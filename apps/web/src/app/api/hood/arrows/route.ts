/**
 * Public read of the Blue Hood arrow feed + hit-rate.
 *
 * Returns the last N arrows (newest first) plus computed 7d hit rate. UI
 * uses this to render the Arrows feed section. Read-only and public — same
 * shape as /api/hood/snapshot.
 *
 * CDN-CACHED, deliberately (was `no-store` until the second Upstash
 * suspension). The bill for this route used to be OPEN TABS × FEED LENGTH:
 * three clients poll every 15s, and each GET cost 1 + min(400, feed length)
 * KV commands — an index read plus one read per arrow. A single open
 * /app/hood/arrows tab was ~2.3M KV commands/day, which is how a 500K/month
 * allowance died in about five hours.
 *
 * Both terms are now gone:
 *   • `s-maxage` (#148 ①) killed the tab-count term — N tabs collapse to one
 *     origin read per 30s window.
 *   • the hydrated blob (#148 ②, `lib/blue-hood/arrow-cache.ts`) killed the
 *     fan-out — this handler reads ONE key and gets the arrow records with it.
 * ~401 commands per request became 1. The blob is a cache; `bh:arrow:feed`
 * and `bh:arrow:{id}` are still the source of truth and are never written here.
 *
 * 30s is far inside the data's own refresh rate — the engine polls every 300s
 * and arrows fire single digits per day — so this trades no freshness a user
 * could perceive. `max-age=0` keeps the BROWSER revalidating every time, so
 * the shared edge cache is the only thing serving stale, never a private one.
 *
 * ① and ② both attacked REQUEST COUNT. What was left is per-response SIZE:
 * `?limit=200` — the URL the Inbox and the Track Record both poll — ships
 * 49,771 B gzip, of which 26.3% is four fields no client renders. The default
 * list now omits them and says so in the payload; `?fields=full` returns the
 * complete record. Nothing is deleted — see lib/blue-hood/arrow-fields.ts.
 *
 * ⚠ THIS ROUTE CAN NOW 503. It could not before ②, and the reasoning below
 * changed with it — read the CACHE_CONTROL note rather than assuming.
 */
import { NextRequest, NextResponse } from "next/server";
import { readArrowFeed } from "@/lib/blue-hood/arrow-cache";
import { isPublicArrow } from "@/lib/blue-hood/public-feed";
import { computeHitRate } from "@/lib/blue-hood/hit-rate-gate";
import { parseArrowFieldMode, projectArrows, omittedFieldsNote } from "@/lib/blue-hood/arrow-fields";

export const runtime = "nodejs";

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 200;

/**
 * Shared-edge cache only. `public` + `s-maxage` = the CDN may hold it for 30s;
 * `max-age=0` = the browser may not, so no user ever reads a private stale copy.
 *
 * ⚠ THE PREMISE OF THIS CONSTANT CHANGED IN #148 ②. It used to read: "SWR is
 * safe here because this route cannot 503 — a KV outage surfaces as
 * `{ok:true, arrows:[]}`, so 60s of stale-but-true beats an empty feed
 * asserted as fact." That lie is now fixed (`readArrowFeed` probes, and the
 * handler 503s), so the old justification is void and the question had to be
 * re-asked from scratch rather than inherited.
 *
 * SWR still earns its place, for a DIFFERENT reason. The old warning — never
 * put SWR on a route that 503s, because the CDN will serve a cached 200 over a
 * real outage — is about /api/hood/snapshot, whose PURPOSE is to signal engine
 * state. This route's purpose is to show arrows. Serving arrows that are up to
 * 90s old (30s fresh + 60s stale) during a KV blip is true, useful, and
 * strictly better than an error page; past that window the 503 does surface.
 * Monitoring honesty lives on /api/hood/health and /api/hood/snapshot, which
 * carry no SWR, so nothing here can mask an outage from the thing watching it.
 *
 * APPLIED ON THE SUCCESS PATH ONLY. The 503 below ships `no-store` — caching an
 * error at the edge would strand every client behind it for the full window.
 */
const CACHE_CONTROL = "public, max-age=0, s-maxage=30, stale-while-revalidate=60";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, parseInt(url.searchParams.get("limit") ?? String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT),
  );

  // Default list drops four audit/provenance fields no client renders — 26.3%
  // of a `?limit=200` response, which is the URL both the Inbox and the Track
  // Record poll. `?fields=full` returns everything. See lib/blue-hood/
  // arrow-fields.ts for the measurement and for why this is a projection and
  // not a deletion. The CDN keys on the full URL, so the two modes cache apart.
  const fieldMode = parseArrowFieldMode(url.searchParams);

  // ONE KV command (#148 ②). The blob already holds the newest
  // ARROW_HYDRATED_MAX records, so the old "over-read the id list ×3 so the
  // test-arrow filter can't starve the result" trick is gone — we filter the
  // whole hydrated window and then slice, which is strictly more accurate.
  const feed = await readArrowFeed();

  // A KV failure is NOT an empty feed. Before ② this route answered a suspended
  // database with `{ok:true, arrows:[], hit_rate:{ready:false}}` — publishing
  // "Blue Hood has no track record" as fact while 300+ graded arrows sat intact
  // in KV. That happened in production on 2026-08-27. Say "unknown" instead.
  if (feed.status === "unavailable") {
    return NextResponse.json(
      {
        ok: false,
        reason: "kv_error",
        error: `Arrow feed unavailable — ${feed.reason}. This is NOT an empty feed: the track record is UNKNOWN right now, not zero.`,
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  const all = feed.arrows;

  // T-A #1 (round 2) — the public track record ONLY accepts engine-fired
  // arrows. Legacy records without `origin` are back-compat treated as
  // engine (they predate the field); every write since T-A carries it.
  // `test: true` still hides for legacy arrows that predate `origin`.
  // `?include_test=1` is honored ONLY in dev to help QA.
  //
  // The predicate is `isPublicArrow` from public-feed.ts, NOT a local copy.
  // This route used to hand-roll it, which made three parallel definitions of
  // a TRUST boundary (here, /api/acp/arrows, inbox/unread-count) that could
  // drift apart silently — a seeded arrow leaking into one public surface but
  // not another. One definition, imported.
  const includeTest = url.searchParams.get("include_test") === "1"
    && process.env.NODE_ENV !== "production";
  const arrows = includeTest ? all : all.filter(isPublicArrow);

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
      // Hit rate is computed from the UNPROJECTED arrows above — the trim must
      // never be able to move a published number. It can't today (the four
      // fields aren't inputs to `computeHitRate`), and this ordering keeps that
      // true if one ever becomes one.
      arrows: projectArrows(arrows.slice(0, limit), fieldMode),
      // Self-describing: the response names what it withheld and how to get it.
      // An escape hatch nobody can discover is not an escape hatch.
      ...omittedFieldsNote(fieldMode),
      arrows_today,
      hit_rate,
      per_type,
      graded_breakdown,
      test_arrows_hidden: includeTest ? 0 : all.length - arrows.length,
      // Blob provenance. Makes cache staleness OBSERVABLE instead of silent —
      // if write-time patching ever stops working, `feed_built_at` goes stale
      // in the response and anyone can see it without KV access.
      feed_built_at: feed.built_at,
      feed_source: feed.source,
    },
    { headers: { "Cache-Control": CACHE_CONTROL } },
  );
}
