import mongoose from 'mongoose'
import { randomBytes } from 'node:crypto'
import { Address } from '@ton/core'
import { IS_TON_TESTNET, TON_NETWORK, TONCENTER_API_KEY, TONCENTER_API_URL } from '../config'
import { logError } from '../logger'
import { isDuplicateKey, randomInvoiceNumber } from '../invoice-id'
import { TonDepositInvoice, User, type ITonDepositInvoice } from '../models'
import { getSettings } from './settings'
import { applyOp, DuplicateOp } from './wallet'
import {
  decodeTonCenterV3Comment,
  parseTonCenterV3Transactions,
  tonCenterV3AddressString,
  tonCenterV3TransactionHash,
  tonCenterV3TransactionMatchesPayment,
} from './toncenter-v3'

function normalAddress(input: string): string {
  return Address.parse(input.trim()).toRawString()
}

/** Friendly address for the active network. A testnet-flagged address is refused on mainnet to prevent misdirected funds. */
function friendlyAddress(input: string): string {
  const s = input.trim()
  let address: Address
  let testOnly = false
  if (Address.isFriendly(s)) {
    const parsed = Address.parseFriendly(s)
    address = parsed.address
    testOnly = parsed.isTestOnly
  } else {
    address = Address.parse(s)
  }
  if (!IS_TON_TESTNET && testOnly) throw new Error('ton_address_is_testnet_on_mainnet')
  return address.toString({ bounceable: false, urlSafe: true, testOnly: IS_TON_TESTNET })
}

export type TonInvoiceCheckResult =
  | { status: 'paid'; invoice: ITonDepositInvoice }
  | { status: 'pending' }
  | { status: 'not_found' }
  | { status: 'already_used' }

/** Create a TON invoice; its number is embedded as a transfer comment for matching on-chain. */
export async function createTonDepositInvoice(input: { userId: number; amount: number }): Promise<ITonDepositInvoice> {
  const [user, settings] = await Promise.all([
    User.findOne({ tgId: input.userId }).select('tgId').lean(),
    getSettings(),
  ])
  if (!user) throw new Error('invoice_user_not_found')
  const configuredAddress = settings.manualDeposit.tonAddress?.trim()
  if (!configuredAddress) throw new Error('ton_receiver_address_not_configured')
  let receiver: string
  try { receiver = friendlyAddress(configuredAddress) } catch { throw new Error('ton_receiver_address_invalid') }
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) throw new Error('invalid_ton_invoice_amount')
  if (input.amount < settings.limits.minDeposit.TON) throw new Error('ton_invoice_amount_below_minimum')

  for (let attempt = 0; attempt < 25; attempt++) {
    const invoiceNumber = randomInvoiceNumber()
    // A per-invoice 256-bit random hex token plus invoice number; this is a memo, not a tx hash.
    const randomMemo = randomBytes(32).toString('hex')
    const comment = `${randomMemo}-${invoiceNumber}`
    // Tonkeeper's web deep link only targets mainnet, so no link is generated on testnet (pay manually).
    const paymentUrl = IS_TON_TESTNET
      ? ''
      : `https://app.tonkeeper.com/transfer/${encodeURIComponent(receiver)}?amount=${input.amount}&text=${encodeURIComponent(comment)}`
    try {
      return await TonDepositInvoice.create({
        invoiceNumber,
        userId: input.userId,
        currency: 'TON',
        amount: input.amount,
        recipientAddress: receiver,
        comment,
        paymentUrl,
        network: TON_NETWORK,
        status: 'pending',
      })
    } catch (error) {
      if (!isDuplicateKey(error)) throw error
    }
  }
  throw new Error('could_not_allocate_unique_ton_invoice_number')
}

