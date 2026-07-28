/**
 * Public read of the latest Blue Hood snapshot.
 *
 * `/hood` calls this on mount + on a client-side timer so it doesn't need
 * to hit KV directly from React. Read-only, public, cache-busting headers
 * — no secret required.
 *
 * WHY kvGetProbe (not kvGet): a swallowed KV throw returns null, which the old
 * code reported as "Poller hasn't run" — the exact blind message that masked
 * the 2026-07-27 Upstash-cap outage. We now probe WITHOUT swallowing and split
 * the 503 into two honest causes so the board never blames the poller for what
 * is actually a monitoring blackout. `reason` is machine-readable so the client
 * can pick a banner; the richer WHY lives at `/api/hood/health`.
 */
import { NextResponse } from "next/server";
import { kvGetProbe } from "@/lib/kv";
import { KV_SNAPSHOT_LATEST } from "@/lib/blue-hood/kv-keys";
import type { HoodSnapshot } from "@/lib/blue-hood/types";

export const runtime = "nodejs";

export async function GET() {
  const probe = await kvGetProbe<HoodSnapshot>(KV_SNAPSHOT_LATEST);

  if (probe.status === "error") {
    // KV threw (throttle / plan-cap / network) — we are BLIND, not down. Do not
    // say "poller hasn't run": the engine may be perfectly healthy behind an
    // unreadable KV. See /api/hood/health for the full discrimination.
    return NextResponse.json(
      {
        ok: false,
        reason: "kv_error",
        error: `KV unreachable (${probe.message}). Snapshot state UNKNOWN — monitoring is blind, not confirmed down.`,
      },
      { status: 503, headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  }

  if (probe.status === "miss") {
    return NextResponse.json(
      { ok: false, reason: "never_polled", error: "No snapshot yet — the poller has not produced one (cold start)." },
      { status: 503, headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  }

  return NextResponse.json(
    { ok: true, snapshot: probe.value },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}
