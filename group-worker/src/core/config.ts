import 'dotenv/config'
import os from 'node:os'

function need(key: string): string {
  const value = process.env[key]
  if (!value) throw new Error(`Missing env variable: ${key}`)
  return value
}

export const TOKEN = need('BOT_TOKEN')
export const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379'
export const MONGO_URI = process.env.MONGO_URI ?? 'mongodb://127.0.0.1:27017/rps?replicaSet=rs0&directConnection=true'
export const STREAM = process.env.GROUP_UPDATES_STREAM ?? 'updates:groups'
export const GROUP = process.env.GROUP_CONSUMER_GROUP ?? 'group-workers'
export const CONSUMER = `${os.hostname()}-${process.pid}`

// Structured rotating logs (aligned with private-worker and bullMQ-worker).
export const LOG_DIR = process.env.LOG_DIR ?? './logs/group-worker'
export const LOG_MAX_SIZE = process.env.LOG_MAX_SIZE ?? '2m'
export const LOG_RETENTION_DAYS = Number(process.env.LOG_RETENTION_DAYS ?? 7)
export const LOG_THROTTLE_MS = Number(process.env.LOG_THROTTLE_MS ?? 1000)
