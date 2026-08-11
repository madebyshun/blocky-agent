// x402/rh-stock-quote (M1) — Chainlink-first live quote for RH stocks.
// Price: $0.03
//
// The *deterministic* quote tool. Reads Chainlink `latestRoundData` on RH
// Chain, returns raw oracle answer + decimals + updatedAt + staleness flag.
// If the ticker has a Chainlink feed but no ERC-20 token registered yet
// (e.g. RGTI, RKLB, IONQ), still returns the oracle price — that's the whole
// point of Chainlink as a public good.
//
// Fallback: if no Chainlink feed exists but the token is in the registry,
// return the DEX spot with `source: "dex-spot"` and a note.
//
// This is the tool builders embed for price display. Chainlink-native → they
// don't need to wire a Chainlink SDK themselves.

import { findByTicker, findChainlinkOnly, RH_CHAIN } from "@/lib/robinhood/rwa-registry";
import { chainlinkLatest, dexPrice } from "@/lib/robinhood/rwa-price";

export default async function handler(req: Request): Promise<Response> {
  try {
    let body: { ticker?: string; query?: string } = {};
    try { const t = await req.text(); if (t?.trim().startsWith("{")) body = JSON.parse(t); } catch {}
    const url = new URL(req.url);
    const ticker = (body.ticker ?? body.query ?? url.searchParams.get("ticker") ?? url.searchParams.get("query") ?? "").trim();
    if (!ticker) return Response.json({ error: "Provide `ticker` (e.g. MSTR, AAPL, TSLA)" }, { status: 400 });

    const timestamp = new Date().toISOString();
    const token = findByTicker(ticker);
    const chainlinkOnly = !token ? findChainlinkOnly(ticker) : null;

    // ── Case A: ticker in registry + has Chainlink feed → gold path ────────
    if (token?.chainlinkFeed) {
      const q = await chainlinkLatest(token.chainlinkFeed, token.chainlinkHeartbeat ?? 86400);
      if (q) {
        return Response.json({
          tool: "rh-stock-quote",
          ticker: token.ticker,
          name: token.name,
          contract: token.contract,
          price_usd: q.price_usd,
          source: "chainlink",
          chainlink: q,
          is_stale: q.is_stale,
          network: RH_CHAIN,
          data_sources: ["Chainlink AggregatorV3 on-chain (RH Chain)"],
          timestamp,
        });
      }
      // fallthrough to DEX if Chainlink read failed
    }

    // ── Case B: registry entry with no Chainlink feed → DEX fallback ────────
    if (token && !token.chainlinkFeed) {
      const d = await dexPrice(token.contract);
      return Response.json({
        tool: "rh-stock-quote",
        ticker: token.ticker,
        name: token.name,
        contract: token.contract,
        price_usd: d?.price_usd ?? null,
        source: d ? "dex-spot" : null,
        chainlink: null,
        dex: d,
        note: "No Chainlink feed listed for this ticker at time of registry snapshot. DEX spot returned instead.",
        network: RH_CHAIN,
        data_sources: d ? ["api.geckoterminal.com (RH Chain)"] : ["docs.robinhood.com/chain/contracts"],
        timestamp,
      });
    }

    // ── Case C: chainlink-only feed (no token contract in registry) ─────────
    if (chainlinkOnly) {
      const q = await chainlinkLatest(chainlinkOnly.chainlinkFeed, chainlinkOnly.chainlinkHeartbeat);
      return Response.json({
        tool: "rh-stock-quote",
        ticker: chainlinkOnly.ticker,
        name: chainlinkOnly.name,
        contract: null,
        price_usd: q?.price_usd ?? null,
        source: q ? "chainlink" : null,
        chainlink: q,
        note: "Chainlink feed exists on RH Chain but the ERC-20 token contract is not yet in the canonical registry.",
        network: RH_CHAIN,
        data_sources: ["Chainlink AggregatorV3 on-chain (RH Chain)"],
        timestamp,
      });
    }

    // ── Case D: unknown ────────────────────────────────────────────────────
    return Response.json({
      tool: "rh-stock-quote",
      ticker,
      price_usd: null,
      source: null,
      error: "Ticker not found. Use rh-stock-search for fuzzy matches.",
      network: RH_CHAIN,
      timestamp,
    }, { status: 404 });
  } catch (e) {
    return Response.json({ error: "rh-stock-quote failed", message: (e as Error).message }, { status: 500 });
  }
}
