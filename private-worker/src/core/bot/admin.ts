import { InlineKeyboard } from 'grammy'
import { randomUUID } from 'node:crypto'
import { OWNER_IDS } from '../config'
import { redis } from '../redis'
import { BROADCAST_WORKER_HEARTBEAT_PREFIX } from '../broadcast-constants'
import { BACKUP_STATUS_KEY, BACKUP_CONFIG_KEY, BACKUP_HISTORY_KEY, BACKUP_COMMAND_CHANNEL, SERVER_TELEMETRY_PREFIX } from '../telemetry'
import { Address } from '@ton/core'
import { logError } from '../logger'
import { CURRENCIES, type Currency, type MoneyCurrency, formatAmount, isCurrency, normalizeDigits, parseAmount } from '../money'
import { AdminLog, BroadcastCampaign, GroupTarget, House, Ledger, ManualDepositInvoice, Match, GroupDuel, Payment, Ticket, TonDepositInvoice, User, Withdrawal, type IManualDepositInvoice } from '../models'
import { clearState, getState, setState, type St } from '../services/state'
import { getBroadcastCounts, countEligibleUsers, type IBroadcastUserFilter } from '../services/broadcast'
import { enqueueBroadcastCampaign } from '../broadcast-queue'
import { getSettings, updateSettings, type Settings } from '../services/settings'
import { setRole } from '../services/users'
import { adminAdjust } from '../services/wallet'
import { resolveManualDepositInvoice } from '../services/manualDeposits'
import { adminChannelsKeyboard, adminMenuKeyboard, adminSettingsKeyboard, mainKeyboard, curName, broadcastAudienceKeyboard, broadcastUserFilterKeyboard, broadcastConfirmKeyboard } from './keyboards'
import { notify } from './notify'
import { bot, type BotContext } from './instance'
import { t } from '../i18n'

const isAdmin = (ctx: BotContext) => ctx.u?.role === 'admin' || ctx.u?.role === 'owner'
const isOwner = (ctx: BotContext) => ctx.u?.role === 'owner' || OWNER_IDS.has(ctx.from?.id ?? 0)
const log = (adminId: number, action: string, detail: string) =>
  AdminLog.create({ adminId, action, detail }).catch((e) => logError('admin_log_failed', e))

async function isBroadcastWorkerReady(): Promise<boolean> {
  try {
    let cursor = '0'
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', `${BROADCAST_WORKER_HEARTBEAT_PREFIX}*`, 'COUNT', 100)
      cursor = next
      for (const key of keys) if (await redis.pttl(key) > 0) return true
    } while (cursor !== '0')
  } catch (error) {
    logError('broadcast_worker_status_check_failed', error)
  }
  return false
}


interface ServerTelemetry {
  serverName: string
  instanceName: string
  instanceId: string
  service: string
  hostname: string
  pid: number
  cpuPercent: number
  totalMemoryBytes: number
  usedMemoryBytes: number
  diskTotalBytes: number
  diskUsedBytes: number
  sampledAt: string
  monitoringNamespace?: string
  backupStatus?: 'starting' | 'running' | 'success' | 'error' | 'skipped'
  lastBackupAt?: string
  lastBackupObjectKey?: string
  lastBackupBytes?: number
  lastBackupError?: string
  backupIntervalMinutes?: number
  lastBackupId?: string
  lastBackupFileName?: string
  lastBackupSha256?: string
  lastBackupDurationMs?: number
  lastBackupFileId?: string
  lastBackupMessageId?: number
}

async function getServerTelemetry(): Promise<Array<{ name: string; metrics: ServerTelemetry; instances: ServerTelemetry[] }>> {
  const keys: string[] = []
  let cursor = '0'
  do {
    const [next, found] = await redis.scan(cursor, 'MATCH', `${SERVER_TELEMETRY_PREFIX}*`, 'COUNT', 200)
    cursor = next
    keys.push(...found)
  } while (cursor !== '0')
  if (!keys.length) return []
  const values = await redis.mget(...keys)
  const byServer = new Map<string, ServerTelemetry[]>()
  for (const raw of values) {
    if (!raw) continue
    try {
      const item = JSON.parse(raw) as ServerTelemetry
      if (!item.serverName || !item.service || !item.sampledAt) continue
      const list = byServer.get(item.serverName) ?? []
      list.push(item)
      byServer.set(item.serverName, list)
    } catch { /* ignore a malformed/stale telemetry record */ }
  }
  return [...byServer.entries()].map(([name, instances]) => {
    instances.sort((a, b) => Date.parse(b.sampledAt) - Date.parse(a.sampledAt))
    return { name, metrics: instances[0]!, instances }
  }).sort((a, b) => a.name.localeCompare(b.name))
}

async function getPersistedBackupStatus(): Promise<ServerTelemetry | null> {
  try {
    const raw = await redis.get(BACKUP_STATUS_KEY)
    if (!raw) return null
    const item = JSON.parse(raw) as ServerTelemetry
    if (!item || typeof item !== 'object' || !item.backupStatus) return null
    return item
  } catch (error) {
    logError('backup_status_read_failed', error)
    return null
  }
}

function persistedBackupText(status: ServerTelemetry, online: boolean): string {
  const labels: Record<string, string> = {
    starting: 'در حال راه‌اندازی', running: 'در حال تهیه بکاپ', success: 'موفق', error: 'خطا', skipped: 'به‌دلیل قفل اجرا نشد',
  }
  const label = labels[String(status.backupStatus ?? 'unknown')] ?? 'نامشخص'
  return `🗄 <b>آخرین وضعیت بکاپ MongoDB</b>\n` +
    `   📡 وضعیت worker: <b>${online ? 'آنلاین' : 'آفلاین / گزارشی دریافت نمی‌شود'}</b>\n` +
    `   ✅ آخرین بکاپ موفق: <code>${status.lastBackupAt ? htmlEscape(new Date(status.lastBackupAt).toLocaleString('fa-IR', { hour12: false })) : 'ثبت نشده'}</code>\n` +
    `   📊 نتیجهٔ آخرین اجرا: <b>${label}</b>\n` +
    `   ⏱ فاصلهٔ تنظیم‌شده: <b>${Number(status.backupIntervalMinutes) || '—'} دقیقه</b>\n` +
    `   📦 اندازه: <b>${status.lastBackupBytes ? formatBytes(status.lastBackupBytes) : '—'}</b>\n` +
    `   📄 نام فایل تلگرام: <code>${htmlEscape(status.lastBackupFileName || '—')}</code>` +
    (status.lastBackupError ? `\n   ⚠️ آخرین خطا: ${htmlEscape(status.lastBackupError.slice(0, 180))}` : '')
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return 'نامشخص'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes, index = 0
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index++ }
  return `${value.toFixed(index >= 3 ? 1 : 0)} ${units[index]}`
}

function usageBar(percent: number): string {
  const safe = Math.max(0, Math.min(100, Number(percent) || 0))
  const filled = Math.round(safe / 10)
  return `${'▰'.repeat(filled)}${'▱'.repeat(10 - filled)} ${safe.toFixed(1)}%`
}

