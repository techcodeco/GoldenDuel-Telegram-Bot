import crypto from "node:crypto";
import { BOT_TOKEN } from "./config";

const MONITORING_NAMESPACE =
  process.env.MONITORING_NAMESPACE?.trim() || BOT_TOKEN;
const BOT_NAMESPACE = crypto
  .createHash("sha256")
  .update(MONITORING_NAMESPACE)
  .digest("hex")
  .slice(0, 12);
export const BROADCAST_WORKER_HEARTBEAT_PREFIX = `gd:${BOT_NAMESPACE}:broadcast-worker:heartbeat:`;

/** Private-worker writes campaign requests here; broadcast-worker converts them into BullMQ jobs. */
export const BROADCAST_COMMAND_STREAM =
  process.env.BROADCAST_COMMAND_STREAM ?? "gd:broadcast:commands";
