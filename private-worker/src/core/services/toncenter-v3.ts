import { Address, Cell } from '@ton/core'

export type TonCenterV3Address = string | { account_address?: string; user_friendly?: string } | null | undefined

export interface TonCenterV3MessageContent {
  body?: string | null
  decoded?: unknown
  hash?: string | null
}

export interface TonCenterV3Message {
  source?: TonCenterV3Address
  destination?: TonCenterV3Address
  value?: string | number | bigint | null
  bounced?: boolean | null
  decoded_opcode?: string | null
  opcode?: number | string | null
  message_content?: TonCenterV3MessageContent | null
}

export interface TonCenterV3Transaction {
  account?: string
  hash?: string
  lt?: string | number
  now?: string | number
  mc_block_seqno?: number | null
  emulated?: boolean | null
  in_msg?: TonCenterV3Message | null
  description?: {
    aborted?: boolean | null
    action?: { success?: boolean | null } | null
    credit_ph?: { credit?: string | number | bigint | null } | null
    compute_ph?: {
      exit_code?: number | null
      success?: boolean | null
      skipped?: boolean | null
      reason?: string | null
    } | null
    bounce?: { type?: string | null } | null
  } | null
  /** TON Center v3 execution/finality metadata; absent on some historical responses. */
  finality?: string | null
  orig_status?: string | null
  end_status?: string | null
  out_msgs?: TonCenterV3Message[] | null
}

/** Convert the API v3 address fields (usually strings) into a value accepted by @ton/core. */
export function tonCenterV3AddressString(input: TonCenterV3Address): string | null {
  if (typeof input === 'string' && input.trim()) return input.trim()
  if (input && typeof input === 'object') {
    if (typeof input.account_address === 'string' && input.account_address.trim()) return input.account_address.trim()
    if (typeof input.user_friendly === 'string' && input.user_friendly.trim()) return input.user_friendly.trim()
  }
  return null
}

function decodeBocTextComment(body: string): string | null {
  try {
    const slice = Cell.fromBase64(body).beginParse()
    // A regular TON wallet-transfer comment starts with the 32-bit text-comment opcode 0.
    if (slice.remainingBits < 32 || slice.loadUint(32) !== 0) return null
    return slice.loadStringTail()
  } catch {
    return null
  }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * V3 `message_content.decoded` is deliberately typed as unknown because TON Center decodes many
 * different TLB schemas. Accept only well-known text-comment shapes, never arbitrary object text.
 */
function decodeDecodedTextComment(message: TonCenterV3Message): string | null {
  const decoded = message.message_content?.decoded
  const opcode = (message.decoded_opcode ?? '').toLowerCase()
  if (typeof decoded === 'string') {
    return opcode.includes('text_comment') ? decoded : null
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return null

  const obj = decoded as Record<string, unknown>
  const kind = String(obj['@type'] ?? obj.type ?? obj.kind ?? '').toLowerCase()
  const direct = asString(obj.text_comment) ?? asString(obj.textComment)
  if (direct !== null) return direct

  for (const key of ['text_comment', 'textComment']) {
    const nested = obj[key]
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      const nestedObj = nested as Record<string, unknown>
      const value = asString(nestedObj.text) ?? asString(nestedObj.comment) ?? asString(nestedObj.value)
      if (value !== null) return value
    }
  }

  if (opcode.includes('text_comment') || kind.includes('text_comment')) {
    return asString(obj.text) ?? asString(obj.comment) ?? asString(obj.value)
  }
  return null
}

/** Decode a standard native-TON comment from the indexed v3 inbound message. */
export function decodeTonCenterV3Comment(message: TonCenterV3Message | null | undefined): string | null {
  if (!message) return null
  // The BOC is the on-chain source of truth. Prefer it over indexed decoded metadata when available.
  const body = message.message_content?.body
  if (typeof body === 'string' && body.length > 0) {
    const comment = decodeBocTextComment(body)
    if (comment !== null) return comment
  }
  return decodeDecodedTextComment(message)
}

/** V3 returns each transaction with a top-level `hash` field. */
export function tonCenterV3TransactionHash(tx: TonCenterV3Transaction): string | null {
  return typeof tx.hash === 'string' && tx.hash.trim() ? tx.hash.trim() : null
}

/**
 * V3 `/transactions` returns `{ transactions: [...] }`, not the v2 `{ ok, result }` envelope.
 * API-level errors are raised separately, including errors returned with HTTP 200.
 */
export function parseTonCenterV3Transactions(payload: unknown): TonCenterV3Transaction[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('toncenter_v3_invalid_response')
  }
  const response = payload as { transactions?: unknown; code?: unknown; error?: unknown }
  const errorText = typeof response.error === 'string' ? response.error.trim() : ''
  const code = response.code === undefined || response.code === null ? '' : String(response.code)
  if ((code && code !== '0') || errorText) {
    throw new Error(`toncenter_v3_api_error${code ? `_${code}` : ''}:${(errorText || 'unknown_error').slice(0, 160)}`)
  }
  if (!Array.isArray(response.transactions)) {
    throw new Error('toncenter_v3_invalid_transactions_result')
  }
  return response.transactions as TonCenterV3Transaction[]
}

