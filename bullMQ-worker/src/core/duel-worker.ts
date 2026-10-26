import IORedis from 'ioredis'
import { Worker, type Job } from 'bullmq'
import { REDIS_URL } from './config'
import { logError } from './logger'
import { Match, Ticket, GroupDuel } from './models'
import { processGroupInviteTimeout, processGroupMatchTimeout, processGroupMatchReminder } from './group-timeouts'
import { redis } from './redis'
import { notify } from './bot/notify'
import { mainKeyboard, curName, moveKeyboard } from './bot/keyboards'
import { type Lang, t } from './i18n'
import { formatAmount } from './money'
import { durationLabel } from './time'
import { releaseTicket, settleMatch } from './services/duel'
import { cancelQueue, userStateKey } from './services/matchmaking'
import { getSettings } from './services/settings'
import { getUser } from './services/users'
import { pool } from './util'
import { TIMING_JOB_NAMES } from './contracts/timing-jobs'
import {
  DUEL_QUEUE_NAME,
  duelQueue,
  closeDuelQueue,
  duelQueueConnection,
  scheduleMatchReminder,
  scheduleMatchTimeout,
  scheduleTicketTimeout,
  type MatchReminderData,
  type MatchTimeoutData,
  type TicketTimeoutData,
  scheduleGroupInviteTimeout,
  scheduleGroupMatchTimeout,
  scheduleGroupMatchReminder,
  type GroupTimeoutData,
  type GroupReminderData,
} from './duel-jobs'

const WORKER_CONCURRENCY = Math.max(1, Number(process.env.DUEL_JOB_CONCURRENCY ?? 50))
const RECONCILE_EVERY_MS = Math.max(15_000, Number(process.env.DUEL_RECONCILE_MS ?? 60_000))

async function processMatchTimeout(data: MatchTimeoutData): Promise<void> {
  const match = await Match.findOne({ _id: data.matchId, status: 'choosing' }).select('_id deadline').lean()
  if (!match) return
  if (match.deadline > Date.now()) {
    await scheduleMatchTimeout(match._id, match.deadline, true)
    return
  }
  await settleMatch(match._id)
}

async function processTicketTimeout(data: TicketTimeoutData): Promise<void> {
  const tk = await Ticket.findOne({ _id: data.ticketId, status: 'queued' }).lean()
  if (!tk) return
  const cfg = await getSettings()
  const seconds = Math.max(1, Number(tk.queueTimeoutSeconds ?? ((tk.mode ?? 'bet') === 'friendly' ? cfg.queue.friendlySeconds : cfg.queue.seconds)))
  const deadline = tk.createdAtMs + seconds * 1000
  if (deadline > Date.now()) {
    await scheduleTicketTimeout({ ...tk, queueTimeoutSeconds: seconds }, true)
    return
  }

  const stillQueued = await cancelQueue({
    userId: tk.userId,
    ticketId: tk._id,
    currency: tk.currency,
    amount: tk.amount,
    mode: tk.mode ?? 'bet',
  })
  // Matching and cancellation race through Redis Lua. If matching won, Mongo may still be
  // transitioning the ticket; reconciliation will reschedule if it remains queued.
  if (!stillQueued && Date.now() - tk.createdAtMs < seconds * 1000 + 60_000) return

  const released = await releaseTicket(tk._id)
  if (!released) return
  if (!stillQueued) {
    const key = userStateKey(tk.userId)
    const state = await redis.get(key)
    if (state === `q:${tk._id}` || (state?.startsWith('m:') && !(await Match.exists({ _id: state.slice(2) })))) {
      await redis.del(key)
    }
  }
  const user = await getUser(tk.userId)
  const lang: Lang = user?.lang ?? 'en'
  await notify(
    tk.userId,
    (tk.mode ?? 'bet') === 'friendly'
      ? t(lang, 'duel.no_opponent_friendly', { duration: durationLabel(seconds, lang) })
      : t(lang, 'duel.no_opponent', {
          amount: formatAmount(tk.amount, tk.currency),
          cur: curName(lang, tk.currency),
          duration: durationLabel(seconds, lang),
        }),
    { reply_markup: mainKeyboard(lang, user?.role === 'admin' || user?.role === 'owner') },
  )
}

