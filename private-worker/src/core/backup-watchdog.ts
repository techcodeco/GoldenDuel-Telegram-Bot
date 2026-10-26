import crypto from 'node:crypto'
import type Redis from 'ioredis'
import { OWNER_IDS } from './config'
import { User } from './models'
import { logError, logger } from './logger'
import { BACKUP_WATCHDOG_LEASE_KEY, BACKUP_WATCHDOG_STATE_KEY, SERVER_TELEMETRY_PREFIX } from './telemetry'
import { bot } from './bot/instance'

const CHECK_MS = Math.max(5000, Number(process.env.BACKUP_WATCHDOG_CHECK_MS ?? 10000) || 10000)
const ONLINE_MAX_AGE_MS = Math.max(20000, Number(process.env.BACKUP_WATCHDOG_ONLINE_MAX_AGE_MS ?? 25000) || 25000)
const STARTUP_GRACE_MS = Math.max(30000, Number(process.env.BACKUP_WATCHDOG_STARTUP_GRACE_MS ?? 60000) || 60000)
const LEASE_MS = Math.max(CHECK_MS * 3, 20000)

type WatchState = {
  state: 'online' | 'down'
  changedAt: string
  lastSeenAt?: string
  /** Owner IDs that received the current outage notification. Failed deliveries are retried. */
  downNotifiedTo?: number[]
  /** Owner IDs that received the recovery notification for the current outage. */
  recoveryNotifiedTo?: number[]
}
type Owner = { id: number; lang: string }
type HealthTransition = 'online' | 'down'

async function getOwners(): Promise<Owner[]> {
  const map = new Map<number, Owner>()
  for (const id of OWNER_IDS) map.set(id, { id, lang: 'fa' })
  try {
    const dbOwners = await User.find({ role: 'owner' }).select('tgId lang').lean() as Array<{ tgId: unknown; lang?: string }>
    for (const row of dbOwners) {
      const id = Number(row.tgId)
      if (Number.isSafeInteger(id) && id > 0) map.set(id, { id, lang: row.lang === 'en' ? 'en' : 'fa' })
    }
  } catch (error) {
    logError('backup_watchdog_owner_lookup_failed', error)
  }
  return [...map.values()]
}

async function backupWorkerHeartbeat(redis: Redis): Promise<{ online: boolean; sampledAt?: string }> {
  let cursor = '0'
  const keys: string[] = []
  do {
    const [next, found] = await redis.scan(cursor, 'MATCH', `${SERVER_TELEMETRY_PREFIX}*`, 'COUNT', 200)
    cursor = next
    keys.push(...found)
  } while (cursor !== '0')
  if (!keys.length) return { online: false }
  for (const raw of await redis.mget(...keys)) {
    if (!raw) continue
    try {
      const item = JSON.parse(raw) as { service?: string; sampledAt?: string }
      if (item.service !== 'backup-worker' || !item.sampledAt) continue
      const age = Date.now() - Date.parse(item.sampledAt)
      if (Number.isFinite(age) && age >= -5000 && age <= ONLINE_MAX_AGE_MS) return { online: true, sampledAt: item.sampledAt }
    } catch { /* Ignore malformed or unrelated heartbeat records. */ }
  }
  return { online: false }
}

async function notifyOwner(owner: Owner, next: HealthTransition): Promise<boolean> {
  const down = next === 'down'
  const text = down
    ? owner.lang === 'en'
      ? '🚨 <b>Backup worker is offline</b>\n\nNo fresh heartbeat has been received from <code>backup-worker</code>. Please check its process, Redis/MongoDB connection, MongoDB Database Tools and logs, then restart it.'
      : '🚨 <b>ورکر بکاپ خاموش یا قطع شده است</b>\n\nاز <code>backup-worker</code> ضربان سلامت تازه‌ای دریافت نشده است. لطفاً وضعیت پردازش، اتصال Redis و MongoDB، نصب MongoDB Database Tools و لاگ‌ها را بررسی و در صورت نیاز ورکر را دوباره روشن کنید.'
    : owner.lang === 'en'
      ? '✅ <b>Backup worker is online again</b>\n\nA fresh heartbeat was received from <code>backup-worker</code>.'
      : '✅ <b>ورکر بکاپ دوباره آنلاین شد</b>\n\nضربان سلامت جدید از <code>backup-worker</code> دریافت شد.'
  try {
    await bot.api.sendMessage(owner.id, text, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: owner.lang === 'en' ? '🗄 Backup management' : '🗄 مدیریت بکاپ‌ها', callback_data: 'admin:backups', style: down ? 'danger' : 'primary' }]] },
    } as any)
    return true
  } catch (error) {
    // A failed owner's delivery is intentionally not marked as complete. The watchdog retries it.
    logError('backup_watchdog_notify_failed', error, { ownerId: owner.id, next })
    return false
  }
}

