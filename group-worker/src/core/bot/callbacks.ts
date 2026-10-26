import { logError } from '../logger'
import mongoose from 'mongoose'
import { bot } from './instance'
import { redis, langOf, tr, curLabel, fmt, mention, getUser } from '../runtime'
import { GroupConfig, GroupDuel } from '../models/index'
import { groupReminderAt, groupDuelHasStake, type GroupCurrency, type GroupMode } from '../contracts/group'
import { getFlow, reserve, release } from '../services/wallet'
import { advanceFlow, createInvite } from '../services/duel-flow'
import { groupLang, renderDashboard, renderTimeoutPanel } from '../services/group'
import { settleDuel } from '../services/settlement'
import { scheduleGroupMatchReminder } from '../services/timing'
import { closeInviteKeyboard, gameKeyboard, gameProgressText, refreshGameProgress } from '../services/game-message'
import { deleteEphemeralMessage, editEphemeralMessage, editMessageReference, messageReferenceFromCallback, sendEphemeralMessage } from './ephemeral'

async function answer(q: any, text?: string, showAlert = false) {
  await bot.api.answerCallbackQuery(q.id, {
    ...(text ? { text: text.slice(0, 200) } : {}),
    ...(showAlert ? { show_alert: true } : {}),
  }).catch(() => undefined)
}

function callbackLang(chatId: unknown) {
  return groupLang(String(chatId))
}

function callbackMessageRef(q: any, userId: number) {
  return messageReferenceFromCallback(q.message, userId)
}

async function editRenderedFromCallback(q: any, uid: number, chatId: string, rendered: any) {
  const msg = q.message
  const options = { parse_mode: 'HTML', reply_markup: rendered.reply_markup } as any
  if (Number.isInteger(msg?.ephemeral_message_id)) {
    await editEphemeralMessage(Number(chatId), uid, Number(msg.ephemeral_message_id), rendered.text, options)
  } else if (Number.isInteger(msg?.message_id)) {
    await bot.api.editMessageText(Number(chatId), Number(msg.message_id), rendered.text, options)
  }
}

async function editDashboardFromCallback(q: any, uid: number, cfg: any, chatId: string) {
  await editRenderedFromCallback(q, uid, chatId, await renderDashboard(chatId, cfg))
}

