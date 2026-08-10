/**
 * series-endpoint-test — regression test for the archive's READ path.
 *
 *   npm run test:series-api
 *
 * `series-persist-test` proves the writer never loses an hour. This proves the
 * reader never lies about one. They are separate failure modes: a perfect
 * archive is worthless if the endpoint in front of it reports a KV outage as
 * "no data", because every consumer downstream then plots a flat market that
 * never happened.
 *
 * So the assertions below are mostly about the three kinds of nothing —
 * `before_archive` (we weren't recording), `miss` (recording, nothing priced)
 * and `error` (we could not read) — staying distinct in the payload, plus the
 * request-budget cap that stops one call from costing 365 KV reads.
 *
 * Runs against the in-memory KV fallback ON PURPOSE (env cleared below, same
 * trick as ledger-race-test and series-persist-test), so it can neither read
 * nor write a real archive.
 */
delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

import { NextRequest } from "next/server";
import { GET } from "../src/app/api/hood/series/route";
import {
  persistSeriesPoint,
  seriesCoverage,
  SERIES_ARCHIVE_START,
} from "../src/lib/blue-hood/poller";
import { yyyymmdd } from "../src/lib/blue-hood/kv-keys";
import type { HoodSnapshot, SeriesPoint } from "../src/lib/blue-hood/types";

const TODAY = yyyymmdd(new Date());

/** A snapshot on `TODAY` at the given UTC hour, so writes land in a day the
 *  route is allowed to read (anything before the archive start is answered
 *  without touching KV, which would defeat the point of the test). */
const mk = (hourUtc: number, priced = true): HoodSnapshot => {
  const iso = `${TODAY.slice(0, 4)}-${TODAY.slice(4, 6)}-${TODAY.slice(6, 8)}T${String(hourUtc).padStart(2, "0")}:00:00.000Z`;
  return {
    cycle_id: hourUtc,
    started_at: iso,
    finished_at: iso,
    duration_ms: 1_000,
    tickers: [
      {
        ticker: "AAPL",
        name: "Apple",
        contract: "0x0",
        verdict: priced ? "ALIGNED" : "ERROR",
        oracle_usd: priced ? 200 + hourUtc : null,
        dex_usd: priced ? 201 + hourUtc : null,
        tvl_usd: priced ? 1_000 : null,
        total_tvl_usd: priced ? 50_000 : null,
        volume_24h_usd: null,
        drift_pct: priced ? 0.5 : null,
        pool_ref: null,
        is_v4_pool_id: false,
        market: { is_open: true, session: "regular", ny_time_iso: "" },
        warnings: [],
        polled_at_ms: 0,
        data_age_s: null,
        sparkline: null,
        no_data_reason: priced ? null : "fetch_failed",
      },
    ],
    metrics: {
      registry_total: 1,
      tokens_watched: 1,
      tokens_no_feed: 0,
      tokens_errored: priced ? 0 : 1,
      tvl_scanned_usd: 0,
      market_is_open: true,
      market_session: "regular",
    },
  };
};

let pass = 0;
let fail = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (cond) pass++;
  else fail++;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
async function call(qs: string): Promise<{ status: number; cache: string; body: any }> {
  const res = await GET(new NextRequest(`http://t/api/hood/series${qs}`));
  return {
    status: res.status,
    cache: res.headers.get("cache-control") ?? "",
    body: await res.json(),
  };
}

const dayOffset = (n: number) => yyyymmdd(new Date(Date.now() + n * 86_400_000));

