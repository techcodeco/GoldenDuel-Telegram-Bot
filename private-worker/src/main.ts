import { bot } from "./core/bot/instance";
import { registerHandlers } from "./core/bot/handlers";
import { closeDb, connectDb } from "./core/db";
import { consumerStreams } from "./core/streams";
import { logger } from "./core/logger";
import { OWNER_IDS, TON_NETWORK, TONCENTER_API_URL } from "./core/config";
import { redis, redisBlock, redisSub } from "./core/redis";
import { startSettingsSubscriber } from "./core/services/settings";
import { startServerTelemetry } from "./core/telemetry";
import { startBackupWorkerWatchdog } from "./core/backup-watchdog";

async function main(): Promise<void> {
  if (!OWNER_IDS.size)
    console.warn("⚠️  OWNER_IDS is empty: nobody can use the admin commands");
  await connectDb();
  const stopTelemetry = await startServerTelemetry(redis, "private-worker");
  await startSettingsSubscriber();
  registerHandlers();
  await bot.init(); // loads bot username (needed for referral links)
  const stopBackupWatchdog = await startBackupWorkerWatchdog(redis);

  const stopStreams = await consumerStreams();
  console.log(
    `private worker ready as @${bot.botInfo.username} | TON network: ${TON_NETWORK.toUpperCase()} (${TONCENTER_API_URL})`,
  );

  let closing = false;
  const shutdown = async (sig: string) => {
    if (closing) return;
    closing = true;
    console.log(`${sig}: shutting down…`);
    await stopStreams();
    await stopBackupWatchdog();
    await stopTelemetry();
    await closeDb();
    redis.disconnect();
    redisBlock.disconnect();
    redisSub.disconnect();
    await new Promise((r) => setTimeout(r, 200));
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((e) => {
  logger.fatal({ err: e }, "startup_failed");
  console.error(e);
  process.exit(1);
});
