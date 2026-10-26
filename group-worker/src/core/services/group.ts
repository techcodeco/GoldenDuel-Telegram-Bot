import { InlineKeyboard } from 'grammy'
import mongoose from 'mongoose'
import { bot, redis, langOf, tr, esc, curLabel, fmt } from '../runtime'
import { sendEphemeralMessage } from '../bot/ephemeral'
import { GroupTarget, GroupConfig, GroupDuel } from '../models/index'
import { groupDuelHasStake } from '../contracts/group'
import { logError } from '../logger'
import { release } from './wallet'

const MODES = ['bet', 'friendly'] as const
const CURRENCIES = ['IRT', 'TON'] as const

function colorizeInlineKeyboard<T extends { inline_keyboard?: any[][] }>(keyboard: T): T {
  for (const row of keyboard.inline_keyboard ?? []) {
    for (const button of row) {
      const key = `${button.callback_data ?? ''} ${button.text ?? ''}`
      button.style = /reject|cancel|delete|remove|:no(?:$|:)|لغو|رد دعوت/i.test(key) ? 'danger'
        : /accept|confirm|save|:amt:|enable|yes|approve|management|مدیریت|ذخیره|تأیید/i.test(key) ? 'success'
          : /duel|fight|competition|rock|paper|scissors|دوئل|رقابت|سنگ|کاغذ|قیچی/i.test(key) ? 'primary'
            : 'primary'
    }
  }
  return keyboard
}

async function deleteKeysByPattern(pattern: string): Promise<void> {
  let cursor = '0'
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200)
    cursor = next
    for (let i = 0; i < keys.length; i += 200) {
      const batch = keys.slice(i, i + 200)
      if (batch.length) await redis.del(...batch)
    }
  } while (cursor !== '0')
}

/**
 * Remove all group-owned runtime state and history when Telegram tells us the bot was removed.
 * Open games are cancelled and reserved stakes are returned before their records are erased.
 * Accounting ledger rows are intentionally retained: they are financial audit records, not group configuration.
 */
export async function removeGroupData(chatId: string): Promise<void> {
  const storedDuels = await GroupDuel.find({ chatId }).select('_id').lean() as Array<{ _id: string }>
  const session = await mongoose.startSession()
  try {
    await session.withTransaction(async () => {
      const openDuels = await GroupDuel.find({ chatId, status: { $in: ['pending', 'choosing'] } }).session(session).lean() as any[]
      for (const duel of openDuels) {
        const claimed = await GroupDuel.findOneAndUpdate(
          { _id: duel._id, status: duel.status },
          { $set: { status: 'cancelled', outcome: 'bot_removed', settledAt: new Date() } },
          { new: true, session },
        ).lean() as any
        if (!claimed) continue
        // `claimed.status` is already `cancelled` because of the update above;
        // branch on the original duel status so a pending invitation only refunds
        // the initiator's reserved stake (the opponent has not paid yet).
        if (groupDuelHasStake(claimed)) {
          if (duel.status === 'pending') {
            await release(Number(claimed.initiatorId), String(claimed.currency), Number(claimed.amount), `group:invite-release:${claimed._id}`, session)
          } else {
            await release(Number(claimed.initiatorId), String(claimed.currency), Number(claimed.amount), `group:cancel-release:${claimed._id}:${claimed.initiatorId}`, session)
            await release(Number(claimed.opponentId), String(claimed.currency), Number(claimed.amount), `group:cancel-release:${claimed._id}:${claimed.opponentId}`, session)
          }
        }
      }
      await GroupDuel.deleteMany({ chatId }).session(session)
      await GroupConfig.deleteOne({ chatId }).session(session)
      await GroupTarget.deleteOne({ chatId }).session(session)
    })
  } finally {
    await session.endSession()
  }

  await Promise.all([
    deleteKeysByPattern(`gw:cfg:${chatId}:*`),
    deleteKeysByPattern(`gw:timeout-input:${chatId}:*`),
    ...storedDuels.map((duel) => redis.del(`gw:move-lock:${duel._id}`)),
  ])

  // A player can have a private-in-group form open even if the flow key is keyed only by user ID.
  let cursor = '0'
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', 'gw:flow:*', 'COUNT', 200)
    cursor = next
    for (let i = 0; i < keys.length; i += 200) {
      const batch = keys.slice(i, i + 200)
      if (!batch.length) continue
      const values = await redis.mget(...batch)
      const stale = batch.filter((key, index) => {
        try { return String(JSON.parse(values[index] ?? 'null')?.chatId ?? '') === chatId } catch { return false }
      })
      if (stale.length) await redis.del(...stale)
    }
  } while (cursor !== '0')
}