async function getMatchingIncomingTransaction(invoice: ITonDepositInvoice): Promise<{
  hash: string
  sourceAddress: string
} | null> {
  const targetRaw = normalAddress(invoice.recipientAddress)
  const apiUrl = new URL(`${TONCENTER_API_URL}/transactions`)
  // API v3 is an indexed API: filter by the receiving account and invoice age, then paginate by offset.
  apiUrl.searchParams.set('account', targetRaw)
  apiUrl.searchParams.set('limit', '1000')
  apiUrl.searchParams.set('sort', 'desc')

  const headers: Record<string, string> = { accept: 'application/json' }
  if (TONCENTER_API_KEY) headers['X-API-Key'] = TONCENTER_API_KEY

  const invoiceCreatedAt = invoice.createdAt instanceof Date
    ? invoice.createdAt.getTime()
    : (invoice.createdAt ? new Date(invoice.createdAt).getTime() : Date.now())
  // A little clock skew allowance. Use the server-side filter to avoid reading the wallet's entire history.
  const earliestAllowedUtime = Math.max(0, Math.floor(invoiceCreatedAt / 1000) - 120)
  const latestAllowedUtime = Math.floor(Date.now() / 1000) + 30
  apiUrl.searchParams.set('start_utime', String(earliestAllowedUtime))
  apiUrl.searchParams.set('end_utime', String(latestAllowedUtime))

  const pageSize = 1000 // API v3 allows at most 1000 rows per request.
  const maxPages = 100 // hard safety bound (up to 100,000 recent rows); never silently call this "not found".
  let scannedPages = 0
  let exhaustedPages = false
  let endLt: string | null = null
  const seenCursors = new Set<string>()

  for (let page = 0; page < maxPages; page++) {
    // LT cursor pagination is stable even if new payments arrive while the user is checking an invoice.
    apiUrl.searchParams.set('offset', '0')
    if (endLt === null) apiUrl.searchParams.delete('end_lt')
    else apiUrl.searchParams.set('end_lt', endLt)

    const response = await fetch(apiUrl, { headers, signal: AbortSignal.timeout(12_000) })
    if (!response.ok) throw new Error(`toncenter_v3_http_${response.status}`)
    const payload: unknown = await response.json()
    const transactions = parseTonCenterV3Transactions(payload)
    scannedPages++
    if (transactions.length === 0) {
      exhaustedPages = true
      break
    }

    for (const tx of transactions) {
      const matches = tonCenterV3TransactionMatchesPayment(tx, {
        recipientRawAddress: targetRaw,
        amountNanoTon: invoice.amount,
        comment: invoice.comment,
        earliestUtime: earliestAllowedUtime,
        latestUtime: latestAllowedUtime,
      })
      if (!matches) continue

      const hash = tonCenterV3TransactionHash(tx)
      const sourceText = tonCenterV3AddressString(tx.in_msg?.source)
      let sourceAddress = ''
      if (sourceText) {
        try { sourceAddress = friendlyAddress(sourceText) } catch { sourceAddress = sourceText }
      }
      return { hash: hash!, sourceAddress }
    }

    if (transactions.length < pageSize) {
      exhaustedPages = true
      break
    }

    // `lt` is a decimal string in v3 and can exceed JS's safe integer range; subtract with BigInt.
    const oldestLtRaw = transactions[transactions.length - 1]?.lt
    const oldestLtText = String(oldestLtRaw ?? '')
    if (!/^\d+$/.test(oldestLtText)) throw new Error('toncenter_v3_missing_lt_cursor')
    const oldestLt = BigInt(oldestLtText)
    if (oldestLt <= 0n) {
      exhaustedPages = true
      break
    }
    const nextEndLt = (oldestLt - 1n).toString()
    if (seenCursors.has(nextEndLt)) throw new Error('toncenter_v3_repeated_lt_cursor')
    seenCursors.add(nextEndLt)
    endLt = nextEndLt
  }

  // If all pages were full, a very busy wallet may have older matching transactions outside the scan.
  // Raise an operational error rather than misleading the user that the payment was definitely not found.
  if (!exhaustedPages && scannedPages >= maxPages) throw new Error('toncenter_v3_pagination_limit_reached')
  return null
}

/**
 * Verify a TON invoice against TON Center API v3 and credit it in one MongoDB transaction.
 * We match destination + exact nanoTON amount + exact invoice comment on a committed transaction returned by the selected network indexer.
 */
export async function checkTonDeposit(invoiceNumber: number, userId: number): Promise<TonInvoiceCheckResult> {
  const invoice = await TonDepositInvoice.findOne({ invoiceNumber, userId }).lean()
  if (!invoice) return { status: 'not_found' }
  // Invoices created on another network can never match this chain; don't query or credit them.
  if ((invoice.network ?? 'mainnet') !== TON_NETWORK) return { status: 'not_found' }
  if (invoice.status === 'paid') return { status: 'paid', invoice }

  let tx: { hash: string; sourceAddress: string } | null
  try {
    tx = await getMatchingIncomingTransaction(invoice)
  } catch (error) {
    logError('ton_deposit_chain_check_failed', error, { invoiceNumber, userId })
    throw error
  }
  if (!tx) return { status: 'pending' }

  const session = await mongoose.startSession()
  try {
    let paid: ITonDepositInvoice | null = null
    await session.withTransaction(async () => {
      const claimed = await TonDepositInvoice.findOneAndUpdate(
        { invoiceNumber, userId, status: 'pending' },
        { $set: { status: 'paid', txHash: tx!.hash, sourceAddress: tx!.sourceAddress, paidAt: new Date() } },
        { session, new: false },
      ).lean()
      if (!claimed) {
        const existing = await TonDepositInvoice.findOne({ invoiceNumber, userId, status: 'paid' }).session(session).lean()
        paid = existing ?? null
        return
      }
      await applyOp(session, {
        key: `ton-deposit:${invoiceNumber}`,
        userId,
        currency: 'TON',
        type: 'deposit',
        available: claimed.amount,
        locked: 0,
        ref: String(invoiceNumber),
      })
      paid = {
        ...claimed,
        status: 'paid',
        txHash: tx!.hash,
        sourceAddress: tx!.sourceAddress,
        paidAt: new Date(),
      }
    }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } })
    if (paid) return { status: 'paid', invoice: paid }
    const latest = await TonDepositInvoice.findOne({ invoiceNumber, userId }).lean()
    if (latest?.status === 'paid') return { status: 'paid', invoice: latest }
    return { status: 'pending' }
  } catch (error: any) {
    if (error instanceof DuplicateOp || error?.code === 11000) {
      // A single on-chain transaction must never be credited against multiple invoices.
      const latest = await TonDepositInvoice.findOne({ invoiceNumber, userId }).lean()
      if (latest?.status === 'paid') return { status: 'paid', invoice: latest }
      return { status: 'already_used' }
    }
    throw error
  } finally {
    await session.endSession()
  }
}
