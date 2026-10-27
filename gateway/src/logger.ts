import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import build from "pino-roll";
import {
  LOG_DIR,
  LOG_MAX_SIZE,
  LOG_RETENTION_DAYS,
  LOG_THROTTLE_MS,
} from "./config";

/**
 * Error-only logging, built to cost (almost) nothing:
 *  - pino: the fastest Node/Bun logger; JSON lines, easy to grep / jq.
 *  - pino-roll: rotates by size (LOG_MAX_SIZE) and day; writes are buffered & async (SonicBoom).
 *  - nothing is logged on the success path, so normal requests never touch the logger.
 *  - throttle: during an outage (e.g. Redis down) the same error fires thousands of times
 *    per second; each distinct error key is written at most once per LOG_THROTTLE_MS and the
 *    number of skipped repeats is added to the next entry as `suppressed`.
 *  - retention: files older than LOG_RETENTION_DAYS are deleted (startup + hourly).
 */
mkdirSync(LOG_DIR, { recursive: true });

const stream = await build({
  file: join(LOG_DIR, "gateway"), // → logs/gateway.<date>.<n>.log
  extension: ".log",
  size: LOG_MAX_SIZE, // rotate when a file reaches ~2 MB
  frequency: "daily", // and start a new file every day
  mkdir: true,
  limit: { count: 100 }, // hard safety cap on file count (≈ 200 MB max) during error storms
});

export const logger = pino(
  {
    level: "error", // errors (and fatal) only
    base: { app: "gd-gateway", pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    serializers: { err: pino.stdSerializers.err },
  },
  stream,
);

// ───────────── Throttled error logging ─────────────
const seen = new Map<string, { t: number; n: number }>();

/** `key` MUST be a static string (e.g. 'xadd_failed'), never built from user input. */
export function logError(
  key: string,
  err: unknown,
  ctx?: Record<string, unknown>,
): void {
  const now = Date.now();
  const s = seen.get(key);
  if (s && now - s.t < LOG_THROTTLE_MS) {
    s.n++;
    return;
  }
  seen.set(key, { t: now, n: 0 });
  logger.error({ key, err, suppressed: s?.n || undefined, ...ctx }, key);
}

// ───────────── Retention: delete files older than N days ─────────────
function cleanOldLogs(): void {
  const cutoff = Date.now() - LOG_RETENTION_DAYS * 86_400_000;
  try {
    for (const name of readdirSync(LOG_DIR)) {
      const path = join(LOG_DIR, name);
      try {
        if (statSync(path).mtimeMs < cutoff) unlinkSync(path);
      } catch {
        /* file vanished or is busy: ignore */
      }
    }
  } catch {
    /* directory missing: ignore */
  }
}

export function startLogJanitor(): void {
  cleanOldLogs();
  setInterval(cleanOldLogs, 3_600_000).unref(); // hourly, does not keep the process alive
}

export function flushLogs(): void {
  try {
    (stream as any).flushSync?.();
  } catch {
    /* nothing buffered */
  }
}

// ───────────── Last-resort handlers ─────────────
process.on("uncaughtException", (err) => {
  logger.fatal({ err, key: "uncaught_exception" }, "uncaught_exception");
  flushLogs();
  console.error("uncaughtException:", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logError("unhandled_rejection", reason);
});
