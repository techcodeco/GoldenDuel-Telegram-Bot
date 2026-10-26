import mongoose from 'mongoose'
import { InlineKeyboard } from 'grammy'
import { bot, redis, langOf, tr, curLabel, fmt, mention, userStarted, startKeyboard, getUser, groupKeyboard } from '../runtime'
import { GroupConfig, GroupDuel, Settings } from '../models/index'
import { setFlow, reserve, release } from './wallet'
import { scheduleGroupInviteTimeout } from './timing'
import { editEphemeralMessage, sendEphemeralMessage } from '../bot/ephemeral'
import { groupModeNeedsStake, type GroupFlow, type GroupCurrency, type GroupMode, type MessageReference } from '../contracts/group'
import { logError } from '../logger'

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
    .text(tr(lang, '🤝 دوستانه', '🤝 Friendly'), 'gw:flow:mode:friendly'))
}

function currencyKeyboard(lang: 'fa' | 'en') {
  return colorize(new InlineKeyboard()
    .text(tr(lang, '💵 تومان', '💵 Toman'), 'gw:flow:cur:IRT')
    .text('💎 TON', 'gw:flow:cur:TON'))
}

function amountKeyboard(amounts: number[], currency: GroupCurrency, lang: 'fa' | 'en') {
  const kb = new InlineKeyboard()
  amounts.slice(0, 12).forEach((amount, index) => {
    kb.text(`${fmt(amount, currency)} ${curLabel(currency, lang)}`, `gw:flow:amt:${amount}`)
    if (index % 2 === 1) kb.row()
  })
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
  let lang = langOf((await getUser(actor.id))?.lang)
  const reply = triggerMessageId ? { reply_parameters: { message_id: triggerMessageId } } : {}
  if (!(await userStarted(actor.id))) {
    await bot.api.sendMessage(chatId, tr(lang, 'برای دعوت به دوئل ابتدا ربات را در پیوی Start کن.', 'Start the bot in private before challenging anyone.'), {
      ...reply, ...(startKeyboard(lang) ? { reply_markup: startKeyboard(lang) } : {}),
    } as any)
    return
  }
  if (!(await userStarted(target.id))) {
    await bot.api.sendMessage(chatId, tr(lang,
      `${mention(target, lang)} برای تأیید یا رد دعوت باید ابتدا ربات را در پیوی Start کند.`,
      `${mention(target, lang)} must start the bot in private before accepting or rejecting the challenge.`,
    ), { ...reply, parse_mode: 'HTML', ...(startKeyboard(lang) ? { reply_markup: startKeyboard(lang) } : {}) } as any)
    return
  }
  const cfg = await GroupConfig.findOne({ chatId }).lean() as any
  if (!cfg || !cfg.enabled) return
  // All group duel form screens follow the language selected for this group,
  // not the challenger's personal/private-chat language.
  lang = langOf(cfg.language)
  const settings = await Settings.findById('main').lean() as any
  if (settings?.features?.duelsEnabled === false) {
    await bot.api.sendMessage(chatId, tr(lang, 'دوئل‌ها فعلاً توسط مالک ربات غیرفعال هستند.', 'Duels are currently disabled by the bot owner.'), reply as any)
    return
  }

  const modes: GroupMode[] = (cfg.allowedModes ?? ['bet', 'friendly']).filter((m: string): m is GroupMode => m === 'bet' || m === 'friendly')
  const currencies: GroupCurrency[] = (cfg.allowedCurrencies ?? ['IRT', 'TON']).filter((c: string): c is GroupCurrency => c === 'IRT' || c === 'TON')
  if (!modes.length || (modes.includes('bet') && !currencies.length)) return
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
  } catch (error) {
    logError('ephemeral_duel_form_send_failed', error, { chatId, actorId: actor.id, targetId: target.id, triggerMessageId })
    await redis.del(`gw:flow:${actor.id}`)
    await bot.api.sendMessage(chatId, tr(lang,
      '⚠️ فرم اختصاصی داخل گروه ارسال نشد. برای این قابلیت، ربات باید ادمین گروه باشد و تلگرام از پیام‌های خصوصی داخل گروه پشتیبانی کند.',
      '⚠️ The private in-group form could not be sent. The bot must be a group administrator and the Telegram client must support ephemeral group messages.',
    ), { ...reply } as any).catch(() => undefined)
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
        currency, amount: stake, mode, status: 'pending', inviteDeadline, triggerMessageId: flow.triggerMessageId, p1Choice: null, p2Choice: null,
      }], { session })
    })
  } finally {
    await session.endSession()
  }
  await redis.del(`gw:flow:${uid}`)

  const lang = langOf(cfg.language)
  const actorMention = mention({ id: uid, first_name: flow.actorName, username: flow.actorUsername }, lang)
  const targetMention = mention({ id: flow.targetId, first_name: flow.targetName, username: flow.targetUsername }, lang)
  const modeLabel = mode === 'bet' ? tr(lang, 'شرطی', 'betting') : tr(lang, 'دوستانه', 'friendly')
  const stakeLineFa = mode === 'bet' ? `\n💰 مبلغ هر بازیکن: <b>${fmt(stake, String(currency))} ${curLabel(String(currency), lang)}</b>` : '\n🆓 بدون شرط مالی؛ این رقابت دوستانه است.'
  const stakeLineEn = mode === 'bet' ? `\n💰 Stake per player: <b>${fmt(stake, String(currency))} ${curLabel(String(currency), lang)}</b>` : '\n🆓 No stake; this is a friendly duel.'
  const text = tr(lang,
    `⚔️ <b>دعوت به رقابت ${modeLabel}</b>\n${actorMention} از ${targetMention} دعوت کرد.${stakeLineFa}\n${targetMention}، برای تأیید یا رد دعوت ${Math.ceil((inviteDeadline - Date.now()) / 1000)} ثانیه فرصت داری.`,
    `⚔️ <b>${modeLabel} duel invitation</b>\n${actorMention} challenged ${targetMention}.${stakeLineEn}\n${targetMention}, you have ${Math.ceil((inviteDeadline - Date.now()) / 1000)} seconds to accept or reject.`,
  )

  let sent: any
  try {
    sent = await bot.api.sendMessage(Number(flow.chatId), text, {
      parse_mode: 'HTML',
      ...(flow.triggerMessageId ? { reply_parameters: { message_id: flow.triggerMessageId } } : {}),
      reply_markup: groupKeyboard([[
        { text: tr(lang, '✅ تأیید دعوت', '✅ Accept'), callback_data: `gw:accept:${id}` },
        { text: tr(lang, '❌ رد دعوت', '❌ Reject'), callback_data: `gw:reject:${id}` },
      ]]),
    } as any)
  } catch {
    const rollback = await mongoose.startSession()
    try {
      await rollback.withTransaction(async () => {
        if (mode === 'bet') await release(uid, String(currency), stake, `group:invite-send-failed:${id}`, rollback)
        await GroupDuel.updateOne({ _id: id, status: 'pending' }, { $set: { status: 'cancelled', outcome: 'invite_send_failed' } }, { session: rollback })
      })
    } finally {
      await rollback.endSession()
    }
    throw new Error('GROUP_SEND_FAILED')
  }

  await GroupDuel.updateOne({ _id: id }, { $set: { inviteMessageId: sent.message_id } })
  try {
    await scheduleGroupInviteTimeout(id, inviteDeadline)
    await GroupDuel.updateOne({ _id: id, status: 'pending' }, { $set: { timingScheduledAt: new Date() } })
  } catch (error) {
    // The BullMQ worker reconciles pending GroupDuel records if the stream request temporarily fails.
    logError('invite_timeout_schedule_failed', error, { duelId: id })
  }

  const waitText = tr(lang, '✅ دعوت در گروه ارسال شد؛ منتظر پاسخ حریف بمان.', '✅ The challenge was posted in the group. Wait for your opponent’s response.')
  if (formRef?.ephemeralMessageId && formRef.receiverUserId) {
    await editEphemeralMessage(formRef.chatId, formRef.receiverUserId, formRef.ephemeralMessageId, waitText, { reply_markup: { inline_keyboard: [] } }).catch(() => undefined)
  }
}
