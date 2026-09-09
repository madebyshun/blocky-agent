/**
 * Blue Hood — the drawable price history for ONE ticker on ONE chain (#229).
 *
 *   GET /api/hood/ticker-series?ticker=NVDA&chain=base&days=14
 *
 * ## Why not just call /api/hood/series or /api/hood/base-series
 *
 * Those two serve the whole desk. A 14-day Base window is ~216 KB because it
 * carries every ticker's points AND every per-cycle peak, and the row-expand
 * panel that opened it wanted one ticker's hourly line. Shipping the archive to
 * the browser so the browser can throw away 90% of it is a cost paid on every
 * row a user expands, and it puts the ticker→row match on the client, where no
 * script tests it. Both problems go away by filtering server-side.
 *
 * ## `chain` is REQUIRED here, unlike /api/hood/ticker-detail
 *
 * That route defaults to `robinhood` because it predates the Base desk and had
 * live callers whose meaning would change under a stricter rule. This route has
 * none — it is new — so it can demand what that one could only invite. A
 * request without a chain is a 400, not an RH answer.
 *
 * The reason is #161 and #206: NVDA, META, GOOGL, AAPL and TSLA are real tokens
 * on BOTH chains, with different addresses, different pools and different
 * prices. A chart is an assertion about one of them. Defaulting a missing chain
 * would mean the most under-specified request gets the most confident-looking
 * answer, which is exactly how RH pools came to render under a Base badge.
 *
 * ## The two archives are read by two readers and never pooled
 *
 * `readSeriesDays` owns `bh:series:day:*`, `readBaseSeriesDays` owns
 * `bh:base:series:day:*`. This route imports NEITHER key builder — same
 * discipline `/api/hood/base-series` documents for itself. The chain picks a
 * reader; after that, `buildChartSeries` resolves the ticker inside whatever
 * that one reader returned, with no cross-chain fallback. There is nowhere in
 * this file that a Base ticker could be answered from RH history, because the
 * RH days were never fetched.
 *
 * ## What it refuses to collapse
 *
 * Everything `/api/hood/series` refuses, carried one level further: not just
 * `error` vs `miss` vs `before_archive` at the DAY level, but the reason each
 * individual HOUR is missing, so the renderer can break the line and label the
 * hole instead of drawing through it. `seriesCoverage` wrote the warning about
 * connecting 03:00 to 09:00 before any chart existed; this is the route that
 * has to honour it.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  readSeriesDays,
  seriesCoverage,
  SERIES_ARCHIVE_START,
} from "@/lib/blue-hood/poller";
import { readBaseSeriesDays, baseSeriesCoverage } from "@/lib/base-stocks/base-series";
import { BASE_SERIES_ARCHIVE_START, yyyymmdd } from "@/lib/blue-hood/kv-keys";
import {
  buildChartSeries,
  chartNote,
  isPlottable,
  DEADBAND_ABS_PCT,
  type ChartDayInput,
} from "@/lib/blue-hood/chart-series";
import type { HoodChain } from "@/lib/blue-hood/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KNOWN_CHAINS: readonly HoodChain[] = ["robinhood", "base"];

/** One KV read per day, against a cap that has starved this engine three times
 *  (task #123). A row-expand asks for 14; the ceiling is for hand-built URLs. */
const MAX_DAYS = 31;
const DEFAULT_DAYS = 14;
const DAY_MS = 86_400_000;