async function persistState(redis: Redis, state: WatchState): Promise<void> {
  await redis.set(BACKUP_WATCHDOG_STATE_KEY, JSON.stringify(state))
}

export async function startBackupWorkerWatchdog(redis: Redis): Promise<() => Promise<void>> {
  const token = crypto.randomUUID()
  let ownsLease = (await redis.set(BACKUP_WATCHDOG_LEASE_KEY, token, 'PX', LEASE_MS, 'NX')) === 'OK'
  let stopped = false
  const bootedAt = Date.now()
  let state: WatchState | null = null
  try {
    const raw = await redis.get(BACKUP_WATCHDOG_STATE_KEY)
    if (raw) state = JSON.parse(raw) as WatchState
  } catch (error) { logError('backup_watchdog_state_load_failed', error) }

  const check = async () => {
    if (stopped) return
    try {
      if (ownsLease) {
        const script = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end"
        ownsLease = Number(await redis.eval(script, 1, BACKUP_WATCHDOG_LEASE_KEY, token, LEASE_MS)) === 1
      } else {
        ownsLease = (await redis.set(BACKUP_WATCHDOG_LEASE_KEY, token, 'PX', LEASE_MS, 'NX')) === 'OK'
      }
      if (!ownsLease) return

      const heartbeat = await backupWorkerHeartbeat(redis)
      if (heartbeat.online) {
        if (state?.state === 'down') {
          const owners = await getOwners()
          const notified = new Set((state.downNotifiedTo ?? []).map(Number))
          const recovered = new Set((state.recoveryNotifiedTo ?? []).map(Number))

          // If the worker recovered before Telegram accepted the first outage alert, still deliver
          // the recorded outage alert and then its recovery notice rather than silently dropping it.
          for (const owner of owners) {
            if (notified.has(owner.id)) continue
            if (await notifyOwner(owner, 'down')) {
              notified.add(owner.id)
              state = { ...state, downNotifiedTo: [...notified] }
              await persistState(redis, state)
            }
          }
          for (const owner of owners) {
            if (!notified.has(owner.id) || recovered.has(owner.id)) continue
            if (await notifyOwner(owner, 'online')) {
              recovered.add(owner.id)
              state = { ...state, recoveryNotifiedTo: [...recovered] }
              await persistState(redis, state)
            }
          }

          const allOwnersAlerted = owners.length > 0 && owners.every((owner) => notified.has(owner.id))
          const allNotifiedOwnersRecovered = owners.length > 0 && owners.every((owner) => !notified.has(owner.id) || recovered.has(owner.id))
          if (allOwnersAlerted && allNotifiedOwnersRecovered) {
            state = { state: 'online', changedAt: new Date().toISOString(), lastSeenAt: heartbeat.sampledAt }
            await persistState(redis, state)
          } else {
            state = { ...state, downNotifiedTo: [...notified], recoveryNotifiedTo: [...recovered] }
            await persistState(redis, state)
          }
          return
        }
        state = {
          state: 'online',
          changedAt: state?.state === 'online' ? state.changedAt : new Date().toISOString(),
          lastSeenAt: heartbeat.sampledAt,
        }
        await persistState(redis, state)
        return
      }

      // Avoid alarming during deployment while the backup process is starting for the first time.
      if (!state && Date.now() - bootedAt < STARTUP_GRACE_MS) return
      if (!state || state.state !== 'down') {
        state = {
          state: 'down',
          changedAt: new Date().toISOString(),
          ...(state?.lastSeenAt ? { lastSeenAt: state.lastSeenAt } : {}),
          downNotifiedTo: [],
          recoveryNotifiedTo: [],
        }
        // Persist the down state before sending, so a private-worker restart does not forget an outage.
        await persistState(redis, state)
      }

      const notified = new Set((state.downNotifiedTo ?? []).map(Number))
      const owners = await getOwners()
      for (const owner of owners) {
        if (notified.has(owner.id)) continue
        if (await notifyOwner(owner, 'down')) {
          notified.add(owner.id)
          state = { ...state, downNotifiedTo: [...notified] }
          await persistState(redis, state)
        }
      }
      if (!owners.length) logger.error({ key: 'backup_watchdog_no_owner_recipients' }, 'backup_watchdog_no_owner_recipients')
    } catch (error) { logError('backup_watchdog_check_failed', error) }
  }

  const timer = setInterval(() => { void check() }, CHECK_MS)
  timer.unref()
  void check()
  logger.info({ checkMs: CHECK_MS, onlineMaxAgeMs: ONLINE_MAX_AGE_MS, startupGraceMs: STARTUP_GRACE_MS }, 'backup_worker_watchdog_started')

  return async () => {
    if (stopped) return
    stopped = true
    clearInterval(timer)
    if (ownsLease) {
      const script = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"
      await redis.eval(script, 1, BACKUP_WATCHDOG_LEASE_KEY, token).catch((error) => logError('backup_watchdog_lease_release_failed', error))
    }
  }
}
