import crypto from 'node:crypto'
import os from 'node:os'
import { statfs } from 'node:fs/promises'
import type Redis from 'ioredis'

const MONITORING_NAMESPACE = (process.env.MONITORING_NAMESPACE?.trim() || process.env.BOT_TOKEN || 'unknown-bot')
const BOT_NAMESPACE = crypto.createHash('sha256').update(MONITORING_NAMESPACE).digest('hex').slice(0, 12)
export const SERVER_TELEMETRY_PREFIX = `rps:${BOT_NAMESPACE}:ops:instance:`
const INTERVAL_MS = Math.max(3000, Number(process.env.SERVER_METRICS_INTERVAL_MS ?? 5000) || 5000)
const TTL_MS = Math.max(INTERVAL_MS * 3, 20000)

type CpuTimes = { idle: number; total: number }
function cpuTimes(): CpuTimes {
  const cpus = os.cpus()
  let idle = 0
  let total = 0
  for (const cpu of cpus) {
    const t = cpu.times
    idle += t.idle
    total += t.user + t.nice + t.sys + t.idle + t.irq
  }
  return { idle, total }
}

export async function startServerTelemetry(redis: Redis, service: string): Promise<() => Promise<void>> {
  const serverName = (process.env.SERVER_NAME ?? os.hostname()).trim().slice(0, 80) || os.hostname()
  const instanceName = (process.env.INSTANCE_NAME?.trim() || `${service}-${os.hostname()}-${process.pid}`).slice(0, 100)
  const instanceId = crypto.randomUUID()
  const key = `${SERVER_TELEMETRY_PREFIX}${encodeURIComponent(serverName)}:${encodeURIComponent(instanceName)}:${instanceId}`
  let previousCpu = cpuTimes()
  let stopped = false

  const report = async () => {
    const currentCpu = cpuTimes()
    const totalDelta = currentCpu.total - previousCpu.total
    const idleDelta = currentCpu.idle - previousCpu.idle
    previousCpu = currentCpu
    const cpuPercent = totalDelta > 0 ? Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100)) : 0
    const totalMemoryBytes = os.totalmem()
    const freeMemoryBytes = os.freemem()
    let diskTotalBytes = 0
    let diskUsedBytes = 0
    try {
      const disk = await statfs(process.cwd())
      diskTotalBytes = Number(disk.blocks) * Number(disk.bsize)
      diskUsedBytes = Math.max(0, Number(disk.blocks - disk.bfree) * Number(disk.bsize))
    } catch {
      // Disk metrics can be unavailable on unusual filesystems; CPU and RAM remain reportable.
    }
    const payload = {
      serverName,
      instanceName,
      monitoringNamespace: MONITORING_NAMESPACE,
      instanceId,
      service,
      hostname: os.hostname(),
      pid: process.pid,
      cpuPercent: Math.round(cpuPercent * 10) / 10,
      totalMemoryBytes,
      usedMemoryBytes: Math.max(0, totalMemoryBytes - freeMemoryBytes),
      diskTotalBytes,
      diskUsedBytes,
      sampledAt: new Date().toISOString(),
    }
    await redis.set(key, JSON.stringify(payload), 'PX', TTL_MS)
  }

  const safeReport = () => { void report().catch((error) => console.error(`[${service}] server telemetry failed:`, error?.message ?? error)) }
  safeReport()
  const timer = setInterval(safeReport, INTERVAL_MS)
  timer.unref()
  console.info(`[${service}] server monitoring enabled | SERVER_NAME=${serverName} | INSTANCE_NAME=${instanceName}`)

  return async () => {
    if (stopped) return
    stopped = true
    clearInterval(timer)
    await redis.del(key).catch(() => undefined)
  }
}
