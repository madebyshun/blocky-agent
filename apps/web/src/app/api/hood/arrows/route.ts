/**
 * Public read of the Blue Hood arrow feed + hit-rate.
 *
 * Returns the last N arrows (newest first) plus computed 7d hit rate. UI
 * uses this to render the Arrows feed section. Read-only and public — same
 * shape as /api/hood/snapshot.
 *
 * CDN-CACHED, deliberately (was `no-store` until the second Upstash
 * suspension). One GET here costs 1 + min(400, feed length) KV commands: an
 * index read plus one read per arrow. Three clients poll it every 15s and the
 * feed is never trimmed, so the bill scaled with OPEN TABS × FEED LENGTH —
 * a single open /app/hood/arrows tab was ~2.3M KV commands/day, which is how
 * a 500K/month allowance died in about five hours.
 *
 * `s-maxage` makes the cost independent of tab count: N tabs collapse to one
 * origin read per window. That removes the unbounded term; the per-request
 * fan-out is the other half and is being fixed separately (task #148 ②).
 *
 * 30s is far inside the data's own refresh rate — the engine polls every 300s
 * and arrows fire single digits per day — so this trades no freshness a user
 * could perceive. `max-age=0` keeps the BROWSER revalidating every time, so
 * the shared edge cache is the only thing serving stale, never a private one.
 */
import { NextRequest, NextResponse } from "next/server";
import { kvGet } from "@/lib/kv";
import { KV_ARROW_FEED, kvArrow } from "@/lib/blue-hood/kv-keys";
import type { Arrow } from "@/lib/blue-hood/types";
import { computeHitRate } from "@/lib/blue-hood/hit-rate-gate";

export const runtime = "nodejs";

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 200;

/**
 * Shared-edge cache only. `public` + `s-maxage` = the CDN may hold it for 30s;
 * `max-age=0` = the browser may not, so no user ever reads a private stale copy.
 *
 * `stale-while-revalidate` is safe HERE specifically, and the reason is worth
 * naming because it is not general: this route cannot 503. Its reads go through
 * `kvGet`, which swallows a throw and returns null, so a KV outage surfaces as
 * `{ ok: true, arrows: [] }` — an empty feed asserted as fact. Serving a stale
 * but true response for 60s is strictly better than serving that. Note the
 * direction of the argument: SWR is not fixing the lie, it is narrowly not
 * making it worse. The lie itself is a `kvGetProbe` conversion (task #150).
 *
 * Do NOT copy this constant onto a route that returns 503 on KV error — there
 * SWR would serve a cached 200 over a real outage, which is the opposite of
 * what /api/hood/snapshot was built to do. See that file's success-path-only
 * placement.
 */
const CACHE_CONTROL = "public, max-age=0, s-maxage=30, stale-while-revalidate=60";

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
    { headers: { "Cache-Control": CACHE_CONTROL } },
  );
}
