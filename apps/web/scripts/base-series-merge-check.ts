/**
 * Verify the permanent Base archive — `mergeBaseSeriesPoint`, the pure fold that
 * writes it, and the read side that interprets what it wrote.
 *
 * Run: `cd apps/web && npx tsx scripts/base-series-merge-check.ts`
 *
 * There is no test runner in this repo, so this is a standalone script. It
 * imports the SHIPPING function rather than reimplementing the fold — a test of
 * a copy proves nothing about what runs in production.
 *
 * The invariants below are the ones whose failure is UNRECOVERABLE. `points` is
 * a permanent record: a merge bug that drops an hour cannot be fixed later by
 * redeploying, because the prices it would have held no longer exist anywhere.
 * That asymmetry is why this file exists at all.
 *
 * The read side is here rather than in its own file because it is the same
 * invariant seen from the other end. Group 12 proves the writer RECORDS the
 * oracle timestamp's three states; groups 14–16 prove nothing downstream
 * collapses them back into two. Split across two scripts, either half would
 * keep passing while the pair stopped meaning anything.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  mergeBaseSeriesPoint,
  BASE_SERIES_VERSION,
  archiveHoles,
  baseSeriesCoverage,
  oracleDating,
  datingCounts,
  oracleAgeAtAnchor,
  oracleAgeSpread,
  type BaseSeriesDayRead,
} from "@/lib/base-stocks/base-series";
import type { BaseSeriesDay, TickerSnapshot } from "@/lib/blue-hood/types";

let failures = 0;
/** Counted, not hardcoded. The old footer said "(11 groups)" — a number kept
 *  correct by hand, i.e. a number that goes stale the first time someone adds a
 *  group and forgets. Deriving it costs one line and cannot lie. */
let checks = 0;

