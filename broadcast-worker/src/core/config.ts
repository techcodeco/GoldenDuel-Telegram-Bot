import 'dotenv/config'
import os from 'node:os'

function need(key: string): string {
  const value = process.env[key]
  if (!value) throw new Error(`Missing env variable: ${key}`)
  return value
}

export const BOT_TOKEN = need('BOT_TOKEN')
export const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379'
export const MONGO_URI = process.env.MONGO_URI ?? 'mongodb://127.0.0.1:27017/rps?replicaSet=rs0&directConnection=true'
// Settings used only for consuming the timing/broadcast command streams.
export const CONSUMER = `${os.hostname()}-${process.pid}`
export const BATCH = Math.max(1, Number(process.env.BATCH ?? 100) || 100)
export const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY ?? 50) || 50)
export const BLOCK_MS = Math.max(250, Number(process.env.BLOCK_MS ?? 2000) || 2000)
export const CLAIM_IDLE_MS = 60_000
export const MAX_FAILS = 5

export const LOG_DIR = process.env.LOG_DIR ?? './logs'
export const LOG_MAX_SIZE = process.env.LOG_MAX_SIZE ?? '2m'
export const LOG_RETENTION_DAYS = Math.max(1, Number(process.env.LOG_RETENTION_DAYS ?? 7) || 7)
export const LOG_THROTTLE_MS = Math.max(0, Number(process.env.LOG_THROTTLE_MS ?? 1000) || 0)
