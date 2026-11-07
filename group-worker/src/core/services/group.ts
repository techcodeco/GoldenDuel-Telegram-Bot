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

export async function groupLang(chatId: string): Promise<'fa' | 'en' | 'ar' | 'es'> {
  const c = await GroupConfig.findOne({ chatId }).lean() as any
  return langOf(c?.language)
}

export async function sendHelp(chatId: number | string, lang: 'fa' | 'en' | 'ar' | 'es', receiverUserId: number, replyToMessageId?: number) {
  const texts = {
    fa: '⚔️ <b>راهنمای کامل دوئل گروهی</b>\n\n<b>۱) ارسال دعوت</b>\nروی پیام کاربر موردنظر ریپلای کن و یکی از واژه‌های «دوئل»، «فایت»، «رقابت»، «چالش»، «چلنج»، «duel»، «fight»، «challenge» یا «competition» را بفرست. هر دو بازیکن باید قبلاً ربات را در پیوی Start کرده باشند.\n\n<b>۲) تنظیم رقابت</b>\nفرم تنظیمات فقط برای دعوت‌کننده و به‌صورت خصوصی داخل گروه نمایش داده می‌شود. نوع «دوستانه» بدون پول و شرط است. نوع «شرطی» از تو ارز (تومان یا TON) و مبلغ هر بازیکن را می‌پرسد.\n\n<b>۳) تأیید حریف</b>\nدعوت به‌صورت خصوصی برای حریف فرستاده می‌شود. حریف می‌تواند دعوت را قبول یا رد کند؛ دعوت در صورت بی‌پاسخ ماندن پس از مهلت تعیین‌شده منقضی می‌شود. در دوئل شرطی، مبلغ هر دو نفر هنگام شروع بازی رزرو می‌شود.\n\n<b>۴) انتخاب سنگ، کاغذ یا قیچی</b>\nپس از پذیرش، هر بازیکن فرم اختصاصی خودش را می‌بیند و فقط یک بار می‌تواند انتخاب کند. ثبت انتخاب یک نفر، دکمه‌های همان نفر را می‌بندد و فرم حریف را فعال نگه می‌دارد.\n\n<b>۵) یادآوری و پایان</b>\nدر ۸۵٪ زمان، فقط به بازیکنانی که هنوز انتخاب نکرده‌اند یادآوری خصوصی همراه با ثانیه‌های باقی‌مانده ارسال می‌شود. با تکمیل انتخاب‌ها یا پایان مهلت، نتیجه در گروه منتشر می‌شود.\n\n<b>۶) تنظیمات</b>\nبرای مدیریت زبان، حالت‌ها، ارزها و مهلت‌ها، واژهٔ «پنل» را بفرست. فقط فعال‌کنندهٔ گروه می‌تواند پنل را مدیریت کند.',
    en: '⚔️ <b>Complete group duel guide</b>\n\n<b>1) Send a challenge</b>\nReply to a user’s message and send “duel”, “fight”, “challenge”, or “competition”, or one of the supported Persian trigger words. Both players must have started the bot in private first.\n\n<b>2) Configure the duel</b>\nOnly the challenger sees the setup form, privately inside the group. Friendly mode has no money or stake. Bet mode asks for a currency (Toman or TON) and the stake per player.\n\n<b>3) Opponent invitation</b>\nThe opponent receives a private invitation and can accept or reject it. An unanswered invitation expires after its configured deadline. In bet duels, both stakes are reserved when the duel starts.\n\n<b>4) Rock, paper, or scissors</b>\nAfter acceptance, each player receives a personal move form and can choose once. Once a move is registered, that player’s buttons are disabled while the opponent’s form remains active.\n\n<b>5) Reminder and result</b>\nAt 85% of the choice window, only players who have not chosen receive a private reminder showing the remaining seconds. When both moves are recorded or the deadline expires, the result is published in the group.\n\n<b>6) Settings</b>\nSend “panel” to manage language, allowed modes, currencies, and deadlines. Only the group activator can manage the panel.',
    ar: '⚔️ <b>الدليل الكامل للتحديات في المجموعة</b>\n\n<b>١) إرسال تحدٍّ</b>\nقم بالرد على رسالة المستخدم وأرسل إحدى الكلمات «duel» أو «fight» أو «challenge» أو «competition»، أو إحدى كلمات التحدي الفارسية المدعومة. يجب أن يكون اللاعبان قد بدآ الروبوت في المحادثة الخاصة أولاً.\n\n<b>٢) إعداد التحدي</b>\nيظهر نموذج الإعداد لصاحب الدعوة فقط وبشكل خاص داخل المجموعة. التحدي الودي بلا أموال أو رهانات. أما تحدي الرهان فيطلب العملة (تومان أو TON) وقيمة رهان كل لاعب.\n\n<b>٣) دعوة الخصم</b>\nيتلقى الخصم دعوة خاصة ويمكنه قبولها أو رفضها. تنتهي صلاحية الدعوة إذا لم يُجب عنها خلال المهلة المحددة. في تحديات الرهان يُحجز رهان كلا اللاعبين عند بدء المباراة.\n\n<b>٤) حجر وورقة ومقص</b>\nبعد القبول، يحصل كل لاعب على نموذج اختيار خاص به ويمكنه الاختيار مرة واحدة فقط. بعد تسجيل الاختيار تُعطّل أزرار ذلك اللاعب ويبقى نموذج الخصم فعالاً.\n\n<b>٥) التذكير والنتيجة</b>\nعند انقضاء ٨٥٪ من الوقت، يتلقى اللاعبون الذين لم يختاروا بعد تذكيراً خاصاً يتضمن عدد الثواني المتبقية فقط. عند اكتمال الاختيارين أو انتهاء المهلة، تُنشر النتيجة في المجموعة.\n\n<b>٦) الإعدادات</b>\nأرسل «panel» لإدارة اللغة والأنماط والعملات والمهل الزمنية. يمكن لمُفعّل المجموعة وحده إدارة اللوحة.',
    es: '⚔️ <b>Guía completa de duelos en grupo</b>\n\n<b>1) Enviar un desafío</b>\nResponde al mensaje de un usuario y envía «duel», «fight», «challenge» o «competition», o una de las palabras persas compatibles. Ambos jugadores deben haber iniciado el bot en privado.\n\n<b>2) Configurar el duelo</b>\nSolo quien invita ve el formulario de configuración, de forma privada dentro del grupo. El modo amistoso no utiliza dinero ni apuestas. El modo con apuesta solicita la moneda (Toman o TON) y la cantidad por jugador.\n\n<b>3) Invitación al rival</b>\nEl rival recibe una invitación privada que puede aceptar o rechazar. La invitación caduca si no responde dentro del plazo establecido. En los duelos con apuesta, se reservan las apuestas de ambos al comenzar la partida.\n\n<b>4) Piedra, papel o tijeras</b>\nTras aceptar, cada jugador recibe su propio formulario privado y puede elegir una sola vez. Al registrar una elección, se desactivan los botones de ese jugador y el formulario del rival sigue activo.\n\n<b>5) Aviso y resultado</b>\nAl transcurrir el 85 % del tiempo, solo los jugadores que aún no han elegido reciben un aviso privado con los segundos restantes. Cuando ambos eligen o vence el plazo, el resultado se publica en el grupo.\n\n<b>6) Ajustes</b>\nEnvía «panel» para administrar el idioma, los modos, las monedas y los plazos. Solo la persona que activó el grupo puede administrar el panel.',
  } as const
  const text = texts[lang]
  try {
    await sendEphemeralMessage(chatId, receiverUserId, text, { parse_mode: 'HTML' }, {
      ...(replyToMessageId ? { replyMessageId: replyToMessageId } : {}),
    })
  } finally {
    if (replyToMessageId) await bot.api.deleteMessage(chatId, replyToMessageId).catch(() => undefined)
  }
}

