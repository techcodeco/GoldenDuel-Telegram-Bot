import { InlineKeyboard, Keyboard } from 'grammy'
import { t, type Lang } from '../i18n'
import { CURRENCIES, type Currency, formatAmount } from '../money'
import type { Settings } from '../services/settings'

export const curName = (lang: Lang, c: Currency) => t(lang, c === 'IRT' ? 'cur.IRT' : 'cur.TON')

/** Bot API 9.4 supports native styles for both reply-keyboard and inline buttons. */
type ButtonStyle = 'primary' | 'success' | 'danger'
type StyledButton = { text: string; style?: ButtonStyle }
const styled = (text: string, style?: ButtonStyle): StyledButton => ({ text, ...(style ? { style } : {}) })
const plain = (text: string): StyledButton => ({ text })
const replyKeyboard = (keyboard: StyledButton[][]) => ({
  // These two main-menu buttons are deliberately unstyled. Strip any accidental style
  // attribute even if a caller passes a styled button object for either translation.
  keyboard: keyboard.map((row) => row.map((button) => {
    if (/friendly duel|duel history|دوئل دوستانه|سابقه\s*دوئل/i.test(button.text)) {
      const { style: _ignoredStyle, ...plainButton } = button
      return plainButton
    }
    return button
  })),
  resize_keyboard: true,
  is_persistent: true,
}) as any

/** Attach Bot API button styles without relying on InlineKeyboard.toJSON(). */
const styleInline = <T extends { inline_keyboard?: any[][] }>(keyboard: T): T => {
  for (const row of keyboard.inline_keyboard ?? []) {
    for (const button of row) {
      const key = `${button.callback_data ?? ''} ${button.text ?? ''}`.toLowerCase()
      if (/friendly|دوستانه|duel.?history|profile:duels|سابقه.{0,12}دوئل|دوئل.{0,12}سابقه|آمار.{0,12}دوئل/.test(key)) {
        delete button.style
        continue
      }
      button.style = /cancel|reject|:no(?:$|:)|withdraw|delete|remove|bc:cancel|dq:x:|لغو|برداشت/.test(key) ? 'danger'
        : /deposit|:yes|confirm|approve|bc:confirm|save|:amt:|admin:backups|admin:broadcast|backup management|مدیریت بکاپ|مدیریت ربات/.test(key) ? 'success'
          : 'primary'
    }
  }
  return keyboard
}

/** Main menu: friendly duel and duel history intentionally use plain buttons with no style property. */
export const mainKeyboard = (lang: Lang, isAdmin = false) => {
  const keyboard: StyledButton[][] = [
    [styled(t(lang, 'btn.duel'), 'primary')],
    [styled(t(lang, 'btn.balance')), plain(t(lang, 'btn.friendly'))],
    [styled(t(lang, 'btn.profile'))],
    [styled(t(lang, 'btn.withdraw'), 'danger'), styled(t(lang, 'btn.deposit'), 'success')],
    [styled(t(lang, 'btn.finance_history')), plain(t(lang, 'btn.duel_history'))],
    [styled(t(lang, 'btn.support')), styled(t(lang, 'btn.referral'))],
  ]
  if (isAdmin) keyboard.push([styled(t(lang, 'btn.admin'), 'success')])
  return replyKeyboard(keyboard)
}

export const financeKeyboard = (lang: Lang) => replyKeyboard([
  [styled(t(lang, 'btn.balance')), styled(t(lang, 'btn.withdraw'), 'danger')],
  [styled(t(lang, 'btn.deposit'), 'success'), styled(t(lang, 'btn.referral'))],
  [styled(t(lang, 'btn.back'))],
])

/** Initial language picker is a reply keyboard, not an inline keyboard. */
export const languageKeyboard = () =>
  new Keyboard().text(t('en', 'lang.fa')).text(t('en', 'lang.en')).resized().oneTime()

/** Inline version is used only from the Profile screen. */
export const inlineLanguageKeyboard = () =>
  styleInline(new InlineKeyboard().text(t('en', 'lang.fa'), 'lang:fa').text(t('en', 'lang.en'), 'lang:en'))

export const currencyKeyboard = (lang: Lang, prefix: string) => {
  const kb = new InlineKeyboard()
  for (const c of CURRENCIES) kb.text(curName(lang, c), `${prefix}:${c}`)
  return styleInline(kb)
}

/** Inline shortcuts shown directly below the Assets message. */
export const balanceActionsKeyboard = (lang: Lang) => ({
  inline_keyboard: [[
    { text: t(lang, 'btn.deposit'), callback_data: 'balance:deposit', style: 'success' },
    { text: t(lang, 'btn.withdraw'), callback_data: 'balance:withdraw', style: 'danger' },
  ]],
}) as any

