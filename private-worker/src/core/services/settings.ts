import { redis, redisSub } from '../redis'
import type { Currency } from '../money'
import { SettingsModel } from '../models'
import type { Fees } from '../settle'

export interface Settings {
  version: number
  bets: Record<Currency, number[]>
  fees: Fees
  /** Percent of group-game house fees credited to the group activator (0..100). */
  groupRewardPercent: number
  /** Fixed withdrawal fee in the currency's stored units (IRT=toman, TON=nanoTON). */
  withdrawalFees: Record<Currency, number>
  limits: {
    minDeposit: Record<Currency, number>
    minWithdraw: Record<Currency, number>
    minDuelsForWithdraw: number
    minReferralsForWithdraw: number
  }
  referral: { rewardIRT: number; reward: Record<Currency, number>; maxPaidReferrals: number }
  registrationBonus: Record<Currency, number>
  features: { duelsEnabled: boolean; depositsEnabled: boolean; withdrawalsEnabled: boolean; chatEnabled: boolean }
  membership: { enabled: boolean; channels: Array<{ chatId: string; title: string; url: string }> }
  manualDeposit: {
    cardNumber: string
    cardHolder: string
    supportUsername: string
    tonAddress: string
  }
  match: { seconds: number; friendlySeconds: number }
  queue: { seconds: number; friendlySeconds: number }
  chat: { maxMessages: number; friendlyMaxMessages: number; profanityPenalty: Record<Currency, number> }
  bannedWords: string[]
}

export const DEFAULTS: Settings = {
  version: 1,
  bets: { IRT: [10_000, 20_000, 30_000, 50_000], TON: [100_000_000, 200_000_000, 500_000_000, 1_000_000_000] },
  fees: { win: 1000, draw: 500, winTimeout: 2000, drawTimeout: 1000 }, // 10% / 5% / 20% / 10%
  groupRewardPercent: 20,
  withdrawalFees: { IRT: 0, TON: 0 }, // Fixed flat fee, not a percentage
  limits: {
    minDeposit: { IRT: 20_000, TON: 100_000_000 },
    minWithdraw: { IRT: 100_000, TON: 200_000_000 },
    minDuelsForWithdraw: 3,
    minReferralsForWithdraw: 0,
  },
  referral: { rewardIRT: 5_000, reward: { IRT: 5_000, TON: 0 }, maxPaidReferrals: 100 },
  registrationBonus: { IRT: 0, TON: 0 },
  features: { duelsEnabled: true, depositsEnabled: true, withdrawalsEnabled: true, chatEnabled: true },
  membership: { enabled: true, channels: [] },
  manualDeposit: {
    cardNumber: '',
    cardHolder: '',
    supportUsername: '',
    tonAddress: '',
  },
  match: { seconds: 300, friendlySeconds: 120 },
  queue: { seconds: 300, friendlySeconds: 120 },
  chat: { maxMessages: 100, friendlyMaxMessages: 25, profanityPenalty: { IRT: 0, TON: 0 } },
  bannedWords: [],
}

const KEY = 'cfg:main'
const CHANNEL = 'cfg:invalidate'
let l1: { v: Settings; exp: number } | null = null

function merge<T>(base: T, over: unknown): T {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return (over ?? base) as T
  const out: any = { ...base }
  if (over && typeof over === 'object') {
    for (const k of Object.keys(base as object)) out[k] = merge((base as any)[k], (over as any)[k])
  }
  return out
}

async function loadFromMongo(): Promise<Settings> {
  await SettingsModel.updateOne({ _id: 'main' }, { $setOnInsert: DEFAULTS }, { upsert: true })
  const doc = await SettingsModel.findById('main').lean()
  return merge(DEFAULTS, doc)
}

/** Memory (30 s) → Redis (5 min) → Mongo. Admin changes invalidate every layer via pub/sub. */
export async function getSettings(): Promise<Settings> {
  if (l1 && l1.exp > Date.now()) return l1.v
  const raw = await redis.get(KEY)
  let v: Settings
  if (raw) v = merge(DEFAULTS, JSON.parse(raw))
  else {
    v = await loadFromMongo()
    await redis.set(KEY, JSON.stringify(v), 'EX', 300)
  }
  l1 = { v, exp: Date.now() + 30_000 }
  return v
}

export async function updateSettings(path: string, value: unknown): Promise<void> {
  await getSettings() // make sure the document exists
  await SettingsModel.updateOne({ _id: 'main' }, { $set: { [path]: value }, $inc: { version: 1 } })
  l1 = null
  await redis.del(KEY)
  await redis.publish(CHANNEL, '1')
}

export async function startSettingsSubscriber(): Promise<void> {
  await redisSub.subscribe(CHANNEL)
  redisSub.on('message', (channel) => {
    if (channel === CHANNEL) l1 = null
  })
}
