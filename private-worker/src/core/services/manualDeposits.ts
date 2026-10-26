import type { Currency } from '../money'
import { ManualDepositInvoice, User, type IManualDepositInvoice } from '../models'
import { isDuplicateKey, randomInvoiceNumber } from '../invoice-id'
import { getSettings } from './settings'
import { applyOp, DuplicateOp, runTx } from './wallet'

export class ManualDepositConfigurationError extends Error {
  constructor(message = 'manual_deposit_configuration_missing') {
    super(message)
    this.name = 'ManualDepositConfigurationError'
  }
}

export class ManualDepositAmountBelowMinimum extends Error {
  constructor(public readonly minimum: number) {
    super('manual_deposit_amount_below_minimum')
    this.name = 'ManualDepositAmountBelowMinimum'
  }
}

/** Create an invoice and freeze all payment instructions/user details into it. */
export async function createManualDepositInvoice(input: {
  userId: number
  currency: Currency
  amount: number
}): Promise<IManualDepositInvoice> {
  const [user, settings] = await Promise.all([
    User.findOne({ tgId: input.userId }).select('tgId firstName username').lean(),
    getSettings(),
  ])
  if (!user) throw new Error('invoice_user_not_found')
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) throw new Error('invalid_manual_deposit_amount')
  if (input.amount < settings.limits.minDeposit[input.currency]) {
    throw new ManualDepositAmountBelowMinimum(settings.limits.minDeposit[input.currency])
  }

  const cfg = settings.manualDeposit
  if (!cfg.supportUsername) throw new ManualDepositConfigurationError('support_username_not_configured')
  if (input.currency === 'IRT' && (!cfg.cardNumber || !cfg.cardHolder)) {
    throw new ManualDepositConfigurationError('bank_card_not_configured')
  }

  // Seven-digit codes are random rather than sequential. The unique Mongo index
  // and collision retry guarantee that simultaneous invoices never share a code.
  for (let attempt = 0; attempt < 25; attempt++) {
    const invoiceNumber = randomInvoiceNumber()
    try {
      return await ManualDepositInvoice.create({
        invoiceNumber,
        userId: input.userId,
        userFirstName: user.firstName ?? '',
        userUsername: user.username ?? '',
        currency: input.currency,
        amount: input.amount,
        status: 'pending',
        cardNumber: input.currency === 'IRT' ? cfg.cardNumber : '',
        cardHolder: input.currency === 'IRT' ? cfg.cardHolder : '',
        supportUsername: cfg.supportUsername,
      })
    } catch (error) {
      if (!isDuplicateKey(error)) throw error
    }
  }
  throw new Error('could_not_allocate_unique_invoice_number')
}

/**
 * Resolve an invoice exactly once. Approval and wallet credit share one Mongo transaction,
 * so the account cannot be credited without the invoice being marked approved (or vice versa).
 */
export async function resolveManualDepositInvoice(
  invoiceNumber: number,
  adminId: number,
  approve: boolean,
  rejectionReason = '',
): Promise<IManualDepositInvoice | null> {
  try {
    return await runTx(async (session) => {
      const invoice = await ManualDepositInvoice.findOneAndUpdate(
        { invoiceNumber, status: 'pending' },
        {
          $set: {
            status: approve ? 'approved' : 'rejected',
            reviewedBy: adminId,
            reviewedAt: new Date(),
            reviewReason: approve ? '' : rejectionReason.trim(),
          },
        },
        { session, new: false },
      ).lean()
      if (!invoice) return null

      if (approve) {
        await applyOp(session, {
          key: `manual-deposit:${invoice.invoiceNumber}`,
          userId: invoice.userId,
          currency: invoice.currency,
          type: 'deposit',
          available: invoice.amount,
          locked: 0,
          ref: String(invoice.invoiceNumber),
        })
      }
      return { ...invoice, status: approve ? 'approved' : 'rejected', reviewedBy: adminId, reviewedAt: new Date(), reviewReason: approve ? '' : rejectionReason.trim() }
    })
  } catch (error) {
    if (error instanceof DuplicateOp) return null
    throw error
  }
}
