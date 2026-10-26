import type { Currency } from '../money'
import { redis } from '../redis'

/** Redis state of a user: `q:<ticketId>` = waiting in queue, `m:<matchId>` = inside a match. */
export const userStateKey = (userId: number) => `mm:user:${userId}`
export type DuelMode = 'bet' | 'friendly'
export const queueKey = (cur: Currency, amount: number, mode: DuelMode = 'bet') =>
  mode === 'friendly' ? `mm:friendly:${cur}:${amount}` : `mm:${cur}:${amount}`

const JOIN = `
-- KEYS[1]=queue KEYS[2]=userState
-- ARGV: 1 userId, 2 ticketId, 3 nowMs, 4 matchId, 5 queuedTtl, 6 matchTtl, 7 statePrefix
if redis.call('EXISTS', KEYS[2]) == 1 then return {'busy','','','',''} end
local member = ARGV[1] .. '|' .. ARGV[2]
local ghosts = {}
while true do
  local popped = redis.call('ZPOPMIN', KEYS[1])
  if #popped == 0 then break end
  local m = popped[1]
  local sep = string.find(m, '|', 1, true)
  local oppUser = string.sub(m, 1, sep - 1)
  local oppTicket = string.sub(m, sep + 1)
  local oppKey = ARGV[7] .. oppUser
  if redis.call('GET', oppKey) == 'q:' .. oppTicket then
    redis.call('SET', oppKey, 'm:' .. ARGV[4], 'EX', ARGV[6])
    redis.call('SET', KEYS[2], 'm:' .. ARGV[4], 'EX', ARGV[6])
    return {'matched', oppUser, oppTicket, ARGV[4], table.concat(ghosts, ',')}
  end
  ghosts[#ghosts + 1] = oppTicket
end
redis.call('ZADD', KEYS[1], ARGV[3], member)
redis.call('SET', KEYS[2], 'q:' .. ARGV[2], 'EX', ARGV[5])
return {'queued', '', '', '', table.concat(ghosts, ',')}
`

const CANCEL = `
-- KEYS[1]=queue KEYS[2]=userState; ARGV[1]=member ARGV[2]=expected state value
if redis.call('ZREM', KEYS[1], ARGV[1]) == 1 then
  if redis.call('GET', KEYS[2]) == ARGV[2] then redis.call('DEL', KEYS[2]) end
  return 1
end
return 0
`

const r = redis as any
redis.defineCommand('mmJoin', { numberOfKeys: 2, lua: JOIN })
redis.defineCommand('mmCancel', { numberOfKeys: 2, lua: CANCEL })

export type JoinResult =
  | { status: 'busy'; ghosts: string[] }
  | { status: 'queued'; ghosts: string[] }
  | { status: 'matched'; oppUserId: number; oppTicketId: string; matchId: string; ghosts: string[] }

export async function joinQueue(p: {
  userId: number
  ticketId: string
  currency: Currency
  amount: number
  mode?: DuelMode
  matchId: string
  queuedTtl: number
  matchTtl: number
}): Promise<JoinResult> {
  const res: string[] = await r.mmJoin(
    queueKey(p.currency, p.amount, p.mode ?? 'bet'),
    userStateKey(p.userId),
    String(p.userId),
    p.ticketId,
    Date.now(),
    p.matchId,
    p.queuedTtl,
    p.matchTtl,
    'mm:user:',
  )
  const ghosts = res[4] ? res[4].split(',') : []
  if (res[0] === 'busy') return { status: 'busy', ghosts: [] }
  if (res[0] === 'queued') return { status: 'queued', ghosts }
  return { status: 'matched', oppUserId: Number(res[1]), oppTicketId: res[2]!, matchId: res[3]!, ghosts }
}

/** true = the ticket was still in the queue and is now removed (safe to release the stake). */
export async function cancelQueue(t: {
  userId: number
  ticketId: string
  currency: Currency
  amount: number
  mode?: DuelMode
}): Promise<boolean> {
  const n = await r.mmCancel(
    queueKey(t.currency, t.amount, t.mode ?? 'bet'),
    userStateKey(t.userId),
    `${t.userId}|${t.ticketId}`,
    `q:${t.ticketId}`,
  )
  return n === 1
}
