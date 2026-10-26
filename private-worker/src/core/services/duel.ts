import { randomUUID } from 'node:crypto'
import { moveKeyboard } from '../bot/keyboards'
import { curName } from '../bot/keyboards'
import { notify } from '../bot/notify'
import { type Key, t, type Lang } from '../i18n'
import { logError } from '../logger'
import { type Currency, formatAmount } from '../money'
import { type IMatch, type ITicket, Match, Ticket, User } from '../models'
import { ProfanityFilter } from '../profanity'
import { redis } from '../redis'
import { type Choice, settle, type Settlement } from '../settle'
import { cancelQueue, joinQueue, userStateKey, type DuelMode } from './matchmaking'
import { payReferral } from './referral'
import { getSettings, type Settings } from './settings'
import { durationLabel } from '../time'
import { fullUser, getUser } from './users'
import { applyOp, DuplicateOp, houseOp, InsufficientFunds, newId, runTx } from './wallet'
import { scheduleMatchJobs, scheduleTicketTimeout } from '../duel-jobs'


const langOf = async (id: number): Promise<Lang> => (await getUser(id))?.lang ?? 'en'
const moveName = (lang: Lang, c: Choice | null) => t(lang, c ? (`move.${c}` as Key) : 'move.none')

class AlreadySettled extends Error {}

// ───────────────────────── tickets ─────────────────────────

/** Give the reserved stake back (only if the ticket is still `queued`, so it can never be released twice). */
export async function releaseTicket(ticketId: string): Promise<ITicket | null> {
  try {
    return await runTx(async (s) => {
      const tk = await Ticket.findOneAndUpdate(
        { _id: ticketId, status: 'queued' },
        { $set: { status: 'cancelled' } },
        { session: s, new: false },
      ).lean()
      if (!tk) return null
      if ((tk.mode ?? 'bet') === 'bet') {
        await applyOp(s, {
          key: `unhold:${ticketId}`,
          userId: tk.userId,
          currency: tk.currency,
          type: 'unhold',
          available: tk.amount,
          locked: -tk.amount,
          ref: ticketId,
        })
      }
      return tk
    })
  } catch (e) {
    if (e instanceof DuplicateOp) return null
    throw e
  }
}

export type JoinOutcome =
  | { status: 'busy' | 'insufficient' | 'invalid' | 'matched' | 'disabled' }
  | { status: 'queued'; ticketId: string; seconds: number }

export async function joinDuel(
  userId: number,
  currency: Currency,
  amount: number,
  mode: DuelMode = 'bet',
): Promise<JoinOutcome> {
  const cfg = await getSettings()
  if (!cfg.features.duelsEnabled) return { status: 'disabled' }
  if (mode === 'bet' && !cfg.bets[currency].includes(amount)) return { status: 'invalid' }
  if (mode === 'friendly') { currency = 'IRT'; amount = 0 }
  if (await redis.exists(userStateKey(userId))) return { status: 'busy' }

  const queueTimeoutSeconds = mode === 'friendly' ? cfg.queue.friendlySeconds : cfg.queue.seconds
  // 1) reserve the stake + record the ticket (one transaction)
  const ticketId = newId()
  const ticketCreatedAtMs = Date.now()
  try {
    await runTx(async (s) => {
      await Ticket.create([{ _id: ticketId, userId, currency, amount, mode, status: 'queued', createdAtMs: ticketCreatedAtMs, queueTimeoutSeconds }], { session: s })
      if (mode === 'bet') {
        await applyOp(s, { key: `hold:${ticketId}`, userId, currency, type: 'hold', available: -amount, locked: amount, ref: ticketId })
      }
    })
  } catch (e) {
    if (e instanceof InsufficientFunds) return { status: 'insufficient' }
    throw e
  }

  // 2) atomic queue operation in Redis
  const matchId = newId()
  let r
  try {
    r = await joinQueue({
      userId,
      ticketId,
      currency,
      amount,
      mode,
      matchId,
      queuedTtl: queueTimeoutSeconds + 600, // keep Redis state beyond the visible timeout
      matchTtl: (mode === 'friendly' ? cfg.match.friendlySeconds : cfg.match.seconds) + 600,
    })
  } catch (e) {
    await releaseTicket(ticketId).catch((err) => logError('release_after_redis_fail', err, { ticketId }))
    throw e
  }
  for (const g of r.ghosts) await releaseTicket(g).catch((err) => logError('ghost_release_failed', err, { ticketId: g }))

  if (r.status === 'busy') {
    await releaseTicket(ticketId)
    return { status: 'busy' }
  }
  if (r.status === 'queued') {
    // BullMQ is durable; if Redis/BullMQ is temporarily unavailable, startup/periodic
    // reconciliation rebuilds this job from the queued Ticket document.
    await scheduleTicketTimeout({ _id: ticketId, createdAtMs: ticketCreatedAtMs, queueTimeoutSeconds, mode })
      .then(() => Ticket.updateOne({ _id: ticketId, status: 'queued' }, { $set: { timingScheduledAt: new Date() } }))
      .catch((e) => logError('ticket_timeout_schedule_failed', e, { ticketId }))
    return { status: 'queued', ticketId, seconds: queueTimeoutSeconds }
  }

  await createMatch({ matchId: r.matchId, myTicketId: ticketId, oppTicketId: r.oppTicketId, me: userId, opp: r.oppUserId, currency, amount, mode, cfg })
  return { status: 'matched' }
}

