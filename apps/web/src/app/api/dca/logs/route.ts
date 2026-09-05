/**
 * GET /api/dca/logs?scheduleId=…&userAddress=…
 *
 * Returns the DcaExecutionLog ring buffer (last 50 runs) for one schedule.
 * Includes txHash, boughtAmount, sellAmount, effectivePrice, error.
 *
 * Auth: caller must pass the same userAddress that owns the schedule —
 * same weak-auth model as /api/dca/cancel. Logs are otherwise public (all
 * data derivable from on-chain txs anyway), but gating avoids random
 * schedule-id enumeration returning info about other users' activity.
 */

import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { kvGet } from "@/lib/kv";
import { dcaKeys } from "@/lib/dca/kv-keys";
import type { DcaSchedule, DcaExecutionLog } from "@/lib/dca/types";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const u = new URL(req.url);
  const scheduleId  = (u.searchParams.get("scheduleId")  ?? "").trim();
  const userAddress = (u.searchParams.get("userAddress") ?? "").trim();
  if (!scheduleId) {
    return NextResponse.json({ error: "scheduleId required" }, { status: 400 });
  }
  if (!isAddress(userAddress)) {
    return NextResponse.json({ error: "invalid userAddress" }, { status: 400 });
  }

  const schedule = await kvGet<DcaSchedule>(dcaKeys.schedule(scheduleId));
  if (!schedule) {
    return NextResponse.json({ error: "schedule not found" }, { status: 404 });
  }
  if (schedule.userAddress.toLowerCase() !== userAddress.toLowerCase()) {
    return NextResponse.json({ error: "not authorized" }, { status: 403 });
  }

  const logs = (await kvGet<DcaExecutionLog[]>(dcaKeys.logs(scheduleId))) ?? [];
  return NextResponse.json({
    ok: true,
    scheduleId,
    status: schedule.status,
    runsCompleted: schedule.runsCompleted,
    runsFailed:    schedule.runsFailed,
    totalSpent:    schedule.totalSpent,
    totalBought:   schedule.totalBought,
    lastRunAt:     schedule.lastRunAt,
    nextRunAt:     schedule.nextRunAt,
    lastError:     schedule.lastError,
    logs,
  });
}
