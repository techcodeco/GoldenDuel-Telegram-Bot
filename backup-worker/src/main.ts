import 'dotenv/config'
import IORedis from 'ioredis'
import { BACKUP_COMMAND_CHANNEL, BACKUP_CONFIG_KEY, BACKUP_INTERVAL_MINUTES, LOG_DIR, MONITORING_NAMESPACE, REDIS_URL, SERVER_NAME, INSTANCE_NAME, BACKUP_HISTORY_KEY } from './config'
import { Bot } from 'grammy'
import { BOT_TOKEN, TELEGRAM_API_ROOT } from './config'
import { runBackup, readBackupIntervalMinutes } from './backup'
import { flushLogs, logger, logError, startLogJanitor } from './logger'
import { BACKUP_STATUS_KEY, startServerTelemetry, type BackupTelemetry } from './telemetry'
import type { BackupHistoryEntry } from './backup'

const redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null, connectTimeout: 10_000 })
const subscriber = redis.duplicate({ maxRetriesPerRequest: null })
const api = new Bot(BOT_TOKEN, { client: { apiRoot: TELEGRAM_API_ROOT } }).api
redis.on('error', (error) => logError('redis_connection_error', error))
subscriber.on('error', (error) => logError('redis_subscriber_error', error))

const status: BackupTelemetry = { backupStatus: 'starting', backupIntervalMinutes: BACKUP_INTERVAL_MINUTES }
function setStatus(next: Partial<BackupTelemetry>): void {
  Object.assign(status, next, { statusUpdatedAt: new Date().toISOString() })
  void redis.set(BACKUP_STATUS_KEY, JSON.stringify(status)).catch((error) => logError('backup_status_persist_failed', error))
}

async function main(): Promise<void> {
  const janitor = startLogJanitor()
  logger.info({ serverName: SERVER_NAME, instanceName: INSTANCE_NAME, monitoringNamespace: MONITORING_NAMESPACE, initialIntervalMinutes: BACKUP_INTERVAL_MINUTES, logDir: LOG_DIR }, 'backup_worker_starting')
  await redis.ping()
  await subscriber.ping()
  await api.getMe() // Fail fast on an invalid Telegram token before reporting this service as online.
  try {
    const saved = await redis.get(BACKUP_STATUS_KEY)
    if (saved) {
      const restored = JSON.parse(saved) as Partial<BackupTelemetry>
      if (restored && typeof restored === 'object') Object.assign(status, restored)
    }
  } catch (error) {
    logError('backup_status_restore_failed', error)
  }
  const intervalMinutes = await readBackupIntervalMinutes(redis)
  setStatus({ backupStatus: 'starting', backupIntervalMinutes: intervalMinutes })
  const stopTelemetry = await startServerTelemetry(redis, 'backup-worker', () => ({ ...status }))

  let runningBackup: Promise<BackupHistoryEntry | undefined> | undefined
  let scheduleTimer: NodeJS.Timeout | undefined
  let stopping = false

  const scheduleNext = async () => {
    if (stopping) return
    if (scheduleTimer) clearTimeout(scheduleTimer)
    const interval = await readBackupIntervalMinutes(redis)
    status.backupIntervalMinutes = interval
    setStatus({ backupIntervalMinutes: interval })
    scheduleTimer = setTimeout(() => { void cycle('scheduled') }, interval * 60_000)
    scheduleTimer.unref()
    logger.info({ intervalMinutes: interval }, 'next_backup_scheduled')
  }

  const cycle = async (source: 'startup' | 'scheduled' | 'manual'): Promise<BackupHistoryEntry | undefined> => {
    if (stopping) return undefined
    if (runningBackup) {
      logger.warn({ source, key: 'backup_overlap_avoided' }, 'backup_overlap_avoided')
      if (source === 'manual') return await runningBackup
      return undefined
    }
    if (scheduleTimer) clearTimeout(scheduleTimer)
    scheduleTimer = undefined
    runningBackup = (async () => await runBackup(redis, status, setStatus))().catch((error) => {
      setStatus({ backupStatus: 'error', lastBackupError: 'Backup cycle could not start; inspect backup-worker logs.' })
      logError('backup_cycle_escaped', error, { source })
      return undefined
    }).finally(() => { runningBackup = undefined })
    const result = await runningBackup
    if (!stopping) await scheduleNext()
    return result
  }

  await subscriber.subscribe(BACKUP_COMMAND_CHANNEL)
  subscriber.on('message', (channel, message) => {
    if (channel !== BACKUP_COMMAND_CHANNEL) return
    try {
      const command = JSON.parse(message) as { action?: string; requestedBy?: number }
      if (command.action === 'run-now') {
        void cycle('manual').then(async (entry) => {
          if (Number.isSafeInteger(command.requestedBy) && (command.requestedBy ?? 0) > 0) {
            const message = entry
              ? `✅ بکاپ دستی موفق بود. فایل <code>${entry.fileName}</code> در همین چت ارسال شد.`
              : '⚠️ اجرای بکاپ دستی موفق نبود یا در همین لحظه بکاپ دیگری در حال اجرا بود. وضعیت و لاگ‌های backup-worker را بررسی کن.'
            await api.sendMessage(command.requestedBy!, message, { parse_mode: 'HTML' }).catch((error) => logError('manual_backup_confirmation_failed', error))
          }
        })
      } else if (command.action === 'refresh-config') {
        void scheduleNext().catch((error) => logError('backup_schedule_refresh_failed', error))
      }
    } catch (error) {
      logError('backup_command_parse_failed', error)
    }
  })

  // The very first backup starts immediately; later runs use the live owner-configured interval.
  void cycle('startup')

  const shutdown = async (signal: string) => {
    if (stopping) return
    stopping = true
    if (scheduleTimer) clearTimeout(scheduleTimer)
    clearInterval(janitor)
    logger.info({ signal }, 'backup_worker_shutdown_started')
    await runningBackup?.catch((error) => logError('backup_shutdown_wait_failed', error))
    await stopTelemetry()
    await subscriber.quit().catch((error) => logError('redis_subscriber_quit_failed', error))
    await redis.quit().catch((error) => logError('redis_quit_failed', error))
    flushLogs()
    process.exit(0)
  }
  process.once('SIGINT', () => { void shutdown('SIGINT') })
  process.once('SIGTERM', () => { void shutdown('SIGTERM') })
  logger.info({ intervalMinutes, historyLimit: Number(process.env.BACKUP_HISTORY_LIMIT ?? 500), historyKey: BACKUP_HISTORY_KEY, configKey: BACKUP_CONFIG_KEY }, 'backup_worker_ready')
}

main().catch((error) => {
  logError('startup_failed', error)
  flushLogs()
  process.exit(1)
})
