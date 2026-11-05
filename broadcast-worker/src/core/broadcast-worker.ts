import IORedis from 'ioredis'
import crypto from 'node:crypto'
import os from 'node:os'
import { Queue, Worker, type Job } from 'bullmq'
import { bot } from './bot/instance'
import { REDIS_URL } from './config'
import { logError } from './logger'
import { BroadcastCampaign, BroadcastDelivery, GroupTarget, User } from './models'
import { connectDb, closeDb } from './db'
import { BROADCAST_COMMAND_GROUP, BROADCAST_COMMAND_STREAM, BROADCAST_QUEUE_NAME, BROADCAST_WORKER_HEARTBEAT_PREFIX, BROADCAST_WORKER_HEARTBEAT_TTL_MS } from './broadcast-constants'
import { startConsumer } from './consumer'
import { redis, redisBlock, redisSub } from './redis'
import { startServerTelemetry } from './telemetry'
import {
  createBroadcastGroupCursor,
  createBroadcastUserCursor,
  ensureDelivery,
  recordDeliveryResult,
  summarizeCampaignDeliveries,
} from './services/broadcast'

const SENDS_PER_SECOND = Math.max(1, Math.min(20, Number(process.env.BROADCAST_SENDS_PER_SECOND ?? 15) || 15))
const SEND_INTERVAL_MS = Math.ceil(1000 / SENDS_PER_SECOND)
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const isRetryAfter = (error: any): number | undefined => {
  const value = Number(error?.parameters?.retry_after ?? error?.error?.parameters?.retry_after)
  return Number.isFinite(value) && value > 0 ? value : undefined
}
const errorDescription = (error: any) => String(error?.description ?? error?.message ?? error).slice(0, 500)
const isUnavailableUser = (error: any) => /bot was blocked by the user|user is deactivated|chat not found|can't initiate conversation/i.test(errorDescription(error))
const isGoneGroup = (error: any) => /bot was kicked|bot is not a member|chat not found|group chat was deleted/i.test(errorDescription(error))

async function copyToTarget(sourceChatId: string, sourceMessageId: number, targetChatId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const started = Date.now()
    try {
      await bot.api.copyMessage(targetChatId, sourceChatId, sourceMessageId)
      const elapsed = Date.now() - started
      if (elapsed < SEND_INTERVAL_MS) await sleep(SEND_INTERVAL_MS - elapsed)
      return { ok: true }
    } catch (error: any) {
      const retryAfter = isRetryAfter(error)
      const message = errorDescription(error)
      const retryable = retryAfter !== undefined || /network|timeout|econnreset|socket|fetch failed|temporar/i.test(message)
      if (retryable && attempt < 4) {
        await sleep(retryAfter !== undefined ? retryAfter * 1000 + 250 : Math.min(15_000, 500 * 2 ** attempt))
        continue
      }
      // Keep the per-target pacing even on permanent failures, so a campaign cannot flood retries.
      const elapsed = Date.now() - started
      if (elapsed < SEND_INTERVAL_MS) await sleep(SEND_INTERVAL_MS - elapsed)
      return { ok: false, error: message }
    }
  }
  return { ok: false, error: 'retry_limit_exceeded' }
}

async function updateTargetCheckpoint(campaignId: string, type: 'user' | 'group', objectId: string, status: 'sent' | 'failed' | 'unknown') {
  const path = type === 'user' ? 'lastUserObjectId' : 'lastGroupObjectId'
  const processedPath = type === 'user' ? 'processedUsers' : 'processedGroups'
  const sentPath = type === 'user' ? 'sentUsers' : 'sentGroups'
  const failedPath = type === 'user' ? 'failedUsers' : 'failedGroups'
  const unknownPath = type === 'user' ? 'unknownUsers' : 'unknownGroups'
  await BroadcastCampaign.updateOne(
    { _id: campaignId },
    { $set: { [path]: objectId }, $inc: { [processedPath]: 1, [status === 'sent' ? sentPath : status === 'failed' ? failedPath : unknownPath]: 1 } },
  )
}

