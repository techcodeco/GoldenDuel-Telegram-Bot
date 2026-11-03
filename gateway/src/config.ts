function need(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing env variable: ${key}`);
  return value;
}

export const PORT = Number(process.env.PORT ?? 3000);
// The gateway is intended to sit behind Nginx. Keep it private on the host.
export const HOST = process.env.HOST ?? "127.0.0.1";
export const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
// Used only to authenticate Telegram's incoming webhook header.
// Polling mode does not need this value.
export const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? "";
export const BOT_USERNAME = (process.env.BOT_USERNAME ?? "").toLowerCase();
export const REUSE_PORT = process.env.REUSE_PORT === "1";

// Redis Streams (one consumer group per stream, scaled independently)
export const STREAM_PRIVATE =
  process.env.PRIVATE_UPDATES_STREAM ?? "updates:private";
export const STREAM_GROUPS =
  process.env.GROUP_UPDATES_STREAM ?? "updates:groups";

// Approximate caps so Redis memory can never blow up
export const MAXLEN_PRIVATE = Number(process.env.MAXLEN_PRIVATE ?? 300_000);
export const MAXLEN_GROUPS = Number(process.env.MAXLEN_GROUPS ?? 100_000);

// Logging (errors only)
export const LOG_DIR = process.env.LOG_DIR ?? "./logs";
export const LOG_MAX_SIZE = process.env.LOG_MAX_SIZE ?? "2m";
export const LOG_RETENTION_DAYS = Number(process.env.LOG_RETENTION_DAYS ?? 7);
export const LOG_THROTTLE_MS = Number(process.env.LOG_THROTTLE_MS ?? 1000);