/** Legacy export kept for old callbacks, but the main duel flow no longer asks for a mode. */
export const duelModeKeyboard = (lang: Lang) => ({
  inline_keyboard: [
    [{ text: t(lang, 'duel.mode_bet'), callback_data: 'dm:bet', style: 'primary' }],
    [{ text: t(lang, 'duel.mode_friendly'), callback_data: 'dm:friendly' }],
  ],
}) as any

export const amountKeyboard = (lang: Lang, cur: Currency, amounts: number[], waitingAmounts: ReadonlySet<number> = new Set()) => {
  const kb = new InlineKeyboard()
  amounts.forEach((a, i) => {
    const waitingMark = waitingAmounts.has(a) ? ' (⌛)' : ''
    kb.text(`${formatAmount(a, cur)} ${curName(lang, cur)}${waitingMark}`, `dq:a:${cur}:${a}`)
    if (i % 2 === 1) kb.row()
  })
  return styleInline(kb)
}

export const moveKeyboard = (lang: Lang, matchId: string) =>
  styleInline(new InlineKeyboard()
    .text(t(lang, 'btn.rock'), `m:${matchId}:r`)
    .text(t(lang, 'btn.paper'), `m:${matchId}:p`)
    .text(t(lang, 'btn.scissors'), `m:${matchId}:s`))

export const cancelKeyboard = (lang: Lang, ticketId: string) =>
  styleInline(new InlineKeyboard().text(t(lang, 'btn.cancel_search'), `dq:x:${ticketId}`))


export const withdrawalBankConfirmKeyboard = (lang: Lang) => ({
  inline_keyboard: [[
    { text: lang === 'fa' ? '✅ تأیید و ساخت فاکتور' : '✅ Confirm & create invoice', callback_data: 'wdc:yes', style: 'success' },
    { text: lang === 'fa' ? '❌ لغو' : '❌ Cancel', callback_data: 'wdc:no', style: 'danger' },
  ]],
}) as any

export const withdrawalTonConfirmKeyboard = (lang: Lang) => ({
  inline_keyboard: [
    [{ text: lang === 'fa' ? '✅ تأیید و ساخت فاکتور' : '✅ Confirm & create invoice', callback_data: 'wdt:yes', style: 'success' }],
    [{ text: lang === 'fa' ? '❌ لغو برداشت' : '❌ Cancel withdrawal', callback_data: 'wdt:no', style: 'danger' }],
  ],
}) as any

export const broadcastAudienceKeyboard = (lang: Lang) =>
  styleInline(new InlineKeyboard()
    .text(lang === 'fa' ? '👤 کاربران' : '👤 Users', 'bc:aud:users')
    .text(lang === 'fa' ? '👥 گروه‌ها' : '👥 Groups', 'bc:aud:groups')
    .row()
    .text(lang === 'fa' ? '👤 + 👥 کاربران و گروه‌ها' : '👤 + 👥 Users and groups', 'bc:aud:both'))

export const broadcastUserFilterKeyboard = (lang: Lang) =>
  styleInline(new InlineKeyboard()
    .text(lang === 'fa' ? 'همه کاربران واجد شرایط' : 'All eligible users', 'bc:uf:all')
    .text(lang === 'fa' ? 'فقط N کاربر اول' : 'First N users', 'bc:uf:limit')
    .row()
    .text(lang === 'fa' ? 'فیلتر موجودی TON/گرام یا تومان' : 'Filter current TON/IRT balance', 'bc:uf:balance')
    .row()
    .text(lang === 'fa' ? 'فیلتر تعداد زیرمجموعه' : 'Filter referral count', 'bc:uf:referrals')
    .row()
    .text(lang === 'fa' ? 'فیلتر جمع واریزها' : 'Filter total deposits', 'bc:uf:deposits')
    .text(lang === 'fa' ? 'فیلتر جمع برداشت‌ها' : 'Filter total withdrawals', 'bc:uf:withdrawals')
    .row()
    .text(lang === 'fa' ? '⬅️ لغو' : '⬅️ Cancel', 'bc:cancel'))

export const broadcastConfirmKeyboard = (lang: Lang) =>
  styleInline(new InlineKeyboard()
    .text(lang === 'fa' ? '🚀 تأیید و شروع ارسال' : '🚀 Confirm and start', 'bc:confirm')
    .row()
    .text(lang === 'fa' ? '❌ لغو کمپین' : '❌ Cancel campaign', 'bc:cancel'))

