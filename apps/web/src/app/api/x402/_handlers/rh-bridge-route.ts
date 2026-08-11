// x402/rh-bridge-route (B1) — bridge route Base ↔ Robinhood Chain.
// Price: $0.05
//
// Robinhood Chain is an Arbitrum Orbit L2 that settles on Ethereum L1. So
// the canonical route is: source chain → Ethereum → Robinhood Chain via
// the Orbit bridge (or vice-versa). Third-party bridges (Across, LiFi,
// Squid, etc.) may offer faster direct paths and are surfaced when
// available.
//
// v1 returns known canonical + third-party endpoints. Real quote for a
// specific asset requires the third-party aggregator's own API — noted as
// a follow-up integration.

import { RH_CHAIN } from "@/lib/robinhood/rwa-registry";

const KNOWN_BRIDGES = {
  robinhood_native: {
    name: "Robinhood Chain Bridge (Orbit)",
    settles_on: "Ethereum L1 (chainId 1)",
    docs: "https://docs.robinhood.com/chain/bridging/",
    ui: "https://bridge.robinhood.com/",
    kind: "canonical",
    expected_latency: "L1→L2: minutes. L2→L1: ~7 days challenge period.",
  },
  across: {
    name: "Across Protocol",
    docs: "https://docs.across.to/",
    ui: "https://across.to/",
    kind: "third-party",
    expected_latency: "1-3 minutes typical",
  },
  lifi: {
    name: "LI.FI",
    docs: "https://docs.li.fi/",
    ui: "https://jumper.exchange/",
    kind: "third-party",
    expected_latency: "1-5 minutes typical",
  },
  squid: {
    name: "Squid Router",
    docs: "https://docs.squidrouter.com/",
    ui: "https://app.squidrouter.com/",
    kind: "third-party",
    expected_latency: "1-3 minutes typical",
  },
} as const;

export default async function handler(req: Request): Promise<Response> {
  try {
    let body: { from_chain?: string; to_chain?: string; asset?: string } = {};
    try { const t = await req.text(); if (t?.trim().startsWith("{")) body = JSON.parse(t); } catch {}
    const url = new URL(req.url);
    const from = ((body.from_chain ?? url.searchParams.get("from_chain") ?? "base") as string).toLowerCase();
    const to = ((body.to_chain ?? url.searchParams.get("to_chain") ?? "robinhood") as string).toLowerCase();
    const asset = ((body.asset ?? url.searchParams.get("asset") ?? "ETH") as string).toUpperCase();

    const involvesRh = from === "robinhood" || to === "robinhood";
    if (!involvesRh) {
      return Response.json({
        error: "This tool routes Base ↔ Robinhood Chain (or any chain ↔ Robinhood). One side of the pair must be `robinhood`.",
      }, { status: 400 });
    }

    const timestamp = new Date().toISOString();

    return Response.json({
      tool: "rh-bridge-route",
      from_chain: from,
      to_chain: to,
      asset,
      canonical_route: KNOWN_BRIDGES.robinhood_native,
      third_party_routes: [KNOWN_BRIDGES.across, KNOWN_BRIDGES.lifi, KNOWN_BRIDGES.squid],
      note: "Robinhood Chain is an Arbitrum Orbit L2 settling on Ethereum L1. Native bridge is the trust-minimized path (canonical). Third-party aggregators offer faster UX but require trust in their bridge provers. For a live routing quote, hit the third-party's own API (each supports RH chainId 4663).",
      how_to_get_live_quote: {
        across:  "POST https://app.across.to/api/suggested-fees with {originChainId, destinationChainId, token, amount}",
        lifi:    "GET https://li.quest/v1/quote?fromChain=…&toChain=4663&fromToken=…&fromAmount=…",
        squid:   "POST https://api.squidrouter.com/v1/route with {fromChain, toChain, fromToken, fromAmount}",
      },
      network: RH_CHAIN,
      timestamp,
    });
  } catch (e) {
    return Response.json({ error: "rh-bridge-route failed", message: (e as Error).message }, { status: 500 });
  }
}