export type CancelOutcome = 'cancelled' | 'late' | 'unknown'

export async function cancelTicket(userId: number, ticketId: string): Promise<CancelOutcome> {
  const tk = await Ticket.findById(ticketId).lean()
  if (!tk || tk.userId !== userId) return 'unknown'
  if (tk.status === 'cancelled') return 'cancelled'
  if (tk.status !== 'queued') return 'late'
  // ZREM is the arbiter: exactly one of "cancel" and "opponent found" can win
  if (!(await cancelQueue({ userId, ticketId, currency: tk.currency, amount: tk.amount, mode: tk.mode ?? 'bet' }))) return 'late'
  await releaseTicket(ticketId)
  return 'cancelled'
}

// ───────────────────────── matches ─────────────────────────

async function createMatch(p: {
  matchId: string
  myTicketId: string
  oppTicketId: string
  me: number
  opp: number
  currency: Currency
  amount: number
  mode: DuelMode
  cfg: Settings
}): Promise<void> {
  const durationSeconds = p.mode === 'friendly' ? p.cfg.match.friendlySeconds : p.cfg.match.seconds
  const deadline = Date.now() + durationSeconds * 1000
  const fees = p.mode === 'friendly' ? { win: 0, draw: 0, winTimeout: 0, drawTimeout: 0 } : p.cfg.fees
  try {
    await runTx(async (s) => {
      const res = await Ticket.updateMany(
        { _id: { $in: [p.myTicketId, p.oppTicketId] }, status: 'queued' },
        { $set: { status: 'matched', matchId: p.matchId } },
        { session: s },
      )
      if (res.modifiedCount !== 2) throw new Error('tickets_not_queued')
      await Match.create(
        [{ _id: p.matchId, currency: p.currency, amount: p.amount, mode: p.mode, durationSeconds, maxMessages: p.mode === 'friendly' ? p.cfg.chat.friendlyMaxMessages : p.cfg.chat.maxMessages, reminderSent: false, p1: p.opp, p2: p.me, status: 'choosing', deadline, fees }],
        { session: s },
      )
    })
  } catch (e) {
    // Undo: give both stakes back and free both users
    for (const id of [p.myTicketId, p.oppTicketId]) await releaseTicket(id).catch((err) => logError('undo_match_release', err, { ticketId: id }))
    await redis.del(userStateKey(p.me), userStateKey(p.opp))
    throw e
  }
  await cacheMatch({ id: p.matchId, p1: p.opp, p2: p.me, currency: p.currency, amount: p.amount, mode: p.mode, deadline, maxMessages: p.mode === 'friendly' ? p.cfg.chat.friendlyMaxMessages : p.cfg.chat.maxMessages })
  // Schedule after Mongo commit. The durable reconciliation job repairs this if Redis fails here.
  await scheduleMatchJobs(p.matchId, deadline, durationSeconds)
    .then(() => Match.updateOne({ _id: p.matchId, status: 'choosing' }, { $set: { timingScheduledAt: new Date() } }))
    .catch((e) => logError('match_timing_schedule_failed', e, { matchId: p.matchId }))

  await Promise.all(
    [p.opp, p.me].map(async (uid) => {
      const lang = await langOf(uid)
      await notify(
        uid,
        t(lang, p.mode === 'friendly' ? 'duel.matched_friendly' : 'duel.matched', {
          amount: formatAmount(p.amount, p.currency),
          cur: curName(lang, p.currency),
          duration: durationLabel(durationSeconds, lang),
        }),
        { reply_markup: moveKeyboard(lang, p.matchId) },
      )
    }),
  )
}

