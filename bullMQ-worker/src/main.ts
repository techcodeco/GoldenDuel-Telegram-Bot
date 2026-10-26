import { closeDb, connectDb } from './core/db'
import { logger } from './core/logger'
import { redis, redisBlock, redisSub } from './core/redis'
import { startDuelWorker } from './core/duel-worker'
import { startServerTelemetry } from './core/telemetry'
import { startTimingCommandConsumer } from './core/timing-command-consumer'

async function main(): Promise<void> {
  await connectDb()
  const stopTelemetry = await startServerTelemetry(redis, 'bullMQ-worker')
  const stop = await startDuelWorker()
  const stopCommands = await startTimingCommandConsumer()
  console.log('BullMQ timing worker is ready (timing commands consumed from Redis Streams)')
  let closing = false
  const shutdown = async (signal: string) => {
    if (closing) return
    closing = true
    console.log(`${signal}: shutting down duel timing worker`)
    await stopCommands()
    await stop()
    await stopTelemetry()
    await closeDb()
    redis.disconnect()
    redisBlock.disconnect()
    redisSub.disconnect()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((err) => {
  logger.fatal({ err }, 'duel_worker_startup_failed')
  process.exit(1)
})
