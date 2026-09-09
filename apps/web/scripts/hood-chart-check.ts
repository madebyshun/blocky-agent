/**
 * Blue Hood — regression guard for the per-ticker price chart (#229).
 *
 * WHY THIS EXISTS
 * ---------------
 * `seriesCoverage` wrote the warning in prose, months before any chart existed:
 * "A consumer that plots `points` without asking will connect 03:00 straight to
 * 09:00 and draw a confident line through six hours." A chart is that consumer.
 * The warning was a comment, and a comment binds nobody — so this file turns it
 * into a check.
 *
 * The failure is quiet by construction. A bridged line is not a crash, a blank
 * page, or a wrong-looking number; it is a smooth, plausible, confident chart
 * that renders hours nobody observed. Nothing downstream can detect it, and the
 * reader has no way to know. That is why it needs a guard rather than review.
 *
 * WHAT ROTS, AND WHY EACH GROUP EXISTS
 * ------------------------------------
 *  1. Segment integrity — the bridge itself. Runs must be internally hourly and
 *     gaps must never be swallowed. Asserted against a fixture built to contain
 *     every kind of nothing at once.
 *  2. The five kinds of nothing stay five. Collapsing `unreadable` into
 *     `hour_absent` says a KV outage and a quiet market are the same event —
 *     the read-path twin of the bug `readSeriesDays` refuses on the fetch path.
 *  3. Leading absence is not a hole. Derived from a real property of the desk:
 *     tickers admitted later than the archive start exist RIGHT NOW, so the
 *     "not on the desk yet" path is live code, not a hypothetical.
 *  4. Vintage is read PER ITEM (#159). `v` dates the WRITER; a day stamped 2 can
 *     hold items written before the field existed. And `undefined` ≠ `null` —
 *     "never looked" is not "looked and found nothing".
 *  5. The deadband is a MEASUREMENT floor, and must not be fused to the FIRING
 *     thresholds. Sharing one constant would make a tuning of either silently
 *     drag the other.
 *  6. The chain differential. A chart is an assertion about ONE token, and
 *     NVDA/META/GOOGL/AAPL/TSLA are different tokens on the two chains. Same
 *     property `hood-detail-chain-check` pins for the detail panel.
 *  7. Liveness. Groups 1-6 test a module; the actual drawing happens in a
 *     `"use client"` tree no script can import, so that is checked at the source
 *     level — and a source-level check that stops finding its file passes
 *     vacuously forever. #370's lesson: an absence check without a liveness
 *     guard is decoration. Every scan below first asserts its target EXISTS.
 *
 * FIXTURES ARE DERIVED, NEVER TYPED
 * ---------------------------------
 * `hood-chain-token-check` rotted because it contained the literal "TSLA": the
 * ticker was RH-only when written, TSLA was later admitted to Base (#436), and
 * the check silently became a test of nothing. So every ticker here is read out
 * of the registries at runtime, and where a property needs a ticker with a
 * particular relationship to the desks, the guard FAILS LOUDLY if no such
 * ticker exists rather than skipping — a property that can no longer be
 * expressed must be re-stated by a human, not quietly dropped.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  buildChartSeries,
  chartDomain,
  chartNote,
  hourToMs,
  isPlottable,
  oracleDatingSupported,
  DEADBAND_ABS_PCT,
  type ChartDayInput,
  type ChartGapReason,
} from "../src/lib/blue-hood/chart-series";
import { DRIFT_MIN_ABS_PCT, ARB_MIN_ABS_PCT, type SeriesPoint } from "../src/lib/blue-hood/types";
import { BASE_STOCKS } from "../src/lib/base-stocks/registry";
import { RWA_TOKENS } from "../src/lib/robinhood/rwa-registry";

let failures = 0;
let passes = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    passes++;
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ""}`);
  }
}

const SRC = join(__dirname, "..", "src");

// ── Derived fixtures ────────────────────────────────────────────────────────

const BASE_TICKERS = BASE_STOCKS.map((s) => s.ticker).sort();
const RH_TICKERS = RWA_TOKENS.filter((t) => t.kind === "stock")
  .map((t) => t.ticker)
  .sort();
const BASE_SET = new Set(BASE_TICKERS);

/** A ticker real on BOTH desks — the case where a bare ticker is ambiguous and
 *  a chart caption is load-bearing. Null-guarded below rather than assumed. */
