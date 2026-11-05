import "dotenv/config";
import mongoose from "mongoose";
import { startServerTelemetry } from "./telemetry";
import {
  MONGO_URI,
  STREAM,
  GROUP,
  CONSUMER,
  redis,
  redisBlock,
} from "./core/runtime";
import {
  User,
  GroupTarget,
  GroupConfig,
  GroupDuel,
  Settings,
  Ledger,
  House,
} from "./core/models/index";
import { handleUpdate } from "./core/bot/updates";
import { bot } from "./core/bot/instance";
import { logger, logError, startLogJanitor, flushLogs } from "./core/logger";

export async function startGroupWorker() {
  startLogJanitor();
  // Validate BOT_TOKEN / the configured Telegram Bot API endpoint before consuming updates.
  // A 404 here almost always indicates an invalid token or wrong API endpoint.
  const botIdentity = await bot.api.getMe();
  logger.info(
    { botId: botIdentity.id, botUsername: botIdentity.username },
    "group_worker_bot_api_connected",
  );
  await mongoose.connect(MONGO_URI, {
    maxPoolSize: 30,
    serverSelectionTimeoutMS: 10_000,
  });
  logger.info({ stream: STREAM, consumer: CONSUMER }, "group_worker_started");
  const stopTelemetry = await startServerTelemetry(redis, "group-worker");
  await Promise.all(
    [User, GroupTarget, GroupConfig, GroupDuel, Settings, Ledger, House].map(
      (model: any) => model.init(),
    ),
  );
  try {
    await redis.xgroup("CREATE", STREAM, GROUP, "0", "MKSTREAM");
    console.log(`group worker is ready as @${botIdentity.username} `);
  } catch (error: any) {
    if (!String(error?.message).includes("BUSYGROUP")) throw error;
  }

  logger.info(
    { stream: STREAM, consumer: CONSUMER },
    "group_worker_consuming_stream",
  );
  let running = true;
  const ack = async (id: string) => redis.xack(STREAM, GROUP, id);
  const processEntries = async (entries: any[]) => {
    for (const [id, values] of entries) {
      const fields: Record<string, string> = {};
      for (let i = 0; i < (values ?? []).length; i += 2)
        fields[values[i]] = values[i + 1];

      // A Telegram update can be re-published or reclaimed after the handler
      // completed but before XACK. Deduplicate by Telegram update_id, not the
      // Redis Stream entry id (which changes on republish).
      const updateId = String(fields.u ?? '').trim();
      const doneKey = updateId ? `dd:group:${updateId}` : '';
      const lockKey = updateId ? `dd:group:processing:${updateId}` : '';
      const lockOwner = `${CONSUMER}:${id}`;
      let ownsLock = false;
      try {
        if (doneKey && await redis.exists(doneKey)) {
          await ack(id);
          await redis.del(`gw:fail:${id}`);
          continue;
        }
        if (lockKey) {
          const acquired = await redis.set(lockKey, lockOwner, 'EX', 600, 'NX');
          if (acquired !== 'OK') {
            // Leave it pending. The owner may still finish; a later reclaim
            // will see doneKey and ACK this duplicate safely.
            continue;
          }
          ownsLock = true;
        }

        await handleUpdate(fields);
        if (doneKey) await redis.set(doneKey, '1', 'EX', 86_400);
        await ack(id);
        await redis.del(`gw:fail:${id}`);
      } catch (error) {
        const failures = await redis.incr(`gw:fail:${id}`);
        if (failures === 1) await redis.expire(`gw:fail:${id}`, 86_400);
        logError("stream_update_failed", error, {
          stream: STREAM,
          entryId: id,
          updateId: updateId || undefined,
          attempts: failures,
        });
        if (failures >= 5) {
          await redis
            .xadd(
              `${STREAM}:dead`,
              "MAXLEN",
              "~",
              10_000,
              "*",
              "id",
              id,
              "error",
              String(error).slice(0, 500),
              ...(values ?? []),
            )
            .catch((deadError) =>
              logError("dead_letter_write_failed", deadError, {
                stream: STREAM,
                entryId: id,
              }),
            );
          // A terminally dead-lettered update must not execute through another
          // duplicate stream entry in the same retention window.
          if (doneKey) await redis.set(doneKey, 'dead-lettered', 'EX', 86_400);
          await ack(id);
          await redis.del(`gw:fail:${id}`);
        }
      } finally {
        if (ownsLock && lockKey) {
          await (redis as any).eval(
            "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
            1, lockKey, lockOwner,
          ).catch((error: unknown) => logError('group_update_lock_release_failed', error, { updateId }));
        }
      }
    }
  };

  const loop = (async () => {
    while (running) {
      try {
        const response: any = await redisBlock.xreadgroup(
          "GROUP",
          GROUP,
          CONSUMER,
          "COUNT",
          Number(process.env.BATCH ?? 50),
          "BLOCK",
          Number(process.env.BLOCK_MS ?? 2000),
          "STREAMS",
          STREAM,
          ">",
        );
        if (response) await processEntries(response[0][1]);
      } catch (error) {
        if (running) {
          logError("stream_read_failed", error, {
            stream: STREAM,
            consumer: CONSUMER,
          });
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    }
  })();

  let reclaimBusy = false;
  let autoClaimSupported: boolean | null = null;
  const reclaimLegacy = async () => {
    const pending = await (redis as any).xpending(STREAM, GROUP, '-', '+', 100) as Array<[string, string, number, number]>;
    const ids = pending.filter((row) => Number(row[2]) >= 60_000).map((row) => row[0]);
    if (!ids.length) return;
    const claimed = await (redis as any).xclaim(STREAM, GROUP, CONSUMER, 60_000, ...ids);
    if (claimed?.length) await processEntries(claimed);
  };
  const reclaim = setInterval(async () => {
    if (reclaimBusy || !running) return;
    reclaimBusy = true;
    try {
      if (autoClaimSupported === false) {
        await reclaimLegacy();
        return;
      }
      let cursor = "0-0";
      for (let i = 0; i < 5; i++) {
        try {
          const result = await (redis as any).xautoclaim(
            STREAM, GROUP, CONSUMER, 60_000, cursor, "COUNT", 100,
          );
          autoClaimSupported = true;
          cursor = result[0];
          if (result[1]?.length) await processEntries(result[1]);
          if (cursor === "0-0") break;
        } catch (error: any) {
          const message = String(error?.message ?? error);
          if (/unknown command.*xautoclaim|xautoclaim.*unknown command|unsupported.*xautoclaim|xautoclaim.*unsupported|not supported.*xautoclaim|syntax error/i.test(message)) {
            autoClaimSupported = false;
            await reclaimLegacy();
            break;
          }
          throw error;
        }
      }
    } catch (error: any) {
      logError("stream_pending_reclaim_failed", error, {
        stream: STREAM,
        consumer: CONSUMER,
      });
    } finally {
      reclaimBusy = false;
    }
  }, 15_000);
  console.log(`group worker is ready as @${botIdentity.username} `);
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    running = false;
    clearInterval(reclaim);
    await loop;
    logger.info("group_worker_shutdown_started");
    await stopTelemetry();
    await redis.quit();
    await redisBlock.quit();
    await mongoose.disconnect();
    flushLogs();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
