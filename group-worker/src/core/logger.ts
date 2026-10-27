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

mkdirSync(LOG_DIR, { recursive: true });

const stream = await build({
  file: join(LOG_DIR, "group-worker"),
  extension: ".log",
  size: LOG_MAX_SIZE,
  frequency: "daily",
  mkdir: true,
  limit: { count: 100 },
});

export const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? "error",
    base: { app: "gd-group-worker", pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    serializers: { err: pino.stdSerializers.err },
  },
  stream,
);

const seen = new Map<string, { t: number; n: number }>();

/** Use a stable key; do not include user-provided text in the key. */
export function logError(
  key: string,
  err: unknown,
  ctx?: Record<string, unknown>,
): void {
  const now = Date.now();
  const prior = seen.get(key);
  if (prior && now - prior.t < LOG_THROTTLE_MS) {
    prior.n++;
    return;
  }
  seen.set(key, { t: now, n: 0 });
  logger.error({ key, err, suppressed: prior?.n || undefined, ...ctx }, key);
}

export function logWarn(
  key: string,
  ctx?: Record<string, unknown>,
  message = key,
): void {
  logger.warn({ key, ...ctx }, message);
}

function cleanOldLogs(): void {
  const cutoff = Date.now() - Math.max(1, LOG_RETENTION_DAYS) * 86_400_000;
  try {
    for (const name of readdirSync(LOG_DIR)) {
      const path = join(LOG_DIR, name);
      try {
        if (statSync(path).isFile() && statSync(path).mtimeMs < cutoff)
          unlinkSync(path);
      } catch {
        /* a concurrent rotation/deletion is harmless */
      }
    }
  } catch (err) {
    logger.warn(
      { err, key: "log_retention_cleanup_failed" },
      "log_retention_cleanup_failed",
    );
  }
}

export function startLogJanitor(): void {
  cleanOldLogs();
  setInterval(cleanOldLogs, 3_600_000).unref();
}

export function flushLogs(): void {
  try {
    (stream as any).flushSync?.();
  } catch {
    /* best effort */
  }
}

process.on("uncaughtException", (err) => {
  logger.fatal({ err, key: "uncaught_exception" }, "uncaught_exception");
  flushLogs();
  process.exit(1);
});
process.on("unhandledRejection", (reason) =>
  logError("unhandled_rejection", reason),
);
