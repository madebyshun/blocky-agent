/**
 * series-persist-test — regression test for the permanent price archive.
 *
 *   npm run test:series
 *
 * `bh:series:day:*` is the ONE Blue Hood key with no TTL. Everything else in
 * the subsystem is recoverable: a lost snapshot is re-polled in five minutes,
 * a lost arrow re-fires. An overwritten hour of price history is gone for
 * good — there is no upstream to re-read it from, because the entire reason
 * this key exists is that the 25h ring buffer has already dropped it.
 *
 * Writing it is a read-modify-write on a per-day key, which is exactly the
 * shape that ate 24 of 25 paid top-ups in ledger-race-test. So the merge is a
 * pure function (`mergeSeriesPoint`) and the property that matters is
 * asserted directly: **a merge must never return fewer points than it was
 * given.** The cases below also pin the two ways a day could be silently
 * corrupted rather than shrunk — an hour rewritten by a retry, and an hour
 * where nothing priced recorded as though the market had no prices.
 *
 * Runs against the in-memory KV fallback ON PURPOSE (env vars cleared below,
 * same trick as ledger-race-test), so these synthetic prices can never reach
 * the real archive.
 */
delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

import { persistSeriesPoint, readSeriesDay, mergeSeriesPoint } from "../src/lib/blue-hood/poller";
import type { HoodSnapshot, SeriesDay } from "../src/lib/blue-hood/types";

// 2099 — unmistakably synthetic, cannot collide with a real poll cycle.
const DAY = "20991231";

const mk = (hourUtc: number, minute: number, priced: boolean): HoodSnapshot => ({
  cycle_id: hourUtc * 100 + minute,
  started_at: `2099-12-31T${String(hourUtc).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`,
  finished_at: `2099-12-31T${String(hourUtc).padStart(2, "0")}:${String(minute).padStart(2, "0")}:30.000Z`,
  duration_ms: 30_000,
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
});

let pass = 0;
let fail = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (cond) pass++;
  else fail++;
};

async function main() {
  // 1. first write creates the day
  await persistSeriesPoint(mk(13, 0, true));
  let d = await readSeriesDay(DAY);
  ok("first write creates the day", d?.points.length === 1, `points=${d?.points.length}`);
  ok(
    "row carries oracle + dex + depth",
    d?.points[0].rows[0].oracle_usd === 213 &&
      d?.points[0].rows[0].dex_usd === 214 &&
      d?.points[0].rows[0].total_tvl_usd === 50_000,
  );
  ok("point stamps the market clock", d?.points[0].is_open === true && d?.points[0].session === "regular");
  ok("schema version stamped", d?.v === 1, `v=${d?.v}`);

  // 2. same hour again (the poll runs every 5 min) must NOT duplicate
  await persistSeriesPoint(mk(13, 5, true));
  await persistSeriesPoint(mk(13, 55, true));
  d = await readSeriesDay(DAY);
  ok("same-hour re-poll is a no-op", d?.points.length === 1, `points=${d?.points.length}`);
  ok("the first reading of the hour is kept", d?.points[0].at.includes("13:00") === true, d?.points[0].at);

  // 3. a new hour appends rather than replacing
  await persistSeriesPoint(mk(14, 2, true));
  d = await readSeriesDay(DAY);
  ok("new hour appends", d?.points.length === 2, `points=${d?.points.length}`);
  ok("earlier hour survived the rewrite", d?.points.some((p) => p.hour === "2099123113") === true);

  // 4. out-of-order arrival still lands sorted
  await persistSeriesPoint(mk(9, 0, true));
  d = await readSeriesDay(DAY);
  const hours = d?.points.map((p) => p.hour) ?? [];
  ok(
    "points stay chronological",
    JSON.stringify(hours) === JSON.stringify([...hours].sort()),
    hours.join(","),
  );

  // 5. an hour where nothing priced is left ABSENT, not written as an empty point
  await persistSeriesPoint(mk(20, 0, false));
  d = await readSeriesDay(DAY);
  ok(
    "unpriced hour left absent",
    d?.points.length === 3 && !d.points.some((p) => p.hour === "2099123120"),
    `points=${d?.points.length}`,
  );

  // 6. …and a later cycle inside that same hour can still fill it
  await persistSeriesPoint(mk(20, 30, true));
  d = await readSeriesDay(DAY);
  ok("a later cycle can still fill that hour", d?.points.some((p) => p.hour === "2099123120") === true);
  ok("day total is 4 hours", d?.points.length === 4, `points=${d?.points.length}`);

  // 7. the whole day round-trips through JSON unchanged (it is stored as JSON
  //    and will be read back years from now by code that doesn't exist yet)
  const round = JSON.parse(JSON.stringify(d));
  ok("round-trips through JSON", JSON.stringify(round) === JSON.stringify(d));

  // ── The property that actually matters ────────────────────────────────────
  // A merge must never return FEWER points than it was given. This is the
  // clobber this whole design exists to prevent, so assert it directly on the
  // pure function across a full simulated day rather than trusting the
  // read-modify-write to have been written correctly.
  console.log("\n  merge never loses an hour:");
  let acc: SeriesDay | null = null;
  let shrank = "";
  for (let h = 0; h < 24; h++) {
    for (const m of [0, 5, 10, 15]) {
      const before = acc?.points.length ?? 0;
      const merged = mergeSeriesPoint(acc, mk(h, m, true));
      if (merged !== null) {
        if (merged.points.length < before) shrank = `h=${h} m=${m}: ${before} → ${merged.points.length}`;
        acc = merged;
      }
    }
  }
  ok("24h simulated day never shrinks", shrank === "", shrank);
  ok("24h simulated day ends with exactly 24 points", acc?.points.length === 24, `points=${acc?.points.length}`);

  // The literal outage scenario: KV read fails at 23:00. `kvGet` would hand
  // merge a `null` here and we would write a 1-point day over 23 real ones.
  // `persistSeriesPoint` never calls merge in that case — but if it ever did,
  // this is the damage, so keep the size of it visible.
  const asIfReadFailed = mergeSeriesPoint(null, mk(23, 30, true));
  ok(
    "merging onto null WOULD collapse the day (why the probe guard exists)",
    asIfReadFailed?.points.length === 1 && (acc?.points.length ?? 0) === 24,
    `${asIfReadFailed?.points.length} vs ${acc?.points.length}`,
  );

  // An already-recorded hour is refused even when the incoming data differs,
  // so a retry can never rewrite an hour that is already on the record.
  const dup = mergeSeriesPoint(acc, mk(12, 45, true));
  ok("recorded hour is never rewritten", dup === null);

  console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}  ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