async function processMatchReminder(data: MatchReminderData): Promise<void> {
  const match = await Match.findOne({ _id: data.matchId, status: 'choosing' }).select('_id p1 p2 c1 c2 deadline reminderSent').lean()
  if (!match || match.reminderSent) return
  if (match.deadline <= Date.now()) return // timeout job owns finalization
  const seconds = Math.max(0, Math.ceil((match.deadline - Date.now()) / 1000))
  const claimed = await Match.findOneAndUpdate(
    { _id: match._id, status: 'choosing', reminderSent: { $ne: true }, deadline: { $gt: Date.now() } },
    { $set: { reminderSent: true } },
    { new: true },
  ).lean()
  if (!claimed) return
  for (const [uid, choice] of [[claimed.p1, claimed.c1], [claimed.p2, claimed.c2]] as const) {
    if (choice) continue
    const lang: Lang = (await getUser(uid))?.lang ?? 'en'
    await notify(uid, t(lang, 'duel.reminder', { seconds }), {
      reply_markup: moveKeyboard(lang, claimed._id),
    }).catch((err) => logError('duel_reminder_failed', err, { matchId: claimed._id, userId: uid }))
  }
}

/** Rebuild missing delayed jobs from Mongo, the durable source of truth. Safe on every replica. */
export async function reconcileDuelJobs(fullScan = false): Promise<void> {
  const cfg = await getSettings()
  let matchCursor = ''
  for (;;) {
    const query: Record<string, unknown> = { status: 'choosing' }
    if (!fullScan) query.$or = [
      { timingScheduledAt: { $exists: false } },
      { timingScheduledAt: null },
      { timingScheduledAt: { $lte: new Date(Date.now() - Math.max(RECONCILE_EVERY_MS * 3, 180_000)) } },
    ]
    if (matchCursor) query._id = { $gt: matchCursor }
    const rows = await Match.find(query as any).select('_id deadline durationSeconds reminderSent timingScheduledAt').sort({ _id: 1 }).limit(500).lean()
    if (!rows.length) break
    await pool(rows, 20, async (match) => {
      await scheduleMatchTimeout(match._id, match.deadline)
      if (!match.reminderSent && match.deadline > Date.now()) {
        const duration = Math.max(1, Number(match.durationSeconds ?? cfg.match.seconds))
        await scheduleMatchReminder(match._id, match.deadline, duration)
      }
      await Match.updateOne({ _id: match._id, status: 'choosing' }, { $set: { timingScheduledAt: new Date() } })
    })
    matchCursor = rows[rows.length - 1]!._id
    if (rows.length < 500) break
  }

  let ticketCursor = ''
  for (;;) {
    const query: Record<string, unknown> = { status: 'queued' }
    if (!fullScan) query.$or = [
      { timingScheduledAt: { $exists: false } },
      { timingScheduledAt: null },
      { timingScheduledAt: { $lte: new Date(Date.now() - Math.max(RECONCILE_EVERY_MS * 3, 180_000)) } },
    ]
    if (ticketCursor) query._id = { $gt: ticketCursor }
    const rows = await Ticket.find(query as any).select('_id createdAtMs queueTimeoutSeconds mode timingScheduledAt').sort({ _id: 1 }).limit(500).lean()
    if (!rows.length) break
    await pool(rows, 20, async (ticket) => {
      const seconds = Number(ticket.queueTimeoutSeconds ?? ((ticket.mode ?? 'bet') === 'friendly' ? cfg.queue.friendlySeconds : cfg.queue.seconds))
      await scheduleTicketTimeout({ ...ticket, queueTimeoutSeconds: seconds })
      await Ticket.updateOne({ _id: ticket._id, status: 'queued' }, { $set: { timingScheduledAt: new Date() } })
    })
    ticketCursor = rows[rows.length - 1]!._id
    if (rows.length < 500) break
  }

  // Group invitations and active group duels share this timing worker and the same BullMQ queue.
  for (const status of ['pending', 'choosing'] as const) {
    let cursor = ''
    for (;;) {
      const deadlineField = status === 'pending' ? 'inviteDeadline' : 'deadline'
      const query: Record<string, any> = { status }
      if (!fullScan) query.$or = [
        { timingScheduledAt: { $exists: false } }, { timingScheduledAt: null },
        { timingScheduledAt: { $lte: new Date(Date.now() - Math.max(RECONCILE_EVERY_MS * 3, 180_000)) } },
      ]
      if (cursor) query._id = { $gt: cursor }
      const rows = await GroupDuel.find(query).select('_id status inviteDeadline deadline reminderAt reminderSent gameMessageId timingScheduledAt').sort({ _id: 1 }).limit(500).lean() as any[]
      if (!rows.length) break
      await pool(rows, 20, async (d) => {
        const deadline = Number(d[deadlineField] ?? Date.now())
        if (status === 'pending') {
          await scheduleGroupInviteTimeout(d._id, deadline)
        } else {
          const jobs: Promise<void>[] = [scheduleGroupMatchTimeout(d._id, deadline)]
          if (d.gameMessageId != null && d.reminderAt != null && Number.isFinite(Number(d.reminderAt)) && !d.reminderSent && Number(d.reminderAt) < deadline) {
            jobs.push(scheduleGroupMatchReminder(d._id, Number(d.reminderAt)))
          }
          await Promise.all(jobs)
        }
        await GroupDuel.updateOne({ _id: d._id, status }, { $set: { timingScheduledAt: new Date() } })
      })
      cursor = rows[rows.length - 1]!._id
      if (rows.length < 500) break
    }
  }

  // If Telegram was unavailable through all job retries, keep retrying only the missing
  // timeout result message. Normal instant settlements are not selected here.
  const unsentTimeoutResults = await GroupDuel.find({
    status: 'settled', timeoutSettled: true, timeoutResultSentAt: { $exists: false },
  }).select('_id deadline').sort({ _id: 1 }).limit(500).lean() as any[]
  await pool(unsentTimeoutResults, 20, async (duel) => {
    await scheduleGroupMatchTimeout(String(duel._id), Number(duel.deadline ?? Date.now()))
  })
}

