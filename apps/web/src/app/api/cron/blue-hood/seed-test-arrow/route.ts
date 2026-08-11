/**
 * DEV-ONLY: seed a synthetic arrow so the /hood UI can be visually
 * verified without waiting for a real drift to appear.
 *
 * Refuses to run outside NODE_ENV=development. In prod this endpoint
 * always 404s — the file is left in the tree because the poll cron
 * relies on the same rule-engine primitives it exercises.
 *
 * `?push=1` (T-D demo only, non-prod): after firing the seeded arrow,
 * additionally run a REAL push fan-out through the real VAPID sign +
 * real push service. Bypasses the three engine/seeded guards on
 * purpose so the demo gif shows tab-closed → notification → click, but
 * ONLY when NODE_ENV !== "production" AND the seed route is reachable
 * (i.e. this door itself is closed in prod, which shuts both bypasses
 * simultaneously). Reviewer's DoD: "seed test được, miễn là qua đường
 * push thật".
 */
import { NextRequest, NextResponse } from "next/server";
import { fireArrow } from "@/lib/blue-hood/rule-engine";
import { pushArrowToAll, ensureVapidConfigured } from "@/lib/blue-hood/push";
import { writeChatCard } from "@/lib/blue-hood/chat-card";
import { kvGet, kvSet } from "@/lib/kv";
import { kvArrow } from "@/lib/blue-hood/kv-keys";
import type { ArrowType, Arrow } from "@/lib/blue-hood/types";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const url = new URL(req.url);
  const ticker = (url.searchParams.get("ticker") ?? "AAPL").toUpperCase();
  const type = (url.searchParams.get("type") ?? "drift") as ArrowType;
  const direction = url.searchParams.get("direction") === "down" ? "down" : "up";
  const refPrice = Number(url.searchParams.get("ref") ?? "0") || 100;
  const windowH = Number(url.searchParams.get("window") ?? "0") || (type === "arb" ? 4 : 6);

  // Reviewer T-A #1: seed arrows ALWAYS carry origin="seeded", even when
  // `?with_brief=1` is set. That flag only controls whether A4 gets called
  // (useful for exercising the brief pipeline in localhost). Origin stays
  // seeded so the arrow is never eligible for the public feed/hit-rate,
  // regardless of what UI plumbing the caller is exercising.
  //
  // Bug fix (2026-07-21, pre-merge task #1): `withBrief` only removed the
  // `test:true` flag but the fireArrow guard `skipAsync = test || origin
  // === "seeded"` still short-circuited on the seeded origin — so the A4
  // brief was NEVER attached for `?with_brief=1`. Fix: also pass
  // `forceBrief: true` when withBrief is set, which explicitly lifts the
  // guard for THIS one seeded arrow. Push fan-out stays hard-gated on
  // origin === "engine" — the demo can't cross that.
  const withBrief = url.searchParams.get("with_brief") === "1"
    || url.searchParams.get("real") === "1"; // legacy alias — remove after v1
  const demoPush = url.searchParams.get("push") === "1";
  const result = await fireArrow(
    ticker,
    {
      type,
      expected_direction: direction as "up" | "down",
      grading_window_h: windowH,
      reference_price: refPrice,
    },
    Math.floor(Date.now() / 1000),
    withBrief
      ? { origin: "seeded", forceBrief: true }
      : { origin: "seeded", test: true }, // `test` still gates A4 call
  );

  if (!result.arrow) {
    return NextResponse.json({
      ok: false,
      message: `Deduped (${result.skipReason ?? "unknown"}) — an open arrow or cooldown blocks ${ticker}`,
    });
  }
  const arrow = result.arrow;

  // ── T-D demo path ─────────────────────────────────────────────────────
  // The three prod guards (fireArrow skipAsync, pushArrowToAll self-check,
  // brief-worker origin check) all short-circuited above. `?push=1`
  // reaches AROUND those, but only after we've explicitly relabelled the
  // arrow with `origin: "engine"` LOCALLY (never persisted) so
  // pushArrowToAll's internal check accepts it. Guard is still tight:
  // this route 404s in prod, so the demo can only run in dev. Nothing
  // prunes prod push subs.
  let demo:
    | { attempted: false; reason: string }
    | { attempted: true; delivered: number; gone: number; errored: number }
    | undefined;
  if (demoPush) {
    if (!ensureVapidConfigured()) {
      demo = { attempted: false, reason: "vapid_keys_missing" };
    } else {
      // Also write a chat card here so #5 (Blue Chat consumer) can render
      // it immediately — normal seeded path already writes one, but ?push=1
      // implies "run the whole real path"; this makes it explicit.
      await writeChatCard(arrow);
      // Relabel LOCAL COPY only; the persisted arrow stays `origin: "seeded"`
      // so no downstream metric can be tainted. This is the ONLY moment in
      // the codebase where a seeded arrow reaches pushArrowToAll.
      const demoArrow: Arrow = { ...arrow, origin: "engine", test: false };
      // Clear `test` from the persisted record too? No — the persisted
      // record stays seeded, we only mask the fields the fan-out reads.
      console.log(`[demo-push] seeded arrow ${arrow.serial} ${arrow.ticker} — forcing real push (dev only)`);
      const stats = await pushArrowToAll(demoArrow);
      demo = { attempted: true, delivered: stats.delivered, gone: stats.gone, errored: stats.errored };
      // Persist `brief_worker_at` so the UI shows the demo actually fired.
      const stored = await kvGet<Arrow>(kvArrow(arrow.id));
      if (stored) await kvSet(kvArrow(arrow.id), { ...stored, brief_worker_at: new Date().toISOString() });
    }
  }

  return NextResponse.json({ ok: true, arrow, demo });
}
