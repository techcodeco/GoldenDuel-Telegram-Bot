import { timingSafeEqual } from "node:crypto";
import { Elysia } from "elysia";
import {
  HOST,
  MAXLEN_GROUPS,
  MAXLEN_PRIVATE,
  PORT,
  REUSE_PORT,
  STREAM_PRIVATE,
  WEBHOOK_SECRET,
} from "./config";
import { route } from "./filter";
import { flushLogs, logError, startLogJanitor } from "./logger";
import { redis } from "./redis";
import { startServerTelemetry } from "./telemetry";

if (!/^[A-Za-z0-9_-]{1,256}$/.test(WEBHOOK_SECRET)) {
  throw new Error(
    "WEBHOOK_SECRET must be 1-256 characters and contain only A-Z, a-z, 0-9, _ or -",
  );
}

function isValidWebhookSecret(received: string | null): boolean {
  if (!received) return false;

  const expectedBytes = Buffer.from(WEBHOOK_SECRET, "utf8");
  const receivedBytes = Buffer.from(received, "utf8");
  return (
    expectedBytes.length === receivedBytes.length &&
    timingSafeEqual(expectedBytes, receivedBytes)
  );
}

startLogJanitor();

let stopTelemetry: (() => Promise<void>) | undefined;
const telemetryStarted = startServerTelemetry(redis, "gateway")
  .then((stop) => {
    stopTelemetry = stop;
    return stop;
  })
  .catch((error) => {
    logError("telemetry_start_failed", error);
  });

const app = new Elysia()
  // Unexpected exceptions only (404 from scanners is ignored)
  .onError(({ code, error }) => {
    if (code === "NOT_FOUND") return;
    logError(`elysia_${code}`, error);
  })
  .get("/health", async ({ set }) => {
    try {
      await redis.ping();
      return "ok";
    } catch {
      set.status = 503;
      return "redis down";
    }
  })
  .post(
    "/webhook",
    async ({ request, set }) => {
      // Telegram sends this header after secret_token is configured with setWebhook.
      if (!isValidWebhookSecret(
        request.headers.get("x-telegram-bot-api-secret-token"),
      )) {
        logError("webhook_invalid_secret_header", "missing or invalid Telegram webhook secret header");
        set.status = 401;
        return "unauthorized";
      }

      const raw = await request.text(); // stored as-is, no re-stringify
      let update: any;
      try {
        update = JSON.parse(raw);
      } catch (err) {
        logError("webhook_bad_json", err, {
          bodyLength: raw.length,
          bodyPreview: raw.slice(0, 200),
        });
        return "bad json"; // 200: retrying garbage is pointless
      }

      const stream = route(update);

      if (stream === null) return "ignored"; // 200 so Telegram moves on

      try {
        await redis.xadd(
          stream,
          "MAXLEN",
          "~",
          stream === STREAM_PRIVATE ? MAXLEN_PRIVATE : MAXLEN_GROUPS,
          "*",
          "u",
          String(update.update_id), // workers use it for idempotency
          "d",
          raw,
        );
        return "ok";
      } catch (err) {
        logError("xadd_failed", err, { stream, updateId: update.update_id });
        set.status = 503; // non-2xx → Telegram retries, so no update is lost
        return "redis down";
      }
    },
    { parse: "none" }, // manual parse, no schema validation on the hot path
  )
  .listen({ hostname: HOST, port: PORT, reusePort: REUSE_PORT });

console.log(`gateway listening on ${HOST}:${PORT}`);

// Graceful shutdown: finish in-flight requests, flush logs, close Redis
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await telemetryStarted.catch(() => undefined);
    await stopTelemetry?.();
    await app.stop();
    flushLogs();
    await redis.quit().catch(() => {});
    process.exit(0);
  });
}
