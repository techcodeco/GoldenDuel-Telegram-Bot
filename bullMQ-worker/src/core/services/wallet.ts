import { randomUUID } from 'node:crypto'
import { isDuplicateKey, randomInvoiceNumber } from '../invoice-id'
import mongoose, { type ClientSession } from 'mongoose'
import type { Currency, MoneyCurrency } from '../money'
import { House, Ledger, Payment, User, Withdrawal } from '../models'
import { dropUserCache } from './users'

export class InsufficientFunds extends Error {}
export class DuplicateOp extends Error {}

/** Run `fn` inside a Mongo transaction (needs a replica set). Retries transient errors automatically. */
export async function runTx<T>(fn: (s: ClientSession) => Promise<T>): Promise<T> {
  const session = await mongoose.startSession()
  try {
    let out!: T
    await session.withTransaction(
      async () => {
        out = await fn(session)
      },
      { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
    )
    return out
  } finally {
    await session.endSession()
  }
}

export interface Op {
  /** Globally unique idempotency key, e.g. `settle:<matchId>:1` */
  key: string
  userId: number
  currency: MoneyCurrency
  type: string
  /** signed change of the available balance */
  available: number
  /** signed change of the reserved (locked) balance */
  locked: number
  ref?: string
}

async function insertLedger(s: ClientSession, doc: Record<string, unknown>): Promise<void> {
  try {
    await Ledger.create([doc], { session: s })
  } catch (e: any) {
    if (e?.code === 11000) throw new DuplicateOp(String(doc.key))
    throw e
  }
}

/**
 * One atomic balance change: ledger row (unique key) + guarded $inc.
 * Negative deltas are only applied when the balance is big enough, so balances can never go below zero.
 */
export async function applyOp(s: ClientSession, op: Op): Promise<void> {
  await insertLedger(s, {
    key: op.key,
    userId: op.userId,
    currency: op.currency,
    type: op.type,
    available: op.available,
    locked: op.locked,
    ref: op.ref,
  })
  const filter: Record<string, unknown> = { tgId: op.userId }
  const inc: Record<string, number> = {}
  const a = `balances.${op.currency}.available`
  const l = `balances.${op.currency}.locked`
  if (op.available) inc[a] = op.available
  if (op.locked) inc[l] = op.locked
  if (op.available < 0) filter[a] = { $gte: -op.available }
  if (op.locked < 0) filter[l] = { $gte: -op.locked }
  if (!Object.keys(inc).length) return
  const res = await User.updateOne(filter, { $inc: inc }, { session: s })
  if (res.matchedCount !== 1) throw new InsufficientFunds(op.key)
}

/** Fee income (positive) or expenses such as referral rewards (negative) of the house account. */
export async function houseOp(
  s: ClientSession,
  key: string,
  currency: Currency,
  delta: number,
  type: string,
  ref?: string,
): Promise<void> {
  if (!delta) return
  await insertLedger(s, { key, userId: 0, currency, type, available: delta, locked: 0, ref })
  const res = await House.updateOne({ _id: 'house' }, { $inc: { [`balances.${currency}`]: delta } }, { session: s })
  if (res.matchedCount !== 1) throw new Error('house account missing')
}

/** Credit a paid deposit exactly once. Call this from your payment-gateway webhook. */
export async function creditDeposit(
  paymentId: string,
  txId?: string,
): Promise<{ userId: number; currency: MoneyCurrency; amount: number } | null> {
  try {
    return await runTx(async (s) => {
      const p = await Payment.findOneAndUpdate(
        { _id: paymentId, status: 'pending' },
        { $set: { status: 'paid', ...(txId ? { txId } : {}) } },
        { session: s, new: true },
      ).lean()
      if (!p) return null // unknown or already credited
      await applyOp(s, {
        key: `dep:${paymentId}`,
        userId: p.userId,
        currency: p.currency,
        type: 'deposit',
        available: p.amount,
        locked: 0,
        ref: paymentId,
      })
      return { userId: p.userId, currency: p.currency, amount: p.amount }
    })
  } catch (e) {
    if (e instanceof DuplicateOp) return null
    throw e
  }
}

export const newId = (): string => randomUUID()
export const shortId = (): string => randomUUID().replace(/-/g, '').slice(0, 8)

/** Reserve money and create a request with a unique random seven-digit numeric invoice ID. */
export async function createWithdrawal(p: {
  userId: number
  currency: Currency
  amount: number
  dest: string
  bankName?: string
  fullName?: string
}): Promise<string | null> {
  for (let attempt = 0; attempt < 25; attempt++) {
    const id = String(randomInvoiceNumber())
    try {
      await runTx(async (s) => {
        await Withdrawal.create([{
          _id: id,
          userId: p.userId,
          currency: p.currency,
          amount: p.amount,
          dest: p.dest,
          bankName: p.bankName ?? '',
          fullName: p.fullName ?? '',
          status: 'pending',
        }], { session: s })
        await applyOp(s, { key: `wdhold:${id}`, userId: p.userId, currency: p.currency, type: 'withdraw_hold', available: -p.amount, locked: p.amount, ref: id })
      })
      return id
    } catch (e) {
      if (e instanceof InsufficientFunds) return null
      if (isDuplicateKey(e)) continue
      throw e
    }
  }
  throw new Error('could_not_allocate_unique_withdrawal_invoice_number')
}

/** Admin decision. Approve settles reserved funds; rejection refunds them exactly once. */
export async function resolveWithdrawal(
  id: string,
  approve: boolean,
  adminId?: number,
  rejectionReason = '',
): Promise<{ id: string; userId: number; currency: MoneyCurrency; amount: number; fullName?: string; dest: string; bankName?: string; reviewReason?: string } | null> {
  try {
    return await runTx(async (s) => {
      const w = await Withdrawal.findOneAndUpdate(
        { _id: id, status: 'pending' },
        { $set: {
          status: approve ? 'paid' : 'rejected',
          ...(adminId ? { reviewedBy: adminId } : {}),
          reviewedAt: new Date(),
          reviewReason: approve ? '' : rejectionReason.trim(),
        } },
        { session: s, new: false },
      ).lean()
      if (!w) return null
      await applyOp(
        s,
        approve
          ? { key: `wdpaid:${id}`, userId: w.userId, currency: w.currency, type: 'withdraw_paid', available: 0, locked: -w.amount, ref: id }
          : { key: `wdrej:${id}`, userId: w.userId, currency: w.currency, type: 'withdraw_rejected', available: w.amount, locked: -w.amount, ref: id },
      )
      return {
        id,
        userId: w.userId,
        currency: w.currency,
        amount: w.amount,
        fullName: w.fullName,
        dest: w.dest,
        bankName: w.bankName,
        reviewReason: approve ? '' : rejectionReason.trim(),
      }
    })
  } catch (e) {
    if (e instanceof DuplicateOp) return null
    throw e
  }
}

/** Manual balance correction by an admin (audited in the ledger). false = user missing or balance too low. */
export async function adminAdjust(adminId: number, userId: number, currency: Currency, delta: number): Promise<boolean> {
  try {
    await runTx((s) =>
      applyOp(s, { key: `adm:${newId()}`, userId, currency, type: 'admin_adjust', available: delta, locked: 0, ref: String(adminId) }),
    )
    return true
  } catch (e) {
    if (e instanceof InsufficientFunds) return false
    throw e
  }
}


/** Apply the account-creation bonus at most once, in the same transaction as its ledger entry. */
export async function grantRegistrationBonus(
  userId: number,
  currency: Currency,
  amount: number,
  allowLegacyAccount = false,
): Promise<number> {
  const granted = await runTx(async (s) => {
    const filter: Record<string, unknown> = { tgId: userId, registrationBonusPaid: { $ne: true } }
    if (!allowLegacyAccount) filter.registrationBonusPending = true
    const user = await User.findOneAndUpdate(
      filter,
      { $set: { registrationBonusPaid: true, registrationBonusPending: false } },
      { session: s, new: false },
    ).lean()
    if (!user || amount <= 0) return 0
    await applyOp(s, {
      key: `signup:${userId}`,
      userId,
      currency,
      type: 'registration_bonus',
      available: amount,
      locked: 0,
      ref: String(userId),
    })
    await houseOp(s, `signupx:${userId}`, currency, -amount, 'registration_bonus_expense', String(userId))
    return amount
  })
  await dropUserCache(userId).catch(() => {})
  return granted
}
