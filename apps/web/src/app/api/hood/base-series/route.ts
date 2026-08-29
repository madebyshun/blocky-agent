/**
 * Public read of the permanent BASE (chain 8453) oracle-vs-DEX price archive.
 *
 *   GET /api/hood/base-series                      → today (UTC)
 *   GET /api/hood/base-series?day=20260828         → one day
 *   GET /api/hood/base-series?days=7               → last 7 days ending today
 *   GET /api/hood/base-series?from=20260828&to=20260904
 *
 * ## Why this is a separate route from `/api/hood/series`
 *
 * Not style, and not duplication for its own sake. The two archives are keyed
 * differently and MUST NOT meet:
 *
 *   RH   `bh:series:day:*`       keyed by BARE TICKER
 *   Base `bh:base:series:day:*`  keyed by day, rows carry `chain: "base"`
 *
 * NVDA / META / GOOGL / AAPL trade on BOTH chains, so a bare ticker does not
 * identify a token — chain + address does. Teaching the RH route to also serve
 * Base would mean one handler holding both key builders, and the only thing
 * standing between "serve Base" and "write Base into RH history" would be
 * whichever branch the code took. Two routes, two key namespaces, no shared
 * builder: the mistake stops being expressible rather than being merely
 * discouraged. (`kvBaseSeriesDay` is not imported here either — this route asks
 * `readBaseSeriesDays` for days and never constructs a key at all.)
 *
 * ## What this route refuses to collapse
 *
 * Four kinds of "nothing", kept distinct all the way to the consumer:
 *
 *   before_archive → we were not recording yet. No backfill exists or ever
 *                    will; history cannot be reconstructed after the fact.
 *   miss           → we were recording and that day holds nothing priced.
 *   error          → KV could not be read. That day's contents are UNKNOWN.
 *   hit + coverage → present, with the hours we expected and did not get.
 *
 * `error` collapsed into an empty array is how a monitoring blackout gets
 * rendered as a flat, efficient market — which for THIS dataset would be a
 * false product finding, not merely a display bug: the whole question the Base
 * archive exists to answer is "does Base drift ever reach the threshold", and
 * an unreadable day silently served as "no drift" biases that answer toward no.
 * Any response containing an `error` day is sent `no-store` so a transient blip
 * cannot be frozen into the CDN as that day's answer.
 *
 * ## `peaks` is the field that matters
 *
 * `points` is hourly; `peaks` is per-CYCLE (5 min). The rule engine evaluates
 * every cycle, so an hourly-only read would under-sample exactly the tail that
 * decides firing. Consumers asking "did Base ever approach the threshold" must
 * read `peaks`, not `points` — the legend says so in the payload, not just here.
 *
 * And "the threshold" is two numbers, not one: `DRIFT_MIN_ABS_PCT` (2%) applies
 * while the market is CLOSED, `ARB_MIN_ABS_PCT` (1%) while it is OPEN. Each peak
 * is therefore scored against the bar for the session recorded ON THAT PEAK.
 * Scoring everything against 2% would drop open-market peaks in the 1–2% band —
 * the very ones that fire arb — and bias this archive's only question toward no.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  readBaseSeriesDays,
  baseSeriesCoverage,
  datingCounts,
  oracleDating,
  type BaseSeriesCoverage,
} from "@/lib/base-stocks/base-series";
import { BASE_SERIES_ARCHIVE_START, yyyymmdd } from "@/lib/blue-hood/kv-keys";
import { ARB_MIN_ABS_PCT, DRIFT_MIN_ABS_PCT } from "@/lib/blue-hood/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Hard ceiling on days per request — one KV read each. A year of history is 12
 *  calls; a year in one call is a scraper multiplying our request bill by 365×
 *  per hit, against a cap that has suspended this engine three times. */
const MAX_DAYS = 31;

const DAY_MS = 86_400_000;

/** The bar a peak had to clear TO COUNT, given the market clock at the peak.
 *  Mirrors `detectCandidate` in `rule-engine.ts`: drift fires only while closed,
 *  arb only while open. Kept as a function rather than a constant so a caller
 *  cannot forget that "the threshold" is not one number. */
