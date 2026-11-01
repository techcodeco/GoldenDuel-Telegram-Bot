import mongoose from 'mongoose'
import { InlineKeyboard } from 'grammy'
import { bot, redis, langOf, tr, curLabel, fmt, mention, userStarted, getUser, startKeyboard } from '../runtime'
import { GroupConfig, GroupDuel, Settings } from '../models/index'
import { setFlow, reserve, release } from './wallet'
import { scheduleGroupInviteTimeout } from './timing'
import { deleteEphemeralMessage, editEphemeralMessage, sendEphemeralMessage } from '../bot/ephemeral'
import { groupModeNeedsStake, type GroupFlow, type GroupCurrency, type GroupMode, type MessageReference } from '../contracts/group'
import { sendGroupDuelNotice, deleteDuelPublicNotices } from './game-message'
import { logError } from '../logger'

async function buildStartKeyboard(lang: 'fa' | 'en') {
  const configured = startKeyboard(lang)
  if (configured) return configured
  try {
    const me = await bot.api.getMe()
    if (!me.username) return undefined
    return { inline_keyboard: [[{
      text: tr(lang, '▶️ شروع ربات', '▶️ Start bot'),
      url: `https://t.me/${me.username}?start=group_duel`,
    }]] }
  } catch {
    return undefined
  }
}

function colorize<T extends { inline_keyboard?: any[][] }>(keyboard: T): T {
  for (const row of keyboard.inline_keyboard ?? []) for (const button of row) {
    const key = `${button.callback_data ?? ''} ${button.text ?? ''}`
    button.style = /reject|cancel|:back|:no(?:$|:)/i.test(key) ? 'danger' : /:amt:|accept|confirm|save|yes/i.test(key) ? 'success' : 'primary'
  }
  return keyboard
}

function choicePromptKeyboard(lang: 'fa' | 'en') {
  return colorize(new InlineKeyboard()
    .text(tr(lang, '🎲 شرطی', '🎲 Bet'), 'gw:flow:mode:bet')
    .text(tr(lang, '🤝 دوستانه', '🤝 Friendly'), 'gw:flow:mode:friendly')
    .row().text(tr(lang, '↩️ بازگشت', '↩️ Back'), 'gw:flow:back'))
}

function currencyKeyboard(lang: 'fa' | 'en') {
  return colorize(new InlineKeyboard()
    .text(tr(lang, '💵 تومان', '💵 Toman'), 'gw:flow:cur:IRT')
    .text('💎 TON', 'gw:flow:cur:TON')
    .row().text(tr(lang, '⬅️ بازگشت به نوع رقابت', '⬅️ Back to mode'), 'gw:flow:back:mode'))
}

function amountKeyboard(amounts: number[], currency: GroupCurrency, lang: 'fa' | 'en') {
  const kb = new InlineKeyboard()
  amounts.slice(0, 12).forEach((amount, index) => {
    kb.text(`${fmt(amount, currency)} ${curLabel(currency, lang)}`, `gw:flow:amt:${amount}`)
    if (index % 2 === 1) kb.row()
  })
  if (kb.inline_keyboard[kb.inline_keyboard.length - 1]?.length) kb.row()
  kb.text(tr(lang, '⬅️ بازگشت به انتخاب ارز', '⬅️ Back to currency'), 'gw:flow:back:currency')
  return colorize(kb)
}

async function showFlowPrompt(uid: number, flow: GroupFlow, text: string, keyboard: InlineKeyboard, ref?: MessageReference) {
  const markup = { inline_keyboard: keyboard.inline_keyboard }
  if (ref?.ephemeralMessageId && ref.receiverUserId) {
    await editEphemeralMessage(ref.chatId, ref.receiverUserId, ref.ephemeralMessageId, text, { parse_mode: 'HTML', reply_markup: markup })
    flow.formMessageId = ref.ephemeralMessageId
  } else {
    const sent = await sendEphemeralMessage(Number(flow.chatId), uid, text, { parse_mode: 'HTML', reply_markup: markup }, {
      ...(flow.triggerMessageId ? { replyMessageId: flow.triggerMessageId } : {}),
    })
    flow.formMessageId = Number(sent?.ephemeral_message_id ?? sent?.message_id ?? 0) || undefined
  }
  await setFlow(uid, flow)
}

