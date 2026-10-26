/** Redis Stream contract between private-worker and bullMQ-worker. */
export const TIMING_COMMAND_STREAM = process.env.TIMING_COMMAND_STREAM ?? 'rps:timing:commands'