function check(name: string, cond: boolean, detail = "") {
  checks++;
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Minimal Base row. Only the fields the merge actually reads are meaningful;
 *  the rest satisfy the type so we exercise the real signature, not a stub.
 *
 *  Deliberately NOT cast with `as TickerSnapshot`. The first draft was, and the
 *  cast hid a missing required field (`no_data_reason`) — a fixture that needs a
 *  cast to typecheck is no longer proof that the real function accepts it. */
function row(
  ticker: string,
  opts: {
    oracle?: number | null;
    dex?: number | null;
    drift?: number | null;
    open?: boolean;
    /** Chainlink round timestamp. Left OFF by default so every group above
     *  exercises the absent case — the archive must still record the field
     *  (as `null`) rather than dropping it. Group 12 covers both. */
    oracleAt?: number | null;
  } = {},
): TickerSnapshot {
  const { oracle = 100, dex = 100, drift = 0, open = false } = opts;
  return {
    ticker,
    chain: "base",
    name: `${ticker} Base`,
    contract: "0x0000000000000000000000000000000000000000",
    verdict: "ALIGNED",
    oracle_usd: oracle,
    dex_usd: dex,
    tvl_usd: 1_000_000,
    total_tvl_usd: 2_000_000,
    volume_24h_usd: 50_000,
    drift_pct: drift,
    pool_ref: "0xpool",
    is_v4_pool_id: false,
    // "premarket", not "closed" — there is no `"closed"` MarketSession, and the
    // one real Base observation we have (2026-08-28) was premarket.
    market: { is_open: open, session: open ? "regular" : "premarket", ny_time_iso: "2026-08-28T04:00:00-04:00" },
    warnings: [],
    polled_at_ms: 0,
    data_age_s: null,
    // Spread, not `oracle_updated_at: opts.oracleAt`. The distinction the
    // archive turns on is `undefined` (never recorded) vs `null` (recorded,
    // unreadable), and writing the key explicitly would make the default
    // `undefined` — same value, but as a PRESENT key. Structurally absent is
    // what a pre-v2 row actually looks like, so that is what the fixture
    // reproduces.
    ...("oracleAt" in opts ? { oracle_updated_at: opts.oracleAt } : {}),
    sparkline: null,
    no_data_reason: dex === null ? "no_pool" : null,
  };
}

const T0 = "2026-08-28T10:00:00.000Z"; // hour 2026082810
const T1 = "2026-08-28T10:05:00.000Z"; // same hour, next cycle
const T2 = "2026-08-28T11:00:00.000Z"; // new hour

// ── 1. Cold start: first cycle of a fresh day ───────────────────────────────
console.log("\n1. cold start (existing = null)");
const d1 = mergeBaseSeriesPoint(null, [row("NVDAc", { drift: 0.31 }), row("METAc", { drift: -0.12 })], T0);
check("returns a record", d1 !== null);
check("day is UTC yyyymmdd", d1?.day === "20260828", `got ${d1?.day}`);
check("chain is base", d1?.chain === "base", `got ${d1?.chain}`);
check("version stamped", d1?.v === BASE_SERIES_VERSION);
check("one hourly point", d1?.points.length === 1, `got ${d1?.points.length}`);
check("point has both rows", d1?.points[0].rows.length === 2);
check("peaks are absolute", d1?.peaks.find((p) => p.ticker === "METAc")?.abs_drift_pct === 0.12);
check("peaks keep signed drift", d1?.peaks.find((p) => p.ticker === "METAc")?.drift_pct === -0.12);
check("cycles = 1", d1?.cycles === 1);

// ── 2. Same hour, no new high-water mark → NO WRITE ─────────────────────────
// This is the cost story: on a quiet day this branch is ~283 of 288 cycles.
console.log("\n2. same hour, smaller drift → null (no write)");
const d2 = mergeBaseSeriesPoint(d1, [row("NVDAc", { drift: 0.10 }), row("METAc", { drift: -0.05 })], T1);
check("returns null", d2 === null, `got ${JSON.stringify(d2)?.slice(0, 80)}`);

// ── 3. Same hour, EQUAL drift → still no write ──────────────────────────────
// Strictly-greater matters: writing on ties turns a flat series into a write
// every single cycle, which is the whole budget.
console.log("\n3. same hour, equal drift → null (strictly-greater)");
check("returns null", mergeBaseSeriesPoint(d1, [row("NVDAc", { drift: 0.31 })], T1) === null);

// ── 4. Same hour, NEW peak → write peaks but NOT a second point ─────────────
// The failure this catches is an extra point per cycle, which would 12x the
// series size and corrupt any per-hour reading of it.
console.log("\n4. same hour, bigger drift → peak moves, no new point");
const d4 = mergeBaseSeriesPoint(d1, [row("NVDAc", { drift: 1.8 })], T1);
check("returns a record", d4 !== null);
check("still ONE point", d4?.points.length === 1, `got ${d4?.points.length}`);
check("peak updated", d4?.peaks.find((p) => p.ticker === "NVDAc")?.abs_drift_pct === 1.8);
check("other ticker's peak survives", d4?.peaks.find((p) => p.ticker === "METAc")?.abs_drift_pct === 0.12);
check("peak timestamped at the new cycle", d4?.peaks.find((p) => p.ticker === "NVDAc")?.at === T1);
check("cycles incremented", d4?.cycles === 2);

// ── 5. New hour → appends a point, preserves the old one ────────────────────
console.log("\n5. new hour → appends");
const d5 = mergeBaseSeriesPoint(d4, [row("NVDAc", { drift: 0.4, open: true })], T2);
check("two points", d5?.points.length === 2, `got ${d5?.points.length}`);
check("old point preserved", d5?.points[0].hour === "2026082810");
check("new point appended", d5?.points[1].hour === "2026082811");
check("market clock read off the row", d5?.points[1].is_open === true);
check("peak NOT lowered by a smaller cycle", d5?.peaks.find((p) => p.ticker === "NVDAc")?.abs_drift_pct === 1.8);

// ── 6. Late/retried cycle must not leave the day out of order ───────────────
// A year from now nobody will know a cycle was retried; the series must read
// chronologically regardless.
console.log("\n6. out-of-order arrival → points stay sorted");
const late = mergeBaseSeriesPoint(d5, [row("NVDAc", { drift: 0.2 })], "2026-08-28T09:00:00.000Z");
const hours = late?.points.map((p) => p.hour) ?? [];
check("sorted ascending", JSON.stringify(hours) === JSON.stringify([...hours].sort()), hours.join(","));
check("three points", hours.length === 3, hours.join(","));

// ── 7. Unpriced rows are ABSENT, never present-with-nulls ───────────────────
console.log("\n7. unpriced rows");
const mixed = mergeBaseSeriesPoint(
  null,
  [row("NVDAc", { drift: 0.5 }), row("DEADc", { oracle: null, dex: null, drift: null })],
  T0,
);
check("unpriced row excluded from point", mixed?.points[0].rows.length === 1, `got ${mixed?.points[0].rows.length}`);
check("unpriced row has no peak", !mixed?.peaks.some((p) => p.ticker === "DEADc"));
check(
  "all-unpriced cycle writes nothing",
  mergeBaseSeriesPoint(null, [row("DEADc", { oracle: null, dex: null, drift: null })], T0) === null,
);

// ── 8. A priced row with null drift still counts as an observation ──────────
// It contributes a price point but cannot contribute a peak — inventing 0 here
// would fabricate "we measured zero drift" from "we could not compute drift".
console.log("\n8. priced but drift uncomputable");
const nd = mergeBaseSeriesPoint(null, [row("NVDAc", { dex: null, drift: null })], T0);
check("point recorded", nd?.points[0].rows.length === 1);
check("no peak invented", nd?.peaks.length === 0, `got ${nd?.peaks.length}`);

// ── 9. The invariant that protects the RH archive ───────────────────────────
// The two record types are NOT distinguished by their field lists: `SeriesDay`
// requires only `{day, v, points}`, all of which `BaseSeriesDay` has, so it is
// assignable to `SeriesDay` on shape alone. The paired `chain` discriminators
// (`"base"` here, `chain?: "robinhood"` there) are the entire guard. Widen
// either to `string` and Base records silently become RH records.
//
// tsc already rejects the bad assignment at compile time, so what this runtime
// check adds is narrower and worth stating: that the literal is actually
// PRESENT on a produced record, not merely declared on the interface.
console.log("\n9. RH-corruption guard");
const asDay: BaseSeriesDay | null = d5;
check("chain literal present on every write", asDay?.chain === "base");

// ── 10. The guard tsc CANNOT enforce ───────────────────────────────────────
// `kvSet(key: string, value: unknown)` accepts any value at any key, so nothing
// in the type system stops a Base record being written to the RH archive key.
// What actually prevents it is that the RH key builder is never in scope in
// base-series.ts. That is a real invariant with no compiler behind it, so it is
// asserted here instead.
//
// Comments must be stripped first: base-series.ts *documents* this invariant
// and therefore names the RH builder in prose. A naive grep matches that prose
// and reports a false positive — which is exactly what happened when this check
// was first written by hand.
console.log("\n10. RH key builder is out of scope in base-series.ts");

// Resolved from cwd, not `import.meta.dirname` — tsx emits CJS, where that is
// `undefined` and `join` throws ERR_INVALID_ARG_TYPE. The header says to run
// this from apps/web; if you did not, fail saying so rather than silently
// skipping the assertion.
const target = join(process.cwd(), "src/lib/base-stocks/base-series.ts");
if (!existsSync(target)) {
  console.log(`  FAIL  cannot read ${target} — run this from apps/web`);
  process.exit(1);
}
const src = readFileSync(target, "utf8");
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

const hits = code.match(/\bkvSeriesDay\b/g) ?? [];
check("no reference to the RH key builder in code", hits.length === 0, `${hits.length} hit(s)`);
// Guard the guard: if the strip ever stops working, the check above passes
// vacuously. Confirm the Base builder IS still visible after stripping.
check("strip did not eat the file", /\bkvBaseSeriesDay\b/.test(code));

// ── 11. One price predicate, two call sites ────────────────────────────────
// `persistBaseSeriesPoint` returns early when no row is priced, so it does not
// spend a KV read on a cycle the merge would discard anyway. That early exit is
// only safe while it asks EXACTLY the question the merge asks. If the two ever
// drift apart, the cheap pre-check starts skipping cycles the merge would have
// recorded — silent data loss in an archive that cannot be backfilled, which is
// the one failure here with no repair path.
//
// Group 7 covers the merge side by calling it. The early return lives in the
// KV-touching function and cannot be called from here, so the property asserted
// instead is the one that actually prevents the bug: there is a SINGLE
// definition and both sites go through it. A future inline re-test of the same
// condition would compile, pass every runtime check, and reintroduce exactly
// the divergence — so it is failed here at the source level.
console.log("\n11. price predicate is defined once and shared");
const defs = code.match(/const\s+isPriced\s*=/g) ?? [];
check("exactly one isPriced definition", defs.length === 1, `${defs.length} found`);
// The raw condition must appear only inside that definition. More than one
// occurrence means someone re-tested the condition inline instead of calling it.
const raw = code.match(/oracle_usd\s*!==\s*null/g) ?? [];
check("condition is not duplicated inline", raw.length === 1, `${raw.length} occurrence(s)`);
check("merge filters through it", /\.filter\(isPriced\)/.test(code));
check("persist pre-checks through it", /\.some\(isPriced\)/.test(code));

// ── 12. The oracle timestamp reaches the permanent record ──────────────────
// A `drift_pct` with no oracle timestamp is three findings wearing one number:
// a real dislocation, a feed that has not crossed its 0.5% deviation deadband,
// or a feed frozen for a corporate action while the token keeps trading. The
// archive is permanent and forward-only, so a cycle written without the
// timestamp is a cycle whose drift can NEVER be classified — there is no later
// query that recovers which Chainlink round a past poll read.
//
// That makes dropping this field a silent, unrepairable loss, which is exactly
// the shape of failure the rest of this file exists to catch.
console.log("\n12. oracle timestamp is recorded on points AND peaks");
const ORACLE_AT = 1_787_904_439; // a real NVDAc round, 2026-08-28T08:07:19Z

const withTs = mergeBaseSeriesPoint(null, [row("NVDAc", { drift: 0.5, oracleAt: ORACLE_AT })], T0);
check("point row carries it", withTs?.points[0].rows[0].oracle_updated_at === ORACLE_AT);
check("peak carries it", withTs?.peaks[0].oracle_updated_at === ORACLE_AT);

// The peak must be dated by the cycle that SET it, not by whichever cycle wrote
// last — otherwise a drift gets attributed to an oracle it never priced against.
const later = mergeBaseSeriesPoint(
  withTs,
  [row("NVDAc", { drift: 0.2, oracleAt: ORACLE_AT + 3600 })],
  T1,
);
check("smaller cycle does not re-date the peak", later === null, `got ${JSON.stringify(later)?.slice(0, 60)}`);
const bigger = mergeBaseSeriesPoint(
  withTs,
  [row("NVDAc", { drift: 9.9, oracleAt: ORACLE_AT + 3600 })],
  T1,
);
check("a NEW peak takes its own cycle's timestamp",
  bigger?.peaks[0].oracle_updated_at === ORACLE_AT + 3600);

// Absent ⟹ null, never dropped. `undefined` means "this archive never recorded
// the field"; a Base row that reached the merge without a timestamp means "we
// looked and could not date the feed". Collapsing the second into the first is
// the unknown-vs-known-empty error, one level up.
const noTs = mergeBaseSeriesPoint(null, [row("NVDAc", { drift: 0.5 })], T0);
check("absent timestamp is recorded as null", noTs?.points[0].rows[0].oracle_updated_at === null);
check("...and the key is PRESENT, not dropped",
  "oracle_updated_at" in (noTs?.points[0].rows[0] ?? {}));
check("peak likewise", noTs?.peaks[0].oracle_updated_at === null);

// An explicit null from the poller (feed read threw) must survive as null too.
const nullTs = mergeBaseSeriesPoint(null, [row("NVDAc", { drift: 0.5, oracleAt: null })], T0);
check("explicit null survives", nullTs?.points[0].rows[0].oracle_updated_at === null);

// Adding the field without bumping the version would make a v1 record (field
// never existed) and a v2 record (field exists, was null) both read as
// `undefined` — the archive would lose the difference permanently.
check("version was bumped for the new field", BASE_SERIES_VERSION >= 2, `v=${BASE_SERIES_VERSION}`);

// Source-level: both copy sites must remain. Deleting either one still
// compiles, still passes every check above that touches the other, and quietly
// halves the record.
const copies = code.match(/oracle_updated_at:\s*t\.oracle_updated_at\s*\?\?\s*null/g) ?? [];
check("two copy sites (point row + peak)", copies.length === 2, `${copies.length} found`);

// ── 13. The read route stays on the Base side of the fence ─────────────────
// Group 10 asserts the writer never sees the RH key builder. The READ route is
// the second file where the same mistake is expressible and equally invisible
// to tsc: `kvSeriesDay(day)` and `kvBaseSeriesDay(day)` are both `string`, so
// serving RH history from the Base endpoint typechecks perfectly. Because
// NVDA/META/GOOGL/AAPL exist on BOTH chains, the result would not look wrong —
// it would look like Base data, which is the failure mode that matters.
//
// The route additionally must not touch the RH ARCHIVE START. Reusing it would
// mislabel days as `before_archive` against the wrong epoch — reporting the
// Base archive as not-yet-recording for the 18 days between the two starts.
console.log("\n13. /api/hood/base-series route is chain-isolated");

const routeFile = join(process.cwd(), "src/app/api/hood/base-series/route.ts");
if (!existsSync(routeFile)) {
  console.log(`  FAIL  cannot read ${routeFile} — run this from apps/web`);
  process.exit(1);
}
const routeSrc = readFileSync(routeFile, "utf8");
const routeCode = routeSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

const rhHits = routeCode.match(/\bkvSeriesDay\b/g) ?? [];
check("no RH key builder in the route", rhHits.length === 0, `${rhHits.length} hit(s)`);
// `\b` will not match inside BASE_SERIES_ARCHIVE_START — `_` is a word char, so
// there is no boundary before `SERIES`. The next check proves that empirically.
const rhStart = routeCode.match(/\bSERIES_ARCHIVE_START\b/g) ?? [];
check("no RH archive-start constant in the route", rhStart.length === 0, `${rhStart.length} hit(s)`);
check("...and the Base one IS used (proves the \\b above is not vacuous)",
  /\bBASE_SERIES_ARCHIVE_START\b/.test(routeCode));
// The route asks for DAYS, never for a KEY. Keeping every key builder out of it
// means "serve Base" and "write Base into RH history" are not one branch apart.
const anyBuilder = routeCode.match(/\bkvBaseSeriesDay\b/g) ?? [];
check("route builds no KV key at all", anyBuilder.length === 0, `${anyBuilder.length} hit(s)`);

// The threshold SWAPS WITH THE SESSION (2% closed / 1% open). Scoring a mixed
// set against DRIFT alone compiles, runs, and silently undercounts every
// open-market peak in the 1–2% band — biasing the archive's only question
// toward "no". Caught in review once; asserted here so it cannot come back.
check("peak scoring is session-aware", /abs_drift_pct >= thresholdFor\(/.test(routeCode));
const bareCmp = routeCode.match(/abs_drift_pct\s*>=\s*DRIFT_MIN_ABS_PCT/g) ?? [];
check("no bare single-threshold comparison", bareCmp.length === 0, `${bareCmp.length} hit(s)`);
check("both thresholds are imported", /\bARB_MIN_ABS_PCT\b/.test(routeCode));

// ── 13b. `archiveHoles` — one definition of "hole", not two ─────────────────
//
// The route published `contiguous`/`gaps` from an inline copy of a rule the
// archive watchdog also held. The copies were not equivalent, and the check
// that proves it is `13b.2`: the route's version indexed `hitDays[0]` and
// `hitDays[len-1]` on an UNSORTED array, so handed its days out of order it
// reported a holed archive as contiguous. It never was handed them out of
// order — `Promise.all` resolves in input order and `requested` is built
// ascending — which is exactly the problem. Nothing at the call site said so,
// nothing tested it, and three unrelated files each had a free hand to break it.
//
// A false `contiguous: true` is the worst failure this dataset has: #152 reads
// these fields as evidence, and "no gaps" plus "no drift" reads as "Base is
// quiet" when the truth is "we stopped looking".
console.log("\n13b. gaps are derived once, and the derivation is order-proof");

/** A real day record, built by the shipping writer — no casts. A fixture that
 *  needs a cast is no longer proof that the real function accepts it. */
const dayAt = (iso: string) => mergeBaseSeriesPoint(null, [row("NVDAc", { drift: 1 })], iso)!;
const hitOn = (iso: string): BaseSeriesDayRead => {
  const value = dayAt(iso);
  return { day: value.day, status: "hit", value };
};
const missOn = (d: string): BaseSeriesDayRead => ({ day: d, status: "miss" });
const preOn = (d: string): BaseSeriesDayRead => ({ day: d, status: "before_archive" });

const ascending = (a: string[]) => a.every((v, i) => i === 0 || a[i - 1] <= v);

/** 2026-09-01T05:30Z — 0829/0830/0831 are all finished days owed all 24 hours. */
const NOW_A = new Date("2026-09-01T05:30:00.000Z");
const H29 = hitOn("2026-08-29T09:00:00.000Z");
const H31 = hitOn("2026-08-31T09:00:00.000Z");
const M30 = missOn("20260830");

check("13b.0 fixture is a real hit carrying points", H29.day === "20260829" &&
  H29.status === "hit" && H29.value.points.length === 1);

const inOrder = archiveHoles([H29, M30, H31], NOW_A);
check("13b.1 an interior miss is a gap",
  JSON.stringify(inOrder.missing_days) === '["20260830"]',
  JSON.stringify(inOrder.missing_days));

// THE regression. Same three days, shuffled. The old inline copy computed
// `day > "20260831" && day < "20260829"` — a window nothing can satisfy — and
// returned no gaps at all.
const shuffled = archiveHoles([H31, M30, H29], NOW_A);
check("13b.2 the same gap is found when the days arrive out of order",
  JSON.stringify(shuffled.missing_days) === '["20260830"]',
  JSON.stringify(shuffled.missing_days));
check("13b.3 order does not change the verdict at all",
  JSON.stringify(shuffled) === JSON.stringify(inOrder));
check("13b.4 absent hours come back ascending regardless of read order",
  ascending(shuffled.absent_hours) && shuffled.absent_hours.length > 0);
check("13b.5 missing days come back ascending",
  ascending(archiveHoles([H31, missOn("20260830"), missOn("20260829"),
    hitOn("2026-08-28T09:00:00.000Z")], NOW_A).missing_days));

check("13b.6 a leading miss is NOT a gap",
  archiveHoles([missOn("20260828"), H29, H31], NOW_A).missing_days.length === 0);
check("13b.7 a trailing miss is NOT a gap",
  archiveHoles([H29, H31, missOn("20260901")], NOW_A).missing_days.length === 0);

// The shape that once scored a dead archive as healthy: every day a miss, so
// interior-only finds nothing and no hits means no hours to be absent. Correct
// here — and the reason `contiguous` alone can never evidence a live archive.
// `days_with_data` is what separates the two, which is why the watchdog reports
// `empty` as its own level rather than as a quiet `intact`.
const dead = archiveHoles([missOn("20260829"), missOn("20260830")], NOW_A);
check("13b.8 an all-miss window reports no holes (absence is not a gap)",
  dead.missing_days.length === 0 && dead.absent_hours.length === 0);

check("13b.9 a before_archive day is neither a gap nor a hole",
  JSON.stringify(archiveHoles([preOn("20260101"), H29, M30, H31], NOW_A).missing_days) ===
    '["20260830"]');

// Absent hours: the day in progress is owed only its FINISHED hours. Alarming
// on the current hour is how a real alarm gets tuned out.
const today = archiveHoles([hitOn("2026-09-01T02:00:00.000Z")], NOW_A);
check("13b.10 finished empty hours are absent",
  JSON.stringify(today.absent_hours) ===
    '["2026090100","2026090101","2026090103","2026090104"]',
  JSON.stringify(today.absent_hours));
check("13b.11 the hour in progress is never called absent",
  !today.absent_hours.includes("2026090105"));
check("13b.12 future hours are never called absent",
  !today.absent_hours.some((h) => h > "2026090105"));

// Source: the route must not have kept a second copy. The positive check is
// what stops the two negatives from passing vacuously after a rename.
check("13b.13 the route calls the shared derivation", /\barchiveHoles\(/.test(routeCode));
// …on the window it ACTUALLY read, and its own clock. Passing anything else —
// an empty array, a fresh `new Date()` unrelated to the read — compiles, builds,
// and publishes `contiguous: true` about a window it never looked at. Nothing
// downstream could tell. Pinned by name because there is no way to catch it by
// running the handler here (it needs KV).
check("13b.18 …on the reads it took, with the request's clock",
  /\barchiveHoles\(\s*reads\s*,\s*now\s*\)/.test(routeCode));
const inlineMiss = routeCode.match(/status\s*===\s*"miss"/g) ?? [];
check("13b.14 the route no longer re-derives the interior-miss filter",
  inlineMiss.length === 0, `${inlineMiss.length} hit(s)`);
check("13b.15 the route no longer holds its own hit-day bounds",
  !/hitDays/.test(routeCode));

// The response contract is unchanged by the refactor. A consolidation that
// quietly renames a published field is a breaking API change wearing a
// refactor's clothes.
// `contiguous` occurs TWICE in this route — as the published field and as a
// key in the payload legend. The first version of this check was a bare
// `/\bcontiguous:/`, which the legend satisfied on its own: renaming the actual
// field to `is_contiguous` left the check green. Mutation B4 caught it. A
// positive source check answered by documentation instead of code is the same
// failure as a negative one answered by a comment (see `stripComments` in
// archive-watch-check.ts) — it tests the prose.
//
// Both halves are now pinned, and the pairing is the point: the count catches a
// rename of EITHER copy, so the field and the sentence describing it cannot
// drift apart either.
const contiguousUses = routeCode.match(/\bcontiguous:/g) ?? [];
check("13b.16a `contiguous` appears exactly twice — the field and its legend",
  contiguousUses.length === 2, `${contiguousUses.length} hit(s)`);
check("13b.16b the published `contiguous` is derived from the shared holes",
  /\bcontiguous:\s*holes\./.test(routeCode));
check("13b.17 the response still publishes `gaps.days` and `gaps.hours`, both from holes",
  /gaps:\s*\{\s*days:\s*holes\.[^}]*\bhours:\s*holes\.[^}]*\}/.test(routeCode));

// The refactor's actual promise, tested rather than argued. For the ordering
// production supplies — ascending, because `Promise.all` preserves input order
// and `requested` is built ascending — the shared derivation returns EXACTLY
// what the deleted inline copy returned. Byte-identical response.
//
// The deleted copy is reproduced here once, on purpose. It is the only way to
// state "this changed nothing for real traffic" as a check instead of a claim
// in a commit message. Note it stays green under mutation A1 (unsorted bounds):
// that is correct and is the whole point — on ascending input the two agree,
// and they diverge only where the old one was WRONG, which is what 13b.2 tests.
// Non-regression and bug-detection are different questions and get different
// checks.
function legacyHoles(reads: BaseSeriesDayRead[], now: Date) {
  const coverage = new Map<string, string[]>();
  for (const r of reads) {
    if (r.status === "hit") {
      coverage.set(r.day, baseSeriesCoverage(r.day, r.value.points, now).hours_absent);
    }
  }
  const absentHours = [...coverage.values()].flat();
  const hitDays = reads.filter((r) => r.status === "hit").map((r) => r.day);
  const missedDays =
    hitDays.length > 0
      ? reads
          .filter(
            (r) => r.status === "miss" && r.day > hitDays[0] && r.day < hitDays[hitDays.length - 1],
          )
          .map((r) => r.day)
      : [];
  return { missing_days: missedDays, absent_hours: absentHours };
}

const realOrder: BaseSeriesDayRead[] = [
  hitOn("2026-08-28T09:00:00.000Z"),
  H29,
  M30,
  H31,
  missOn("20260901"),
];
check("13b.19 byte-identical to the deleted inline copy on ascending input",
  JSON.stringify(archiveHoles(realOrder, NOW_A)) ===
    JSON.stringify(legacyHoles(realOrder, NOW_A)),
  JSON.stringify(archiveHoles(realOrder, NOW_A)).slice(0, 90));
check("13b.20 …and that fixture is not trivially empty",
  archiveHoles(realOrder, NOW_A).missing_days.length === 1 &&
    archiveHoles(realOrder, NOW_A).absent_hours.length > 0);

// ── 14. `v` dates the WRITER, not the items ────────────────────────────────
// The defect this group exists for, reproduced through the shipping merge.
// `mergeBaseSeriesPoint` re-stamps the whole day with the current version on
// every write while carrying already-written points and peaks forward
// untouched — so a day stamped `v: 2` can hold items written before the field
// existed. That is not hypothetical: it is the shape of 20260828 on prod, where
// the record reads `v: 2` and ten of its fourteen items have no such key.
//
// Why it matters more than a stale comment: the previous doc told readers the
// bump was what made a missing field readable. Anyone who believed it would
// conclude every item on the crossover day was date-attempted-and-failed, when
// most of them were never looked at. Same number, opposite finding.
console.log("\n14. a v-current day can hold v-prior items");

/** Reproduce a v1 record. The current writer CANNOT produce one — it always
 *  writes the key, as group 12 asserts — so the only honest fixture is a
 *  current record with the key removed, which is exactly what v1 left behind. */
function asV1(d: BaseSeriesDay): BaseSeriesDay {
  const c = structuredClone(d);
  for (const p of c.points) for (const r of p.rows) delete r.oracle_updated_at;
  for (const pk of c.peaks) delete pk.oracle_updated_at;
  return c;
}

const v1day = asV1(
  mergeBaseSeriesPoint(null, [row("NVDAc", { drift: 1.2 }), row("METAc", { drift: 0.4 })], T0)!,
);
check("fixture is genuinely v1-shaped", datingCounts(v1day.peaks).predates_field === 2);

// Current writer touches the day: a new hour, and METAc exceeds its old mark
// while NVDAc does not.
const crossover = mergeBaseSeriesPoint(
  v1day,
  [row("NVDAc", { drift: 0.1, oracleAt: ORACLE_AT }), row("METAc", { drift: 5.0, oracleAt: ORACLE_AT })],
  T2,
)!;
const pk = datingCounts(crossover.peaks);
check("day is re-stamped to the CURRENT version", crossover.v === BASE_SERIES_VERSION);
check("un-exceeded peak keeps its v1 shape", pk.predates_field === 1, JSON.stringify(pk));
check("exceeded peak was rewritten and IS dated", pk.dated === 1, JSON.stringify(pk));
check(
  "NVDAc specifically was NOT re-dated",
  oracleDating(crossover.peaks.find((p) => p.ticker === "NVDAc")!) === "predates_field",
);
check(
  "METAc specifically WAS re-dated",
  oracleDating(crossover.peaks.find((p) => p.ticker === "METAc")!) === "dated",
);
// The claim itself, as one assertion: current `v`, mixed items. Any reader
// deriving vintage from `v` is wrong on this record.
check(
  "`v` is current while items are mixed — `v` CANNOT be read as vintage",
  crossover.v === BASE_SERIES_VERSION && pk.predates_field > 0 && pk.dated > 0,
);
const ptc = datingCounts(crossover.points.flatMap((p) => p.rows));
check("carried-forward hour keeps its undated rows", ptc.predates_field === 2, JSON.stringify(ptc));
check("the new hour's rows are dated", ptc.dated === 2, JSON.stringify(ptc));

// Durable, not transient. Strict-greater means an undated peak is repaired only
// by being EXCEEDED; a calm cycle leaves it as-is. This is why the crossover
// day's gap is permanent rather than something the next poll cleans up.
check(
  "a smaller cycle does not repair an undated peak",
  mergeBaseSeriesPoint(
    crossover,
    [row("NVDAc", { drift: 0.05, oracleAt: ORACLE_AT + 60 })],
    "2026-08-28T11:05:00.000Z",
  ) === null,
);

// ...and BOUNDED to that one day. `existing` is read from `kvBaseSeriesDay(day)`,
// so tomorrow's fold starts from null and carries nothing across midnight. This
// is the check that keeps the exposure at ONE day instead of the whole recording
// window — an over-estimate this task was briefly written around.
const tomorrow = mergeBaseSeriesPoint(
  null,
  [row("NVDAc", { drift: 0.1, oracleAt: ORACLE_AT })],
  "2026-08-29T09:00:00.000Z",
)!;
check("a fresh day carries nothing forward", datingCounts(tomorrow.peaks).predates_field === 0);
check("...and is fully dated", datingCounts(tomorrow.peaks).dated === 1);
check("the key really is per-day", /kvBaseSeriesDay\(\s*day\s*\)/.test(code));

// ── 15. The classifier keeps three states three ────────────────────────────
console.log("\n15. oracleDating / datingCounts");
check("absent key ⟹ predates_field", oracleDating({}) === "predates_field");
check("explicit null ⟹ undatable", oracleDating({ oracle_updated_at: null }) === "undatable");
check("number ⟹ dated", oracleDating({ oracle_updated_at: ORACLE_AT }) === "dated");
// The one that matters. These are different inputs carrying different claims —
// "we never looked" vs "we looked and found nothing" — and the entire reason
// the field is three-valued is that they must not answer the same.
check(
  "absent and null are DISTINGUISHED",
  oracleDating({}) !== oracleDating({ oracle_updated_at: null }),
);
// 0 is falsy, so a `||`-based classifier calls it undatable. Whether a round
// stamped 0 is trustworthy is a separate question (#160 clamps future-dated
// rounds); this function's job is to report what is stored, not to judge it.
check("0 is dated, not falsy-collapsed", oracleDating({ oracle_updated_at: 0 }) === "dated");

const tally = datingCounts([{}, {}, { oracle_updated_at: null }, { oracle_updated_at: ORACLE_AT }]);
check(
  "tallies each state",
  tally.predates_field === 2 && tally.undatable === 1 && tally.dated === 1,
  JSON.stringify(tally),
);
// A missing branch would silently drop items, and an undercount reads as a
// smaller archive rather than as a bug — so assert the sum, not just the parts.
check(
  "nothing is dropped",
  tally.dated + tally.undatable + tally.predates_field === 4,
  JSON.stringify(tally),
);
check(
  "empty input is all zeros, not empty",
  JSON.stringify(datingCounts([])) ===
    JSON.stringify({ dated: 0, undatable: 0, predates_field: 0 }),
);

// Source-level: the one-line "simplification" that reintroduces the bug is
// `?? null` INSIDE the classifier. It compiles, and it passes every behavioural
// check above that feeds only nulls and numbers — while silently relabelling
// every pre-field item as a dating failure.
const fnBody = /export function oracleDating\([\s\S]*?\n}/.exec(code)?.[0] ?? "";
check("classifier body located", fnBody.length > 0);
check("classifier tests undefined explicitly", /===\s*undefined/.test(fnBody));
check("classifier does not `?? null`", !/\?\?\s*null/.test(fnBody), fnBody.slice(0, 120));

// ── 16. The route ships vintage wherever a number travels ──────────────────
// Every figure a reader might quote needs its own dating alongside it. A peak
// set while the Chainlink feed was frozen and a peak set against a live feed are
// the same number and opposite findings; shipping the number without the state
// is how the first gets quoted as the second.
console.log("\n16. read route surfaces vintage next to every figure");
check("per-day peak vintage", /peak_dating:\s*datingCounts\(/.test(routeCode));
check("per-day point vintage", /point_dating:\s*datingCounts\(/.test(routeCode));
check("headline peak carries its own dating", /oracleDating\(maxPeak\)/.test(routeCode));
check("the crossers are tallied", /crossed_dating:\s*datingCounts\(/.test(routeCode));
check("all peaks are tallied", /peaks_dating:\s*datingCounts\(/.test(routeCode));
// Nothing may infer vintage from the version stamp — the mistake this whole
// group exists to prevent, expressed as a branch instead of as prose.
const vGate = routeCode.match(/\bv\s*(===|!==|<=|>=|<|>)\s*\d/g) ?? [];
check("route never branches on `v`", vGate.length === 0, vGate.join(" "));
const libGate = code.match(/\.v\s*(===|!==|<=|>=|<|>)\s*\d/g) ?? [];
check("lib never branches on `v`", libGate.length === 0, libGate.join(" "));

// The legend is the payload's own documentation, so assert its KEYS rather than
// its prose — rewording a sentence must not fail a build, but dropping the entry
// that tells a reader `v` is not vintage must.
const lStart = routeCode.indexOf("legend: {");
let legend = "";
if (lStart >= 0) {
  let depth = 0;
  for (let i = routeCode.indexOf("{", lStart); i < routeCode.length; i++) {
    if (routeCode[i] === "{") depth++;
    else if (routeCode[i] === "}" && --depth === 0) {
      legend = routeCode.slice(lStart, i + 1);
      break;
    }
  }
}
check("legend block located", legend.length > 0);
// Guard the guard: a slice that silently came back wrong would make every key
// check below pass or fail for the wrong reason.
check("...and it is really the legend", /peaks_observed:/.test(legend));

/** One legend entry's own text — from its key to the next key at the same
 *  indent. Scoped deliberately: the first draft of the `v` check below tested
 *  the slice from `v:` to the END of the legend, which the `peak_dating:` KEY
 *  further down satisfied all by itself. Mutation M13 (reword the `v` entry so
 *  it no longer redirects) survived that version — the check passed because it
 *  was reading a neighbour, not because the entry said anything. */
function legendEntry(name: string): string {
  const m = new RegExp(`\\n\\s{8}${name}:`).exec(legend);
  if (!m) return "";
  const rest = legend.slice(m.index + m[0].length);
  const next = /\n\s{8}[A-Za-z_][A-Za-z0-9_]*:/.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}
// Guard the guard, again: an extractor that returned "" for everything would
// make the redirect check below fail loudly, but one that returned the WHOLE
// legend for everything would make it pass vacuously. Pin both ends.
check("entry extractor finds a real entry", legendEntry("peaks_observed").includes("denominator"));
check("entry extractor is scoped, not the whole legend", !legendEntry("v").includes("peaks_observed"));
check("entry extractor returns empty for a missing key", legendEntry("no_such_key_xyz") === "");

for (const k of ["v", "oracle_dating", "peak_dating", "point_dating", "peaks_dating", "crossed_dating"]) {
  check(`legend documents \`${k}\``, legendEntry(k).length > 0);
}
// `v` is shipped in every day object, so its legend entry must not merely exist
// — it must point at the field that DOES answer vintage. Semantic, not wording:
// this survives a rewrite of the sentence, and fails its removal.
check("legend `v` redirects to the field that answers vintage",
  /peak_dating|point_dating/.test(legendEntry("v")));
// Likewise the three states must be named, not just alluded to. A two-state
// gloss here is how the distinction gets lost downstream by a reader who never
// opens the source.
const od = legendEntry("oracle_dating");
check("legend `oracle_dating` names all three states",
  ["dated", "undatable", "predates_field"].every((s) => od.includes(s)), od.slice(0, 80));

// ── 17. The oracle-age clamp, and what it must not throw away (#160) ───────
// A round here can be dated AFTER the cycle that recorded it — measured on prod,
// two samples, systematic. `at - oracle_updated_at` therefore goes negative, and
// any distribution built from it grows a left tail that is pure bookkeeping.
//
// The clamp is the easy half. The half worth guarding is that clamping must not
// erase the fact that it happened: `Math.max(0, …)` alone turns "234s in the
// FUTURE" into "0s old", which reads as a freshness claim and silently deletes
// the only signal that says whether the anchor artifact is growing.
console.log("\n17. oracleAgeAtAnchor / oracleAgeSpread");

const ANCHOR = "2026-08-28T15:55:27.454Z";
/** unix seconds for an instant on the measured day. */
const secs = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const readingAt = (roundIso: string, anchor = ANCHOR) =>
  oracleAgeAtAnchor({ oracle_updated_at: secs(roundIso) }, anchor);

const past = readingAt("2026-08-28T15:51:43.000Z");
check("a past round measures", past.state === "measured");
check(
  "...as a positive age, not future-dated",
  past.state === "measured" && past.age_s === 224 && !past.future_dated && past.ahead_s === 0,
  JSON.stringify(past),
);

const ahead = readingAt("2026-08-28T15:59:21.000Z");
check(
  "a FUTURE-dated round is clamped to 0",
  ahead.state === "measured" && ahead.age_s === 0,
  JSON.stringify(ahead),
);
check(
  "...and says so, with the distance it swallowed",
  ahead.state === "measured" && ahead.future_dated && ahead.ahead_s === 234,
  JSON.stringify(ahead),
);
// THE check of this group. `age_s` alone cannot separate "the round printed at
// the anchor instant" from "the round printed four minutes after it". A clamp
// that reports only the clamped number is the collapse, not the fix.
const exactlyZero = oracleAgeAtAnchor(
  { oracle_updated_at: secs(ANCHOR) },
  ANCHOR,
);
check(
  "a genuine 0 and a clamped 0 are DISTINGUISHED",
  exactlyZero.state === "measured" && ahead.state === "measured" &&
    exactlyZero.age_s === ahead.age_s && exactlyZero.future_dated !== ahead.future_dated,
);
check(
  "an exactly-anchored round is not called future-dated",
  exactlyZero.state === "measured" && !exactlyZero.future_dated && exactlyZero.ahead_s === 0,
  JSON.stringify(exactlyZero),
);

// Reproduce the field measurement. All four live-snapshot rows from the #160
// note, against that sample's own anchor — this pins the rounding convention to
// the one the observation was taken with, so the function and the note cannot
// quietly disagree about the same data.
const FIELD: Array<[string, string, number]> = [
  ["NVDA  future-dated by 128s", "2026-08-28T15:57:35.000Z", -128],
  ["GOOGL future-dated by 234s", "2026-08-28T15:59:21.000Z", -234],
  ["META  224s past",            "2026-08-28T15:51:43.000Z",  224],
  ["AAPL  1476s past",           "2026-08-28T15:30:51.000Z", 1476],
];
for (const [label, roundIso, expected] of FIELD) {
  const r = readingAt(roundIso);
  const signed = r.state === "measured" ? (r.future_dated ? -r.ahead_s : r.age_s) : NaN;
  check(`reproduces the 2026-08-28 sample — ${label}`, signed === expected, `got ${signed}`);
}
// The archive sample from the same note reads 215s; this function says 214. The
// true gap is 214.313s (15:00:44.687 → 15:04:19), so 215 comes from EITHER
// truncating the anchor's milliseconds to 15:00:44 OR rounding away from zero
// where we round to nearest — the note does not record which, and both land on
// 215, so this is not a distinction to guess at. What matters is that a 1s
// difference changes no finding, and that the convention is pinned: the four
// live-snapshot rows above agree exactly under round-to-nearest, so that is the
// convention the observation was taken with. Asserted so the 1s stays a recorded
// decision rather than a discrepancy someone rediscovers later and "fixes".
const archiveSample = oracleAgeAtAnchor(
  { oracle_updated_at: secs("2026-08-28T15:04:19.000Z") },
  "2026-08-28T15:00:44.687Z",
);
check(
  "archive sample: 214s ahead, milliseconds kept",
  archiveSample.state === "measured" && archiveSample.future_dated && archiveSample.ahead_s === 214,
  JSON.stringify(archiveSample),
);

// An absent age has three causes here too, and they are not interchangeable.
const undat = oracleAgeAtAnchor({ oracle_updated_at: null }, ANCHOR);
const predates = oracleAgeAtAnchor({}, ANCHOR);
check("a null round is not_dated", undat.state === "not_dated");
check("...carrying `undatable`", undat.state === "not_dated" && undat.dating === "undatable");
check("an absent round is not_dated", predates.state === "not_dated");
check(
  "...carrying `predates_field` — the two are still distinguished here",
  predates.state === "not_dated" && predates.dating === "predates_field" &&
    undat.state === "not_dated" && undat.dating !== predates.dating,
);
// Our bookkeeping failing is not the feed failing. Folding a corrupt archive
// record into `not_dated` would file our own bug under the oracle's name.
const noAnchor = oracleAgeAtAnchor({ oracle_updated_at: ORACLE_AT }, "not-a-date");
check("an unparseable anchor is its own state", noAnchor.state === "no_anchor");
check("...and echoes the offending value", noAnchor.state === "no_anchor" && noAnchor.anchor === "not-a-date");
check(
  "...and is NOT collapsed into not_dated",
  noAnchor.state !== undat.state,
);
// Order is a decision, so pin it: no round means no age whatever the anchor says.
check(
  "no round + bad anchor reports the missing round",
  oracleAgeAtAnchor({}, "not-a-date").state === "not_dated",
);
// 0 is a real unix instant, not "missing". A `||` anywhere in this path collapses it.
check(
  "a round stamped 0 is measured, not dropped",
  oracleAgeAtAnchor({ oracle_updated_at: 0 }, ANCHOR).state === "measured",
);

const spread = oracleAgeSpread([
  readingAt("2026-08-28T15:51:43.000Z"),   // 224 past
  readingAt("2026-08-28T15:30:51.000Z"),   // 1476 past
  readingAt("2026-08-28T15:57:35.000Z"),   // 128 ahead → 0
  readingAt("2026-08-28T15:59:21.000Z"),   // 234 ahead → 0
  undat,
  predates,
  noAnchor,
]);
check("spread counts the measured", spread.measured === 4, JSON.stringify(spread));
check("spread counts the clamped", spread.future_dated === 2, JSON.stringify(spread));
check("spread reports the WORST future-dating", spread.max_ahead_s === 234, JSON.stringify(spread));
check("spread counts both not_dated states together", spread.not_dated === 2);
check("spread counts the broken anchor separately", spread.no_anchor === 1);
// Future-dated rows stay in the distribution as zeros. Dropping them would bias
// it toward stale exactly as hard as leaving them negative biased it toward
// fresh — so they are counted twice, once in `ages_s` and once in `future_dated`.
check(
  "every measured reading reaches the distribution",
  spread.ages_s.length === spread.measured,
  JSON.stringify(spread.ages_s),
);
check(
  "the distribution is sorted ascending",
  JSON.stringify(spread.ages_s) === JSON.stringify([0, 0, 224, 1476]),
  JSON.stringify(spread.ages_s),
);
check("nothing is dropped", spread.measured + spread.not_dated + spread.no_anchor === 7);
// A spread with no clamping must report 0, not -Infinity from a bare Math.max
// over an empty set — which would poison any threshold a caller applies to it.
const clean = oracleAgeSpread([readingAt("2026-08-28T15:51:43.000Z")]);
check("max_ahead_s is 0 when nothing was clamped", clean.max_ahead_s === 0, JSON.stringify(clean));
check(
  "empty input is all zeros, not empty",
  JSON.stringify(oracleAgeSpread([])) ===
    JSON.stringify({ measured: 0, future_dated: 0, max_ahead_s: 0, not_dated: 0, no_anchor: 0, ages_s: [] }),
);

// Source-level: the anchor is an ISO STRING on purpose. `oracle_updated_at` is
// unix seconds and `at` is an ISO instant, so a numeric parameter invites a
// seconds/milliseconds mixup that scales every age by 1000 and still looks like
// a plausible histogram. The type is the defence; assert it stays.
check(
  "the anchor parameter is an ISO string, not a number",
  /export function oracleAgeAtAnchor\([\s\S]*?anchorIso:\s*string/.test(code),
);
// The clamp must reuse the classifier rather than re-deriving the three states.
// A second copy of that rule is a second place to get it wrong.
const ageBody = /export function oracleAgeAtAnchor\([\s\S]*?\n}/.exec(code)?.[0] ?? "";
check("clamp body located", ageBody.length > 0);
check("clamp delegates to oracleDating", /oracleDating\(/.test(ageBody));
check("clamp does not re-test undefined itself", !/===\s*undefined/.test(ageBody), ageBody.slice(0, 120));

console.log(
  failures === 0
    ? `\nALL ${checks} CHECKS PASSED\n`
    : `\n${failures} of ${checks} CHECK(S) FAILED\n`,
);
process.exit(failures === 0 ? 0 : 1);
