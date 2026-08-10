/**
 * Cohort statistics engine — correctness + behaviour tests.
 *
 * Run: npm run test:cohorts   (from apps/web)
 *
 * Two halves, and BOTH must pass for a green run to mean anything:
 *
 *   A. MATH — Wilson intervals, the exact binomial test, Benjamini-Hochberg
 *      and the power formula, each checked against values worked out
 *      independently (textbook closed forms / hand-computed cases), not
 *      against whatever this implementation happens to print.
 *
 *   B. BEHAVIOUR — the part that actually protects the product:
 *        B1 control  — feed PURE COIN-FLIP arrows. The engine must report
 *                      `no_validated_edge`. Across many trials the rate at
 *                      which it wrongly reports an edge must stay near the
 *                      5% FDR, NOT the ~28% you get from picking the best of
 *                      29 uncorrected cohorts.
 *        B2 converse — feed arrows with a REAL planted edge, large enough to
 *                      be detectable. The engine MUST find it. Without this,
 *                      an engine that always answered "no edge" would sail
 *                      through B1 and be worthless.
 *
 *      B1 alone is the trap: a broken-but-silent engine passes it. B1+B2
 *      together pin the engine between paranoia and credulity.
 *
 * Deterministic: seeded PRNG, fixed clock. No network, no KV, no LLM.
 */
import type { Arrow, ArrowType, MarketSession } from "../src/lib/blue-hood/types";
import {
  analyzeCohorts,
  benjaminiHochberg,
  binomialTestTwoSided,
  requiredSampleSize,
  wilsonInterval,
  COHORT_MIN_SAMPLE,
} from "../src/lib/blue-hood/cohort-stats";

let failures = 0;
let checks = 0;

function ok(label: string, pass: boolean, detail = "") {
  checks++;
  if (pass) {
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? `: ${detail}` : ""}`);
  }
}

function near(label: string, actual: number, expected: number, tol: number) {
  ok(
    label,
    Math.abs(actual - expected) <= tol,
    `got ${actual.toPrecision(6)}, expected ${expected.toPrecision(6)} (±${tol})`,
  );
}

// ── Deterministic PRNG (mulberry32) ─────────────────────────────────────────
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NOW = Date.UTC(2026, 7, 8, 12, 0, 0);
const TICKERS = ["NVDA", "AMD", "INTC", "MU", "COIN", "MSTR", "PLTR", "BABA", "SNDK", "ORCL"];
const SESSIONS: MarketSession[] = ["regular", "premarket", "afterhours", "weekend"];

/** Build a synthetic graded arrow with controllable features. */
function makeArrow(
  i: number,
  hit: boolean,
  r: () => number,
  overrides: Partial<Arrow> = {},
): Arrow {
  const type: ArrowType = r() < 0.5 ? "drift" : "arb";
  const session = SESSIONS[Math.floor(r() * SESSIONS.length)];
  const oracle = 100;
  const devPct = 0.5 + r() * 5;
  return {
    id: `arrow-${i}`,
    serial: `#${String(i).padStart(4, "0")}`,
    ticker: TICKERS[Math.floor(r() * TICKERS.length)],
    type,
    expected_direction: r() < 0.5 ? "up" : "down",
    grading_window_h: type === "drift" ? 6 : 4,
    reference_price: oracle,
    snapshot_refs: [],
    fired_at: new Date(NOW - (i + 1) * 3_600_000).toISOString(),
    status: "graded",
    outcome: hit ? "hit" : "miss",
    graded_at: new Date(NOW - i * 3_600_000).toISOString(),
    outcome_detail: null,
    origin: "engine",
    snapshot_at_fire: {
      dex_price_usd: oracle * (1 + devPct / 100),
      oracle_price_usd: oracle,
      dex_tvl_usd: 10_000 + r() * 300_000,
      dex_total_tvl_usd: null,
      dex_volume_24h_usd: 5_000 + r() * 200_000,
      dex_change_24h_pct: null,
      chainlink_age_seconds: null,
    },
    market_at_fire: {
      is_open: session === "regular",
      session,
      ny_time_iso: new Date(NOW).toISOString(),
    },
    ...overrides,
  };
}

