/**
 * Blue Hood — cohort statistics engine.
 *
 * WHY THIS FILE EXISTS, and why it is built to say "no":
 *
 * The ask was "find the condition where drift closes 78%, so we can sell the
 * good subset". That is a reasonable product instinct and a statistical trap.
 * With ~140 graded arrows, slicing into cohorts of 10–50 and keeping the best
 * one is guaranteed to surface a winner FROM NOISE ALONE. Measured, not
 * assumed — on the 2026-08-08 record, scanning 29 cohorts produced EIGHT with
 * p < 0.05, and ZERO survived a Benjamini-Hochberg correction. Two of the
 * "significant" ones were single tickers at opposite extremes (9/10 and 1/10)
 * — the signature of chance, not edge.
 *
 * Publishing that 9/10 as "90% on this ticker" would be a fabricated number
 * dressed as a measured one, which the project's data-honesty rule forbids
 * exactly as firmly as inventing a contract address.
 *
 * So this module computes the honest version:
 *   • Wilson score intervals, never a bare point estimate.
 *   • Exact two-sided binomial test against the 50% coin-flip null.
 *   • Benjamini-Hochberg FDR across the WHOLE family of cohorts tested, so
 *     "best of 29" is judged as best-of-29 and not as a lone hypothesis.
 *   • Alias detection — cohorts with an identical member set are ONE
 *     hypothesis, not several, and are collapsed before correction. On the
 *     current record `type=drift`, `market_closed` and `grading_window=6h`
 *     are the exact same 96 arrows, so "drift works better" and "signals fire
 *     better when the market is shut" are indistinguishable claims. Reporting
 *     them as three findings would triple-count one fact.
 *   • Power analysis — how many more graded arrows are needed before the
 *     leading candidate could be confirmed at all.
 *
 * A cohort below `COHORT_MIN_SAMPLE` emits NO percentage, mirroring
 * `hit-rate-gate.ts` (whose per-type gate is the same 15). That gate exists
 * because a number, once rendered, gets quoted — so we do not render one we
 * cannot stand behind.
 *
 * CHAIN IS PART OF A COHORT'S IDENTITY. Blue Hood grades two desks — Robinhood
 * Chain (4663) and Base (8453) — and NVDA / META / GOOGL / AAPL trade on both
 * as separate contracts with separate pools. A cohort keyed on the bare ticker
 * would pool two different assets and report the blend as one measured rate,
 * which is the same fabrication this file exists to refuse, just arrived at by
 * arithmetic instead of by an LLM. Ticker cohorts are therefore keyed by
 * `rowKey` and the family includes a pre-registered `chain:robinhood` /
 * `chain:base` split. See `cohortDefs` for why that pair was declared while
 * `n_base` was still 0.
 *
 * WINDOW: `hit-rate-gate.ts` deliberately uses a rolling 7 days for the public
 * headline. This module defaults to the FULL record, because a 7-day window
 * currently holds ~72 graded arrows and cohorts inside it would be ~10–20 —
 * far below anything testable. That difference is also why the headline can
 * swing double digits week to week while the underlying rate is unchanged:
 * at n≈70 a ±12pp move is ordinary sampling noise. `window_basis` is stamped
 * on the output so the two numbers can never be silently conflated.
 *
 * Pure + deterministic: no LLM, no network, no clock reads beyond the `now`
 * argument. Every number here is computed in code — an LLM must never be
 * asked to produce or adjust one.
 */
import { chainOf, rowKey, type Arrow, type HoodChain } from "./types";
import { HIT_RATE_MIN_SAMPLE_PER_TYPE } from "./hit-rate-gate";

// ── Thresholds ───────────────────────────────────────────────────────────────

/**
 * A cohort must have this many graded (HIT+MISS) arrows before we compute a
 * percentage for it or enter it into the multiple-comparison family. Matches
 * the per-type public gate so the two can't disagree about what "enough" means.
 */
export const COHORT_MIN_SAMPLE = HIT_RATE_MIN_SAMPLE_PER_TYPE;

/** False-discovery rate for the Benjamini-Hochberg step. */
export const COHORT_FDR = 0.05;

/** Null hypothesis: a signal with no edge closes half the time. */
export const NULL_HIT_RATE = 0.5;