function modeText(cfg: any, lang: 'fa' | 'en' | 'ar' | 'es') {
  const modes = Array.isArray(cfg.allowedModes) ? cfg.allowedModes : MODES
  if (modes.includes('bet') && modes.includes('friendly')) return tr(lang, 'شرطی + دوستانه', 'Bet + Friendly', 'رهان + ودي', 'Apuesta + amistoso')
  if (modes.includes('bet')) return tr(lang, 'فقط شرطی', 'Bet only', 'رهان فقط', 'Solo apuesta')
  if (modes.includes('friendly')) return tr(lang, 'فقط دوستانه', 'Friendly only', 'ودي فقط', 'Solo amistoso')
  return tr(lang, 'هیچ‌کدام', 'Disabled', 'معطّل', 'Desactivado')
}

function currencyText(cfg: any, lang: 'fa' | 'en' | 'ar' | 'es') {
  const currencies = Array.isArray(cfg.allowedCurrencies) ? cfg.allowedCurrencies : CURRENCIES
  if (currencies.includes('IRT') && currencies.includes('TON')) return tr(lang, 'تومان + TON', 'Toman + TON', 'تومان + TON', 'Toman + TON')
  if (currencies.includes('IRT')) return tr(lang, 'فقط تومان', 'Toman only', 'تومان فقط', 'Solo Toman')
  if (currencies.includes('TON')) return tr(lang, 'فقط TON', 'TON only', 'TON فقط', 'Solo TON')
  return tr(lang, 'بدون ارز', 'No currency', 'لا توجد عملة', 'Sin moneda')
}