const DUAL_TICKER = RH_TICKERS.find((t) => BASE_SET.has(t)) ?? null;
/** A ticker real on RH and absent from Base. Same derivation as #436's guard. */
const RH_ONLY_TICKER = RH_TICKERS.find((t) => !BASE_SET.has(t)) ?? null;

/** Build a `SeriesPoint` for one hour holding one row for each named ticker.
 *  `dated` controls the THIRD state of `oracle_updated_at`: `"omit"` leaves the
 *  key absent (never recorded), which is not the same as null. */
function pt(
  hour: string,
  tickers: string[],
  opts: { drift?: number; dated?: number | null | "omit" } = {},
): SeriesPoint {
  const { drift = 0.2, dated = 1_756_000_000 } = opts;
  return {
    hour,
    at: `${hour.slice(0, 4)}-${hour.slice(4, 6)}-${hour.slice(6, 8)}T${hour.slice(8, 10)}:00:00Z`,
    is_open: false,
    // A real closed session, not the word "closed" — `MarketSession` has no such
    // member, and a fixture that invents one would be asserting a shape the
    // archive cannot hold. Caught by `tsc`, which `tsx` had happily skipped.
    session: "weekend",
    rows: tickers.map((ticker) => ({
      ticker,
      oracle_usd: 100,
      dex_usd: 100 * (1 + drift / 100),
      drift_pct: drift,
      total_tvl_usd: 1_000_000,
      ...(dated === "omit" ? {} : { oracle_updated_at: dated }),
    })),
  };
}

console.log("\n── 1. Segment integrity — the line is never drawn through a hole ──\n");

if (DUAL_TICKER === null) {
  check(
    "a ticker exists on BOTH desks — the ambiguity this chart must caption is still expressible",
    false,
    "No ticker is registered on both Base and RH. The chain-caption property below cannot be tested and must be RE-STATED by a human, not deleted.",
  );
}
const T = DUAL_TICKER ?? BASE_TICKERS[0];

// One window holding EVERY kind of nothing at once, plus a mid-day hole.
const mixed: ChartDayInput[] = [
  { day: "20260901", status: "before_archive" },
  { day: "20260902", status: "error", message: "kv unreachable" },
  { day: "20260903", status: "miss" },
  {
    day: "20260904",
    status: "hit",
    hours_absent: ["2026090402", "2026090403"],
    points: [pt("2026090401", [T]), pt("2026090404", [T]), pt("2026090405", [T])],
  },
  {
    // The ticker is absent from an hour the desk DID record — `not_priced`,
    // and because it sits after a run it is interior, not a lead-in.
    day: "20260905",
    status: "hit",
    hours_absent: [],
    points: [pt("2026090501", ["__OTHER__"]), pt("2026090502", [T])],
  },
];

const s = buildChartSeries(T, "base", mixed);

const runs = s.segments.flatMap((x) => (x.kind === "run" ? [x] : []));
let bridged: string[] = [];
for (const r of runs) {
  for (let i = 1; i < r.points.length; i++) {
    const a = r.points[i - 1].hour;
    const b = r.points[i].hour;
    if (hourToMs(b) - hourToMs(a) !== 3_600_000) bridged.push(`${a}→${b}`);
  }
}
check(
  `no run bridges non-adjacent hours (${runs.length} runs, ${s.counts.plotted} points)`,
  bridged.length === 0,
  bridged.length ? `bridged: ${bridged.join(", ")}` : undefined,
);
check(
  "the mid-day hole splits the day into separate runs rather than one line",
  runs.length >= 2,
  `got ${runs.length} run(s) — a 2-hour hole inside 20260904 must break the line`,
);
check(
  "`points` is flat-but-ordered and is NEVER the same object as a run's points",
  s.points.length === runs.reduce((n, r) => n + r.points.length, 0) &&
    runs.every((r) => r.points !== s.points),
);
check(
  "every gap segment carries a positive hour count (a hole of unknown size is still a hole)",
  s.segments.every((x) => x.kind !== "gap" || x.hours > 0),
);

