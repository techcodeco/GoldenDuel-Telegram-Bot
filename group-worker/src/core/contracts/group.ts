export type GroupLanguage = 'fa' | 'en' | 'ar' | 'es'
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
  /** True when the duel is posted publicly for any eligible group member to accept. */
  openChallenge?: boolean
  mode: GroupMode | null
  currency: GroupCurrency | null
  step: 'mode' | 'currency' | 'amount'
  triggerMessageId?: number
  /** Original message being replied to; used as context for the target-only invitation. */
  targetMessageId?: number
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



/** A flow without a reply target is a public/open challenge. */
export function isOpenGroupFlow(flow: { openChallenge?: unknown; targetId?: unknown }): boolean {
  // An explicit flag is authoritative. In particular, a direct challenge must
  // fail closed rather than become public if its target ID is ever missing.
  if (typeof flow.openChallenge === 'boolean') return flow.openChallenge
  // Backward compatibility for flows created before openChallenge was stored.
  return Number(flow.targetId ?? 0) <= 0
}

/**
 * All invitations are announced in the group. Only open challenges expose a
 * public accept button; a reply-targeted invitation is accepted/rejected only
 * through an ephemeral form addressed to the selected target.
 */
export function groupInvitationDelivery(flow: { openChallenge?: unknown; targetId?: unknown }) {
  const openChallenge = isOpenGroupFlow(flow)
  return {
    publicAnnouncement: true as const,
    publicAcceptButton: openChallenge,
    privateAcceptForm: !openChallenge,
  }
}

/** Open group challenges have no preselected opponent until the first valid acceptance. */
export function isOpenGroupChallenge(duel: { openChallenge?: unknown; opponentId?: unknown }): boolean {
  // Once an opponent ID is assigned, the request is no longer waiting for a
  // public acceptor even though the original openChallenge flag remains true.
  return Number(duel.opponentId ?? 0) <= 0
}