function thresholdFor(isOpen: boolean): number {
  return isOpen ? ARB_MIN_ABS_PCT : DRIFT_MIN_ABS_PCT;
}

/** `YYYYMMDD` → UTC ms, or null if it is not a real calendar day. Rejects
 *  20260231 as well as garbage: parsing must not invent a date. */
function parseDay(s: string): number | null {
  if (!/^\d{8}$/.test(s)) return null;
  const ms = Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
  if (Number.isNaN(ms)) return null;
  return yyyymmdd(new Date(ms)) === s ? ms : null;
}

function bad(error: string) {
  return NextResponse.json(
    { ok: false, error, archive_start: BASE_SERIES_ARCHIVE_START, max_days: MAX_DAYS },
    { status: 400, headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}

export async function GET(req: NextRequest) {
  const q = new URL(req.url).searchParams;
  const now = new Date();
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

  let fromMs: number;
  let toMs: number;

  if (q.has("from") || q.has("to")) {
    const from = parseDay(q.get("from") ?? "");
    const to = q.has("to") ? parseDay(q.get("to") ?? "") : todayMs;
    if (from === null) return bad("`from` must be a real calendar day as YYYYMMDD");
    if (to === null) return bad("`to` must be a real calendar day as YYYYMMDD");
    if (to < from) return bad("`to` is before `from`");
    fromMs = from;
    toMs = to;
  } else if (q.has("days")) {
    const n = Number(q.get("days"));
    if (!Number.isInteger(n) || n < 1) return bad("`days` must be a positive integer");
    toMs = todayMs;
    fromMs = todayMs - (n - 1) * DAY_MS;
  } else if (q.has("day")) {
    const d = parseDay(q.get("day") ?? "");
    if (d === null) return bad("`day` must be a real calendar day as YYYYMMDD");
    fromMs = toMs = d;
  } else {
    fromMs = toMs = todayMs;
  }

  const span = Math.round((toMs - fromMs) / DAY_MS) + 1;
  if (span > MAX_DAYS) {
    return bad(`window is ${span} days; the cap is ${MAX_DAYS} per request (one KV read per day)`);
  }

  const requested: string[] = [];
  for (let ms = fromMs; ms <= toMs; ms += DAY_MS) requested.push(yyyymmdd(new Date(ms)));

  const reads = await readBaseSeriesDays(requested);

  const unreadable = reads.filter((r) => r.status === "error").map((r) => r.day);
  // Every requested day errored → we know nothing about this window. A 503 says
  // that; a 200 with an empty array would claim we looked and found nothing.
  if (unreadable.length === requested.length && requested.length > 0) {
    return NextResponse.json(
      {
        ok: false,
        reason: "kv_error",
        error:
          "KV unreachable — the Base archive could not be read. This is NOT the same as the archive being empty; its contents for this window are UNKNOWN.",
        requested,
      },
      { status: 503, headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  }

  const coverage = new Map<string, BaseSeriesCoverage>();
  for (const r of reads) {
    if (r.status === "hit") coverage.set(r.day, baseSeriesCoverage(r.day, r.value.points, now));
  }

  const days = reads.map((r) =>
    r.status === "hit"
      ? {
          day: r.day,
          status: r.status,
          v: r.value.v,
          chain: r.value.chain,
          // Cycles that CONTRIBUTED a write, not total polls — see legend.
          cycles: r.value.cycles,
          coverage: coverage.get(r.day)!,
          // Vintage is per ITEM, and `v` above does not report it — on this
          // archive's first day the record is stamped `v: 2` while ten of its
          // fourteen items predate the field. Shipped next to `v` on purpose,
          // so the contradiction is visible in one object rather than needing a
          // reader who already knows to distrust `v`.
          peak_dating: datingCounts(r.value.peaks),
          point_dating: datingCounts(r.value.points.flatMap((p) => p.rows)),
          peaks: r.value.peaks,
          points: r.value.points,
        }
      : r.status === "error"
        ? { day: r.day, status: r.status, message: r.message }
        : { day: r.day, status: r.status },
  );

  const hits = reads.flatMap((r) => (r.status === "hit" ? [r.value] : []));
  const points = hits.reduce((n, v) => n + v.points.length, 0);
  const rows = hits.reduce((n, v) => n + v.points.reduce((m, p) => m + p.rows.length, 0), 0);

  // The headline the whole archive exists to produce. Computed in code from the
  // stored peaks — never narrated, never estimated. Null when there is nothing
  // on record, because "no observation" is not "zero drift".
  const allPeaks = hits.flatMap((v) => v.peaks);
  const maxPeak = allPeaks.reduce<(typeof allPeaks)[number] | null>(
    (best, p) => (best === null || p.abs_drift_pct > best.abs_drift_pct ? p : best),
    null,
  );
  // The threshold SWAPS WITH THE SESSION — 2% closed (drift), 1% open (arb) —
  // so there is no single number to compare a mixed-session set against.
  // Measuring every peak against 2.0 would silently discard open-market peaks
  // between 1% and 2%, which are precisely the ones the engine fires on while
  // the market is open. That undercount would bias the archive's one question
  // ("does Base ever reach the threshold") toward no — the same false-negative
  // this route refuses everywhere else. `BaseSeriesPeak.is_open` exists for
  // this; its own doc says the peak's session decides which rule it could have
  // triggered.
  const crossed = allPeaks.filter((p) => p.abs_drift_pct >= thresholdFor(p.is_open));

  const absentHours = [...coverage.values()].flatMap((c) => c.hours_absent);
  // A `miss` is only a gap when it sits BETWEEN two days holding data. Asking
  // for 31 days of a days-old archive would otherwise report weeks of "gap" for
  // days nothing was ever alive to record — an alarm on the expected, which is
  // how a real signal gets tuned out.
  const hitDays = reads.filter((r) => r.status === "hit").map((r) => r.day);
  const missedDays =
    hitDays.length > 0
      ? reads
          .filter(
            (r) =>
              r.status === "miss" && r.day > hitDays[0] && r.day < hitDays[hitDays.length - 1],
          )
          .map((r) => r.day)
      : [];

  const yesterday = yyyymmdd(new Date(todayMs - DAY_MS));
  const mutable = requested.some((d) => d >= yesterday);
  const cache = unreadable.length
    ? "no-store, max-age=0"
    : mutable
      ? "public, s-maxage=300, stale-while-revalidate=600"
      : "public, s-maxage=86400, stale-while-revalidate=604800";

  return NextResponse.json(
    {
      ok: true,
      chain: "base",
      chain_id: 8453,
      archive_start: BASE_SERIES_ARCHIVE_START,
      thresholds_abs_pct: { closed_drift: DRIFT_MIN_ABS_PCT, open_arb: ARB_MIN_ABS_PCT },
      complete: unreadable.length === 0,
      unreadable,
      contiguous: absentHours.length === 0 && missedDays.length === 0,
      gaps: { days: missedDays, hours: absentHours },
      requested,
      totals: {
        days_requested: requested.length,
        days_with_data: hits.length,
        points,
        rows,
        cycles_contributing: hits.reduce((n, v) => n + v.cycles, 0),
      },
      // Null, not 0, when nothing is on record — absence is not a measurement.
      max_abs_drift_pct: maxPeak?.abs_drift_pct ?? null,
      // The headline does not travel without its own dating state. This is the
      // single figure most likely to be quoted as "the strongest case for the
      // Base desk", and a high-water mark set while the Chainlink feed was
      // frozen is an artefact of the freeze, not evidence about Base — the two
      // are the same number and opposite findings. Attached to the peak object
      // rather than offered as a sibling field so it cannot be dropped by a
      // caller destructuring the peak.
      max_drift_peak:
        maxPeak === null ? null : { ...maxPeak, oracle_dating: oracleDating(maxPeak) },
      peaks_at_or_above_threshold: crossed.length,
      // The dating breakdown OF THE CROSSERS, not of all peaks: when this count
      // stops being zero it becomes the archive's answer, and "how many of the
      // peaks that cleared the bar could we even date" is then the first
      // question a reader should be able to ask without a second request.
      crossed_dating: datingCounts(crossed),
      peaks_dating: datingCounts(allPeaks),
      // Never ship the numerator alone. `0` out of 0 observations ("we have no
      // record") and `0` out of 4,000 ("the desk was calm all month") are the
      // same digit and opposite findings — and this archive exists to answer
      // exactly the question those two would be confused on.
      peaks_observed: allPeaks.length,
      days,
      legend: {
        hit: "day present in the archive",
        miss: "we were recording; this day holds no cycle where anything priced",
        error: "KV could not be read — contents UNKNOWN, not empty",
        before_archive: `earlier than ${BASE_SERIES_ARCHIVE_START}, when Base recording began — no backfill exists or ever will`,
        peaks:
          "per-CYCLE (5 min) |drift| high-water marks. Use THESE, not `points`, to ask whether the threshold was approached — `points` is hourly and deliberately under-samples the tail that decides firing",
        points: "hourly snapshots, mirroring the RH archive so one reader walks both",
        cycles:
          "cycles that CONTRIBUTED a write, NOT total polls. On a quiet day ~283 of 288 cycles write nothing. This is a FLOOR on observation count — do NOT use it as a denominator",
        max_abs_drift_pct:
          "null means nothing is on record, which is NOT the same as zero drift",
        thresholds_abs_pct:
          "TWO bars, not one: a peak while the market is CLOSED is measured against closed_drift (2%), while OPEN against open_arb (1%). Comparing a mixed-session set against a single number undercounts",
        peaks_observed:
          "denominator for `peaks_at_or_above_threshold`. 0 here means NOTHING IS ON RECORD — read the ratio, never the numerator alone",
        peaks_at_or_above_threshold:
          "peaks that cleared the bar FOR THEIR OWN SESSION. This is NECESSARY, NOT SUFFICIENT, for an arrow: an open-market peak must also carry a LONG_DEX/SHORT_DEX verdict to fire arb, and `peaks` does not record the verdict. Read this as 'reached the threshold', never as 'would have fired'",
        chain:
          "Base (8453) only. RH Chain (4663) history lives at /api/hood/series and the two must never be pooled — a ticker exists on both chains, so ticker alone does not identify a token",
        contiguous:
          "false when a readable day still has holes — distinct from `complete`, which is only about whether the days could be read at all",
        v: "the writer that last TOUCHED the day, NOT the vintage of the items inside it. Every write re-stamps the whole day while carrying already-written peaks and points forward unchanged, so `v: 2` does NOT mean every item in that day has `oracle_updated_at`. On 20260828 it does not: the day is stamped 2 and ten of its fourteen items predate the field. Read `peak_dating`/`point_dating` for vintage; `v` cannot answer it",
        oracle_dating:
          "THREE states, never two. `dated` = holds the Chainlink round the price was measured against. `undatable` = the feed was read this cycle and could not be dated (stored null). `predates_field` = written before the field existed, so nobody ever looked (key absent). Folding the third into the second turns 'we never looked' into 'we looked and found nothing' — a claim the archive never made",
        peak_dating:
          "`oracle_dating` tallied over this day's peaks. A day whose peaks are all `predates_field` cannot support any statement about oracle freshness, no matter how large its drift",
        point_dating: "`oracle_dating` tallied over every row of this day's hourly points",
        peaks_dating: "`oracle_dating` tallied over every peak in the window",
        crossed_dating:
          "`oracle_dating` tallied over the peaks counted by `peaks_at_or_above_threshold`. When that count stops being zero, this says how many of the crossers could be dated at all — a crosser set that is mostly `undatable` is a finding about the feed, not about Base",
      },
    },
    { headers: { "Cache-Control": cache } },
  );
}
