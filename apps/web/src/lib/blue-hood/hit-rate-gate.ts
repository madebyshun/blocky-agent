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
  const cutoff = now - HIT_RATE_WINDOW_MS;
  const graded7d = arrows.filter(
    (a) => a.status === "graded" && a.graded_at && new Date(a.graded_at).getTime() >= cutoff,
  );

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
