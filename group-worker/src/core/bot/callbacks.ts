import { InlineKeyboard } from 'grammy'
import { logError } from '../logger'
import mongoose from 'mongoose'
import { bot } from './instance'
import { redis, langOf, tr, curLabel, fmt, mention, getUser, userStarted, startKeyboard } from '../runtime'
import { GroupConfig, GroupDuel } from '../models/index'
import { groupReminderAt, groupDuelHasStake, isOpenGroupChallenge, type GroupCurrency, type GroupMode } from '../contracts/group'
import { getFlow, reserve, release } from '../services/wallet'
import { advanceFlow, createInvite } from '../services/duel-flow'
import { groupLang, renderDashboard, renderTimeoutPanel } from '../services/group'
import { settleDuel } from '../services/settlement'
import { scheduleGroupInviteTimeout, scheduleGroupMatchReminder } from '../services/timing'
import { acknowledgePlayerChoice, closeInviteKeyboard, notifyOpponentChoice, sendPlayerGameForms, sendGroupDuelNotice, deleteDuelPublicNotices } from '../services/game-message'
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
    const ref = callbackMessageRef(q, uid)
    if (uid !== Number(flow.actorId) || String(msg?.chat?.id) !== String(flow.chatId)
      || !Number.isInteger(msg?.ephemeral_message_id)
      || (Number(flow.formMessageId) > 0 && Number(flow.formMessageId) !== Number(msg.ephemeral_message_id))) {
      return answer(q, tr(await callbackLang(flow.chatId), '⛔ این فرم برای شما نیست یا منقضی شده است.', '⛔ This form is not yours or has expired.'), true)
    }
    const parts = data.split(':')
    if (parts[2] === 'back') {
      const target = parts[3]
      if (!target) {
        await redis.del(`gw:flow:${uid}`)
        await editEphemeralMessage(Number(flow.chatId), uid, Number(msg.ephemeral_message_id), tr(await callbackLang(flow.chatId), 'فرایند دعوت لغو شد.', 'Invitation setup cancelled.'), { reply_markup: { inline_keyboard: [] } }).catch(() => undefined)
        return answer(q, tr(await callbackLang(flow.chatId), 'فرایند لغو شد.', 'Setup cancelled.'))
      }
      if (target === 'mode') { flow.mode = null; flow.currency = null }
      else if (target === 'currency') { flow.currency = null }
      else return answer(q)
      try {
        await advanceFlow(uid, flow, ref)
        await answer(q)
      } catch (error: any) {
        logError('group_flow_back_failed', error, { chatId: flow.chatId, userId: uid, target })
        await answer(q, tr(await callbackLang(flow.chatId), 'بازگشت انجام نشد؛ دوباره تلاش کن.', 'Could not go back. Try again.'), true)
      }
      return
    }
    if (parts[2] === 'mode' && (parts[3] === 'bet' || parts[3] === 'friendly')) flow.mode = parts[3] as GroupMode
    else if (parts[2] === 'cur' && (parts[3] === 'IRT' || parts[3] === 'TON')) flow.currency = parts[3] as GroupCurrency
    else if (parts[2] === 'amt') {
      const amount = Number(parts[3])
      try {
        await createInvite(uid, flow, amount, ref)
        await answer(q, (flow.openChallenge === true || Number(flow.targetId) <= 0) ? tr(await callbackLang(flow.chatId), '✅ درخواست عمومی دوئل در گروه منتشر شد.', '✅ Your public group challenge has been posted.') : tr(await callbackLang(flow.chatId), '✅ دعوت خصوصی ارسال شد.', '✅ Private invitation sent.'))
      } catch (error: any) {
        const lang = await callbackLang(flow.chatId)
        const message = error?.message === 'INSUFFICIENT_BALANCE'
          ? tr(lang, '❌ موجودی آزاد برای این مبلغ کافی نیست.', '❌ Insufficient available balance for this stake.')
          : error?.message === 'GROUP_CONFIG_CHANGED'
            ? tr(lang, '⚠️ تنظیمات گروه تغییر کرده است؛ فرم را دوباره باز کن.', '⚠️ Group settings changed; reopen the form.')
            : tr(lang, '❌ ساخت دعوت ناموفق بود؛ دوباره تلاش کن.', '❌ Could not create the invitation. Try again.')
        await answer(q, message, true)
      }
      return
    } else return answer(q)

    try {
      await advanceFlow(uid, flow, ref)
      await answer(q)
    } catch (error: any) {
      await answer(q, tr(await callbackLang(flow.chatId), '⚠️ ادامهٔ فرم ممکن نشد؛ دوباره از «دوئل» شروع کن.', '⚠️ The form could not continue. Start again with “duel”.'), true)
    }
    return
  }

  if (data.startsWith('gw:accept:') || data.startsWith('gw:reject:') || data.startsWith('gw:openaccept:')) {
    const isOpenAccept = data.startsWith('gw:openaccept:')
    const isReject = data.startsWith('gw:reject:')
    const id = data.split(':')[2]
    if (!id) return answer(q)
    const duel = await GroupDuel.findOne({ _id: id, status: 'pending' }).lean() as any
    if (!duel) return answer(q, tr(await callbackLang(String(msg?.chat?.id ?? '')), '⌛ این دعوت دیگر فعال نیست.', '⌛ This invitation is no longer active.'), true)
    const lang = await callbackLang(String(duel.chatId))
    const openChallenge = isOpenGroupChallenge(duel)

    if (isOpenAccept) {
      const publicNoticeIds = Array.isArray(duel.publicNoticeMessageIds) ? duel.publicNoticeMessageIds.map(Number) : []
      const validPublicMessage = Number(msg?.message_id) === Number(duel.inviteMessageId)
        || publicNoticeIds.includes(Number(msg?.message_id))
      if (!openChallenge || isReject || String(msg?.chat?.id) !== String(duel.chatId) || !validPublicMessage) {
        return answer(q, tr(lang, 'این درخواست عمومی معتبر نیست.', 'This public challenge is not valid.'), true)
      }
      if (uid === Number(duel.initiatorId)) return answer(q, tr(lang, '⛔ نمی‌توانی درخواست خودت را قبول کنی.', '⛔ You cannot accept your own challenge.'), true)
      if (q.from?.is_bot) return answer(q, tr(lang, 'ربات‌ها نمی‌توانند وارد دوئل شوند.', 'Bots cannot join duels.'), true)
      if (!(await userStarted(uid))) {
        const prompt = tr(lang,
          'برای پذیرش دوئل ابتدا ربات را در پیوی Start کن و سپس دوباره دکمهٔ پذیرش را بزن.',
          'Start the bot in private before accepting this duel, then tap Accept again.',
        )
        const keyboard = startKeyboard(lang)
        await sendEphemeralMessage(Number(duel.chatId), uid, prompt, keyboard ? { reply_markup: keyboard } : {}, {
          ...(Number(msg?.message_id) > 0 ? { replyMessageId: Number(msg.message_id) } : {}),
        }).catch((error) => logError('open_challenge_start_prompt_failed', error, { duelId: id, userId: uid }))
        return answer(q, tr(lang, 'ابتدا ربات را در پیوی Start کن.', 'Start the bot in private first.'), true)
      }
    } else {
      if (openChallenge || String(msg?.chat?.id) !== String(duel.chatId)
        || Number(msg?.ephemeral_message_id) !== Number(duel.opponentInviteEphemeralId)) {
        return answer(q, tr(lang, 'این دعوت خصوصی معتبر نیست.', 'This private invitation is not valid.'), true)
      }
      if (uid !== Number(duel.opponentId)) return answer(q, tr(lang, '⛔ فقط بازیکن دعوت‌شده می‌تواند پاسخ دهد.', '⛔ Only the invited player can respond.'), true)
    }
    if (Date.now() > Number(duel.inviteDeadline)) {
      await expireInvite(id)
      return answer(q, tr(lang, '⌛ مهلت این دعوت تمام شده است.', '⌛ This invitation has expired.'), true)
    }

    if (isReject) {
      const session = await mongoose.startSession()
      let rejected: any = null
      try {
        await session.withTransaction(async () => {
          rejected = null
          rejected = await GroupDuel.findOneAndUpdate(
            { _id: id, status: 'pending', inviteDeadline: { $gt: Date.now() }, opponentId: Number(duel.opponentId) },
            { $set: { status: 'rejected', outcome: 'opponent_rejected' } }, { new: true, session },
          ).lean() as any
          if (rejected && groupDuelHasStake(rejected)) await release(rejected.initiatorId, String(rejected.currency), Number(rejected.amount), `group:invite-release:${id}`, session)
        })
      } finally { await session.endSession() }
      if (!rejected) return answer(q, tr(lang, '⌛ دعوت دیگر فعال نیست.', '⌛ Invitation is no longer active.'), true)
      await closeInviteKeyboard(rejected)
      await deleteDuelPublicNotices(rejected)
      const [a, b] = await Promise.all([getUser(rejected.initiatorId), getUser(rejected.opponentId)])
      const p1 = mention({ id: rejected.initiatorId, first_name: a?.firstName, last_name: a?.lastName, username: a?.username }, lang)
      const p2 = mention({ id: rejected.opponentId, first_name: b?.firstName, last_name: b?.lastName, username: b?.username }, lang)
      const notice = tr(lang,
        `❌ ${p2} دعوت دوئل ${p1} را رد کرد. مبلغ رزروشده، در صورت وجود، آزاد شد.`,
        `❌ ${p2} rejected ${p1}’s duel invitation. Any reserved stake was released.`,
      )
      try {
        await sendGroupDuelNotice(id, Number(rejected.chatId), notice)
      } catch (error) {
        logError('group_rejection_notice_failed', error, { duelId: id, chatId: rejected.chatId })
        await Promise.all([Number(rejected.initiatorId), Number(rejected.opponentId)].map((playerId) =>
          sendEphemeralMessage(Number(rejected.chatId), playerId, notice, { parse_mode: 'HTML' }).catch(() => undefined),
        ))
      }
      return answer(q, tr(lang, 'دعوت رد شد.', 'Invitation rejected.'))
    }

    const acceptingUserId = isOpenAccept ? uid : Number(duel.opponentId)
    const session = await mongoose.startSession()
    let acceptedDuel: any = null
    let insufficient = false
    try {
      await session.withTransaction(async () => {
        acceptedDuel = null
        insufficient = false
        const current = await GroupDuel.findOne({ _id: id, status: 'pending', inviteDeadline: { $gt: Date.now() } }).session(session).lean() as any
        if (!current) return
        if (isOpenGroupChallenge(current) && Number(current.initiatorId) === acceptingUserId) return
        if (!isOpenGroupChallenge(current) && Number(current.opponentId) !== acceptingUserId) return
        if (groupDuelHasStake(current)) {
          try { await reserve(acceptingUserId, String(current.currency), Number(current.amount), session) }
          catch (error: any) { if (error?.message === 'INSUFFICIENT_BALANCE') { insufficient = true; return } throw error }
        }
        const cfg = await GroupConfig.findOne({ chatId: current.chatId }).session(session).lean() as any
        const seconds = Math.max(30, Math.min(600, Number(current.mode === 'bet' ? cfg?.betTimeoutSeconds : cfg?.friendlyTimeoutSeconds) || 180))
        const startedAt = Date.now()
        const deadline = startedAt + seconds * 1000
        const reminderAt = groupReminderAt(startedAt, seconds)
        const filter: any = { _id: id, status: 'pending', inviteDeadline: { $gt: Date.now() } }
        if (isOpenGroupChallenge(current)) {
          filter.initiatorId = { $ne: acceptingUserId }
          filter.$or = [{ opponentId: 0 }, { opponentId: null }, { opponentId: { $exists: false } }]
        } else {
          filter.opponentId = acceptingUserId
        }
        acceptedDuel = await GroupDuel.findOneAndUpdate(
          filter,
          { $set: { opponentId: acceptingUserId, status: 'choosing', deadline, reminderAt, reminderSent: false, p1Choice: null, p2Choice: null, gameFormsSent: false } },
          { new: true, session },
        ).lean() as any
        // If the conditional claim did not win, abort the transaction so a
        // just-reserved stake can never remain locked for a non-participant.
        if (!acceptedDuel) throw new Error('INVITE_ACCEPT_RACE')
      })
    } catch (error: any) {
      if (error?.message !== 'INVITE_ACCEPT_RACE') throw error
      acceptedDuel = null
    } finally { await session.endSession() }
    if (insufficient) return answer(q, tr(lang, '❌ موجودی آزاد کیف پولت برای این مبلغ کافی نیست.', '❌ Your available balance is insufficient for this stake.'), true)
    if (!acceptedDuel) return answer(q, tr(lang, '⌛ این دوئل قبلاً پذیرفته شده یا دیگر فعال نیست.', '⌛ This duel has already been accepted or is no longer active.'), true)

    await closeInviteKeyboard(acceptedDuel)
    await deleteDuelPublicNotices(acceptedDuel)
    const [acceptedBy, challenger] = await Promise.all([getUser(acceptingUserId), getUser(acceptedDuel.initiatorId)])
    const acceptedMention = mention({ id: acceptingUserId, first_name: acceptedBy?.firstName, last_name: acceptedBy?.lastName, username: acceptedBy?.username }, lang)
    const challengerMention = mention({ id: acceptedDuel.initiatorId, first_name: challenger?.firstName, last_name: challenger?.lastName, username: challenger?.username }, lang)
    const acceptedMode = acceptedDuel.mode === 'bet' ? tr(lang, 'شرطی', 'betting') : tr(lang, 'دوستانه', 'friendly')
    const acceptedStakeFa = groupDuelHasStake(acceptedDuel) ? `\n💰 مبلغ هر بازیکن: <b>${fmt(Number(acceptedDuel.amount), String(acceptedDuel.currency))} ${curLabel(String(acceptedDuel.currency), lang)}</b>` : '\n🆓 بدون شرط مالی'
    const acceptedStakeEn = groupDuelHasStake(acceptedDuel) ? `\n💰 Stake per player: <b>${fmt(Number(acceptedDuel.amount), String(acceptedDuel.currency))} ${curLabel(String(acceptedDuel.currency), lang)}</b>` : '\n🆓 No stake'
    let acceptedNoticeId = 0
    try {
      acceptedNoticeId = await sendGroupDuelNotice(id, Number(acceptedDuel.chatId), tr(lang,
        `✅ ${acceptedMention} دعوت ${challengerMention} را پذیرفت. رقابت ${acceptedMode} آغاز می‌شود.${acceptedStakeFa}`,
        `✅ ${acceptedMention} accepted ${challengerMention}’s ${acceptedMode} duel invitation. The game is starting.${acceptedStakeEn}`,
      ))
    } catch (error) {
      logError('group_acceptance_notice_failed', error, { duelId: id, chatId: acceptedDuel.chatId })
    }
    if (!acceptedNoticeId) {
      // The accepted status must be visible before private move forms are delivered.
      const rollback = await mongoose.startSession()
      try {
        await rollback.withTransaction(async () => {
          const current = await GroupDuel.findOneAndUpdate(
            { _id: id, status: 'choosing', gameFormsSent: { $ne: true } },
            { $set: { status: 'cancelled', outcome: 'acceptance_notice_failed', settledAt: new Date() } },
            { new: true, session: rollback },
          ).lean() as any
          if (current && groupDuelHasStake(current)) {
            await release(current.initiatorId, String(current.currency), Number(current.amount), `group:cancel-release:${id}:${current.initiatorId}`, rollback)
            await release(current.opponentId, String(current.currency), Number(current.amount), `group:cancel-release:${id}:${current.opponentId}`, rollback)
          }
        })
      } finally { await rollback.endSession() }
      const failedState = await GroupDuel.findById(id).lean() as any
      if (failedState) {
        await closeInviteKeyboard(failedState)
        await deleteDuelPublicNotices(failedState)
      }
      const failure = tr(lang,
        '⚠️ اعلام عمومی شروع دوئل در گروه انجام نشد؛ بازی آغاز نشد و مبالغ رزروشده آزاد شدند.',
        '⚠️ The duel start announcement could not be posted; the game was not started and reserved funds were released.',
      )
      await Promise.all([Number(acceptedDuel.initiatorId), Number(acceptingUserId)].map((playerId) =>
        sendEphemeralMessage(Number(acceptedDuel.chatId), playerId, failure).catch(() => undefined),
      ))
      return answer(q, tr(lang, 'اعلام شروع دوئل ارسال نشد؛ مبالغ آزاد شدند.', 'The duel announcement failed; reserved funds were released.'), true)
    }
    const fresh = await GroupDuel.findById(id).lean() as any
    try {
      await sendPlayerGameForms(fresh, acceptedNoticeId)
    } catch (error) {
      logError('group_private_game_forms_failed', error, { duelId: id })
      const rollback = await mongoose.startSession()
      try {
        await rollback.withTransaction(async () => {
          const current = await GroupDuel.findOneAndUpdate({ _id: id, status: 'choosing', gameFormsSent: { $ne: true } }, { $set: { status: 'cancelled', outcome: 'game_forms_failed', settledAt: new Date() } }, { new: true, session: rollback }).lean() as any
          if (current && groupDuelHasStake(current)) {
            await release(current.initiatorId, String(current.currency), Number(current.amount), `group:cancel-release:${id}:${current.initiatorId}`, rollback)
            await release(current.opponentId, String(current.currency), Number(current.amount), `group:cancel-release:${id}:${current.opponentId}`, rollback)
          }
        })
      } finally { await rollback.endSession() }
      const failedState = await GroupDuel.findById(id).lean() as any
      if (failedState) await deleteDuelPublicNotices(failedState)
      const failure = tr(lang, '⚠️ فرم اختصاصی بازی ارسال نشد؛ مبالغ رزروشده آزاد شدند.', '⚠️ Private game forms could not be sent; reserved funds were released.')
      await Promise.all([Number(acceptedDuel.initiatorId), Number(acceptingUserId)].map((playerId) => sendEphemeralMessage(Number(acceptedDuel.chatId), playerId, failure).catch(() => undefined)))
      return answer(q, tr(lang, 'شروع بازی ناموفق بود؛ مبالغ آزاد شدند.', 'Could not start the game; reserved funds were released.'), true)
    }
    try {
      const { scheduleGroupMatchTimeout } = await import('../services/timing')
      await Promise.all([
        scheduleGroupMatchTimeout(id, Number(fresh.deadline)),
        scheduleGroupMatchReminder(id, Number(fresh.reminderAt)),
      ])
      await GroupDuel.updateOne({ _id: id, status: 'choosing' }, { $set: { timingScheduledAt: new Date() } })
    } catch (error) {
      logError('match_timeout_or_reminder_schedule_failed', error, { duelId: id, deadline: fresh.deadline, reminderAt: fresh.reminderAt })
    }
    await answer(q, tr(lang, '✅ دعوت پذیرفته شد؛ فرم خصوصی بازی برای هر دو بازیکن ارسال شد.', '✅ Invitation accepted; each player received a private game form.'))
    return
  }

  if (data.startsWith('gw:cancel:')) {
    const id = data.split(':')[2]
    const duel = await GroupDuel.findOne({ _id: id, status: 'pending' }).lean() as any
    if (!duel) return answer(q, tr(await callbackLang(String(msg?.chat?.id ?? '')), '⌛ دعوت دیگر فعال نیست.', '⌛ Invitation is no longer active.'), true)
    const lang = await callbackLang(String(duel.chatId))
    if (String(msg?.chat?.id) !== String(duel.chatId) || uid !== Number(duel.initiatorId) || Number(msg?.ephemeral_message_id) !== Number(duel.initiatorWaitEphemeralId)) return answer(q, tr(lang, '⛔ فقط دعوت‌کننده می‌تواند این دعوت را لغو کند.', '⛔ Only the challenger can cancel this invitation.'), true)
    const session = await mongoose.startSession()
    let cancelled: any = null
    try {
      await session.withTransaction(async () => {
        cancelled = await GroupDuel.findOneAndUpdate({ _id: id, status: 'pending' }, { $set: { status: 'cancelled', outcome: 'initiator_cancelled' } }, { new: true, session }).lean() as any
        if (cancelled && groupDuelHasStake(cancelled)) await release(cancelled.initiatorId, String(cancelled.currency), Number(cancelled.amount), `group:invite-release:${id}`, session)
      })
    } finally { await session.endSession() }
    if (!cancelled) return answer(q, tr(lang, '⌛ دعوت دیگر فعال نیست.', '⌛ Invitation is no longer active.'), true)
    await closeInviteKeyboard(cancelled)
    await deleteDuelPublicNotices(cancelled)
    return answer(q, tr(lang, 'دعوت لغو شد و مبلغ رزروشده آزاد شد.', 'Invitation cancelled and the reserved stake was released.'))
  }

  if (data.startsWith('gw:rematch:')) {
    const parentId = data.split(':')[2]
    const parent = await GroupDuel.findOne({ _id: parentId, status: 'settled' }).lean() as any
    if (!parent) return answer(q, tr(await callbackLang(String(msg?.chat?.id ?? '')), 'فرصت شروع دوباره دیگر فعال نیست.', 'Rematch is no longer available.'), true)
    const lang = await callbackLang(String(parent.chatId))
    const ownCard = uid === Number(parent.initiatorId) ? parent.initiatorRematchEphemeralId : uid === Number(parent.opponentId) ? parent.opponentRematchEphemeralId : 0
    if (String(msg?.chat?.id) !== String(parent.chatId) || !ownCard || Number(msg?.ephemeral_message_id) !== Number(ownCard)) return answer(q, tr(lang, '⛔ این دکمه برای شما نیست.', '⛔ This button is not yours.'), true)
    const opponentId = uid === Number(parent.initiatorId) ? Number(parent.opponentId) : Number(parent.initiatorId)
    const cfg = await GroupConfig.findOne({ chatId: String(parent.chatId) }).lean() as any
    if (!cfg?.enabled) return answer(q, tr(lang, 'دوئل در این گروه غیرفعال است.', 'Duels are disabled in this group.'), true)
    const newId = `gd_${String(parent.chatId).replace(/-/g, '').slice(-10)}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    const inviteSeconds = Math.max(30, Math.min(300, Number(parent.mode === 'bet' ? cfg.betInviteTimeoutSeconds ?? cfg.inviteTimeoutSeconds : cfg.friendlyInviteTimeoutSeconds ?? cfg.inviteTimeoutSeconds) || 120))
    const inviteDeadline = Date.now() + inviteSeconds * 1000
    const rematchSession = await mongoose.startSession()
    let created = false
    try {
      await rematchSession.withTransaction(async () => {
        const lockedParent = await GroupDuel.findOneAndUpdate({ _id: parentId, status: 'settled', $or: [{ rematchDuelId: { $exists: false } }, { rematchDuelId: null }, { rematchDuelId: '' }] }, { $set: { rematchDuelId: newId } }, { new: true, session: rematchSession }).lean() as any
        if (!lockedParent) return
        if (groupDuelHasStake(parent)) await reserve(uid, String(parent.currency), Number(parent.amount), rematchSession)
        await GroupDuel.create([{
          _id: newId, chatId: String(parent.chatId), activatorId: parent.activatorId,
          initiatorId: uid, opponentId, mode: parent.mode, currency: parent.currency,
          amount: Number(parent.amount), status: 'pending', inviteDeadline, rematchOf: parentId,
          p1Choice: null, p2Choice: null, lifecycleVersion: 2, publicNoticeMessageIds: [],
        }], { session: rematchSession })
        created = true
      })
    } catch (error: any) {
      if (error?.message === 'INSUFFICIENT_BALANCE') return answer(q, tr(lang, 'موجودی آزاد برای شروع دوباره کافی نیست.', 'Insufficient available balance for a rematch.'), true)
      throw error
    } finally { await rematchSession.endSession() }
    if (!created) return answer(q, tr(lang, 'برای این دوئل قبلاً درخواست شروع دوباره ثبت شده است.', 'A rematch invitation has already been created for this duel.'), true)
    // The rematch control is shown on two recipient-only ephemeral reply cards.
    // Once either player activates it, remove both cards immediately.
    await Promise.all([
      Number(parent.initiatorRematchEphemeralId) > 0
        ? deleteEphemeralMessage(Number(parent.chatId), Number(parent.initiatorId), Number(parent.initiatorRematchEphemeralId)).catch(() => undefined)
        : Promise.resolve(),
      Number(parent.opponentRematchEphemeralId) > 0
        ? deleteEphemeralMessage(Number(parent.chatId), Number(parent.opponentId), Number(parent.opponentRematchEphemeralId)).catch(() => undefined)
        : Promise.resolve(),
    ])
    await GroupDuel.updateOne({ _id: parentId, status: 'settled' }, { $set: {
      initiatorRematchEphemeralId: null, opponentRematchEphemeralId: null,
    } })
    const [requester, other] = await Promise.all([getUser(uid), getUser(opponentId)])
    const requesterMention = mention({ id: uid, first_name: requester?.firstName, last_name: requester?.lastName, username: requester?.username }, lang)
    const otherMention = mention({ id: opponentId, first_name: other?.firstName, last_name: other?.lastName, username: other?.username }, lang)
    const modeLabel = parent.mode === 'bet' ? tr(lang, 'شرطی', 'bet') : tr(lang, 'دوستانه', 'friendly')
    const stakeLine = groupDuelHasStake(parent) ? tr(lang, `\n💰 مبلغ هر بازیکن: <b>${fmt(Number(parent.amount), String(parent.currency))} ${curLabel(String(parent.currency), lang)}</b>`, `\n💰 Stake per player: <b>${fmt(Number(parent.amount), String(parent.currency))} ${curLabel(String(parent.currency), lang)}</b>`) : tr(lang, '\n🆓 بدون شرط مالی', '\n🆓 No stake')
    const inviteMarkup = new InlineKeyboard().text(tr(lang, '✅ قبول', '✅ Accept'), `gw:accept:${newId}`).text(tr(lang, '❌ رد', '❌ Reject'), `gw:reject:${newId}`)
    const waitMarkup = new InlineKeyboard().text(tr(lang, '❌ لغو دعوت', '❌ Cancel invitation'), `gw:cancel:${newId}`)
    let inviteCard: any
    let waitCard: any
    try {
      const publicInviteText = tr(lang,
        `🔁 ${requesterMention} دوباره ${otherMention} را به دوئل ${modeLabel} دعوت کرد.${stakeLine}`,
        `🔁 ${requesterMention} invited ${otherMention} to a ${modeLabel} rematch.${stakeLine}`,
      )
      const publicInviteMessageId = await sendGroupDuelNotice(newId, Number(parent.chatId), publicInviteText)
      // Store the requester's cancel-card before the opponent gets an actionable
      // Accept button, preventing an instant acceptance from racing this write.
      waitCard = await sendEphemeralMessage(Number(parent.chatId), uid, tr(lang, `✅ درخواست شروع دوباره برای ${otherMention} ارسال شد.`, `✅ Rematch invitation sent to ${otherMention}.`), { parse_mode: 'HTML', reply_markup: { inline_keyboard: waitMarkup.inline_keyboard } })
      const savedWait = await GroupDuel.updateOne({ _id: newId, status: 'pending' }, { $set: { initiatorWaitEphemeralId: Number(waitCard.ephemeral_message_id) } })
      if (!savedWait.modifiedCount) throw new Error('REMATCH_WAIT_CARD_STATE_CHANGED')
      inviteCard = await sendEphemeralMessage(Number(parent.chatId), opponentId, tr(lang, `🔁 <b>دعوت شروع دوباره ${modeLabel}</b>\n${requesterMention} شما (${otherMention}) را به بازی مجدد دعوت کرده است.${stakeLine}`, `🔁 <b>${modeLabel} rematch invitation</b>\n${requesterMention} invited you (${otherMention}) to play again.${stakeLine}`), { parse_mode: 'HTML', reply_markup: { inline_keyboard: inviteMarkup.inline_keyboard } }, { replyMessageId: publicInviteMessageId })
      const savedInvite = await GroupDuel.updateOne({ _id: newId, status: 'pending' }, { $set: { opponentInviteEphemeralId: Number(inviteCard.ephemeral_message_id) } })
      if (!savedInvite.modifiedCount) throw new Error('REMATCH_INVITE_CARD_STATE_CHANGED')
      await scheduleGroupInviteTimeout(newId, inviteDeadline).catch(() => undefined)
    } catch (error) {
      if (inviteCard?.ephemeral_message_id) await deleteEphemeralMessage(Number(parent.chatId), opponentId, Number(inviteCard.ephemeral_message_id)).catch(() => undefined)
      if (waitCard?.ephemeral_message_id) await deleteEphemeralMessage(Number(parent.chatId), uid, Number(waitCard.ephemeral_message_id)).catch(() => undefined)
      const failedRematch = await GroupDuel.findById(newId).lean() as any
      if (failedRematch) await deleteDuelPublicNotices(failedRematch)
      const rollback = await mongoose.startSession()
      try {
        await rollback.withTransaction(async () => {
          const current = await GroupDuel.findOneAndUpdate({ _id: newId, status: 'pending' }, { $set: { status: 'cancelled', outcome: 'rematch_send_failed' } }, { new: true, session: rollback }).lean() as any
          if (current && groupDuelHasStake(current)) await release(uid, String(current.currency), Number(current.amount), `group:invite-send-failed:${newId}`, rollback)
          await GroupDuel.updateOne({ _id: parentId, rematchDuelId: newId }, { $unset: { rematchDuelId: 1 } }, { session: rollback })
        })
      } finally { await rollback.endSession() }
      return answer(q, tr(lang, 'ارسال دعوت شروع دوباره ناموفق بود.', 'Could not send rematch invitation.'), true)
    }
    return answer(q, tr(lang, 'دعوت شروع دوباره ارسال شد.', 'Rematch invitation sent.'))
  }

  if (data.startsWith('gw:move:')) {
    const [, , id, choice] = data.split(':')
    if (!id || !['r', 'p', 's'].includes(String(choice))) return answer(q)
    const duel = await GroupDuel.findOne({ _id: id, status: 'choosing' }).lean() as any
    if (!duel) return answer(q, tr(await callbackLang(String(msg?.chat?.id ?? '')), '⌛ این رقابت دیگر فعال نیست.', '⌛ This duel is no longer active.'), true)
    const lang = await callbackLang(String(duel.chatId))
    if (String(msg?.chat?.id) !== String(duel.chatId)) return answer(q, tr(lang, 'این بازی متعلق به گروه دیگری است.', 'This game belongs to another group.'), true)
    const isP1 = uid === Number(duel.initiatorId)
    const isP2 = uid === Number(duel.opponentId)
    if (!isP1 && !isP2) return answer(q, tr(lang, '⛔ فقط دو بازیکن این رقابت می‌توانند انتخاب کنند.', '⛔ Only the two duel players can make a choice.'), true)
    const ownFormId = Number(isP1 ? duel.initiatorGameEphemeralId : duel.opponentGameEphemeralId)
    if (!ownFormId || Number(msg?.ephemeral_message_id) !== ownFormId) return answer(q, tr(lang, '⛔ این فرم انتخاب برای شما نیست یا قدیمی است.', '⛔ This choice form is not yours or is outdated.'), true)
    if (Number(duel.deadline) <= Date.now()) return answer(q, tr(lang, '⌛ مهلت انتخاب به پایان رسیده است.', '⌛ The move deadline has passed.'), true)
    const field = isP1 ? 'p1Choice' : 'p2Choice'
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
      await acknowledgePlayerChoice(fresh, uid)
      if (fresh?.p1Choice && fresh?.p2Choice) await settleDuel(id, false)
      else await notifyOpponentChoice(fresh, uid)
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
      duel = null
      const claimed = await GroupDuel.findOneAndUpdate(
        { _id: id, status: 'pending', inviteDeadline: { $lte: Date.now() } },
        { $set: { status: 'expired', outcome: 'invite_expired' } }, { new: true, session },
      ).lean() as any
      if (!claimed) return
      if (groupDuelHasStake(claimed)) await release(claimed.initiatorId, String(claimed.currency), Number(claimed.amount), `group:invite-release:${id}`, session)
      duel = claimed
    })
  } finally { await session.endSession() }
  if (!duel) return
  await closeInviteKeyboard(duel)
  await deleteDuelPublicNotices(duel)
  // Open challenges expire silently after removing the public accept post and
  // the creator's private cancel card; there is no preselected opponent to mention.
  if (isOpenGroupChallenge(duel)) return
  const lang = await callbackLang(String(duel.chatId))
  const [a, b] = await Promise.all([getUser(duel.initiatorId), getUser(duel.opponentId)])
  const p1 = mention({ id: duel.initiatorId, first_name: a?.firstName, last_name: a?.lastName, username: a?.username }, lang)
  const p2 = mention({ id: duel.opponentId, first_name: b?.firstName, last_name: b?.lastName, username: b?.username }, lang)
  const text = tr(lang,
    `⌛ مهلت دعوت ${p1} از ${p2} تمام شد؛ مبلغ رزروشده، در صورت وجود، آزاد شد.`,
    `⌛ ${p1}’s invitation to ${p2} expired; any reserved stake was released.`,
  )
  await sendGroupDuelNotice(id, Number(duel.chatId), text).catch((error) => logError('group_invite_expired_notice_failed', error, { duelId: id }))
  await Promise.all([Number(duel.initiatorId), Number(duel.opponentId)].map((playerId) =>
    sendEphemeralMessage(Number(duel.chatId), playerId, text).catch(() => undefined),
  ))
}
