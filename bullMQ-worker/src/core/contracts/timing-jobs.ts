/** Shared BullMQ contract. New domains (including future group games) must extend this
 * contract and use the shared timing command stream; do not create parallel timers.
 */
export const TIMING_QUEUE_NAME = 'duel-timing'

export const TIMING_JOB_NAMES = {
  ticketTimeout: 'ticket-timeout',
  matchTimeout: 'match-timeout',
  matchReminder: 'match-reminder',
  reconcile: 'reconcile',
  groupInviteTimeout: 'group-invite-timeout',
  groupMatchTimeout: 'group-match-timeout',
  groupMatchReminder: 'group-match-reminder',
} as const

export type ExistingTimingJobName = typeof TIMING_JOB_NAMES[keyof typeof TIMING_JOB_NAMES]

/** Redis Stream used by private-worker and group-worker to request delayed jobs without depending on BullMQ. */
export const TIMING_COMMAND_STREAM = process.env.TIMING_COMMAND_STREAM ?? 'rps:timing:commands'
