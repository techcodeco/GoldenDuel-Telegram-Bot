export type GroupLanguage = 'fa' | 'en'
export type GroupCurrency = 'IRT' | 'TON'
export type GroupMode = 'bet' | 'friendly'
export type DuelChoice = 'r' | 'p' | 's'
export type GroupTrigger = 'fight' | 'help' | 'dashboard'

export interface GroupFlow {
  chatId: string
  actorId: number
  actorName: string
  actorUsername: string
  targetId: number
  targetName: string
  targetUsername: string
  mode: GroupMode | null
  currency: GroupCurrency | null
  step: 'mode' | 'currency' | 'amount'
  triggerMessageId?: number
  formMessageId?: number
}

export interface MessageReference {
  chatId: number | string
  messageId?: number
  ephemeralMessageId?: number
  receiverUserId?: number
}

/** Absolute timestamp at 85% elapsed time, leaving roughly 15% of the move window. */
export function groupReminderAt(startedAtMs: number, durationSeconds: number): number {
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error('INVALID_GROUP_MOVE_DURATION')
  }
  return startedAtMs + Math.floor(durationSeconds * 850)
}


/** Only conditional duels require a currency and stake form. */
export function groupModeNeedsStake(mode: unknown): boolean {
  return mode === 'bet'
}

/** True for conditional duels and legacy friendly duels that were created with a reserved stake. */
export function groupDuelHasStake(duel: { mode?: unknown; currency?: unknown; amount?: unknown }): boolean {
  if (groupModeNeedsStake(duel.mode)) return true
  return duel.mode === 'friendly'
    && Number(duel.amount) > 0
    && (duel.currency === 'IRT' || duel.currency === 'TON')
}