async function serverStatusText(requestedPage = 0): Promise<{ text: string; page: number; totalPages: number }> {
  const servers = await getServerTelemetry()
  const persistedBackup = await getPersistedBackupStatus()
  const backupWorkerOnline = servers.some((server) => server.instances.some((instance) => instance.service === 'backup-worker'))
  const backupFallback = persistedBackup && !backupWorkerOnline ? `\n\n━━━━━━━━━━━━━━━━━━\n\n${persistedBackupText(persistedBackup, false)}` : ''
  if (!servers.length) {
    return { text: '🛰 <b>وضعیت سرورها</b>\n\n⚠️ هنوز هیچ سرویس فعالی اطلاعات مانیتورینگ ارسال نکرده است.\n\nبررسی کن سرویس‌ها به Redis مشترک وصل باشند و در فایل <code>.env</code> مقدار <code>SERVER_NAME</code> تنظیم شده باشد.' + backupFallback, page: 0, totalPages: 1 }
  }
  const servicesCount = servers.reduce((sum, server) => sum + server.instances.length, 0)
  const totalPages = Math.max(1, Math.ceil(servers.length / 4))
  const page = Math.max(0, Math.min(totalPages - 1, Math.floor(requestedPage) || 0))
  const visibleServers = servers.slice(page * 4, page * 4 + 4)
  const lines = visibleServers.map(({ name, metrics, instances }) => {
    const ram = metrics.totalMemoryBytes > 0 ? metrics.usedMemoryBytes / metrics.totalMemoryBytes * 100 : 0
    const disk = metrics.diskTotalBytes > 0 ? metrics.diskUsedBytes / metrics.diskTotalBytes * 100 : 0
    const services = [...new Set(instances.map((x) => x.service))].sort()
    const serviceLines = services.map((service) => {
      const serviceInstances = instances.filter((x) => x.service === service)
      const instanceNames = serviceInstances.map((x) => `${htmlEscape(x.instanceName)} <code>#${Number(x.pid) || '?'}</code>`).slice(0, 8)
      const remaining = serviceInstances.length > 8 ? ` و ${serviceInstances.length - 8} نمونهٔ دیگر` : ''
      return `   • <b>${htmlEscape(service)}</b>: ${instanceNames.join('، ')}${remaining}`
    }).join('\n')
    const backup = instances.filter((x) => x.service === 'backup-worker').sort((a, b) => Date.parse(b.sampledAt) - Date.parse(a.sampledAt))[0]
    const backupStatus = backup ? ({
      starting: 'در حال راه‌اندازی', running: 'در حال تهیه بکاپ', success: 'موفق', error: 'خطا', skipped: 'به‌دلیل قفل اجرا نشد',
    } as Record<string, string>)[String(backup.backupStatus ?? 'unknown')] ?? 'نامشخص' : ''
    const backupLines = backup ? `\n   🗄 <b>وضعیت بکاپ MongoDB:</b> ${backupStatus}` +
      `\n   ⏱ <b>فاصلهٔ بکاپ:</b> ${Number(backup.backupIntervalMinutes) || '—'} دقیقه` +
      `\n   🕒 <b>آخرین بکاپ موفق:</b> <code>${backup.lastBackupAt ? htmlEscape(new Date(backup.lastBackupAt).toLocaleString('fa-IR', { hour12: false })) : 'هنوز ثبت نشده'}</code>` +
      `\n   📦 <b>حجم آخرین بکاپ:</b> ${backup.lastBackupBytes ? formatBytes(backup.lastBackupBytes) : '—'}` +
      `\n   📄 <b>نام فایل تلگرام:</b> <code>${htmlEscape(backup.lastBackupFileName || '—')}</code>` +
      (backup.lastBackupError ? `\n   ⚠️ <b>آخرین خطای بکاپ:</b> ${htmlEscape(backup.lastBackupError.slice(0, 180))}` : '') : ''
    const namespace = instances.find((x) => x.monitoringNamespace)?.monitoringNamespace
    const hosts = [...new Set(instances.map((x) => x.hostname).filter(Boolean))].map(htmlEscape).join(', ')
    return `🖥 <b>${htmlEscape(name)}</b>  ·  ${instances.length} نمونه سرویس\n` +
      `   🧩 <b>Namespace:</b> <code>${htmlEscape(namespace ?? '—')}</code>\n` +
      `   🖧 <b>Host:</b> <code>${hosts || '—'}</code>\n` +
      `   ⚙️ CPU   <code>${usageBar(metrics.cpuPercent)}</code>\n` +
      `   🧠 RAM   <code>${usageBar(ram)}</code>  (${formatBytes(metrics.usedMemoryBytes)} / ${formatBytes(metrics.totalMemoryBytes)})\n` +
      `   💽 Disk  <code>${usageBar(disk)}</code>  (${formatBytes(metrics.diskUsedBytes)} / ${formatBytes(metrics.diskTotalBytes)})\n` +
      `   📦 سرویس‌ها و instanceها:\n${serviceLines}${backupLines}\n` +
      `   🕒 آخرین نمونه: <code>${new Date(metrics.sampledAt).toLocaleTimeString('fa-IR', { hour12: false })}</code>`
  })
  const text = `🛰 <b>داشبورد وضعیت سرورها</b>\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `🟢 سرورهای آنلاین: <b>${servers.length}</b>\n` +
    `⚙️ نمونه‌سرویس‌های آنلاین: <b>${servicesCount}</b>\n` +
    `🔄 به‌روزرسانی خودکار داده‌ها: هر ۵ ثانیه\n` +
    `📄 صفحه <b>${page + 1}/${totalPages}</b>\n\n` +
    lines.join('\n\n━━━━━━━━━━━━━━━━━━\n\n') +
    backupFallback +
    `\n\n<i>هر سرور بر اساس SERVER_NAME گروه‌بندی شده است؛ بنابراین چند Worker روی یک سرور فقط یک سرور محسوب می‌شوند.</i>`
  return { text, page, totalPages }
}

export async function adminIds(): Promise<number[]> {
  const docs = await User.find({ role: { $in: ['admin', 'owner'] } }).select('tgId').lean()
  return [...new Set([...OWNER_IDS, ...docs.map((d) => d.tgId)])]
}

/** Single owner-only destination for deposit review notifications; never broadcast to ordinary admins. */
async function ownerId(): Promise<number | null> {
  const configured = [...OWNER_IDS][0]
  if (configured) return configured
  const owner = await User.findOne({ role: 'owner' }).select('tgId').sort({ createdAt: 1 }).lean()
  return owner?.tgId ?? null
}

async function notifyOwnerDepositDecision(p: {
  invoiceNumber: number; userId: number; amount: number; currency: MoneyCurrency; approved: boolean; reviewedBy: number; rejectionReason?: string
}): Promise<void> {
  const id = await ownerId()
  if (!id) return
  const owner = await User.findOne({ tgId: id }).select('lang').lean()
  const lang: BotContext['lang'] = owner?.lang === 'en' ? 'en' : 'fa'
  const approvedText = lang === 'fa' ? '✅ تأیید شد' : '✅ Approved'
  const rejectedText = lang === 'fa' ? '❌ رد شد' : '❌ Rejected'
  const text = `${lang === 'fa' ? '📣 <b>گزارش بررسی فاکتور واریز</b>' : '📣 <b>Deposit invoice review report</b>'}
`+
    `${lang === 'fa' ? 'کد فاکتور' : 'Invoice'}: <code>${p.invoiceNumber}</code>
`+
    `${lang === 'fa' ? 'شناسه کاربر' : 'User ID'}: <code>${p.userId}</code>
`+
    `${lang === 'fa' ? 'مبلغ' : 'Amount'}: <b>${formatAmount(p.amount, p.currency)} ${curName(lang, p.currency)}</b>
`+
    `${lang === 'fa' ? 'وضعیت نهایی' : 'Final status'}: <b>${p.approved ? approvedText : rejectedText}</b>
`+
    `${!p.approved && p.rejectionReason ? `${lang === 'fa' ? 'دلیل رد' : 'Rejection reason'}: ${htmlEscape(p.rejectionReason)}\n` : ''}`+
    `${lang === 'fa' ? 'بررسی‌کننده' : 'Reviewed by'}: <code>${p.reviewedBy}</code>`
  await notify(id, text)
}

const pct = (bp: number) => `${bp / 100}%`
const HELP = `<b>دستورات مدیریت</b>
/admin — نمایش تنظیمات و منوی مدیریت
/stats — آمار کاربران، رقابت‌ها و امور مالی
/bets IRT 10000,20000,30000,50000 — مبالغ شرط هر ارز
/fee win|draw|winTimeout|drawTimeout 10 — کارمزد (درصد)
/limit minDeposit|minWithdraw IRT 20000 — حداقل واریز/برداشت
/set betMatchSeconds|friendlyMatchSeconds|betQueueSeconds|friendlyQueueSeconds|betChatLimit|friendlyChatLimit|minDuels عدد
/refreward 5000 — پاداش زیرمجموعه (تومان)
/words add|del|list کلمه — فیلتر کلمات چت
جریمه کلمات ممنوع از تنظیمات: مبلغ ثابت جداگانه برای شرط تومان و TON (عدد ۰ = فقط هشدار)
/credit userId IRT 50000 — شارژ/کسر دستی (کسر با منفی)
/role userId admin|user — فقط مالک`

async function summary(): Promise<string> {
  const s = await getSettings()
  const bets = CURRENCIES.map((c) => `• ${c}: ${s.bets[c].map((a) => formatAmount(a, c)).join(' / ')}`).join('\n')
  return `<b>تنظیمات فعلی</b> (نسخه ${s.version})
<b>مبالغ شرط</b>
${bets}
<b>کارمزد</b>
برد ${pct(s.fees.win)} · مساوی ${pct(s.fees.draw)} · برد با تایم‌اوت ${pct(s.fees.winTimeout)} · مساوی با تایم‌اوت ${pct(s.fees.drawTimeout)}
سهم فعال‌کننده گروه از کارمزد رقابت‌های شرطی گروه: ${Number(s.groupRewardPercent ?? 20)}%
<b>حداقل واریز</b> IRT ${formatAmount(s.limits.minDeposit.IRT, 'IRT')} · TON ${formatAmount(s.limits.minDeposit.TON, 'TON')}
<b>حداقل برداشت</b> IRT ${formatAmount(s.limits.minWithdraw.IRT, 'IRT')} · TON ${formatAmount(s.limits.minWithdraw.TON, 'TON')}
<b>کارمزد ثابت برداشت</b> تومان ${formatAmount(s.withdrawalFees.IRT, 'IRT')} · شبکه TON ${formatAmount(s.withdrawalFees.TON, 'TON')}
<b>فاکتورهای دستی</b>
شماره کارت: ${s.manualDeposit.cardNumber ? 'تنظیم شده' : 'تنظیم نشده'} · صاحب کارت: ${s.manualDeposit.cardHolder ? 'تنظیم شده' : 'تنظیم نشده'}
پشتیبانی: ${s.manualDeposit.supportUsername ? '@' + s.manualDeposit.supportUsername : 'تنظیم نشده'}
آدرس دریافت TON: ${s.manualDeposit.tonAddress ? 'تنظیم شده در دیتابیس' : 'تنظیم نشده ⚠️'}
<b>حداقل دوئل شرطی برای برداشت</b> ${s.limits.minDuelsForWithdraw}
<b>پاداش زیرمجموعه</b> تومان ${formatAmount(s.referral.reward.IRT, 'IRT')} · تون (گرام) ${formatAmount(s.referral.reward.TON, 'TON')}
<b>سقف دعوت پاداش‌دار</b> ${s.referral.maxPaidReferrals}
<b>بونوس ساخت حساب</b> تومان ${formatAmount(s.registrationBonus.IRT, 'IRT')} · تون (گرام) ${formatAmount(s.registrationBonus.TON, 'TON')}
<b>حداقل زیرمجموعه برای برداشت</b> ${s.limits.minReferralsForWithdraw}
<b>امکانات</b> دوئل ${s.features.duelsEnabled ? 'روشن' : 'خاموش'} · شارژ ${s.features.depositsEnabled ? 'روشن' : 'خاموش'} · برداشت ${s.features.withdrawalsEnabled ? 'روشن' : 'خاموش'} · چت ${s.features.chatEnabled ? 'روشن' : 'خاموش'}
<b>عضویت اجباری</b> ${s.membership.enabled ? 'روشن' : 'خاموش'} · ${s.membership.channels.length} کانال/گروه
<b>دوئل شرطی:</b> مهلت انتخاب ${s.match.seconds}s · مهلت صف ${s.queue.seconds}s · سقف پیام هر نفر ${s.chat.maxMessages}
<b>دوئل دوستانه:</b> مهلت انتخاب ${s.match.friendlySeconds}s · مهلت صف ${s.queue.friendlySeconds}s · سقف پیام هر نفر ${s.chat.friendlyMaxMessages}
<b>جریمه کلمات ممنوع در دوئل شرطی</b> تومان ${formatAmount(s.chat.profanityPenalty.IRT, 'IRT')} · TON ${formatAmount(s.chat.profanityPenalty.TON, 'TON')} (۰ = فقط هشدار)
<b>کلمات ممنوع</b> ${s.bannedWords.length}

${HELP}`
}

const FEE_KEYS = ['win', 'draw', 'winTimeout', 'drawTimeout'] as const
const INT_KEYS: Record<string, { path: string; min: number; max: number }> = {
  // Old aliases are retained so existing admin commands do not break.
  matchSeconds: { path: 'match.seconds', min: 30, max: 3600 },
  queueSeconds: { path: 'queue.seconds', min: 30, max: 1800 },
  chatLimit: { path: 'chat.maxMessages', min: 0, max: 200 },
  minDuels: { path: 'limits.minDuelsForWithdraw', min: 0, max: 1000 },
  minReferrals: { path: 'limits.minReferralsForWithdraw', min: 0, max: 100000 },
  betMatchSeconds: { path: 'match.seconds', min: 30, max: 3600 },
  friendlyMatchSeconds: { path: 'match.friendlySeconds', min: 30, max: 3600 },
  betQueueSeconds: { path: 'queue.seconds', min: 30, max: 1800 },
  friendlyQueueSeconds: { path: 'queue.friendlySeconds', min: 30, max: 1800 },
  betChatLimit: { path: 'chat.maxMessages', min: 0, max: 200 },
  friendlyChatLimit: { path: 'chat.friendlyMaxMessages', min: 0, max: 200 },
}

interface SettingInput {
  path: string
  label: string
  kind: 'integer' | 'amount' | 'feeAmount' | 'percent' | 'bets' | 'text'
  min?: number
  max?: number
  currency?: Currency
  ownerOnly?: boolean
}
const SETTING_INPUTS: Record<string, SettingInput> = {
  bms: { path: 'match.seconds', label: 'زمان دوئل شرطی (ثانیه)', kind: 'integer', min: 30, max: 3600 },
  fms: { path: 'match.friendlySeconds', label: 'زمان دوئل دوستانه (ثانیه)', kind: 'integer', min: 30, max: 3600 },
  bqs: { path: 'queue.seconds', label: 'مهلت پیدا کردن حریف شرطی (ثانیه)', kind: 'integer', min: 30, max: 1800 },
  fqs: { path: 'queue.friendlySeconds', label: 'مهلت پیدا کردن حریف دوستانه (ثانیه)', kind: 'integer', min: 30, max: 1800 },
  bcl: { path: 'chat.maxMessages', label: 'سقف پیام هر بازیکن در دوئل شرطی', kind: 'integer', min: 0, max: 200 },
  fcl: { path: 'chat.friendlyMaxMessages', label: 'سقف پیام هر بازیکن در دوئل دوستانه', kind: 'integer', min: 0, max: 200 },
  md: { path: 'limits.minDuelsForWithdraw', label: 'حداقل تعداد دوئل برای برداشت', kind: 'integer', min: 0, max: 1000 },
  mr: { path: 'limits.minReferralsForWithdraw', label: 'حداقل تعداد زیرمجموعه برای برداشت', kind: 'integer', min: 0, max: 100000 },
  rbi: { path: 'registrationBonus.IRT', label: 'بونوس ساخت حساب (تومان)', kind: 'amount', currency: 'IRT' },
  rbt: { path: 'registrationBonus.TON', label: 'بونوس ساخت حساب (TON/گرام)', kind: 'amount', currency: 'TON' },
  ri: { path: 'referral.reward.IRT', label: 'پاداش زیرمجموعه (تومان)', kind: 'amount', currency: 'IRT' },
  rt: { path: 'referral.reward.TON', label: 'پاداش زیرمجموعه (TON/گرام)', kind: 'amount', currency: 'TON' },
  rm: { path: 'referral.maxPaidReferrals', label: 'حداکثر تعداد زیرمجموعه پاداش‌دار', kind: 'integer', min: 0, max: 1000000 },
  di: { path: 'limits.minDeposit.IRT', label: 'حداقل واریز تومان', kind: 'amount', currency: 'IRT' },
  wi: { path: 'limits.minWithdraw.IRT', label: 'حداقل برداشت تومان', kind: 'amount', currency: 'IRT' },
  dt: { path: 'limits.minDeposit.TON', label: 'حداقل واریز TON (گرام)', kind: 'amount', currency: 'TON' },
  wt: { path: 'limits.minWithdraw.TON', label: 'حداقل برداشت TON (گرام)', kind: 'amount', currency: 'TON' },
  wfi: { path: 'withdrawalFees.IRT', label: 'کارمزد ثابت برداشت تومان (بین‌بانکی)', kind: 'feeAmount', currency: 'IRT' },
  wft: { path: 'withdrawalFees.TON', label: 'کارمزد ثابت برداشت TON (شبکه)', kind: 'feeAmount', currency: 'TON' },
  cpi: { path: 'chat.profanityPenalty.IRT', label: 'جریمه استفاده از کلمات فیلترشده در شرط تومان', kind: 'feeAmount', currency: 'IRT' },
  cpt: { path: 'chat.profanityPenalty.TON', label: 'جریمه استفاده از کلمات فیلترشده در شرط TON (گرام)', kind: 'feeAmount', currency: 'TON' },
  bi: { path: 'bets.IRT', label: 'فهرست مبالغ شرط IRT', kind: 'bets', currency: 'IRT' },
  bt: { path: 'bets.TON', label: 'فهرست مبالغ شرط TON (گرام)', kind: 'bets', currency: 'TON' },
  fw: { path: 'fees.win', label: 'کارمزد برد عادی (درصد)', kind: 'percent' },
  fd: { path: 'fees.draw', label: 'کارمزد مساوی (درصد)', kind: 'percent' },
  ftw: { path: 'fees.winTimeout', label: 'کارمزد برد با تایم‌اوت (درصد)', kind: 'percent' },
  fdt: { path: 'fees.drawTimeout', label: 'کارمزد مساوی با تایم‌اوت (درصد)', kind: 'percent' },
  card: { path: 'manualDeposit.cardNumber', label: 'شماره کارت بانکی', kind: 'text' },
  holder: { path: 'manualDeposit.cardHolder', label: 'نام صاحب کارت', kind: 'text' },
  support: { path: 'manualDeposit.supportUsername', label: 'آیدی پشتیبانی (username)', kind: 'text' },
  tonaddr: { path: 'manualDeposit.tonAddress', label: 'آدرس عمومی کیف پول دریافت TON (گرام)', kind: 'text' },
  grp: { path: 'groupRewardPercent', label: 'درصد سهم فعال‌کننده گروه از کارمزد رقابت‌های شرطی گروه', kind: 'integer', min: 0, max: 100, ownerOnly: true },
}

function settingCurrentValue(s: Settings, key: string): string {
  const x = SETTING_INPUTS[key]
  if (!x) return '—'
  const v: any = x.path.split('.').reduce((o, k) => o?.[k], s as any)
  if ((x.kind === 'amount' || x.kind === 'feeAmount') && x.currency) return `${formatAmount(Number(v ?? 0), x.currency)} ${x.currency}`
  if (key === 'grp') return `${Number(v ?? 20)}%`
  if (x.kind === 'bets' && x.currency) return (v as number[]).map((a) => formatAmount(a, x.currency!)).join(',')
  if (x.kind === 'percent') return pct(Number(v ?? 0))
  if (key === 'support' && v) return `@${String(v).replace(/^@/, '')}`
  if (key === 'card' && v) return String(v).replace(/(.{4})/g, '$1 ').trim()
  return String(v ?? '—')
}

export async function updateAdminSettingFromInput(
  adminId: number,
  key: string,
  input: string,
): Promise<{ ok: boolean; message: string }> {
  const def = SETTING_INPUTS[key]
  if (!def) return { ok: false, message: 'این تنظیم ناشناخته است.' }
  if (def.ownerOnly && !OWNER_IDS.has(adminId) && (await User.findOne({ tgId: adminId }).select('role').lean() as any)?.role !== 'owner') return { ok: false, message: '⛔ این تنظیم فقط برای مالک اصلی ربات مجاز است.' }
  const normalized = normalizeDigits(input.trim())
  let value: unknown
  let valueText = normalized
  if (def.kind === 'integer') {
    const n = Number(normalized)
    if (!Number.isSafeInteger(n) || n < (def.min ?? 0) || n > (def.max ?? Number.MAX_SAFE_INTEGER)) {
      return { ok: false, message: '❌ عدد باید در بازه مجاز باشد.' }
    }
    value = n
    valueText = String(n)
  } else if (def.kind === 'amount' || def.kind === 'feeAmount') {
    const parsed = parseAmount(normalized, def.currency!)
    const isZeroFee = def.kind === 'feeAmount' && /^0+(?:\.0+)?$/.test(normalized)
    const n = parsed ?? (isZeroFee ? 0 : null)
    if (n === null) return { ok: false, message: def.kind === 'feeAmount' ? '❌ کارمزد معتبر نیست. مبلغ را با واحد اصلی وارد کن؛ برای غیرفعال‌کردن کارمزد عدد ۰ را بفرست.' : '❌ مبلغ معتبر نیست. عدد را با واحد اصلی وارد کن.' }
    value = n
    valueText = `${formatAmount(n, def.currency!)} ${def.currency}`
  } else if (def.kind === 'percent') {
    if (!/^\d{1,2}(?:\.\d{1,2})?$/.test(normalized)) return { ok: false, message: '❌ درصد نامعتبر است.' }
    const n = Math.round(Number(normalized) * 100)
    if (n < 0 || n > 5000) return { ok: false, message: '❌ کارمزد باید بین ۰ تا ۵۰ درصد باشد.' }
    value = n
    valueText = pct(n)
  } else if (def.kind === 'text') {
    const clean = input.trim()
    if (key === 'card') {
      const card = normalizeDigits(clean).replace(/[\s-]/g, '')
      if (!/^\d{16}$/.test(card)) return { ok: false, message: '❌ شماره کارت باید ۱۶ رقم باشد.' }
      value = card
      valueText = card.replace(/(.{4})/g, '$1 ').trim()
    } else if (key === 'holder') {
      if (clean.length < 2 || clean.length > 100 || /[<>\u0000-\u001f]/.test(clean)) {
        return { ok: false, message: '❌ نام صاحب کارت باید بین ۲ تا ۱۰۰ نویسه باشد.' }
      }
      value = clean
      valueText = clean
    } else if (key === 'support') {
      const match = /^(?:https?:\/\/)?(?:t\.me\/)?@?([A-Za-z0-9_]{5,32})\/?$/i.exec(clean)
      if (!match) return { ok: false, message: '❌ آیدی پشتیبانی معتبر نیست؛ فقط username تلگرام را وارد کن، مثلاً @my_support.' }
      value = match[1]
      valueText = `@${match[1]}`
    } else if (key === 'tonaddr') {
      try {
        value = Address.parse(clean).toString({ bounceable: false, urlSafe: true })
        valueText = String(value)
      } catch {
        return { ok: false, message: '❌ آدرس TON معتبر نیست. آدرس عمومی کیف پول TON را ارسال کن.' }
      }
    } else {
      return { ok: false, message: '❌ نوع این تنظیم پشتیبانی نمی‌شود.' }
    }
  } else {
    const items = input.trim().split(/[,،;]/).map((v) => parseAmount(v, def.currency!))
    if (items.length < 1 || items.length > 8 || items.some((n) => n === null)) {
      return { ok: false, message: '❌ بین ۱ تا ۸ مبلغ معتبر، با ویرگول جداشده، وارد کن.' }
    }
    const list = [...new Set(items as number[])].sort((a, b) => a - b)
    value = list
    valueText = list.map((a) => formatAmount(a, def.currency!)).join(' / ')
  }
  await updateSettings(def.path, value)
  if (key === 'ri') await updateSettings('referral.rewardIRT', value) // backward compatibility with older settings
  await log(adminId, 'setting_ui', `${def.path}=${Array.isArray(value) ? value.join(',') : value}`)
  return { ok: true, message: `✅ ${htmlEscape(def.label)} با موفقیت به ${htmlEscape(valueText)} تغییر کرد.` }
}

async function adminStatsText(): Promise<string> {
  const [users, active, queued, completed, groupCompleted, groupActive, house, ledgerRows, pendingPayments, pendingManualInvoices, pendingTonInvoices, pendingWithdrawals, balances, activeGroups] = await Promise.all([
    User.countDocuments({}),
    Match.countDocuments({ status: 'choosing' }),
    Ticket.countDocuments({ status: 'queued' }),
    Match.countDocuments({ status: 'settled' }),
    GroupDuel.countDocuments({ status: 'settled' }),
    GroupDuel.countDocuments({ status: { $in: ['pending', 'choosing', 'settling'] } }),
    House.findById('house').lean(),
    Ledger.aggregate([
      { $group: { _id: { currency: '$currency', type: '$type' }, available: { $sum: '$available' }, locked: { $sum: '$locked' } } },
    ]),
    Payment.aggregate([{ $match: { status: 'pending' } }, { $group: { _id: '$currency', amount: { $sum: '$amount' } } }]),
    ManualDepositInvoice.aggregate([{ $match: { status: 'pending' } }, { $group: { _id: '$currency', amount: { $sum: '$amount' } } }]),
    TonDepositInvoice.aggregate([{ $match: { status: 'pending' } }, { $group: { _id: '$currency', amount: { $sum: '$amount' } } }]),
    Withdrawal.aggregate([{ $match: { status: 'pending' } }, { $group: { _id: '$currency', amount: { $sum: '$amount' } } }]),
    User.aggregate([{ $group: { _id: null, irtAvailable: { $sum: '$balances.IRT.available' }, irtLocked: { $sum: '$balances.IRT.locked' }, tonAvailable: { $sum: '$balances.TON.available' }, tonLocked: { $sum: '$balances.TON.locked' } } }]),
    GroupTarget.countDocuments({ status: 'active' }),
  ])
  const ledger = (currency: Currency, type: string, field: 'available' | 'locked' = 'available') =>
    Number(ledgerRows.find((r: any) => r._id.currency === currency && r._id.type === type)?.[field] ?? 0)
  const pending = (rows: any[], manualRows: any[], tonRows: any[], currency: Currency) =>
    Number(rows.find((r) => r._id === currency)?.amount ?? 0) + Number(manualRows.find((r) => r._id === currency)?.amount ?? 0) + Number(tonRows.find((r) => r._id === currency)?.amount ?? 0)
  const commission = (currency: Currency) => ledger(currency, 'fee') + ledger(currency, 'group_fee') + ledger(currency, 'withdrawal_fee')
  const b: any = balances[0] ?? { irtAvailable: 0, irtLocked: 0, tonAvailable: 0, tonLocked: 0 }
  return `<b>📊 آمار کامل ربات</b>
👥 کل کاربران: <b>${users.toLocaleString('en-US')}</b>
👥 گروه‌های فعال: <b>${activeGroups.toLocaleString('en-US')}</b>
⚔️ دوئل‌های فعال: <b>${active}</b> · در انتظار حریف: <b>${queued}</b>
🏁 دوئل‌های انجام‌شدهٔ خصوصی: <b>${completed}</b>\n🏟 دوئل‌های گروهی: <b>${groupCompleted}</b> انجام‌شده · <b>${groupActive}</b> فعال

<b>💰 تومان (IRT)</b>
واریز تأییدشده: ${formatAmount(ledger('IRT', 'deposit'), 'IRT')}
برداشت پرداخت‌شده: ${formatAmount(-ledger('IRT', 'withdraw_paid', 'locked'), 'IRT')}
واریز معلق: ${formatAmount(pending(pendingPayments, pendingManualInvoices, pendingTonInvoices, 'IRT'), 'IRT')}
برداشت معلق: ${formatAmount(pending(pendingWithdrawals, [], [], 'IRT'), 'IRT')}
موجودی آزاد کاربران: ${formatAmount(b.irtAvailable, 'IRT')}
موجودی رزروشده کاربران: ${formatAmount(b.irtLocked, 'IRT')}
کارمزد دوئل خصوصی: ${formatAmount(ledger('IRT', 'fee'), 'IRT')}
کارمزد دوئل گروهی (سهم خانه): ${formatAmount(ledger('IRT', 'group_fee'), 'IRT')}
کارمزد برداشت: ${formatAmount(ledger('IRT', 'withdrawal_fee'), 'IRT')}
<b>مجموع درآمد کارمزد:</b> ${formatAmount(commission('IRT'), 'IRT')}
مانده خالص حساب خانه پس از پاداش‌ها و هزینه‌ها: ${formatAmount(house?.balances?.IRT ?? 0, 'IRT')}

<b>💎 تون (گرام) · TON</b>
واریز تأییدشده: ${formatAmount(ledger('TON', 'deposit'), 'TON')}
برداشت پرداخت‌شده: ${formatAmount(-ledger('TON', 'withdraw_paid', 'locked'), 'TON')}
واریز معلق: ${formatAmount(pending(pendingPayments, pendingManualInvoices, pendingTonInvoices, 'TON'), 'TON')}
برداشت معلق: ${formatAmount(pending(pendingWithdrawals, [], [], 'TON'), 'TON')}
موجودی آزاد کاربران: ${formatAmount(b.tonAvailable, 'TON')}
موجودی رزروشده کاربران: ${formatAmount(b.tonLocked, 'TON')}
کارمزد دوئل خصوصی: ${formatAmount(ledger('TON', 'fee'), 'TON')}
کارمزد دوئل گروهی (سهم خانه): ${formatAmount(ledger('TON', 'group_fee'), 'TON')}
کارمزد برداشت: ${formatAmount(ledger('TON', 'withdrawal_fee'), 'TON')}
<b>مجموع درآمد کارمزد:</b> ${formatAmount(commission('TON'), 'TON')}
مانده خالص حساب خانه پس از پاداش‌ها و هزینه‌ها: ${formatAmount(house?.balances?.TON ?? 0, 'TON')}`
}

async function saveRequiredChannel(adminId: number, input: string): Promise<string> {
  const [rawId, rawUrl] = input.split('|').map((x) => x.trim())
  if (!rawId) return '❌ شناسه کانال یا گروه نامعتبر است.'
  const chatArg: string | number = /^-?\d+$/.test(rawId) ? Number(rawId) : (rawId.startsWith('@') ? rawId : `@${rawId}`)
  let chat: any
  try {
    chat = await bot.api.getChat(chatArg)
  } catch {
    return '❌ کانال/گروه پیدا نشد یا ربات به آن دسترسی ندارد. ابتدا ربات را به مقصد اضافه کن.'
  }
  const kind = String(chat.type ?? '')
  if (!['channel', 'group', 'supergroup'].includes(kind)) return '❌ فقط کانال، گروه یا سوپرگروه قابل ثبت است.'
  let me: any
  let botMember: any
  try {
    me = await bot.api.getMe()
    botMember = await bot.api.getChatMember(chat.id, me.id)
  } catch {
    return '❌ وضعیت دسترسی ربات قابل بررسی نیست. ربات را به مقصد اضافه کن و دوباره تلاش کن.'
  }
  if (!['administrator', 'creator'].includes(String(botMember.status))) {
    return '❌ برای فعال‌سازی عضویت اجباری، ربات باید در همان کانال/گروه ادمین باشد.'
  }
  const username = chat.username ? String(chat.username) : ''
  const url = rawUrl || (username ? `https://t.me/${username}` : '')
  if (!url || !/^https:\/\/t\.me\//i.test(url)) {
    return '❌ این مقصد خصوصی است؛ شناسه و لینک دعوت را با | وارد کن: <code>-1001234567890 | https://t.me/+InviteCode</code>'
  }
  if (!username && !rawUrl) return '❌ برای مقصد خصوصی باید لینک دعوت اختصاصی وارد شود.'
  const cfg = await getSettings()
  if (cfg.membership.channels.some((x) => x.chatId === String(chat.id))) return 'این مقصد از قبل اضافه شده است.'
  const title = String(chat.title ?? username ?? chat.id)
  const targets = [...cfg.membership.channels, { chatId: String(chat.id), title, url, kind: kind as 'channel' | 'group' | 'supergroup' }]
  await updateSettings('membership.channels', targets)
  await updateSettings('membership.enabled', true)
  await log(adminId, 'required_membership_target_add', `${kind}|${chat.id}|${title}`)
  const safeTitle = title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return `✅ ${kind === 'channel' ? 'کانال' : 'گروه'} <b>${safeTitle}</b> اضافه شد. ربات به‌عنوان ادمین ثبت شد.`
}

