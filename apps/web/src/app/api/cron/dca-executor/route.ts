/**
 * DCA cron executor.
 *
 * Fires every ~5 minutes. For each active schedule:
 *   - Skip if `nextRunAt > now`
 *   - Acquire NX lock (dca:lock:<id>) to prevent double-fire when two crons overlap
 *   - Execute one run via executeDcaRun()
 *   - Persist result to schedule + append to logs ring buffer
 *   - Auto-pause on 3 consecutive failures or if schedule completed all runs
 *
 * Env:
 *   CRON_SECRET       — Bearer header
 *   KEEPER_MASTER_KEY — HMAC master for per-user keeper derivation
 *   ZEROX_API_KEY     — 0x AllowanceHolder quote fetcher
 *   BASE_RPC_URL      — optional override (defaults to https://mainnet.base.org)
 *
 * Vercel cron in vercel.json:
 *   { "path": "/api/cron/dca-executor", "schedule": "STAR/5 * * * *" }  every 5m
 *   (STAR is "*" — cron docs; use the literal in JSON)
 */

import { NextRequest, NextResponse } from "next/server";
import { kvGet, kvSet, kvSetNX } from "@/lib/kv";
import { dcaKeys, DCA_LOG_MAX, DCA_LOCK_TTL_SEC } from "@/lib/dca/kv-keys";
import { executeDcaRun } from "@/lib/dca/execution";
import type { DcaSchedule, DcaExecutionLog } from "@/lib/dca/types";

export const runtime = "nodejs";
export const maxDuration = 300; // 5min — the cron may sweep many schedules

const CONSECUTIVE_FAIL_PAUSE_THRESHOLD = 3;

function isAuthorized(req: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET ?? "";
  const authHeader = req.headers.get("authorization") ?? "";
  const isVercelCron = req.headers.has("x-vercel-cron");
  return isVercelCron || (cronSecret !== "" && authHeader === `Bearer ${cronSecret}`);
}

async function appendLog(scheduleId: string, entry: DcaExecutionLog): Promise<void> {
  const logs = (await kvGet<DcaExecutionLog[]>(dcaKeys.logs(scheduleId))) ?? [];
  logs.unshift(entry);
  await kvSet(dcaKeys.logs(scheduleId), logs.slice(0, DCA_LOG_MAX));
}

async function processSchedule(id: string, now: number): Promise<{
  id: string;
  action: "skipped" | "executed" | "locked" | "removed";
  reason?: string;
  log?: DcaExecutionLog;
}> {
  const schedule = await kvGet<DcaSchedule>(dcaKeys.schedule(id));
  if (!schedule) {
    return { id, action: "removed", reason: "schedule not found in KV" };
  }
  if (schedule.status !== "active") {
    return { id, action: "removed", reason: `status=${schedule.status}` };
  }
  if (schedule.expiresAt <= now) {
    await kvSet(dcaKeys.schedule(id), { ...schedule, status: "expired" });
    return { id, action: "removed", reason: "expired" };
  }
  if (schedule.nextRunAt > now) {
    return { id, action: "skipped", reason: `nextRunAt=${schedule.nextRunAt} in ${schedule.nextRunAt - now}s` };
  }

  // Prevent double-fire when two cron ticks overlap or a manual run races
  const lockAcquired = await kvSetNX(dcaKeys.execLock(id), now, DCA_LOCK_TTL_SEC);
  if (!lockAcquired) {
    return { id, action: "locked", reason: "another executor holds the lock" };
  }

  const log = await executeDcaRun(schedule, { now });
  await appendLog(id, log);

  const updated: DcaSchedule = { ...schedule, lastRunAt: now };
  if (log.status === "success") {
    updated.runsCompleted = schedule.runsCompleted + 1;
    updated.totalSpent    = (BigInt(schedule.totalSpent)  + BigInt(log.sellAmount)).toString();
    updated.totalBought   = (BigInt(schedule.totalBought) + BigInt(log.buyAmount)).toString();
    updated.lastError     = null;
    updated.nextRunAt     = now + schedule.frequencySec;
    if (updated.runsCompleted >= schedule.totalRuns) {
      updated.status  = "cancelled";
      updated.nextRunAt = 0;
    }
  } else if (log.status === "failed") {
    updated.runsFailed = schedule.runsFailed + 1;
    updated.lastError  = log.error;
    // Retry sooner on failure (½ the frequency, capped 1h) but not too eagerly
    updated.nextRunAt  = now + Math.min(schedule.frequencySec / 2, 60 * 60);
    // Recent-failure heuristic: if the last 3 logs are all failures, pause
    const recent = (await kvGet<DcaExecutionLog[]>(dcaKeys.logs(id))) ?? [];
    const lastThree = recent.slice(0, CONSECUTIVE_FAIL_PAUSE_THRESHOLD);
    const allFailed = lastThree.length >= CONSECUTIVE_FAIL_PAUSE_THRESHOLD
      && lastThree.every((l) => l.status === "failed");
    if (allFailed) updated.status = "paused";
  }

  await kvSet(dcaKeys.schedule(id), updated);

  // If we ended terminal (cancelled/paused/expired), drop from active set
  if (updated.status !== "active") {
    const active = (await kvGet<string[]>(dcaKeys.activeSet())) ?? [];
    await kvSet(dcaKeys.activeSet(), active.filter((x) => x !== id));
  }

  return { id, action: "executed", log };
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const now  = Math.floor(Date.now() / 1000);
  const ids  = (await kvGet<string[]>(dcaKeys.activeSet())) ?? [];
  if (ids.length === 0) {
    return NextResponse.json({ ok: true, action: "no-op", activeCount: 0, now });
  }

  // Sequential (not Promise.all) so we don't hammer 0x + RPC or overrun our
  // shared max_duration. v1 handles up to a few hundred schedules per tick.
  const results: Array<Awaited<ReturnType<typeof processSchedule>>> = [];
  for (const id of ids) {
    try {
      results.push(await processSchedule(id, now));
    } catch (e) {
      results.push({ id, action: "skipped", reason: (e as Error).message });
    }
  }

  const summary = {
    ok: true,
    now,
    activeCount: ids.length,
    executed:  results.filter((r) => r.action === "executed").length,
    skipped:   results.filter((r) => r.action === "skipped").length,
    locked:    results.filter((r) => r.action === "locked").length,
    removed:   results.filter((r) => r.action === "removed").length,
    successes: results.filter((r) => r.log?.status === "success").length,
    failures:  results.filter((r) => r.log?.status === "failed").length,
    results:   results.map(({ id, action, reason, log }) => ({
      id,
      action,
      reason,
      status:  log?.status,
      txHash:  log?.txHash,
      error:   log?.error,
      runNumber: log?.runNumber,
    })),
  };
  return NextResponse.json(summary);
}

// Support POST too so we can trigger manually with curl during testing
export const POST = GET;
