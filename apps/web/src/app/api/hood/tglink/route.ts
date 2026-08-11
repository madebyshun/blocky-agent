/**
 * Blue Hood — Telegram wallet-link: mint a link code.
 *
 * Web side of the handshake defined in `lib/blue-hood/watchlist.ts`. The
 * connected wallet POSTs here; we mint a short-lived code (TTL 10m) and return
 * a `t.me/<bot>?start=link_<code>` DEEP LINK. The user taps it, hits Start, and
 * the bot's `/start link_<code>` handler (2.2b) consumes it via
 * `consumeTgLinkCode` — NO code to copy or type. We return the deep link built
 * server-side (never a bare code the UI has to render) so the /hood button is
 * one tap: "no wallet paste, no code typed". `link` is null when the bot
 * username env is unset — the client then shows "unavailable", never the code.
 * The manual `/link <code>` path still works as a fallback. Non-custodial: the
 * link stores only { address, tgUserId } — never a key. The tg id is a routing
 * handle for alerts, not an authz token for funds.
 *
 * v1 trust model: the route trusts the `address` in the body (proven by the
 * wagmi connection on the client). The code is returned ONLY to this caller, so
 * to consume it an attacker would need the code value. Worst case is receiving
 * another wallet's PUBLIC track-record alerts — no funds, no private data. When
 * wallet auth (SIWE) lands, this can require a signature to harden it.
 */
import { NextResponse } from "next/server";
import { issueTgLinkCode } from "@/lib/blue-hood/watchlist";
import { botDeepLink, BOT_USERNAME } from "@/lib/telegram/bot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

/** POST /api/hood/tglink { address } → { code, link, expiresAt } */
export async function POST(req: Request) {
  let body: { address?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400, headers: NO_STORE });
  }
  if (!body.address) {
    return NextResponse.json({ ok: false, error: "address is required" }, { status: 400, headers: NO_STORE });
  }

  const res = await issueTgLinkCode(body.address);
  if ("error" in res) {
    return NextResponse.json({ ok: false, error: res.error.message, code: res.error.code }, { status: 400, headers: NO_STORE });
  }
  // Build the deep link server-side so the UI never has to render a bare code.
  // Null when the bot username env is unset → client shows "unavailable".
  const link = BOT_USERNAME ? botDeepLink(`link_${res.code}`) : null;
  return NextResponse.json({ ok: true, code: res.code, link, expiresAt: res.expiresAt }, { headers: NO_STORE });
}