const htmlEscape = (value: unknown): string => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

function manualInvoiceText(invoice: IManualDepositInvoice, lang: BotContext['lang']): string {
  const isFa = lang === 'fa'
  const createdAt = invoice.createdAt
    ? new Date(invoice.createdAt).toLocaleString(isFa ? 'fa-IR' : 'en-GB')
    : '—'
  const status = invoice.status === 'pending'
    ? (isFa ? '⏳ در انتظار بررسی' : '⏳ Pending review')
    : invoice.status === 'approved'
      ? (isFa ? '✅ تأیید شده' : '✅ Approved')
      : (isFa ? '❌ رد شده' : '❌ Rejected')
  const username = invoice.userUsername ? `@${htmlEscape(invoice.userUsername)}` : (isFa ? 'ثبت نشده' : 'not set')
  const destination = invoice.currency === 'IRT'
    ? `${isFa ? 'شماره کارت ذخیره‌شده' : 'Snapshotted card number'}: <code>${htmlEscape(invoice.cardNumber)}</code>\n${isFa ? 'صاحب کارت' : 'Card holder'}: <b>${htmlEscape(invoice.cardHolder)}</b>`
    : (isFa ? 'پرداخت TON از طریق فاکتور شبکه TON انجام می‌شود.' : 'TON payments use native TON invoices.')
  return `${isFa ? '🧾 <b>جزئیات فاکتور واریز دستی</b>' : '🧾 <b>Manual deposit invoice details</b>'}
━━━━━━━━━━━━━━━━━━
${isFa ? 'کد فاکتور' : 'Invoice code'}: <code>${invoice.invoiceNumber}</code>
${isFa ? 'وضعیت' : 'Status'}: <b>${status}</b>
${isFa ? 'نام ثبت‌شده' : 'Registered name'}: <b>${htmlEscape(invoice.userFirstName || (isFa ? 'ثبت نشده' : 'not set'))}</b>
${isFa ? 'نام کاربری' : 'Username'}: ${username}
${isFa ? 'آیدی عددی تلگرام' : 'Telegram numeric ID'}: <code>${invoice.userId}</code>
${isFa ? 'مبلغ فاکتور' : 'Invoice amount'}: <b>${formatAmount(invoice.amount, invoice.currency)} ${invoice.currency}</b>
${isFa ? 'زمان ساخت فاکتور' : 'Created at'}: <b>${htmlEscape(createdAt)}</b>
${destination}
${isFa ? 'پشتیبانی ثبت‌شده در زمان صدور' : 'Support username at creation'}: @${htmlEscape(invoice.supportUsername || '')}
${invoice.reviewedBy ? `${isFa ? 'بررسی‌کننده' : 'Reviewed by'}: <code>${invoice.reviewedBy}</code>` : ''}\n${invoice.reviewReason ? `${isFa ? 'دلیل رد' : 'Rejection reason'}: <b>${htmlEscape(invoice.reviewReason)}</b>` : ''}`
}

