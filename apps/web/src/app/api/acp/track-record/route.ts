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
 * The receipts/headline/meta assembly (and the sanitize that strips the
 * internal pct + gates the curve) lives in `track-record-public.ts` so this
 * endpoint and the public /track page + OG cards are byte-identical — the same
 * anti-drift discipline hit-rate-gate.ts enforces on the aggregation itself.
 */
import { NextRequest } from "next/server";
import { acpEnvelope, clientIp, corsHeaders, preflight, rateLimit } from "@/lib/acp";
import { getPublicTrackRecord } from "@/lib/blue-hood/track-record-public";

export const runtime = "nodejs";

export async function OPTIONS() {
  return preflight();
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

  const trackRecord = await getPublicTrackRecord(limit);

  return Response.json(
    acpEnvelope(trackRecord, "https://blueagent.dev/docs/blue-hood#grading"),
    { status: 200, headers: corsHeaders() },
  );
}
