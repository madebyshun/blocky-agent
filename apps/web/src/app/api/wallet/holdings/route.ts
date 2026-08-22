// GET /api/wallet/holdings?address=0x…&network=base|baseSepolia
//
// Full live token holdings for the Wallet portfolio table, via checkWallet()
// (Moralis `/wallets/{address}/tokens` — every non-zero, non-spam token, with
// usd_value already priced by Moralis; B20 tokens confirmed on-chain via the
// Factory.isB20() read). Falls back to a curated-majors RPC read (flagged
// `partial`) when MORALIS_API_KEY is absent.
//
// ZERO fabrication: usdValue is whatever Moralis returns (or omitted), never a
// guessed number. The client renders "—" for any token without a price.

import { NextResponse } from "next/server";
import { checkWallet } from "@/lib/wallet/holdings";

// Per-address wallet read — never cache across addresses.
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const u = new URL(req.url);
  const address = u.searchParams.get("address") ?? "";
  const network = u.searchParams.get("network") ?? "base";

  if (!/^0x[a-fA-F0-9]{40}$/.test(address))
    return NextResponse.json({ holdings: [], source: "rpc", partial: false, error: "invalid address" });

  try {
    const r = await checkWallet(address, network);
    return NextResponse.json({
      holdings:   r.holdings,
      source:     r.source,
      partial:    r.partial,
      explorer:   r.explorer,
      addressUrl: r.addressUrl,
      network:    r.network,
      error:      r.error,
      ts:         Date.now(),
    });
  } catch (e) {
    return NextResponse.json({ holdings: [], source: "rpc", partial: false, error: (e as Error).message });
  }
}