const manualInvoiceKeyboard = (invoice: IManualDepositInvoice, lang: BotContext['lang']) => invoice.status !== 'pending'
  ? { inline_keyboard: [] as Array<Array<{ text: string; callback_data: string }>> }
  : {
      inline_keyboard: [[
        { text: lang === 'fa' ? '✅ تأیید و شارژ حساب' : '✅ Approve and credit', callback_data: `inv:approve:${invoice.invoiceNumber}` },
        { text: lang === 'fa' ? '❌ رد فاکتور' : '❌ Reject invoice', callback_data: `inv:reject:${invoice.invoiceNumber}` },
      ]],
    }

export type AdminInvoiceMessageRef = { chatId: number; messageId: number }

/** Resolve a manual invoice and notify the user and owner, retaining the rejection reason. */
export async function processManualDepositDecision(
  ctx: BotContext,
  invoiceNumber: number,
  approve: boolean,
  rejectionReason = '',
  origin?: AdminInvoiceMessageRef,
): Promise<boolean> {
  if (!isAdmin(ctx)) {
    await ctx.reply(t(ctx.lang, 'admin.not_allowed'), { parse_mode: 'HTML' })
    return false
  }
  const message = ctx.callbackQuery?.message
  const target = origin ?? (message && 'message_id' in message ? { chatId: message.chat.id, messageId: message.message_id } : undefined)
  const resolved = await resolveManualDepositInvoice(invoiceNumber, ctx.from!.id, approve, rejectionReason)
  if (!resolved) {
    const latest = await ManualDepositInvoice.findOne({ invoiceNumber }).lean()
    const response = latest ? manualInvoiceText(latest, ctx.lang) : t(ctx.lang, 'admin.invoice_not_found')
    if (target) {
      await ctx.api.editMessageText(target.chatId, target.messageId, response, {
        parse_mode: 'HTML',
        reply_markup: latest ? manualInvoiceKeyboard(latest, ctx.lang) : { inline_keyboard: [] },
      }).catch(() => undefined)
    } else {
      await ctx.reply(latest ? t(ctx.lang, 'admin.invoice_not_pending') : t(ctx.lang, 'admin.invoice_not_found'), { parse_mode: 'HTML' })
    }
    return false
  }

  const finalInvoice = { ...resolved, status: approve ? 'approved' as const : 'rejected' as const }
  if (target) {
    await ctx.api.editMessageText(target.chatId, target.messageId, manualInvoiceText(finalInvoice, ctx.lang), {
      parse_mode: 'HTML',
      reply_markup: manualInvoiceKeyboard(finalInvoice, ctx.lang),
    }).catch(() => undefined)
  }
  await log(ctx.from!.id, approve ? 'manual_deposit_approved' : 'manual_deposit_rejected', `invoice=${invoiceNumber}|user=${resolved.userId}|amount=${resolved.amount}|currency=${resolved.currency}|reason=${approve ? '' : rejectionReason.trim()}`)

  const amount = formatAmount(resolved.amount, resolved.currency)
  const invoiceUser = await User.findOne({ tgId: resolved.userId }).select('balances lang').lean()
  const userLang: BotContext['lang'] = invoiceUser?.lang === 'fa' ? 'fa' : 'en'
  const currencyName = resolved.currency === 'IRT' ? (userLang === 'fa' ? 'تومان' : 'Toman') : (userLang === 'fa' ? 'تون (گرام)' : 'TON (Gram)')
  if (approve) {
    const balance = Number(invoiceUser?.balances?.[resolved.currency]?.available ?? 0)
    await notify(resolved.userId, t(userLang, 'deposit.manual_approved', {
      invoice: invoiceNumber,
      amount,
      cur: currencyName,
      balance: formatAmount(balance, resolved.currency),
    }))
  } else {
    await notify(resolved.userId, t(userLang, 'deposit.manual_rejected', {
      invoice: invoiceNumber,
      reason: htmlEscape(rejectionReason.trim()),
    }))
  }
  await notifyOwnerDepositDecision({
    invoiceNumber,
    userId: resolved.userId,
    amount: resolved.amount,
    currency: resolved.currency,
    approved: approve,
    reviewedBy: ctx.from!.id,
    rejectionReason: approve ? undefined : rejectionReason.trim(),
  })
  return true
}

/** Search by tracking number. Withdrawal invoice announcements go to the owner only, but any
 * authorized admin can look up a withdrawal when they have its invoice code. Only the owner gets
 * approve/reject controls. Codes can collide across invoice collections, so show every match. */
export async function handleManualInvoiceSearch(ctx: BotContext, input: string): Promise<void> {
  if (!isAdmin(ctx)) return void (await ctx.reply(t(ctx.lang, 'admin.not_allowed'), { parse_mode: 'HTML' }))
  const code = normalizeDigits(input.trim())
  if (!/^\d{1,12}$/.test(code) || !Number.isSafeInteger(Number(code)) || Number(code) <= 0) {
    return void (await ctx.reply(t(ctx.lang, 'admin.invoice_invalid'), { parse_mode: 'HTML' }))
  }

  const numericCode = Number(code)
  const [withdrawal, depositInvoice, tonDepositInvoice] = await Promise.all([
    Withdrawal.findById(code).lean(),
    ManualDepositInvoice.findOne({ invoiceNumber: numericCode }).lean(),
    TonDepositInvoice.findOne({ invoiceNumber: numericCode }).lean(),
  ])
  if (!withdrawal && !depositInvoice && !tonDepositInvoice) {
    return void (await ctx.reply(t(ctx.lang, 'admin.invoice_not_found'), { parse_mode: 'HTML' }))
  }

  if (withdrawal) {
    const user = await User.findOne({ tgId: withdrawal.userId }).select('firstName username').lean()
    const status = withdrawal.status === 'pending'
      ? (ctx.lang === 'fa' ? '⏳ در انتظار بررسی مالک' : '⏳ Pending owner review')
      : withdrawal.status === 'paid'
        ? (ctx.lang === 'fa' ? '✅ پرداخت‌شده' : '✅ Paid')
        : (ctx.lang === 'fa' ? '❌ ردشده و مبلغ برگشته' : '❌ Rejected and refunded')
    const isToman = withdrawal.currency === 'IRT'
    const destinationLabel = isToman
      ? (ctx.lang === 'fa' ? 'شماره شبای مقصد' : 'Destination IBAN')
      : (ctx.lang === 'fa' ? 'آدرس کیف پول مقصد' : 'Destination wallet')
    const feeLabel = isToman
      ? (ctx.lang === 'fa' ? 'کارمزد ثابت بین‌بانکی' : 'Fixed interbank fee')
      : (ctx.lang === 'fa' ? 'کارمزد ثابت شبکه TON' : 'Fixed TON network fee')
    const amount = formatAmount(withdrawal.amount, withdrawal.currency)
    const fee = formatAmount(withdrawal.fee ?? 0, withdrawal.currency)
    const payout = formatAmount(withdrawal.payoutAmount ?? (withdrawal.amount - (withdrawal.fee ?? 0)), withdrawal.currency)
    const currencyName = curName(ctx.lang, withdrawal.currency)
    const name = htmlEscape(user?.firstName ?? '—')
    const username = user?.username ? '@' + htmlEscape(user.username) : '—'
    const text = `${ctx.lang === 'fa' ? '📤 <b>فاکتور برداشت</b>' : '📤 <b>Withdrawal invoice</b>'}\n` +
      `کد پیگیری: <code>${htmlEscape(withdrawal._id)}</code>\n` +
      `${ctx.lang === 'fa' ? 'وضعیت' : 'Status'}: <b>${status}</b>\n` +
      `${ctx.lang === 'fa' ? 'کاربر' : 'User'}: <b>${name}</b> (${username}) · <code>${withdrawal.userId}</code>\n` +
      `${ctx.lang === 'fa' ? 'مبلغ رزروشده/کسرشده از موجودی' : 'Gross amount reserved'}: <b>${amount} ${currencyName}</b>\n` +
      `${feeLabel}: <b>${fee} ${currencyName}</b>\n` +
      `${ctx.lang === 'fa' ? 'مبلغ خالص قابل پرداخت به کاربر' : 'Net amount to pay'}: <b>${payout} ${currencyName}</b>\n` +
      `${destinationLabel}: <code>${htmlEscape(withdrawal.dest)}</code>\n` +
      `${withdrawal.bankName ? `${ctx.lang === 'fa' ? 'بانک' : 'Bank'}: <b>${htmlEscape(withdrawal.bankName)}</b>\n` : ''}` +
      `${withdrawal.fullName ? `${ctx.lang === 'fa' ? 'نام صاحب حساب' : 'Account holder'}: <b>${htmlEscape(withdrawal.fullName)}</b>\n` : ''}` +
      `${ctx.lang === 'fa' ? 'زمان ثبت' : 'Created'}: ${withdrawal.createdAt ? new Date(withdrawal.createdAt).toLocaleString(ctx.lang === 'fa' ? 'fa-IR' : 'en-GB') : '—'}\n` +
      `${ctx.lang === 'fa' ? 'یادآوری' : 'Reminder'}: ${isToman
        ? (ctx.lang === 'fa' ? 'برای پرداخت، مالک باید از همراه‌بانک مبلغ خالص را به شبای مقصد واریز کند.' : 'The owner should transfer the net amount to the IBAN using mobile banking.')
        : (ctx.lang === 'fa' ? 'برای پرداخت، مالک باید از Tonkeeper مبلغ خالص را به آدرس مقصد ارسال کند.' : 'The owner should send the net amount to the destination using Tonkeeper.')}` +
      `${withdrawal.reviewReason ? `\n${ctx.lang === 'fa' ? 'دلیل رد' : 'Rejection reason'}: <b>${htmlEscape(withdrawal.reviewReason)}</b>` : ''}`
    const markup = isOwner(ctx) && withdrawal.status === 'pending'
      ? { inline_keyboard: [[
          { text: ctx.lang === 'fa' ? '✅ پرداخت شد' : '✅ Mark paid', callback_data: `wda:ok:${withdrawal._id}` },
          { text: ctx.lang === 'fa' ? '❌ رد و بازگشت مبلغ' : '❌ Reject/refund', callback_data: `wda:no:${withdrawal._id}` },
        ]] }
      : undefined
    await ctx.reply(text, { parse_mode: 'HTML', ...(markup ? { reply_markup: markup } : {}) })
  }

  if (depositInvoice) {
    await ctx.reply(manualInvoiceText(depositInvoice, ctx.lang), {
      parse_mode: 'HTML',
      reply_markup: manualInvoiceKeyboard(depositInvoice, ctx.lang),
    })
  }

  if (tonDepositInvoice) {
    const status = tonDepositInvoice.status === 'paid'
      ? (ctx.lang === 'fa' ? '✅ پرداخت‌شده' : '✅ Paid')
      : (ctx.lang === 'fa' ? '⏳ منتظر تراکنش بلاک‌چینی' : '⏳ Awaiting blockchain transaction')
    const text = `${ctx.lang === 'fa' ? '💎 <b>فاکتور واریز TON</b>' : '💎 <b>TON deposit invoice</b>'}\n` +
      `${ctx.lang === 'fa' ? 'کد پیگیری' : 'Tracking number'}: <code>${tonDepositInvoice.invoiceNumber}</code>\n` +
      `${ctx.lang === 'fa' ? 'وضعیت' : 'Status'}: <b>${status}</b>\n` +
      `${ctx.lang === 'fa' ? 'شناسه کاربر' : 'User ID'}: <code>${tonDepositInvoice.userId}</code>\n` +
      `${ctx.lang === 'fa' ? 'مبلغ دقیق' : 'Exact amount'}: <b>${formatAmount(tonDepositInvoice.amount, 'TON')} ${curName(ctx.lang, 'TON')}</b>\n` +
      `${ctx.lang === 'fa' ? 'شبکه' : 'Network'}: <b>${htmlEscape(tonDepositInvoice.network ?? 'mainnet')}</b>\n` +
      `${ctx.lang === 'fa' ? 'آدرس دریافت' : 'Recipient address'}: <code>${htmlEscape(tonDepositInvoice.recipientAddress)}</code>\n` +
      `${ctx.lang === 'fa' ? 'کامنت/شناسه مرجع' : 'Reference comment'}: <code>${htmlEscape(tonDepositInvoice.comment)}</code>\n` +
      `${tonDepositInvoice.txHash ? `${ctx.lang === 'fa' ? 'هش تراکنش' : 'Transaction hash'}: <code>${htmlEscape(tonDepositInvoice.txHash)}</code>\n` : ''}` +
      `${tonDepositInvoice.sourceAddress ? `${ctx.lang === 'fa' ? 'آدرس فرستنده' : 'Source address'}: <code>${htmlEscape(tonDepositInvoice.sourceAddress)}</code>\n` : ''}` +
      `${ctx.lang === 'fa' ? 'ایجاد شده' : 'Created'}: ${tonDepositInvoice.createdAt ? new Date(tonDepositInvoice.createdAt).toLocaleString(ctx.lang === 'fa' ? 'fa-IR' : 'en-GB') : '—'}`
    await ctx.reply(text, { parse_mode: 'HTML' })
  }
}

