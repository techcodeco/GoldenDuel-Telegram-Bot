import { BATCH, BLOCK_MS, CLAIM_IDLE_MS, CONCURRENCY, CONSUMER, MAX_FAILS } from './config'
import { logError } from './logger'
import { redis, redisBlock } from './redis'
import { pool, sleep } from './util'

export interface ConsumerOpts {
  stream: string
  group: string
  dead: string
  handle: (fields: Record<string, string>) => Promise<void>
}

type Entry = [string, string[] | null]
const toObj = (arr: string[]): Record<string, string> => {
  const o: Record<string, string> = {}
  for (let i = 0; i + 1 < arr.length; i += 2) o[arr[i]!] = arr[i + 1]!
  return o
}

/**
 * Redis Streams consumer group:
 *  - XREADGROUP in batches, handled in parallel (bounded), XACK only after success
 *  - XAUTOCLAIM re-delivers entries of crashed workers
 *  - after MAX_FAILS failures an entry goes to the dead-letter stream (nothing loops forever)
 */
export async function startConsumer(o: ConsumerOpts): Promise<() => Promise<void>> {
  const r = redis as any
  const rb = redisBlock as any
  try {
    await r.xgroup('CREATE', o.stream, o.group, '0', 'MKSTREAM')
  } catch (e: any) {
    if (!String(e?.message).includes('BUSYGROUP')) throw e
  }

  let running = true
  const ack = (id: string) => r.xack(o.stream, o.group, id)
  // Redis < 6.2 has no XAUTOCLAIM. Remember that fact so we do not spam the log
  // every 15 seconds; recover abandoned messages with XPENDING + XCLAIM instead.
  let autoClaimSupported: boolean | null = null

  async function reclaimLegacy(): Promise<void> {
    const pending = await r.xpending(o.stream, o.group, '-', '+', 100) as Array<[string, string, number, number]>
    const ids = pending
      .filter((row) => Number(row[2]) >= CLAIM_IDLE_MS)
      .map((row) => row[0] as string)
    if (!ids.length) return
    const claimed = await r.xclaim(o.stream, o.group, CONSUMER, CLAIM_IDLE_MS, ...ids) as Entry[]
    if (claimed?.length) await processEntries(claimed)
  }

  async function processEntries(entries: Entry[]): Promise<void> {
    await pool(entries, CONCURRENCY, async ([id, arr]) => {
      if (!arr) {
        // MAXLEN can trim an entry that was pending during a long outage. Preserve an
        // operational breadcrumb before acknowledging the now-unrecoverable entry.
        await r.xadd(o.dead, 'MAXLEN', '~', 10_000, '*', 'id', id, 'source_stream', o.stream, 'error', 'source_entry_trimmed')
        await ack(id)
        logError('consumer_entry_trimmed', new Error('pending stream entry was trimmed before processing'), { stream: o.stream, id })
        return
      }
      const fields = toObj(arr)
      try {
        await o.handle(fields)
        await ack(id)
      } catch (err) {
        const k = `fail:${o.stream}:${id}`
        const n = await redis.incr(k)
        if (n === 1) await redis.expire(k, 86_400)
        logError(`consumer_${o.stream}_failed`, err, { id, attempts: n })
        if (n >= MAX_FAILS) {
          await r.xadd(o.dead, 'MAXLEN', '~', 10_000, '*', 'id', id, 'error', String(err).slice(0, 500), ...arr)
          await ack(id)
        }
      }
    })
  }

  const loop = (async () => {
    while (running) {
      try {
        const res = await rb.xreadgroup('GROUP', o.group, CONSUMER, 'COUNT', BATCH, 'BLOCK', BLOCK_MS, 'STREAMS', o.stream, '>')
        if (res) await processEntries(res[0][1] as Entry[])
      } catch (e) {
        if (!running) break
        logError('xreadgroup_failed', e)
        await sleep(1000)
      }
    }
  })()

  const reclaim = setInterval(async () => {
    try {
      if (autoClaimSupported === false) {
        await reclaimLegacy()
        return
      }
      let cursor = '0-0'
      for (let i = 0; i < 5; i++) {
        try {
          const [next, entries] = await r.xautoclaim(o.stream, o.group, CONSUMER, CLAIM_IDLE_MS, cursor, 'COUNT', 100)
          autoClaimSupported = true
          if (entries?.length) await processEntries(entries as Entry[])
          cursor = next
          if (cursor === '0-0') break
        } catch (e: any) {
          const message = String(e?.message ?? e)
          if (/unknown command.*xautoclaim|xautoclaim.*unknown command|unsupported.*xautoclaim|xautoclaim.*unsupported|not supported.*xautoclaim|syntax error/i.test(message)) {
            // This is expected on Redis versions/providers without XAUTOCLAIM, not a worker failure.
            // Switch permanently to XPENDING + XCLAIM to avoid logging this as an error every startup.
            autoClaimSupported = false
            await reclaimLegacy()
            break
          }
          throw e
        }
      }
    } catch (e) {
      logError('stream_reclaim_failed', e)
    }
  }, 15_000)

  return async () => {
    running = false
    clearInterval(reclaim)
    await loop
  }
}
