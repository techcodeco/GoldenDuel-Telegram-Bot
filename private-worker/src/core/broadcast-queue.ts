import { redis } from './redis'
import { BROADCAST_COMMAND_STREAM } from './broadcast-constants'


/** Send a campaign enqueue request to the independent broadcast-worker. */
export async function enqueueBroadcastCampaign(campaignId: string): Promise<void> {
  await redis.xadd(
    BROADCAST_COMMAND_STREAM,
    'MAXLEN', '~', 500_000, '*',
    'campaignId', campaignId,
    'jobId', `bcast-${campaignId}`,
  )
}