type BroadcastDialogue = Extract<St, { s: 'admin_broadcast' }>

function audienceLabel(audience: 'users' | 'groups' | 'both'): string {
  return audience === 'users' ? 'کاربران' : audience === 'groups' ? 'گروه‌ها' : 'کاربران و گروه‌ها'
}

export function broadcastFilterLabel(filter?: IBroadcastUserFilter): string {
  if (!filter || filter.type === 'all') return 'همه کاربران واجد شرایط'
  if (filter.type === 'limit') return `اولین ${Number(filter.limit ?? 0).toLocaleString('en-US')} کاربر`
  if (filter.type === 'referrals') return `تعداد زیرمجموعه ${filter.operator === 'gt' ? '>' : '<'} ${filter.amount}`
  const currency = filter.currency === 'IRT' ? 'تومان' : 'TON (گرام)'
  const amount = filter.currency ? formatAmount(Number(filter.amount ?? 0), filter.currency) : String(filter.amount ?? 0)
  const label = filter.type === 'balance' ? 'موجودی' : filter.type === 'deposits' ? 'جمع واریزها' : 'جمع برداشت‌ها'
  return `${label} ${currency} ${filter.operator === 'gt' ? '>' : '<'} ${amount}`
}

export async function advanceBroadcastAfterUserFilter(ctx: BotContext, dialogue: BroadcastDialogue): Promise<void> {
  if (dialogue.audience === 'both') {
    const counts = await getBroadcastCounts(dialogue.userFilter ?? { type: 'all' })
    const next: BroadcastDialogue = { ...dialogue, step: 'group_limit' }
    await setState(ctx.from!.id, next)
    await ctx.reply(
      `📊 <b>مخاطبان فعال کمپین</b>\n` +
      `👤 کاربران فعال و قابل ارسال با این فیلتر: <b>${counts.matchingUsers.toLocaleString('en-US')}</b>\n` +
      `👥 گروه‌های فعال: <b>${counts.activeGroups.toLocaleString('en-US')}</b>\n\n` +
      `چند گروه در این کمپین باشند؟ عدد <code>0</code> یعنی همه گروه‌های فعال.`,
      { parse_mode: 'HTML' },
    )
    return
  }
  await promptBroadcastMessage(ctx, dialogue)
}

export async function promptBroadcastMessage(ctx: BotContext, dialogue: BroadcastDialogue): Promise<void> {
  const filter = dialogue.userFilter ?? { type: 'all' as const }
  const counts = await getBroadcastCounts(filter)
  const targetUsers = dialogue.audience === 'groups' ? 0 : counts.matchingUsers
  const targetGroups = ['groups', 'both'].includes(dialogue.audience)
    ? Math.min(counts.activeGroups, dialogue.groupLimit && dialogue.groupLimit > 0 ? dialogue.groupLimit : counts.activeGroups)
    : 0
  if (!targetUsers && !targetGroups) {
    await clearState(ctx.from!.id)
    await ctx.reply('⚠️ با این تنظیمات هیچ کاربر یا گروه فعالی برای ارسال پیدا نشد. کمپین لغو شد.')
    return
  }
  await setState(ctx.from!.id, {
    ...dialogue,
    step: 'message',
    counts,
  })
  await ctx.reply(
    `📣 <b>آماده دریافت محتوای پیام انبوه</b>\n\n` +
      `👤 کاربران ثبت‌شده: <b>${counts.registeredUsers.toLocaleString('en-US')}</b>\n` +
      `👤 کاربران فعال و قابل ارسال: <b>${counts.eligibleUsers.toLocaleString('en-US')}</b>\n` +
      `🎯 کاربران انتخاب‌شده: <b>${targetUsers.toLocaleString('en-US')}</b>\n\n` +
      `👥 گروه‌های فعال: <b>${counts.activeGroups.toLocaleString('en-US')}</b>\n` +
      `🎯 گروه‌های انتخاب‌شده: <b>${targetGroups.toLocaleString('en-US')}</b>\n\n` +
      `مخاطب: <b>${audienceLabel(dialogue.audience)}</b>\n` +
      `${dialogue.audience !== 'groups' ? `فیلتر کاربران: <b>${broadcastFilterLabel(dialogue.userFilter)}</b>\n` : ''}\n` +
      `اکنون متن، عکس، ویدئو یا پیام موردنظر را همین‌جا برای ربات بفرست. بعد از نمایش خلاصه و تأیید نهایی، ارسال در Worker جداگانه شروع می‌شود.\n` +
      `برای لغو بنویس: <code>/cancel</code>`,
    { parse_mode: 'HTML' },
  )
}

function broadcastFilterPrompt(filter: 'balance' | 'referrals' | 'deposits' | 'withdrawals'): string {
  if (filter === 'referrals') return 'تعداد زیرمجموعه را به شکل <code>&gt; 5</code> یا <code>&lt; 10</code> وارد کن.'
  const subject = filter === 'balance' ? 'موجودی فعلی' : filter === 'deposits' ? 'مجموع واریزهای تأییدشده' : 'مجموع برداشت‌های پرداخت‌شده'
  return `${subject} را با واحد ارز مشخص کن؛ نمونه: <code>TON &gt; 10</code> یا <code>IRT &lt; 50000</code>. مبلغ TON با TON و تومان با IRT وارد شود.`
}

type BackupHistoryEntry = {
  id: string; createdAt: string; fileName: string; bytes: number; sha256: string
  durationMs: number; collectionFiles: number; dumpFiles: number; oplogIncluded: boolean
  telegramFileId: string; telegramMessageId: number; telegramChatId: number
  telegramParts?: Array<{ fileId: string; messageId: number; chatId: number; fileName: string; bytes: number }>
}

async function backupHistory(): Promise<BackupHistoryEntry[]> {
  try {
    const rows = await redis.lrange(BACKUP_HISTORY_KEY, 0, 4999)
    const parsed: BackupHistoryEntry[] = []
    for (const row of rows) {
      try {
        const item = JSON.parse(row) as BackupHistoryEntry
        if (item?.id && item.telegramFileId && item.fileName && Number.isFinite(item.bytes)) parsed.push(item)
      } catch { /* Ignore malformed history entries. */ }
    }
    return parsed
  } catch (error) {
    logError('backup_history_read_failed', error)
    return []
  }
}

async function backupWorkerIsOnline(): Promise<boolean> {
  const servers = await getServerTelemetry()
  const now = Date.now()
  return servers.some((server) => server.instances.some((instance) =>
    instance.service === 'backup-worker' && Number.isFinite(Date.parse(instance.sampledAt)) &&
    now - Date.parse(instance.sampledAt) >= -5000 && now - Date.parse(instance.sampledAt) <= 25000,
  ))
}

async function backupManagementView(lang: BotContext['lang']): Promise<{ text: string; keyboard: any }> {
  const online = await backupWorkerIsOnline().catch(() => false)
  let interval = Number(process.env.BACKUP_INTERVAL_MINUTES) || 15
  try {
    const raw = await redis.get(BACKUP_CONFIG_KEY)
    if (raw) {
      const cfg = JSON.parse(raw) as { intervalMinutes?: number }
      if (Number.isInteger(cfg.intervalMinutes) && Number(cfg.intervalMinutes) >= 1 && Number(cfg.intervalMinutes) <= 1440) interval = Number(cfg.intervalMinutes)
    }
  } catch (error) { logError('backup_interval_dashboard_read_failed', error) }
  const status = await getPersistedBackupStatus()
  const history = await backupHistory()
  const fa = lang === 'fa'
  const stateLabel = online ? (fa ? '🟢 آنلاین' : '🟢 Online') : (fa ? '🔴 آفلاین' : '🔴 Offline')
  const text = fa
    ? `🗄 <b>مدیریت بکاپ MongoDB</b>\n━━━━━━━━━━━━━━━━━━\n\n🖥 وضعیت Worker: <b>${stateLabel}</b>\n⏱ فاصلهٔ بکاپ: <b>${interval} دقیقه</b>\n📦 تعداد بکاپ‌های ثبت‌شده: <b>${history.length}</b>\n🕒 آخرین بکاپ موفق: <code>${status?.lastBackupAt ? htmlEscape(new Date(status.lastBackupAt).toLocaleString('fa-IR', { hour12: false })) : 'هنوز ثبت نشده'}</code>\n📄 آخرین فایل: <code>${htmlEscape(status?.lastBackupFileName || history[0]?.fileName || '—')}</code>\n📏 حجم آخرین فایل: <b>${status?.lastBackupBytes ? formatBytes(status.lastBackupBytes) : history[0]?.bytes ? formatBytes(history[0].bytes) : '—'}</b>\n📌 وضعیت آخرین اجرا: <b>${htmlEscape(status?.backupStatus || 'نامشخص')}</b>${status?.lastBackupError ? `\n⚠️ آخرین خطا: ${htmlEscape(status.lastBackupError.slice(0, 250))}` : ''}\n\nفایل ZIP مستقیماً در همین چت تلگرام ارسال می‌شود و داخل آن پوشهٔ BSON قابل‌بازیابی با <code>mongorestore</code> قرار دارد.`
    : `🗄 <b>MongoDB Backup Management</b>\n━━━━━━━━━━━━━━━━━━\n\n🖥 Worker status: <b>${stateLabel}</b>\n⏱ Backup interval: <b>${interval} minutes</b>\n📦 Saved backup count: <b>${history.length}</b>\n🕒 Last successful backup: <code>${status?.lastBackupAt ? htmlEscape(new Date(status.lastBackupAt).toLocaleString('en-GB')) : 'Not yet recorded'}</code>\n📄 Last file: <code>${htmlEscape(status?.lastBackupFileName || history[0]?.fileName || '—')}</code>\n📏 Last file size: <b>${status?.lastBackupBytes ? formatBytes(status.lastBackupBytes) : history[0]?.bytes ? formatBytes(history[0].bytes) : '—'}</b>\n📌 Last run: <b>${htmlEscape(status?.backupStatus || 'unknown')}</b>${status?.lastBackupError ? `\n⚠️ Last error: ${htmlEscape(status.lastBackupError.slice(0, 250))}` : ''}\n\nZIP files are sent directly to this Telegram chat and contain BSON dumps restorable with <code>mongorestore</code>.`
  const keyboard = {
    inline_keyboard: [
      [{ text: fa ? '⏱ تنظیم فاصله بکاپ' : '⏱ Set backup interval', callback_data: 'backup:interval:set', style: 'primary' }],
      [{ text: fa ? '📚 تاریخچه / دانلود بکاپ‌ها' : '📚 Backup history / download', callback_data: 'backup:history:0', style: 'primary' }],
      [{ text: fa ? '⚡ بکاپ‌گیری همین الان' : '⚡ Run backup now', callback_data: 'backup:now', style: 'success' }],
      [{ text: fa ? '🔄 تازه‌سازی وضعیت' : '🔄 Refresh status', callback_data: 'admin:backups', style: 'primary' }],
      [{ text: fa ? '⬅️ بازگشت به مدیریت ربات' : '⬅️ Back to admin', callback_data: 'admin:home', style: 'primary' }],
    ],
  }
  return { text, keyboard }
}

async function sendBackupHistoryPage(ctx: BotContext, requestedPage: number): Promise<void> {
  const fa = ctx.lang === 'fa'
  const rows = await backupHistory()
  const pageSize = 5
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize))
  const page = Math.max(0, Math.min(totalPages - 1, Math.floor(requestedPage) || 0))
  const slice = rows.slice(page * pageSize, page * pageSize + pageSize)
  const lines = slice.map((entry, index) => {
    const position = page * pageSize + index + 1
    const date = new Date(entry.createdAt).toLocaleString(fa ? 'fa-IR' : 'en-GB', { hour12: false })
    return `${position}. <b>${htmlEscape(entry.fileName)}</b>\n   🕒 <code>${htmlEscape(date)}</code> · 📦 <b>${formatBytes(entry.bytes)}</b> · 🧩 ${entry.collectionFiles} ${fa ? 'فایل BSON' : 'BSON files'}${(entry.telegramParts?.length ?? 1) > 1 ? ` · ${entry.telegramParts!.length} ${fa ? 'بخش تلگرام' : 'Telegram parts'}` : ''}\n   🔐 <code>${htmlEscape(entry.sha256.slice(0, 16))}…</code>`
  })
  const text = fa
    ? `📚 <b>تاریخچه بکاپ‌ها</b> · صفحه ${page + 1}/${totalPages}\n\n${lines.join('\n\n') || 'هنوز بکاپ موفقی ثبت نشده است.'}\n\nبرای دریافت دوبارهٔ هر فایل، دکمهٔ همان بکاپ را بزن.`
    : `📚 <b>Backup history</b> · page ${page + 1}/${totalPages}\n\n${lines.join('\n\n') || 'No successful backups have been recorded yet.'}\n\nTap a backup button to download it again.`
  const keyboard: any = { inline_keyboard: [] as any[][] }
  for (const entry of slice) keyboard.inline_keyboard.push([{ text: `📥 ${entry.fileName.slice(0, 35)}`, callback_data: `backup:dl:${entry.id}`, style: 'success' }])
  const nav: any[] = []
  if (page > 0) nav.push({ text: fa ? '⬅️ قبلی' : '⬅️ Previous', callback_data: `backup:history:${page - 1}`, style: 'primary' })
  if (page + 1 < totalPages) nav.push({ text: fa ? 'بعدی ➡️' : 'Next ➡️', callback_data: `backup:history:${page + 1}`, style: 'primary' })
  if (nav.length) keyboard.inline_keyboard.push(nav)
  keyboard.inline_keyboard.push([{ text: fa ? '⬅️ بازگشت به مدیریت بکاپ' : '⬅️ Backup management', callback_data: 'admin:backups', style: 'primary' }])
  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(async () => { await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard }) })
}

