import { redis } from "../redis";

/** Shared with private-worker; only bullMQ-worker translates these commands into BullMQ jobs. */
export const TIMING_COMMAND_STREAM =
  process.env.TIMING_COMMAND_STREAM ?? "gd:timing:commands";

async function requestTimingJob(
  type: "group-invite-timeout" | "group-match-timeout" | "group-match-reminder",
  data: { duelId: string; deadline?: number; reminderAt?: number },
) {
  await redis.xadd(
    TIMING_COMMAND_STREAM,
    "MAXLEN",
    "~",
    500_000,
    "*",
    "type",
    type,
    "data",
    JSON.stringify(data),
  );
}

export function scheduleGroupInviteTimeout(duelId: string, deadline: number) {
  return requestTimingJob("group-invite-timeout", { duelId, deadline });
}

export function scheduleGroupMatchTimeout(duelId: string, deadline: number) {
  return requestTimingJob("group-match-timeout", { duelId, deadline });
}

/** Schedule a durable group move reminder through the shared BullMQ command stream. */
export function scheduleGroupMatchReminder(duelId: string, reminderAt: number) {
  return requestTimingJob("group-match-reminder", { duelId, reminderAt });
}
