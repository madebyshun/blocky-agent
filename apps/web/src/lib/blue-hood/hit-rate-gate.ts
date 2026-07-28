/**
 * Blue Hood — hit-rate aggregation + public-display gate.
 *
 * WHY THIS FILE: /api/hood/arrows and /api/acp/arrows previously each had
 * their own copy of the aggregation logic AND used slightly different
 * denominators (hood excluded VOID; acp included it). Both then had to
 * agree on the "warming up" gate constant. When we changed the gate, one
 * side drifted out of sync twice. This module owns:
 *
 *   1. What counts as a valid graded arrow (VOID + informational excluded).
 *   2. The public-display thresholds — aggregate and per-type.
 *   3. The response shape both APIs return + both UI clients consume.
 *
 * DISPLAY GATES (updated 2026-07-25 for P3.2):
 *   - AGGREGATE public display: ≥ 30 valid (hit + miss). Previously 10.
 *   - PER-TYPE public display: each type independently needs ≥ 15 valid
 *     of its own kind. `arb` and `drift` render only when their own
 *     bucket clears the bar; below that the type is `ready: false` even
 *     if the aggregate is ready.
 *
 * INTERNAL VISIBILITY: `per_type` is always populated — even when a type
 * hasn't cleared its own gate — so we (not the public) can see if arb is
 * systematically missing (nghi ngưỡng 0.5%/4h quá nghiêm hoặc arb đang
 * bắn vào spread không mean-revert). Look at `per_type[t].sample` and
 * `per_type[t].pct_internal` when auditing.
 */
import type { Arrow, ArrowType } from "./types";

// ── Configurable thresholds ─────────────────────────────────────────────────

export const HIT_RATE_WINDOW_MS = 7 * 24 * 3_600 * 1000;

/** Aggregate hit-rate is hidden publicly until this many valid arrows. */
export const HIT_RATE_MIN_SAMPLE_AGGREGATE = 30;

/** A given type's hit-rate is hidden publicly until this many valid arrows of that type. */
export const HIT_RATE_MIN_SAMPLE_PER_TYPE = 15;

// ── 0.2 track-record API contract ───────────────────────────────────────────

/** Version stamped into the track-record endpoint's `meta` so agents can pin it. */
export const TRACK_RECORD_API_VERSION = "0.2.0";

/** Human-readable grading rules. `#grading` anchor lives in docs/blue-hood. */
export const GRADING_RULES_URL = "https://blueagent.dev/docs/blue-hood#grading";

// ── Response shape ──────────────────────────────────────────────────────────

/** Aggregate stats. `ready` flips true only when sample ≥ AGGREGATE threshold. */
export type HitRateAggregate =
  | { ready: true;  pct: number; sample: number }
  | { ready: false; sample: number; needed: number };

/**
 * Per-type stats. Fields:
 *   - `sample`: valid graded of this type (excludes VOID + informational)
 *   - `hits`, `misses`, `voided`, `informational_count`
 *   - `pct`: hits / sample, ONLY set when `ready` (public consumers use this)
 *   - `pct_internal`: hits / sample, ALWAYS set (undefined only if sample=0);
 *      internal audit only — do NOT surface publicly when `ready:false`
 *   - `needed`: PER_TYPE threshold, echoed for UI "warming up · N/15"
 *   - `ready`: sample ≥ PER_TYPE threshold
 */
export interface HitRatePerTypeStats {
  ready: boolean;
  sample: number;
  hits: number;
  misses: number;
  voided: number;
  informational_count: number;
  pct?: number;
  pct_internal?: number;
  needed: number;
}

export type PerType = Partial<Record<ArrowType, HitRatePerTypeStats>>;

export interface HitRateComputed {
  hit_rate: HitRateAggregate;
  per_type: PerType;
  /** Aggregate breakdown of the 7d window — same fields /hood/arrows already returned. */
  graded_breakdown: {
    hits: number;
    misses: number;
    voided: number;
    informational: number;
    total_graded: number;
  };
}

// ── Compute ─────────────────────────────────────────────────────────────────

/**
 * The one true windowing filter: graded arrows whose `graded_at` falls inside
 * the last WINDOW_MS. Shared by computeHitRate + computeRecordCurve so the two
 * can never disagree on which arrows are "in window" (the exact drift this
 * module was created to kill).
 */
function gradedInWindow(arrows: Arrow[], now: number): Arrow[] {
  const cutoff = now - HIT_RATE_WINDOW_MS;
  return arrows.filter(
    (a) => a.status === "graded" && a.graded_at && new Date(a.graded_at).getTime() >= cutoff,
  );
}

function statsFor(arrows: Arrow[], threshold: number): HitRatePerTypeStats {
  const hits = arrows.filter((a) => a.outcome === "hit").length;
  const misses = arrows.filter((a) => a.outcome === "miss").length;
  const voided = arrows.filter((a) => a.outcome === "void").length;
  const informational_count = arrows.filter((a) => a.outcome === "informational").length;
  const sample = hits + misses;
  const ready = sample >= threshold;
  const pct_internal = sample > 0 ? Math.round((hits / sample) * 100) : undefined;
  return {
    ready,
    sample,
    hits,
    misses,
    voided,
    informational_count,
    pct: ready ? pct_internal : undefined,
    pct_internal,
    needed: threshold,
  };
}

/**
 * Given the already-filtered public arrow list, compute the aggregate +
 * per-type hit-rate for the last WINDOW_MS.
 *
 * `arrows` should already have engine/test/origin filtering applied — this
 * function's job is windowing + status filtering + gate application only.
 */
