// x402/defi-opportunity
// DeFi yield scan over REAL Base pools (DefiLlama yields). Every protocol, APY and
// TVL is live. The LLM ranks/explains the real pools and flags risk — it never
// invents a protocol or an APY.
// Price: $0.35

import { getBaseYields, getBaseTvl, yieldsToPrompt, tvlToPrompt, type YieldPool } from "@/lib/market-data";
import { callLLM } from "@/app/api/_lib/llm";

type Msg = { role: string; content: string };
// Bankr LLM (llm.bankr.bot) was 403-banned 2026-07-20 → route through callLLM
// (Virtuals). Signature/temperature defaults preserved so call sites are unchanged.
async function llm(system: string, user: string, temp = 0.3, tokens = 1000): Promise<string> {
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
    let body: { strategy?: string; risk_tolerance?: string } = {};
    try { const t = await req.text(); if (t.trim().startsWith("{")) body = JSON.parse(t); } catch {}
    const { strategy = "yield", risk_tolerance = "medium" } = body;

    // Low risk → bias toward stablecoin pools with meaningful TVL.
    const stableOnly = risk_tolerance === "low";
    const [pools, tvl] = await Promise.all([
      getBaseYields(18, { stableOnly, minTvl: 100_000 }),
      getBaseTvl(),
    ]);
    const usable: YieldPool[] = pools.length ? pools : await getBaseYields(18, { minTvl: 100_000 });

    if (!usable.length) {
      return Response.json(
        { error: "Live DeFi yield data is unavailable right now. Retry shortly." },
        { status: 503 }
      );
    }

    const validProjects = Array.from(new Set(usable.map((p) => `${p.project}/${p.symbol}`)));
    const realContext = `${tvlToPrompt(tvl)}\n\nLive Base yield pools (DefiLlama):\n${yieldsToPrompt(usable)}`;

    const resultRaw = await llm(
      `You are Blue Agent — DeFi opportunity scanner for Base. You are given REAL live yield pools with real APY, TVL and risk flags.
Rules:
- Recommend ONLY pools from this list: ${validProjects.join(", ")}. Never invent a protocol or APY.
- Quote the real APY and TVL shown. Respect the user's risk tolerance (${risk_tolerance}).
- apy_range must reflect the real APY of the pool you cite.
Return ONLY raw JSON. No markdown.
Schema: {
  "scan_score": <0-100>,
  "market_condition": "favorable|neutral|unfavorable",
  "opportunities": [
    {"protocol":"<project from list>","pool":"<symbol>","type":"yield|lp|lending|farming|staking","apy":"<real APY>","tvl":"<real TVL>","risk":"high|medium|low","entry":"<how to enter>","watch_for":"<risk signal>"}
  ],
  "avoid_now": ["<protocol or strategy to avoid>"],
  "best_entry_timing": "<immediate|wait for X>",
  "summary": "<2 sentences>"
}`,
      `Strategy: ${strategy}\nRisk tolerance: ${risk_tolerance}\n\n${realContext}`,
      0.3,
      1000
    );

    let result = parseJson(resultRaw);
    if (!result) result = { degraded: true, note: "Synthesis briefly unavailable - please retry." };

    return Response.json({
      tool: "defi-opportunity",
      timestamp: new Date().toISOString(),
      strategy,
      risk_tolerance,
      data_source: "DefiLlama (live Base yields)",
      pools_scanned: usable.length,
      ...result,
    });
  } catch (e) {
    return Response.json({ error: "DeFi opportunity scan failed", message: (e as Error).message }, { status: 500 });
  }
}
