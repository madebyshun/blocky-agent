// x402/blue-research
// Blue Research — deep due-diligence memo on a Base topic, project, or token.
// Grounds in real market data when a token address is supplied (DexScreener),
// then runs a structured research synthesis. Resilient: retry + graceful
// fallback, never 500.
// Price: $1.00

import { getTokenMarket, type TokenMarket } from "@/lib/market-data";
import { NO_FABRICATION_RULE, callLLM } from "@/app/api/_lib/llm";

// Delegates to the shared Virtuals → Venice → Bankr chain. Bankr was
// banned 2026-07-18; the direct-Bankr fetch this used to do is dead
// on prod. `callLLM` retries providers in order and returns text +
// provenance. Signature kept identical so all call sites stay untouched.
async function llm(system: string, user: string, temp = 0.4, tokens = 1400): Promise<string> {
  const r = await callLLM({ system: `${NO_FABRICATION_RULE}\n\n${system}`, user, temperature: temp, maxTokens: tokens });
  return r.text;
}
function parseJson(t: string): Record<string, unknown> | null {
  let s = t.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const i = s.indexOf("{"), j = s.lastIndexOf("}");
  if (i >= 0 && j > i) s = s.slice(i, j + 1);
  try { return JSON.parse(s); } catch { try { return JSON.parse(s.replace(/[\x00-\x1F]/g, " ")); } catch { return null; } }
}

export default async function handler(req: Request): Promise<Response> {
  try {
    let body: { topic?: string; target?: string } = {};
    try { const t = await req.text(); if (t.trim().startsWith("{")) body = JSON.parse(t); } catch {}
    const url = new URL(req.url);
    const topic  = (body.topic ?? url.searchParams.get("topic") ?? "").trim();
    const target = (body.target ?? url.searchParams.get("target") ?? "").trim();
    const subject = topic || target;
    if (!subject) {
      return Response.json({ error: "topic is required (a project, narrative, or token; optionally a 0x address as target)." }, { status: 400 });
    }

    // Ground in real market data if a token address is supplied.
    let market: TokenMarket | null = null;
    if (/^0x[0-9a-fA-F]{40}$/.test(target)) market = await getTokenMarket(target);
    const marketCtx = market
      ? `\nLive market data (DexScreener, REAL — reference only these numbers): symbol ${market.symbol ?? "?"}, price $${market.priceUsd ?? "?"}, 24h ${market.change.h24 ?? "?"}%, liquidity $${Math.round(market.liquidityUsd ?? 0).toLocaleString()}, 24h vol $${Math.round(market.volume24h ?? 0).toLocaleString()}, mcap $${Math.round(market.marketCap ?? 0).toLocaleString()}.`
      : "";

    const system = `You are Blue Research — a sharp, contrarian DD analyst for the Base ecosystem (chain 8453).
Write a tight, honest research memo. If live market data is provided, reference ONLY those numbers; never fabricate prices/tickers/percentages. For non-quantitative claims, reason from known fundamentals and clearly mark anything uncertain.
Return ONLY raw JSON. No markdown.
Schema: {
  "thesis": "<1-2 sentence core thesis>",
  "key_findings": ["<finding>"],
  "bull_case": "<2-3 sentences>",
  "bear_case": "<2-3 sentences>",
  "risks": [{"risk":"<name>","severity":"high|medium|low","note":"<brief>"}],
  "contrarian_take": "<the non-consensus angle>",
  "verdict": "<conviction: strong|moderate|weak|avoid> + 1 sentence why",
  "sources_to_check": ["<what to verify before acting — Basescan, docs, onchain data, etc.>"]
}`;
    const user = `Research subject: ${subject}${target ? `\nTarget address: ${target}` : ""}${marketCtx}`;

    let result: Record<string, unknown> | null = null;
    for (let attempt = 0; attempt < 2 && !result; attempt++) {
      try { result = parseJson(await llm(system, user)); } catch { /* retry then fallback */ }
    }
    if (!result) {
      result = {
        thesis: `Research synthesis was briefly unavailable for "${subject}".`,
        key_findings: [],
        bull_case: "",
        bear_case: "",
        risks: [{ risk: "incomplete-analysis", severity: "medium", note: "Live synthesis failed — re-run for a full memo." }],
        contrarian_take: "",
        verdict: "weak — insufficient data this run",
        sources_to_check: ["Basescan (contract + holders)", "Project docs / GitHub", "DexScreener liquidity & volume"],
        degraded: true,
      };
    }

    return Response.json({
      tool: "blue-research",
      timestamp: new Date().toISOString(),
      data_source: market ? "DexScreener (live) + analysis" : "analysis",
      subject,
      target: target || null,
      market: market ? { symbol: market.symbol, price_usd: market.priceUsd, change_24h_pct: market.change.h24, liquidity_usd: market.liquidityUsd, volume_24h_usd: market.volume24h, market_cap: market.marketCap, url: market.url } : null,
      ...result,
    });
  } catch (e) {
    return Response.json({ error: "Blue research failed", message: (e as Error).message }, { status: 500 });
  }
}