/**
 * 1.1.0 — ticker cohorts are keyed by `rowKey` (ticker, chain) instead of a bare
 * ticker, and a pre-registered `chain:*` pair joined the family. The key shape
 * changed for Base rows only (`ticker:base:NVDA`); Robinhood keys are unchanged.
 * Stamped on the output so a stored analysis can't be compared against a newer
 * one without noticing the family grew.
 */
export const COHORT_STATS_VERSION = "1.1.0";

// ── Statistics primitives ────────────────────────────────────────────────────

export interface ConfidenceInterval {
  /** Lower bound, 0–1. */
  lo: number;
  /** Upper bound, 0–1. */
  hi: number;
}

/**
 * Wilson score interval — the small-sample-safe binomial CI.
 *
 * Chosen over the textbook normal approximation (p̂ ± z·√(p̂(1−p̂)/n)) because
 * that one degenerates exactly where our cohorts live: at n=10 with 9 hits it
 * produces an upper bound above 1.0, and at 10/10 it produces the absurd
 * [1.0, 1.0]. Wilson stays inside [0,1] and keeps its nominal coverage down to
 * small n, which is the regime every cohort here is in.
 */
export function wilsonInterval(hits: number, n: number, z = 1.96): ConfidenceInterval {
  if (n <= 0) return { lo: 0, hi: 1 };
  const p = hits / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const halfWidth = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return {
    lo: Math.max(0, centre - halfWidth),
    hi: Math.min(1, centre + halfWidth),
  };
}

/** Lanczos log-gamma — lets the binomial pmf run in log space so `choose(n,k)` can't overflow. */
function logGamma(x: number): number {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const z = x - 1;
  let a = c[0];
  const t = z + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

function logChoose(n: number, k: number): number {
  return logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);
}

function binomialPmf(k: number, n: number, p: number): number {
  if (k < 0 || k > n) return 0;
  if (p <= 0) return k === 0 ? 1 : 0;
  if (p >= 1) return k === n ? 1 : 0;
  return Math.exp(logChoose(n, k) + k * Math.log(p) + (n - k) * Math.log(1 - p));
}

/**
 * Exact two-sided binomial test — the probability of an outcome AT LEAST as
 * extreme as `hits`, if the true rate were `p0`.
 *
 * Exact rather than a normal/chi-square approximation because cohorts here run
 * as small as 15, where the approximation misstates the tail. Two-sided by
 * summing every outcome no more likely than the observed one (the standard
 * small-sample construction); a one-sided test would quietly double our
 * apparent significance, which is the opposite of this module's purpose.
 */
export function binomialTestTwoSided(hits: number, n: number, p0 = NULL_HIT_RATE): number {
  if (n <= 0) return 1;
  const observed = binomialPmf(hits, n, p0);
  // 1e-9 relative slack: floating-point pmf values that are mathematically
  // equal (symmetric outcomes under p0=0.5) must both be counted.
  const tolerance = observed * 1e-9;
  let total = 0;
  for (let k = 0; k <= n; k++) {
    const pk = binomialPmf(k, n, p0);
    if (pk <= observed + tolerance) total += pk;
  }
  return Math.min(1, total);
}

/**
 * Benjamini-Hochberg step-up. Returns a boolean per input p-value: true where
 * the hypothesis is retained at the given false-discovery rate.
 *
 * BH rather than Bonferroni: Bonferroni controls the chance of ANY false
 * positive and at 29 cohorts would demand p < 0.0017, which no realistic edge
 * would clear at this sample size — it would make the engine useless rather
 * than honest. BH controls the EXPECTED PROPORTION of false discoveries, which
 * is the right question for "which of these cohorts deserve a second look".
 */
export function benjaminiHochberg(pvalues: number[], fdr = COHORT_FDR): boolean[] {
  const m = pvalues.length;
  const keep = new Array<boolean>(m).fill(false);
  if (m === 0) return keep;

  const ordered = pvalues
    .map((p, index) => ({ p, index }))
    .sort((a, b) => a.p - b.p);

  // Largest rank whose p-value clears its BH ceiling; everything up to that
  // rank is retained (the "step-up" part — a later pass can rescue earlier
  // ranks that individually looked borderline).
  let cutoff = -1;
  for (let rank = 0; rank < m; rank++) {
    if (ordered[rank].p <= (fdr * (rank + 1)) / m) cutoff = rank;
  }
  for (let rank = 0; rank <= cutoff; rank++) keep[ordered[rank].index] = true;
  return keep;
}

