import { model, Schema } from 'mongoose'
import type { Currency, MoneyCurrency } from '../money'

const balance = () => ({ available: { type: Number, default: 0 }, locked: { type: Number, default: 0 } })

export type Balances = Record<MoneyCurrency, { available: number; locked: number }>
export const zeroBalances = (): Balances => ({
  IRT: { available: 0, locked: 0 },
  TON: { available: 0, locked: 0 },
})

// ───────────── User ─────────────
export interface IUser {
  tgId: number
  refCode?: string
  firstName?: string
  username?: string
  lang: 'fa' | 'en' | null
  role: 'user' | 'admin' | 'owner'
  referrerId: number | null
  referralPaid: boolean
  referralBonusCount?: number
  registrationBonusPaid?: boolean
  registrationBonusPending?: boolean
  duelsPlayed: number
  blockedBot: boolean
  balances: Balances
  createdAt?: Date
}
const userSchema = new Schema<IUser>(
  {
    tgId: { type: Number, required: true, unique: true },
    refCode: { type: String, unique: true, sparse: true },
    firstName: String,
    username: String,
    lang: { type: String, default: null },
    role: { type: String, default: 'user' },
    referrerId: { type: Number, default: null, index: true },
    referralPaid: { type: Boolean, default: false },
    referralBonusCount: { type: Number, default: 0 },
    registrationBonusPaid: { type: Boolean, default: false },
    registrationBonusPending: { type: Boolean, default: false },
    duelsPlayed: { type: Number, default: 0 },
    blockedBot: { type: Boolean, default: false },
    balances: { IRT: balance(), TON: balance() },
  },
  { timestamps: true, versionKey: false },
)
export const User = model<IUser>('User', userSchema)

// ───────────── Ticket (a stake waiting in the matchmaking queue) ─────────────
export interface ITicket {
  _id: string
  userId: number
  currency: MoneyCurrency
  amount: number
  mode: 'bet' | 'friendly'
  status: 'queued' | 'matched' | 'cancelled'
  matchId?: string
  createdAtMs: number
  queueTimeoutSeconds?: number
  timingScheduledAt?: Date
}
const ticketSchema = new Schema<ITicket>(
  {
    _id: { type: String },
    userId: { type: Number, required: true, index: true },
    currency: { type: String, required: true },
    amount: { type: Number, required: true },
    mode: { type: String, enum: ['bet', 'friendly'], default: 'bet', index: true },
    status: { type: String, default: 'queued' },
    matchId: String,
    createdAtMs: { type: Number, required: true },
    queueTimeoutSeconds: Number,
    timingScheduledAt: Date,
  },
  { versionKey: false },
)
ticketSchema.index({ status: 1, createdAtMs: 1 })
ticketSchema.index({ status: 1, _id: 1 })
export const Ticket = model<ITicket>('Ticket', ticketSchema)

// ───────────── Match ─────────────
export interface IMatch {
  _id: string
  currency: MoneyCurrency
  amount: number
  mode: 'bet' | 'friendly'
  durationSeconds?: number
  reminderSent?: boolean
  timingScheduledAt?: Date
  maxMessages?: number
  p1: number
  p2: number
  c1: 'r' | 'p' | 's' | null
  c2: 'r' | 'p' | 's' | null
  status: 'choosing' | 'settled'
  deadline: number
  fees: { win: number; draw: number; winTimeout: number; drawTimeout: number }
  outcome?: string
  winner?: number | null
  fee?: number
  settledAt?: Date
  createdAt?: Date
}
const matchSchema = new Schema<IMatch>(
  {
    _id: { type: String },
    currency: { type: String, required: true },
    amount: { type: Number, required: true },
    mode: { type: String, enum: ['bet', 'friendly'], default: 'bet', index: true },
    durationSeconds: { type: Number },
    reminderSent: { type: Boolean, default: false },
    timingScheduledAt: Date,
    maxMessages: Number,
    p1: { type: Number, required: true, index: true },
    p2: { type: Number, required: true, index: true },
    c1: { type: String, default: null },
    c2: { type: String, default: null },
    status: { type: String, default: 'choosing' },
    deadline: { type: Number, required: true },
    fees: { win: Number, draw: Number, winTimeout: Number, drawTimeout: Number },
    outcome: String,
    winner: Number,
    fee: Number,
    settledAt: Date,
  },
  { timestamps: true, versionKey: false },
)
matchSchema.index({ status: 1, deadline: 1 })
matchSchema.index({ status: 1, _id: 1 })
export const Match = model<IMatch>('Match', matchSchema)