export async function beginFlow(
  chatId: string,
  actor: { id: number; first_name?: string; last_name?: string; username?: string },
  target: { id: number; first_name?: string; last_name?: string; username?: string },
  triggerMessageId?: number,
) {
  const groupSettings = await GroupConfig.findOne({ chatId }).select('language').lean() as any
  let lang = langOf(groupSettings?.language ?? (await getUser(actor.id))?.lang)
  const privateNotice = async (receiverUserId: number, text: string, parseMode?: string, showStartButton = false) => {
    try {
      const keyboard = showStartButton ? await buildStartKeyboard(lang) : undefined
      await sendEphemeralMessage(Number(chatId), receiverUserId, text, {
        ...(parseMode ? { parse_mode: parseMode } : {}),
        ...(keyboard ? { reply_markup: keyboard } : {}),
      }, {
        ...(triggerMessageId ? { replyMessageId: triggerMessageId } : {}),
      })
    } catch (error) {
      logError('group_private_precondition_notice_failed', error, { chatId, receiverUserId, actorId: actor.id, targetId: target.id })
    } finally {
      if (triggerMessageId) await bot.api.deleteMessage(chatId, triggerMessageId).catch(() => undefined)
    }
  }
  if (!(await userStarted(actor.id))) {
    await privateNotice(actor.id, tr(lang, 'برای دعوت به دوئل ابتدا ربات را در پیوی Start کن.', 'Start the bot in private before challenging anyone.'), undefined, true)
    return
  }
  if (!(await userStarted(target.id))) {
    await privateNotice(target.id, tr(lang,
      `${mention(target, lang)} برای تأیید یا رد دعوت باید ابتدا ربات را در پیوی Start کند.`,
      `${mention(target, lang)} must start the bot in private before accepting or rejecting the challenge.`,
    ), 'HTML', true)
    return
  }
  const cfg = await GroupConfig.findOne({ chatId }).lean() as any
  if (!cfg || !cfg.enabled) return
  // All group duel form screens follow the language selected for this group,
  // not the challenger's personal/private-chat language.
  lang = langOf(cfg.language)
  const settings = await Settings.findById('main').lean() as any
  if (settings?.features?.duelsEnabled === false) {
    await privateNotice(actor.id, tr(lang, 'دوئل‌ها فعلاً توسط مالک ربات غیرفعال هستند.', 'Duels are currently disabled by the bot owner.'))
    return
  }

  const modes: GroupMode[] = (cfg.allowedModes ?? ['bet', 'friendly']).filter((m: string): m is GroupMode => m === 'bet' || m === 'friendly')
  const currencies: GroupCurrency[] = (cfg.allowedCurrencies ?? ['IRT', 'TON']).filter((c: string): c is GroupCurrency => c === 'IRT' || c === 'TON')
  if (!modes.length || (modes.includes('bet') && !currencies.length)) {
    await privateNotice(actor.id, tr(lang, 'در حال حاضر هیچ حالت مجازی برای دوئل در این گروه فعال نیست.', 'No duel mode is currently enabled in this group.'))
    return
  }
  const flow: GroupFlow = {
    chatId, actorId: actor.id,
    actorName: [actor.first_name, actor.last_name].filter(Boolean).join(' ') || '', actorUsername: actor.username ?? '',
    targetId: target.id, targetName: [target.first_name, target.last_name].filter(Boolean).join(' ') || '', targetUsername: target.username ?? '',
    mode: modes.length === 1 ? modes[0] : null, currency: currencies.length === 1 ? currencies[0] : null,
    step: 'mode', triggerMessageId,
  }

  await setFlow(actor.id, flow)
  try {
    if (modes.length > 1) {
      await showFlowPrompt(actor.id, flow, tr(lang, '🎮 <b>نوع رقابت را انتخاب کن</b>', '🎮 <b>Choose duel mode</b>'), choicePromptKeyboard(lang))
    } else {
      await advanceFlow(actor.id, flow)
    }
    if (triggerMessageId) await bot.api.deleteMessage(chatId, triggerMessageId).catch(() => undefined)
  } catch (error) {
    logError('ephemeral_duel_form_send_failed', error, { chatId, actorId: actor.id, targetId: target.id, triggerMessageId })
    await redis.del(`gw:flow:${actor.id}`)
    // Fail closed: never replace a private form with a public group message.
  }
}