export async function handleCallback(update: any) {
  const q = update.callback_query
  if (!q) return
  const data = String(q.data ?? '')
  const uid = Number(q.from?.id)
  const msg = q.message

  // Welcome-language selector is public; only the group activator may use it.
  if (data.startsWith('gw:lang:')) {
    const chosen = data.split(':')[2]
    const chat = msg?.chat
    if (!chat || (chosen !== 'fa' && chosen !== 'en')) return answer(q)
    const chatId = String(chat.id)
    const cfg = await GroupConfig.findOne({ chatId }).lean() as any
    if (!cfg || Number(cfg.activatorId) !== uid) {
      return answer(q, tr(langOf(cfg?.language), '⛔ فقط فعال‌کنندهٔ گروه می‌تواند زبان را انتخاب کند.', '⛔ Only the group activator can choose the language.'), true)
    }
    await GroupConfig.updateOne({ chatId }, { $set: { language: chosen } })
    await bot.api.editMessageText(chat.id, msg.message_id, tr(chosen,
      '🤖 ربات در گروه فعال است. برای راهنما «راهنما» و برای تنظیمات «پنل» را بفرستید.',
      '🤖 The bot is active in this group. Send “help” for the guide or “panel” for settings.',
    ), { reply_markup: { inline_keyboard: [] } }).catch(() => undefined)
    await answer(q, tr(chosen, 'زبان گروه ذخیره شد.', 'Group language saved.'))
    return
  }

  if (data.startsWith('gw:cfg:')) {
    const bits = data.split(':')
    const chatId = bits[2]
    if (!chatId || !msg?.chat || String(msg.chat.id) !== chatId) {
      return answer(q, 'Invalid panel reference.', true)
    }
    const actual = await GroupConfig.findOne({ chatId }).lean() as any
    if (!actual || Number(actual.activatorId) !== uid) {
      return answer(q, tr(langOf(actual?.language), '⛔ فقط فعال‌کنندهٔ این گروه اجازهٔ تغییر تنظیمات را دارد.', '⛔ Only this group’s activator can change its settings.'), true)
    }
    const action = bits[3]
    const value = bits[4]
    if (action === 'timeout') {
      const kind = value
      const operation = bits[5]
      const allowedKinds = ['inviteBet', 'inviteFriendly', 'bet', 'friendly']
      if (!allowedKinds.includes(kind ?? '')) return answer(q, 'Invalid timeout setting.', true)
      const key = kind === 'inviteBet' ? 'betInviteTimeoutSeconds'
        : kind === 'inviteFriendly' ? 'friendlyInviteTimeoutSeconds'
          : kind === 'bet' ? 'betTimeoutSeconds' : 'friendlyTimeoutSeconds'
      const maximum = kind.startsWith('invite') ? 300 : 600
      const fallback = kind === 'inviteBet' || kind === 'inviteFriendly' ? Number(actual.inviteTimeoutSeconds ?? 120) : kind === 'bet' ? 180 : 120
      const current = Math.max(30, Math.min(maximum, Number(actual[key] ?? fallback) || fallback))

      if (operation === 'set') {
        const requested = Number(bits[6])
        if (!Number.isInteger(requested) || requested < 30 || requested > maximum) {
          return answer(q, tr(langOf(actual.language), `⛔ زمان باید بین ۳۰ و ${maximum} ثانیه باشد.`, `⛔ Timeout must be between 30 and ${maximum} seconds.`), true)
        }
        if (requested === current) return answer(q, tr(langOf(actual.language), '⏱ این مقدار از قبل انتخاب شده است.', '⏱ This value is already selected.'))
        await GroupConfig.updateOne({ chatId }, { $set: { [key]: requested } })
      } else if (operation === 'step') {
        const delta = Number(bits[6])
        if (![-10, -5, -1, 1, 5, 10].includes(delta)) return answer(q)
        const next = Math.max(30, Math.min(maximum, current + delta))
        if (next === current) return answer(q, tr(langOf(actual.language), '⏱ زمان به حد مجاز رسیده است.', '⏱ The timeout is already at its limit.'))
        await GroupConfig.updateOne({ chatId }, { $set: { [key]: next } })
      } else if (operation !== 'panel' && operation !== 'back') {
        return answer(q)
      }

      const fresh = await GroupConfig.findOne({ chatId }).lean() as any
      try {
        if (operation === 'back') {
          await editRenderedFromCallback(q, uid, chatId, await renderDashboard(chatId, fresh))
        } else {
          await editRenderedFromCallback(q, uid, chatId, await renderTimeoutPanel(chatId, fresh, kind))
        }
        await answer(q, operation === 'panel' ? tr(langOf(fresh.language), '⏱ تنظیم زمان باز شد.', '⏱ Timeout settings opened.') : operation === 'back' ? tr(langOf(fresh.language), '✅ بازگشت به پنل مدیریت.', '✅ Returned to group settings.') : tr(langOf(fresh.language), '✅ زمان ذخیره شد.', '✅ Timeout saved.'))
      } catch (error) {
        logError('timeout_panel_edit_failed', error, { chatId, actorId: uid, kind, operation })
        await answer(q, tr(langOf(fresh.language), '⚠️ پنل زمان به‌روزرسانی نشد.', '⚠️ Could not update the timeout panel.'), true)
      }
      return
    }

    const set: Record<string, unknown> = {}
    if (action === 'lang' && (value === 'fa' || value === 'en')) set.language = value
    if (action === 'mode' && ['bet', 'friendly', 'both'].includes(value ?? '')) set.allowedModes = value === 'both' ? ['bet', 'friendly'] : [value]
    if (action === 'cur' && ['IRT', 'TON', 'both'].includes(value ?? '')) set.allowedCurrencies = value === 'both' ? ['IRT', 'TON'] : [value]
    if (Object.keys(set).length) await GroupConfig.updateOne({ chatId }, { $set: set })
    const fresh = await GroupConfig.findOne({ chatId }).lean() as any
    try {
      await editDashboardFromCallback(q, uid, fresh, chatId)
      await answer(q, tr(langOf(fresh.language), '✅ تنظیمات ذخیره شد.', '✅ Settings saved.'))
    } catch {
      await answer(q, tr(langOf(fresh.language), '⚠️ ویرایش پنل انجام نشد؛ دوباره دکمه را بزن.', '⚠️ Could not update the panel; tap the button again.'), true)
    }
    return
  }

  if (data.startsWith('gw:flow:')) {
    const flow = await getFlow(uid)
    if (!flow) return answer(q, tr(langOf((await getUser(uid))?.lang), '⌛ این فرم منقضی شده است؛ دوباره «دوئل» را بفرست.', '⌛ This form has expired. Start a new duel.'), true)
    if (uid !== Number(flow.actorId) || String(msg?.chat?.id) !== String(flow.chatId)) {
      return answer(q, tr(await callbackLang(flow.chatId), '⛔ این فرم برای شما نیست.', '⛔ This form does not belong to you.'), true)
    }
    const parts = data.split(':')
    const ref = callbackMessageRef(q, uid)
    if (parts[2] === 'mode' && (parts[3] === 'bet' || parts[3] === 'friendly')) flow.mode = parts[3] as GroupMode
    else if (parts[2] === 'cur' && (parts[3] === 'IRT' || parts[3] === 'TON')) flow.currency = parts[3] as GroupCurrency
    else if (parts[2] === 'amt') {
      const amount = Number(parts[3])
      try {
        await createInvite(uid, flow, amount, ref)
        await answer(q, tr(await callbackLang(flow.chatId), '✅ دعوت در گروه ارسال شد.', '✅ Challenge posted in the group.'))
      } catch (error: any) {
        const lang = await callbackLang(flow.chatId)
        const message = error?.message === 'INSUFFICIENT_BALANCE'
          ? tr(lang, '❌ موجودی آزاد باید از مبلغ رقابت بیشتر باشد.', '❌ Your available balance must be greater than the stake.')
          : error?.message === 'GROUP_CONFIG_CHANGED'
            ? tr(lang, '⚠️ تنظیمات گروه تغییر کرده است؛ فرم را دوباره باز کن.', '⚠️ Group settings changed; reopen the form.')
            : tr(lang, '❌ ساخت دعوت ناموفق بود؛ دوباره تلاش کن.', '❌ Could not create the invitation. Try again.')
        await answer(q, message, true)
      }
      return
    } else {
      return answer(q)
    }

    try {
      await advanceFlow(uid, flow, ref)
      await answer(q)
    } catch (error: any) {
      await answer(q, tr(await callbackLang(flow.chatId),
        '⚠️ ادامهٔ فرم ممکن نشد؛ دوباره از «دوئل» شروع کن.',
        '⚠️ The form could not continue. Start again with “duel”.',
      ), true)
    }
    return
  }

  if (data.startsWith('gw:accept:') || data.startsWith('gw:reject:')) {
    const id = data.split(':')[2]
    if (!id) return answer(q)
    const duel = await GroupDuel.findOne({ _id: id, status: 'pending' }).lean() as any
    if (!duel) {
      const lang = await callbackLang(String(msg?.chat?.id ?? ''))
      return answer(q, tr(lang, '⌛ این دعوت دیگر فعال نیست.', '⌛ This invitation is no longer active.'), true)
    }
    const lang = await callbackLang(String(duel.chatId))
    if (String(msg?.chat?.id) !== String(duel.chatId)) return answer(q, tr(lang, 'این دعوت متعلق به گروه دیگری است.', 'This invitation belongs to another group.'), true)
    if (uid !== Number(duel.opponentId)) {
      return answer(q, tr(lang, '⛔ فقط کاربری که دعوت شده می‌تواند دوئل را تأیید یا رد کند.', '⛔ Only the invited player can accept or reject this duel.'), true)
    }
    if (Date.now() > Number(duel.inviteDeadline)) {
      await expireInvite(id)
      return answer(q, tr(lang, '⌛ مهلت این دعوت تمام شده است.', '⌛ This invitation has expired.'), true)
    }

    if (data.startsWith('gw:reject:')) {
      const session = await mongoose.startSession()
      let rejected = false
      try {
        await session.withTransaction(async () => {
          const current = await GroupDuel.findOneAndUpdate(
            { _id: id, status: 'pending', inviteDeadline: { $gt: Date.now() } },
            { $set: { status: 'rejected' } }, { new: true, session },
          ).lean() as any
          if (!current) return
          if (groupDuelHasStake(current)) await release(current.initiatorId, String(current.currency), Number(current.amount), `group:invite-release:${id}`, session)
          rejected = true
        })
      } finally { await session.endSession() }
      if (!rejected) return answer(q, tr(lang, '⌛ دعوت دیگر فعال نیست.', '⌛ This invitation is no longer active.'), true)
      await closeInviteKeyboard(duel)
      const [a, b] = await Promise.all([getUser(duel.initiatorId), getUser(duel.opponentId)])
      const p1 = mention({ id: duel.initiatorId, first_name: a?.firstName, last_name: a?.lastName, username: a?.username }, lang)
      const p2 = mention({ id: duel.opponentId, first_name: b?.firstName, last_name: b?.lastName, username: b?.username }, lang)
      const mode = duel.mode === 'bet' ? tr(lang, 'شرطی', 'bet') : tr(lang, 'دوستانه', 'friendly')
      const showStake = duel.mode === 'bet' && Number(duel.amount) > 0 && groupDuelHasStake(duel)
      const stakeTextFa = showStake ? ` به مبلغ ${fmt(duel.amount, String(duel.currency))} ${curLabel(String(duel.currency), lang)}` : ' بدون شرط مالی'
      const stakeTextEn = showStake ? ` for ${fmt(duel.amount, String(duel.currency))} ${curLabel(String(duel.currency), lang)}` : ' with no stake'
      const text = tr(lang,
        `❌ دعوت ${p1} از ${p2} برای رقابت ${mode}${stakeTextFa} رد شد.`,
        `❌ ${p2} rejected ${p1}’s ${mode} duel invitation${stakeTextEn}.`,
      )
      await bot.api.sendMessage(Number(duel.chatId), text, { parse_mode: 'HTML', reply_parameters: { message_id: Number(duel.inviteMessageId ?? msg?.message_id) } } as any).catch(() => undefined)
      await answer(q, tr(lang, 'دعوت رد شد.', 'Invitation rejected.'))
      return
    }

    const session = await mongoose.startSession()
    let accepted = false
    let insufficient = false
    try {
      await session.withTransaction(async () => {
        accepted = false
        insufficient = false
        const current = await GroupDuel.findOne({ _id: id, status: 'pending', inviteDeadline: { $gt: Date.now() } }).session(session).lean() as any
        if (!current) return
        if (groupDuelHasStake(current)) {
          try { await reserve(current.opponentId, String(current.currency), Number(current.amount), session) }
          catch (error: any) { if (error?.message === 'INSUFFICIENT_BALANCE') { insufficient = true; return } throw error }
        }
        const cfg = await GroupConfig.findOne({ chatId: current.chatId }).session(session).lean() as any
        const seconds = Math.max(30, Math.min(600, Number(current.mode === 'bet' ? cfg?.betTimeoutSeconds : cfg?.friendlyTimeoutSeconds) || 180))
        const startedAt = Date.now()
        const deadline = startedAt + seconds * 1000
        const reminderAt = groupReminderAt(startedAt, seconds)
        const changed = await GroupDuel.updateOne(
          { _id: id, status: 'pending', inviteDeadline: { $gt: Date.now() } },
          { $set: { status: 'choosing', deadline, reminderAt, reminderSent: false, p1Choice: null, p2Choice: null } },
          { session },
        )
        if (!changed.modifiedCount) throw new Error('INVITE_RACE')
        accepted = true
      })
    } finally { await session.endSession() }
    if (insufficient) return answer(q, tr(lang,
      '❌ موجودی آزاد کیف پولت باید بیشتر از مبلغ رقابت باشد. مبلغ را شارژ کن و سپس دوباره دعوت شو.',
      '❌ Your available balance must be greater than the stake. Top up and ask for a new invitation.',
    ), true)
    if (!accepted) return answer(q, tr(lang, '⌛ دعوت دیگر فعال نیست.', '⌛ This invitation is no longer active.'), true)

    const fresh = await GroupDuel.findById(id).lean() as any
    await closeInviteKeyboard(duel)
    const prompt = await gameProgressText(fresh)
    let game: any
    try {
      game = await bot.api.sendMessage(Number(duel.chatId), prompt, {
        parse_mode: 'HTML',
        ...(duel.inviteMessageId ? { reply_parameters: { message_id: Number(duel.inviteMessageId) } } : {}),
        reply_markup: gameKeyboard(id, lang),
      } as any)
    } catch {
      const rollback = await mongoose.startSession()
      try {
        await rollback.withTransaction(async () => {
          const current = await GroupDuel.findOneAndUpdate({ _id: id, status: 'choosing' }, { $set: { status: 'cancelled', outcome: 'game_message_failed', settledAt: new Date() } }, { new: true, session: rollback }).lean() as any
          if (!current) return
          if (groupDuelHasStake(current)) {
            await release(current.initiatorId, String(current.currency), Number(current.amount), `group:cancel-release:${id}:${current.initiatorId}`, rollback)
            await release(current.opponentId, String(current.currency), Number(current.amount), `group:cancel-release:${id}:${current.opponentId}`, rollback)
          }
        })
      } finally { await rollback.endSession() }
      await bot.api.sendMessage(Number(duel.chatId), groupDuelHasStake(duel)
        ? tr(lang, '⚠️ ارسال فرم بازی ناموفق بود؛ مبالغ رزروشده آزاد شدند.', '⚠️ The game form could not be posted; reserved funds were released.')
        : tr(lang, '⚠️ ارسال فرم بازی ناموفق بود؛ دعوت لغو شد. دوباره تلاش کنید.', '⚠️ The game form could not be posted; the duel was cancelled. Please try again.'), {
        ...(duel.inviteMessageId ? { reply_parameters: { message_id: Number(duel.inviteMessageId) } } : {}),
      } as any).catch(() => undefined)
      await answer(q, tr(lang, 'ارسال بازی ناموفق بود؛ مبلغ رزروشده آزاد شد.', 'Could not start the game; reserved funds were released.'), true)
      return
    }
    await GroupDuel.updateOne({ _id: id, status: 'choosing' }, { $set: { gameMessageId: game.message_id } })
    try {
      const { scheduleGroupMatchTimeout } = await import('../services/timing')
      await Promise.all([
        scheduleGroupMatchTimeout(id, Number(fresh.deadline)),
        scheduleGroupMatchReminder(id, Number(fresh.reminderAt)),
      ])
      await GroupDuel.updateOne({ _id: id, status: 'choosing' }, { $set: { timingScheduledAt: new Date() } })
    } catch (error) {
      // The BullMQ worker's Mongo reconciliation will restore either missing job.
      logError('match_timeout_or_reminder_schedule_failed', error, { duelId: id, deadline: fresh.deadline, reminderAt: fresh.reminderAt })
    }
    await answer(q, tr(lang, '✅ دعوت پذیرفته شد؛ بازی شروع شد.', '✅ Invitation accepted; the game has started.'))
    return
  }

  if (data.startsWith('gw:move:')) {
    const [, , id, choice] = data.split(':')
    if (!id || !['r', 'p', 's'].includes(String(choice))) return answer(q)
    const duel = await GroupDuel.findOne({ _id: id, status: 'choosing' }).lean() as any
    if (!duel) {
      const lang = await callbackLang(String(msg?.chat?.id ?? ''))
      return answer(q, tr(lang, '⌛ این رقابت دیگر فعال نیست.', '⌛ This duel is no longer active.'), true)
    }
    const lang = await callbackLang(String(duel.chatId))
    if (String(msg?.chat?.id) !== String(duel.chatId)) return answer(q, tr(lang, 'این بازی متعلق به گروه دیگری است.', 'This game belongs to another group.'), true)
    if (uid !== Number(duel.initiatorId) && uid !== Number(duel.opponentId)) {
      return answer(q, tr(lang, '⛔ فقط دو بازیکن این رقابت می‌توانند انتخاب کنند.', '⛔ Only the two duel players can make a choice.'), true)
    }
    if (Number(duel.deadline) <= Date.now()) return answer(q, tr(lang, '⌛ مهلت انتخاب به پایان رسیده است.', '⌛ The move deadline has passed.'), true)
    const field = uid === Number(duel.initiatorId) ? 'p1Choice' : 'p2Choice'
    const lockKey = `gw:move-lock:${id}`
    const lockToken = `${uid}:${Date.now()}:${Math.random().toString(36).slice(2)}`
    const locked = await redis.set(lockKey, lockToken, 'PX', 10000, 'NX')
    if (locked !== 'OK') return answer(q, tr(lang, '⌛ انتخاب دیگری در حال ثبت است؛ دوباره امتحان کن.', '⌛ Another move is being recorded. Try again.'), true)
    try {
      const result = await GroupDuel.updateOne(
        { _id: id, status: 'choosing', deadline: { $gt: Date.now() }, [field]: { $in: [null, undefined] } },
        { $set: { [field]: choice } },
      )
      if (!result.modifiedCount) {
        const latest = await GroupDuel.findById(id).lean() as any
        if (latest?.status !== 'choosing') return answer(q, tr(lang, '⌛ رقابت پایان یافته است.', '⌛ The duel has ended.'), true)
        return answer(q, tr(lang, '✅ انتخاب قبلاً ثبت شده؛ هر بازیکن فقط یک بار می‌تواند انتخاب کند.', '✅ Your move is already recorded. Each player may choose only once.'), true)
      }
      const fresh = await GroupDuel.findById(id).lean() as any
      if (fresh?.p1Choice && fresh?.p2Choice) {
        await settleDuel(id, false)
      } else if (fresh?.status === 'choosing') {
        await refreshGameProgress(fresh)
      }
      await answer(q, tr(lang, '✅ انتخاب ثبت شد.', '✅ Your choice was recorded.'))
    } finally {
      await redis.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", 1, lockKey, lockToken).catch(() => undefined)
    }
    return
  }

  await answer(q)
}

