// x402/rh-stock-token (L1) — canonical RH RWA lookup.
// Price: $0.05
//
// Given a stock ticker or company name, return:
//   • on-chain contract address on Robinhood Chain (chainId 4663)
//   • canonical metadata (name, decimals, kind, issuer, sector)
//   • live price via Chainlink oracle (preferred, deterministic)
//   • fallback DEX spot from GeckoTerminal (with pool + TVL + 24h vol)
//   • Blockscout link for one-click verification
//
// Never fabricates data. If the ticker isn't in the canonical registry,
// returns `{ verdict: "NOT_FOUND", suggestions: [...] }` so callers see the
// closest 3 matches instead of a hallucinated address.
//
// Data sources (real, verifiable):
//   • Registry: hand-curated from docs.robinhood.com/chain/contracts +
//               Blockscout for late listings (see lib/robinhood/rwa-registry.ts).
//   • Chainlink feed proxies: reference-data-directory.vercel.app/feeds-robinhood-mainnet.json
//   • DEX spot: api.geckoterminal.com (RH Chain network id: robinhood).

import { findByTicker, findChainlinkOnly, fuzzySearch, RH_CHAIN } from "@/lib/robinhood/rwa-registry";
import { chainlinkLatest, dexPrice } from "@/lib/robinhood/rwa-price";

export default async function handler(req: Request): Promise<Response> {
  try {
    let body: { query?: string; ticker?: string } = {};
    try { const t = await req.text(); if (t?.trim().startsWith("{")) body = JSON.parse(t); } catch {}
    const url = new URL(req.url);
    const query = (body.query ?? body.ticker ?? url.searchParams.get("query") ?? url.searchParams.get("ticker") ?? "").trim();
    if (!query) return Response.json({ error: "Provide `query` (ticker or company name, e.g. MSTR)" }, { status: 400 });

    const timestamp = new Date().toISOString();
    const token = findByTicker(query);

    // ─── NOT_FOUND path — return closest matches, never fabricate ──────────
    if (!token) {
      const cl = findChainlinkOnly(query);
      const suggestions = fuzzySearch(query, 3).map((r) => ({
        ticker: r.token.ticker,
        name: r.token.name,
        contract: r.token.contract,
        similarity_rank: r.score,
      }));
      // If Chainlink-only feed exists, surface it — caller may only need the oracle.
      if (cl) {
        const cq = await chainlinkLatest(cl.chainlinkFeed, cl.chainlinkHeartbeat);
        return Response.json({
          tool: "rh-stock-token",
          verdict: "CHAINLINK_ONLY",
          query,
          ticker: cl.ticker,
          name: cl.name,
          note: "Live Chainlink feed exists on Robinhood Chain but the ERC-20 token contract is not yet in the canonical registry.",
          chainlink: cq,
          suggestions,
          data_sources: ["reference-data-directory.vercel.app (Chainlink)"],
          network: RH_CHAIN,
          timestamp,
        });
      }
      return Response.json({
        tool: "rh-stock-token",
        verdict: "NOT_FOUND",
        query,
        suggestions,
        note: "Ticker not found in canonical Robinhood Chain RWA registry. Closest matches shown.",
        data_sources: ["docs.robinhood.com/chain/contracts"],
        network: RH_CHAIN,
        timestamp,
      });
    }

    // ─── FOUND path — parallel Chainlink + DEX quote ───────────────────────
    const [chainlink, dex] = await Promise.all([
      token.chainlinkFeed
        ? chainlinkLatest(token.chainlinkFeed, token.chainlinkHeartbeat ?? 86400)
        : Promise.resolve(null),
      dexPrice(token.contract),
    ]);

    // Pick primary price: Chainlink (if fresh), else DEX. Never guess.
    let price_usd: number | null = null;
    let price_source: "chainlink" | "dex-spot" | null = null;
    if (chainlink && !chainlink.is_stale) {
      price_usd = chainlink.price_usd;
      price_source = "chainlink";
    } else if (dex) {
      price_usd = dex.price_usd;
      price_source = "dex-spot";
    } else if (chainlink) {
      // stale but present — still useful, flag it
      price_usd = chainlink.price_usd;
      price_source = "chainlink";
    }

    return Response.json({
      tool: "rh-stock-token",
      verdict: "LISTED",
      ticker: token.ticker,
      name: token.name,
      contract: token.contract,
      decimals: token.decimals,
      kind: token.kind,
      issuer: token.issuer,
      sector: token.sector ?? null,
      note: token.note ?? null,
      network: RH_CHAIN,
      explorer_url: `${RH_CHAIN.explorer}/address/${token.contract}`,
      price_usd,
      price_source,
      chainlink,       // full feed metadata (or null)
      dex,             // full pool metadata (or null)
      data_sources: [
        "docs.robinhood.com/chain/contracts",
        chainlink ? "Chainlink AggregatorV3 on-chain" : null,
        dex ? "api.geckoterminal.com (RH Chain)" : null,
      ].filter(Boolean),
      timestamp,
    });
  } catch (e) {
    return Response.json({ error: "rh-stock-token failed", message: (e as Error).message }, { status: 500 });
  }
}
