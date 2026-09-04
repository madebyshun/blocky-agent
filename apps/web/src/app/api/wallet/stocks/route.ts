// GET /api/wallet/stocks?address=0x…
//
// Tokenized-stock holdings for the Wallet surface, on BOTH venues: Coinbase B20
// on Base 8453 and RHJ RWA tokens on Robinhood Chain 4663. The crypto table
// (/api/wallet/holdings) is Moralis-backed and Base-only; this is the equity
// leg it cannot see.
//
// Every row starts from a pinned registry address and is stamped with its chain
// — nothing is resolved by ticker, because NVDA/META/GOOGL/AAPL exist on both
// chains as different tokens. See lib/wallet/stock-holdings.ts for the rules.
//
// ZERO fabrication: an unpriced holding returns valueUsd:null plus the reason,
// and a chain we could not reach returns that leg as `status:"unavailable"`
// rather than an empty list.

import { NextResponse } from "next/server";
import { readStockHoldings } from "@/lib/wallet/stock-holdings";

// Per-address wallet read — never cache across addresses.
export const dynamic = "force-dynamic";
// The RH leg is an explorer round-trip plus per-holding price reads; the Base
// leg quotes each held ticker. Comfortably under this, but not under the 10s
// default on a cold pool.
export const maxDuration = 60;

export async function GET(req: Request) {
  const address = new URL(req.url).searchParams.get("address") ?? "";

  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return NextResponse.json({ address, legs: [], ts: Date.now(), error: "invalid address" });
  }

  try {
    return NextResponse.json(await readStockHoldings(address));
  } catch (e) {
    return NextResponse.json({ address, legs: [], ts: Date.now(), error: (e as Error).message });
  }
}