export async function expireInvite(id: string) {
  const session = await mongoose.startSession()
  let duel: any = null
  try {
    await session.withTransaction(async () => {
      const claimed = await GroupDuel.findOneAndUpdate(
        { _id: id, status: 'pending', inviteDeadline: { $lte: Date.now() } },
        { $set: { status: 'expired' } }, { new: true, session },
      ).lean() as any
      if (!claimed) return
      if (groupDuelHasStake(claimed)) await release(claimed.initiatorId, String(claimed.currency), Number(claimed.amount), `group:invite-release:${id}`, session)
      duel = claimed
    })
  } finally { await session.endSession() }
  if (!duel) return
  const lang = await callbackLang(String(duel.chatId))
  await closeInviteKeyboard(duel)
  const [u1, u2] = await Promise.all([getUser(duel.initiatorId), getUser(duel.opponentId)])
  const p1 = mention({ id: duel.initiatorId, first_name: u1?.firstName, last_name: u1?.lastName, username: u1?.username }, lang)
  const p2 = mention({ id: duel.opponentId, first_name: u2?.firstName, last_name: u2?.lastName, username: u2?.username }, lang)
  const mode = duel.mode === 'bet' ? tr(lang, 'شرطی', 'bet') : tr(lang, 'دوستانه', 'friendly')
  const showStake = duel.mode === 'bet' && Number(duel.amount) > 0 && groupDuelHasStake(duel)
  const stakeTextFa = showStake ? ` به مبلغ ${fmt(duel.amount, String(duel.currency))} ${curLabel(String(duel.currency), lang)}` : ' بدون شرط مالی'
  const stakeTextEn = showStake ? ` for ${fmt(duel.amount, String(duel.currency))} ${curLabel(String(duel.currency), lang)}` : ' with no stake'
  const text = tr(lang,
    `⌛ مهلت دعوت ${p1} از ${p2} برای رقابت ${mode}${stakeTextFa} تمام شد و دعوت خودکار رد شد.`,
    `⌛ ${p1}’s ${mode} duel invitation to ${p2}${stakeTextEn} expired and was automatically rejected.`,
  )
  await bot.api.sendMessage(Number(duel.chatId), text, {
    parse_mode: 'HTML', ...(duel.inviteMessageId ? { reply_parameters: { message_id: Number(duel.inviteMessageId) } } : {}),
  } as any).catch(() => undefined)
}
