import IORedis from 'ioredis'
import { Queue, type JobsOptions } from 'bullmq'
import { REDIS_URL } from './config'
import { logError } from './logger'
import { TIMING_QUEUE_NAME } from './contracts/timing-jobs'

export const DUEL_QUEUE_NAME = TIMING_QUEUE_NAME

/** Dedicated BullMQ connection. Do not reuse the app's low-retry Redis connection. */
export const duelQueueConnection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null })
duelQueueConnection.on('error', (err) => logError('duel_queue_redis_error', err))

const defaultJobOptions: JobsOptions = {
  attempts: 8,
  backoff: { type: 'exponential', delay: 1_000 },
  removeOnComplete: { count: 10_000 },
  removeOnFail: { count: 20_000 },
}

export const duelQueue = new Queue(DUEL_QUEUE_NAME, {
  connection: duelQueueConnection,
  defaultJobOptions,
})

let queueClosed = false
export async function closeDuelQueue(): Promise<void> {
  if (queueClosed) return
  queueClosed = true
  await duelQueue.close()
  await duelQueueConnection.quit().catch(() => undefined)
}

export interface TicketTimeoutData { ticketId: string }
export interface MatchTimeoutData { matchId: string; deadline: number }
export interface MatchReminderData { matchId: string; deadline: number; durationSeconds: number }

async function ensureDelayedJob<T extends object>(name: string, id: string, data: T, runAt: number, forceSuccessor = false): Promise<void> {
  if (forceSuccessor) {
    // Called only from a timeout processor that has proven it ran before the deadline.
    // The current/base job is still active, so reusing its ID would be a no-op. Give
    // each explicit early-run retry a unique id; duplicate adds from the same millisecond
    // still collapse to the same BullMQ job id.
    const successorId = `${id}_retry_${Date.now()}`
    await duelQueue.add(name, data, { jobId: successorId, delay: Math.max(0, runAt - Date.now()) })
    return
  }

  const existing = await duelQueue.getJob(id)
  if (existing) {
    const state = await existing.getState()
    if (['active', 'waiting', 'delayed', 'paused', 'waiting-children', 'prioritized'].includes(state)) return
    // A completed/failed job must not prevent recovery if Mongo still says the work is pending.
    try { await existing.remove() } catch { /* another worker may have replaced it */ }
  }
  await duelQueue.add(name, data, { jobId: id, delay: Math.max(0, runAt - Date.now()) })
}

export async function scheduleTicketTimeout(ticket: {
  _id: string
  createdAtMs: number
  queueTimeoutSeconds?: number
  mode?: 'bet' | 'friendly'
}, forceSuccessor = false): Promise<void> {
  const seconds = Math.max(1, Number(ticket.queueTimeoutSeconds ?? 300))
  await ensureDelayedJob<TicketTimeoutData>(
    'ticket-timeout',
    `ticket_timeout_${ticket._id}`,
    { ticketId: ticket._id },
    ticket.createdAtMs + seconds * 1000,
    forceSuccessor,
  )
}

export async function scheduleMatchTimeout(matchId: string, deadline: number, forceSuccessor = false): Promise<void> {
  await ensureDelayedJob<MatchTimeoutData>(
    'match-timeout',
    `match_timeout_${matchId}_${deadline}`,
    { matchId, deadline },
    deadline,
    forceSuccessor,
  )
}

export async function scheduleMatchReminder(matchId: string, deadline: number, durationSeconds: number): Promise<void> {
  const runAt = deadline - Math.max(1, durationSeconds) * 1000 * 0.15
  await ensureDelayedJob<MatchReminderData>(
    'match-reminder',
    `match_reminder_${matchId}_${deadline}`,
    { matchId, deadline, durationSeconds },
    runAt,
  )
}

export async function scheduleMatchJobs(matchId: string, deadline: number, durationSeconds: number): Promise<void> {
  await Promise.all([
    scheduleMatchTimeout(matchId, deadline),
    scheduleMatchReminder(matchId, deadline, durationSeconds),
  ])
}


export interface GroupTimeoutData { duelId: string; deadline: number }
export interface GroupReminderData { duelId: string; reminderAt: number }
export async function scheduleGroupInviteTimeout(duelId: string, deadline: number, forceSuccessor = false): Promise<void> {
  await ensureDelayedJob<GroupTimeoutData>('group-invite-timeout', `group_invite_${duelId}`, { duelId, deadline }, deadline, forceSuccessor)
}
export async function scheduleGroupMatchTimeout(duelId: string, deadline: number, forceSuccessor = false): Promise<void> {
  await ensureDelayedJob<GroupTimeoutData>('group-match-timeout', `group_match_${duelId}_${deadline}`, { duelId, deadline }, deadline, forceSuccessor)
}
export async function scheduleGroupMatchReminder(duelId: string, reminderAt: number, forceSuccessor = false): Promise<void> {
  await ensureDelayedJob<GroupReminderData>(
    'group-match-reminder', `group_match_reminder_${duelId}_${reminderAt}`, { duelId, reminderAt }, reminderAt, forceSuccessor,
  )
}
