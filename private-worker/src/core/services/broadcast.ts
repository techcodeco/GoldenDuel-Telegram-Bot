import mongoose from 'mongoose'
import { GroupTarget, Ledger, User, type IBroadcastUserFilter } from '../models'
import { normalizeDigits, parseAmount, type Currency } from '../money'

export type { IBroadcastUserFilter }

const eligibleUserMatch = {
  role: { $nin: ['admin', 'owner'] },
  blockedBot: { $ne: true },
}

/** Parse an owner-entered filter such as `TON > 0.5`, `IRT < 50000` or referrals `< 10`. */
export function parseBroadcastUserCondition(
  kind: 'balance' | 'referrals' | 'deposits' | 'withdrawals',
  input: string,
): IBroadcastUserFilter | null {
  const normalized = normalizeDigits(input.trim())
  if (kind === 'referrals') {
    const match = /^(>|<)\s*(\d{1,9})$/.exec(normalized)
    if (!match) return null
    return { type: 'referrals', operator: match[1] === '>' ? 'gt' : 'lt', amount: Number(match[2]) }
  }
  const match = /^(TON|IRT)\s*(>|<)\s*(\d{1,12}(?:\.\d{1,9})?)$/i.exec(normalized)
  if (!match) return null
  const currency = match[1]!.toUpperCase() as Currency
  const rawAmount = match[3]!
  let amount: number | null
  if (/^0+(?:\.0+)?$/.test(rawAmount)) {
    amount = 0
  } else {
    amount = parseAmount(rawAmount, currency)
  }
  if (amount === null) return null
  if (currency === 'IRT' && rawAmount.includes('.') && !/^\d+\.0+$/.test(rawAmount)) return null
  return { type: kind, currency, operator: match[2] === '>' ? 'gt' : 'lt', amount }
}

function metricOperator(operator: 'gt' | 'lt', value: number): Record<string, number> {
  return operator === 'gt' ? { $gt: value } : { $lt: value }
}

function userPipeline(filter: IBroadcastUserFilter, afterObjectId?: string, forCount = false): any[] {
  const match: Record<string, any> = { ...eligibleUserMatch }
  if (filter.type === 'balance' && filter.currency && filter.operator && Number.isFinite(filter.amount)) {
    match[`balances.${filter.currency}.available`] = metricOperator(filter.operator, Number(filter.amount))
  }
  const pipeline: any[] = [{ $match: match }]

  if (filter.type === 'referrals' && filter.operator && Number.isFinite(filter.amount)) {
    pipeline.push(
      {
        $lookup: {
          from: User.collection.name,
          let: { targetTelegramId: '$tgId' },
          pipeline: [
            { $match: { $expr: { $eq: ['$referrerId', '$$targetTelegramId'] } } },
            { $count: 'count' },
          ],
          as: '_broadcastReferralCount',
        },
      },
      {
        $addFields: {
          _broadcastMetric: { $ifNull: [{ $arrayElemAt: ['$_broadcastReferralCount.count', 0] }, 0] },
        },
      },
      { $match: { _broadcastMetric: metricOperator(filter.operator, Number(filter.amount)) } },
    )
  }

  if ((filter.type === 'deposits' || filter.type === 'withdrawals') && filter.currency && filter.operator && Number.isFinite(filter.amount)) {
    const ledgerType = filter.type === 'deposits' ? 'deposit' : 'withdraw_paid'
    const amountExpression = filter.type === 'deposits' ? '$available' : { $multiply: [{ $ifNull: ['$locked', 0] }, -1] }
    pipeline.push(
      {
        $lookup: {
          from: Ledger.collection.name,
          let: { targetTelegramId: '$tgId' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$userId', '$$targetTelegramId'] },
                    { $eq: ['$currency', filter.currency] },
                    { $eq: ['$type', ledgerType] },
                  ],
                },
              },
            },
            { $group: { _id: null, total: { $sum: amountExpression } } },
          ],
          as: '_broadcastFinanceTotal',
        },
      },
      {
        $addFields: {
          _broadcastMetric: { $ifNull: [{ $arrayElemAt: ['$_broadcastFinanceTotal.total', 0] }, 0] },
        },
      },
      { $match: { _broadcastMetric: metricOperator(filter.operator, Number(filter.amount)) } },
    )
  }

  if (!forCount) {
    pipeline.push({ $sort: { _id: 1 } })
    // Limit means the first N matching users, not N more users after a worker restart.
    if (filter.type === 'limit' && Number.isSafeInteger(filter.limit) && Number(filter.limit) > 0) {
      pipeline.push({ $limit: Number(filter.limit) })
    }
    if (afterObjectId && mongoose.isValidObjectId(afterObjectId)) {
      pipeline.push({ $match: { _id: { $gt: new mongoose.Types.ObjectId(afterObjectId) } } })
    }
    pipeline.push({ $project: { _id: 1, tgId: 1, blockedBot: 1 } })
  }
  return pipeline
}

export async function countEligibleUsers(filter: IBroadcastUserFilter = { type: 'all' }): Promise<number> {
  if (filter.type === 'all') return User.countDocuments(eligibleUserMatch)
  if (filter.type === 'limit') {
    const total = await User.countDocuments(eligibleUserMatch)
    return Math.min(total, Math.max(0, Number(filter.limit ?? 0)))
  }
  if (filter.type === 'balance' && filter.currency && filter.operator && Number.isFinite(filter.amount)) {
    return User.countDocuments({
      ...eligibleUserMatch,
      [`balances.${filter.currency}.available`]: metricOperator(filter.operator, Number(filter.amount)),
    })
  }
  const rows = await User.aggregate([...userPipeline(filter, undefined, true), { $count: 'count' }]).allowDiskUse(true)
  return Number(rows[0]?.count ?? 0)
}

export async function getBroadcastCounts(filter: IBroadcastUserFilter = { type: 'all' }): Promise<{
  registeredUsers: number
  eligibleUsers: number
  activeGroups: number
  matchingUsers: number
}> {
  const [registeredUsers, eligibleUsers, activeGroups, matchingUsers] = await Promise.all([
    User.countDocuments({ role: { $nin: ['admin', 'owner'] } }),
    User.countDocuments(eligibleUserMatch),
    GroupTarget.countDocuments({ status: 'active' }),
    countEligibleUsers(filter),
  ])
  return { registeredUsers, eligibleUsers, activeGroups, matchingUsers }
}


export function isMoneyCurrencyForBroadcast(value: unknown): value is Currency {
  return value === 'IRT' || value === 'TON'
}
