import { Address, Cell } from "@ton/core";

export type TonCenterV3Address =
  | string
  | { account_address?: string; user_friendly?: string }
  | null
  | undefined;

export interface TonCenterV3MessageContent {
  body?: string | null;
  decoded?: unknown;
  hash?: string | null;
}

export interface TonCenterV3Message {
  source?: TonCenterV3Address;
  destination?: TonCenterV3Address;
  value?: string | number | bigint | null;
  bounced?: boolean | null;
  decoded_opcode?: string | null;
  opcode?: number | string | null;
  message_content?: TonCenterV3MessageContent | null;
}

export interface TonCenterV3Transaction {
  account?: string;
  hash?: string;
  lt?: string | number;
  now?: string | number;
  mc_block_seqno?: number | null;
  emulated?: boolean | null;
  in_msg?: TonCenterV3Message | null;
  description?: {
    aborted?: boolean | null;
    action?: { success?: boolean | null } | null;
    credit_ph?: { credit?: string | number | bigint | null } | null;
    compute_ph?: {
      exit_code?: number | null;
      success?: boolean | null;
      skipped?: boolean | null;
      reason?: string | null;
    } | null;
    bounce?: { type?: string | null } | null;
  } | null;
  /** TON Center v3 execution/finality metadata; absent on some historical responses. */
  finality?: string | null;
  orig_status?: string | null;
  end_status?: string | null;
  out_msgs?: TonCenterV3Message[] | null;
}

/** Convert API v3 address fields into a value accepted by @ton/core. */
export function tonCenterV3AddressString(
  input: TonCenterV3Address,
): string | null {
  if (typeof input === "string" && input.trim()) {
    return input.trim();
  }

  if (input && typeof input === "object") {
    if (
      typeof input.account_address === "string" &&
      input.account_address.trim()
    ) {
      return input.account_address.trim();
    }

    if (typeof input.user_friendly === "string" && input.user_friendly.trim()) {
      return input.user_friendly.trim();
    }
  }

  return null;
}

function decodeBocTextComment(body: string): string | null {
  try {
    const slice = Cell.fromBase64(body).beginParse();

    // Native TON text-comment opcode.
    if (slice.remainingBits < 32 || slice.loadUint(32) !== 0) {
      return null;
    }

    return slice.loadStringTail();
  } catch {
    return null;
  }
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Accept known text-comment shapes returned by TON Center v3.
 */
function decodeDecodedTextComment(message: TonCenterV3Message): string | null {
  const decoded = message.message_content?.decoded;
  const opcode = (message.decoded_opcode ?? "").toLowerCase();

  if (typeof decoded === "string") {
    return opcode.includes("text_comment") ? decoded : null;
  }

  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    return null;
  }

  const obj = decoded as Record<string, unknown>;
  const kind = String(obj["@type"] ?? obj.type ?? obj.kind ?? "").toLowerCase();

  const direct = asString(obj["text_comment"]) ?? asString(obj["textComment"]);

  if (direct !== null) {
    return direct;
  }

  for (const key of ["text_comment", "textComment"]) {
    const nested = obj[key];

    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const nestedObj = nested as Record<string, unknown>;

      const value =
        asString(nestedObj["text"]) ??
        asString(nestedObj["comment"]) ??
        asString(nestedObj["value"]);

      if (value !== null) {
        return value;
      }
    }
  }

  if (opcode.includes("text_comment") || kind.includes("text_comment")) {
    return (
      asString(obj["text"]) ??
      asString(obj["comment"]) ??
      asString(obj["value"])
    );
  }

  return null;
}

/** Decode a native TON text comment from the inbound message. */
export function decodeTonCenterV3Comment(
  message: TonCenterV3Message | null | undefined,
): string | null {
  if (!message) {
    return null;
  }

  // Prefer decoding the original BOC when it is available.
  const body = message.message_content?.body;

  if (typeof body === "string" && body.length > 0) {
    const comment = decodeBocTextComment(body);

    if (comment !== null) {
      return comment;
    }
  }

  return decodeDecodedTextComment(message);
}

/** TON Center v3 transaction hash. */
export function tonCenterV3TransactionHash(
  tx: TonCenterV3Transaction,
): string | null {
  return typeof tx.hash === "string" && tx.hash.trim() ? tx.hash.trim() : null;
}

/**
 * Parse the TON Center v3 response.
 *
 * Expected shape:
 * {
 *   transactions: [...]
 * }
 */
export function parseTonCenterV3Transactions(
  payload: unknown,
): TonCenterV3Transaction[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("toncenter_v3_invalid_response");
  }

  const response = payload as {
    transactions?: unknown;
    code?: unknown;
    error?: unknown;
  };

  const errorText =
    typeof response.error === "string" ? response.error.trim() : "";

  const code =
    response.code === undefined || response.code === null
      ? ""
      : String(response.code);

  if ((code && code !== "0") || errorText) {
    throw new Error(
      `toncenter_v3_api_error${
        code ? `_${code}` : ""
      }:${(errorText || "unknown_error").slice(0, 160)}`,
    );
  }

  if (!Array.isArray(response.transactions)) {
    throw new Error("toncenter_v3_invalid_transactions_result");
  }

  return response.transactions as TonCenterV3Transaction[];
}

/**
 * Returns null when TON Center has not supplied an explicit result.
 */
export function tonCenterV3TransactionIsAborted(
  tx: TonCenterV3Transaction,
): boolean | null {
  return typeof tx.description?.aborted === "boolean"
    ? tx.description.aborted
    : null;
}

