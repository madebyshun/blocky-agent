/**
 * Blue Hood — per-user alert watchlist CRUD.
 *
 * Thin HTTP skin over `lib/blue-hood/watchlist.ts`, which owns ALL the rules
 * (validation, dedupe, cap policy, the symmetric reverse-index dual-write). This
 * route holds no business logic on purpose: the Telegram bot (2.2) and the alert
 * cron (2.1) import the same lib directly, so keeping logic out of the route is
 * what lets web + bot stay in lockstep instead of drifting apart.
 *
 * Public read/write — no secret. It only touches a wallet's own list of public
 * RWA tickers (no wallet balances, no keys), so the board can call it with just
 * the connected address. Tier gating is NOT applied here yet: `blueBalance` is
 * omitted until 1.1 WalletProvider can supply it, so everyone resolves to the
 * free tier and, with enforcement off, nothing blocks.
 */
import { NextResponse } from "next/server";
import { addTicker, removeTicker, getWatchlist } from "@/lib/blue-hood/watchlist";
import type { AlertKind } from "@/lib/blue-hood/watchlist";
import { parseHoodChain } from "@/lib/blue-hood/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

/** GET /api/hood/watchlist?address=0x… → the wallet's watchlist (empty default if none). */
export async function GET(req: Request) {
  const address = new URL(req.url).searchParams.get("address");
  if (!address) {
    return NextResponse.json({ ok: false, error: "address query param required" }, { status: 400, headers: NO_STORE });
  }
  const watchlist = await getWatchlist(address);
  return NextResponse.json({ ok: true, watchlist }, { headers: NO_STORE });
}

/**
 * POST /api/hood/watchlist { address, ticker, chain?, kinds? } → add a watch.
 *
 * `chain` is optional ON THE WIRE and absent ⟹ "robinhood" inside `addTicker`,
 * which is what every client sent before the Base desk existed. It is parsed,
 * not cast: an unrecognised value becomes `undefined` (⟹ robinhood, the
 * documented default) rather than being written into a KV key.
 */
export async function POST(req: Request) {
  let body: { address?: string; ticker?: string; chain?: unknown; kinds?: AlertKind[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400, headers: NO_STORE });
  }
  if (!body.address || !body.ticker) {
    return NextResponse.json({ ok: false, error: "address and ticker are required" }, { status: 400, headers: NO_STORE });
  }

  const res = await addTicker(body.address, body.ticker, {
    chain: parseHoodChain(body.chain),
    kinds: body.kinds,
  });
  if (!res.ok) {
    // bad_address / bad_ticker → 400; at_cap → 409 (a limit, not a malformed request).
    const status = res.error.code === "at_cap" ? 409 : 400;
    return NextResponse.json({ ok: false, error: res.error.message, code: res.error.code }, { status, headers: NO_STORE });
  }
  return NextResponse.json(
    { ok: true, watchlist: res.watchlist, added: res.added, decision: res.decision },
    { headers: NO_STORE },
  );
}

/** DELETE /api/hood/watchlist { address, ticker, chain? } → remove a watch
 *  (symmetric prune). `chain` is parsed and defaulted EXACTLY as in POST — if
 *  the two disagreed, un-starring would leave the reverse set populated and the
 *  user would keep receiving DMs they had cancelled. */
export async function DELETE(req: Request) {
  let body: { address?: string; ticker?: string; chain?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400, headers: NO_STORE });
  }
  if (!body.address || !body.ticker) {
    return NextResponse.json({ ok: false, error: "address and ticker are required" }, { status: 400, headers: NO_STORE });
  }

  const res = await removeTicker(body.address, body.ticker, { chain: parseHoodChain(body.chain) });
  if (!res.ok) {
    return NextResponse.json({ ok: false, error: res.error.message, code: res.error.code }, { status: 400, headers: NO_STORE });
  }
  return NextResponse.json({ ok: true, watchlist: res.watchlist, removed: res.removed }, { headers: NO_STORE });
}
