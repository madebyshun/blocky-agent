// x402/base-alpha — Base-chain alpha digest: narratives, momentum picks, divergence
// Price: $0.25 — Real trending pools + TVL from market-data; LLM only groups/labels.

import { callLLM, extractJsonObject } from "@/app/api/_lib/llm";
import { getBaseTrending, getBaseTvl, poolsToPrompt, tvlToPrompt } from "@/lib/market-data";
import { filterScamPools } from "./_scam-filter";

const SYSTEM = `Respond with ONLY a raw JSON object. Start immediately with { and end with }. No markdown, no explanation, no text before or after.

You are a Base chain analyst. Use ONLY the data provided. NEVER invent numbers, addresses, or token names not in the data. If data unavailable, return field as null — never estimate.

Group the provided trending Base tokens into narratives, momentum picks, and divergence signals. Every token you name MUST appear in the provided trending list.

Return JSON with this exact shape:
{
  "market_phase": "string (e.g. 'risk-on', 'rotation', 'cooling')",
  "top_narratives": [ { "name": "string", "phase": "early|mid|late", "velocity": "accelerating|steady|fading", "tokens": ["SYMBOL"] } ],
  "momentum_picks": [ { "symbol": "string", "score": number, "signal_type": "string", "entry": "string" } ],
  "divergence_signals": [ { "symbol": "string", "thesis": "string" } ],
  "avoid": ["string"],
  "summary": "string"
}`;

export default async function handler(req: Request): Promise<Response> {
  try {
    // No input — drain any body so the request stream is consumed.
    try { await req.text(); } catch {}

    console.log("[BaseAlpha] Building Base alpha digest");

    const [trendingRaw, tvl] = await Promise.all([
      getBaseTrending(15).catch(() => []),
      getBaseTvl().catch(() => null),
    ]);
    const trending = filterScamPools(trendingRaw);

    const base_tvl_usd = tvl?.tvlUsd ?? null;
    const tvl_change_7d = tvl?.change7dPct ?? null;

    if (!trending.length) {
      return Response.json({
        tool: "base-alpha",
        timestamp: new Date().toISOString(),
        market_phase: null,
        base_tvl_usd,
        tvl_change_7d,
        top_narratives: [],
        momentum_picks: [],
        divergence_signals: [],
        avoid: [],
        summary: "Live trending data (GeckoTerminal) unavailable — no alpha digest generated to avoid fabricated picks.",
        dataSource: "GeckoTerminal + DefiLlama (unavailable)",
      });
    }

    const content = `Live Base market data — use ONLY these tokens and numbers.\n\n${tvlToPrompt(tvl)}\n\nTrending Base tokens:\n${poolsToPrompt(trending)}\n\nGroup these into narratives, momentum picks (score 0-100), and divergence signals. Only reference symbols from the list above.`;

    const ask = async () => (await callLLM({ system: SYSTEM, messages: [{ role: "user", content }], temperature: 0.3, maxTokens: 1400 })).text;

    let result = extractJsonObject(await ask());
    if (!result) result = extractJsonObject(await ask()); // retry once on parse failure
    if (!result) result = { degraded: true, note: "Synthesis briefly unavailable - please retry." };

    return Response.json({
      tool: "base-alpha",
      timestamp: new Date().toISOString(),
      base_tvl_usd,
      tvl_change_7d,
      ...result,
      dataSource: "GeckoTerminal (trending) + DefiLlama (TVL)",
      disclaimer: "Narratives are model-generated groupings of live tokens — not financial advice.",
    });
  } catch (error) {
    console.error("[BaseAlpha] Error:", error);
    return Response.json({ error: "Base alpha digest failed", message: (error as Error).message }, { status: 500 });
  }
}
