import crypto from "node:crypto";
import os from "node:os";
import { statfs } from "node:fs/promises";
import type Redis from "ioredis";
import {
  INSTANCE_NAME,
  MONITORING_NAMESPACE,
  SERVER_METRICS_INTERVAL_MS,
  SERVER_NAME,
  BACKUP_STATUS_KEY,
  BACKUP_CONFIG_KEY,
  BACKUP_HISTORY_KEY,
  BACKUP_COMMAND_CHANNEL,
} from "./config";
import { logError, logger } from "./logger";

const BOT_NAMESPACE = crypto
  .createHash("sha256")
  .update(MONITORING_NAMESPACE)
  .digest("hex")
  .slice(0, 12);
export const SERVER_TELEMETRY_PREFIX = `gd:${BOT_NAMESPACE}:ops:instance:`;
export {
  BACKUP_STATUS_KEY,
  BACKUP_CONFIG_KEY,
  BACKUP_HISTORY_KEY,
  BACKUP_COMMAND_CHANNEL,
};
const TTL_MS = Math.max(SERVER_METRICS_INTERVAL_MS * 3, 20_000);

type CpuTimes = { idle: number; total: number };
function cpuTimes(): CpuTimes {
  let idle = 0,
    total = 0;
  for (const cpu of os.cpus()) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

export type BackupTelemetry = {
  backupStatus: "starting" | "running" | "success" | "error" | "skipped";
  lastBackupAt?: string;
  lastBackupId?: string;
  lastBackupFileName?: string;
  lastBackupBytes?: number;
  lastBackupSha256?: string;
  lastBackupDurationMs?: number;
  lastBackupMessageId?: number;
  lastBackupFileId?: string;
  lastBackupError?: string;
  backupIntervalMinutes: number;
  statusUpdatedAt?: string;
};

export async function startServerTelemetry(
  redis: Redis,
  service: string,
  extra?: () => Record<string, unknown>,
): Promise<() => Promise<void>> {
  const instanceId = crypto.randomUUID();
  const key = `${SERVER_TELEMETRY_PREFIX}${encodeURIComponent(SERVER_NAME)}:${encodeURIComponent(INSTANCE_NAME)}:${instanceId}`;
  let previousCpu = cpuTimes();
  let stopped = false;

  const report = async () => {
    const currentCpu = cpuTimes();
    const totalDelta = currentCpu.total - previousCpu.total;
    const idleDelta = currentCpu.idle - previousCpu.idle;
    previousCpu = currentCpu;
    const cpuPercent =
      totalDelta > 0
        ? Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100))
        : 0;
    const totalMemoryBytes = os.totalmem();
    let diskTotalBytes = 0,
      diskUsedBytes = 0;
    try {
      const disk = await statfs(process.cwd());
      diskTotalBytes = Number(disk.blocks) * Number(disk.bsize);
      diskUsedBytes = Math.max(
        0,
        Number(disk.blocks - disk.bfree) * Number(disk.bsize),
      );
    } catch {
      /* CPU/RAM and worker status are still useful without disk information */
    }
    const payload = {
      serverName: SERVER_NAME,
      instanceName: INSTANCE_NAME,
      monitoringNamespace: MONITORING_NAMESPACE,
      instanceId,
      service,
      hostname: os.hostname(),
      pid: process.pid,
      cpuPercent: Math.round(cpuPercent * 10) / 10,
      totalMemoryBytes,
      usedMemoryBytes: Math.max(0, totalMemoryBytes - os.freemem()),
      diskTotalBytes,
      diskUsedBytes,
      sampledAt: new Date().toISOString(),
      ...(extra?.() ?? {}),
    };
    await redis.set(key, JSON.stringify(payload), "PX", TTL_MS);
  };

  const safeReport = () => {
    void report().catch((error) =>
      logError("server_telemetry_report_failed", error, {
        service,
        serverName: SERVER_NAME,
        instanceName: INSTANCE_NAME,
      }),
    );
  };
  safeReport();
  const timer = setInterval(safeReport, SERVER_METRICS_INTERVAL_MS);
  timer.unref();
  logger.info(
    { service, serverName: SERVER_NAME, instanceName: INSTANCE_NAME },
    "server_monitoring_enabled",
  );

  return async () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    await redis
      .del(key)
      .catch((error) =>
        logError("server_telemetry_cleanup_failed", error, {
          service,
          serverName: SERVER_NAME,
          instanceName: INSTANCE_NAME,
        }),
      );
  };
}
