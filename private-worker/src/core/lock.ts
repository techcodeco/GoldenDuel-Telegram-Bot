import { randomUUID } from 'node:crypto'
import { redis } from './redis'
import { sleep } from './util'

/** Updates of one user are handled strictly one after another (in this process and across workers). */
const chains = new Map<number, Promise<unknown>>()
const UNLOCK = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`
const RENEW = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end return 0`
const LOCK_TTL_MS = 30_000
const LOCK_RENEW_MS = 10_000

async function redisLock<T>(userId: number, fn: () => Promise<T>): Promise<T> {
  const key = `lock:u:${userId}`
  const token = randomUUID()
  const giveUp = Date.now() + 20_000
  while (!(await redis.set(key, token, 'PX', 30_000, 'NX'))) {
    if (Date.now() > giveUp) throw new Error(`user lock timeout ${userId}`)
    await sleep(20)
  }
  const renewal = setInterval(() => {
    void redis.eval(RENEW, 1, key, token, LOCK_TTL_MS).catch(() => {
      // Best-effort renewal: handler errors still propagate normally; never convert a
      // successful side effect into a retry solely because one heartbeat was transiently lost.
    })
  }, LOCK_RENEW_MS)
  renewal.unref?.()
  try {
    return await fn()
  } finally {
    clearInterval(renewal)
    await redis.eval(UNLOCK, 1, key, token).catch(() => {})
  }
}

export function withUserLock<T>(userId: number, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(userId) ?? Promise.resolve()
  const next = prev.catch(() => {}).then(() => redisLock(userId, fn))
  chains.set(userId, next)
  void next
    .finally(() => {
      if (chains.get(userId) === next) chains.delete(userId)
    })
    .catch(() => {})
  return next
}