// ══ A. MATH ═════════════════════════════════════════════════════════════════
console.log("\nA. Statistics primitives");

// Wilson, 50/100. Closed form: centre = (0.5 + 1.9208/200)/(1+0.038416) = 0.5,
// half-width = 1.96*sqrt(0.0025 + 0.0000960)/1.038416 = 0.09793.
{
  const ci = wilsonInterval(50, 100);
  near("wilson(50,100).lo ≈ 0.4020", ci.lo, 0.402, 0.002);
  near("wilson(50,100).hi ≈ 0.5980", ci.hi, 0.598, 0.002);
}
// The reason Wilson was chosen: the normal approximation gives [1,1] here.
{
  const ci = wilsonInterval(10, 10);
  ok("wilson(10,10) stays inside [0,1]", ci.hi <= 1 && ci.lo > 0.5 && ci.lo < 1,
     `got [${ci.lo.toFixed(3)}, ${ci.hi.toFixed(3)}]`);
}
ok("wilson(0,0) degrades to [0,1]", (() => { const c = wilsonInterval(0, 0); return c.lo === 0 && c.hi === 1; })());

// Exact binomial. 10/10 at p0=0.5 → 2 * 0.5^10 = 0.001953125 exactly.
near("binom(10,10) = 2·0.5^10", binomialTestTwoSided(10, 10), 0.001953125, 1e-12);
// 8/10 → two-sided = 2 * P(X>=8) = 2*(45+10+1)/1024 = 112/1024 = 0.109375
near("binom(8,10) = 0.109375", binomialTestTwoSided(8, 10), 0.109375, 1e-12);
// Symmetric outcomes must agree exactly under p0 = 0.5.
near("binom symmetric 2/10 == 8/10", binomialTestTwoSided(2, 10), binomialTestTwoSided(8, 10), 1e-12);
near("binom(5,10) = 1 (dead centre)", binomialTestTwoSided(5, 10), 1, 1e-9);
// Large n must not overflow: choose(400,200) ~1e119 would blow a naive factorial.
ok("binom(200,400) finite (log-space, no overflow)", Number.isFinite(binomialTestTwoSided(200, 400)));

// Benjamini-Hochberg, hand-worked. m=5, fdr=0.05, ceilings = .01 .02 .03 .04 .05
// p = [.001, .008, .039, .041, .9] → rank3 (.039 > .03) fails, rank4 (.041 > .04)
// fails, but rank2 (.008 <= .02) passes → step-up keeps ranks 1–2 only.
{
  const keep = benjaminiHochberg([0.001, 0.008, 0.039, 0.041, 0.9], 0.05);
  ok("BH keeps exactly the 2 smallest", JSON.stringify(keep) === JSON.stringify([true, true, false, false, false]),
     JSON.stringify(keep));
}
// Step-up property: a large p at a high rank rescues smaller ones below it.
{
  const keep = benjaminiHochberg([0.01, 0.02, 0.03, 0.04, 0.05], 0.05);
  ok("BH step-up keeps all 5 when every p sits on its ceiling", keep.every(Boolean), JSON.stringify(keep));
}
ok("BH on empty input returns empty", benjaminiHochberg([]).length === 0);

// Power: detecting 61.5% vs 50% at α=.05, power=.8 → ~146 by the standard formula.
{
  const n = requiredSampleSize(0.615);
  ok("requiredSampleSize(0.615) ≈ 146", n >= 140 && n <= 152, `got ${n}`);
}
ok("requiredSampleSize(0.5) = Infinity (no effect to detect)", !Number.isFinite(requiredSampleSize(0.5)));
ok("bigger effect needs fewer samples", requiredSampleSize(0.8) < requiredSampleSize(0.6));

