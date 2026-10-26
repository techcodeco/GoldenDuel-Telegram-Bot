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
      try {
        const fields: Record<string, string> = {};
        for (let i = 0; i < values.length; i += 2)
          fields[values[i]] = values[i + 1];
        await handleUpdate(fields);
        await ack(id);
        await redis.del(`gw:fail:${id}`);
      } catch (error) {
        const failures = await redis.incr(`gw:fail:${id}`);
        if (failures === 1) await redis.expire(`gw:fail:${id}`, 86_400);
        logError("stream_update_failed", error, {
          stream: STREAM,
          entryId: id,
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
          await ack(id);
          await redis.del(`gw:fail:${id}`);
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
  const reclaim = setInterval(async () => {
    if (reclaimBusy || !running) return;
    reclaimBusy = true;
    try {
      let cursor = "0-0";
      for (let i = 0; i < 5; i++) {
        const result = await (redis as any).xautoclaim(
          STREAM,
          GROUP,
          CONSUMER,
          60_000,
          cursor,
          "COUNT",
          100,
        );
        cursor = result[0];
        if (result[1]?.length) await processEntries(result[1]);
        if (cursor === "0-0") break;
      }
    } catch (error: any) {
      if (
        !/unknown command.*xautoclaim|xautoclaim.*unknown command|syntax error/i.test(
          String(error?.message ?? error),
        )
      ) {
        logError("stream_pending_reclaim_failed", error, {
          stream: STREAM,
          consumer: CONSUMER,
        });
      }
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