console.log("\n── 2. Five kinds of nothing stay five ──\n");

const REASONS: ChartGapReason[] = [
  "unreadable",
  "missing_day",
  "before_archive",
  "hour_absent",
  "not_priced",
  "before_first_seen",
];
const seen = new Set(s.segments.flatMap((x) => (x.kind === "gap" ? [x.reason] : [])));
for (const r of ["unreadable", "missing_day", "before_archive", "hour_absent", "not_priced"] as const) {
  check(`\`${r}\` is produced and kept distinct`, seen.has(r), `reasons seen: ${[...seen].join(", ")}`);
}
check(
  "the reason set is exhaustive — every reason the type allows is reachable or explicitly derived",
  REASONS.every((r) => r in s.counts.gaps),
  `counts.gaps keys: ${Object.keys(s.counts.gaps).join(", ")}`,
);
check(
  "a KV outage is NOT reported as an absent hour (the two must not share a reason)",
  s.counts.gaps.unreadable > 0 && s.counts.gaps.hour_absent > 0,
);
check(
  "`chartNote` never emits an empty reason list",
  !(chartNote(s) ?? "").includes("()"),
  `note: ${chartNote(s)}`,
);

console.log("\n── 3. Leading absence is not a hole ──\n");

// DERIVED, not assumed: a ticker admitted after the archive began has no record
// in the early window. Modelled by a window where `T` only appears late.
const lateAdmit: ChartDayInput[] = [
  { day: "20260901", status: "hit", hours_absent: [], points: [pt("2026090101", ["__OTHER__"])] },
  { day: "20260902", status: "hit", hours_absent: [], points: [pt("2026090201", ["__OTHER__"])] },
  {
    day: "20260903",
    status: "hit",
    hours_absent: [],
    points: [pt("2026090301", [T]), pt("2026090302", [T])],
  },
];
const late = buildChartSeries(T, "base", lateAdmit);
check(
  "a ticker absent before its first observation reads `before_first_seen`, not `not_priced`",
  late.counts.gaps.before_first_seen > 0 && late.counts.gaps.not_priced === 0,
  `before_first_seen=${late.counts.gaps.before_first_seen} not_priced=${late.counts.gaps.not_priced}`,
);
check(
  "leading absence is counted as lead-in, NOT as a break in the line",
  late.counts.lead_in_hours > 0 && late.counts.gap_hours === 0,
  `lead_in=${late.counts.lead_in_hours} gap_hours=${late.counts.gap_hours}`,
);
check(
  "the note for a late-admitted ticker does not claim missing data",
  !/break|missing|unavailable/i.test(chartNote(late) ?? ""),
  `note: ${chartNote(late)}`,
);
const dom = chartDomain(late)!;
check(
  "`chartDomain` starts at the first OBSERVATION, not at the requested window",
  dom.from_ms === hourToMs(late.points[0].hour) && dom.from_ms > hourToMs("2026090101"),
);
check(
  "an interior hole still counts as a break (lead-in leniency does not leak inward)",
  s.counts.gap_hours > 0,
  `gap_hours=${s.counts.gap_hours}`,
);

console.log("\n── 4. Vintage is read per ITEM, and `undefined` ≠ `null` (#159) ──\n");