// ══ B1. CONTROL — pure noise must NOT yield an edge ═════════════════════════
console.log("\nB1. Control: coin-flip arrows (true rate = 50%)");
{
  const TRIALS = 200;
  const N = 150;
  let falseEdges = 0;
  let bestUncorrectedHits = 0;

  for (let t = 0; t < TRIALS; t++) {
    const r = rng(1000 + t);
    const arrows: Arrow[] = [];
    for (let i = 0; i < N; i++) arrows.push(makeArrow(i, r() < 0.5, r));
    const res = analyzeCohorts(arrows, { now: NOW });
    if (res.validated.length > 0) falseEdges++;
    // How often does at least one cohort look significant WITHOUT correction?
    if (res.cohorts.some((c) => c.ready && (c.p_value ?? 1) < 0.05)) bestUncorrectedHits++;
  }

  const correctedRate = falseEdges / TRIALS;
  const naiveRate = bestUncorrectedHits / TRIALS;

  console.log(`     naive "best cohort p<0.05" fires in ${(naiveRate * 100).toFixed(1)}% of pure-noise runs`);
  console.log(`     corrected engine claims an edge in ${(correctedRate * 100).toFixed(1)}% of pure-noise runs`);

  ok("control: corrected false-edge rate ≤ 10%", correctedRate <= 0.10, `${(correctedRate * 100).toFixed(1)}%`);
  ok("control: correction is doing real work (naive ≫ corrected)", naiveRate > correctedRate * 2,
     `naive ${(naiveRate * 100).toFixed(1)}% vs corrected ${(correctedRate * 100).toFixed(1)}%`);
}

// ══ B2. CONVERSE — a real edge MUST be found ═══════════════════════════════
console.log("\nB2. Converse: planted edge (drift = 80%, arb = 50%)");
{
  const r = rng(7);
  const arrows: Arrow[] = [];
  for (let i = 0; i < 240; i++) {
    // Decide type first so the planted edge attaches to a real feature.
    const isDrift = i % 2 === 0;
    const hit = r() < (isDrift ? 0.8 : 0.5);
    const a = makeArrow(i, hit, r);
    a.type = isDrift ? "drift" : "arb";
    a.grading_window_h = isDrift ? 6 : 4;
    arrows.push(a);
  }
  const res = analyzeCohorts(arrows, { now: NOW });
  const drift = res.cohorts.find((c) => c.key === "type:drift");

  ok("converse: verdict = edge_detected", res.verdict === "edge_detected", res.verdict);
  ok("converse: drift survives correction", drift?.survives_correction === true);
  ok("converse: drift CI excludes 50%", drift?.ci_excludes_null === true,
     drift?.ci ? `[${drift.ci.lo}%, ${drift.ci.hi}%]` : "no ci");
  ok("converse: drift pct ≈ 80%", (drift?.pct ?? 0) > 70 && (drift?.pct ?? 0) < 90, `${drift?.pct}%`);
  ok("converse: arb does NOT survive", res.cohorts.find((c) => c.key === "type:arb")?.survives_correction === false);
}