export async function advanceFlow(uid: number, flow: GroupFlow, edit?: MessageReference) {
  const cfg = await GroupConfig.findOne({ chatId: flow.chatId }).lean() as any
  if (!cfg || !cfg.enabled) throw new Error('GROUP_DISABLED')
  // Keep every step (mode, currency, stake, and button labels) in the group's selected language.
  const lang = langOf(cfg.language)
  const modes: GroupMode[] = (cfg.allowedModes ?? ['bet', 'friendly']).filter((m: string): m is GroupMode => m === 'bet' || m === 'friendly')
  const currencies: GroupCurrency[] = (cfg.allowedCurrencies ?? ['IRT', 'TON']).filter((c: string): c is GroupCurrency => c === 'IRT' || c === 'TON')
  if (!modes.length || (modes.includes('bet') && !currencies.length)) throw new Error('GROUP_CONFIG_EMPTY')
  if (flow.mode && !modes.includes(flow.mode)) throw new Error('INVALID_MODE')
  if (!flow.mode && modes.length > 1) {
    flow.step = 'mode'
    await showFlowPrompt(uid, flow, tr(lang, '🎮 <b>نوع رقابت را انتخاب کن</b>', '🎮 <b>Choose duel mode</b>'), choicePromptKeyboard(lang), edit)
    return
  }
  if (!flow.mode) flow.mode = modes[0] ?? null

  // A friendly duel is completely stake-free: do not ask for a currency or amount.
  // It is posted as an invitation immediately after the user chooses this mode.
  if (!groupModeNeedsStake(flow.mode)) {
    flow.currency = null
    flow.step = 'mode'
    await createInvite(uid, flow, 0, edit)
    return
  }

  if (flow.currency && !currencies.includes(flow.currency)) throw new Error('INVALID_CURRENCY')
  if (!flow.currency && currencies.length > 1) {
    flow.step = 'currency'
    await showFlowPrompt(uid, flow, tr(lang, '💱 <b>ارز رقابت را انتخاب کن</b>', '💱 <b>Choose currency</b>'), currencyKeyboard(lang), edit)
    return
  }
  if (!flow.currency) flow.currency = currencies[0] ?? null
  const currency = flow.currency
  if (!currency || !currencies.includes(currency)) throw new Error('INVALID_CURRENCY')
  const settings = await Settings.findById('main').lean() as any
  const configured = Array.isArray(settings?.bets?.[currency]) ? settings.bets[currency] : undefined
  const amounts = configured ?? (currency === 'IRT' ? [10000, 20000, 30000, 50000] : [100000000, 200000000, 500000000, 1000000000])
  flow.step = 'amount'
  await showFlowPrompt(uid, flow, tr(lang, '💰 <b>مبلغ هر بازیکن را انتخاب کن</b>', '💰 <b>Choose the stake per player</b>'), amountKeyboard(amounts, currency, lang), edit)
}