export async function saveGroup(chat: any, activatorId: number, status: 'active' | 'left' = 'active') {
  const chatId = String(chat.id)
  if (status === 'left') {
    await removeGroupData(chatId)
    return
  }

  await GroupTarget.updateOne(
    { chatId },
    { $set: { title: String(chat.title ?? ''), username: String(chat.username ?? ''), type: chat.type, status: 'active', lastSeenAt: new Date() }, $setOnInsert: { addedAt: new Date() } },
    { upsert: true },
  )
  const defaults = {
    title: String(chat.title ?? ''), activatorId, language: 'fa', allowedModes: ['bet', 'friendly'],
    allowedCurrencies: ['IRT', 'TON'], inviteTimeoutSeconds: 120, betInviteTimeoutSeconds: 120,
    friendlyInviteTimeoutSeconds: 120, betTimeoutSeconds: 180, friendlyTimeoutSeconds: 120, enabled: true,
  }
  const { title: _unusedTitle, ...insertDefaults } = defaults
  await GroupConfig.updateOne({ chatId }, { $set: { title: String(chat.title ?? '') }, $setOnInsert: { chatId, ...insertDefaults } }, { upsert: true })
  await GroupConfig.updateOne({ chatId, enabled: false }, { $set: defaults })
}

export async function groupLang(chatId: string): Promise<'fa' | 'en'> {
  const c = await GroupConfig.findOne({ chatId }).lean() as any
  return langOf(c?.language)
}

export async function sendHelp(chatId: number | string, lang: 'fa' | 'en', replyToMessageId?: number) {
  const text = tr(lang,
    '⚔️ <b>راهنمای دوئل گروهی</b>\nبرای دعوت، روی پیام حریف ریپلای کن و دقیقاً یکی از واژه‌های «دوئل»، «فایت» یا «رقابت» را بفرست.\nبعد از انتخاب نوع رقابت، برای بازی شرطی فرم ارز و مبلغ نمایش داده می‌شود؛ رقابت دوستانه بدون شرط مالی است.\nبرای تنظیمات گروه، «پنل» را بفرست.',
    '⚔️ <b>Group duel guide</b>\nTo challenge someone, reply to their message and send exactly “duel”, “fight”, or “competition”.\nAfter choosing the mode, currency and stake are requested only for bet duels; friendly duels have no stake.\nSend “panel” to manage this group.',
  )
  await bot.api.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    ...(replyToMessageId ? { reply_parameters: { message_id: replyToMessageId } } : {}),
  } as any)
}

function modeText(cfg: any, lang: 'fa' | 'en') {
  const modes = Array.isArray(cfg.allowedModes) ? cfg.allowedModes : MODES
  if (modes.includes('bet') && modes.includes('friendly')) return tr(lang, 'شرطی + دوستانه', 'Bet + Friendly')
  if (modes.includes('bet')) return tr(lang, 'فقط شرطی', 'Bet only')
  if (modes.includes('friendly')) return tr(lang, 'فقط دوستانه', 'Friendly only')
  return tr(lang, 'هیچ‌کدام', 'Disabled')
}

function currencyText(cfg: any, lang: 'fa' | 'en') {
  const currencies = Array.isArray(cfg.allowedCurrencies) ? cfg.allowedCurrencies : CURRENCIES
  if (currencies.includes('IRT') && currencies.includes('TON')) return tr(lang, 'تومان + TON', 'Toman + TON')
  if (currencies.includes('IRT')) return tr(lang, 'فقط تومان', 'Toman only')
  if (currencies.includes('TON')) return tr(lang, 'فقط TON', 'TON only')
  return tr(lang, 'بدون ارز', 'No currency')
}