export function registerAdmin(): void {
  bot.callbackQuery('admin:backups', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {})
    if (!isOwner(ctx)) return void (await ctx.reply(ctx.lang === 'fa' ? '⛔ مدیریت بکاپ فقط برای مالک ربات است.' : '⛔ Backup management is owner-only.'))
    const view = await backupManagementView(ctx.lang)
    await ctx.editMessageText(view.text, { parse_mode: 'HTML', reply_markup: view.keyboard }).catch(async () => { await ctx.reply(view.text, { parse_mode: 'HTML', reply_markup: view.keyboard }) })
  })

  bot.callbackQuery('backup:interval:set', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {})
    if (!isOwner(ctx)) return void (await ctx.reply('⛔'))
    await setState(ctx.from.id, { s: 'admin_backup_interval' })
    await ctx.reply(ctx.lang === 'fa'
      ? '⏱ فاصلهٔ بکاپ را به دقیقه بفرست (عدد صحیح از ۱ تا ۱۴۴۰). نمونه: <code>15</code> یعنی هر ۱۵ دقیقه، <code>60</code> یعنی هر ساعت. برای لغو /cancel را بفرست.'
      : '⏱ Send the backup interval in minutes (integer from 1 to 1440). Example: <code>15</code> means every 15 minutes; <code>60</code> means hourly. Send /cancel to abort.', { parse_mode: 'HTML' })
  })

  bot.callbackQuery(/^backup:history:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {})
    if (!isOwner(ctx)) return void (await ctx.reply('⛔'))
    await sendBackupHistoryPage(ctx as BotContext, Number(ctx.match[1]))
  })

  bot.callbackQuery(/^backup:dl:([a-zA-Z0-9_-]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {})
    if (!isOwner(ctx)) return void (await ctx.reply('⛔'))
    const entry = (await backupHistory()).find((item) => item.id === ctx.match[1])
    if (!entry) return void (await ctx.reply(ctx.lang === 'fa' ? '⚠️ این بکاپ در تاریخچه پیدا نشد.' : '⚠️ Backup not found in history.'))
    try {
      const parts = entry.telegramParts?.length ? entry.telegramParts : [{ fileId: entry.telegramFileId, messageId: entry.telegramMessageId, chatId: entry.telegramChatId, fileName: entry.fileName, bytes: entry.bytes }]
      for (let index = 0; index < parts.length; index++) {
        const part = parts[index]!
        const caption = parts.length === 1
          ? `${entry.fileName}\n${ctx.lang === 'fa' ? 'زمان' : 'Created'}: ${entry.createdAt}\n${ctx.lang === 'fa' ? 'حجم' : 'Size'}: ${formatBytes(entry.bytes)}\nSHA-256: ${entry.sha256}`
          : `${entry.fileName} · ${ctx.lang === 'fa' ? 'بخش' : 'part'} ${index + 1}/${parts.length}\n${ctx.lang === 'fa' ? 'بعد از دانلود همه بخش‌ها، آن‌ها را به ترتیب به هم متصل و ZIP حاصل را استخراج کن.' : 'Download every part, concatenate them in order, then extract the resulting ZIP.'}\nSHA-256: ${entry.sha256}`
        await ctx.api.sendDocument(ctx.from.id, part.fileId, { caption } as any)
        if (parts.length > 1 && index + 1 < parts.length) await new Promise((resolve) => setTimeout(resolve, 1100))
      }
    } catch (error) {
      logError('backup_history_download_failed', error, { backupId: entry.id, ownerId: ctx.from.id })
      await ctx.reply(ctx.lang === 'fa' ? '❌ ارسال مجدد فایل با تلگرام ناموفق بود؛ ممکن است فایل حذف شده یا شناسهٔ آن نامعتبر باشد.' : '❌ Telegram could not resend this backup file; it may have been deleted or the file id is invalid.')
    }
  })

  bot.callbackQuery('backup:now', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {})
    if (!isOwner(ctx)) return void (await ctx.reply('⛔'))
    const online = await backupWorkerIsOnline().catch(() => false)
    if (!online) {
      return void (await ctx.reply(ctx.lang === 'fa'
        ? '🚨 ورکر بکاپ آفلاین است؛ درخواست اجرا ارسال نشد. ابتدا سرویس backup-worker را روشن و اتصال Redis را بررسی کن.'
        : '🚨 Backup worker is offline; no run request was sent. Start backup-worker and check its Redis connection first.'))
    }
    await redis.publish(BACKUP_COMMAND_CHANNEL, JSON.stringify({ action: 'run-now', requestedBy: ctx.from.id }))
    await ctx.reply(ctx.lang === 'fa' ? '⏳ درخواست بکاپ دستی به ورکر ارسال شد. پس از اتمام، فایل ZIP در همین چت ارسال می‌شود.' : '⏳ Manual backup request sent to the worker. The ZIP will be sent here when complete.')
  })
  const cmd = (name: string, ownerOnly: boolean, fn: (ctx: BotContext, args: string[]) => Promise<string | void>) =>
    bot.command(name, async (ctx) => {
      if (!isAdmin(ctx) || (ownerOnly && ctx.u?.role !== 'owner')) return
      try {
        const out = await fn(ctx, String(ctx.match ?? '').trim().split(/\s+/).filter(Boolean))
        if (out) await ctx.reply(out, { parse_mode: 'HTML' })
      } catch (e) {
        logError(`admin_${name}_failed`, e)
        await ctx.reply('⚠️ خطا در اجرای دستور.')
      }
    })

  cmd('admin', false, async () => `${await summary()}\n\nبرای پنل دکمه «مدیریت ربات» را از منوی اصلی بزن.`)

  cmd('bets', false, async (ctx, [cur, list]) => {
    if (!isCurrency(cur) || !list) return 'نمونه: /bets IRT 10000,20000,30000,50000'
    const nums = list.split(',').map((x) => parseAmount(x, cur))
    if (nums.some((n) => n === null) || nums.length < 1 || nums.length > 8) return '❌ فهرست نامعتبر (۱ تا ۸ عدد).'
    const bets = [...new Set(nums as number[])].sort((a, b) => a - b)
    await updateSettings(`bets.${cur}`, bets)
    await log(ctx.from!.id, 'bets', `${cur}=${bets.join(',')}`)
    return `✅ مبالغ ${cur}: ${bets.map((a) => formatAmount(a, cur)).join(' / ')}`
  })

  cmd('fee', false, async (ctx, [key, val]) => {
    if (!FEE_KEYS.includes(key as any) || !val) return 'نمونه: /fee win 10  (win|draw|winTimeout|drawTimeout)'
    const normalized = normalizeDigits(val.replace('%', ''))
    if (!/^\d{1,2}(?:\.\d{1,2})?$/.test(normalized)) return '❌ درصد نامعتبر.'
    const bp = Math.round(Number(normalized) * 100)
    if (bp < 0 || bp > 5000) return '❌ درصد باید بین ۰ و ۵۰ باشد.'
    await updateSettings(`fees.${key}`, bp)
    await log(ctx.from!.id, 'fee', `${key}=${bp}bp`)
    return `✅ کارمزد ${key}: ${pct(bp)} (فقط برای دوئل‌های جدید)`
  })

  cmd('limit', false, async (ctx, [kind, cur, val]) => {
    if (!['minDeposit', 'minWithdraw'].includes(kind ?? '') || !isCurrency(cur) || !val) return 'نمونه: /limit minDeposit IRT 20000'
    const n = parseAmount(val, cur)
    if (n === null) return '❌ مبلغ نامعتبر.'
    await updateSettings(`limits.${kind}.${cur}`, n)
    await log(ctx.from!.id, 'limit', `${kind}.${cur}=${n}`)
    return `✅ ${kind} ${cur}: ${formatAmount(n, cur)}`
  })

  cmd('set', false, async (ctx, [key, val]) => {
    const k = INT_KEYS[key ?? '']
    const normalized = val ? normalizeDigits(val) : ''
    if (!k || !normalized) return `نمونه: /set friendlyMatchSeconds 120\nکلیدها: ${Object.keys(INT_KEYS).join(' | ')}`
    const n = Number(normalized)
    if (!Number.isInteger(n) || n < k.min || n > k.max) return `❌ عدد باید بین ${k.min} و ${k.max} باشد.`
    await updateSettings(k.path, n)
    await log(ctx.from!.id, 'set', `${k.path}=${n}`)
    return `✅ ${key} = ${n}`
  })

  cmd('refreward', false, async (ctx, [val]) => {
    const n = val ? parseAmount(val, 'IRT') : null
    if (n === null) return 'نمونه: /refreward 5000'
    await updateSettings('referral.rewardIRT', n)
    await updateSettings('referral.reward.IRT', n)
    await log(ctx.from!.id, 'refreward', String(n))
    return `✅ پاداش زیرمجموعه: ${formatAmount(n, 'IRT')} تومان`
  })

  cmd('words', false, async (ctx, [op, ...rest]) => {
    const s = await getSettings()
    const word = rest.join(' ').trim()
    if (op === 'list') return s.bannedWords.length ? s.bannedWords.join('، ') : 'فهرست خالی است.'
    if ((op !== 'add' && op !== 'del') || !word) return 'نمونه: /words add کلمه | /words del کلمه | /words list'
    const set = new Set(s.bannedWords)
    if (op === 'add') set.add(word)
    else set.delete(word)
    await updateSettings('bannedWords', [...set])
    await log(ctx.from!.id, 'words', `${op} ${word}`)
    return `✅ انجام شد (${set.size} کلمه)`
  })

  cmd('credit', false, async (ctx, [id, cur, val]) => {
    if (!id || !isCurrency(cur) || !val) return 'نمونه: /credit 123456 IRT 50000  (کسر: -50000)'
    const neg = val.startsWith('-')
    const n = parseAmount(neg ? val.slice(1) : val, cur)
    if (!/^\d+$/.test(id) || n === null) return '❌ ورودی نامعتبر.'
    const ok = await adminAdjust(ctx.from!.id, Number(id), cur as Currency, neg ? -n : n)
    await log(ctx.from!.id, 'credit', `${id} ${cur} ${neg ? '-' : '+'}${n} ok=${ok}`)
    return ok ? `✅ ${neg ? 'کسر' : 'شارژ'} ${formatAmount(n, cur)} ${cur} برای ${id}` : '❌ کاربر وجود ندارد یا موجودی کافی نیست.'
  })

  cmd('role', true, async (ctx, [id, role]) => {
    if (!id || !/^\d+$/.test(id) || (role !== 'admin' && role !== 'user')) return 'نمونه: /role 123456 admin'
    const ok = await setRole(Number(id), role)
    await log(ctx.from!.id, 'role', `${id}=${role}`)
    return ok ? `✅ نقش ${id}: ${role}` : '❌ کاربر پیدا نشد.'
  })

  cmd('stats', false, async () => adminStatsText())

  bot.callbackQuery('admin:broadcast', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {})
    if (!isOwner(ctx)) return void (await ctx.reply('⛔ ارسال پیام انبوه فقط برای مالک فعال است.'))
    const workerHeartbeat = await isBroadcastWorkerReady()
    if (!workerHeartbeat) return void (await ctx.reply('⚠️ ورکر پیام انبوه در حال اجرا نیست. ابتدا سرویس <code>broadcast-worker</code> را روی یکی از سرورها اجرا کن؛ تا آن زمان امکان تنظیم یا ثبت کمپین وجود ندارد.', { parse_mode: 'HTML' }))
    const counts = await getBroadcastCounts({ type: 'all' })
    await clearState(ctx.from!.id)
    await ctx.reply(
      `📣 <b>سامانه پیام انبوه</b>\n\n` +
      `👤 کل کاربران ثبت‌شده: <b>${counts.registeredUsers.toLocaleString('en-US')}</b>\n` +
      `👤 کاربران فعال و قابل ارسال (ربات را بلاک نکرده‌اند): <b>${counts.eligibleUsers.toLocaleString('en-US')}</b>\n` +
      `👥 گروه‌های فعالی که ربات آن‌ها را می‌شناسد: <b>${counts.activeGroups.toLocaleString('en-US')}</b>\n\n` +
      `مقصد کمپین را انتخاب کن. بعد از انتخاب مقصد، می‌توانی کاربران را با فیلتر یا تعداد مشخص محدود کنی. ارسال از Worker مستقل و با سرعت محدود انجام می‌شود تا پردازش بازی کند نشود.`,
      { parse_mode: 'HTML', reply_markup: broadcastAudienceKeyboard(ctx.lang) },
    )
  })

  bot.callbackQuery(/^bc:aud:(users|groups|both)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {})
    if (!isOwner(ctx)) return void (await ctx.reply('⛔ فقط مالک می‌تواند پیام انبوه بسازد.'))
    const audience = ctx.match[1] as 'users' | 'groups' | 'both'
    await ctx.editMessageReplyMarkup().catch(() => {})
    const counts = await getBroadcastCounts({ type: 'all' })
    if (audience === 'groups') {
      await setState(ctx.from!.id, { s: 'admin_broadcast', step: 'group_limit', audience })
      await ctx.reply(
        `📊 <b>گروه‌های فعال: ${counts.activeGroups.toLocaleString('en-US')}</b>\n` +
        `👤 کاربران فعال و قابل ارسال: <b>${counts.eligibleUsers.toLocaleString('en-US')}</b>\n\n` +
        `👥 چند گروه مقصد باشند؟ عدد <code>0</code> یعنی همه گروه‌های فعال.`,
        { parse_mode: 'HTML' },
      )
    } else {
      await setState(ctx.from!.id, { s: 'admin_broadcast', step: 'user_filter', audience })
      await ctx.reply(
        `📊 <b>کاربران فعال و قابل ارسال: ${counts.eligibleUsers.toLocaleString('en-US')}</b>\n` +
        `👥 گروه‌های فعال: <b>${counts.activeGroups.toLocaleString('en-US')}</b>\n\n` +
        `👤 مخاطبان کاربر را انتخاب کن:`,
        { parse_mode: 'HTML', reply_markup: broadcastUserFilterKeyboard(ctx.lang) },
      )
    }
  })

  bot.callbackQuery(/^bc:uf:(all|limit|balance|referrals|deposits|withdrawals)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {})
    if (!isOwner(ctx)) return void (await ctx.reply('⛔ فقط مالک می‌تواند پیام انبوه بسازد.'))
    const st = await getState(ctx.from!.id)
    if (!st || st.s !== 'admin_broadcast' || st.step !== 'user_filter') return void (await ctx.reply('⌛ مرحله تنظیم مخاطب منقضی شده؛ از پنل پیام انبوه دوباره شروع کن.'))
    const choice = ctx.match[1]
    await ctx.editMessageReplyMarkup().catch(() => {})
    if (choice === 'all') return void (await advanceBroadcastAfterUserFilter(ctx, { ...st, userFilter: { type: 'all' } }))
    if (choice === 'limit') {
      await setState(ctx.from!.id, { ...st, step: 'user_limit' })
      return void (await ctx.reply('🔢 تعداد کاربران هدف را وارد کن (از ۱ تا ۲۰۰۰۰۰). ترتیب انتخاب بر اساس قدیمی‌تر بودن حساب است.'))
    }
    const pendingFilter = choice as 'balance' | 'referrals' | 'deposits' | 'withdrawals'
    await setState(ctx.from!.id, { ...st, step: 'user_condition', pendingFilter })
    await ctx.reply(broadcastFilterPrompt(pendingFilter), { parse_mode: 'HTML' })
  })

  bot.callbackQuery('bc:confirm', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {})
    if (!isOwner(ctx)) return void (await ctx.reply('⛔ فقط مالک می‌تواند کمپین را آغاز کند.'))
    const workerHeartbeat = await isBroadcastWorkerReady()
    if (!workerHeartbeat) return void (await ctx.reply('⚠️ ورکر پیام انبوه دیگر فعال نیست. کمپین ثبت نشد. سرویس <code>broadcast-worker</code> را اجرا کن و سپس از ابتدا اقدام کن.', { parse_mode: 'HTML' }))
    const st = await getState(ctx.from!.id)
    if (!st || st.s !== 'admin_broadcast_confirm') return void (await ctx.reply('⌛ تأیید کمپین منقضی شده؛ از ابتدا تنظیم کن.'))
    const id = randomUUID()
    try {
      await BroadcastCampaign.create({
        _id: id,
        ownerId: ctx.from!.id,
        sourceChatId: st.sourceChatId,
        sourceMessageId: st.sourceMessageId,
        audience: st.audience,
        userFilter: st.userFilter,
        groupLimit: st.groupLimit,
        totalUsers: st.totalUsers,
        totalGroups: st.totalGroups,
        estimatedUsers: st.targetUsers,
        estimatedGroups: st.targetGroups,
        status: 'queued',
        sentUsers: 0,
        failedUsers: 0,
        sentGroups: 0,
        failedGroups: 0,
        processedUsers: 0,
        processedGroups: 0,
      })
      await enqueueBroadcastCampaign(id)
    } catch (error) {
      await BroadcastCampaign.updateOne({ _id: id }, { $set: { status: 'failed', lastError: String((error as any)?.message ?? error).slice(0, 1000), finishedAt: new Date() } }).catch(() => undefined)
      logError('broadcast_enqueue_failed', error, { campaignId: id, ownerId: ctx.from!.id })
      return void (await ctx.reply('❌ ثبت کمپین در صف ارسال ناموفق بود. Worker/Redis را بررسی کن؛ هیچ ارسالی شروع نشده است.'))
    }
    await clearState(ctx.from!.id)
    await ctx.editMessageReplyMarkup().catch(() => {})
    await log(ctx.from!.id, 'broadcast_created', `campaign=${id}|audience=${st.audience}|users=${st.targetUsers}|groups=${st.targetGroups}`)
    await ctx.reply(
      `✅ <b>کمپین در صف قرار گرفت.</b>\nشناسه: <code>${id}</code>\n\n` +
      `👤 کاربران هدف: <b>${st.targetUsers.toLocaleString('en-US')}</b>\n` +
      `👥 گروه‌های هدف: <b>${st.targetGroups.toLocaleString('en-US')}</b>\n` +
      `📦 مجموع گیرندگان: <b>${(st.targetUsers + st.targetGroups).toLocaleString('en-US')}</b>\n\n` +
      `ارسال در فرایند جداگانه و به‌صورت کنترل‌شده انجام می‌شود. پس از پایان، گزارش تعداد موفق/ناموفق برایت ارسال می‌شود.`,
      { parse_mode: 'HTML' },
    )
  })

  bot.callbackQuery('bc:cancel', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {})
    if (!isOwner(ctx)) return
    await clearState(ctx.from!.id)
    await ctx.editMessageReplyMarkup().catch(() => {})
    await ctx.reply('✅ تنظیم پیام انبوه لغو شد؛ هیچ کمپینی ارسال نمی‌شود.')
  })

  bot.callbackQuery(/^admin:servers:p:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {})
    if (!isOwner(ctx)) return void (await ctx.reply('⛔ داشبورد سرورها فقط برای مالک ربات قابل مشاهده است.'))
    const result = await serverStatusText(Number(ctx.match[1]))
    const keyboard = new InlineKeyboard()
    if (result.page > 0) keyboard.text('⬅️ قبلی', `admin:servers:p:${result.page - 1}`)
    keyboard.text('🔄 تازه‌سازی', `admin:servers:p:${result.page}`)
    if (result.page + 1 < result.totalPages) keyboard.text('بعدی ➡️', `admin:servers:p:${result.page + 1}`)
    keyboard.row().text('⬅️ بازگشت به مدیریت', 'admin:home')
    await ctx.editMessageText(result.text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(async () => { await ctx.reply(result.text, { parse_mode: 'HTML', reply_markup: keyboard }) })
  })

  bot.callbackQuery(/^admin:(home|settings|stats|commands|homeUser|channels|invoices|withdrawals|servers)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {})
    if (!isAdmin(ctx)) return void (await ctx.reply('⛔ این بخش فقط برای مدیران ربات است.'))
    const action = ctx.match[1]
    if (action === 'servers') {
      if (!isOwner(ctx)) return void (await ctx.reply('⛔ داشبورد سرورها فقط برای مالک ربات قابل مشاهده است.'))
      const loading = await ctx.reply('🛰 <b>در حال اتصال به سرورها...</b>\n\n◴ جمع‌آوری وضعیت CPU، RAM و دیسک\n<code>▰▱▱▱▱▱▱▱▱▱</code>', { parse_mode: 'HTML' })
      const frames = [
        '◷ جمع‌آوری وضعیت CPU، RAM و دیسک\n<code>▰▰▰▱▱▱▱▱▱▱</code>',
        '◶ جمع‌آوری وضعیت CPU، RAM و دیسک\n<code>▰▰▰▰▰▰▱▱▱▱</code>',
        '◵ آماده‌سازی داشبورد\n<code>▰▰▰▰▰▰▰▰▱▱</code>',
      ]
      for (const frame of frames) {
        await new Promise((resolve) => setTimeout(resolve, 220))
        await ctx.api.editMessageText(ctx.chat!.id, loading.message_id, `🛰 <b>در حال بررسی سرورها...</b>\n\n${frame}`, { parse_mode: 'HTML' }).catch(() => undefined)
      }
      const status = await serverStatusText(0)
      const keyboard = new InlineKeyboard().text(ctx.lang === 'fa' ? '🔄 تازه‌سازی' : '🔄 Refresh', 'admin:servers')
      if (status.totalPages > 1) keyboard.text(ctx.lang === 'fa' ? 'بعدی ➡️' : 'Next ➡️', 'admin:servers:p:1')
      keyboard.row().text(ctx.lang === 'fa' ? '⬅️ بازگشت به مدیریت' : '⬅️ Back to admin', 'admin:home')
      await ctx.api.editMessageText(ctx.chat!.id, loading.message_id, status.text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(async () => { await ctx.reply(status.text, { parse_mode: 'HTML', reply_markup: keyboard }) })
      return
    }
    if (action === 'invoices') {
      await setState(ctx.from.id, { s: 'admin_invoice_search' })
      await ctx.reply(t(ctx.lang, 'admin.invoice_prompt'), { parse_mode: 'HTML' })
      return
    }
    if (action === 'withdrawals') {
      if (!isOwner(ctx)) return void (await ctx.reply('⛔ فاکتورهای برداشت فقط برای مالک قابل مشاهده هستند.'))
      await showWithdrawalList(ctx, 0, true)
      return
    }
    if (action === 'homeUser') {
      await clearState(ctx.from.id)
      await ctx.reply('منوی اصلی 👇', { reply_markup: mainKeyboard(ctx.lang, true) })
      return
    }
    const cfg = await getSettings()
    const channelText = `<b>🔐 مدیریت عضویت اجباری گروه و کانال</b>\nوضعیت: ${cfg.membership.enabled ? '✅ روشن' : '⛔ خاموش'}\nتعداد مقصدها: ${cfg.membership.channels.length}\n\n<b>۱) گروه یا کانال عمومی</b>\nربات را به مقصد اضافه و ادمین کن؛ سپس فقط شناسهٔ عمومی مانند <code>@my_channel</code> یا <code>@my_group</code> را بفرست. لینک عمومی به‌صورت خودکار ساخته می‌شود.\n\n<b>۲) گروه یا کانال خصوصی</b>\nابتدا ربات را به مقصد خصوصی اضافه و ادمین کن. سپس شناسهٔ عددی مقصد که معمولاً با <code>-100</code> شروع می‌شود و لینک دعوت را با | جدا کن؛ نمونه:\n<code>-1001234567890 | https://t.me/+InviteCode</code>\nبرای به‌دست‌آوردن شناسهٔ خصوصی می‌توانی از یک ربات نمایش شناسهٔ چت در همان گروه یا از پیام فورواردشدهٔ آن مقصد استفاده کنی. لینک دعوت باید معتبر و فعال باشد.\n\n<b>نکتهٔ مهم:</b> ربات باید در هر مقصد ادمین باشد تا بتواند عضویت کاربران را از Telegram دریافت و بررسی کند. کاربران عادی و مدیران ربات باید عضو تمام مقصدهای ثبت‌شده باشند؛ فقط مالک اصلی ربات از این محدودیت مستثناست. وضعیت عضویت در هر تعامل دوباره از تلگرام بررسی می‌شود.`
    const text = action === 'settings'
      ? `${await summary()}\n\nبرای تغییر هر مورد روی دکمه مربوط به آن بزن:`
      : action === 'stats'
        ? await adminStatsText()
        : action === 'commands'
          ? HELP
          : action === 'channels'
            ? channelText
            : '🛠 <b>مدیریت ربات</b>\nاز دکمه‌های زیر برای مشاهده آمار و تنظیم پارامترهای بازی استفاده کن.'
    const markup = action === 'settings'
      ? adminSettingsKeyboard(await getSettings())
      : action === 'channels'
        ? adminChannelsKeyboard(cfg.membership.channels)
        : adminMenuKeyboard(ctx.lang, isOwner(ctx))
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: markup }).catch(async () => {
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: markup })
    })
  })

  bot.callbackQuery(/^at:(duels|deposits|withdrawals|chat|membership)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {})
    if (!isAdmin(ctx)) return
    const key = ctx.match[1]
    const path: Record<string, string> = {
      duels: 'features.duelsEnabled',
      deposits: 'features.depositsEnabled',
      withdrawals: 'features.withdrawalsEnabled',
      chat: 'features.chatEnabled',
      membership: 'membership.enabled',
    }
    const cfg = await getSettings()
    const current = key === 'membership' ? cfg.membership.enabled : (cfg.features as any)[key === 'duels' ? 'duelsEnabled' : key === 'deposits' ? 'depositsEnabled' : key === 'withdrawals' ? 'withdrawalsEnabled' : 'chatEnabled']
    await updateSettings(path[key]!, !current)
    await log(ctx.from.id, 'feature_toggle', `${path[key]}=${!current}`)
    const fresh = await getSettings()
    const text = `${await summary()}\n\nبرای تغییر هر مورد روی دکمه مربوط به آن بزن:`
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: adminSettingsKeyboard(fresh) }).catch(async () => {
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: adminSettingsKeyboard(fresh) })
    })
  })

  bot.callbackQuery('admch:add', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {})
    if (!isAdmin(ctx)) return
    await setState(ctx.from.id, { s: 'admin_channel_add' })
    await ctx.reply('➕ مقصد عمومی: <code>@username</code>\nمقصد خصوصی: <code>-1001234567890 | https://t.me/+InviteCode</code>\nابتدا ربات را به مقصد اضافه و ادمین کن. برای بررسی عضویت کاربران، ربات باید در تمام مقصدها ادمین باقی بماند.\nبرای لغو: /cancel', { parse_mode: 'HTML' })
  })

  bot.callbackQuery(/^admch:del:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {})
    if (!isAdmin(ctx)) return
    const cfg = await getSettings()
    const index = Number(ctx.match[1])
    if (!Number.isInteger(index) || index < 0 || index >= cfg.membership.channels.length) {
      await ctx.reply('این کانال قبلاً حذف شده است.')
      return
    }
    const channels = cfg.membership.channels.filter((_, i) => i !== index)
    await updateSettings('membership.channels', channels)
    await log(ctx.from.id, 'required_channel_delete', cfg.membership.channels[index]!.chatId)
    const text = `<b>📢 مدیریت عضویت اجباری</b>\nمقصد حذف شد. تعداد کانال/گروه‌ها: ${channels.length}`
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: adminChannelsKeyboard(channels) }).catch(async () => {
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: adminChannelsKeyboard(channels) })
    })
  })

  bot.callbackQuery(/^as:([a-z]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {})
    if (!isAdmin(ctx)) return
    const key = ctx.match[1]
    if ((key === 'tonaddr' || key === 'grp') && !isOwner(ctx)) {
      await ctx.reply(key === 'grp' ? '⛔ تنظیم سهم فعال‌کننده گروه فقط برای مالک ربات مجاز است.' : '⛔ تغییر آدرس دریافت TON فقط برای مالک مجاز است.')
      return
    }
    const def = SETTING_INPUTS[key]
    if (!def) return void (await ctx.reply('تنظیم مورد نظر پیدا نشد.'))
    const current = settingCurrentValue(await getSettings(), key)
    await setState(ctx.from.id, { s: 'admin_setting', key })
    await ctx.reply(`✏️ مقدار جدید برای <b>${htmlEscape(def.label)}</b> را ارسال کن.\nمقدار فعلی: <code>${htmlEscape(current)}</code>\nبرای خروج /cancel را بفرست.`, { parse_mode: 'HTML' })
  })

  bot.callbackQuery(/^inv:(approve|reject):(\d{1,12})$/, async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.answerCallbackQuery({ text: t(ctx.lang, 'admin.not_allowed').replace(/<[^>]*>/g, ''), show_alert: true }).catch(() => {})
      return
    }
    const approve = ctx.match[1] === 'approve'
    const invoiceNumber = Number(ctx.match[2])
    const message = ctx.callbackQuery.message
    const ref = message && 'message_id' in message ? { chatId: message.chat.id, messageId: message.message_id } : undefined
    if (!approve) {
      await setState(ctx.from.id, { s: 'admin_deposit_reject_reason', invoiceNumber, ...(ref ?? {}) })
      await ctx.answerCallbackQuery().catch(() => {})
      await ctx.reply(t(ctx.lang, 'admin.deposit_rejection_reason_prompt'), { parse_mode: 'HTML' })
      return
    }
    await ctx.answerCallbackQuery().catch(() => {})
    await processManualDepositDecision(ctx, invoiceNumber, true, '', ref)
  })

  bot.callbackQuery(/^wdpage:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {})
    if (!isOwner(ctx)) return void (await ctx.reply('⛔ فاکتورهای برداشت فقط برای مالک قابل مشاهده هستند.'))
    await showWithdrawalList(ctx, Math.max(0, Number(ctx.match[1])), true)
  })

  bot.callbackQuery(/^wdi:([\w-]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {})
    if (!isOwner(ctx)) return void (await ctx.reply('⛔ فاکتورهای برداشت فقط برای مالک قابل مشاهده هستند.'))
    const w = await Withdrawal.findById(ctx.match[1]).lean()
    if (!w) return void (await ctx.reply(ctx.lang === 'fa' ? '❌ فاکتور برداشت پیدا نشد.' : '❌ Withdrawal invoice not found.'))
    const u = await User.findOne({ tgId: w.userId }).select('firstName username').lean()
    const status = w.status === 'pending' ? (ctx.lang === 'fa' ? '⏳ در انتظار بررسی' : '⏳ Pending') : w.status === 'paid' ? (ctx.lang === 'fa' ? '✅ تأیید/پرداخت‌شده' : '✅ Approved/paid') : (ctx.lang === 'fa' ? '❌ لغوشده و مبلغ برگشته' : '❌ Cancelled/refunded')
    const name = htmlEscape(u?.firstName ?? '—')
    const username = u?.username ? '@' + htmlEscape(u.username) : '—'
    const destinationLabel = w.currency === 'IRT' ? (ctx.lang === 'fa' ? 'شماره شبا' : 'IBAN') : (ctx.lang === 'fa' ? 'آدرس کیف پول' : 'Wallet address')
    const text = `${ctx.lang === 'fa' ? '📤 <b>جزئیات فاکتور برداشت</b>' : '📤 <b>Withdrawal invoice details</b>'}\n`+
      `━━━━━━━━━━━━━━━━━━\n`+
      `${ctx.lang === 'fa' ? 'کد فاکتور' : 'Invoice ID'}: <code>${htmlEscape(w._id)}</code>\n`+
      `${ctx.lang === 'fa' ? 'وضعیت' : 'Status'}: <b>${status}</b>\n`+
      `${ctx.lang === 'fa' ? 'نام کاربر' : 'User'}: <b>${name}</b> (${username})\n`+
      `${ctx.lang === 'fa' ? 'شناسه تلگرام' : 'Telegram ID'}: <code>${w.userId}</code>\n`+
      `${ctx.lang === 'fa' ? 'مبلغ کسرشده از موجودی' : 'Gross amount deducted'}: <b>${formatAmount(w.amount, w.currency)} ${curName(ctx.lang, w.currency)}</b>\n`+
      `${ctx.lang === 'fa' ? (w.currency === 'IRT' ? 'کارمزد ثابت بین‌بانکی' : 'کارمزد ثابت شبکه TON') : (w.currency === 'IRT' ? 'Fixed interbank fee' : 'Fixed TON network fee')}: <b>${formatAmount(w.fee ?? 0, w.currency)} ${curName(ctx.lang, w.currency)}</b>\n`+
      `${ctx.lang === 'fa' ? 'مبلغی که باید واریز شود' : 'Net amount to send'}: <b>${formatAmount(w.payoutAmount ?? (w.amount - (w.fee ?? 0)), w.currency)} ${curName(ctx.lang, w.currency)}</b>\n`+
      `${w.fullName ? `${ctx.lang === 'fa' ? 'نام و نام خانوادگی صاحب شبا' : 'IBAN account holder'}: <b>${htmlEscape(w.fullName)}</b>\n` : ''}`+
      `${w.bankName ? `${ctx.lang === 'fa' ? 'بانک تشخیص‌داده‌شده' : 'Detected bank'}: <b>${htmlEscape(w.bankName)}</b>\n` : ''}`+
      `${destinationLabel}: <code>${htmlEscape(w.dest)}</code>\n`+
      `${ctx.lang === 'fa' ? 'زمان ثبت' : 'Created'}: ${w.createdAt ? new Date(w.createdAt).toLocaleString(ctx.lang === 'fa' ? 'fa-IR' : 'en-GB') : '—'}\n`+
      `${ctx.lang === 'fa' ? 'راهنمای پرداخت' : 'Payment instructions'}: ${w.currency === 'IRT'
        ? (ctx.lang === 'fa' ? 'وارد همراه‌بانک شو و مبلغ خالص را به شبای مقصد واریز کن؛ سپس موفقیت انتقال را بررسی و پرداخت را تأیید کن.' : 'Use mobile banking to transfer the net amount to the destination IBAN, verify the transfer, then mark it paid.')
        : (ctx.lang === 'fa' ? 'در Tonkeeper کیف پول و شبکه TON را بررسی کن، مبلغ خالص را به آدرس مقصد ارسال کن و پس از نهایی‌شدن تراکنش پرداخت را تأیید کن.' : 'In Tonkeeper, verify the wallet and TON network, send the net amount to the destination address, then mark it paid after finalization.')}\n`+
      `${ctx.lang === 'fa' ? 'یادداشت' : 'Note'}: ${ctx.lang === 'fa' ? 'مبلغ هنگام ساخت فاکتور رزرو شده است؛ لغو باعث برگشت کل مبلغ رزروشده می‌شود.' : 'Funds are reserved at invoice creation; cancelling refunds the full reserved amount.'}`+
      `${w.reviewReason ? `\n${ctx.lang === 'fa' ? 'دلیل رد' : 'Rejection reason'}: <b>${htmlEscape(w.reviewReason)}</b>` : ''}`
    const markup = w.status === 'pending'
      ? { inline_keyboard: [[{ text: ctx.lang === 'fa' ? '✅ تأیید/پرداخت' : '✅ Approve/paid', callback_data: `wda:ok:${w._id}` }, { text: ctx.lang === 'fa' ? '❌ لغو و بازگشت مبلغ' : '❌ Cancel/refund', callback_data: `wda:no:${w._id}` }], [{ text: ctx.lang === 'fa' ? '⬅️ فاکتورهای برداشت' : '⬅️ Withdrawals', callback_data: 'wdpage:0' }]] }
      : { inline_keyboard: [[{ text: ctx.lang === 'fa' ? '⬅️ فاکتورهای برداشت' : '⬅️ Withdrawals', callback_data: 'wdpage:0' }]] }
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: markup }).catch(async () => { await ctx.reply(text, { parse_mode: 'HTML', reply_markup: markup }) })
  })
}

