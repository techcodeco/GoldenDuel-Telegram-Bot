// Development mode: long polling instead of a webhook.
// Same filter, same stream format as the webhook gateway, so the workers can't tell the difference.
//   bun run poll
// To go back to the webhook later: stop this script and run `bun run webhook`.
import { MAXLEN_GROUPS, MAXLEN_PRIVATE, STREAM_PRIVATE } from "../src/config";
import { route } from "../src/filter";
import { flushLogs, logError } from "../src/logger";
import { redis } from "../src/redis";
import { startServerTelemetry } from "../src/telemetry";

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("BOT_TOKEN must be set in .env");

const API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const ALLOWED = [
  "message",
  "edited_message",
  "callback_query",
  "my_chat_member",
  "message_reaction",
];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let running = true;
let abort = new AbortController();
let stopTelemetry: (() => Promise<void>) | undefined;
let telemetryStarted: Promise<void> = Promise.resolve();
let shuttingDown = false;

async function call(method: string, body: object): Promise<any> {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: abort.signal,
  });
  return res.json();
}

async function shutdown(sig: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  running = false;
  abort.abort(); // cancels the pending long poll; unconfirmed updates stay on Telegram's side
  await telemetryStarted.catch(() => undefined);
  await stopTelemetry?.().catch(() => undefined);
  flushLogs();
  await redis.quit().catch(() => {});
  console.log(`${sig}: polling gateway stopped`);
  process.exit(0);
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => void shutdown(sig));
}

// Telegram refuses getUpdates while a webhook is set
const del = await call("deleteWebhook", { drop_pending_updates: false });
if (!del.ok) throw new Error(`deleteWebhook failed: ${JSON.stringify(del)}`);
console.log("polling started (webhook removed)");

// Polling and webhook are two entrypoints for the same gateway service, so both
// must publish the same telemetry schema into the shared Redis namespace.
telemetryStarted = startServerTelemetry(redis, "gateway")
  .then((stop) => {
    stopTelemetry = stop;
  })
  .catch((error) => {
    logError("telemetry_start_failed", error);
  });
await telemetryStarted;

let offset: number | undefined;
let total = 0;
let kept = 0;

while (running) {
  try {
    const r = await call("getUpdates", {
      offset,
      timeout: 50,
      limit: 100,
      allowed_updates: ALLOWED,
    });
    if (!r.ok) {
      logError("getUpdates_error", JSON.stringify(r)); // e.g. 409 = a webhook or another poller is active
      await sleep(5000);
      continue;
    }
    const updates: any[] = r.result;
    if (!updates.length) continue;

    await Promise.all(
      updates.map(async (u) => {
        total++;
        const stream = route(u);
        if (!stream) return; // same filter as the gateway: group chatter is dropped
        kept++;
        await redis.xadd(
          stream,
          "MAXLEN",
          "~",
          stream === STREAM_PRIVATE ? MAXLEN_PRIVATE : MAXLEN_GROUPS,
          "*",
          "u",
          String(u.update_id),
          "d",
          JSON.stringify(u),
        );
        offset = updates[updates.length - 1].update_id + 1;
        console.log(
          `+${updates.length} updates (total ${total}, queued ${kept})`,
        );
      }),
    );
    // confirm to Telegram only after EVERY update of the batch is in Redis (a retry just re-adds; workers dedupe by update_id)
  } catch (e) {
    if (!running) break;
    logError("poll_failed", e);
    await sleep(2000);
  }
}
