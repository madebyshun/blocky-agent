// x402/rh-rwa-index (L2) — full canonical RH RWA catalog.
// Price: $0.02
//
// Zero-input. Returns the entire Robinhood Chain RWA registry — every token
// the RHJ factory has deployed (stocks + ETFs), plus the WETH/USDG utility
// rows, plus Chainlink-only tickers (a feed exists but no ERC-20 is registered).
// The registry is generated from the factory's `Deployed` event log rather than
// hand-curated, so the counts below are whatever the chain says today.
//
// One thing this catalog does NOT claim: tradability. Membership proves RHJ
// issued the token, nothing more — most RH stock tokens have no pool and no
// Chainlink feed, so a listing here is not a green light to route an order
// through it. Check depth first (see rh-stock-liquidity / M-series tools).
//
// Callable by portfolio dashboards, sector-basket builders (P4), rebalance
// planners (P3), and any front-end that needs to render "all available RH
// tokenized stocks" without wiring the docs page themselves.

import {
  RH_CHAIN,
  RWA_TOKENS,
  CHAINLINK_ONLY_FEEDS,
} from "@/lib/robinhood/rwa-registry";

export default async function handler(_req: Request): Promise<Response> {
  try {
    const stocks = RWA_TOKENS.filter((t) => t.kind === "stock");
    const etfs   = RWA_TOKENS.filter((t) => t.kind === "etf");
    const utility = RWA_TOKENS.filter((t) => t.kind === "stable" || t.kind === "wrapped");

    return Response.json({
      tool: "rh-rwa-index",
      network: RH_CHAIN,
      counts: {
        stocks:  stocks.length,
        etfs:    etfs.length,
        utility: utility.length,
        chainlink_only_feeds: CHAINLINK_ONLY_FEEDS.length,
        total_tokens: RWA_TOKENS.length,
      },
      stocks: stocks.map(strip),
      etfs:   etfs.map(strip),
      utility: utility.map(strip),
      chainlink_only_feeds: CHAINLINK_ONLY_FEEDS.map((f) => ({
        ticker: f.ticker,
        name: f.name,
        chainlink_feed: f.chainlinkFeed,
        heartbeat_seconds: f.chainlinkHeartbeat,
        note: "Live Chainlink feed on RH Chain but ERC-20 token contract not yet in canonical registry.",
      })),
      data_sources: [
        // The docs page is a subset that lags the chain — it listed 25 tokens
        // while 203 had been deployed. Provenance is the factory, not the docs:
        // the registry is generated from the RHJ factory's own `Deployed` event
        // log, which cannot silently return a prefix the way a ranked token
        // list can. See scripts/rwa-generate.ts.
        "robinhoodchain.blockscout.com API v2 /addresses/{RH_RWA_DEPLOYER}/logs — Deployed events",
        "reference-data-directory.vercel.app/feeds-robinhood-mainnet.json (Chainlink)",
      ],
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    return Response.json({ error: "rh-rwa-index failed", message: (e as Error).message }, { status: 500 });
  }
}

function strip(t: typeof RWA_TOKENS[number]) {
  return {
    ticker: t.ticker,
    name: t.name,
    contract: t.contract,
    decimals: t.decimals,
    kind: t.kind,
    issuer: t.issuer,
    sector: t.sector ?? null,
    chainlink_feed: t.chainlinkFeed ?? null,
    explorer_url: `${RH_CHAIN.explorer}/address/${t.contract}`,
    note: t.note ?? null,
  };
}
