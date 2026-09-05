// GET /api/wallet/rh-holdings?address=0x…
//
// Crypto holdings on Robinhood Chain 4663, for the Wallet surface.
//
// This is a THIRD wallet read, not a parameter on an existing one, because the
// two chains share no reader and no state:
//   /api/wallet/holdings  → Moralis      → Base only (Moralis does not index RH)
//   /api/wallet/stocks    → registry     → equities on BOTH chains
//   this route            → Blockscout   → everything else on RH
// Folding RH into /api/wallet/holdings would mean one response whose rows came
// from two different indexers with two different trust models, on chains whose
// explorers are not interchangeable.
//
// Mainnet only — RH has no testnet leg here, and the caller mounts it under the
// same `!isTestnet` guard as the stock table.
//
// ZERO fabrication: prices are Blockscout's own exchange_rate, an unpriced token
// stays unpriced, and an explorer that did not answer returns
// `status:"unavailable"` rather than an empty portfolio.

import { NextResponse } from "next/server";
import { readRhHoldings } from "@/lib/wallet/rh-holdings";
import { RH_CHAIN } from "@/lib/robinhood/rwa-registry";

// Per-address wallet read — never cache across addresses.
export const dynamic = "force-dynamic";
// Up to five Blockscout round-trips with one retry each — the native balance,
// then the ERC-20 list, which is 50 rows per page and walked up to 4 pages
// (cursor-based, so pages 2-4 are sequential). Against an explorer measured at
// 2.4-8.8s on its slow path. Comfortably under this; not under the default.
export const maxDuration = 60;

/** Shape-compatible failure: the UI branches on `status`, so it must always exist. */
function unavailable(address: string, error?: string) {
  return NextResponse.json({
    address,
    chainId:  RH_CHAIN.chainId,
    label:    RH_CHAIN.name,
    explorer: RH_CHAIN.explorer,
    status:   "unavailable" as const,
    holdings: [],
    totalUsd: 0,
    equitiesHidden: 0,
    nativeUnread: false,
    truncated: false,
    ts: Date.now(),
    ...(error ? { error } : {}),
  });
}

export async function GET(req: Request) {
  const address = new URL(req.url).searchParams.get("address") ?? "";

  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return unavailable(address, "invalid address");
  }

  try {
    return NextResponse.json(await readRhHoldings(address));
  } catch (e) {
    // Never a 500 into an empty list — the caller would render that as a
    // portfolio. Fail as "we could not check", which is what actually happened.
    return unavailable(address, (e as Error).message);
  }
}
