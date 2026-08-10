/**
 * Public read of the permanent oracle-vs-DEX price archive.
 *
 *   GET /api/hood/series                       → today (UTC)
 *   GET /api/hood/series?day=20260810          → one day
 *   GET /api/hood/series?days=7                → last 7 days ending today
 *   GET /api/hood/series?from=20260810&to=20260817
 *
 * WHY THIS EXISTS: `bh:series:day:*` is the one Blue Hood key with no TTL, and
 * until this route there was no way to look at it. Verifying that the writer
 * even worked meant grepping serverless logs or pulling production secrets —
 * so the dataset the whole feature exists to protect was the one dataset
 * nobody could see. An append-only archive with no read path is indistinguish-
 * able from an archive that is silently empty.
 *
 * THE ONE RULE THIS ROUTE ENFORCES: three different kinds of "no data" stay
 * distinguishable all the way to the consumer.
 *
 *   before_archive → we were not recording yet. Never will be; there is no
 *                    upstream to backfill from.
 *   miss           → we were recording and that day holds nothing.
 *   error          → KV could not be read. We do NOT know what that day holds.
 *
 * Collapsing `error` into an empty array is how a monitoring blackout gets
 * rendered as a flat market. `persistSeriesPoint` refuses to write on a failed
 * read for the same reason; this is the mirror of that guard on the read side.
 * A response containing any `error` day is also sent `no-store`, so a transient
 * KV blip can never be frozen into the CDN as that day's answer.
 *
 * COST: one KV request per requested day, which is why the window is capped —
 * the Upstash request cap has starved this engine once already (task #123).
 * Days before the archive start cost nothing: the answer is known without
 * asking. Completed days are immutable and cached for a day; today and
 * yesterday still move (a cycle starting 23:58 UTC writes to yesterday's key
 * a couple of minutes after midnight) so they get 5 minutes.
 */
import { NextRequest, NextResponse } from "next/server";
import { readSeriesDays, SERIES_ARCHIVE_START } from "@/lib/blue-hood/poller";
import { yyyymmdd } from "@/lib/blue-hood/kv-keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Hard ceiling on days per request — one KV read each. A year of history is
 *  12 calls, which is fine; a year in one call is a scraper amplifying our
 *  request bill by 365× per hit. */
const MAX_DAYS = 31;

/** `YYYYMMDD` → UTC ms, or null if it is not a real calendar day. Rejects
 *  20260231 as well as garbage: parsing must not invent a date. */
function parseDay(s: string): number | null {
  if (!/^\d{8}$/.test(s)) return null;
  const ms = Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
  if (Number.isNaN(ms)) return null;
  return yyyymmdd(new Date(ms)) === s ? ms : null;
}

const DAY_MS = 86_400_000;

function bad(error: string) {
  return NextResponse.json(
    { ok: false, error, archive_start: SERIES_ARCHIVE_START, max_days: MAX_DAYS },
    { status: 400, headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}

export async function GET(req: NextRequest) {
  const q = new URL(req.url).searchParams;
  const todayMs = Date.UTC(
    new Date().getUTCFullYear(),
    new Date().getUTCMonth(),
    new Date().getUTCDate(),
  );

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

  const reads = await readSeriesDays(requested);

  const unreadable = reads.filter((r) => r.status === "error").map((r) => r.day);
  // Every requested day errored → we know nothing about this window. Say so
  // with a 503 rather than serving an empty archive that looks authoritative.
  if (unreadable.length === requested.length && requested.length > 0) {
    return NextResponse.json(
      {
        ok: false,
        reason: "kv_error",
        error:
          "KV unreachable — the archive could not be read. This is NOT the same as the archive being empty; its contents for this window are UNKNOWN.",
        requested,
      },
      { status: 503, headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  }

  const days = reads.map((r) =>
    r.status === "hit"
      ? { day: r.day, status: r.status, v: r.value.v, points: r.value.points }
      : r.status === "error"
        ? { day: r.day, status: r.status, message: r.message }
        : { day: r.day, status: r.status },
  );

  const hits = reads.filter((r) => r.status === "hit");
  const points = hits.reduce((n, r) => n + (r.status === "hit" ? r.value.points.length : 0), 0);
  const rows = hits.reduce(
    (n, r) =>
      n + (r.status === "hit" ? r.value.points.reduce((m, p) => m + p.rows.length, 0) : 0),
    0,
  );

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
      archive_start: SERIES_ARCHIVE_START,
      // False the moment any day in the window could not be read. A consumer
      // that flattens `days[].points` into one array MUST check this first,
      // or it will plot a hole it cannot see.
      complete: unreadable.length === 0,
      unreadable,
      requested,
      totals: { days_requested: requested.length, days_with_data: hits.length, points, rows },
      days,
      legend: {
        hit: "day present in the archive",
        miss: "we were recording; this day holds no hour where anything priced",
        error: "KV could not be read — contents UNKNOWN, not empty",
        before_archive: `earlier than ${SERIES_ARCHIVE_START}, when recording began — no backfill exists or ever will`,
      },
    },
    { headers: { "Cache-Control": cache } },
  );
}