export interface MatchInfo {
  id: string
  p1: number
  p2: number
  currency: Currency
  amount: number
  mode: DuelMode
  deadline: number
  maxMessages?: number
}
const cacheMatch = (m: MatchInfo) => redis.set(`match:${m.id}`, JSON.stringify(m), 'EX', 7200)

export async function getMatchInfo(id: string): Promise<MatchInfo | null> {
  const raw = await redis.get(`match:${id}`)
  if (raw) return JSON.parse(raw) as MatchInfo
  const m = await Match.findById(id).lean()
  if (!m || m.status !== 'choosing') return null
  const info: MatchInfo = { id, p1: m.p1, p2: m.p2, currency: m.currency, amount: m.amount, mode: m.mode ?? 'bet', deadline: m.deadline, maxMessages: m.maxMessages }
  await cacheMatch(info)
  return info
}

/** The match a user is currently inside (from the Redis state set by the matchmaking script). */
export async function currentMatchId(userId: number): Promise<string | null> {
  const v = await redis.get(userStateKey(userId))
  return v?.startsWith('m:') ? v.slice(2) : null
}

export type ChooseResult = 'saved' | 'settled' | 'already' | 'finished' | 'late' | 'not_yours'

export async function chooseMove(userId: number, matchId: string, move: Choice): Promise<ChooseResult> {
  const m = await Match.findById(matchId).lean()
  if (!m) return 'finished'
  const slot = m.p1 === userId ? 1 : m.p2 === userId ? 2 : 0
  if (!slot) return 'not_yours'
  if (m.status !== 'choosing') return 'finished'
  if (Date.now() > m.deadline) return 'late' // BullMQ timeout job settles it shortly
  const field = slot === 1 ? 'c1' : 'c2'
  // atomic: only writes while the slot is still empty and the match is still open
  // Use MongoDB server time in the atomic write filter. Checking Date.now() only
  // before the request leaves a network/queue race at the exact deadline boundary.
  const upd = await Match.findOneAndUpdate(
    {
      _id: matchId,
      status: 'choosing',
      [field]: null,
      $expr: { $gt: [{ $toDate: '$deadline' }, '$$NOW'] },
    },
    { $set: { [field]: move } },
    { new: true },
  ).lean()
  if (!upd) {
    const current = await Match.findById(matchId).select(`status deadline ${field}`).lean()
    if (!current || current.status !== 'choosing') return 'finished'
    if (Date.now() >= current.deadline) return 'late'
    if ((current as any)[field]) return 'already'
    return 'finished'
  }
  if (upd.c1 && upd.c2) {
    await settleMatch(matchId)
    return 'settled'
  }
  return 'saved'
}

