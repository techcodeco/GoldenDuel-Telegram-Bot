import { redis } from './redis'
import { TIMING_COMMAND_STREAM } from './contracts/timing-commands'

export interface TicketTimeoutData { ticketId: string }
export interface MatchTimeoutData { matchId: string; deadline: number }
export interface MatchReminderData { matchId: string; deadline: number; durationSeconds: number }

type TimingCommandType = 'ticket-timeout' | 'match-timeout' | 'match-reminder'

/**
 * The private bot intentionally does not depend on BullMQ. It publishes scheduling
 * requests to a durable Redis Stream; bullMQ-worker is the only service that writes
 * timing requests into the BullMQ queue.
 */
async function requestTimingJob(type: TimingCommandType, data: object): Promise<void> {
  await redis.xadd(
    TIMING_COMMAND_STREAM,
    'MAXLEN', '~', 500_000, '*',
    'type', type,
    'data', JSON.stringify(data),
  )
}

export async function scheduleTicketTimeout(ticket: {
  _id: string
  createdAtMs: number
  queueTimeoutSeconds?: number
  mode?: 'bet' | 'friendly'
}): Promise<void> {
  await requestTimingJob('ticket-timeout', ticket)
}

export async function scheduleMatchTimeout(matchId: string, deadline: number): Promise<void> {
  await requestTimingJob('match-timeout', { matchId, deadline })
}

export async function scheduleMatchReminder(matchId: string, deadline: number, durationSeconds: number): Promise<void> {
  await requestTimingJob('match-reminder', { matchId, deadline, durationSeconds })
}

export async function scheduleMatchJobs(matchId: string, deadline: number, durationSeconds: number): Promise<void> {
  await Promise.all([
    scheduleMatchTimeout(matchId, deadline),
    scheduleMatchReminder(matchId, deadline, durationSeconds),
  ])
}
