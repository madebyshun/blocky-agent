// x402/blue-analytics
// Blue Analytics — performance/metrics read on a Base token (live DexScreener
// data) with an interpretation layer. Grounded; resilient (never 500).
// Price: $0.25

import { getTokenMarket, type TokenMarket } from "@/lib/market-data";
import { callLLM } from "@/app/api/_lib/llm";

type Msg = { role: string; content: string };
// Bankr LLM (llm.bankr.bot) was 403-banned 2026-07-20 → route through callLLM
// (Virtuals). Signature/temperature defaults preserved so call sites are unchanged.
async function llm(system: string, user: string, temp = 0.3, tokens = 900): Promise<string> {
  return (await callLLM({ system, messages: [{ role: "user", content: user }] as Msg[], temperature: temp, maxTokens: tokens })).text;
}
function parseJson(t: string): Record<string, unknown> | null {
  let s = t.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const i = s.indexOf("{"), j = s.lastIndexOf("}");
  if (i >= 0 && j > i) s = s.slice(i, j + 1);
  try { return JSON.parse(s); } catch { try { return JSON.parse(s.replace(/[\x00-\x1F]/g, " ")); } catch { return null; } }
}

export default async function handler(req: Request): Promise<Response> {
  try {
    let body: { target?: string; focus?: string } = {};
    try { const t = await req.text(); if (t.trim().startsWith("{")) body = JSON.parse(t); } catch {}
    const url = new URL(req.url);
    const target = (body.target ?? url.searchParams.get("target") ?? "").trim();
    const focus  = (body.focus ?? url.searchParams.get("focus") ?? "").trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(target)) {
      return Response.json({ error: "target must be a Base token contract address (0x…)." }, { status: 400 });
    }

    const market: TokenMarket | null = await getTokenMarket(target);
    if (!market) {
      return Response.json({ error: "No live DEX market data found for this token on Base." }, { status: 404 });
    }

    const metrics = {
      symbol: market.symbol, name: market.name,
      price_usd: market.priceUsd,
      change: market.change,
      volume_24h_usd: market.volume24h,
      liquidity_usd: market.liquidityUsd,
      market_cap: market.marketCap, fdv: market.fdv,
      dex: market.dex,
    };

    const system = `You are Blue Analytics — interpret REAL Base token metrics for a builder/trader.
Reference ONLY the numbers given. Never invent figures. Be concrete and concise.
Return ONLY raw JSON. No markdown.
Schema: {
  "performance_summary": "<2 sentences on the read>",
  "momentum": "strong-up|up|flat|down|strong-down",
  "liquidity_health": "deep|adequate|thin|critical",
  "vol_to_liq_ratio": "<qualitative: healthy turnover vs wash/illiquid>",
  "growth_signals": ["<signal grounded in the metrics>"],
  "watch_metrics": ["<the metric to track + why>"]
}`;
    const user = `Token metrics (live DexScreener): ${JSON.stringify(metrics)}${focus ? `\nFocus: ${focus}` : ""}`;

    let interp: Record<string, unknown> | null = null;
    for (let attempt = 0; attempt < 2 && !interp; attempt++) {
      try { interp = parseJson(await llm(system, user)); } catch { /* retry then fallback */ }
    }
    if (!interp) {
      const ch = market.change.h24 ?? 0;
      interp = {
        performance_summary: "Interpretation layer was briefly unavailable; raw live metrics are included below.",
        momentum: ch > 5 ? "up" : ch < -5 ? "down" : "flat",
        liquidity_health: (market.liquidityUsd ?? 0) > 250_000 ? "adequate" : "thin",
        vol_to_liq_ratio: "see raw metrics",
        growth_signals: [],
        watch_metrics: ["liquidity_usd", "volume_24h_usd", "change.h24"],
        degraded: true,
      };
    }

    return Response.json({
      tool: "blue-analytics",
      timestamp: new Date().toISOString(),
      data_source: "DexScreener (live)",
      target,
      metrics: { ...metrics, url: market.url },
      ...interp,
    });
  } catch (e) {
    return Response.json({ error: "Blue analytics failed", message: (e as Error).message }, { status: 500 });
  }
}
