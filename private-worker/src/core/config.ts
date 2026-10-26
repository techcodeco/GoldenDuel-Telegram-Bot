import { DEFAULT_GROUP_UPDATES_STREAM, DEFAULT_PRIVATE_UPDATES_STREAM } from './contracts/updates'
import 'dotenv/config'
import os from 'node:os'

function need(key: string): string {
  const v = process.env[key]
  if (!v) throw new Error(`Missing env variable: ${key}`)
  return v
}
const num = (key: string, def: number) => Number(process.env[key] ?? def)

export const BOT_TOKEN = need('BOT_TOKEN')
export const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379'
// TON network. Fail-safe default is MAINNET so a forgotten env var can never silently route real users to testnet.
// Testnet is used when TON_NETWORK=testnet, or when NODE_ENV=development (the `dev` script).
export type TonNetwork = 'mainnet' | 'testnet'
function resolveTonNetwork(): TonNetwork {
  const explicit = (process.env.TON_NETWORK ?? '').trim().toLowerCase()
  if (explicit === 'mainnet' || explicit === 'testnet') return explicit
  if (explicit) throw new Error(`Invalid TON_NETWORK: ${explicit} (use mainnet or testnet)`)
  return process.env.NODE_ENV === 'development' ? 'testnet' : 'mainnet'
}
export const TON_NETWORK: TonNetwork = resolveTonNetwork()
export const IS_TON_TESTNET = TON_NETWORK === 'testnet'
const DEFAULT_TONCENTER_URL = IS_TON_TESTNET ? 'https://testnet.toncenter.com/api/v3' : 'https://toncenter.com/api/v3'
function resolveTonCenterApiUrl(): string {
  const raw = (process.env.TONCENTER_API_URL?.trim() || DEFAULT_TONCENTER_URL).replace(/\/$/, '')
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`Invalid TONCENTER_API_URL: ${raw}`)
  }
  if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
    throw new Error('TONCENTER_API_URL must use HTTPS (except local development endpoints)')
  }
  // Keep old deployments working: normalize a previous v2 base URL to API v3.
  const path = parsed.pathname.replace(/\/$/, '')
  if (path.endsWith('/api/v2')) {
    parsed.pathname = path.replace(/\/api\/v2$/, '/api/v3')
  } else if (path.endsWith('/api/v3')) {
    parsed.pathname = path
  } else if (path === '' || path === '/') {
    parsed.pathname = '/api/v3'
  } else {
    throw new Error(`TONCENTER_API_URL must point to the API v3 base path (/api/v3): ${parsed.toString()}`)
  }
  parsed.pathname = parsed.pathname.replace(/\/$/, '')
  if (!parsed.pathname.endsWith('/api/v3')) {
    throw new Error(`TONCENTER_API_URL must point to the API v3 base path (/api/v3): ${parsed.toString()}`)
  }
  if (parsed.search || parsed.hash) throw new Error('TONCENTER_API_URL must not contain query parameters or a fragment')
  // Prevent accidental use of the opposite public network endpoint.
  if (IS_TON_TESTNET !== parsed.hostname.toLowerCase().includes('testnet.')) {
    throw new Error(`TON_NETWORK=${TON_NETWORK} does not match TONCENTER_API_URL=${parsed.toString()}`)
  }
  return `${parsed.origin}${parsed.pathname}`
}
export const TONCENTER_API_URL = resolveTonCenterApiUrl()
export const TONCENTER_API_KEY = (
  (IS_TON_TESTNET ? process.env.TONCENTER_API_KEY_TESTNET : process.env.TONCENTER_API_KEY_MAINNET)?.trim() ||
  process.env.TONCENTER_API_KEY?.trim() ||
  ''
)
export const MONGO_URI =
  process.env.MONGO_URI ?? 'mongodb://127.0.0.1:27017/rps?replicaSet=rs0&directConnection=true'
export const OWNER_IDS = new Set(
  (process.env.OWNER_IDS ?? '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0),
)

// Redis Streams written by the single Telegram Gateway. Group updates are duplicated to
// a separate stream so a future group-game worker never competes with private-chat consumers.
export const STREAM = process.env.PRIVATE_UPDATES_STREAM ?? DEFAULT_PRIVATE_UPDATES_STREAM
export const GROUP_STREAM = process.env.GROUP_UPDATES_STREAM ?? DEFAULT_GROUP_UPDATES_STREAM
export const GROUP = 'pv-workers'
export const DEAD_STREAM = 'updates:private:dead'
export const CONSUMER = `${os.hostname()}-${process.pid}`
export const BATCH = num('BATCH', 100)
export const CONCURRENCY = num('CONCURRENCY', 50)
export const BLOCK_MS = num('BLOCK_MS', 2000)
export const CLAIM_IDLE_MS = 60_000
export const MAX_FAILS = 5

// Logging (errors only)
export const LOG_DIR = process.env.LOG_DIR ?? './logs'
export const LOG_MAX_SIZE = process.env.LOG_MAX_SIZE ?? '2m'
export const LOG_RETENTION_DAYS = num('LOG_RETENTION_DAYS', 7)
export const LOG_THROTTLE_MS = num('LOG_THROTTLE_MS', 1000)

// Deposits confirmed by your payment service are pushed to this stream (see README)
export const STREAM_PAYMENTS = 'payments:paid'
export const GROUP_PAYMENTS = 'pay-workers'
export const DEAD_PAYMENTS = 'payments:paid:dead'
