import type { MoneyCurrency } from '../money'
import { Ledger, Match, User } from '../models'

export interface DuelStats {
  total: number
  bet: number
  friendly: number
  wins: number
  losses: number
  draws: number
}

export interface FinanceStats {
  deposited: Record<MoneyCurrency, number>
  withdrawn: Record<MoneyCurrency, number>
  won: Record<MoneyCurrency, number>
  lost: Record<MoneyCurrency, number>
  referralIRT: number
  groupReward: Record<MoneyCurrency, number>
  referral: Record<MoneyCurrency, number>
  registrationBonus: Record<MoneyCurrency, number>
  available: Record<MoneyCurrency, number>
  locked: Record<MoneyCurrency, number>
}

export async function getDuelStats(userId: number): Promise<DuelStats> {
  const matches = await Match.find({ status: 'settled', currency: { $in: ['IRT', 'TON'] }, $or: [{ p1: userId }, { p2: userId }] })
    .select('p1 p2 mode outcome winner')
    .lean()
  const stats: DuelStats = { total: matches.length, bet: 0, friendly: 0, wins: 0, losses: 0, draws: 0 }
  for (const m of matches) {
    if ((m.mode ?? 'bet') === 'friendly') stats.friendly++
    else stats.bet++
    if (m.winner === null || m.winner === undefined || m.outcome === 'draw' || m.outcome === 'draw_timeout') {
      stats.draws++
      continue
    }
    const userSlot = m.p1 === userId ? 1 : 2
    if (m.winner === userSlot) stats.wins++
    else stats.losses++
  }
  return stats
}

export async function getFinanceStats(userId: number): Promise<FinanceStats> {
  const [u, ledgerRows, matches] = await Promise.all([
    User.findOne({ tgId: userId }).select('balances').lean(),
    Ledger.aggregate([
      { $match: { userId, currency: { $in: ['IRT', 'TON'] } } },
      { $group: { _id: { currency: '$currency', type: '$type' }, available: { $sum: '$available' }, locked: { $sum: '$locked' } } },
    ]),
    Match.find({ status: 'settled', currency: { $in: ['IRT', 'TON'] }, mode: { $ne: 'friendly' }, $or: [{ p1: userId }, { p2: userId }] })
      .select('p1 p2 currency amount fee outcome winner')
      .lean(),
  ])
  const ledgerTotal = (currency: MoneyCurrency, type: string, field: 'available' | 'locked') =>
    Number(ledgerRows.find((r: any) => r._id.currency === currency && r._id.type === type)?.[field] ?? 0)
  const deposited = { IRT: ledgerTotal('IRT', 'deposit', 'available'), TON: ledgerTotal('TON', 'deposit', 'available') }
  const referral = { IRT: ledgerTotal('IRT', 'referral', 'available'), TON: ledgerTotal('TON', 'referral', 'available') }
  const registrationBonus = { IRT: ledgerTotal('IRT', 'registration_bonus', 'available'), TON: ledgerTotal('TON', 'registration_bonus', 'available') }
  const groupReward = { IRT: ledgerTotal('IRT', 'group_reward', 'available'), TON: ledgerTotal('TON', 'group_reward', 'available') }
  const withdrawn = {
    IRT: -ledgerTotal('IRT', 'withdraw_paid', 'locked'),
    TON: -ledgerTotal('TON', 'withdraw_paid', 'locked'),
  }
  const won: Record<MoneyCurrency, number> = { IRT: 0, TON: 0 }
  const lost: Record<MoneyCurrency, number> = { IRT: 0, TON: 0 }
  for (const m of matches) {
    const cur = m.currency as MoneyCurrency
    const slot = m.p1 === userId ? 1 : 2
    const fee = Number(m.fee ?? 0)
    if ((m.outcome === 'win' || m.outcome === 'win_timeout') && m.winner === slot) {
      won[cur] += Math.max(0, Number(m.amount) - fee)
    } else if (m.outcome === 'win' || m.outcome === 'win_timeout') {
      lost[cur] += Number(m.amount)
    } else {
      lost[cur] += fee / 2
    }
  }
  return {
    deposited,
    withdrawn,
    won,
    lost,
    referralIRT: referral.IRT,
    groupReward,
    referral,
    registrationBonus,
    available: {
      IRT: Number(u?.balances?.IRT?.available ?? 0),
      TON: Number(u?.balances?.TON?.available ?? 0),
    },
    locked: {
      IRT: Number(u?.balances?.IRT?.locked ?? 0),
      TON: Number(u?.balances?.TON?.locked ?? 0),
    },
  }
}