/** Notify the opponent after the first player locks a move. */
export async function notifyOpponentChoice(matchId: string, chooserId: number): Promise<void> {
  const m = await Match.findById(matchId).lean()
  if (!m || m.status !== 'choosing') return
  const chooserSlot = m.p1 === chooserId ? 1 : m.p2 === chooserId ? 2 : 0
  if (!chooserSlot) return
  const opponentId = chooserSlot === 1 ? m.p2 : m.p1
  const opponentChoice = chooserSlot === 1 ? m.c2 : m.c1
  const chooserMove = chooserSlot === 1 ? m.c1 : m.c2
  if (!chooserMove || opponentChoice) return
  const lang = await langOf(opponentId)
  const secondsLeft = Math.max(0, Math.ceil((m.deadline - Date.now()) / 1000))
  await notify(opponentId, t(lang, 'duel.opponent_chosen', { seconds: secondsLeft }), {
    reply_markup: moveKeyboard(lang, matchId),
  })
}

/** Settle exactly once (status guard + unique ledger keys). Returns false when it was already settled. */
export async function settleMatch(matchId: string): Promise<boolean> {
  const m = await Match.findById(matchId).lean()
  if (!m || m.status !== 'choosing') return false
  const s = settle(m.amount, m.c1, m.c2, m.fees)
  try {
    await runTx(async (tx) => {
      const upd = await Match.updateOne(
        { _id: matchId, status: 'choosing' },
        { $set: { status: 'settled', outcome: s.outcome, winner: s.winner, fee: s.fee, settledAt: new Date() } },
        { session: tx },
      )
      if (upd.modifiedCount !== 1) throw new AlreadySettled()
      if ((m.mode ?? 'bet') === 'bet') {
        const payouts = [s.payout1, s.payout2]
        for (const [i, uid] of [m.p1, m.p2].entries()) {
          await applyOp(tx, {
            key: `settle:${matchId}:${i + 1}`,
            userId: uid,
            currency: m.currency,
            type: 'settle',
            available: payouts[i]!,
            locked: -m.amount, // the whole stake leaves the reserved balance
            ref: matchId,
          })
        }
        await houseOp(tx, `fee:${matchId}`, m.currency, s.fee, 'fee', matchId)
      }
      // Count both modes in the user's completed-duel counter, including draws and timeouts.
      await User.updateMany({ tgId: { $in: [m.p1, m.p2] } }, { $inc: { duelsPlayed: 1 } }, { session: tx })
    })
  } catch (e) {
    if (e instanceof AlreadySettled) return false
    throw e
  }

  await redis.del(userStateKey(m.p1), userStateKey(m.p2), `match:${matchId}`)
  await notifyResult(m, s)
  // A completed friendly duel qualifies too; only a player who actually chose a move is eligible.
  for (const uid of [m.c1 ? m.p1 : 0, m.c2 ? m.p2 : 0].filter(Boolean)) {
    await payReferral(uid).catch((e) => logError('referral_failed', e, { userId: uid }))
  }
  return true
}

async function notifyResult(m: IMatch, s: Settlement): Promise<void> {
  const cur = m.currency
  const stake = m.amount
  await Promise.all(
    [1, 2].map(async (i) => {
      const uid = i === 1 ? m.p1 : m.p2
      const lang = await langOf(uid)
      const mine = i === 1 ? m.c1 : m.c2
      const theirs = i === 1 ? m.c2 : m.c1
      const payout = i === 1 ? s.payout1 : s.payout2
      const won = s.winner === i
      const p = {
        cur: curName(lang, cur),
        mine: moveName(lang, mine),
        theirs: moveName(lang, theirs),
        stake: formatAmount(stake, cur),
        profit: formatAmount(payout - stake, cur),
        seconds: Math.max(1, Number(m.durationSeconds ?? 300)),
      }
      if ((m.mode ?? 'bet') === 'friendly') {
        let friendlyKey: Key
        if (s.outcome === 'draw_timeout') friendlyKey = 'result.friendly_draw_timeout'
        else if (s.outcome === 'win_timeout') friendlyKey = won ? 'result.friendly_win_timeout' : 'result.friendly_lose_timeout'
        else if (s.outcome === 'draw') friendlyKey = 'result.friendly_draw'
        else friendlyKey = won ? 'result.friendly_win' : 'result.friendly_lose'
        await notify(uid, t(lang, friendlyKey, { mine: p.mine, theirs: p.theirs, seconds: p.seconds }))
        return
      }
      let text: string
      switch (s.outcome) {
        case 'win':
          text = won ? t(lang, 'result.win', { ...p, fee: formatAmount(s.fee, cur) }) : t(lang, 'result.lose', p)
          break
        case 'win_timeout':
          text = won ? t(lang, 'result.win_timeout', { ...p, fee: formatAmount(s.fee, cur) }) : t(lang, 'result.lose_timeout', p)
          break
        case 'draw':
          text = t(lang, 'result.draw', { ...p, fee: formatAmount(stake - payout, cur) })
          break
        default:
          text = t(lang, 'result.draw_timeout', { ...p, fee: formatAmount(stake - payout, cur) })
      }
      const u = await fullUser(uid)
      if (u) text += '\n' + t(lang, 'result.balance', { balance: formatAmount(u.balances[cur].available, cur), cur: p.cur })
      await notify(uid, text)
    }),
  )
}

