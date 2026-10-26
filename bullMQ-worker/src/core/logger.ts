import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import pino from 'pino'
import build from 'pino-roll'
import { LOG_DIR, LOG_MAX_SIZE, LOG_RETENTION_DAYS, LOG_THROTTLE_MS } from './config'

/** Error-only logging: pino + pino-roll (size + daily rotation), throttled, 7-day retention. */
mkdirSync(LOG_DIR, { recursive: true })

const stream = await build({
  file: join(LOG_DIR, 'worker'),
  extension: '.log',
  size: LOG_MAX_SIZE,
  frequency: 'daily',
  mkdir: true,
  limit: { count: 100 },
})

export const logger = pino(
  {
    level: 'error',
    base: { app: 'rps-pv-worker', pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    serializers: { err: pino.stdSerializers.err },
  },
  stream,
)

const seen = new Map<string, { t: number; n: number }>()

/** `key` must be a static string, never built from user input. */
export function logError(key: string, err: unknown, ctx?: Record<string, unknown>): void {
  const now = Date.now()
  const s = seen.get(key)
  if (s && now - s.t < LOG_THROTTLE_MS) {
    s.n++
    return
  }
  seen.set(key, { t: now, n: 0 })
  logger.error({ key, err, suppressed: s?.n || undefined, ...ctx }, key)
}

function cleanOldLogs(): void {
  const cutoff = Date.now() - LOG_RETENTION_DAYS * 86_400_000
  try {
    for (const name of readdirSync(LOG_DIR)) {
      const path = join(LOG_DIR, name)
      try {
        if (statSync(path).mtimeMs < cutoff) unlinkSync(path)
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

export function startLogJanitor(): void {
  cleanOldLogs()
  setInterval(cleanOldLogs, 3_600_000).unref()
}

export function flushLogs(): void {
  try {
    ;(stream as any).flushSync?.()
  } catch {
    /* nothing buffered */
  }
}

process.on('uncaughtException', (err) => {
  logger.fatal({ err, key: 'uncaught_exception' }, 'uncaught_exception')
  flushLogs()
  console.error('uncaughtException:', err)
  process.exit(1)
})
process.on('unhandledRejection', (reason) => logError('unhandled_rejection', reason))
