import { startGroupWorker } from './worker'
import { logger, flushLogs } from './core/logger'

startGroupWorker().catch((error) => {
  logger.fatal({ err: error, key: 'startup_failed' }, 'group_worker_startup_failed')
  flushLogs()
  process.exit(1)
})
