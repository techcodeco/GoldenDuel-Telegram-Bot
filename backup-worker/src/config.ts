import 'dotenv/config'
import os from 'node:os'
import crypto from 'node:crypto'
import { hasDatabasePath, hasReplicaSetMarker } from './dump-args'

function need(key: string): string {
  const value = process.env[key]?.trim()
  if (!value) throw new Error(`Missing required environment variable: ${key}`)
  return value
}

function positiveInteger(key: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[key] ?? fallback)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max}`)
  }
  return parsed
}

export const MONGO_URI = need('MONGO_URI')
export const BOT_TOKEN = need('BOT_TOKEN')
export const OWNER_IDS = new Set((process.env.OWNER_IDS ?? '').split(',').map((v) => Number(v.trim())).filter((v) => Number.isSafeInteger(v) && v > 0))
if (!OWNER_IDS.size) throw new Error('OWNER_IDS must contain at least one Telegram owner user ID')
export const TELEGRAM_API_ROOT = process.env.TELEGRAM_API_ROOT?.trim() || 'https://api.telegram.org'
export const MONITORING_NAMESPACE = process.env.MONITORING_NAMESPACE?.trim() || BOT_TOKEN
export const REDIS_URL = process.env.REDIS_URL?.trim() || 'redis://127.0.0.1:6379'
const namespaceHash = crypto.createHash('sha256').update(MONITORING_NAMESPACE).digest('hex').slice(0, 12)
export const BACKUP_REDIS_PREFIX = `rps:${namespaceHash}:ops:backup-worker`
export const BACKUP_STATUS_KEY = `${BACKUP_REDIS_PREFIX}:status`
export const BACKUP_CONFIG_KEY = `${BACKUP_REDIS_PREFIX}:config`
export const BACKUP_HISTORY_KEY = `${BACKUP_REDIS_PREFIX}:history`
export const BACKUP_COMMAND_CHANNEL = `${BACKUP_REDIS_PREFIX}:commands`
export const BACKUP_FAILURE_ACTIVE_KEY = `${BACKUP_REDIS_PREFIX}:failure-alert-active`

const backupOplogRaw = process.env.BACKUP_OPLOG?.trim().toLowerCase()
if (backupOplogRaw && !['true', 'false'].includes(backupOplogRaw)) throw new Error('BACKUP_OPLOG must be true or false')
export const BACKUP_OPLOG = backupOplogRaw === 'true'
if (BACKUP_OPLOG) {
  let parsed: URL
  try { parsed = new URL(MONGO_URI) } catch { throw new Error('MONGO_URI is not a valid MongoDB URI') }
  if (!['mongodb:', 'mongodb+srv:'].includes(parsed.protocol.toLowerCase())) throw new Error('MONGO_URI must use mongodb:// or mongodb+srv://')
  if (hasDatabasePath(MONGO_URI)) throw new Error('BACKUP_OPLOG=true requires MONGO_URI without a database path; use a full replica-set URI and credentials with backup access')
  if (!hasReplicaSetMarker(MONGO_URI)) throw new Error('BACKUP_OPLOG=true requires replicaSet=<name> in the MongoDB URI, or the mongodb+srv:// scheme')
}

export const BACKUP_INTERVAL_MINUTES = positiveInteger('BACKUP_INTERVAL_MINUTES', 15, 1, 1440)
export const BACKUP_HISTORY_LIMIT = positiveInteger('BACKUP_HISTORY_LIMIT', 500, 10, 5000)
export const BACKUP_LOCK_TTL_SECONDS = positiveInteger('BACKUP_LOCK_TTL_SECONDS', 3600, 60, 86400)
export const BACKUP_TMP_DIR = process.env.BACKUP_TMP_DIR?.trim() || os.tmpdir()
export const MONGODUMP_BIN = process.env.MONGODUMP_BIN?.trim() || 'mongodump'
// Decimal MB and a 49 MB maximum leave a margin below Telegram's 50 MB cloud upload limit.
export const TELEGRAM_UPLOAD_MAX_BYTES = positiveInteger('TELEGRAM_UPLOAD_MAX_MB', 47, 1, 49) * 1_000_000
export const SERVER_NAME = (process.env.SERVER_NAME?.trim() || os.hostname()).slice(0, 80)
export const INSTANCE_NAME = (process.env.INSTANCE_NAME?.trim() || `backup-worker-${os.hostname()}-${process.pid}`).slice(0, 100)
export const SERVER_METRICS_INTERVAL_MS = Math.max(3000, Number(process.env.SERVER_METRICS_INTERVAL_MS ?? 5000) || 5000)
export const LOG_DIR = process.env.LOG_DIR?.trim() || './logs/backup-worker'
export const LOG_LEVEL = process.env.LOG_LEVEL?.trim() || 'info'
export const LOG_MAX_SIZE = process.env.LOG_MAX_SIZE?.trim() || '5m'
export const LOG_RETENTION_DAYS = positiveInteger('LOG_RETENTION_DAYS', 14, 1, 365)
export const LOG_THROTTLE_MS = positiveInteger('LOG_THROTTLE_MS', 1000, 0, 60000)