// ───────────────────────── chat between matched players ─────────────────────────

let filter: { version: number; f: ProfanityFilter } | null = null
function filterFor(cfg: Settings): ProfanityFilter {
  if (!filter || filter.version !== cfg.version) filter = { version: cfg.version, f: new ProfanityFilter(cfg.bannedWords) }
  return filter.f
}

export type ChatResult =
  | 'ok' | 'blocked' | 'limit' | 'too_long' | 'gone' | 'disabled'
  | { status: 'penalized'; amount: number; currency: Currency }
  | { status: 'penalty_insufficient'; amount: number; currency: Currency }

/**
 * Relay chat and apply a fixed filtered-word penalty at most once per Telegram message.
 * Penalties only apply to paid/bet duels and are debited from available funds, never the locked stake.
 */
export async function relayChat(userId: number, matchId: string, text: string, messageId?: number): Promise<ChatResult> {
  if ([...text].length > 300) return 'too_long'
  const info = await getMatchInfo(matchId)
  if (!info || (info.p1 !== userId && info.p2 !== userId)) return 'gone'
  const opp = info.p1 === userId ? info.p2 : info.p1
  const cfg = await getSettings()
  if (!cfg.features.chatEnabled) return 'disabled'
  if (filterFor(cfg).test(text)) {
    // Friendly duels have no monetary stake; all filtered messages there receive only a warning.
    const penalty = info.mode === 'bet' ? Number(cfg.chat.profanityPenalty?.[info.currency] ?? 0) : 0
    if (!Number.isSafeInteger(penalty) || penalty <= 0) return 'blocked'

    // Telegram message IDs are unique within this user's private chat. Including the match and
    // user in the ledger key makes webhook/polling retries idempotent.
    const eventId = messageId === undefined ? randomUUID() : String(messageId)
    const opKey = `profanity:${matchId}:${userId}:${eventId}`
    try {
      await runTx(async (session) => {
        await applyOp(session, {
          key: opKey,
          userId,
          currency: info.currency,
          type: 'profanity_penalty',
          available: -penalty,
          locked: 0,
          ref: matchId,
        })
        await houseOp(session, `profanity-house:${matchId}:${userId}:${eventId}`, info.currency, penalty, 'profanity_penalty_income', matchId)
      })
      return { status: 'penalized', amount: penalty, currency: info.currency }
    } catch (error) {
      if (error instanceof InsufficientFunds) {
        return { status: 'penalty_insufficient', amount: penalty, currency: info.currency }
      }
      // A repeated delivery of the same Telegram message must not deduct money twice.
      if (error instanceof DuplicateOp) return 'blocked'
      throw error
    }
  }
  const ck = `chat:${matchId}:${userId}`
  const n = await redis.incr(ck)
  if (n === 1) await redis.expire(ck, 7200)
  const limit = info.maxMessages ?? (info.mode === 'friendly' ? cfg.chat.friendlyMaxMessages : cfg.chat.maxMessages)
  if (n > limit) return 'limit'
  await notify(opp, t(await langOf(opp), 'chat.from_opponent', { text }), { plain: true })
  return 'ok'
}
