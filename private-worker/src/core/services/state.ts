import type { Currency } from '../money'
import type { BroadcastAudience, IBroadcastUserFilter } from '../models'
import { redis } from '../redis'

/** Short-lived dialogue state ("waiting for the deposit amount…"), kept in Redis. */
export type St =
  | { s: 'dep'; cur: Currency }
  | { s: 'wd_amt'; cur: Currency }
  | { s: 'wd_dest'; cur: Currency; amount: number; fee?: number }
  | { s: 'wd_name'; cur: 'IRT'; amount: number; fee?: number; dest: string; bankName: string }
  | { s: 'wd_confirm'; cur: 'IRT'; amount: number; fee?: number; dest: string; bankName: string; fullName: string }
  | { s: 'wd_confirm_ton'; cur: 'TON'; amount: number; fee?: number; dest: string }
  | { s: 'admin_deposit_reject_reason'; invoiceNumber: number; chatId?: number; messageId?: number }
  | { s: 'admin_withdraw_reject_reason'; withdrawalId: string; chatId?: number; messageId?: number; originalText?: string }
  | { s: 'admin_setting'; key: string }
  | { s: 'admin_backup_interval' }
  | { s: 'admin_invoice_search' }
  | { s: 'admin_channel_add' }
  | {
      s: 'admin_broadcast'
      step: 'user_filter' | 'user_limit' | 'user_condition' | 'group_limit' | 'message'
      audience: BroadcastAudience
      userFilter?: IBroadcastUserFilter
      pendingFilter?: 'balance' | 'referrals' | 'deposits' | 'withdrawals'
      groupLimit?: number
      counts?: { registeredUsers: number; eligibleUsers: number; activeGroups: number; matchingUsers: number }
    }
  | {
      s: 'admin_broadcast_confirm'
      audience: BroadcastAudience
      userFilter?: IBroadcastUserFilter
      groupLimit?: number
      sourceChatId: string
      sourceMessageId: number
      totalUsers: number
      totalGroups: number
      targetUsers: number
      targetGroups: number
    }

const key = (id: number) => `st:${id}`

export async function getState(id: number): Promise<St | null> {
  const raw = await redis.get(key(id))
  return raw ? (JSON.parse(raw) as St) : null
}
export const setState = (id: number, st: St) => redis.set(key(id), JSON.stringify(st), 'EX', 900)
export const clearState = (id: number) => redis.del(key(id))