async function processUserTargets(campaign: any): Promise<void> {
  if (!['users', 'both'].includes(campaign.audience)) return
  const filter = campaign.userFilter ?? { type: 'all' }
  const cursor = createBroadcastUserCursor(filter, campaign.lastUserObjectId)
  try {
    for await (const target of cursor as any) {
      const objectId = String(target._id)
      const targetId = String(target.tgId)
      const delivery = await ensureDelivery(campaign._id, 'user', targetId, targetId)
      if (delivery?.status === 'sent' || delivery?.status === 'failed' || delivery?.status === 'unknown') {
        // If a process died after writing the delivery result but before checkpointing, complete the checkpoint.
        await updateTargetCheckpoint(campaign._id, 'user', objectId, delivery.status)
        continue
      }
      await BroadcastDelivery.updateOne(
        { campaignId: campaign._id, targetType: 'user', targetId },
        { $set: { status: 'sending', chatId: targetId, error: '' }, $inc: { attempts: 1 } },
      )
      const result = await copyToTarget(campaign.sourceChatId, campaign.sourceMessageId, targetId)
      if (!result.ok && isUnavailableUser({ description: result.error })) {
        await User.updateOne({ tgId: Number(targetId) }, { $set: { blockedBot: true } }).catch(() => undefined)
      }
      await recordDeliveryResult(campaign._id, 'user', targetId, result.ok ? 'sent' : 'failed', result.ok ? '' : result.error)
      await updateTargetCheckpoint(campaign._id, 'user', objectId, result.ok ? 'sent' : 'failed')
    }
  } finally {
    await (cursor as any).close().catch(() => undefined)
  }
}

async function processGroupTargets(campaign: any): Promise<void> {
  if (!['groups', 'both'].includes(campaign.audience)) return
  const cursor = createBroadcastGroupCursor(campaign.lastGroupObjectId, campaign.groupLimit)
  try {
    for await (const target of cursor as any) {
      const objectId = String(target._id)
      const targetId = String(target.chatId)
      const delivery = await ensureDelivery(campaign._id, 'group', targetId, targetId)
      if (delivery?.status === 'sent' || delivery?.status === 'failed' || delivery?.status === 'unknown') {
        await updateTargetCheckpoint(campaign._id, 'group', objectId, delivery.status)
        continue
      }
      await BroadcastDelivery.updateOne(
        { campaignId: campaign._id, targetType: 'group', targetId },
        { $set: { status: 'sending', chatId: targetId, error: '' }, $inc: { attempts: 1 } },
      )
      const result = await copyToTarget(campaign.sourceChatId, campaign.sourceMessageId, targetId)
      if (!result.ok && isGoneGroup({ description: result.error })) {
        await GroupTarget.updateOne({ chatId: targetId }, { $set: { status: 'left', lastSeenAt: new Date() } }).catch(() => undefined)
      }
      await recordDeliveryResult(campaign._id, 'group', targetId, result.ok ? 'sent' : 'failed', result.ok ? '' : result.error)
      await updateTargetCheckpoint(campaign._id, 'group', objectId, result.ok ? 'sent' : 'failed')
    }
  } finally {
    await (cursor as any).close().catch(() => undefined)
  }
}