function bad(error: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json(
    { ok: false, error, max_days: MAX_DAYS, ...extra },
    { status: 400, headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}

export async function GET(req: NextRequest) {
  const q = new URL(req.url).searchParams;

  const ticker = (q.get("ticker") ?? "").trim().toUpperCase();
  if (!ticker) return bad("Missing ?ticker=");

  // No default. See the header: this route has no legacy callers to protect, so
  // an unstated chain is an unanswerable question rather than an RH one.
  const rawChain = q.get("chain");
  if (rawChain === null) {
    return bad(
      `Missing ?chain=. A ticker does not identify a token — ${ticker} may exist on more than one chain with different addresses, pools and prices. Expected one of: ${KNOWN_CHAINS.join(", ")}.`,
    );
  }
  const normalised = rawChain.trim().toLowerCase();
  if (!(KNOWN_CHAINS as readonly string[]).includes(normalised)) {
    return bad(`Unknown chain "${rawChain}". Expected one of: ${KNOWN_CHAINS.join(", ")}.`);
  }
  const chain = normalised as HoodChain;

  let days = DEFAULT_DAYS;
  if (q.has("days")) {
    const n = Number(q.get("days"));
    if (!Number.isInteger(n) || n < 1) return bad("`days` must be a positive integer");
    if (n > MAX_DAYS) {
      return bad(`window is ${n} days; the cap is ${MAX_DAYS} per request (one KV read per day)`);
    }
    days = n;
  }

  const now = new Date();
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const requested: string[] = [];
  for (let i = days - 1; i >= 0; i--) requested.push(yyyymmdd(new Date(todayMs - i * DAY_MS)));

  const archiveStart = chain === "base" ? BASE_SERIES_ARCHIVE_START : SERIES_ARCHIVE_START;

  // ONE reader per chain, chosen here and never mixed. The `hours_absent` list
  // comes from that chain's own coverage function rather than being re-derived:
  // those functions already encode the archive-start day and the partial current
  // day, and a second copy of that window logic is a second place for it to be
  // wrong in a direction that quietly shrinks the holes.
  let dayInputs: ChartDayInput[];
  let unreadable: string[];

  if (chain === "base") {
    const reads = await readBaseSeriesDays(requested);
    unreadable = reads.filter((r) => r.status === "error").map((r) => r.day);
    dayInputs = reads.map((r) =>
      r.status === "hit"
        ? {
            day: r.day,
            status: "hit" as const,
            points: r.value.points,
            hours_absent: baseSeriesCoverage(r.day, r.value.points, now).hours_absent,
          }
        : r.status === "error"
          ? { day: r.day, status: "error" as const, message: r.message }
          : { day: r.day, status: r.status },
    );
  } else {
    const reads = await readSeriesDays(requested);
    unreadable = reads.filter((r) => r.status === "error").map((r) => r.day);
    dayInputs = reads.map((r) =>
      r.status === "hit"
        ? {
            day: r.day,
            status: "hit" as const,
            points: r.value.points,
            hours_absent: seriesCoverage(r.day, r.value.points, now).hours_absent,
          }
        : r.status === "error"
          ? { day: r.day, status: "error" as const, message: r.message }
          : { day: r.day, status: r.status },
    );
  }

  // Every requested day errored ⟹ we know nothing about this window. A 503 says
  // that. A 200 carrying an all-gap series would be technically honest — the
  // gaps ARE labelled `unreadable` — but it would render as a chart-shaped
  // object, and a caller that only checks the status code would cache it.
  if (unreadable.length === requested.length && requested.length > 0) {
    return NextResponse.json(
      {
        ok: false,
        reason: "kv_error",
        chain,
        ticker,
        error:
          "The archive could not be read for this window. This is NOT the same as the archive being empty; its contents here are UNKNOWN.",
        requested,
      },
      { status: 503, headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  }

  const series = buildChartSeries(ticker, chain, dayInputs);

  // Mirrors the sibling archive routes: never freeze an unreadable window into
  // the CDN, and treat today + yesterday as still-moving (a cycle starting
  // 23:58 UTC writes yesterday's key a couple of minutes after midnight).
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
      ticker,
      chain,
      chain_id: chain === "base" ? 8453 : 4663,
      archive_start: archiveStart,
      requested,
      // Two separate questions, as everywhere else in this archive: `complete`
      // asks whether we could READ the days, `contiguous` whether what we read
      // has holes. A window can be perfectly readable and still be missing nine
      // hours, and those call for opposite reactions — retry, versus accept the
      // hole is permanent.
      complete: unreadable.length === 0,
      unreadable,
      contiguous: series.counts.gap_hours === 0,
      plottable: isPlottable(series),
      note: chartNote(series),
      counts: series.counts,
      dating: series.dating,
      deadband: series.deadband,
      segments: series.segments,
      legend: {
        segments:
          "walk these IN ORDER. A `run` is a maximal stretch of consecutive on-record hours and gets ONE polyline; a `gap` gets a labelled band. Never concatenate the runs and draw a single line — that is the bug this endpoint exists to make impossible",
        unreadable_gap:
          "KV could not be read. The archive's contents there are UNKNOWN — emphatically not 'nothing happened'",
        missing_day: "we were recording; that day holds no hour where anything priced",
        before_archive: `earlier than ${archiveStart}, when recording began on this chain — no backfill exists or ever will`,
        hour_absent:
          "the day is on record and this hour is not. WHY is unknown — cron did not run, nothing priced, or a KV error blocked the write. Measured against a real expected window, so hours before the archive began and hours still in the future are excluded",
        not_priced:
          "the hour IS on record and this ticker is absent from it. A row that failed to price is omitted rather than written with nulls, so this is 'we observed no price for this one'",
        before_first_seen:
          "the hour is on record, the ticker is absent, and it has NO record earlier in this window — it was not on the desk yet. Distinct from `not_priced`, which is a claim about the ticker; this is a claim about the desk. Derived from the series itself, not from an admission date (the archive holds none)",
        gap_hours:
          "hours in holes that sit BETWEEN two observations — a real break in the line. Leading and trailing absence are NOT counted here: a 14-day window over a 12-day archive is not two days of missing data, and a ticker admitted last week did not go dark before it existed. Same cut `archiveHoles` makes, for the same reason",
        lead_in_hours:
          "hours before the first observation. Not a hole — the window starts earlier than the record does",
        trailing_hours:
          "hours after the last observation. Also not a break, but read it: a chart whose newest point is two days old looks identical to a live one, and this is the only field that says otherwise",
        drift_pct:
          "copied from the archive, never recomputed from the two prices. The desk graded its arrows against THIS number; a recomputed one could disagree in the last decimal with no way to say which was right",
        deadband: `readings below ${DEADBAND_ABS_PCT}% |drift| are inside the Chainlink B20 deviation threshold — the feed had not stepped yet. That is quantisation, not the DEX disagreeing with the oracle, and the number alone cannot tell them apart. \`inside\`/\`graded\` is the share of this window that falls there`,
        dating:
          "THREE states, never two. `dated` = holds the Chainlink round the price was measured against. `undatable` = the feed was read and could not be dated. `predates_field` = never recorded, so nobody ever looked. Check `supported` FIRST: it is false on Robinhood, where no oracle round is recorded at all and the tally is 100% `predates_field` by construction rather than by observation",
        chain:
          "the chart is an assertion about ONE token. A ticker exists on both chains as different tokens with different pools, so this field is part of the answer, not decoration",
      },
    },
    { headers: { "Cache-Control": cache } },
  );
}