// ══ B3. Gate + alias behaviour ═════════════════════════════════════════════
console.log("\nB3. Sample gate and alias collapsing");
{
  const r = rng(11);
  const few: Arrow[] = [];
  for (let i = 0; i < COHORT_MIN_SAMPLE - 1; i++) few.push(makeArrow(i, true, r));
  const res = analyzeCohorts(few, { now: NOW });
  ok("below gate: verdict = insufficient_data", res.verdict === "insufficient_data", res.verdict);
  ok("below gate: overall emits NO pct even at 100% hits", res.overall.pct === undefined,
     `pct=${res.overall.pct}`);
  ok("below gate: no cohort emits a pct", res.cohorts.every((c) => c.pct === undefined));
}
{
  // Perfectly collinear by construction: every drift arrow is market-closed and
  // 6h-windowed — exactly the confound present in the live record.
  const r = rng(23);
  const arrows: Arrow[] = [];
  for (let i = 0; i < 120; i++) {
    const isDrift = i % 2 === 0;
    const a = makeArrow(i, r() < 0.5, r);
    a.type = isDrift ? "drift" : "arb";
    a.grading_window_h = isDrift ? 6 : 4;
    a.market_at_fire = {
      is_open: !isDrift,
      session: isDrift ? "afterhours" : "regular",
      ny_time_iso: new Date(NOW).toISOString(),
    };
    arrows.push(a);
  }
  const res = analyzeCohorts(arrows, { now: NOW });
  const driftGroup = res.confounds.find((g) => g.keys.includes("type:drift"));
  ok("alias: drift/market-closed/afterhours detected as one hypothesis",
     !!driftGroup && driftGroup.keys.includes("market:closed"),
     JSON.stringify(res.confounds.map((c) => c.keys)));
  ok("alias: collapsed family is smaller than the raw cohort count",
     res.tests_run < res.cohorts.filter((c) => c.ready).length,
     `tests_run=${res.tests_run}, ready cohorts=${res.cohorts.filter((c) => c.ready).length}`);
  const drift = res.cohorts.find((c) => c.key === "type:drift");
  ok("alias: aliases listed on the cohort", (drift?.aliases.length ?? 0) > 0, JSON.stringify(drift?.aliases));
}

// ══ B4. De-aliasing of the headline lists ══════════════════════════════════
// The counts in `validated` / `exploratory` are what a reader quotes ("4 edges
// found"). If an alias group contributed one entry per LABEL, a single fact
// wearing three names would read as three findings — the exact over-count the
// correction exists to prevent. So: plant a real edge on a perfectly collinear
// group and assert the lists report the HYPOTHESIS once, while the full
// `cohorts` list still marks every alias as surviving.
console.log("\nB4. Headline lists count hypotheses, not labels");
{
  const r = rng(77);
  const arrows: Arrow[] = [];
  for (let i = 0; i < 200; i++) {
    const isDrift = i % 2 === 0;
    // Drift genuinely works here (85%); arb is a coin flip.
    const a = makeArrow(i, isDrift ? r() < 0.85 : r() < 0.5, r);
    a.type = isDrift ? "drift" : "arb";
    a.grading_window_h = isDrift ? 6 : 4;
    a.market_at_fire = {
      is_open: !isDrift,
      session: isDrift ? "afterhours" : "regular",
      ny_time_iso: new Date(NOW).toISOString(),
    };
    arrows.push(a);
  }
  const res = analyzeCohorts(arrows, { now: NOW });
  const headline = [...res.validated, ...res.exploratory];

  ok("de-alias: the planted edge is detected", res.verdict === "edge_detected",
     `verdict=${res.verdict}, validated=${res.validated.length}`);

  // No entry in the headline lists may be an alias of another entry.
  const keys = new Set(headline.map((c) => c.key));
  const dup = headline.find((c) => c.aliases.some((a) => keys.has(a)));
  ok("de-alias: no two headline entries are the same hypothesis", !dup,
     dup ? `${dup.key} co-listed with alias in [${[...keys].join(", ")}]` : "");

  // …but the aliases are NOT silently dropped: they still carry the result.
  const closed = res.cohorts.find((c) => c.key === "market:closed");
  const driftC = res.cohorts.find((c) => c.key === "type:drift");
  ok("de-alias: aliases still marked as surviving in the full cohort list",
     !!closed?.survives_correction && !!driftC?.survives_correction,
     `drift=${driftC?.survives_correction}, closed=${closed?.survives_correction}`);
  ok("de-alias: headline count ≤ distinct hypotheses tested",
     headline.length <= res.tests_run,
     `headline=${headline.length}, tests_run=${res.tests_run}`);
}

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${failures === 0 ? "ALL GREEN" : "FAILURES"} — ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
