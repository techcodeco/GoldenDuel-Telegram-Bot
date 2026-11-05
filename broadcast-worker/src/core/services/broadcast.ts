import mongoose from 'mongoose'
import { BroadcastDelivery, GroupTarget, Ledger, User, type IBroadcastUserFilter } from '../models'

const eligibleUserMatch = {
  role: { $nin: ['admin', 'owner'] },
  blockedBot: { $ne: true },
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

export function createBroadcastUserCursor(filter: IBroadcastUserFilter, afterObjectId?: string) {
  return User.aggregate(userPipeline(filter, afterObjectId, false)).allowDiskUse(true).cursor({ batchSize: 250 })
}

export function createBroadcastGroupCursor(afterObjectId?: string, limit?: number) {
  const pipeline: any[] = [{ $match: { status: 'active' } }, { $sort: { _id: 1 } }]
  if (Number.isSafeInteger(limit) && Number(limit) > 0) pipeline.push({ $limit: Number(limit) })
  if (afterObjectId && mongoose.isValidObjectId(afterObjectId)) {
    pipeline.push({ $match: { _id: { $gt: new mongoose.Types.ObjectId(afterObjectId) } } })
  }
  pipeline.push({ $project: { _id: 1, chatId: 1, title: 1, type: 1 } })
  return GroupTarget.aggregate(pipeline).allowDiskUse(true).cursor({ batchSize: 100 })
}

export async function ensureDelivery(campaignId: string, targetType: 'user' | 'group', targetId: string, chatId: string) {
  return BroadcastDelivery.findOneAndUpdate(
    { campaignId, targetType, targetId },
    { $setOnInsert: { campaignId, targetType, targetId, chatId, status: 'pending', attempts: 0, error: '' } },
    { upsert: true, new: true },
  ).lean()
}

export async function recordDeliveryResult(
  campaignId: string,
  targetType: 'user' | 'group',
  targetId: string,
  status: 'sent' | 'failed' | 'unknown',
  error = '',
) {
  await BroadcastDelivery.updateOne(
    { campaignId, targetType, targetId },
    { $set: { status, error: error.slice(0, 500) } },
  )
}

export async function summarizeCampaignDeliveries(campaignId: string) {
  const rows = await BroadcastDelivery.aggregate([
    { $match: { campaignId } },
    { $group: { _id: { targetType: '$targetType', status: '$status' }, count: { $sum: 1 } } },
  ])
  const summary = { sentUsers: 0, failedUsers: 0, unknownUsers: 0, sentGroups: 0, failedGroups: 0, unknownGroups: 0 }
  for (const row of rows) {
    const type = row._id.targetType
    const status = row._id.status
    if (type === 'user' && status === 'sent') summary.sentUsers += row.count
    else if (type === 'user' && status === 'failed') summary.failedUsers += row.count
    else if (type === 'user' && status === 'unknown') summary.unknownUsers += row.count
    else if (type === 'group' && status === 'sent') summary.sentGroups += row.count
    else if (type === 'group' && status === 'failed') summary.failedGroups += row.count
    else if (type === 'group' && status === 'unknown') summary.unknownGroups += row.count
  }
  return summary
}