export function dashboardKeyboard(lang: 'fa' | 'en' | 'ar' | 'es', chatId: string, cfg: any = {}) {
  const p = `gw:cfg:${chatId}:`
  const modes = Array.isArray(cfg.allowedModes) ? cfg.allowedModes : ['bet', 'friendly']
  const currencies = Array.isArray(cfg.allowedCurrencies) ? cfg.allowedCurrencies : ['IRT', 'TON']
  const isBothModes = modes.includes('bet') && modes.includes('friendly')
  const isBothCurrencies = currencies.includes('IRT') && currencies.includes('TON')
  const betInvite = Number(cfg.betInviteTimeoutSeconds ?? cfg.inviteTimeoutSeconds ?? 120)
  const friendlyInvite = Number(cfg.friendlyInviteTimeoutSeconds ?? cfg.inviteTimeoutSeconds ?? 120)
  const betGame = Number(cfg.betTimeoutSeconds ?? 180)
  const friendlyGame = Number(cfg.friendlyTimeoutSeconds ?? 120)
  const labels = {
    fa: { friendly:'فقط دوستانه', bet:'فقط شرطی', both:'هر دو حالت', toman:'فقط تومان', ton:'فقط تون (گرام)', currencies:'هر دو ارز', betInvite:'دعوت شرطی', friendlyInvite:'دعوت دوستانه', betMove:'انتخاب شرطی', friendlyMove:'انتخاب دوستانه', sec:'ثانیه' },
    en: { friendly:'Friendly only', bet:'Bet only', both:'Both modes', toman:'Toman only', ton:'TON (Gram) only', currencies:'Both currencies', betInvite:'Bet invite', friendlyInvite:'Friendly invite', betMove:'Bet move', friendlyMove:'Friendly move', sec:'seconds' },
    ar: { friendly:'ودي فقط', bet:'رهان فقط', both:'كلا النمطين', toman:'تومان فقط', ton:'تون (گرام) فقط', currencies:'كلتا العملتين', betInvite:'دعوة الرهان', friendlyInvite:'الدعوة الودية', betMove:'اختيار الرهان', friendlyMove:'الاختيار الودي', sec:'ثانية' },
    es: { friendly:'Solo amistoso', bet:'Solo apuesta', both:'Ambos modos', toman:'Solo Toman', ton:'Solo TON (Gram)', currencies:'Ambas monedas', betInvite:'Invitación con apuesta', friendlyInvite:'Invitación amistosa', betMove:'Elección con apuesta', friendlyMove:'Elección amistosa', sec:'segundos' },
  }[lang]
  const mark = (active: boolean) => active ? '✅ ' : '▫️ '
  const seconds = (value: number) => `${value} ${labels.sec}`
  return colorizeInlineKeyboard(new InlineKeyboard()
    .text(`${cfg.language === 'fa' ? '✅' : '▫️'} 🇮🇷 فارسی`, `${p}lang:fa`)
    .text(`${cfg.language === 'en' ? '✅' : '▫️'} 🇬🇧 English`, `${p}lang:en`)
    .row().text(`${cfg.language === 'ar' ? '✅' : '▫️'} 🇸🇦 العربية`, `${p}lang:ar`)
    .text(`${cfg.language === 'es' ? '✅' : '▫️'} 🇪🇸 Español`, `${p}lang:es`)
    .row()
    .text(`${mark(modes.length === 1 && modes[0] === 'friendly')}${labels.friendly}`, `${p}mode:friendly`)
    .text(`${mark(modes.length === 1 && modes[0] === 'bet')}${labels.bet}`, `${p}mode:bet`)
    .row()
    .text(`${mark(isBothModes)}${labels.both}`, `${p}mode:both`)
    .row()
    .text(`${mark(currencies.length === 1 && currencies[0] === 'IRT')}${labels.toman}`, `${p}cur:IRT`)
    .text(`${mark(currencies.length === 1 && currencies[0] === 'TON')}${labels.ton}`, `${p}cur:TON`)
    .row()
    .text(`${mark(isBothCurrencies)}${labels.currencies}`, `${p}cur:both`)
    .row()
    .text(`⏱ ${labels.betInvite} · ${seconds(betInvite)} ⚙️`, `${p}timeout:inviteBet:panel`)
    .row()
    .text(`⏱ ${labels.friendlyInvite} · ${seconds(friendlyInvite)} ⚙️`, `${p}timeout:inviteFriendly:panel`)
    .row()
    .text(`🎯 ${labels.betMove} · ${seconds(betGame)} ⚙️`, `${p}timeout:bet:panel`)
    .row()
    .text(`🎯 ${labels.friendlyMove} · ${seconds(friendlyGame)} ⚙️`, `${p}timeout:friendly:panel`))
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
  const names = {
    fa: { inviteBet:'مهلت پاسخ به دعوت شرطی', inviteFriendly:'مهلت پاسخ به دعوت دوستانه', bet:'مهلت انتخاب در رقابت شرطی', friendly:'مهلت انتخاب در رقابت دوستانه', title:'تنظیم زمان', current:'زمان فعلی', description:'با دکمه‌های ۱۰ ثانیه‌ای زمان را کم یا زیاد کن. حد مجاز: ۳۰ تا', unit:'ثانیه', minus:'➖ ۱۰ ثانیه', plus:'➕ ۱۰ ثانیه', back:'⬅️ بازگشت به پنل مدیریت' },
    en: { inviteBet:'Bet invitation timeout', inviteFriendly:'Friendly invitation timeout', bet:'Bet move timeout', friendly:'Friendly move timeout', title:'Timeout settings', current:'Current value', description:'Use the 10-second buttons to adjust the timeout. Allowed range: 30 to', unit:'seconds', minus:'➖ 10 seconds', plus:'➕ 10 seconds', back:'⬅️ Back to group settings' },
    ar: { inviteBet:'مهلة دعوة الرهان', inviteFriendly:'مهلة الدعوة الودية', bet:'مهلة اختيار الرهان', friendly:'مهلة الاختيار الودي', title:'إعدادات المهلة', current:'القيمة الحالية', description:'استخدم أزرار العشر ثوانٍ لتعديل المهلة. النطاق المسموح: من ٣٠ إلى', unit:'ثانية', minus:'➖ ١٠ ثوانٍ', plus:'➕ ١٠ ثوانٍ', back:'⬅️ العودة إلى إعدادات المجموعة' },
    es: { inviteBet:'Plazo de invitación con apuesta', inviteFriendly:'Plazo de invitación amistosa', bet:'Plazo de elección con apuesta', friendly:'Plazo de elección amistosa', title:'Ajustes de tiempo', current:'Valor actual', description:'Usa los botones de 10 segundos para ajustar el plazo. Rango permitido: de 30 a', unit:'segundos', minus:'➖ 10 segundos', plus:'➕ 10 segundos', back:'⬅️ Volver a los ajustes del grupo' },
  }[lang]
  const name:any = names[kind as keyof typeof names] ?? names.bet
  const { current, maximum } = timeoutConfig(cfg, kind)
  const shown = (value: number) => `${value} ${name.unit}`
  const prefix = `gw:cfg:${chatId}:timeout:${kind}`
  const kb = colorizeInlineKeyboard(new InlineKeyboard()
    .text(name.minus, `${prefix}:step:-10`)
    .text(name.plus, `${prefix}:step:10`)
    .row()
    .text(name.back, `${prefix}:back`))
  const text = `⏱ <b>${name.title}</b>\n${name[kind as keyof typeof name] ?? name.bet}\n\n${name.current}: <b>${shown(current)}</b>\n\n${name.description} ${maximum} ${name.unit}.`
  return { text, reply_markup: { inline_keyboard: kb.inline_keyboard }, parse_mode: 'HTML' }
}

