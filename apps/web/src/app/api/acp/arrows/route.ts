/**
 * ACP wrapper: Blue Hood arrows feed (public track record).
 *
 * Public GET. Reads the same filtered arrow feed the drift-board UI
 * reads, wrapped in the ACP envelope.
 *
 * ⚠ This header used to claim it "reuses /api/hood/arrows server-side to avoid
 * duplicating the origin/test filter (single source of truth for what's
 * public)". It did no such thing — it carried its own hand-written copy of the
 * predicate, directly beneath a comment asserting it didn't. Fixed 2026-08-27:
 * the filter now genuinely comes from `readPublicArrowsProbe`, and the read
 * goes through the hydrated blob (#148 ②) so one GET costs 1 KV command
 * instead of ~151.
 */
import { NextRequest } from "next/server";
import { readPublicArrowsProbe } from "@/lib/blue-hood/public-feed";
import { acpEnvelope, clientIp, corsHeaders, preflight, rateLimit } from "@/lib/acp";
import { computeHitRate } from "@/lib/blue-hood/hit-rate-gate";

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
  const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get("limit") ?? "50", 10) || 50));

  // ACP is public — same filter as /api/hood/arrows, and now literally the
  // same code (`isPublicArrow`, applied inside `readPublicArrowsProbe`).
  const feed = await readPublicArrowsProbe(limit);

  // ACP consumers are agents that will store whatever we return. Handing them
  // `arrows: []` off a dead database would write a false zero into someone
  // else's system, where we can never correct it. 503 is the only honest answer.
  if (feed.status === "unavailable") {
    return Response.json(
      { error: "kv_error", detail: `Arrow feed unavailable — ${feed.reason}. Track record is UNKNOWN, not zero.` },
      { status: 503, headers: { ...corsHeaders(), "Cache-Control": "no-store" } },
    );
  }

  const arrows = feed.arrows;

  // P3.2 — shared gate with /api/hood/arrows so ACP consumers see the same
  // headline the UI shows. Aggregate needs 30 valid; per_type (arb / drift)
  // needs 15 own samples before its `pct` is populated. VOID excluded from
  // denominators everywhere.
  const { hit_rate, per_type } = computeHitRate(arrows);

  return Response.json(
    acpEnvelope(
      {
        arrows,
        arrows_today: arrows.filter((a) => new Date(a.fired_at).getTime() >= Date.now() - 24 * 3_600 * 1000).length,
        hit_rate,
        per_type,
      },
      "https://blueagent.dev/hood/arrows",
    ),
    { status: 200, headers: corsHeaders() },
  );
}