/** True/false only when TON Center provides an explicit execution result; null means fail closed. */
export function tonCenterV3TransactionIsAborted(tx: TonCenterV3Transaction): boolean | null {
  return typeof tx.description?.aborted === 'boolean' ? tx.description.aborted : null
}


export interface TonCenterV3PaymentCriteria {
  recipientRawAddress: string
  amountNanoTon: number
  comment: string
  earliestUtime: number
  latestUtime: number
}

function addressToRaw(input: TonCenterV3Address): string | null {
  const value = tonCenterV3AddressString(input)
  if (!value) return null
  try {
    return Address.parse(value).toRawString()
  } catch {
    return null
  }
}

/**
 * Exact matcher for a native TON deposit. Keep this deliberately strict, but consume API v3's real
 * field names (`hash`, `now`, `in_msg.message_content.body/decoded`, `description.aborted`).
 */
export function tonCenterV3TransactionMatchesPayment(
  tx: TonCenterV3Transaction,
  criteria: TonCenterV3PaymentCriteria,
): boolean {
  const hash = tonCenterV3TransactionHash(tx)
  const message = tx.in_msg
  if (!hash || !message || message.bounced === true || tx.emulated === true) return false
  if (typeof tx.mc_block_seqno === 'number' && tx.mc_block_seqno <= 0) return false

  const rawUtime = tx.now
  const utime = typeof rawUtime === 'number' ? rawUtime : Number(rawUtime)
  // Missing/malformed timestamps must fail closed; otherwise a crafted or partial API
  // payload could bypass the invoice time window.
  if (!Number.isSafeInteger(utime) || utime < criteria.earliestUtime || utime > criteria.latestUtime) return false

  const destination = addressToRaw(message.destination)
  if (!destination || destination !== criteria.recipientRawAddress) return false

  const value = String(message.value ?? '')
  if (!/^\d+$/.test(value)) return false
  if (!Number.isSafeInteger(criteria.amountNanoTon) || criteria.amountNanoTon <= 0) return false
  if (BigInt(value) !== BigInt(criteria.amountNanoTon)) return false
  if (decodeTonCenterV3Comment(message) !== criteria.comment) return false

  // Normal wallet transactions must explicitly be non-aborted. One important TON edge case:
  // sending to a not-yet-initialized account produces an `uninit -> uninit` transaction where
  // compute is skipped (`no_state`) and `aborted` is true, although the credit phase has already
  // credited the incoming value to that account. TON Center v3 represents this real, finalized
  // deposit exactly that way (and it is what the reported transaction sample contains).
  // Accept only that narrowly defined case, not arbitrary aborted transactions.
  const aborted = tonCenterV3TransactionIsAborted(tx)
  if (aborted === null) return false
  if (aborted) {
    const compute = tx.description?.compute_ph
    const creditedRaw = String(tx.description?.credit_ph?.credit ?? '')
    const incomingRaw = String(message.value ?? '')
    const isCreditedToUninitializedAccount =
      tx.finality === 'finalized' &&
      tx.orig_status === 'uninit' &&
      tx.end_status === 'uninit' &&
      compute?.skipped === true &&
      String(compute.reason ?? '').toLowerCase() === 'no_state' &&
      /^\d+$/.test(creditedRaw) &&
      /^\d+$/.test(incomingRaw) &&
      BigInt(creditedRaw) === BigInt(incomingRaw) &&
      (tx.out_msgs?.length ?? 0) === 0 &&
      !tx.description?.bounce?.type
    if (!isCreditedToUninitializedAccount) return false
  } else {
    if (tx.description?.action?.success === false) return false
    if (tx.description?.compute_ph?.success === false) return false
    if (typeof tx.description?.compute_ph?.exit_code === 'number' && tx.description.compute_ph.exit_code !== 0) return false
    if (tx.description?.bounce?.type) return false
  }

  return true
}
