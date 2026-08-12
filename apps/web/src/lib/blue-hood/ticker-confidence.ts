/**
 * Blue Hood — Drift Statistics v0: per-ticker rolling confidence.
 *
 * Premise, measured not assumed: signal quality varies by TICKER, not by how
 * big the gap was. Raising the shared `DRIFT_MIN_ABS_PCT` floor was tested
 * against the record and makes things worse (2.5% → 45%, 3.0% → 54%, 4.0% →
 * 33%, vs a 55% baseline), and per-ticker medians all cluster at 2.1–2.9%, so
 * gap size does not separate the good tickers from the bad ones. Ticker does.
 *
 * ── Why the bar is this high ────────────────────────────────────────────
 * A per-ticker rate is a cohort chosen AFTER looking at the data, which is
 * exactly the setup where a naive threshold manufactures an edge out of
 * noise. `cohort-stats.ts` already carries the machinery and the warning for
 * this; we honour the same standard here:
 *
 *   1. n ≥ CONFIDENCE_MIN_SAMPLE (the existing COHORT_MIN_SAMPLE), and
 *   2. the Wilson UPPER bound must sit below 50%.
 *
 * (2) is the load-bearing one. A point estimate under 40% sounds decisive but
 * isn't: at the time of writing BABA sat at 17% over n=12 with a 95% interval
 * of [5%, 45%] — an interval whose top end is ABOVE the 40% line anyone would
 * have drawn. The data could not distinguish "BABA is bad" from "BABA is
 * ordinary". Requiring the whole interval to clear a coin flip is what makes
 * "this ticker is worse than chance" a claim rather than a guess.
 *
 * On the record as it stands this matches ZERO tickers, and that is the
 * correct output — no ticker has even reached n=15 yet, and a
 * Benjamini-Hochberg pass over all 20 tickers returns nothing significant.
 * The gate is live and inert; it starts biting on its own as sample
 * accumulates, with no redeploy.
 *
 * ── Why low-confidence arrows still FIRE ────────────────────────────────
 * A gate that stops a ticker from firing also stops it from ever being
 * graded again, which freezes its rolling window at the moment it was
 * condemned — the ticker can never earn its way back. So a flagged arrow is
 * still fired and still graded (the window keeps refreshing); what it loses
 * is the alert fan-out, the surface where a noisy signal actually costs a
 * user something. It stays in the public feed and in the published hit rate:
 * quietly dropping the losers out of a number we publish would be
 * cherry-picking, whatever the rule.
 *
 * Pure + deterministic. Every number is computed in code; no LLM.
 */
import { kvGet, kvSet } from "@/lib/kv";
import { KV_TICKER_CONFIDENCE } from "./kv-keys";
import { readPublicArrows } from "./public-feed";
import { wilsonInterval, isGraded, COHORT_MIN_SAMPLE } from "./cohort-stats";
import type { Arrow, ArrowType } from "./types";

export const TICKER_CONFIDENCE_VERSION = "0.1.0";

/** Rolling window: only the most recent N graded arrows per key count. */
export const CONFIDENCE_WINDOW = 30;

/** Matches the existing cohort gate so the two can't disagree on "enough". */
export const CONFIDENCE_MIN_SAMPLE = COHORT_MIN_SAMPLE;

/** The Wilson upper bound must clear a coin flip before we flag a ticker. */
export const CONFIDENCE_MAX_WILSON_UPPER = 0.5;

/** How many feed entries to scan when recomputing. */
const READ_DEPTH = 300;

/** Recompute at most this often, even if grading happened (KV cost guard). */
export const CONFIDENCE_MIN_REFRESH_MS = 60 * 60 * 1000;

/** Recompute at least this often, so a schema change can't leave a stale blob. */
export const CONFIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type ConfidenceLevel = "normal" | "low" | "insufficient";

export interface TickerConfidenceEntry {
  /** `AAPL` for the ticker-wide entry, `AAPL:drift` for the per-type one. */
  key: string;
  ticker: string;
  type: ArrowType | null;
  n: number;
  hits: number;
  /** 0–100, rounded. Only meaningful once `n >= CONFIDENCE_MIN_SAMPLE`. */
  pct: number;
  wilson_low: number;
  wilson_high: number;
  level: ConfidenceLevel;
}

