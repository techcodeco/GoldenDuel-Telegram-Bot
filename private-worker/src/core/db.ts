import mongoose from 'mongoose'
import { MONGO_URI } from './config'
import { BroadcastCampaign, BroadcastDelivery, GroupTarget, House, Ledger, ManualDepositInvoice, Match, Payment, Sequence, Ticket, TonDepositInvoice, User, Withdrawal } from './models'

export async function connectDb(maxPoolSize = 50): Promise<void> {
  mongoose.set('strictQuery', true)
  await mongoose.connect(MONGO_URI, { maxPoolSize, serverSelectionTimeoutMS: 10_000 })
  // Build indexes (unique keys are what make the money logic idempotent)
  await Promise.all([User, Match, Ticket, Ledger, Payment, ManualDepositInvoice, TonDepositInvoice, Sequence, Withdrawal, House, GroupTarget, BroadcastCampaign, BroadcastDelivery].map((m) => m.init()))
  await House.updateOne({ _id: 'house' }, { $setOnInsert: { balances: { IRT: 0, TON: 0 } } }, { upsert: true })
}

export async function closeDb(): Promise<void> {
  await mongoose.disconnect()
}
