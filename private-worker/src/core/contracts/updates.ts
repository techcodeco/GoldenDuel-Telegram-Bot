/** Stable Redis stream contract between Telegram Gateway and independently deployed workers. */
export const DEFAULT_PRIVATE_UPDATES_STREAM = 'updates:private'
export const DEFAULT_GROUP_UPDATES_STREAM = 'updates:groups'

export interface TelegramUpdateStreamEntry {
  /** Telegram update_id, serialized as a string in Redis Streams. */
  u: string
  /** Complete Telegram Update object serialized as JSON. */
  d: string
}

export type UpdateStreamKind = 'private' | 'group'

export function updateDedupeKey(updateId: number, kind: UpdateStreamKind = 'private'): string {
  return kind === 'private' ? `dd:${updateId}` : `dd:group:${updateId}`
}