function reportText(campaign: any, summary: any, status: string, lang: 'fa' | 'en' | 'ar' | 'es' = 'fa'): string {
  const pendingUsers = Math.max(0, Number(campaign.estimatedUsers ?? 0) - summary.sentUsers - summary.failedUsers - Number(summary.unknownUsers ?? 0))
  const pendingGroups = Math.max(0, Number(campaign.estimatedGroups ?? 0) - summary.sentGroups - summary.failedGroups - Number(summary.unknownGroups ?? 0))
  const values = {
    fa: `📣 <b>گزارش نهایی پیام انبوه</b>\nشناسه کمپین: <code>${campaign._id}</code>\nوضعیت: <b>${status}</b>\n\n👤 کاربران هدف: ${campaign.estimatedUsers}\n✅ ارسال موفق به کاربران: ${summary.sentUsers}\n❌ ارسال ناموفق به کاربران: ${summary.failedUsers}\n❔ وضعیت نامشخص کاربران: ${summary.unknownUsers ?? 0}\n⏳ پردازش‌نشده کاربران: ${pendingUsers}\n\n👥 گروه‌های هدف: ${campaign.estimatedGroups}\n✅ ارسال موفق به گروه‌ها: ${summary.sentGroups}\n❌ ارسال ناموفق به گروه‌ها: ${summary.failedGroups}\n❔ وضعیت نامشخص گروه‌ها: ${summary.unknownGroups ?? 0}\n⏳ پردازش‌نشده گروه‌ها: ${pendingGroups}\n\n📦 مجموع موفق: <b>${summary.sentUsers + summary.sentGroups}</b>\n⚠️ مجموع ناموفق: <b>${summary.failedUsers + summary.failedGroups}</b>\n❔ مجموع نامشخص: <b>${(summary.unknownUsers ?? 0) + (summary.unknownGroups ?? 0)}</b>`,
    en: `📣 <b>Broadcast campaign report</b>\nCampaign: <code>${campaign._id}</code>\nStatus: <b>${status}</b>\n\n👤 Target users: ${campaign.estimatedUsers}\n✅ Sent to users: ${summary.sentUsers}\n❌ Failed for users: ${summary.failedUsers}\n❔ Unknown user deliveries: ${summary.unknownUsers ?? 0}\n⏳ Users not processed: ${pendingUsers}\n\n👥 Target groups: ${campaign.estimatedGroups}\n✅ Sent to groups: ${summary.sentGroups}\n❌ Failed for groups: ${summary.failedGroups}\n❔ Unknown group deliveries: ${summary.unknownGroups ?? 0}\n⏳ Groups not processed: ${pendingGroups}\n\n📦 Total sent: <b>${summary.sentUsers + summary.sentGroups}</b>\n⚠️ Total failed: <b>${summary.failedUsers + summary.failedGroups}</b>\n❔ Total unknown: <b>${(summary.unknownUsers ?? 0) + (summary.unknownGroups ?? 0)}</b>`,
    ar: `📣 <b>تقرير حملة الإرسال</b>\nالحملة: <code>${campaign._id}</code>\nالحالة: <b>${status}</b>\n\n👤 المستخدمون المستهدفون: ${campaign.estimatedUsers}\n✅ تم الإرسال للمستخدمين: ${summary.sentUsers}\n❌ فشل الإرسال للمستخدمين: ${summary.failedUsers}\n❔ عمليات إرسال غير مؤكدة للمستخدمين: ${summary.unknownUsers ?? 0}\n⏳ مستخدمون لم تتم معالجتهم: ${pendingUsers}\n\n👥 المجموعات المستهدفة: ${campaign.estimatedGroups}\n✅ تم الإرسال للمجموعات: ${summary.sentGroups}\n❌ فشل الإرسال للمجموعات: ${summary.failedGroups}\n❔ عمليات إرسال غير مؤكدة للمجموعات: ${summary.unknownGroups ?? 0}\n⏳ مجموعات لم تتم معالجتها: ${pendingGroups}\n\n📦 إجمالي الإرسال الناجح: <b>${summary.sentUsers + summary.sentGroups}</b>\n⚠️ إجمالي الإرسال الفاشل: <b>${summary.failedUsers + summary.failedGroups}</b>\n❔ إجمالي الإرسال غير المؤكد: <b>${(summary.unknownUsers ?? 0) + (summary.unknownGroups ?? 0)}</b>`,
    es: `📣 <b>Informe de la campaña de difusión</b>\nCampaña: <code>${campaign._id}</code>\nEstado: <b>${status}</b>\n\n👤 Usuarios objetivo: ${campaign.estimatedUsers}\n✅ Enviado a usuarios: ${summary.sentUsers}\n❌ Envíos fallidos a usuarios: ${summary.failedUsers}\n❔ Envíos de usuarios sin confirmar: ${summary.unknownUsers ?? 0}\n⏳ Usuarios sin procesar: ${pendingUsers}\n\n👥 Grupos objetivo: ${campaign.estimatedGroups}\n✅ Enviado a grupos: ${summary.sentGroups}\n❌ Envíos fallidos a grupos: ${summary.failedGroups}\n❔ Envíos de grupos sin confirmar: ${summary.unknownGroups ?? 0}\n⏳ Grupos sin procesar: ${pendingGroups}\n\n📦 Total enviados: <b>${summary.sentUsers + summary.sentGroups}</b>\n⚠️ Total fallidos: <b>${summary.failedUsers + summary.failedGroups}</b>\n❔ Total sin confirmar: <b>${(summary.unknownUsers ?? 0) + (summary.unknownGroups ?? 0)}</b>`,
  }
  return values[lang]
}