export interface TickerConfidenceTable {
  version: string;
  computed_at: string;
  window: number;
  min_sample: number;
  max_wilson_upper: number;
  /** Keyed by `TickerConfidenceEntry.key`. */
  entries: Record<string, TickerConfidenceEntry>;
  /** How many entries came back `low` — expected to be 0 for a long while. */
  low_count: number;
  /** Graded arrows the table was built from. */
  sample_total: number;
}

/** What gets stamped onto an arrow at fire time. A fire-time fact — never
 *  recomputed later, for the same reason `snapshot_at_fire` isn't. */
export interface ArrowTickerConfidence {
  level: ConfidenceLevel;
  /** Which entry decided it. `none` = no entry had enough sample. */
  basis: "ticker_type" | "ticker" | "none";
  n: number;
  hits: number;
  wilson_high: number | null;
  computed_at: string | null;
}

// ── Computation ────────────────────────────────────────────────────────────

function classify(hits: number, n: number): { level: ConfidenceLevel; lo: number; hi: number } {
  const { lo, hi } = wilsonInterval(hits, n);
  if (n < CONFIDENCE_MIN_SAMPLE) return { level: "insufficient", lo, hi };
  return { level: hi < CONFIDENCE_MAX_WILSON_UPPER ? "low" : "normal", lo, hi };
}

/**
 * Build the table from a list of arrows. Pure — `arrows` should already be
 * trust-filtered (engine origin, non-test); `readPublicArrows` does that.
 *
 * Both a ticker-wide and a per-(ticker,type) entry are produced. The gate
 * prefers the per-type entry when it has enough sample and falls back to the
 * ticker-wide one otherwise: the most specific evidence that clears the bar
 * wins. At current volume the ticker-wide entry is the one that will reach
 * n=15 first, which is why it exists at all.
 */
export function computeTickerConfidence(
  arrows: Arrow[],
  now: number = Date.now(),
): TickerConfidenceTable {
  const graded = arrows.filter(isGraded);
  // Newest-first so `slice(0, WINDOW)` keeps the most recent N. The feed is
  // already newest-first, but sort explicitly rather than trusting order.
  const sorted = [...graded].sort(
    (a, b) => new Date(b.graded_at ?? b.fired_at).getTime() - new Date(a.graded_at ?? a.fired_at).getTime(),
  );

  const buckets = new Map<string, { ticker: string; type: ArrowType | null; arrows: Arrow[] }>();
  const push = (key: string, ticker: string, type: ArrowType | null, a: Arrow) => {
    const b = buckets.get(key) ?? { ticker, type, arrows: [] };
    b.arrows.push(a);
    buckets.set(key, b);
  };
  for (const a of sorted) {
    push(a.ticker, a.ticker, null, a);
    push(`${a.ticker}:${a.type}`, a.ticker, a.type, a);
  }

  const entries: Record<string, TickerConfidenceEntry> = {};
  let low_count = 0;
  for (const [key, b] of buckets) {
    const win = b.arrows.slice(0, CONFIDENCE_WINDOW);
    const n = win.length;
    const hits = win.filter((a) => a.outcome === "hit").length;
    const { level, lo, hi } = classify(hits, n);
    if (level === "low") low_count++;
    entries[key] = {
      key,
      ticker: b.ticker,
      type: b.type,
      n,
      hits,
      pct: n > 0 ? Math.round((hits / n) * 100) : 0,
      wilson_low: Number(lo.toFixed(4)),
      wilson_high: Number(hi.toFixed(4)),
      level,
    };
  }

  return {
    version: TICKER_CONFIDENCE_VERSION,
    computed_at: new Date(now).toISOString(),
    window: CONFIDENCE_WINDOW,
    min_sample: CONFIDENCE_MIN_SAMPLE,
    max_wilson_upper: CONFIDENCE_MAX_WILSON_UPPER,
    entries,
    low_count,
    sample_total: graded.length,
  };
}