export interface TonCenterV3PaymentCriteria {
  /** Destination address in raw form: workchain:hex. */
  recipientRawAddress: string;
  /** Expected invoice amount in nanoTON. */
  amountNanoTon: number;
  /** Exact expected invoice comment. */
  comment: string;
  /** Earliest allowed Unix timestamp in seconds. */
  earliestUtime: number;
  /** Latest allowed Unix timestamp in seconds. */
  latestUtime: number;
}

function addressToRaw(input: TonCenterV3Address): string | null {
  const value = tonCenterV3AddressString(input);

  if (!value) {
    return null;
  }

  try {
    return Address.parse(value).toRawString();
  } catch {
    return null;
  }
}

/**
 * Exact matcher for a native TON deposit.
 *
 * Requirements:
 * - The transaction is finalized.
 * - The destination and transaction account match the configured wallet.
 * - The incoming amount matches the invoice exactly.
 * - The invoice comment matches exactly.
 * - The transaction timestamp falls within the invoice window.
 * - The incoming message is not marked as bounced.
 * - Aborted transactions are rejected, except for the narrowly defined
 *   first-credit-to-uninitialized-account case.
 *
 * IMPORTANT:
 * This function only validates a candidate transaction. The caller must
 * also ensure that the transaction has not previously been credited and
 * must credit the invoice atomically.
 */
export function tonCenterV3TransactionMatchesPayment(
  tx: TonCenterV3Transaction,
  criteria: TonCenterV3PaymentCriteria,
): boolean {
  const hash = tonCenterV3TransactionHash(tx);
  const message = tx.in_msg;

  // Require an identifiable transaction and inbound message.
  if (!hash || !message) {
    return false;
  }

  // Never accept an emulated or non-finalized transaction.
  if (tx.finality !== "finalized" || tx.emulated === true) {
    return false;
  }

  // An incoming deposit message must explicitly not be bounced.
  if (message.bounced !== false) {
    return false;
  }

  if (typeof tx.mc_block_seqno === "number" && tx.mc_block_seqno <= 0) {
    return false;
  }

  // Validate the invoice time window.
  if (
    !Number.isSafeInteger(criteria.earliestUtime) ||
    !Number.isSafeInteger(criteria.latestUtime) ||
    criteria.earliestUtime < 0 ||
    criteria.latestUtime < criteria.earliestUtime
  ) {
    return false;
  }

  const rawUtime = tx.now;
  const utime = typeof rawUtime === "number" ? rawUtime : Number(rawUtime);

  if (
    !Number.isSafeInteger(utime) ||
    utime < criteria.earliestUtime ||
    utime > criteria.latestUtime
  ) {
    return false;
  }

  // Normalize both destination and account to raw TON addresses.
  const destination = addressToRaw(message.destination);
  const transactionAccount = addressToRaw(tx.account);
  const recipient = addressToRaw(criteria.recipientRawAddress);

  if (
    !destination ||
    !transactionAccount ||
    !recipient ||
    destination !== recipient ||
    transactionAccount !== destination
  ) {
    return false;
  }

  // Parse amounts as integers to avoid floating-point comparisons.
  const value = String(message.value ?? "");

  if (!/^\d+$/.test(value)) {
    return false;
  }

  if (
    !Number.isSafeInteger(criteria.amountNanoTon) ||
    criteria.amountNanoTon <= 0
  ) {
    return false;
  }

  if (BigInt(value) !== BigInt(criteria.amountNanoTon)) {
    return false;
  }

  // Match the invoice comment exactly.
  if (decodeTonCenterV3Comment(message) !== criteria.comment) {
    return false;
  }

  const aborted = tonCenterV3TransactionIsAborted(tx);

  // Missing execution result: fail closed.
  if (aborted === null) {
    return false;
  }

  if (aborted) {
    /*
     * TON edge case:
     *
     * A transfer to an uninitialized account can have:
     * - orig_status = nonexist or uninit
     * - end_status = uninit
     * - aborted = true
     * - compute skipped because reason = no_state
     *
     * The incoming TON can still have been credited to the account.
     *
     * Accept only this narrowly defined case. Do not treat arbitrary
     * aborted transactions as successful deposits.
     */
    const compute = tx.description?.compute_ph;

    const creditedRaw = String(tx.description?.credit_ph?.credit ?? "");

    const incomingRaw = String(message.value ?? "");

    const originalStatus = String(tx.orig_status ?? "").toLowerCase();

    const endStatus = String(tx.end_status ?? "").toLowerCase();

    const isCreditedToUninitializedAccount =
      (originalStatus === "nonexist" || originalStatus === "uninit") &&
      endStatus === "uninit" &&
      compute?.skipped === true &&
      String(compute.reason ?? "").toLowerCase() === "no_state" &&
      /^\d+$/.test(creditedRaw) &&
      /^\d+$/.test(incomingRaw) &&
      BigInt(creditedRaw) === BigInt(incomingRaw) &&
      (tx.out_msgs?.length ?? 0) === 0 &&
      !tx.description?.bounce?.type;

    if (!isCreditedToUninitializedAccount) {
      return false;
    }
  } else {
    // Normal transactions must not report execution failures.
    if (tx.description?.action?.success === false) {
      return false;
    }

    if (tx.description?.compute_ph?.success === false) {
      return false;
    }

    if (
      typeof tx.description?.compute_ph?.exit_code === "number" &&
      tx.description.compute_ph.exit_code !== 0
    ) {
      return false;
    }

    if (tx.description?.bounce?.type) {
      return false;
    }
  }

  return true;
}
