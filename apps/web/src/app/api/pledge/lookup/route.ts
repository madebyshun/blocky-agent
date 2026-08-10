/**
 * GET /api/pledge/lookup?address=0x…
 *
 * "Did my pledge land?" — the single question this whole site exists to answer,
 * given its own endpoint so a holder can check one address without loading or
 * scrolling the full ledger.
 *
 * `found: false` is an ANSWER, not an error: it means no Transfer from that
 * address into the receiving wallet was seen. It is returned with 200 and,
 * critically, alongside `stale` and `degraded` — because "we couldn't read the
 * chain" and "you didn't send anything" are the same screen to a worried holder
 * unless the response distinguishes them.
 */
import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { getLedger, lookupWallet } from "@/lib/pledge/ledger";
import { rateLimit, getIdentifier } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const address = new URL(req.url).searchParams.get("address")?.trim() ?? "";

  if (!address) {
    return NextResponse.json({ error: "address query parameter is required" }, { status: 400 });
  }
  if (!isAddress(address)) {
    return NextResponse.json({ error: "not a valid EVM address" }, { status: 400 });
  }

  const rl = await rateLimit(getIdentifier(req), "api");
  if (!rl.success) {
    return NextResponse.json(
      { error: "rate limited", reset: rl.reset },
      { status: 429, headers: { "Retry-After": String(Math.ceil((rl.reset - Date.now()) / 1000)) } },
    );
  }

  const snap = await getLedger();
  return NextResponse.json(lookupWallet(snap, address), {
    headers: { "Cache-Control": "public, max-age=15, stale-while-revalidate=120" },
  });
}
