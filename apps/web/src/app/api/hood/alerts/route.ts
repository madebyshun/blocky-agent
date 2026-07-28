/**
 * Blue Hood — per-wallet alert feed (2.1 expose surface).
 *
 * Thin HTTP skin over `lib/blue-hood/alerts.ts`. Returns the recent
 * watchlist-targeted alerts for one wallet — the CHANNEL-AGNOSTIC records the
 * alert engine writes when an arrow fires for a ticker the wallet watches. The
 * Telegram bot (2.2) consumes the same records via the lib's pending-queue
 * drain; web push (later) reads THIS shape + a delivered.webpush cursor. This
 * route is the human/inspection read — no delivery side effects.
 *
 * Public read — no secret. It only exposes a wallet's own alerts for PUBLIC RWA
 * arrows (no balances, no keys), keyed by the connected address, mirroring the
 * watchlist route's trust model.
 */
import { NextResponse } from "next/server";
import { getAlertsForAddress } from "@/lib/blue-hood/alerts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

/** GET /api/hood/alerts?address=0x…&limit=50 → { ok, alerts } newest-first. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const address = url.searchParams.get("address");
  if (!address) {
    return NextResponse.json({ ok: false, error: "address query param required" }, { status: 400, headers: NO_STORE });
  }
  // Clamp limit to a sane window so a caller can't ask for the whole KV history.
  const rawLimit = Number(url.searchParams.get("limit") ?? 50);
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(100, Math.trunc(rawLimit))) : 50;

  const alerts = await getAlertsForAddress(address, limit);
  return NextResponse.json({ ok: true, alerts }, { headers: NO_STORE });
}
