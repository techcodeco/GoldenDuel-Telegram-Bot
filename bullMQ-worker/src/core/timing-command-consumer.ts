import { startConsumer } from './consumer'
import { logError } from './logger'
import { scheduleGroupInviteTimeout, scheduleGroupMatchTimeout, scheduleGroupMatchReminder, scheduleMatchReminder, scheduleMatchTimeout, scheduleTicketTimeout } from './duel-jobs'
import { TIMING_COMMAND_STREAM } from './contracts/timing-jobs'

/** Consumes requests from private-worker and creates BullMQ jobs in this service only. */
export async function startTimingCommandConsumer(): Promise<() => Promise<void>> {
  return startConsumer({
    stream: TIMING_COMMAND_STREAM,
    group: 'bullmq-timing-command-workers',
    dead: `${TIMING_COMMAND_STREAM}:dead`,
    handle: async (fields) => {
      const type = fields.type
      const data = JSON.parse(fields.data ?? '{}')
      try {
        switch (type) {
          case 'ticket-timeout':
            await scheduleTicketTimeout(data)
            return
          case 'match-timeout':
            await scheduleMatchTimeout(String(data.matchId), Number(data.deadline))
            return
          case 'match-reminder':
            await scheduleMatchReminder(String(data.matchId), Number(data.deadline), Number(data.durationSeconds))
            return
          case 'group-invite-timeout':
            await scheduleGroupInviteTimeout(String(data.duelId), Number(data.deadline))
            return
          case 'group-match-timeout':
            await scheduleGroupMatchTimeout(String(data.duelId), Number(data.deadline))
            return
          case 'group-match-reminder':
            await scheduleGroupMatchReminder(String(data.duelId), Number(data.reminderAt))
            return
          default:
            throw new Error(`Unknown timing command: ${String(type)}`)
        }
      } catch (error) {
        logError('timing_command_failed', error, { type, data })
        throw error
      }
    },
  })
}