async function dashboardText(chatId: string, cfg: any): Promise<string> {
  const lang = langOf(cfg.language)
  const duelStats = await GroupDuel.aggregate([
    { $match: { chatId, status: 'settled' } },
    { $group: { _id: '$mode', total: { $sum: 1 }, draws: { $sum: { $cond: [{ $in: ['$outcome', ['draw', 'draw_timeout']] }, 1, 0] } } } },
  ])
  const total = duelStats.reduce((n: number, x: any) => n + Number(x.total ?? 0), 0)
  const bets = Number(duelStats.find((x: any) => x._id === 'bet')?.total ?? 0)
  const friendly = Number(duelStats.find((x: any) => x._id === 'friendly')?.total ?? 0)
  const draws = duelStats.reduce((n: number, x: any) => n + Number(x.draws ?? 0), 0)
  const wager = await GroupDuel.aggregate([{ $match: { chatId, mode: 'bet', status: 'settled' } }, { $group: { _id: '$currency', amount: { $sum: { $multiply: ['$amount', 2] } } } }])
  const betIrt = Number(wager.find((x: any) => x._id === 'IRT')?.amount ?? 0)
  const betTon = Number(wager.find((x: any) => x._id === 'TON')?.amount ?? 0)
  const finance = await GroupDuel.aggregate([{ $match: { chatId, mode: 'bet', status: 'settled' } }, { $group: { _id: '$currency', fees: { $sum: '$fee' }, rewards: { $sum: '$reward' } } }])
  const feeIrt = Number(finance.find((x: any) => x._id === 'IRT')?.fees ?? 0)
  const feeTon = Number(finance.find((x: any) => x._id === 'TON')?.fees ?? 0)
  const rewardIrt = Number(finance.find((x: any) => x._id === 'IRT')?.rewards ?? 0)
  const rewardTon = Number(finance.find((x: any) => x._id === 'TON')?.rewards ?? 0)
  const betInvite = Number(cfg.betInviteTimeoutSeconds ?? cfg.inviteTimeoutSeconds ?? 120)
  const friendlyInvite = Number(cfg.friendlyInviteTimeoutSeconds ?? cfg.inviteTimeoutSeconds ?? 120)
  const betTime = Number(cfg.betTimeoutSeconds ?? 180)
  const friendlyTime = Number(cfg.friendlyTimeoutSeconds ?? 120)
  const values = {
    fa: `🎛 <b>پنل مدیریت گروه</b>\n📍 <b>گروه:</b> ${esc(cfg.title)}\n\n🌐 <b>زبان:</b> ${cfg.language === 'en' ? 'English' : cfg.language === 'ar' ? 'العربية' : cfg.language === 'es' ? 'Español' : 'فارسی'}\n🎮 <b>حالت‌های مجاز:</b> ${modeText(cfg, lang)}\n💱 <b>ارزهای مجاز:</b> ${currencyText(cfg, lang)}\n\n⏱ <b>مهلت پاسخ به دعوت شرطی:</b> ${betInvite} ثانیه\n⏱ <b>مهلت پاسخ به دعوت دوستانه:</b> ${friendlyInvite} ثانیه\n🎯 <b>مهلت انتخاب شرطی:</b> ${betTime} ثانیه\n🎯 <b>مهلت انتخاب دوستانه:</b> ${friendlyTime} ثانیه\n\n📊 <b>آمار همین گروه</b>\nکل رقابت‌های پایان‌یافته: <b>${total}</b>\nشرطی: <b>${bets}</b> · دوستانه: <b>${friendly}</b> · مساوی: <b>${draws}</b>\n\n💰 <b>مجموع مبلغ شرط‌ها:</b> ${fmt(betIrt, 'IRT')} تومان · ${fmt(betTon, 'TON')} TON\n🧾 <b>کارمزد ثبت‌شده:</b> ${fmt(feeIrt, 'IRT')} تومان · ${fmt(feeTon, 'TON')} TON\n🎁 <b>پاداش فعال‌کننده:</b> ${fmt(rewardIrt, 'IRT')} تومان · ${fmt(rewardTon, 'TON')} TON\n\nبرای تغییر هر گزینه، دکمهٔ مربوط را بزن. این پنل و آمار فقط برای تو نمایش داده می‌شود.`,
    en: `🎛 <b>Group management</b>\n📍 <b>Group:</b> ${esc(cfg.title)}\n\n🌐 <b>Language:</b> ${cfg.language === 'fa' ? 'Persian' : cfg.language === 'ar' ? 'Arabic' : cfg.language === 'es' ? 'Spanish' : 'English'}\n🎮 <b>Allowed modes:</b> ${modeText(cfg, lang)}\n💱 <b>Allowed currencies:</b> ${currencyText(cfg, lang)}\n\n⏱ <b>Bet invitation timeout:</b> ${betInvite}s\n⏱ <b>Friendly invitation timeout:</b> ${friendlyInvite}s\n🎯 <b>Bet move timeout:</b> ${betTime}s\n🎯 <b>Friendly move timeout:</b> ${friendlyTime}s\n\n📊 <b>This group’s statistics</b>\nCompleted duels: <b>${total}</b>\nBet: <b>${bets}</b> · Friendly: <b>${friendly}</b> · Draws: <b>${draws}</b>\n\n💰 <b>Total stakes:</b> ${fmt(betIrt, 'IRT')} Toman · ${fmt(betTon, 'TON')} TON\n🧾 <b>Fees:</b> ${fmt(feeIrt, 'IRT')} Toman · ${fmt(feeTon, 'TON')} TON\n🎁 <b>Activator rewards:</b> ${fmt(rewardIrt, 'IRT')} Toman · ${fmt(rewardTon, 'TON')} TON\n\nTap a button to change a setting. This panel and its statistics are visible only to you.`,
    ar: `🎛 <b>إدارة المجموعة</b>\n📍 <b>المجموعة:</b> ${esc(cfg.title)}\n\n🌐 <b>اللغة:</b> ${cfg.language === 'fa' ? 'الفارسية' : cfg.language === 'en' ? 'الإنجليزية' : cfg.language === 'es' ? 'الإسبانية' : 'العربية'}\n🎮 <b>الأنماط المسموح بها:</b> ${modeText(cfg, lang)}\n💱 <b>العملات المسموح بها:</b> ${currencyText(cfg, lang)}\n\n⏱ <b>مهلة دعوة الرهان:</b> ${betInvite} ثانية\n⏱ <b>مهلة الدعوة الودية:</b> ${friendlyInvite} ثانية\n🎯 <b>مهلة اختيار الرهان:</b> ${betTime} ثانية\n🎯 <b>مهلة الاختيار الودي:</b> ${friendlyTime} ثانية\n\n📊 <b>إحصاءات المجموعة</b>\nالتحديات المكتملة: <b>${total}</b>\nرهان: <b>${bets}</b> · ودي: <b>${friendly}</b> · تعادل: <b>${draws}</b>\n\n💰 <b>إجمالي الرهانات:</b> ${fmt(betIrt, 'IRT')} تومان · ${fmt(betTon, 'TON')} TON\n🧾 <b>الرسوم:</b> ${fmt(feeIrt, 'IRT')} تومان · ${fmt(feeTon, 'TON')} TON\n🎁 <b>مكافآت مُفعّل المجموعة:</b> ${fmt(rewardIrt, 'IRT')} تومان · ${fmt(rewardTon, 'TON')} TON\n\nاضغط الزر المناسب لتغيير الإعداد. هذه اللوحة والإحصاءات ظاهرة لك وحدك.`,
    es: `🎛 <b>Administración del grupo</b>\n📍 <b>Grupo:</b> ${esc(cfg.title)}\n\n🌐 <b>Idioma:</b> ${cfg.language === 'fa' ? 'Persa' : cfg.language === 'en' ? 'Inglés' : cfg.language === 'ar' ? 'Árabe' : 'Español'}\n🎮 <b>Modos permitidos:</b> ${modeText(cfg, lang)}\n💱 <b>Monedas permitidas:</b> ${currencyText(cfg, lang)}\n\n⏱ <b>Plazo de invitación con apuesta:</b> ${betInvite} s\n⏱ <b>Plazo de invitación amistosa:</b> ${friendlyInvite} s\n🎯 <b>Plazo de elección con apuesta:</b> ${betTime} s\n🎯 <b>Plazo de elección amistosa:</b> ${friendlyTime} s\n\n📊 <b>Estadísticas del grupo</b>\nDuelos completados: <b>${total}</b>\nCon apuesta: <b>${bets}</b> · Amistosos: <b>${friendly}</b> · Empates: <b>${draws}</b>\n\n💰 <b>Apuestas totales:</b> ${fmt(betIrt, 'IRT')} Toman · ${fmt(betTon, 'TON')} TON\n🧾 <b>Comisiones:</b> ${fmt(feeIrt, 'IRT')} Toman · ${fmt(feeTon, 'TON')} TON\n🎁 <b>Recompensas del activador:</b> ${fmt(rewardIrt, 'IRT')} Toman · ${fmt(rewardTon, 'TON')} TON\n\nPulsa un botón para cambiar un ajuste. Este panel y sus estadísticas solo son visibles para ti.`,
  }
  return values[lang]
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
    // Fail closed: never replace a private dashboard with a public message.
    throw error
  }
}

export async function renderDashboard(chatId: string, cfg: any) {
  return { text: await dashboardText(chatId, cfg), reply_markup: { inline_keyboard: dashboardKeyboard(langOf(cfg.language), chatId, cfg).inline_keyboard }, parse_mode: 'HTML' }
}

export async function sendWelcome(chat: any, _actorId: number) {
  const kb = new InlineKeyboard().text('🇮🇷 فارسی', 'gw:lang:fa').text('🇬🇧 English', 'gw:lang:en').row().text('🇸🇦 العربية', 'gw:lang:ar').text('🇪🇸 Español', 'gw:lang:es')
  await bot.api.sendMessage(chat.id,
    '🤖 ربات در گروه فعال شد؛ فعال‌کننده زبان را انتخاب کند.\n🤖 The bot is active; the group activator should choose a language.\n🤖 تم تفعيل الروبوت؛ على مُفعّل المجموعة اختيار اللغة.\n🤖 El bot está activo; quien activó el grupo debe elegir el idioma.',
    { reply_markup: kb },
  )
}
