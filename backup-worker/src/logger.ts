import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import pino from 'pino'
import build from 'pino-roll'
import { LOG_DIR, LOG_LEVEL, LOG_MAX_SIZE, LOG_RETENTION_DAYS, LOG_THROTTLE_MS } from './config'

mkdirSync(LOG_DIR, { recursive: true })
const stream = await build({
  file: join(LOG_DIR, 'backup-worker'),
  extension: '.log',
  size: LOG_MAX_SIZE,
  frequency: 'daily',
  mkdir: true,
  limit: { count: 100 },
})

export const logger = pino({
  level: LOG_LEVEL,
  base: { app: 'rps-backup-worker', pid: process.pid },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { level: (label: string) => ({ level: label }) },
  serializers: { err: pino.stdSerializers.err },
}, stream)

const seen = new Map<string, { at: number; suppressed: number }>()
export function logError(key: string, err: unknown, context: Record<string, unknown> = {}): void {
  const now = Date.now()
  const prior = seen.get(key)
  if (LOG_THROTTLE_MS > 0 && prior && now - prior.at < LOG_THROTTLE_MS) {
    prior.suppressed++
    return
  }
  seen.set(key, { at: now, suppressed: 0 })
  logger.error({ key, err, suppressed: prior?.suppressed || undefined, ...context }, key)
}

function cleanOldLogs(): void {
  const cutoff = Date.now() - LOG_RETENTION_DAYS * 86_400_000
  try {
    for (const name of readdirSync(LOG_DIR)) {
      const path = join(LOG_DIR, name)
      try { if (statSync(path).isFile() && statSync(path).mtimeMs < cutoff) unlinkSync(path) } catch { /* concurrent rotation is harmless */ }
    }
  } catch (err) { logger.warn({ err, key: 'log_retention_cleanup_failed' }, 'log_retention_cleanup_failed') }
}

export function startLogJanitor(): NodeJS.Timeout {
  cleanOldLogs()
  const timer = setInterval(cleanOldLogs, 3_600_000)
  timer.unref()
  return timer
}

export function flushLogs(): void {
  try { (stream as any).flushSync?.() } catch { /* best effort */ }
}

process.on('uncaughtException', (err) => {
  logger.fatal({ err, key: 'uncaught_exception' }, 'uncaught_exception')
  flushLogs()
  process.exit(1)
})
process.on('unhandledRejection', (reason) => logError('unhandled_rejection', reason))