export function dashboardKeyboard(lang: 'fa' | 'en', chatId: string, cfg: any = {}) {
  const p = `gw:cfg:${chatId}:`
  const modes = Array.isArray(cfg.allowedModes) ? cfg.allowedModes : ['bet', 'friendly']
  const currencies = Array.isArray(cfg.allowedCurrencies) ? cfg.allowedCurrencies : ['IRT', 'TON']
  const isBothModes = modes.includes('bet') && modes.includes('friendly')
  const isBothCurrencies = currencies.includes('IRT') && currencies.includes('TON')
  const betInvite = Number(cfg.betInviteTimeoutSeconds ?? cfg.inviteTimeoutSeconds ?? 120)
  const friendlyInvite = Number(cfg.friendlyInviteTimeoutSeconds ?? cfg.inviteTimeoutSeconds ?? 120)
  const betGame = Number(cfg.betTimeoutSeconds ?? 180)
  const friendlyGame = Number(cfg.friendlyTimeoutSeconds ?? 120)
  const fa = lang === 'fa'
  const mark = (active: boolean) => active ? '✅ ' : '▫️ '

  const seconds = (value: number) => fa ? `${value} ثانیه` : `${value}s`
  return colorizeInlineKeyboard(new InlineKeyboard()
    .text(`${cfg.language === 'fa' ? '✅' : '▫️'} 🇮🇷 فارسی`, `${p}lang:fa`)
    .text(`${cfg.language === 'en' ? '✅' : '▫️'} 🇬🇧 English`, `${p}lang:en`)
    .row()
    .text(`${mark(modes.length === 1 && modes[0] === 'friendly')}${fa ? 'فقط دوستانه' : 'Friendly only'}`, `${p}mode:friendly`)
    .text(`${mark(modes.length === 1 && modes[0] === 'bet')}${fa ? 'فقط شرطی' : 'Bet only'}`, `${p}mode:bet`)
    .row()
    .text(`${mark(isBothModes)}${fa ? 'هر دو حالت' : 'Both modes'}`, `${p}mode:both`)
    .row()
    .text(`${mark(currencies.length === 1 && currencies[0] === 'IRT')}${fa ? 'فقط تومان' : 'Toman only'}`, `${p}cur:IRT`)
    .text(`${mark(currencies.length === 1 && currencies[0] === 'TON')}${fa ? 'فقط TON' : 'TON only'}`, `${p}cur:TON`)
    .row()
    .text(`${mark(isBothCurrencies)}${fa ? 'هر دو ارز' : 'Both currencies'}`, `${p}cur:both`)
    .row()
    .text(`⏱ ${fa ? 'دعوت شرطی' : 'Bet invite'} · ${seconds(betInvite)} ⚙️`, `${p}timeout:inviteBet:panel`)
    .row()
    .text(`⏱ ${fa ? 'دعوت دوستانه' : 'Friendly invite'} · ${seconds(friendlyInvite)} ⚙️`, `${p}timeout:inviteFriendly:panel`)
    .row()
    .text(`🎯 ${fa ? 'انتخاب شرطی' : 'Bet move time'} · ${seconds(betGame)} ⚙️`, `${p}timeout:bet:panel`)
    .row()
    .text(`🎯 ${fa ? 'انتخاب دوستانه' : 'Friendly move time'} · ${seconds(friendlyGame)} ⚙️`, `${p}timeout:friendly:panel`))
}

const timeoutConfig = (cfg: any, kind: string) => {
  const key = kind === 'inviteBet' ? 'betInviteTimeoutSeconds'
    : kind === 'inviteFriendly' ? 'friendlyInviteTimeoutSeconds'
      : kind === 'bet' ? 'betTimeoutSeconds' : 'friendlyTimeoutSeconds'
  const fallback = kind === 'inviteBet' || kind === 'inviteFriendly'
    ? Number(cfg.inviteTimeoutSeconds ?? 120) : kind === 'bet' ? 180 : 120
  const maximum = kind.startsWith('invite') ? 300 : 600
  return { key, maximum, current: Math.max(30, Math.min(maximum, Number(cfg[key] ?? fallback) || fallback)) }
}

export async function renderTimeoutPanel(chatId: string, cfg: any, kind: string) {
  const lang = langOf(cfg.language)
  const fa = lang === 'fa'
  const names: Record<string, [string, string]> = {
    inviteBet: ['مهلت پاسخ به دعوت شرطی', 'Bet invitation timeout'],
    inviteFriendly: ['مهلت پاسخ به دعوت دوستانه', 'Friendly invitation timeout'],
    bet: ['مهلت انتخاب در رقابت شرطی', 'Bet move timeout'],
    friendly: ['مهلت انتخاب در رقابت دوستانه', 'Friendly move timeout'],
  }
  const [faName, enName] = names[kind] ?? names.bet
  const { current, maximum } = timeoutConfig(cfg, kind)
  const shown = (value: number) => fa ? `${value} ثانیه` : `${value} seconds`
  const prefix = `gw:cfg:${chatId}:timeout:${kind}`
  const kb = colorizeInlineKeyboard(new InlineKeyboard()
    .text(fa ? '➖ ۱۰ ثانیه' : '➖ 10 seconds', `${prefix}:step:-10`)
    .text(fa ? '➕ ۱۰ ثانیه' : '➕ 10 seconds', `${prefix}:step:10`)
    .row()
    .text(fa ? '⬅️ بازگشت به پنل مدیریت' : '⬅️ Back to group settings', `${prefix}:back`))

  const text = tr(lang,
    `⏱ <b>تنظیم زمان</b>
${faName}

زمان فعلی: <b>${shown(current)}</b>

با دکمه‌های ۱۰ ثانیه‌ای زمان را کم یا زیاد کن. حد مجاز: ۳۰ تا ${maximum} ثانیه.`,
    `⏱ <b>Timeout settings</b>
${enName}

Current value: <b>${shown(current)}</b>

Use the 10-second buttons to decrease or increase the timeout. Allowed range: 30 to ${maximum} seconds.`,
  )
  return { text, reply_markup: { inline_keyboard: kb.inline_keyboard }, parse_mode: 'HTML' }
}