async function main() {
  // ── the happy path: what was written is what comes back ──────────────────
  await persistSeriesPoint(mk(13));
  await persistSeriesPoint(mk(14));
  await persistSeriesPoint(mk(20, false)); // nothing priced → hour stays absent

  let r = await call(`?day=${TODAY}`);
  ok("200 on a day that exists", r.status === 200, `status=${r.status}`);
  ok("day reports hit", r.body.days[0].status === "hit", r.body.days[0].status);
  ok("both written hours come back", r.body.days[0].points.length === 2, `points=${r.body.days[0].points.length}`);
  ok("unpriced hour is not invented", !r.body.days[0].points.some((p: any) => p.hour.endsWith("20")));
  ok("totals count rows, not just points", r.body.totals.rows === 2, `rows=${r.body.totals.rows}`);
  ok("schema version travels with the day", r.body.days[0].v === 1, `v=${r.body.days[0].v}`);
  ok("prices survive the round trip", r.body.days[0].points[0].rows[0].oracle_usd === 213);
  ok("complete when nothing failed to read", r.body.complete === true && r.body.unreadable.length === 0);

  // ── the three kinds of nothing stay distinct ─────────────────────────────
  r = await call(`?day=${dayOffset(3)}`);
  ok("a recorded-era day with no data is a MISS", r.body.days[0].status === "miss", r.body.days[0].status);

  r = await call(`?day=20260101`);
  ok(
    "a day before recording began is BEFORE_ARCHIVE, not miss",
    r.body.days[0].status === "before_archive",
    r.body.days[0].status,
  );
  ok("archive start is published so a consumer can tell", r.body.archive_start === SERIES_ARCHIVE_START);
  ok(
    "legend spells out that error != empty",
    typeof r.body.legend?.error === "string" && r.body.legend.error.includes("UNKNOWN"),
  );

  // ── request budget: one KV read per day, so the window is capped ─────────
  r = await call(`?days=400`);
  ok("a 400-day window is refused", r.status === 400, `status=${r.status}`);
  ok("refusal explains the cost, not just the rule", String(r.body.error).includes("KV read"));

  r = await call(`?days=31`);
  ok("31 days is allowed (the documented cap)", r.status === 200, `status=${r.status}`);

  // ── input that must not be guessed at ────────────────────────────────────
  for (const bad of ["?day=20260231", "?day=nonsense", "?day=2026081", "?days=0", "?days=1.5"]) {
    r = await call(bad);
    ok(`rejects ${bad}`, r.status === 400, `status=${r.status}`);
  }

  r = await call(`?from=20260901&to=20260801`);
  ok("rejects a backwards range", r.status === 400, `status=${r.status}`);

  // ── caching follows mutability, not convenience ─────────────────────────
  r = await call(`?day=${TODAY}`);
  ok("today is cached briefly (it still grows)", r.cache.includes("s-maxage=300"), r.cache);

  r = await call(`?day=${dayOffset(-5)}`);
  ok("a finished day is cached for a day", r.cache.includes("s-maxage=86400"), r.cache);

  r = await call(`?day=20260231`);
  ok("a rejected request is never cached", r.cache.includes("no-store"), r.cache);

  // ── the range walker ─────────────────────────────────────────────────────
  r = await call(`?from=${dayOffset(-2)}&to=${TODAY}`);
  ok("range enumerates every day inclusive", r.body.requested.length === 3, r.body.requested.join(","));
  ok("range ends on the day asked for", r.body.requested[2] === TODAY, r.body.requested[2]);
  ok("data inside a range is still returned", r.body.totals.points === 2, `points=${r.body.totals.points}`);

  // ── coverage: which hours we expected and did not get ────────────────────
  // Driven through the pure `seriesCoverage` with an injected clock rather
  // than through the route, so these assertions mean the same thing at 03:00
  // UTC as at 23:00. Testing the window against the real wall clock would make
  // the suite pass or fail depending on the hour it happened to run.
  const pt = (hour: string): SeriesPoint => ({
    hour,
    at: "",
    is_open: true,
    session: "regular",
    rows: [],
  });
  /** A day AFTER the archive start, so all 24 hours are legitimately owed. */
  const LATER = "20260812";
  const hoursOf = (day: string, hs: number[]) =>
    hs.map((h) => pt(`${day}${String(h).padStart(2, "0")}`));

  // A finished day, hours 07 and 08 lost.
  const full = [...Array(24).keys()].filter((h) => h !== 7 && h !== 8);
  let c = seriesCoverage(LATER, hoursOf(LATER, full), new Date("2026-08-13T05:00:00Z"));
  ok("a hole inside a finished day is named", c.hours_absent.join(",") === "2026081207,2026081208", c.hours_absent.join(","));
  ok("hours_present counts what is there", c.hours_present === 22, `${c.hours_present}`);
  ok("a finished day is judged against all 24 hours", c.expected_from === "2026081200" && c.expected_to === "2026081223", `${c.expected_from}..${c.expected_to}`);

  // Today, mid-morning: hour 08 is over and missing, hour 09 is still running.
  c = seriesCoverage(LATER, hoursOf(LATER, [0, 1, 2, 3, 4, 5, 6, 7]), new Date("2026-08-12T09:30:00Z"));
  ok("a finished hour that is missing IS a gap", c.hours_absent.join(",") === "2026081208", c.hours_absent.join(","));
  ok("the window stops at the last finished hour", c.expected_to === "2026081208", String(c.expected_to));

  // The writer appends at ~:05. If the running hour counted as overdue, every
  // response would carry a phantom gap for five minutes out of every sixty.
  c = seriesCoverage(LATER, hoursOf(LATER, [0, 1, 2, 3, 4, 5, 6, 7, 8]), new Date("2026-08-12T09:02:00Z"));
  ok("the hour running right now is never called overdue", c.hours_absent.length === 0, c.hours_absent.join(","));

  // Just past midnight nothing is due yet — and "no window" must not read as
  // "24 hours lost".
  c = seriesCoverage(LATER, [], new Date("2026-08-12T00:20:00Z"));
  ok("nothing is overdue just past midnight", c.hours_absent.length === 0 && c.expected_from === null);

  // On the archive's first day recording began mid-day. Hours before the first
  // point were never promised; listing them would brand the archive with a
  // permanent gap that no deploy could ever have filled.
  c = seriesCoverage(SERIES_ARCHIVE_START, hoursOf(SERIES_ARCHIVE_START, [3, 4, 5]), new Date("2026-08-11T00:30:00Z"));
  ok("hours before recording began are not gaps", !c.hours_absent.some((h) => h < `${SERIES_ARCHIVE_START}03`), c.hours_absent.slice(0, 3).join(","));
  ok("but hours after it are", c.hours_absent[0] === `${SERIES_ARCHIVE_START}06`, c.hours_absent[0]);
  ok("the window says where it started measuring", c.expected_from === `${SERIES_ARCHIVE_START}03`, String(c.expected_from));

  // Order is the writer's job; the reader must not depend on it having happened.
  c = seriesCoverage(LATER, hoursOf(LATER, [5, 3, 4]), new Date("2026-08-13T05:00:00Z"));
  ok("first/last survive unsorted points", c.first_hour === "2026081203" && c.last_hour === "2026081205");

  // ── coverage as the route serves it ──────────────────────────────────────
  r = await call(`?day=${TODAY}`);
  ok("a hit carries coverage", typeof r.body.days[0].coverage === "object" && r.body.days[0].coverage !== null);
  ok("coverage agrees with the points it shipped", r.body.days[0].coverage.hours_present === 2, `${r.body.days[0].coverage.hours_present}`);
  ok("first/last hour bracket the data", r.body.days[0].coverage.first_hour === `${TODAY}13` && r.body.days[0].coverage.last_hour === `${TODAY}14`);
  ok("`contiguous` is stated, not left to inference", typeof r.body.contiguous === "boolean");
  ok(
    "top-level gaps.hours is exactly the union of the days'",
    r.body.gaps.hours.join(",") === r.body.days[0].coverage.hours_absent.join(","),
  );
  ok("`complete` and `contiguous` are separate fields", "complete" in r.body && "contiguous" in r.body);
  ok("legend explains that a gap's CAUSE is unknown", String(r.body.legend?.coverage).includes("UNKNOWN"));

  r = await call(`?day=20260101`);
  ok("a before_archive day claims no coverage", !("coverage" in r.body.days[0]));

  // A `miss` after the last day holding data is the recorder not having run
  // yet, not a hole. Counting it would put an alarm on every wide window.
  r = await call(`?from=${TODAY}&to=${dayOffset(2)}`);
  ok("trailing empty days are not called gaps", r.body.gaps.days.length === 0, r.body.gaps.days.join(","));

  console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}  ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