const vintage: ChartDayInput[] = [
  {
    day: "20260904",
    status: "hit",
    hours_absent: [],
    points: [
      pt("2026090401", [T], { dated: 1_756_000_000 }), // a real round
      pt("2026090402", [T], { dated: null }), // read, could not date
      pt("2026090403", [T], { dated: "omit" }), // never recorded
    ],
  },
];
const v = buildChartSeries(T, "base", vintage);
check(
  "three dating states survive as three (dated / undatable / predates_field)",
  v.dating.dated === 1 && v.dating.undatable === 1 && v.dating.predates_field === 1,
  `dated=${v.dating.dated} undatable=${v.dating.undatable} predates_field=${v.dating.predates_field}`,
);
check(
  "vintage is read from the ITEM — three items in ONE day resolve to three different states",
  new Set(v.points.map((p) => p.dating)).size === 3,
  "if this fails, something is dating items from the day's `v`, which dates the WRITER",
);
check(
  "`dating.supported` is false on a desk that records no oracle round at all",
  oracleDatingSupported("base") && !oracleDatingSupported("robinhood"),
);
check(
  "an RH series ships `supported: false` beside its counts, not a bare tally",
  buildChartSeries(T, "robinhood", vintage).dating.supported === false,
);

console.log("\n── 5. The deadband is a measurement floor, not a firing threshold ──\n");

// Read through `number`-typed bindings ON PURPOSE. All three are `const` number
// literals, so TypeScript narrows them to `0.5`, `2` and `1` and then rejects
// `0.5 !== 2` as a comparison "with no overlap" (TS2367). That would leave the
// check compiling ONLY in the state it is meant to report — fuse the constants
// and the types match, tsc goes quiet, and the guard finally builds just in time
// to fail. A check that cannot be compiled while the invariant holds is not a
// check. Widening keeps it a runtime assertion, which is what it always was.
const deadband: number = DEADBAND_ABS_PCT;
const driftFires: number = DRIFT_MIN_ABS_PCT;
const arbFires: number = ARB_MIN_ABS_PCT;

check(
  `DEADBAND_ABS_PCT (${DEADBAND_ABS_PCT}) is NOT fused to DRIFT_MIN_ABS_PCT (${DRIFT_MIN_ABS_PCT})`,
  deadband !== driftFires,
);
check(
  `DEADBAND_ABS_PCT (${DEADBAND_ABS_PCT}) is NOT fused to ARB_MIN_ABS_PCT (${ARB_MIN_ABS_PCT})`,
  deadband !== arbFires,
);
check(
  "the deadband sits BELOW both firing thresholds (a floor, not a bar)",
  DEADBAND_ABS_PCT < DRIFT_MIN_ABS_PCT && DEADBAND_ABS_PCT < ARB_MIN_ABS_PCT,
);
const band = buildChartSeries(T, "base", [
  {
    day: "20260904",
    status: "hit",
    hours_absent: [],
    points: [
      pt("2026090401", [T], { drift: DEADBAND_ABS_PCT / 2 }),
      pt("2026090402", [T], { drift: DEADBAND_ABS_PCT * 2 }),
    ],
  },
]);
check(
  "the inside/graded pair ships WITH the series, so the caveat cannot be dropped",
  band.deadband.graded === 2 && band.deadband.inside === 1,
  `graded=${band.deadband.graded} inside=${band.deadband.inside}`,
);
check(
  "a reading exactly AT the deadband counts as outside (the band is exclusive)",
  buildChartSeries(T, "base", [
    { day: "20260904", status: "hit", hours_absent: [], points: [pt("2026090401", [T], { drift: DEADBAND_ABS_PCT })] },
  ]).deadband.inside === 0,
);

console.log("\n── 6. A chart is an assertion about ONE token on ONE chain ──\n");