async function dashboardText(chatId: string, cfg: any): Promise<string> {
  const lang = langOf(cfg.language)
  const duelStats = await GroupDuel.aggregate([
    { $match: { chatId, status: 'settled' } },
    { $group: {
      _id: '$mode', total: { $sum: 1 },
      draws: { $sum: { $cond: [{ $in: ['$outcome', ['draw', 'draw_timeout']] }, 1, 0] } },
    } },
  ])
  const total = duelStats.reduce((n: number, x: any) => n + Number(x.total ?? 0), 0)
  const bets = Number(duelStats.find((x: any) => x._id === 'bet')?.total ?? 0)
  const friendly = Number(duelStats.find((x: any) => x._id === 'friendly')?.total ?? 0)
  const draws = duelStats.reduce((n: number, x: any) => n + Number(x.draws ?? 0), 0)
  const wager = await GroupDuel.aggregate([
    { $match: { chatId, mode: 'bet', status: 'settled' } },
    { $group: { _id: '$currency', amount: { $sum: { $multiply: ['$amount', 2] } } } },
  ])
  const betIrt = Number(wager.find((x: any) => x._id === 'IRT')?.amount ?? 0)
  const betTon = Number(wager.find((x: any) => x._id === 'TON')?.amount ?? 0)
  const finance = await GroupDuel.aggregate([
    { $match: { chatId, mode: 'bet', status: 'settled' } },
    { $group: { _id: '$currency', fees: { $sum: '$fee' }, rewards: { $sum: '$reward' } } },
  ])
  const feeIrt = Number(finance.find((x: any) => x._id === 'IRT')?.fees ?? 0)
  const feeTon = Number(finance.find((x: any) => x._id === 'TON')?.fees ?? 0)
  const rewardIrt = Number(finance.find((x: any) => x._id === 'IRT')?.rewards ?? 0)
  const rewardTon = Number(finance.find((x: any) => x._id === 'TON')?.rewards ?? 0)
  const betInvite = Number(cfg.betInviteTimeoutSeconds ?? cfg.inviteTimeoutSeconds ?? 120)
  const friendlyInvite = Number(cfg.friendlyInviteTimeoutSeconds ?? cfg.inviteTimeoutSeconds ?? 120)
  const betTime = Number(cfg.betTimeoutSeconds ?? 180)
  const friendlyTime = Number(cfg.friendlyTimeoutSeconds ?? 120)

  return tr(lang,
    `🎛 <b>پنل مدیریت گروه</b>\n📍 <b>گروه:</b> ${esc(cfg.title)}\n\n🌐 <b>زبان:</b> ${cfg.language === 'en' ? 'English' : 'فارسی'}\n🎮 <b>حالت‌های مجاز:</b> ${modeText(cfg, lang)}\n💱 <b>ارزهای مجاز:</b> ${currencyText(cfg, lang)}\n\n⏱ <b>مهلت پاسخ به دعوت شرطی:</b> ${betInvite} ثانیه\n⏱ <b>مهلت پاسخ به دعوت دوستانه:</b> ${friendlyInvite} ثانیه\n🎯 <b>مهلت انتخاب شرطی:</b> ${betTime} ثانیه\n🎯 <b>مهلت انتخاب دوستانه:</b> ${friendlyTime} ثانیه\n\n📊 <b>آمار همین گروه</b>\nکل رقابت‌های پایان‌یافته: <b>${total}</b>\nشرطی: <b>${bets}</b>  ·  دوستانه: <b>${friendly}</b>  ·  مساوی (با احتساب پایان مهلت): <b>${draws}</b>\n\n💰 <b>مجموع مبلغ شرط‌ها:</b> ${fmt(betIrt, 'IRT')} تومان  ·  ${fmt(betTon, 'TON')} TON\n🧾 <b>کارمزد ثبت‌شده:</b> ${fmt(feeIrt, 'IRT')} تومان  ·  ${fmt(feeTon, 'TON')} TON\n🎁 <b>پاداش فعال‌کننده:</b> ${fmt(rewardIrt, 'IRT')} تومان  ·  ${fmt(rewardTon, 'TON')} TON\n\nبرای تغییر هر گزینه، دکمهٔ مربوط به آن را بزن. تنظیمات و آمار فقط برای خودت در همین گروه نمایش داده می‌شود.`,
    `🎛 <b>Group management</b>\n📍 <b>Group:</b> ${esc(cfg.title)}\n\n🌐 <b>Language:</b> ${cfg.language === 'en' ? 'English' : 'Persian'}\n🎮 <b>Allowed modes:</b> ${modeText(cfg, lang)}\n💱 <b>Allowed currencies:</b> ${currencyText(cfg, lang)}\n\n⏱ <b>Bet invitation timeout:</b> ${betInvite}s\n⏱ <b>Friendly invitation timeout:</b> ${friendlyInvite}s\n🎯 <b>Bet move timeout:</b> ${betTime}s\n🎯 <b>Friendly move timeout:</b> ${friendlyTime}s\n\n📊 <b>This group’s statistics</b>\nCompleted duels: <b>${total}</b>\nBet: <b>${bets}</b>  ·  Friendly: <b>${friendly}</b>  ·  Draws (including timeout draws): <b>${draws}</b>\n\n💰 <b>Total stakes:</b> ${fmt(betIrt, 'IRT')} IRT  ·  ${fmt(betTon, 'TON')} TON\n🧾 <b>Fees:</b> ${fmt(feeIrt, 'IRT')} IRT  ·  ${fmt(feeTon, 'TON')} TON\n🎁 <b>Activator rewards:</b> ${fmt(rewardIrt, 'IRT')} IRT  ·  ${fmt(rewardTon, 'TON')} TON\n\nTap a button to change a setting. This dashboard and its statistics are visible only to you inside this group.`,
  )
}

