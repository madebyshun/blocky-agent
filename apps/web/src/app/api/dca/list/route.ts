/**
 * GET /api/dca/list?address=0x…
 *
 * List all DCA schedules for a user. Returns a lightweight view (no keeper key).
 * Public read — no auth required because schedules leak nothing sensitive
 * (keeperAddress is trivially recoverable given the user's address by
 * anyone who has KEEPER_MASTER_KEY, which only the server does).
 */

import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { kvGet } from "@/lib/kv";
import { dcaKeys } from "@/lib/dca/kv-keys";
import type { DcaSchedule, DcaScheduleView } from "@/lib/dca/types";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const u = new URL(req.url);
  const address = u.searchParams.get("address") ?? "";
  if (!isAddress(address)) {
    return NextResponse.json({ error: "invalid address" }, { status: 400 });
  }

  const ids = (await kvGet<string[]>(dcaKeys.userIndex(address))) ?? [];
  const schedules = await Promise.all(
    ids.map((id) => kvGet<DcaSchedule>(dcaKeys.schedule(id))),
  );
  const views: DcaScheduleView[] = schedules
    .filter((s): s is DcaSchedule => s !== null)
    .map(({ keeperAddress: _hidden, ...rest }) => rest);

  return NextResponse.json({ ok: true, schedules: views });
}
