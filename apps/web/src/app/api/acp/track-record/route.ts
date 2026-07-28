/**
 * ACP: Blue Hood track record (0.2) — receipts free, headline gated.
 *
 * The 0.1 /api/acp/arrows already returns the arrow feed. This 0.2 endpoint
 * draws the line the spec asks for, in ONE machine-readable contract:
 *
 *   • receipts — every graded arrow with its outcome (HIT / MISS / VOID) and
 *     the raw graded_breakdown counts. Returned FREELY and always. This is the
 *     product: the evidence. Anyone may recompute a hit-rate from it — that's
 *     their right. VOID stays visible (honest evidence, never filtered out).
 *
 *   • headline — the CALCULATED numbers that bear our name: hit_rate %, per-type
 *     %, and the record curve. These pass through hit-rate-gate.ts. Below the
 *     sample threshold they return {ready:false, graded:N, needed:M} and NO
 *     percentage. We don't publish a headline our sample hasn't earned.
 *
 *   • meta — version + machine-readable grading rules (+ their doc URL) so an
 *     agent can understand exactly how each outcome was decided.
 *
 * NOTE the pct_internal field (always-computed, internal audit only) is
 * deliberately stripped here — it must never leak while the gate says not-ready.
 */
import { NextRequest } from "next/server";
import { acpEnvelope, clientIp, corsHeaders, preflight, rateLimit } from "@/lib/acp";
import { readPublicArrows, arrowsFiredToday } from "@/lib/blue-hood/public-feed";
import {
  computeHitRate,
  computeRecordCurve,
  gradingRulesMeta,
  GRADING_RULES_URL,
  TRACK_RECORD_API_VERSION,
  type HitRatePerTypeStats,
  type PerType,
} from "@/lib/blue-hood/hit-rate-gate";

export const runtime = "nodejs";

export async function OPTIONS() {
  return preflight();
}

/** Public aggregate shape — `sample` renamed to `graded`, per the 0.2 contract. */
type PublicAggregate =
  | { ready: true; pct: number; graded: number }
  | { ready: false; graded: number; needed: number };

/** Public per-type shape — pct only when ready, pct_internal never present. */
interface PublicPerTypeStats {
  ready: boolean;
  graded: number;
  hits: number;
  misses: number;
  voided: number;
  informational_count: number;
  pct?: number;
  needed: number;
}

/** Strip pct_internal + rename sample→graded for every per-type bucket. */
function sanitizePerType(perType: PerType): Record<string, PublicPerTypeStats> {
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

export async function GET(req: NextRequest) {
  const rl = rateLimit(clientIp(req));
  if (!rl.ok) {
    return Response.json(
      { error: "rate_limited", retry_after_s: rl.retry_after_s },
      { status: 429, headers: { ...corsHeaders(), "Retry-After": String(rl.retry_after_s) } },
    );
  }

  const url = new URL(req.url);
  const limit = Math.min(
    200,
    Math.max(1, parseInt(url.searchParams.get("limit") ?? "100", 10) || 100),
  );

  const arrows = await readPublicArrows(limit);
  const { hit_rate, per_type, graded_breakdown } = computeHitRate(arrows);
  const record_curve = computeRecordCurve(arrows);

  // Rename sample→graded on the aggregate. `sample` is the internal name; the
  // public contract calls it `graded` (the count of hit+miss that "counts").
  const publicHitRate: PublicAggregate = hit_rate.ready
    ? { ready: true, pct: hit_rate.pct, graded: hit_rate.sample }
    : { ready: false, graded: hit_rate.sample, needed: hit_rate.needed };

  // Same rename on the record curve's not-ready branch.
  const publicCurve = record_curve.ready
    ? {
        basis: record_curve.basis,
        ready: true as const,
        graded: record_curve.sample,
        final: record_curve.final,
        peak: record_curve.peak,
        trough: record_curve.trough,
        points: record_curve.points,
      }
    : {
        basis: record_curve.basis,
        ready: false as const,
        graded: record_curve.sample,
        needed: record_curve.needed,
      };

  return Response.json(
    acpEnvelope(
      {
        receipts: {
          // Every public arrow, VOID included — the evidence, returned freely.
          arrows,
          arrows_today: arrowsFiredToday(arrows),
          // Raw counts are receipts-level (derivable from `arrows`), so free.
          graded_breakdown,
        },
        headline: {
          // Calculated fields — gated. Below threshold: {ready:false,graded,needed}.
          hit_rate: publicHitRate,
          per_type: sanitizePerType(per_type),
          record_curve: publicCurve,
        },
        meta: {
          api_version: TRACK_RECORD_API_VERSION,
          grading_rules_url: GRADING_RULES_URL,
          grading: gradingRulesMeta(),
        },
      },
      "https://blueagent.dev/docs/blue-hood#grading",
    ),
    { status: 200, headers: corsHeaders() },
  );
}
