import { bot } from './bot/instance'
import { curName } from './bot/keyboards'
import { notify } from './bot/notify'
import {
  DEAD_PAYMENTS,
  DEAD_STREAM,
  GROUP,
  GROUP_PAYMENTS,
  STREAM,
  STREAM_PAYMENTS,
} from './config'
import { startConsumer } from './consumer'
import { type Lang, t } from './i18n'
import { withUserLock } from './lock'
import { formatAmount } from './money'
import { redis } from './redis'
import { fullUser, getUser } from './services/users'
import { creditDeposit } from './services/wallet'

const userIdOf = (u: any): number | undefined =>
  u.message?.from?.id ?? u.callback_query?.from?.id ?? u.my_chat_member?.from?.id ?? u.edited_message?.from?.id ?? u.message_reaction?.user?.id

/** Telegram updates written by the gateway → grammY, one user at a time, never the same update twice. */
async function handleUpdateEntry(f: Record<string, string>): Promise<void> {
  if (!f.d) throw new Error('update_entry_missing_payload')
  const seenKey = f.u ? `dd:${f.u}` : ''
  const update = JSON.parse(f.d)
  const handleOnce = async () => {
    // This second check must run after acquiring the user lock. Otherwise two workers can
    // both pass the first check, queue behind the lock, and execute the same update twice.
    if (seenKey && (await redis.exists(seenKey))) return
    await bot.handleUpdate(update)
    if (seenKey) await redis.set(seenKey, '1', 'EX', 86_400)
  }
  const uid = userIdOf(update)
  if (uid) await withUserLock(uid, handleOnce)
  else await handleOnce()
}

/** A payment confirmed by YOUR payment service: credit once, then tell the user. */
async function handlePaymentEntry(f: Record<string, string>): Promise<void> {
  if (!f.paymentId) return
  const r = await creditDeposit(f.paymentId, f.txId)
  if (!r) return // unknown or already credited
  const lang: Lang = (await getUser(r.userId))?.lang ?? 'en'
  const u = await fullUser(r.userId)
  await notify(
    r.userId,
    t(lang, 'deposit.credited', {
      amount: formatAmount(r.amount, r.currency),
      cur: curName(lang, r.currency),
      balance: formatAmount(u?.balances[r.currency].available ?? 0, r.currency),
    }),
  )
}

export async function consumerStreams(): Promise<() => Promise<void>> {
  const stops = await Promise.all([
    startConsumer({ stream: STREAM, group: GROUP, dead: DEAD_STREAM, handle: handleUpdateEntry }),
    startConsumer({ stream: STREAM_PAYMENTS, group: GROUP_PAYMENTS, dead: DEAD_PAYMENTS, handle: handlePaymentEntry }),
  ])
  return async () => {
    await Promise.all(stops.map((s) => s()))
  }
}
