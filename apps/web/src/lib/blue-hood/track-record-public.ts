/**
 * Blue Hood — the ONE assembly of the public, gated track record.
 *
 * WHY THIS FILE: the 0.2 `/api/acp/track-record` endpoint drew the line between
 * FREE receipts and GATED headline, inline. Now three more public surfaces need
 * the exact same shape:
 *   • /track            — the public track-record page (SEO, no wallet)
 *   • /track OG image    — headline card for social unfurls
 *   • /share/arrow OG    — per-arrow card (reuses the gate for the aggregate)
 *
 * If each re-implemented the sanitize (strip `pct_internal`, rename
 * `sample`→`graded`, gate the curve) they WOULD drift — the exact failure
 * `hit-rate-gate.ts` was created to end. So the sanitize lives here once, and
 * the ACP endpoint + every page call `buildPublicTrackRecord()`.
 *
 * The gate is preserved verbatim: below the sample threshold NO percentage is
 * emitted (not `pct`, never `pct_internal`) — only `{ready:false, graded, needed}`.
 */
import type { Arrow } from "@/lib/blue-hood/types";
import { readPublicArrows, arrowsFiredToday } from "@/lib/blue-hood/public-feed";
import {
  computeHitRate,
  computeRecordCurve,
  gradingRulesMeta,
  GRADING_RULES_URL,
  TRACK_RECORD_API_VERSION,
  type HitRateComputed,
  type HitRatePerTypeStats,
  type PerType,
  type RecordCurvePoint,
} from "@/lib/blue-hood/hit-rate-gate";

// ── Public shapes (pct_internal never present; `sample` renamed `graded`) ─────

/** Aggregate hit-rate. `pct` present only when the gate says ready. */
export type PublicAggregate =
  | { ready: true; pct: number; graded: number }
  | { ready: false; graded: number; needed: number };

/** Per-type bucket — pct only when that type cleared its own gate. */
export interface PublicPerTypeStats {
  ready: boolean;
  graded: number;
  hits: number;
  misses: number;
  voided: number;
  informational_count: number;
  pct?: number;
  needed: number;
}

/** Cumulative HIT−MISS walk — points only when the aggregate gate is ready. */
export type PublicRecordCurve =
  | {
      basis: "cumulative_hit_minus_miss";
      ready: true;
      graded: number;
      final: number;
      peak: number;
      trough: number;
      points: RecordCurvePoint[];
    }
  | {
      basis: "cumulative_hit_minus_miss";
      ready: false;
      graded: number;
      needed: number;
    };

/** The full 0.2 body — receipts (free) + headline (gated) + meta. */
export interface PublicTrackRecord {
  receipts: {
    /** Every public arrow, VOID + open included — the evidence, returned freely. */
    arrows: Arrow[];
    arrows_today: number;
    graded_breakdown: HitRateComputed["graded_breakdown"];
  };
  headline: {
    hit_rate: PublicAggregate;
    per_type: Record<string, PublicPerTypeStats>;
    record_curve: PublicRecordCurve;
  };
  meta: {
    api_version: string;
    grading_rules_url: string;
    grading: ReturnType<typeof gradingRulesMeta>;
  };
}

// ── Sanitizers ───────────────────────────────────────────────────────────────

/** Strip `pct_internal` + rename `sample`→`graded` for every per-type bucket. */
export function sanitizePerType(perType: PerType): Record<string, PublicPerTypeStats> {
  const out: Record<string, PublicPerTypeStats> = {};
  for (const [type, s] of Object.entries(perType)) {
    const v = s as HitRatePerTypeStats;
    out[type] = {
      ready: v.ready,
      graded: v.sample,
      hits: v.hits,
      misses: v.misses,
      voided: v.voided,
      informational_count: v.informational_count,
      needed: v.needed,
      ...(v.ready && v.pct !== undefined ? { pct: v.pct } : {}),
    };
  }
  return out;
}

// ── Build ────────────────────────────────────────────────────────────────────

/**
 * Assemble the public track record from an already-filtered public arrow list.
 * Pure — takes `arrows` (engine-origin, non-test) + an optional clock. Every
 * consumer that has the arrows in hand (or wants a deterministic test) calls
 * this; only `getPublicTrackRecord` below touches KV.
 */
export function buildPublicTrackRecord(
  arrows: Arrow[],
  now: number = Date.now(),
): PublicTrackRecord {
  const { hit_rate, per_type, graded_breakdown } = computeHitRate(arrows, now);
  const record_curve = computeRecordCurve(arrows, now);

  // Rename sample→graded on the aggregate (the public contract calls the
  // hit+miss count `graded`, not `sample`).
  const publicHitRate: PublicAggregate = hit_rate.ready
    ? { ready: true, pct: hit_rate.pct, graded: hit_rate.sample }
    : { ready: false, graded: hit_rate.sample, needed: hit_rate.needed };

  const publicCurve: PublicRecordCurve = record_curve.ready
    ? {
        basis: record_curve.basis,
        ready: true,
        graded: record_curve.sample,
        final: record_curve.final,
        peak: record_curve.peak,
        trough: record_curve.trough,
        points: record_curve.points,
      }
    : {
        basis: record_curve.basis,
        ready: false,
        graded: record_curve.sample,
        needed: record_curve.needed,
      };

  return {
    receipts: {
      arrows,
      arrows_today: arrowsFiredToday(arrows, now),
      graded_breakdown,
    },
    headline: {
      hit_rate: publicHitRate,
      per_type: sanitizePerType(per_type),
      record_curve: publicCurve,
    },
    meta: {
      api_version: TRACK_RECORD_API_VERSION,
      grading_rules_url: GRADING_RULES_URL,
      grading: gradingRulesMeta(),
    },
  };
}

/**
 * KV-backed convenience: read the newest public arrows (the trust-boundary
 * filter lives in `readPublicArrows`) and assemble the gated track record.
 * `limit` is clamped 1..200 to match the ACP endpoint.
 */
export async function getPublicTrackRecord(limit = 100): Promise<PublicTrackRecord> {
  const capped = Math.min(200, Math.max(1, limit || 100));
  const arrows = await readPublicArrows(capped);
  return buildPublicTrackRecord(arrows);
}
