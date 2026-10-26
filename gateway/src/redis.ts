import Redis from 'ioredis'
import { REDIS_URL } from './config'
import { logError } from './logger'

export const redis = new Redis(REDIS_URL, {
  enableAutoPipelining: true, // concurrent XADDs are batched into one round trip automatically
  maxRetriesPerRequest: 2,
})

// ioredis emits this on every failed reconnect attempt → throttled in logError
redis.on('error', (err) => logError('redis_error', err))