export const profileKeyboard = (lang: Lang, section: 'home' | 'duels' | 'finance' = 'home', txPage = 0, txPages = 1) => {
  const kb = new InlineKeyboard()
  if (section !== 'duels') kb.text(t(lang, 'profile.btn_duels'), 'profile:duels')
  if (section !== 'finance') kb.text(t(lang, 'profile.btn_finance'), 'profile:finance')
  if (section === 'home') kb.row().text(t(lang, 'profile.btn_language'), 'profile:language')
  else kb.row().text(t(lang, 'profile.btn_home'), 'profile:home').text(t(lang, 'profile.btn_language'), 'profile:language')
  if ((section === 'home' || section === 'finance') && txPages > 1) {
    kb.row()
    if (txPage > 0) kb.text(lang === 'fa' ? '⬅️ قبلی' : '⬅️ Previous', `profile:tx:${txPage - 1}`)
    kb.text(lang === 'fa' ? `📜 صفحه ${txPage + 1}/${txPages}` : `📜 Page ${txPage + 1}/${txPages}`, `profile:tx:${txPage}`)
    if (txPage + 1 < txPages) kb.text(lang === 'fa' ? 'بعدی ➡️' : 'Next ➡️', `profile:tx:${txPage + 1}`)
  }
  return styleInline(kb)
}

export const adminMenuKeyboard = (lang: Lang, showOwnerInvoices = false) => {
  const kb = new InlineKeyboard()
    .text(t(lang, 'admin.btn_stats'), 'admin:stats')
    .text(t(lang, 'admin.btn_settings'), 'admin:settings')
    .row()
    .text(t(lang, 'admin.btn_invoices'), 'admin:invoices')
  if (showOwnerInvoices) kb.row().text(t(lang, 'admin.btn_withdrawals'), 'admin:withdrawals')
  if (showOwnerInvoices) kb.row().text(lang === 'fa' ? '📣 پیام انبوه' : '📣 Broadcast', 'admin:broadcast')
  if (showOwnerInvoices) kb.row().text(lang === 'fa' ? '🛰 مدیریت وضعیت سرورها' : '🛰 Server Status', 'admin:servers')
  if (showOwnerInvoices) kb.row().text(lang === 'fa' ? '🗄 مدیریت بکاپ‌ها' : '🗄 Backup management', 'admin:backups')
  kb.row()
    .text(t(lang, 'admin.btn_channels'), 'admin:channels')
    .text(t(lang, 'admin.btn_commands'), 'admin:commands')
    .row()
    .text(t(lang, 'admin.btn_profile'), 'admin:homeUser')
  return styleInline(kb)
}

const amount = (n: number, c: Currency) => `${formatAmount(n, c)} ${curName('fa', c)}`
const sec = (n: number) => `${n} ثانیه`
const onOff = (v: boolean) => v ? '✅ روشن' : '⛔ خاموش'