export async function createInvite(uid: number, flow: GroupFlow, amount: number, formRef?: MessageReference) {
  const mode = flow.mode
  if (!mode) throw new Error('INCOMPLETE_FLOW')
  const currency: GroupCurrency | null = mode === 'bet' ? flow.currency : null
  const stake = mode === 'bet' ? amount : 0
  const cfg = await GroupConfig.findOne({ chatId: flow.chatId }).lean() as any
  const allowedModes = Array.isArray(cfg?.allowedModes) ? cfg.allowedModes : ['bet', 'friendly']
  const allowedCurrencies = Array.isArray(cfg?.allowedCurrencies) ? cfg.allowedCurrencies : ['IRT', 'TON']
  if (!cfg || !cfg.enabled || !['bet', 'friendly'].includes(mode) || !allowedModes.includes(mode)) throw new Error('GROUP_CONFIG_CHANGED')
  if (mode === 'bet') {
    if (!currency || !['IRT', 'TON'].includes(currency) || !allowedCurrencies.includes(currency)) throw new Error('GROUP_CONFIG_CHANGED')
    if (!Number.isSafeInteger(stake) || stake <= 0) throw new Error('INVALID_AMOUNT')
    const settings = await Settings.findById('main').lean() as any
    const configuredAmounts = settings?.bets?.[currency]
    if (Array.isArray(configuredAmounts) && !configuredAmounts.some((n: unknown) => Number(n) === stake)) throw new Error('INVALID_AMOUNT')
  }

  const id = `gd_${flow.chatId.replace(/-/g, '').slice(-10)}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
  const inviteTimeout = mode === 'bet'
    ? Number(cfg.betInviteTimeoutSeconds ?? cfg.inviteTimeoutSeconds ?? 120)
    : Number(cfg.friendlyInviteTimeoutSeconds ?? cfg.inviteTimeoutSeconds ?? 120)
  const inviteDeadline = Date.now() + Math.max(30, Math.min(300, inviteTimeout || 120)) * 1000
  const session = await mongoose.startSession()
  try {
    await session.withTransaction(async () => {
      if (mode === 'bet') await reserve(uid, String(currency), stake, session)
      await GroupDuel.create([{
        _id: id, chatId: flow.chatId, activatorId: cfg.activatorId, initiatorId: uid, opponentId: flow.targetId,
        currency, amount: stake, mode, status: 'pending', inviteDeadline, triggerMessageId: flow.triggerMessageId,
        p1Choice: null, p2Choice: null, reminderSent: false, lifecycleVersion: 2, publicNoticeMessageIds: [],
      }], { session })
    })
  } finally {
    await session.endSession()
  }

  const lang = langOf(cfg.language)
  const actorMention = mention({ id: uid, first_name: flow.actorName, username: flow.actorUsername }, lang)
  const targetMention = mention({ id: flow.targetId, first_name: flow.targetName, username: flow.targetUsername }, lang)
  const modeLabel = mode === 'bet' ? tr(lang, 'شرطی', 'betting') : tr(lang, 'دوستانه', 'friendly')
  const stakeLineFa = mode === 'bet' ? `\n💰 مبلغ هر بازیکن: <b>${fmt(stake, String(currency))} ${curLabel(String(currency), lang)}</b>` : '\n🆓 بدون شرط مالی؛ این رقابت دوستانه است.'
  const stakeLineEn = mode === 'bet' ? `\n💰 Stake per player: <b>${fmt(stake, String(currency))} ${curLabel(String(currency), lang)}</b>` : '\n🆓 No stake; this is a friendly duel.'
  const inviteText = tr(lang,
    `⚔️ <b>دعوت خصوصی به رقابت ${modeLabel}</b>\n${actorMention} از شما (${targetMention}) دعوت کرده است.${stakeLineFa}\nبرای پاسخ ${Math.ceil((inviteDeadline - Date.now()) / 1000)} ثانیه فرصت داری.`,
    `⚔️ <b>Private ${modeLabel} duel invitation</b>\n${actorMention} challenged you (${targetMention}).${stakeLineEn}\nYou have ${Math.ceil((inviteDeadline - Date.now()) / 1000)} seconds to respond.`,
  )
  const waitText = tr(lang,
    `✅ دعوت خصوصی برای ${targetMention} ارسال شد.\n${stakeLineFa}\nتا پاسخ حریف منتظر بمان یا دعوت را لغو کن.`,
    `✅ A private invitation was sent to ${targetMention}.\n${stakeLineEn}\nWait for the response or cancel the invitation.`,
  )
  const publicInviteText = tr(lang,
    `⚔️ ${actorMention} کاربر ${targetMention} را به یک دوئل ${modeLabel} دعوت کرد.${stakeLineFa}`,
    `⚔️ ${actorMention} challenged ${targetMention} to a ${modeLabel} duel.${stakeLineEn}`,
  )

  let opponentCard: any
  let initiatorCard: any
  try {
    // Public, notification-capable group announcement comes first. The actionable
    // invitation remains an ephemeral card visible only to the invited opponent.
    const publicInviteMessageId = await sendGroupDuelNotice(id, Number(flow.chatId), publicInviteText)

    // Persist the challenger's waiting card before exposing the opponent's
    // actionable invitation. This closes the fast-accept race where the
    // opponent could accept before X's cancel-card ID had been stored.
    const waitKeyboard = colorize(new InlineKeyboard().text(tr(lang, '❌ لغو دعوت', '❌ Cancel invitation'), `gw:cancel:${id}`))
    if (formRef?.ephemeralMessageId && formRef.receiverUserId === uid) {
      await editEphemeralMessage(formRef.chatId, uid, formRef.ephemeralMessageId, waitText, {
        parse_mode: 'HTML', reply_markup: { inline_keyboard: waitKeyboard.inline_keyboard },
      })
      initiatorCard = { ephemeral_message_id: formRef.ephemeralMessageId }
    } else {
      initiatorCard = await sendEphemeralMessage(Number(flow.chatId), uid, waitText, {
        parse_mode: 'HTML', reply_markup: { inline_keyboard: waitKeyboard.inline_keyboard },
      })
    }
    const savedWait = await GroupDuel.updateOne({ _id: id, status: 'pending' }, { $set: {
      initiatorWaitEphemeralId: Number(initiatorCard?.ephemeral_message_id),
    } })
    if (!savedWait.modifiedCount) throw new Error('INITIATOR_WAIT_CARD_STATE_CHANGED')

    const inviteKeyboard = colorize(new InlineKeyboard()
      .text(tr(lang, '✅ قبول', '✅ Accept'), `gw:accept:${id}`)
      .text(tr(lang, '❌ رد', '❌ Reject'), `gw:reject:${id}`))
    opponentCard = await sendEphemeralMessage(Number(flow.chatId), flow.targetId, inviteText, {
      parse_mode: 'HTML', reply_markup: { inline_keyboard: inviteKeyboard.inline_keyboard },
    }, { replyMessageId: publicInviteMessageId })
    const savedInvite = await GroupDuel.updateOne({ _id: id, status: 'pending' }, { $set: {
      opponentInviteEphemeralId: Number(opponentCard?.ephemeral_message_id),
    } })
    if (!savedInvite.modifiedCount) throw new Error('OPPONENT_INVITE_CARD_STATE_CHANGED')
  } catch (error) {
    if (opponentCard?.ephemeral_message_id) await deleteEphemeralMessage(Number(flow.chatId), flow.targetId, Number(opponentCard.ephemeral_message_id)).catch(() => undefined)
    const failedDuel = await GroupDuel.findById(id).lean() as any
    if (failedDuel) await deleteDuelPublicNotices(failedDuel)
    if (initiatorCard?.ephemeral_message_id) {
      const sameAsFlow = Number(formRef?.ephemeralMessageId) === Number(initiatorCard.ephemeral_message_id)
        && Number(formRef?.receiverUserId) === uid
      if (sameAsFlow) {
        await editEphemeralMessage(Number(flow.chatId), uid, Number(initiatorCard.ephemeral_message_id),
          tr(lang, '⚠️ ارسال دعوت ناموفق بود؛ دوباره تلاش کن.', '⚠️ The invitation could not be sent. Please start again.'),
          { reply_markup: { inline_keyboard: [] } },
        ).catch(() => undefined)
      } else {
        await deleteEphemeralMessage(Number(flow.chatId), uid, Number(initiatorCard.ephemeral_message_id)).catch(() => undefined)
      }
    }
    const rollback = await mongoose.startSession()
    try {
      await rollback.withTransaction(async () => {
        const current = await GroupDuel.findOneAndUpdate({ _id: id, status: 'pending' }, { $set: { status: 'cancelled', outcome: 'invite_send_failed' } }, { new: true, session: rollback }).lean() as any
        if (current?.mode === 'bet') await release(uid, String(current.currency), Number(current.amount), `group:invite-send-failed:${id}`, rollback)
      })
    } finally { await rollback.endSession() }
    throw new Error('GROUP_SEND_FAILED')
  }

  await redis.del(`gw:flow:${uid}`)
  try {
    await scheduleGroupInviteTimeout(id, inviteDeadline)
    await GroupDuel.updateOne({ _id: id, status: 'pending' }, { $set: { timingScheduledAt: new Date() } })
  } catch (error) {
    // BullMQ reconciles pending invitations if the stream request is temporarily unavailable.
    logError('invite_timeout_schedule_failed', error, { duelId: id })
  }
}
