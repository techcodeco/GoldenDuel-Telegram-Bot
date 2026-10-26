import { redis } from '../runtime'
import { User, Ledger } from '../models/index'
import type { GroupFlow } from '../contracts/group'
export async function setFlow(uid: number, value: GroupFlow) { await redis.set(`gw:flow:${uid}`, JSON.stringify(value), 'EX', 600) }
export async function getFlow(uid: number): Promise<GroupFlow|null> { const v=await redis.get(`gw:flow:${uid}`); return v?JSON.parse(v):null }
export async function reserve(uid:number, cur:string, amount:number, session:any) {
  const r=await User.updateOne({tgId:uid,[`balances.${cur}.available`]:{$gt:amount}},{$inc:{[`balances.${cur}.available`]:-amount,[`balances.${cur}.locked`]:amount}}, {session})
  if (!r.modifiedCount) throw new Error('INSUFFICIENT_BALANCE')
  await Ledger.create([{key:`group:reserve:${uid}:${cur}:${amount}:${Date.now()}:${Math.random().toString(36).slice(2)}`,userId:uid,currency:cur,type:'group_reserve',available:-amount,locked:amount,ref:'group'}],{session})
}
export async function release(uid:number, cur:string, amount:number, key:string, session:any) {
  const exists=await Ledger.exists({key}).session(session); if(exists) return
  const r=await User.updateOne({tgId:uid,[`balances.${cur}.locked`]:{$gte:amount}},{$inc:{[`balances.${cur}.available`]:amount,[`balances.${cur}.locked`]:-amount}},{session})
  if(!r.modifiedCount) throw new Error('LOCKED_BALANCE_INVARIANT')
  await Ledger.create([{key,userId:uid,currency:cur,type:'group_release',available:amount,locked:-amount,ref:key}],{session})
}