export const adminSettingsKeyboard = (s: Settings) =>
  styleInline(new InlineKeyboard()
    .text(`دوئل‌ها: ${onOff(s.features.duelsEnabled)}`, 'at:duels')
    .text(`شارژ حساب: ${onOff(s.features.depositsEnabled)}`, 'at:deposits')
    .row()
    .text(`برداشت: ${onOff(s.features.withdrawalsEnabled)}`, 'at:withdrawals')
    .text(`چت حریفان: ${onOff(s.features.chatEnabled)}`, 'at:chat')
    .row()
    .text(`عضویت اجباری: ${onOff(s.membership.enabled)}`, 'at:membership')
    .text('📢 مدیریت کانال‌ها', 'admin:channels')
    .row()
    .text(`شرطی | زمان انتخاب: ${sec(s.match.seconds)}`, 'as:bms')
    .row()
    .text(`دوستانه | زمان انتخاب: ${sec(s.match.friendlySeconds)}`, 'as:fms')
    .row()
    .text(`شرطی | زمان صف: ${sec(s.queue.seconds)}`, 'as:bqs')
    .row()
    .text(`دوستانه | زمان صف: ${sec(s.queue.friendlySeconds)}`, 'as:fqs')
    .row()
    .text(`شرطی | سقف چت: ${s.chat.maxMessages}`, 'as:bcl')
    .row()
    .text(`دوستانه | سقف چت: ${s.chat.friendlyMaxMessages}`, 'as:fcl')
    .row()
    .text(`جریمه کلمات ممنوع تومان: ${amount(s.chat.profanityPenalty.IRT, 'IRT')}`, 'as:cpi')
    .row()
    .text(`جریمه کلمات ممنوع TON: ${amount(s.chat.profanityPenalty.TON, 'TON')}`, 'as:cpt')
    .row()
    .text(`حداقل دوئل برداشت: ${s.limits.minDuelsForWithdraw}`, 'as:md')
    .text(`حداقل زیرمجموعه برداشت: ${s.limits.minReferralsForWithdraw}`, 'as:mr')
    .row()
    .text(`بونوس ثبت‌نام تومان: ${amount(s.registrationBonus.IRT, 'IRT')}`, 'as:rbi')
    .text(`بونوس ثبت‌نام TON (گرام): ${amount(s.registrationBonus.TON, 'TON')}`, 'as:rbt')
    .row()
    .text(`پاداش دعوت تومان: ${amount(s.referral.reward.IRT, 'IRT')}`, 'as:ri')
    .text(`پاداش دعوت TON (گرام): ${amount(s.referral.reward.TON, 'TON')}`, 'as:rt')
    .row()
    .text(`سقف پاداش دعوت: ${s.referral.maxPaidReferrals}`, 'as:rm')
    .row()
    .text(`حداقل واریز تومان: ${amount(s.limits.minDeposit.IRT, 'IRT')}`, 'as:di')
    .text(`حداقل برداشت تومان: ${amount(s.limits.minWithdraw.IRT, 'IRT')}`, 'as:wi')
    .row()
    .text(`حداقل واریز TON (گرام): ${amount(s.limits.minDeposit.TON, 'TON')}`, 'as:dt')
    .text(`حداقل برداشت TON (گرام): ${amount(s.limits.minWithdraw.TON, 'TON')}`, 'as:wt')
    .row()
    .text(`کارمزد برداشت تومان: ${amount(s.withdrawalFees.IRT, 'IRT')}`, 'as:wfi')
    .row()
    .text(`کارمزد شبکه TON: ${amount(s.withdrawalFees.TON, 'TON')}`, 'as:wft')
    .row()
    .text(`شماره کارت: ${s.manualDeposit.cardNumber ? 'تنظیم شده ✅' : 'تنظیم نشده ⚠️'}`, 'as:card')
    .text(`صاحب کارت: ${s.manualDeposit.cardHolder ? 'تنظیم شده ✅' : 'تنظیم نشده ⚠️'}`, 'as:holder')
    .row()
    .text(`پشتیبانی: ${s.manualDeposit.supportUsername ? '@' + s.manualDeposit.supportUsername : 'تنظیم نشده ⚠️'}`, 'as:support')
    .row()
    .text(`آدرس دریافت TON: ${s.manualDeposit.tonAddress ? 'تنظیم شده ✅' : 'تنظیم نشده ⚠️'}`, 'as:tonaddr')
    .row()
    .text(`سهم فعال‌کننده گروه از کارمزد: ${Number(s.groupRewardPercent ?? 20)}%`, 'as:grp')
    .row()
    .text('مبالغ شرط تومان', 'as:bi')
    .text('مبالغ شرط TON (گرام)', 'as:bt')
    .row()
    .text(`کارمزد برد ${s.fees.win / 100}%`, 'as:fw')
    .text(`کارمزد مساوی ${s.fees.draw / 100}%`, 'as:fd')
    .row()
    .text(`کارمزد برد با تایم‌اوت ${s.fees.winTimeout / 100}%`, 'as:ftw')
    .text(`کارمزد عدم انتخاب هر دو ${s.fees.drawTimeout / 100}%`, 'as:fdt')
    .row()
    .text('⬅️ بازگشت به مدیریت', 'admin:home'))

export const membershipKeyboard = (channels: Array<{ title: string; url: string }>, lang: Lang) => {
  const kb = new InlineKeyboard()
  for (const ch of channels) kb.url(`📢 ${ch.title.slice(0, 45)}`, ch.url).row()
  kb.text(lang === 'fa' ? '✅ بررسی عضویت' : '✅ Check membership', 'membership:check')
  return styleInline(kb)
}

export const adminChannelsKeyboard = (channels: Array<{ title: string; url: string; chatId: string }>) => {
  const kb = new InlineKeyboard()
  channels.forEach((ch, i) => kb.text(`🗑 ${i + 1}. ${ch.title.slice(0, 35)}`, `admch:del:${i}`).row())
  kb.text('➕ افزودن کانال', 'admch:add').row()
  kb.text('⬅️ بازگشت به تنظیمات', 'admin:settings')
  return styleInline(kb)
}