if (RH_ONLY_TICKER === null) {
  check(
    "a ticker exists that is real on RH and absent from Base — the differential is still expressible",
    false,
    "Every RH stock is now on the Base desk. This property cannot be tested and must be RE-STATED, not deleted.",
  );
} else {
  const rhOnly = buildChartSeries(RH_ONLY_TICKER, "base", [
    { day: "20260904", status: "hit", hours_absent: [], points: [pt("2026090401", [RH_ONLY_TICKER])] },
  ]);
  check(
    `an RH-only ticker (${RH_ONLY_TICKER}) carries the chain it was asked for, never a fallback`,
    rhOnly.chain === "base",
  );
}
check(
  "the series carries its chain, so a caption cannot be assembled from the ticker alone",
  s.chain === "base" && buildChartSeries(T, "robinhood", mixed).chain === "robinhood",
);
// The load-bearing one: same ticker, same fixture, two chains. If a resolver
// ever grew a cross-chain fallback, both would return identical dating state.
check(
  "the SAME ticker on two chains does not resolve to the same series",
  JSON.stringify(buildChartSeries(T, "base", vintage).dating) !==
    JSON.stringify(buildChartSeries(T, "robinhood", vintage).dating),
);
check(
  "a series with fewer than two priced points is refused rather than drawn as a trend",
  !isPlottable(
    buildChartSeries(T, "base", [
      { day: "20260904", status: "hit", hours_absent: [], points: [pt("2026090401", [T])] },
    ]),
  ),
);

console.log("\n── 7. The renderer decides nothing — and this check can still find it ──\n");

const CHART_TSX = join(SRC, "components", "blue-hood", "TickerChart.tsx");
const ROUTE_TS = join(SRC, "app", "api", "hood", "ticker-series", "route.ts");

// LIVENESS FIRST. Every scan below is an absence check, and an absence check
// against a file that no longer exists passes forever while testing nothing
// (#370). So the file's existence — and the presence of the symbols the scans
// are phrased around — is asserted before any of them run.
check("the chart component exists at the path this guard scans", existsSync(CHART_TSX), CHART_TSX);
check("the ticker-series route exists at the path this guard scans", existsSync(ROUTE_TS), ROUTE_TS);

if (existsSync(CHART_TSX) && existsSync(ROUTE_TS)) {
  const tsx = readFileSync(CHART_TSX, "utf8");
  const route = readFileSync(ROUTE_TS, "utf8");

  check(
    "liveness: the component still walks `segments` (the symbol the scans below assume)",
    tsx.includes("segments"),
  );
  check(
    "liveness: the component still renders `<polyline` (the drawing the scans below constrain)",
    tsx.includes("<polyline"),
  );

  // THE bug, at the source level: a polyline whose points come from the flat
  // array. `series.points` is for scaling axes; drawing it bridges every hole.
  const bridgesFlat = /points=\{[^}]*series\.points[^}]*\}/s.test(tsx);
  check(
    "no `<polyline points={…series.points…}>` — the flat array must never be drawn",
    !bridgesFlat,
    "the flat array exists for axis scaling; a polyline built from it joins 03:00 to 09:00",
  );

  check(
    "the component does not recompute drift from the two prices",
    !/dex_usd\s*\/\s*.*oracle_usd|oracle_usd\s*\)\s*\/\s*.*oracle_usd/.test(tsx),
    "drift is copied from the archive so the chart cannot disagree with the receipt beside it",
  );
  check(
    "the component sends `chain` on the wire rather than letting the route guess",
    /chain=\$\{encodeURIComponent\(chain\)\}/.test(tsx),
  );
  check(
    "the component takes `chain` as a required prop (not optional, not defaulted)",
    /chain:\s*HoodChain;/.test(tsx) && !/chain\?:\s*HoodChain/.test(tsx),
  );

  // The route must REFUSE a chainless request. A default would recreate #161
  // while every other check here still passed.
  check(
    "the route 400s a request with no `chain` instead of defaulting to a desk",
    /rawChain === null/.test(route) && /Missing \?chain=/.test(route),
  );
  check(
    "the route never imports a series KEY BUILDER — it asks a reader for days",
    !/kvBaseSeriesDay|kvSeriesDay/.test(route),
    "importing both key builders into one handler is what makes cross-archive writes expressible",
  );
  check(
    "the route reads BOTH archives through their own readers, never one for both",
    /readBaseSeriesDays/.test(route) && /readSeriesDays/.test(route),
  );
}

console.log(
  `\nhood-chart-check: ${passes}/${passes + failures} passed${failures ? ` — ${failures} FAILED` : ""}\n`,
);
process.exit(failures === 0 ? 0 : 1);
