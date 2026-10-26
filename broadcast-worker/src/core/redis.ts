import Redis from 'ioredis'
import { REDIS_URL } from './config'
import { logError } from './logger'

/** General purpose connection (auto-pipelined). */
export const redis = new Redis(REDIS_URL, { enableAutoPipelining: true, maxRetriesPerRequest: 2 })
/** Dedicated connection for the blocking XREADGROUP loop (must not be pipelined). */
export const redisBlock = new Redis(REDIS_URL, { maxRetriesPerRequest: null })
/** Dedicated subscriber connection. */
export const redisSub = new Redis(REDIS_URL, { maxRetriesPerRequest: null })

for (const [name, c] of [['redis', redis], ['redis_block', redisBlock], ['redis_sub', redisSub]] as const) {
  c.on('error', (err) => logError(`${name}_error`, err))
}