async function showWithdrawalList(ctx: BotContext, requestedPage: number, edit: boolean): Promise<void> {
  const pageSize = 8
  const total = await Withdrawal.countDocuments({ status: 'pending' })
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const page = Math.min(Math.max(0, requestedPage), pages - 1)
  const rows = await Withdrawal.find({ status: 'pending' }).sort({ createdAt: -1, _id: -1 }).skip(page * pageSize).limit(pageSize).lean()
  const keyboard: Array<Array<{ text: string; callback_data: string }>> = []
  for (const w of rows) {
    keyboard.push([{ text: `📄 #${w._id} · ${formatAmount(w.amount, w.currency)} ${curName(ctx.lang, w.currency)}`, callback_data: `wdi:${w._id}` }])
  }
  if (pages > 1) {
    const nav: Array<{ text: string; callback_data: string }> = []
    if (page > 0) nav.push({ text: ctx.lang === 'fa' ? '⬅️ قبلی' : '⬅️ Previous', callback_data: `wdpage:${page - 1}` })
    nav.push({ text: `${page + 1}/${pages}`, callback_data: `wdpage:${page}` })
    if (page + 1 < pages) nav.push({ text: ctx.lang === 'fa' ? 'بعدی ➡️' : 'Next ➡️', callback_data: `wdpage:${page + 1}` })
    keyboard.push(nav)
  }
  keyboard.push([{ text: ctx.lang === 'fa' ? '⬅️ بازگشت به مدیریت' : '⬅️ Back to admin', callback_data: 'admin:home' }])
  const text = total ? `${t(ctx.lang, 'admin.withdrawals_title')}\n\n${ctx.lang === 'fa' ? 'تعداد فاکتورهای منتظر:' : 'Pending invoices:'} <b>${total}</b>\n${ctx.lang === 'fa' ? 'صفحه' : 'Page'} ${page + 1}/${pages}` : t(ctx.lang, 'admin.withdrawals_empty')
  const markup = { inline_keyboard: keyboard }
  if (edit && ctx.callbackQuery?.message) await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: markup }).catch(async () => { await ctx.reply(text, { parse_mode: 'HTML', reply_markup: markup }) })
  else await ctx.reply(text, { parse_mode: 'HTML', reply_markup: markup })
}

