import { startBroadcastWorker } from './core/broadcast-worker'

async function main() {
  const running = await startBroadcastWorker()
  console.log('broadcast worker ready; sends are rate-limited and campaigns are persisted in MongoDB')
  let closing = false
  const shutdown = async (signal: string) => {
    if (closing) return
    closing = true
    console.log(`${signal}: stopping broadcast worker…`)
    await running.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((error) => {
  console.error('broadcast_worker_start_failed', error)
  process.exit(1)
})