async function processCampaign(job: Job<{ campaignId: string }>): Promise<void> {
  const campaign = await BroadcastCampaign.findOne({ _id: job.data.campaignId, status: { $in: ['queued', 'running'] } }).lean()
  if (!campaign) return
  await BroadcastCampaign.updateOne({ _id: campaign._id }, { $set: { status: 'running', startedAt: campaign.startedAt ?? new Date(), lastError: '' } })
  // Telegram copyMessage has no idempotency key. If a worker crashed while a
  // delivery was marked `sending`, the remote side may already have accepted
  // it. Mark it unknown rather than blindly retrying and potentially sending
  // duplicates. The cursor will encounter each row and checkpoint it below.
  await BroadcastDelivery.updateMany(
    { campaignId: campaign._id, status: 'sending' },
    { $set: { status: 'unknown', error: 'Worker stopped during delivery; Telegram acceptance cannot be verified safely.' } },
  )
  try {
    await processUserTargets(campaign)
    // Refresh the persisted cursors before advancing to groups. A restart resumes where the campaign stopped.
    const refreshed = await BroadcastCampaign.findById(campaign._id).lean()
    if (refreshed) await processGroupTargets(refreshed)

    const summary = await summarizeCampaignDeliveries(campaign._id)
    await BroadcastCampaign.updateOne(
      { _id: campaign._id },
      { $set: { ...summary, status: 'completed', finishedAt: new Date(), lastError: '' } },
    )
    const owner = await User.findOne({ tgId: campaign.ownerId }).select('lang').lean() as any
    const ownerLang = (['fa', 'en', 'ar', 'es'].includes(owner?.lang) ? owner.lang : 'fa') as 'fa' | 'en' | 'ar' | 'es'
    const doneStatus = ({ fa: '✅ تکمیل شد', en: '✅ Completed', ar: '✅ اكتملت', es: '✅ Completada' } as const)[ownerLang]
    await bot.api.sendMessage(campaign.ownerId, reportText(campaign, summary, doneStatus, ownerLang), { parse_mode: 'HTML' }).catch((e) => {
      logError('broadcast_final_report_failed', e, { campaignId: campaign._id, ownerId: campaign.ownerId })
    })
  } catch (error: any) {
    const attempts = Number(job.opts.attempts ?? 1)
    const exhausted = job.attemptsMade + 1 >= attempts
    await BroadcastCampaign.updateOne(
      { _id: campaign._id },
      { $set: { status: exhausted ? 'failed' : 'queued', lastError: String(error?.message ?? error).slice(0, 1000), ...(exhausted ? { finishedAt: new Date() } : {}) } },
    )
    if (exhausted) {
      const summary = await summarizeCampaignDeliveries(campaign._id).catch(() => ({ sentUsers: 0, failedUsers: 0, unknownUsers: 0, sentGroups: 0, failedGroups: 0, unknownGroups: 0 }))
      const owner = await User.findOne({ tgId: campaign.ownerId }).select('lang').lean() as any
      const ownerLang = (['fa', 'en', 'ar', 'es'].includes(owner?.lang) ? owner.lang : 'fa') as 'fa' | 'en' | 'ar' | 'es'
      const failedStatus = ({ fa: '❌ خطا خورد؛ کمپین ناقص ماند', en: '❌ Failed; campaign incomplete', ar: '❌ فشلت الحملة ولم تكتمل', es: '❌ Falló; campaña incompleta' } as const)[ownerLang]
      await bot.api.sendMessage(campaign.ownerId, reportText(campaign, summary, failedStatus, ownerLang), { parse_mode: 'HTML' }).catch(() => undefined)
    }
    throw error
  }
}

export async function startBroadcastWorker(): Promise<{ close: () => Promise<void> }> {
  // Separate worker uses a small Mongo pool so bulk sends do not monopolize DB connections.
  await connectDb(8)
  const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null })
  const queue = new Queue(BROADCAST_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: 500,
      removeOnFail: 1_000,
    },
  })
  const worker = new Worker(BROADCAST_QUEUE_NAME, processCampaign, {
    connection,
    concurrency: 1,
    // BullMQ's Redis-backed limiter is shared across workers using this queue.
    limiter: { max: SENDS_PER_SECOND, duration: 1000 },
  })
  worker.on('error', (error) => logError('broadcast_worker_error', error))
  worker.on('failed', (job, error) => logError('broadcast_job_failed', error, { campaignId: job?.data?.campaignId, attemptsMade: job?.attemptsMade }))
  await Promise.all([worker.waitUntilReady(), queue.waitUntilReady()])

  // This independent service is also responsible for translating campaign requests
  // from the private bot into BullMQ jobs. private-worker itself has no BullMQ package.
  const stopCommands = await startConsumer({
    stream: BROADCAST_COMMAND_STREAM,
    group: BROADCAST_COMMAND_GROUP,
    dead: `${BROADCAST_COMMAND_STREAM}:dead`,
    handle: async (fields) => {
      const campaignId = String(fields.campaignId ?? '').trim()
      if (!campaignId) throw new Error('Broadcast command is missing campaignId')
      await queue.add('broadcast-campaign', { campaignId }, { jobId: fields.jobId || `bcast-${campaignId}` })
    },
  })

  const stopTelemetry = await startServerTelemetry(connection, 'broadcast-worker')
  const heartbeatKey = `${BROADCAST_WORKER_HEARTBEAT_PREFIX}${os.hostname()}:${process.pid}:${crypto.randomUUID()}`
  const markReady = () => connection.set(heartbeatKey, String(Date.now()), 'PX', BROADCAST_WORKER_HEARTBEAT_TTL_MS)
  await markReady()
  const heartbeatTimer = setInterval(() => { void markReady().catch((error) => logError('broadcast_worker_heartbeat_failed', error)) }, 5_000)
  heartbeatTimer.unref()
  return {
    close: async () => {
      clearInterval(heartbeatTimer)
      await stopCommands()
      await stopTelemetry()
      await connection.del(heartbeatKey).catch(() => undefined)
      await worker.close()
      await queue.close()
      await connection.quit().catch(() => undefined)
      await closeDb()
      redis.disconnect()
      redisBlock.disconnect()
      redisSub.disconnect()
    },
  }
}