/** Normal quantile (Acklam's inverse-CDF approximation) — used for power sizing. */
function normalQuantile(p: number): number {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
           ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pLow) return -normalQuantile(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
         (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/**
 * Graded arrows needed to detect a true rate of `pAlt` against the 50% null,
 * at the given significance and power. The actionable output: not "we have no
 * edge" but "confirming this specific candidate needs N more arrows".
 */
export function requiredSampleSize(pAlt: number, alpha = 0.05, power = 0.8): number {
  const effect = Math.abs(pAlt - NULL_HIT_RATE);
  if (effect < 1e-9) return Number.POSITIVE_INFINITY;
  const zAlpha = normalQuantile(1 - alpha / 2);
  const zBeta = normalQuantile(power);
  const numerator =
    zAlpha * Math.sqrt(NULL_HIT_RATE * (1 - NULL_HIT_RATE)) +
    zBeta * Math.sqrt(pAlt * (1 - pAlt));
  return Math.ceil((numerator * numerator) / (effect * effect));
}

// ── Arrow feature extraction ─────────────────────────────────────────────────

/** Graded means the outcome actually counts: VOID and informational are excluded. */
export function isGraded(a: Arrow): boolean {
  return a.outcome === "hit" || a.outcome === "miss";
}

/**
 * |DEX − oracle| / oracle, in percent, at fire time. Null when either price is
 * missing — callers must treat null as "unknown" and drop the arrow from that
 * cohort rather than substituting a zero.
 */
export function deviationPct(a: Arrow): number | null {
  const snap = a.snapshot_at_fire;
  if (!snap) return null;
  const dex = snap.dex_price_usd;
  const oracle = snap.oracle_price_usd;
  if (dex === null || oracle === null || !oracle) return null;
  return (Math.abs(dex - oracle) / oracle) * 100;
}

function tvlUsd(a: Arrow): number | null {
  return a.snapshot_at_fire?.dex_tvl_usd ?? null;
}

function volumeUsd(a: Arrow): number | null {
  return a.snapshot_at_fire?.dex_volume_24h_usd ?? null;
}

// ── Cohort definitions ───────────────────────────────────────────────────────

export type CohortDimension =
  | "type"
  | "session"
  | "direction"
  | "deviation"
  | "liquidity"
  | "volume"
  | "chain"
  | "ticker";

export interface CohortDef {
  key: string;
  label: string;
  dimension: CohortDimension;
  /** True when the arrow belongs to this cohort. Must return false on unknown data. */
  match: (a: Arrow) => boolean;
}

function bucket(
  key: string,
  label: string,
  dimension: CohortDimension,
  read: (a: Arrow) => number | null,
  lo: number,
  hi: number,
): CohortDef {
  return {
    key,
    label,
    dimension,
    match: (a) => {
      const v = read(a);
      return v !== null && v >= lo && v < hi;
    },
  };
}

/**
 * The hypothesis family. Every cohort listed here is tested EVERY run — the
 * list is fixed in code on purpose. If cohorts were added ad hoc after
 * eyeballing the data, the correction below would be meaningless: you cannot
 * honestly correct for the tests you decided not to admit to running.
 *
 * `rows` is passed in rather than hard-coded so the ticker family grows with the
 * universe, and the correction automatically accounts for the wider search.
 *
 * ⚠️ TICKER COHORTS ARE KEYED BY (TICKER, CHAIN), NOT BY TICKER.
 * NVDA, META, GOOGL and AAPL exist on BOTH desks as different contracts with
 * different pools. `match: (a) => a.ticker === t` therefore merged two assets
 * into one cohort, and that is worse here than anywhere else in the codebase:
 * this module is the TOOLING for the #152 question "does the Base desk generate
 * drift the way Robinhood does?". A merged cohort answers it with a clean,
 * confident number computed over a mixed population — Base's small drift diluted
 * into Robinhood's larger one — and nothing in the output would reveal the mix.
 * A wrong answer that looks rigorous is the failure mode this whole file was
 * written to prevent, so the key comes from `rowKey`: `ticker:NVDA` (unchanged
 * for Robinhood, which pays no migration cost) and `ticker:base:NVDA`.
 *
 * The `chain:*` pair is PRE-REGISTERED — declared now, while `n_base` is still
 * 0, precisely so it is part of the fixed family before anyone has seen a Base
 * number. Adding it later, after glancing at the data, is the ad-hoc admission
 * this doc forbids. Below the gate it simply reports `ready: false` and a
 * `needed` count, which is the honest state of that question today.
 */
export function cohortDefs(rows: { ticker: string; chain?: HoodChain }[] = []): CohortDef[] {
  const defs: CohortDef[] = [
    { key: "chain:robinhood", label: "chain = Robinhood Chain", dimension: "chain", match: (a) => chainOf(a) === "robinhood" },
    { key: "chain:base", label: "chain = Base", dimension: "chain", match: (a) => chainOf(a) === "base" },

    { key: "type:drift", label: "type = drift", dimension: "type", match: (a) => a.type === "drift" },
    { key: "type:arb", label: "type = arb", dimension: "type", match: (a) => a.type === "arb" },

    { key: "session:regular", label: "session = regular", dimension: "session", match: (a) => a.market_at_fire?.session === "regular" },
    { key: "session:premarket", label: "session = premarket", dimension: "session", match: (a) => a.market_at_fire?.session === "premarket" },
    { key: "session:afterhours", label: "session = afterhours", dimension: "session", match: (a) => a.market_at_fire?.session === "afterhours" },
    { key: "session:weekend", label: "session = weekend", dimension: "session", match: (a) => a.market_at_fire?.session === "weekend" },
    { key: "market:open", label: "market open", dimension: "session", match: (a) => a.market_at_fire?.is_open === true },
    { key: "market:closed", label: "market closed", dimension: "session", match: (a) => a.market_at_fire?.is_open === false },

    { key: "dir:up", label: "expects up", dimension: "direction", match: (a) => a.expected_direction === "up" },
    { key: "dir:down", label: "expects down", dimension: "direction", match: (a) => a.expected_direction === "down" },

    bucket("dev:0-1", "deviation < 1%", "deviation", deviationPct, 0, 1),
    bucket("dev:1-2", "deviation 1–2%", "deviation", deviationPct, 1, 2),
    bucket("dev:2-4", "deviation 2–4%", "deviation", deviationPct, 2, 4),
    bucket("dev:4+", "deviation ≥ 4%", "deviation", deviationPct, 4, Infinity),

    bucket("tvl:0-50k", "pool TVL < $50k", "liquidity", tvlUsd, 0, 50_000),
    bucket("tvl:50-150k", "pool TVL $50k–150k", "liquidity", tvlUsd, 50_000, 150_000),
    bucket("tvl:150k+", "pool TVL ≥ $150k", "liquidity", tvlUsd, 150_000, Infinity),

    bucket("vol:0-25k", "24h volume < $25k", "volume", volumeUsd, 0, 25_000),
    bucket("vol:25-100k", "24h volume $25k–100k", "volume", volumeUsd, 25_000, 100_000),
    bucket("vol:100k+", "24h volume ≥ $100k", "volume", volumeUsd, 100_000, Infinity),
  ];

  // `rowKey` on BOTH sides: it applies `chainOf`'s absent ⟹ robinhood default
  // and returns the BARE ticker for Robinhood, so every historical cohort key
  // (`ticker:NVDA`) is byte-identical to what it was before Base existed. Only
  // Base rows get a new spelling — the incumbent pays no migration cost.
  for (const k of [...new Set(rows.map(rowKey))].sort()) {
    defs.push({
      key: `ticker:${k}`,
      label: `ticker = ${k}`,
      dimension: "ticker",
      match: (a) => rowKey(a) === k,
    });
  }
  return defs;
}

// ── Analysis output ──────────────────────────────────────────────────────────

export interface CohortStat {
  key: string;
  label: string;
  dimension: CohortDimension;
  hits: number;
  misses: number;
  /** hits + misses. */
  n: number;
  /** Cleared COHORT_MIN_SAMPLE — only then is `pct` populated. */
  ready: boolean;
  needed: number;
  /** Observed hit rate 0–100. Present only when `ready`. */
  pct?: number;
  /** Wilson 95% CI, 0–100. Present only when `ready`. */
  ci?: { lo: number; hi: number };
  /** Exact two-sided binomial p vs the 50% null. Present only when `ready`. */
  p_value?: number;
  /** Retained by Benjamini-Hochberg across the whole tested family. */
  survives_correction: boolean;
  /** True when the CI excludes 50% — necessary but NOT sufficient to claim an edge. */
  ci_excludes_null: boolean;
  /** Keys of cohorts covering an identical arrow set (same hypothesis, different name). */
  aliases: string[];
}

export interface ConfoundGroup {
  /** Cohort keys that select exactly the same arrows. */
  keys: string[];
  n: number;
  note: string;
}

export interface CohortAnalysis {
  version: string;
  window_basis: "all_time" | "rolling_7d";
  /** Graded arrows considered (HIT+MISS only). */
  graded: number;
  overall: {
    hits: number;
    misses: number;
    n: number;
    pct?: number;
    ci?: { lo: number; hi: number };
    p_value?: number;
    ready: boolean;
  };
  /** Every cohort, largest hit-rate first. Cohorts below the gate carry no pct. */
  cohorts: CohortStat[];
  /** How many hypotheses entered the correction (aliases collapsed to one). */
  tests_run: number;
  /**
   * Cohorts that survive BH — the ONLY ones any surface may call an edge.
   * One entry per hypothesis: alias groups appear once, via the representative
   * that entered the correction, with the other names in its `aliases`.
   */
  validated: CohortStat[];
  /**
   * Cohorts that look significant alone but do NOT survive correction. Kept
   * visible for internal steering, and explicitly not publishable.
   * De-aliased the same way as `validated`, so the length is a count of
   * distinct hypotheses rather than of labels.
   */
  exploratory: CohortStat[];
  confounds: ConfoundGroup[];
  /** Sizing for the strongest candidate, so "not yet" comes with a number. */
  power: {
    leading_cohort?: string;
    observed_pct?: number;
    n_now?: number;
    n_required?: number;
    n_more?: number;
  };
  /** Plain-language state of the evidence — derived in code, never by an LLM. */
  verdict: "no_validated_edge" | "edge_detected" | "insufficient_data";
}

// ── Analysis ─────────────────────────────────────────────────────────────────

function statBlock(arrows: Arrow[]) {
  const hits = arrows.filter((a) => a.outcome === "hit").length;
  const misses = arrows.filter((a) => a.outcome === "miss").length;
  return { hits, misses, n: hits + misses };
}

/**
 * Run the full cohort analysis over an already-trust-filtered arrow list
 * (`readPublicArrows` does origin/test filtering; this function does not
 * re-derive it, matching how `computeHitRate` is layered).
 *
 * `windowMs` narrows to arrows graded within that many ms of `now`; omit it —
 * the default — to use the entire record, which is what any cohort split needs.
 */
export function analyzeCohorts(
  arrows: Arrow[],
  opts: { now?: number; windowMs?: number } = {},
): CohortAnalysis {
  const now = opts.now ?? Date.now();
  const inWindow = opts.windowMs
    ? arrows.filter(
        (a) => a.graded_at && new Date(a.graded_at).getTime() >= now - opts.windowMs!,
      )
    : arrows;
  const graded = inWindow.filter(isGraded);

  const overallRaw = statBlock(graded);
  const overallReady = overallRaw.n >= COHORT_MIN_SAMPLE;
  const overallCi = wilsonInterval(overallRaw.hits, overallRaw.n);
  const overall = {
    ...overallRaw,
    ready: overallReady,
    ...(overallReady
      ? {
          pct: round1((overallRaw.hits / overallRaw.n) * 100),
          ci: { lo: round1(overallCi.lo * 100), hi: round1(overallCi.hi * 100) },
          p_value: binomialTestTwoSided(overallRaw.hits, overallRaw.n),
        }
      : {}),
  };

  // Whole rows, not `a.ticker` — dropping the chain here is what let a Base NVDA
  // and a Robinhood NVDA land in one cohort.
  const defs = cohortDefs(graded);

  // Members per cohort, kept as id sets so aliases can be detected exactly.
  const members = new Map<string, Arrow[]>();
  const signatures = new Map<string, string>();
  for (const def of defs) {
    const sub = graded.filter(def.match);
    members.set(def.key, sub);
    signatures.set(
      def.key,
      sub.map((a) => a.id).sort().join(","),
    );
  }

  // Group cohorts whose member sets are identical — one hypothesis wearing
  // several names. Only groups at/above the gate matter for the correction.
  const bySignature = new Map<string, string[]>();
  for (const def of defs) {
    const sub = members.get(def.key)!;
    if (sub.length < COHORT_MIN_SAMPLE) continue;
    const sig = signatures.get(def.key)!;
    bySignature.set(sig, [...(bySignature.get(sig) ?? []), def.key]);
  }

  const aliasOf = new Map<string, string[]>();
  const confounds: ConfoundGroup[] = [];
  for (const [sig, keys] of bySignature) {
    if (keys.length < 2) continue;
    const n = sig ? sig.split(",").length : 0;
    confounds.push({
      keys,
      n,
      note:
        `These ${keys.length} cohorts select the identical ${n} arrows, so they are one ` +
        `hypothesis, not ${keys.length}. No test here can tell them apart — separating ` +
        `them needs arrows that vary one condition while holding the others fixed.`,
    });
    for (const k of keys) aliasOf.set(k, keys.filter((other) => other !== k));
  }

  // One representative per alias group enters the correction family, so the
  // count of tests reflects hypotheses rather than labels.
  const representatives = new Set<string>();
  for (const keys of bySignature.values()) representatives.add(keys[0]);

  const family = defs.filter((d) => representatives.has(d.key));
  const familyPvalues = family.map((d) => {
    const { hits, n } = statBlock(members.get(d.key)!);
    return binomialTestTwoSided(hits, n);
  });
  const survives = benjaminiHochberg(familyPvalues, COHORT_FDR);
  const survivorKeys = new Set(
    family.filter((_, i) => survives[i]).map((d) => d.key),
  );
  // A survivor's aliases survive with it — same arrows, same result.
  for (const key of [...survivorKeys]) {
    for (const alias of aliasOf.get(key) ?? []) survivorKeys.add(alias);
  }

  const cohorts: CohortStat[] = defs.map((def) => {
    const sub = members.get(def.key)!;
    const { hits, misses, n } = statBlock(sub);
    const ready = n >= COHORT_MIN_SAMPLE;
    const ci = wilsonInterval(hits, n);
    const ciExcludesNull = ready && (ci.lo > NULL_HIT_RATE || ci.hi < NULL_HIT_RATE);
    return {
      key: def.key,
      label: def.label,
      dimension: def.dimension,
      hits,
      misses,
      n,
      ready,
      needed: COHORT_MIN_SAMPLE,
      ...(ready
        ? {
            pct: round1((hits / n) * 100),
            ci: { lo: round1(ci.lo * 100), hi: round1(ci.hi * 100) },
            p_value: binomialTestTwoSided(hits, n),
          }
        : {}),
      survives_correction: survivorKeys.has(def.key),
      ci_excludes_null: ciExcludesNull,
      aliases: aliasOf.get(def.key) ?? [],
    };
  });

  cohorts.sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1));

  // ONE ENTRY PER HYPOTHESIS. `cohorts` lists every label, so an alias group
  // appears in it several times — but `type:drift` and `market:closed` being
  // the same 96 arrows is one finding, not two. Reporting "5 exploratory" for
  // 4 distinct hypotheses would be the same over-count this module exists to
  // prevent, so both headline lists are restricted to the representatives that
  // actually entered the correction. Each entry carries `aliases`, so nothing
  // is hidden — it's just no longer counted twice.
  const isRepresentative = (c: CohortStat) => representatives.has(c.key);
  const validated = cohorts.filter((c) => c.survives_correction && isRepresentative(c));
  const exploratory = cohorts.filter(
    (c) =>
      !c.survives_correction && c.ready && (c.p_value ?? 1) < 0.05 && isRepresentative(c),
  );

  // Leading candidate = highest observed rate among cohorts that at least
  // cleared the sample gate. Sizing it tells us what "keep collecting" costs.
  const ranked = cohorts.filter((c) => c.ready && (c.pct ?? 0) > NULL_HIT_RATE * 100);
  const leader = ranked[0];
  const power: CohortAnalysis["power"] = leader
    ? (() => {
        const required = requiredSampleSize(leader.pct! / 100);
        return {
          leading_cohort: leader.key,
          observed_pct: leader.pct,
          n_now: leader.n,
          n_required: Number.isFinite(required) ? required : undefined,
          n_more: Number.isFinite(required) ? Math.max(0, required - leader.n) : undefined,
        };
      })()
    : {};

  const verdict: CohortAnalysis["verdict"] =
    !overallReady ? "insufficient_data"
    : validated.length > 0 ? "edge_detected"
    : "no_validated_edge";

  return {
    version: COHORT_STATS_VERSION,
    window_basis: opts.windowMs ? "rolling_7d" : "all_time",
    graded: graded.length,
    overall,
    cohorts,
    tests_run: family.length,
    validated,
    exploratory,
    confounds,
    power,
    verdict,
  };
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}