/** Validate and persist a value entered from the inline admin settings panel. */
/** Withdrawal invoice notifications are delivered to exactly one owner destination, never broadcast
 * to all administrators. The unique pending->paid/rejected transition remains atomic as a second guard. */
export async function notifyAdminsWithdrawal(w: { id: string; userId: number; username?: string; currency: Currency; amount: number; fee: number; payoutAmount: number; dest: string; bankName?: string; fullName?: string }): Promise<void> {
  const id = await ownerId()
  if (!id) {
    logError('withdrawal_owner_not_configured', new Error('Set OWNER_IDS in .env; invoice was not broadcast to admins.'), { withdrawalId: w.id })
    return
  }
  const isToman = w.currency === 'IRT'
  const feeLabel = isToman ? 'کارمزد ثابت بین‌بانکی' : 'کارمزد ثابت شبکه TON'
  const paymentInstructions = isToman
    ? '🏦 <b>روش پرداخت تومان</b>\n۱. وارد همراه‌بانک حساب مبدأ شو.\n۲. مبلغ خالص بالا را به شماره شبای مقصد واریز کن و نام صاحب حساب را بررسی کن.\n۳. پس از اطمینان از ثبت موفق انتقال بانکی، دکمه «پرداخت شد» را بزن.'
    : '💎 <b>روش پرداخت TON (گرام)</b>\n۱. کیف پول مالک را در Tonkeeper باز کن و شبکهٔ درست TON را بررسی کن.\n۲. دقیقاً مبلغ خالص بالا را به آدرس مقصد ارسال کن. کارمزد شبکه کیف پول فرستنده جداگانه اعمال می‌شود؛ مقدار ارسالی به کاربر همان مبلغ خالص فاکتور است.\n۳. پس از اطمینان از نهایی‌شدن تراکنش، دکمه «پرداخت شد» را بزن.'
  const text = `💸 <b>فاکتور برداشت #${w.id}</b>\nکاربر: <code>${w.userId}</code> ${w.username ? '@' + htmlEscape(w.username) : ''}\nمبلغ کل رزروشده از موجودی: <b>${formatAmount(w.amount, w.currency)} ${curName('fa', w.currency)}</b>\n${feeLabel}: <b>${formatAmount(w.fee, w.currency)} ${curName('fa', w.currency)}</b>\n<b>مبلغ خالصی که باید به کاربر واریز شود: ${formatAmount(w.payoutAmount, w.currency)} ${curName('fa', w.currency)}</b>\n${w.fullName ? `نام صاحب حساب: <b>${htmlEscape(w.fullName)}</b>\n` : ''}${w.bankName ? `بانک: <b>${htmlEscape(w.bankName)}</b>\n` : ''}مقصد: <code>${htmlEscape(w.dest)}</code>\n\n${paymentInstructions}\n\n🔐 این اعلان فقط برای مالک ارسال شده است. سایر مدیران می‌توانند با کد پیگیری از بخش جستجوی فاکتور، وضعیت آن را مشاهده کنند؛ فقط مالک مجاز به تأیید پرداخت یا رد فاکتور است.`
  const reply_markup = {
    inline_keyboard: [[
      { text: '✅ پرداخت شد', callback_data: `wda:ok:${w.id}` },
      { text: '❌ رد و بازگشت مبلغ', callback_data: `wda:no:${w.id}` },
    ]],
  }
  await notify(id, text, { reply_markup })
}

export async function addRequiredChannel(adminId: number, input: string): Promise<string> {
  return saveRequiredChannel(adminId, input)
}
