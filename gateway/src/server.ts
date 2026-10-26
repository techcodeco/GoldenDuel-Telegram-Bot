import { Elysia } from "elysia";
import {
  MAXLEN_GROUPS,
  MAXLEN_PRIVATE,
  PORT,
  REUSE_PORT,
  STREAM_PRIVATE,
  WEBHOOK_TOKEN,
} from "./config";
import { route } from "./filter";
import { flushLogs, logError, startLogJanitor } from "./logger";
import { redis } from "./redis";
import { startServerTelemetry } from "./telemetry";

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
    "/webhook/:token",
    async ({ params, request, set }) => {
      if (params.token !== WEBHOOK_TOKEN) {
        logError("webhook_bad_token", "request with wrong token"); // helps spot a misconfigured setWebhook
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
  .listen({ port: PORT, reusePort: REUSE_PORT });

console.log(`gateway listening on :${PORT}`);

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
