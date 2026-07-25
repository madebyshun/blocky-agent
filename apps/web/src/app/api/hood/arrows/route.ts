/**
 * Public read of the Blue Hood arrow feed + hit-rate.
 *
 * Returns the last N arrows (newest first) plus computed 7d hit rate. UI
 * uses this to render the Arrows feed section. Read-only, public, cache-
 * busted — same shape as /api/hood/snapshot.
 */
import { NextRequest, NextResponse } from "next/server";
import { kvGet } from "@/lib/kv";
import { KV_ARROW_FEED, kvArrow } from "@/lib/blue-hood/kv-keys";
import type { Arrow } from "@/lib/blue-hood/types";
import { computeHitRate } from "@/lib/blue-hood/hit-rate-gate";

export const runtime = "nodejs";

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 200;

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, parseInt(url.searchParams.get("limit") ?? String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT),
  );

  // Read a larger slice than the response `limit` so we can filter out
  // synthetic `test: true` arrows and still return `limit` real ones.
  const readSlice = Math.min(MAX_LIMIT * 2, limit * 3);
  const ids = ((await kvGet<string[]>(KV_ARROW_FEED)) ?? []).slice(0, readSlice);
  const all = (await Promise.all(ids.map((id) => kvGet<Arrow>(kvArrow(id))))).filter(
    (a): a is Arrow => a !== null,
  );

  // T-A #1 (round 2) — the public track record ONLY accepts engine-fired
  // arrows. Legacy records without `origin` are back-compat treated as
  // engine (they predate the field); every write since T-A carries it.
  // `test: true` still hides for legacy arrows that predate `origin`.
  // `?include_test=1` is honored ONLY in dev to help QA.
  const includeTest = url.searchParams.get("include_test") === "1"
    && process.env.NODE_ENV !== "production";
  const arrows = includeTest ? all : all.filter((a) => {
    if (a.test) return false;
    if (a.origin && a.origin !== "engine") return false;
    return true;
  });

  // P3.2 — aggregate + per-type gate now live in @/lib/blue-hood/hit-rate-gate
  // so /api/acp/arrows and both UI clients read the same shape. Aggregate
  // display gate is 30 valid arrows; per-type (arb / drift) gate is 15 own
  // samples. VOID + informational stay excluded from every denominator.
  const { hit_rate, per_type, graded_breakdown } = computeHitRate(arrows);

  const arrows_today = arrows.filter(
    (a) => new Date(a.fired_at).getTime() >= Date.now() - 24 * 3_600 * 1000,
  ).length;

  return NextResponse.json(
    {
      ok: true,
      arrows: arrows.slice(0, limit),
      arrows_today,
      hit_rate,
      per_type,
      graded_breakdown,
      test_arrows_hidden: includeTest ? 0 : all.length - arrows.length,
    },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}