// ───────────── Ledger (append-only, the unique key makes every money operation idempotent) ─────────────
const ledgerSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    userId: { type: Number, required: true, index: true }, // 0 = house
    currency: { type: String, required: true },
    type: { type: String, required: true },
    available: { type: Number, default: 0 },
    locked: { type: Number, default: 0 },
    ref: String,
  },
  { timestamps: { createdAt: 'at', updatedAt: false }, versionKey: false },
)
ledgerSchema.index({ userId: 1, type: 1, currency: 1 })
export const Ledger = model('Ledger', ledgerSchema)

// ───────────── House (fee income) ─────────────
export const House = model(
  'House',
  new Schema(
    { _id: String, balances: { IRT: { type: Number, default: 0 }, TON: { type: Number, default: 0 } } },
    { versionKey: false },
  ),
)

// ───────────── Payments / Withdrawals ─────────────
export interface IPayment {
  _id: string
  userId: number
  currency: MoneyCurrency
  amount: number
  status: 'pending' | 'paid' | 'failed'
  provider?: string
  providerRef?: string
  txId?: string
}
export const Payment = model<IPayment>(
  'Payment',
  new Schema<IPayment>(
    {
      _id: { type: String },
      userId: { type: Number, required: true, index: true },
      currency: { type: String, required: true },
      amount: { type: Number, required: true },
      status: { type: String, default: 'pending' },
      provider: String,
      providerRef: { type: String, index: true },
      txId: { type: String, unique: true, sparse: true },
    },
    { timestamps: true, versionKey: false },
  ),
)

// ───────────── Manual deposit invoices ─────────────
// Invoice destinations and user identity are snapshotted at creation time so later admin
// setting changes never alter the instructions attached to an existing invoice.
export interface IManualDepositInvoice {
  invoiceNumber: number
  userId: number
  userFirstName: string
  userUsername: string
  currency: MoneyCurrency
  amount: number
  status: 'pending' | 'approved' | 'rejected'
  cardNumber: string
  cardHolder: string
  supportUsername: string
  reviewedBy?: number
  reviewedAt?: Date
  reviewReason?: string
  createdAt?: Date
  updatedAt?: Date
}

