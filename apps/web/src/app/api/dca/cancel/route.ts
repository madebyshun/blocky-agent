/**
 * POST /api/dca/cancel
 *
 * Body: { scheduleId, userAddress }
 * Marks the schedule as cancelled + removes it from the active set (cron queue).
 * The user's on-chain approve() is untouched — user can revoke via a plain
 * `approve(keeper, 0)` tx if they want to zero the allowance.
 *
 * v1 auth: caller must pass the same userAddress that owns the schedule.
 * This is the same weak-auth model as the DCA card itself (we trust the wallet
 * signature happens client-side; a full SIWE guard is TODO for v2).
 */

import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { kvGet, kvSet } from "@/lib/kv";
import { dcaKeys } from "@/lib/dca/kv-keys";
import type { DcaSchedule } from "@/lib/dca/types";

export const runtime = "nodejs";

export async function POST(req: Request) {
  let body: { scheduleId?: string; userAddress?: string } = {};
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "invalid json" }, { status: 400 }); }

  const scheduleId  = String(body.scheduleId ?? "").trim();
  const userAddress = String(body.userAddress ?? "").trim();
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
  if (schedule.status === "cancelled") {
    return NextResponse.json({ ok: true, alreadyCancelled: true });
  }

  const updated: DcaSchedule = { ...schedule, status: "cancelled" };
  await kvSet(dcaKeys.schedule(scheduleId), updated);

  // Remove from active set
  const active = (await kvGet<string[]>(dcaKeys.activeSet())) ?? [];
  const nextActive = active.filter((id) => id !== scheduleId);
  await kvSet(dcaKeys.activeSet(), nextActive);

  return NextResponse.json({ ok: true, scheduleId });
}
