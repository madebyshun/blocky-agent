// x402/rh-stock-search (L3) — fuzzy search over the RH RWA registry.
// Price: $0.02
//
// Handles typos, partial names, and casing. Uses Levenshtein + prefix bonus
// against ticker + full company name. Returns top-N ranked matches, never
// fabricates.

import { fuzzySearch, RH_CHAIN } from "@/lib/robinhood/rwa-registry";

export default async function handler(req: Request): Promise<Response> {
  try {
    let body: { query?: string; limit?: number } = {};
    try { const t = await req.text(); if (t?.trim().startsWith("{")) body = JSON.parse(t); } catch {}
    const url = new URL(req.url);
    const query = (body.query ?? url.searchParams.get("query") ?? "").trim();
    const limit = Math.max(1, Math.min(20, Number(body.limit ?? url.searchParams.get("limit") ?? 5)));

    if (!query) {
      return Response.json({ error: "Provide `query` (partial ticker or company name)" }, { status: 400 });
    }

    const matches = fuzzySearch(query, limit).map((m) => ({
      ticker: m.token.ticker,
      name: m.token.name,
      contract: m.token.contract,
      kind: m.token.kind,
      sector: m.token.sector ?? null,
      chainlink_feed: m.token.chainlinkFeed ?? null,
      similarity_rank: m.score,          // lower = closer
      explorer_url: `${RH_CHAIN.explorer}/address/${m.token.contract}`,
    }));

    return Response.json({
      tool: "rh-stock-search",
      query,
      matches,
      match_count: matches.length,
      note: matches.length === 0 ? "No candidates in registry." : "similarity_rank: lower = closer match. Negative = strong prefix match.",
      data_sources: ["docs.robinhood.com/chain/contracts"],
      network: RH_CHAIN,
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    return Response.json({ error: "rh-stock-search failed", message: (e as Error).message }, { status: 500 });
  }
}