export function computeHitRate(
  arrows: Arrow[],
  now: number = Date.now(),
): HitRateComputed {
  const graded7d = gradedInWindow(arrows, now);

  const agg = statsFor(graded7d, HIT_RATE_MIN_SAMPLE_AGGREGATE);
  const hit_rate: HitRateAggregate = agg.ready
    ? { ready: true, pct: agg.pct!, sample: agg.sample }
    : { ready: false, sample: agg.sample, needed: HIT_RATE_MIN_SAMPLE_AGGREGATE };

  // Report per-type for the types we care about publicly. `flow`/`whale`
  // are informational-only in the current engine (they grade as
  // `informational` and never HIT/MISS), so we don't gate them here; the
  // per_type map still surfaces them so an internal reader sees the shape.
  const perTypeOut: PerType = {};
  const types: ArrowType[] = ["drift", "arb", "flow", "whale"];
  for (const t of types) {
    const bucket = graded7d.filter((a) => a.type === t);
    if (bucket.length === 0 && t !== "drift" && t !== "arb") continue; // skip empty non-gated types
    perTypeOut[t] = statsFor(bucket, HIT_RATE_MIN_SAMPLE_PER_TYPE);
  }

  return {
    hit_rate,
    per_type: perTypeOut,
    graded_breakdown: {
      hits: agg.hits,
      misses: agg.misses,
      voided: agg.voided,
      informational: agg.informational_count,
      total_graded: graded7d.length,
    },
  };
}

// ── Record curve (gated headline) ───────────────────────────────────────────

/**
 * HONESTY NOTE — why this is NOT an equity/PnL curve:
 * The `Arrow` type carries no per-arrow return or PnL (grading is
 * signal-accuracy only — see types.ts). A monetary "equity curve" would
 * therefore be fabricated, which the data-honesty rules forbid. So the curve
 * we publish is an explicit W/L walk: each graded HIT steps +1, each MISS −1,
 * VOID/informational contribute nothing. `basis` names this so no consumer can
 * mistake it for dollars.
 */
export interface RecordCurvePoint {
  /** graded_at of the arrow that produced this step (ISO 8601). */
  t: string;
  /** cumulative HIT−MISS after this arrow. */
  v: number;
}

export type RecordCurve =
  | {
      basis: "cumulative_hit_minus_miss";
      ready: true;
      sample: number;
      final: number;
      peak: number;
      trough: number;
      points: RecordCurvePoint[];
    }
  | {
      basis: "cumulative_hit_minus_miss";
      ready: false;
      sample: number;
      needed: number;
    };

/**
 * Cumulative HIT−MISS curve over the same 7d window as computeHitRate. Gated on
 * the AGGREGATE threshold — a headline shape, so it shares the aggregate gate.
 * Below threshold we return only `{ready:false, sample, needed}` (no points),
 * matching the "don't publish the headline until the sample earns it" rule.
 */
export function computeRecordCurve(
  arrows: Arrow[],
  now: number = Date.now(),
): RecordCurve {
  const graded = gradedInWindow(arrows, now)
    .filter((a) => a.outcome === "hit" || a.outcome === "miss")
    .sort(
      (a, b) => new Date(a.graded_at!).getTime() - new Date(b.graded_at!).getTime(),
    );

  const sample = graded.length;
  if (sample < HIT_RATE_MIN_SAMPLE_AGGREGATE) {
    return {
      basis: "cumulative_hit_minus_miss",
      ready: false,
      sample,
      needed: HIT_RATE_MIN_SAMPLE_AGGREGATE,
    };
  }

  let cum = 0;
  let peak = 0;
  let trough = 0;
  const points: RecordCurvePoint[] = graded.map((a) => {
    cum += a.outcome === "hit" ? 1 : -1;
    if (cum > peak) peak = cum;
    if (cum < trough) trough = cum;
    return { t: a.graded_at!, v: cum };
  });

  return {
    basis: "cumulative_hit_minus_miss",
    ready: true,
    sample,
    final: cum,
    peak,
    trough,
    points,
  };
}

// ── Machine-readable grading rules (endpoint `meta`) ─────────────────────────

/**
 * The grading rules an agent needs to trust (and re-derive) our numbers, in a
 * form it can read without scraping the docs page. Mirrors grader.ts exactly —
 * if a grading constant changes, change it here too.
 */
export function gradingRulesMeta() {
  return {
    version: TRACK_RECORD_API_VERSION,
    rules_url: GRADING_RULES_URL,
    window_days: HIT_RATE_WINDOW_MS / (24 * 3_600 * 1000),
    thresholds: {
      aggregate: HIT_RATE_MIN_SAMPLE_AGGREGATE,
      per_type: HIT_RATE_MIN_SAMPLE_PER_TYPE,
    },
    // Which wall/session clock each type is graded against. Chainlink oracle
    // freezes at the NYSE close, so drift/arb count only regular-session hours.
    clock: {
      drift: "nyse_regular_session_hours",
      arb: "nyse_regular_session_hours",
      flow: "wall_clock_hours",
    },
    outcomes: {
      drift:
        "HIT if the DEX↔oracle price gap closes ≥50% within grading_window_h NYSE regular-session hours; otherwise MISS.",
      arb:
        "HIT if the DEX↔oracle spread narrows below 0.5% within 4 NYSE regular-session hours; otherwise MISS.",
      flow: "Informational only — never graded HIT/MISS.",
      void:
        "Any drift/arb arrow graded before its regular-session window fully elapsed is VOID and excluded from hit-rate.",
    },
    excluded_from_hit_rate: ["void", "informational", "test", "seeded"],
  };
}