export async function sendDashboard(chatId: string, actorId: number, cfg: any, replyToMessageId?: number) {
  if (actorId !== Number(cfg.activatorId)) throw new Error('ACTIVATOR_ONLY')
  const lang = langOf(cfg.language)
  const text = await dashboardText(chatId, cfg)
  try {
    await sendEphemeralMessage(Number(chatId), actorId, text, {
      parse_mode: 'HTML', reply_markup: { inline_keyboard: dashboardKeyboard(lang, chatId, cfg).inline_keyboard },
    }, { ...(replyToMessageId ? { replyMessageId: replyToMessageId } : {}) })
  } catch (error: any) {
    logError('ephemeral_dashboard_send_failed', error, { chatId, actorId, replyToMessageId })
    // Avoid a second known-to-fail call when Telegram returns 404 (usually an
    // invalid BOT_TOKEN or wrong Bot API endpoint). Never fall back to public
    // dashboard content; the fallback message is generic only.
    const errorCode = Number(error?.error_code ?? error?.errorCode ?? error?.parameters?.error_code)
    if (errorCode !== 404 && !/\(404:\s*Not Found\)/i.test(String(error?.message ?? ''))) {
      await bot.api.sendMessage(Number(chatId), tr(lang,
        '⚠️ پنل خصوصی داخل گروه ارسال نشد. دسترسی ادمین گروه را به ربات بده و مطمئن شو Bot API و برنامهٔ تلگرام از پیام‌های خصوصی داخل گروه پشتیبانی می‌کنند.',
        '⚠️ The private in-group dashboard could not be sent. Make the bot a group administrator and ensure the Telegram API/client supports ephemeral group messages.',
      ), { ...(replyToMessageId ? { reply_parameters: { message_id: replyToMessageId } } : {}) } as any).catch((fallbackError) => logError('dashboard_failure_notice_send_failed', fallbackError, { chatId, actorId }))
    }
    throw error
  }
}

export async function renderDashboard(chatId: string, cfg: any) {
  return { text: await dashboardText(chatId, cfg), reply_markup: { inline_keyboard: dashboardKeyboard(langOf(cfg.language), chatId, cfg).inline_keyboard }, parse_mode: 'HTML' }
}

export async function sendWelcome(chat: any, _actorId: number) {
  const kb = new InlineKeyboard().text('🇮🇷 فارسی', 'gw:lang:fa').text('🇬🇧 English', 'gw:lang:en')
  await bot.api.sendMessage(chat.id,
    '🤖 ربات در گروه فعال شد. فعال‌کننده، زبان گروه را انتخاب کند. برای راهنما «راهنما» و برای پنل «پنل» را بفرستید.\n\n🤖 Bot enabled. The activator should choose the group language. Send “help” for help and “panel” for settings.',
    { reply_markup: kb },
  )
}