const manualDepositInvoiceSchema = new Schema<IManualDepositInvoice>(
  {
    invoiceNumber: { type: Number, required: true, unique: true, index: true },
    userId: { type: Number, required: true, index: true },
    userFirstName: { type: String, default: '' },
    userUsername: { type: String, default: '' },
    currency: { type: String, required: true, enum: ['IRT', 'TON'] },
    amount: { type: Number, required: true, min: 1 },
    status: { type: String, required: true, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
    cardNumber: { type: String, default: '' },
    cardHolder: { type: String, default: '' },
    supportUsername: { type: String, default: '' },
    reviewedBy: Number,
    reviewedAt: Date,
    reviewReason: { type: String, default: '' },
  },
  { timestamps: true, versionKey: false },
)
manualDepositInvoiceSchema.index({ status: 1, createdAt: -1 })
manualDepositInvoiceSchema.index({ userId: 1, createdAt: -1 })
export const ManualDepositInvoice = model<IManualDepositInvoice>('ManualDepositInvoice', manualDepositInvoiceSchema)

// ───────────── Native TON on-chain deposit invoices ─────────────
// txHash is produced by the blockchain; invoiceNumber/comment identify the intended payment.
export interface ITonDepositInvoice {
  invoiceNumber: number
  userId: number
  currency: 'TON'
  amount: number // integer nanoTON
  recipientAddress: string
  comment: string
  paymentUrl: string // empty on testnet (no Tonkeeper deep link)
  network?: 'mainnet' | 'testnet'
  status: 'pending' | 'paid'
  txHash?: string
  sourceAddress?: string
  paidAt?: Date
  createdAt?: Date
  updatedAt?: Date
}
const tonDepositInvoiceSchema = new Schema<ITonDepositInvoice>(
  {
    invoiceNumber: { type: Number, required: true, unique: true, index: true },
    userId: { type: Number, required: true, index: true },
    currency: { type: String, required: true, enum: ['TON'], default: 'TON' },
    amount: { type: Number, required: true, min: 1 },
    recipientAddress: { type: String, required: true },
    comment: { type: String, required: true, unique: true },
    paymentUrl: { type: String, default: '' },
    network: { type: String, enum: ['mainnet', 'testnet'], default: 'mainnet', index: true },
    status: { type: String, required: true, enum: ['pending', 'paid'], default: 'pending', index: true },
    txHash: { type: String, unique: true, sparse: true, index: true },
    sourceAddress: { type: String, default: '' },
    paidAt: Date,
  },
  { timestamps: true, versionKey: false },
)
tonDepositInvoiceSchema.index({ userId: 1, createdAt: -1 })
tonDepositInvoiceSchema.index({ status: 1, createdAt: -1 })
export const TonDepositInvoice = model<ITonDepositInvoice>('TonDepositInvoice', tonDepositInvoiceSchema)

// Atomic sequence for human-friendly numeric invoice codes (starts at 100000).
export const Sequence = model(
  'Sequence',
  new Schema({ _id: String, value: { type: Number, required: true, default: 99_999 } }, { versionKey: false }),
)

export interface IWithdrawal {
  _id: string
  userId: number
  currency: MoneyCurrency
  amount: number
  /** Fixed fee snapshot in currency's stored units. Optional for older invoices. */
  fee?: number
  /** Net amount owner must send to the user. Optional for older invoices. */
  payoutAmount?: number
  dest: string
  bankName?: string
  fullName?: string
  reviewReason?: string
  reviewedBy?: number
  reviewedAt?: Date
  status: 'pending' | 'paid' | 'rejected'
  createdAt?: Date
  updatedAt?: Date
}
export const Withdrawal = model<IWithdrawal>(
  'Withdrawal',
  new Schema<IWithdrawal>(
    {
      _id: { type: String },
      userId: { type: Number, required: true, index: true },
      currency: { type: String, required: true },
      amount: { type: Number, required: true },
      fee: { type: Number, min: 0, default: 0 },
      payoutAmount: { type: Number, min: 0 },
      dest: { type: String, required: true },
      bankName: { type: String, default: '' },
      fullName: { type: String, default: '' },
      reviewReason: { type: String, default: '' },
      reviewedBy: Number,
      reviewedAt: Date,
      status: { type: String, default: 'pending', index: true },
    },
    { timestamps: true, versionKey: false },
  ),
)

// ───────────── Known groups and durable broadcast campaigns ─────────────
export interface IGroupTarget {
  chatId: string
  title: string
  username?: string
  type: 'group' | 'supergroup'
  status: 'active' | 'left'
  lastSeenAt?: Date
  addedAt?: Date
}
const groupTargetSchema = new Schema<IGroupTarget>(
  {
    chatId: { type: String, required: true, unique: true, index: true },
    title: { type: String, default: '' },
    username: { type: String, default: '' },
    type: { type: String, enum: ['group', 'supergroup'], required: true },
    status: { type: String, enum: ['active', 'left'], default: 'active', index: true },
    lastSeenAt: Date,
    addedAt: { type: Date, default: Date.now },
  },
  { timestamps: true, versionKey: false },
)
groupTargetSchema.index({ status: 1, _id: 1 })
export const GroupTarget = model<IGroupTarget>('GroupTarget', groupTargetSchema)

export type BroadcastAudience = 'users' | 'groups' | 'both'
export type BroadcastMetric = 'all' | 'limit' | 'balance' | 'referrals' | 'deposits' | 'withdrawals'
export interface IBroadcastUserFilter {
  type: BroadcastMetric
  limit?: number
  currency?: Currency
  operator?: 'gt' | 'lt'
  amount?: number
}
export interface IBroadcastCampaign {
  _id: string
  ownerId: number
  sourceChatId: string
  sourceMessageId: number
  audience: BroadcastAudience
  userFilter?: IBroadcastUserFilter
  groupLimit?: number
  totalUsers: number
  totalGroups: number
  estimatedUsers: number
  estimatedGroups: number
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  sentUsers: number
  failedUsers: number
  sentGroups: number
  failedGroups: number
  processedUsers: number
  processedGroups: number
  lastUserObjectId?: string
  lastGroupObjectId?: string
  startedAt?: Date
  finishedAt?: Date
  lastError?: string
  createdAt?: Date
  updatedAt?: Date
}
const broadcastCampaignSchema = new Schema<IBroadcastCampaign>(
  {
    _id: { type: String },
    ownerId: { type: Number, required: true, index: true },
    sourceChatId: { type: String, required: true },
    sourceMessageId: { type: Number, required: true },
    audience: { type: String, enum: ['users', 'groups', 'both'], required: true },
    userFilter: { type: Schema.Types.Mixed },
    groupLimit: Number,
    totalUsers: { type: Number, default: 0 },
    totalGroups: { type: Number, default: 0 },
    estimatedUsers: { type: Number, default: 0 },
    estimatedGroups: { type: Number, default: 0 },
    status: { type: String, enum: ['queued', 'running', 'completed', 'failed', 'cancelled'], default: 'queued', index: true },
    sentUsers: { type: Number, default: 0 },
    failedUsers: { type: Number, default: 0 },
    sentGroups: { type: Number, default: 0 },
    failedGroups: { type: Number, default: 0 },
    processedUsers: { type: Number, default: 0 },
    processedGroups: { type: Number, default: 0 },
    lastUserObjectId: String,
    lastGroupObjectId: String,
    startedAt: Date,
    finishedAt: Date,
    lastError: String,
  },
  { timestamps: true, versionKey: false },
)
broadcastCampaignSchema.index({ ownerId: 1, createdAt: -1 })
export const BroadcastCampaign = model<IBroadcastCampaign>('BroadcastCampaign', broadcastCampaignSchema)

export interface IBroadcastDelivery {
  campaignId: string
  targetType: 'user' | 'group'
  targetId: string
  chatId: string
  status: 'pending' | 'sending' | 'sent' | 'failed'
  attempts: number
  error?: string
  updatedAt?: Date
}
const broadcastDeliverySchema = new Schema<IBroadcastDelivery>(
  {
    campaignId: { type: String, required: true },
    targetType: { type: String, enum: ['user', 'group'], required: true },
    targetId: { type: String, required: true },
    chatId: { type: String, required: true },
    status: { type: String, enum: ['pending', 'sending', 'sent', 'failed'], default: 'pending', index: true },
    attempts: { type: Number, default: 0 },
    error: { type: String, default: '' },
  },
  { timestamps: true, versionKey: false },
)
broadcastDeliverySchema.index({ campaignId: 1, targetType: 1, targetId: 1 }, { unique: true })
broadcastDeliverySchema.index({ campaignId: 1, targetType: 1, status: 1 })
export const BroadcastDelivery = model<IBroadcastDelivery>('BroadcastDelivery', broadcastDeliverySchema)


// ───────────── Group game configuration and duels (shared with group-worker) ─────────────
export const GroupConfig = model('GroupConfig', new Schema({
  chatId: { type: String, unique: true, index: true }, title: String, activatorId: Number,
  language: { type: String, enum: ['fa', 'en'], default: 'fa' }, allowedModes: [String], allowedCurrencies: [String],
  inviteTimeoutSeconds: Number, betInviteTimeoutSeconds: Number, friendlyInviteTimeoutSeconds: Number, betTimeoutSeconds: Number, friendlyTimeoutSeconds: Number, enabled: Boolean,
}, { timestamps: true, versionKey: false, strict: false }))
export const GroupDuel = model('GroupDuel', new Schema({
  _id: String, chatId: { type: String, index: true }, activatorId: Number, initiatorId: Number, opponentId: Number, openChallenge: { type: Boolean, default: false },
  currency: String, amount: Number, mode: String, status: { type: String, index: true }, inviteDeadline: Number,
  deadline: Number, reminderAt: Number, reminderSent: { type: Boolean, default: false }, reminderProcessingAt: Date, p1Choice: String, p2Choice: String, outcome: String, winnerId: Number, fee: Number, payout1: Number, payout2: Number, reward: Number,
  rewardPaid: Boolean, timeoutSettled: { type: Boolean, default: false }, timeoutResultSentAt: Date, rewardPercent: Number, settledAt: Date, inviteMessageId: Number, gameMessageId: Number, timingScheduledAt: Date,
  triggerMessageId: Number, opponentInviteEphemeralId: Number, initiatorWaitEphemeralId: Number,
  initiatorGameEphemeralId: Number, opponentGameEphemeralId: Number, initiatorReminderEphemeralId: Number, opponentReminderEphemeralId: Number, initiatorRematchEphemeralId: Number,
  opponentRematchEphemeralId: Number, gameFormsSent: { type: Boolean, default: false }, rematchFormsSent: { type: Boolean, default: false }, resultMessageId: Number,
  rematchOf: { type: String, index: true }, rematchDuelId: String, lifecycleVersion: Number, publicNoticeMessageIds: { type: [Number], default: [] }, reminderAnnouncementMessageId: Number,
}, { timestamps: true, versionKey: false, strict: false }))
GroupDuel.schema.index({ status: 1, inviteDeadline: 1 })
GroupDuel.schema.index({ status: 1, deadline: 1 })

// ───────────── Settings (single document, edited by admins) ─────────────
export const SettingsModel = model(
  'Settings',
  new Schema({ _id: String }, { strict: false, versionKey: false }),
)

export const AdminLog = model(
  'AdminLog',
  new Schema(
    { adminId: Number, action: String, detail: String },
    { timestamps: { createdAt: 'at', updatedAt: false }, versionKey: false },
  ),
)