/** Resolve the stamp for a (ticker, type) about to fire. */
export function confidenceForFire(
  table: TickerConfidenceTable | null,
  ticker: string,
  type: ArrowType,
): ArrowTickerConfidence {
  const none: ArrowTickerConfidence = {
    level: "insufficient", basis: "none", n: 0, hits: 0, wilson_high: null, computed_at: table?.computed_at ?? null,
  };
  if (!table) return none;
  const specific = table.entries[`${ticker}:${type}`];
  const wide = table.entries[ticker];
  const chosen =
    specific && specific.level !== "insufficient" ? { e: specific, basis: "ticker_type" as const }
    : wide && wide.level !== "insufficient" ? { e: wide, basis: "ticker" as const }
    : null;
  if (!chosen) {
    // Nothing has enough sample — report the widest count we do have, so the
    // log shows how far off the bar this ticker is rather than a bare zero.
    const fallback = wide ?? specific;
    return fallback
      ? { level: "insufficient", basis: "none", n: fallback.n, hits: fallback.hits, wilson_high: fallback.wilson_high, computed_at: table.computed_at }
      : none;
  }
  return {
    level: chosen.e.level,
    basis: chosen.basis,
    n: chosen.e.n,
    hits: chosen.e.hits,
    wilson_high: chosen.e.wilson_high,
    computed_at: table.computed_at,
  };
}

// ── KV access ──────────────────────────────────────────────────────────────

/** One KV read. The engine calls this once per cycle, never per candidate —
 *  recomputing from the feed on every cycle would be ~600 reads × 288
 *  cycles/day, which is how the engine died once already (Upstash cap). */
export async function getTickerConfidence(): Promise<TickerConfidenceTable | null> {
  return await kvGet<TickerConfidenceTable>(KV_TICKER_CONFIDENCE);
}

export interface RefreshResult {
  refreshed: boolean;
  reason: "graded" | "stale" | "missing" | "throttled" | "not_needed";
  low_count: number;
  sample_total: number;
  eligible: number;
}

/**
 * Recompute the table when it can actually have changed — the rate only moves
 * when the grader closes an arrow — subject to a 1h floor and a 24h ceiling.
 * Costs ~READ_DEPTH KV reads when it runs, so the throttle is the point.
 */
export async function refreshTickerConfidence(opts: { graded: number }): Promise<RefreshResult> {
  const existing = await getTickerConfidence();
  const now = Date.now();
  const ageMs = existing ? now - new Date(existing.computed_at).getTime() : Infinity;

  let reason: RefreshResult["reason"];
  if (!existing) reason = "missing";
  else if (ageMs >= CONFIDENCE_MAX_AGE_MS) reason = "stale";
  else if (opts.graded > 0 && ageMs >= CONFIDENCE_MIN_REFRESH_MS) reason = "graded";
  else if (opts.graded > 0) reason = "throttled";
  else reason = "not_needed";

  if (reason === "throttled" || reason === "not_needed") {
    return {
      refreshed: false,
      reason,
      low_count: existing?.low_count ?? 0,
      sample_total: existing?.sample_total ?? 0,
      eligible: existing ? countEligible(existing) : 0,
    };
  }

  const arrows = await readPublicArrows(READ_DEPTH);
  const table = computeTickerConfidence(arrows, now);
  await kvSet(KV_TICKER_CONFIDENCE, table);
  const eligible = countEligible(table);
  console.log(
    `[ticker-confidence] refreshed reason=${reason} sample=${table.sample_total}` +
      ` entries=${Object.keys(table.entries).length} eligible=${eligible} low=${table.low_count}`,
  );
  return { refreshed: true, reason, low_count: table.low_count, sample_total: table.sample_total, eligible };
}

/** Entries that have cleared the sample bar — i.e. are actually being judged.
 *  Watching this go from 0 upward is how we know the gate has woken up. */
function countEligible(t: TickerConfidenceTable): number {
  return Object.values(t.entries).filter((e) => e.level !== "insufficient").length;
}
