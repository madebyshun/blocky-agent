/**
 * Verify `mergeBaseSeriesPoint` — the pure core of the permanent Base archive.
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
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mergeBaseSeriesPoint, BASE_SERIES_VERSION } from "@/lib/base-stocks/base-series";
import type { BaseSeriesDay, TickerSnapshot } from "@/lib/blue-hood/types";

let failures = 0;

function check(name: string, cond: boolean, detail = "") {
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
  opts: { oracle?: number | null; dex?: number | null; drift?: number | null; open?: boolean } = {},
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

// ── 12. The read route stays on the Base side of the fence ─────────────────
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
console.log("\n12. /api/hood/base-series route is chain-isolated");

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

console.log(
  failures === 0
    ? `\nALL CHECKS PASSED (12 groups)\n`
    : `\n${failures} CHECK(S) FAILED\n`,
);
process.exit(failures === 0 ? 0 : 1);
