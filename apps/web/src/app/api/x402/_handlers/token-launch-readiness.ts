// x402/token-launch-readiness
// Token Launch Readiness — market-TIMING grounded in REAL Base data: live chain TVL
// + trending pools (DefiLlama/GeckoTerminal) set the market regime, and if a token
// `address` is supplied its live DexScreener price/liquidity/volume grounds the
// momentum read. The LLM scores readiness on top — never invents market numbers.
// Without a token address the launch is pre-market, so the score is a clearly
// labelled estimate. Resilient: retry + graceful fallback, never 500.
// Price: $0.50

import { getBaseTvl, getBaseTrending, tvlToPrompt, poolsToPrompt, getTokenMarket, type TokenMarket } from "@/lib/market-data";
import { callLLM } from "@/app/api/_lib/llm";

async function llm(system: string, user: string, temp = 0.3, tokens = 1300): Promise<string> {
  return (await callLLM({ system, user, temperature: temp, maxTokens: tokens })).text;
}
function parseJson(t: string): Record<string, unknown> | null {
  let s = t.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const i = s.indexOf("{"), j = s.lastIndexOf("}");
  if (i >= 0 && j > i) s = s.slice(i, j + 1);
  try { return JSON.parse(s); } catch { try { return JSON.parse(s.replace(/[\x00-\x1F]/g, " ")); } catch { return null; } }
}
const isAddr = (s: string) => /^0x[a-fA-F0-9]{40}$/.test(s.trim());

export default async function handler(req: Request): Promise<Response> {
  try {
    let body: { name?: string; project?: string; ticker?: string; address?: string; description?: string; traction?: string } = {};
    try { const t = await req.text(); if (t?.trim().startsWith("{")) body = JSON.parse(t); } catch {}
    const url = new URL(req.url);
    const name = body.name ?? body.project ?? url.searchParams.get("name") ?? url.searchParams.get("project") ?? "";
    const ticker = body.ticker ?? url.searchParams.get("ticker") ?? "";
    const address = body.address ?? url.searchParams.get("address") ?? "";
    const description = body.description ?? body.traction ?? url.searchParams.get("description") ?? url.searchParams.get("traction") ?? "";
    if (!name) return Response.json({ error: "project name is required" }, { status: 400 });

    // ── Real Base market context (timing regime) + optional live token market ──
    const [tvl, trending, tokenMkt] = await Promise.all([
      getBaseTvl(),
      getBaseTrending(8),
      isAddr(address) ? getTokenMarket(address.trim()) : Promise.resolve<TokenMarket | null>(null),
    ]);
    const hasMarket = !!(tvl || trending.length);
    const tokenLaunched = !!tokenMkt;

    const tokenCtx = tokenMkt
      ? `Existing token market (DexScreener, REAL): ${tokenMkt.symbol ?? "?"} price $${tokenMkt.priceUsd ?? "?"}, 24h ${tokenMkt.change.h24 ?? "?"}%, vol24h $${tokenMkt.volume24h ?? "?"}, liquidity $${tokenMkt.liquidityUsd ?? "?"}, mcap $${tokenMkt.marketCap ?? "?"} — this token is ALREADY trading; assess re-launch/relaunch momentum.`
      : "No token address supplied — this is a PRE-LAUNCH token; there is no live price/liquidity yet. Score launch timing from market regime + narrative only, and label it an estimate.";

    const marketCtx = [
      `Base market regime (REAL):`,
      tvlToPrompt(tvl),
      `Trending Base pools right now:`,
      poolsToPrompt(trending),
      tokenCtx,
    ].join("\n");

    const system = `You are Blue Agent — token launch readiness engine for Base (chain 8453).
You are given REAL Base market data (chain TVL + trending pools)${tokenLaunched ? " and the token's REAL live DexScreener market" : ""}. Use those exact numbers for market_timing; NEVER invent TVL, prices or volumes. ${tokenLaunched ? "" : "There is no live token market yet — frame readiness as an estimate, not measured."} Reason about narrative fit and retail appetite qualitatively.
Return ONLY raw JSON. No markdown.
Schema: {
  "readiness_score": <0-100>,
  "verdict": "GO|WAIT",
  "market_timing": {"score":<0-10>,"notes":"<reference the real TVL/trending data>"},
  "narrative_fit": {"score":<0-10>,"aligned":<boolean>,"notes":"<1 sentence>"},
  "retail_appetite": {"score":<0-10>,"notes":"<1 sentence>"},
  "checklist": [{"item":"<task>","status":"done|pending|critical","category":"technical|marketing|community|liquidity"}],
  "blockers": ["<critical issue if any>"],
  "action_items": ["<step>","<step>","<step>"],
  "recommended_timing": "<immediate|1-2 weeks|1 month|wait for catalyst>",
  "confidence": <0-100>
}`;
    const user = `Token: ${name} ${ticker ? `($${ticker})` : ""}\nDescription: ${description || "(none)"}\n\n${marketCtx}`;

    let result: Record<string, unknown> | null = null;
    for (let attempt = 0; attempt < 2 && !result; attempt++) {
      try { result = parseJson(await llm(system, user)); } catch { /* retry then fallback */ }
    }
    if (!result) {
      result = {
        readiness_score: null,
        verdict: "WAIT",
        market_timing: { score: null, notes: "Synthesis briefly unavailable — Base market context below is real. Re-run." },
        narrative_fit: { score: null, aligned: null, notes: "Re-run for detail." },
        retail_appetite: { score: null, notes: "Re-run for detail." },
        checklist: [],
        blockers: [],
        action_items: ["Re-run the readiness check", "Confirm audit + liquidity plan", "Line up launch narrative"],
        recommended_timing: "wait for catalyst",
        confidence: null,
        degraded: true,
      };
    }

    return Response.json({
      tool: "token-launch-readiness",
      timestamp: new Date().toISOString(),
      data_source: tokenLaunched
        ? "DefiLlama + GeckoTerminal + DexScreener (live token market)"
        : hasMarket
          ? "DefiLlama + GeckoTerminal (live Base market regime) — pre-launch estimate"
          : "estimate (live market data unavailable this run)",
      token: { name, ticker: ticker || null, address: address || null, description },
      market: {
        base_tvl_usd: tvl?.tvlUsd ?? null,
        base_tvl_change_7d_pct: tvl?.change7dPct ?? null,
        trending: trending.slice(0, 5).map((p) => ({ symbol: p.baseSymbol, change_24h_pct: p.change.h24, vol24h: p.volume24h })),
        token: tokenMkt ? { symbol: tokenMkt.symbol, price_usd: tokenMkt.priceUsd, change_24h_pct: tokenMkt.change.h24, volume24h: tokenMkt.volume24h, liquidity_usd: tokenMkt.liquidityUsd, market_cap: tokenMkt.marketCap } : null,
      },
      ...result,
    });
  } catch (error) {
    console.error("[TokenLaunchReadiness]", error);
    return Response.json({ error: "Token launch readiness check failed", message: (error as Error).message }, { status: 500 });
  }
}