async function processor(job: Job): Promise<void> {
  switch (job.name) {
    case TIMING_JOB_NAMES.matchTimeout: return processMatchTimeout(job.data as MatchTimeoutData)
    case TIMING_JOB_NAMES.ticketTimeout: return processTicketTimeout(job.data as TicketTimeoutData)
    case TIMING_JOB_NAMES.matchReminder: return processMatchReminder(job.data as MatchReminderData)
    case TIMING_JOB_NAMES.groupInviteTimeout: { const d=job.data as GroupTimeoutData; return processGroupInviteTimeout(d.duelId,d.deadline,(id,deadline)=>scheduleGroupInviteTimeout(id,deadline,true)) }
    case TIMING_JOB_NAMES.groupMatchTimeout: { const d=job.data as GroupTimeoutData; return processGroupMatchTimeout(d.duelId,d.deadline,(id,deadline)=>scheduleGroupMatchTimeout(id,deadline,true)) }
    case TIMING_JOB_NAMES.groupMatchReminder: { const d=job.data as GroupReminderData; return processGroupMatchReminder(d.duelId,d.reminderAt,(id,reminderAt)=>scheduleGroupMatchReminder(id,reminderAt,true)) }
    case TIMING_JOB_NAMES.reconcile: return reconcileDuelJobs(false)
    default: throw new Error(`Unknown duel timing job: ${job.name}`)
  }
}

export async function startDuelWorker(): Promise<() => Promise<void>> {
  const workerConnection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null })
  workerConnection.on('error', (err) => logError('duel_worker_redis_error', err))
  const worker = new Worker(DUEL_QUEUE_NAME, processor, {
    connection: workerConnection,
    concurrency: WORKER_CONCURRENCY,
    lockDuration: 30_000,
    stalledInterval: 30_000,
    maxStalledCount: 2,
  })
  worker.on('failed', (job, err) => logError('duel_job_failed', err, { jobId: job?.id, name: job?.name, attempts: job?.attemptsMade }))
  worker.on('error', (err) => logError('duel_worker_error', err))
  worker.on('stalled', (jobId) => logError('duel_job_stalled', new Error('BullMQ job stalled and will be recovered'), { jobId }))

  await duelQueue.add('reconcile', {}, {
    jobId: 'duel_reconcile_repeat',
    repeat: { every: RECONCILE_EVERY_MS },
    removeOnComplete: true,
    attempts: 3,
    backoff: { type: 'exponential', delay: 2_000 },
  })
  await reconcileDuelJobs(true)
  let hasEverBeenReady = duelQueueConnection.status === 'ready'
  const onQueueRedisReady = () => {
    if (!hasEverBeenReady) {
      hasEverBeenReady = true
      return
    }
    // Redis may have restarted or lost volatile state; rebuild timers from Mongo once reconnected.
    void reconcileDuelJobs(true).catch((err) => logError('duel_reconnect_reconcile_failed', err))
  }
  duelQueueConnection.on('ready', onQueueRedisReady)
  return async () => {
    duelQueueConnection.off('ready', onQueueRedisReady)
    await worker.close()
    await workerConnection.quit().catch(() => undefined)
    await closeDuelQueue()
  }
}
