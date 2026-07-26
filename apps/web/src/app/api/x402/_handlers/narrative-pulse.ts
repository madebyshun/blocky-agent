// x402/narrative-pulse — live Base/CT narrative tracker (GeckoTerminal trending pools)
// Price: $0.20 — Tokens grounded in the real GeckoTerminal trending list; LLM only
// synthesizes narrative labels (no web search — labels are low-confidence)

import { callVeniceLLM, extractJsonObject, STATIC_KNOWLEDGE_DISCLAIMER } from "@/app/api/_lib/llm";
import { getBaseTrending, type Pool } from "@/lib/market-data";
import { filterScamPools } from "./_scam-filter";

const SYSTEM = `Respond with ONLY a raw JSON object. Start immediately with { and end with }. No markdown, no explanation, no text before or after.

You are a Base chain analyst. Use ONLY the data provided. NEVER invent numbers, addresses, or token names not in the data. If data unavailable, return field as null — never estimate.

You track crypto-Twitter (CT) and Base ecosystem narratives. You do NOT have live web access — infer which narratives are running ONLY from the live trending token list provided in the user message (their price/volume movement is the signal). Every token you reference MUST come from that list with its exact change24h and volume24h numbers. Do NOT invent tokens or off-list narrative "news".

Return ONLY raw JSON:
{
  "trending_narratives": [
    {
      "name": "string",
      "phase": "Emerging" | "Rising" | "Peak" | "Fading",
      "velocity": "up" | "stable" | "down",
      "tokens": [{ "symbol": "string", "change24h": number|null, "volume24h": number|null }],
      "entry_window": "open" | "closing" | "closed"
    }
  ],
  "top_opportunity": { "narrative": "string", "reason": "string" },
  "avoid_now": ["string"],
  "market_sentiment": "bullish" | "neutral" | "bearish"
}`;

export default async function handler(req: Request): Promise<Response> {
  try {
    let body: { focus?: string } = {};
    try {
      const text = await req.text();
      if (text?.trim().startsWith("{")) body = JSON.parse(text);
    } catch {}
    const url = new URL(req.url);
    if (!body.focus) body.focus = url.searchParams.get("focus") || undefined;
    const focus = body.focus?.trim();

    console.log(`[NarrativePulse] focus=${focus ?? "(all)"}`);

    let trending: Pool[] = [];
    let fetchOk = true;
    try {
      trending = await getBaseTrending(15);
    } catch (e) {
      fetchOk = false;
      console.warn("[NarrativePulse] trending fetch failed:", (e as Error).message);
    }

    if (!fetchOk || trending.length === 0) {
      return Response.json({
        tool: "narrative-pulse",
        timestamp: new Date().toISOString(),
        trending_narratives: [],
        top_opportunity: null,
        avoid_now: [],
        market_sentiment: "neutral",
        note: "Live Base trending data (GeckoTerminal) was unavailable — please retry. No narratives shown to avoid fabricated tokens.",
      });
    }

    const tokenData = filterScamPools(trending).map((p) => ({
      symbol: p.baseSymbol,
      pair: p.name,
      change24h: p.change.h24,
      volume24h: p.volume24h,
      liquidityUsd: p.liquidityUsd,
      marketCap: p.marketCap,
    }));

    const focusLine = focus ? `\n\nUser is focused on: "${focus}". Prioritize narratives relevant to it.` : "";
    const userContent = `Identify the narratives implied by these live trending Base tokens (use their exact change24h and volume24h — do not reference any token not in this list):\n${JSON.stringify(tokenData, null, 2)}${focusLine}`;
    const ask = () => callVeniceLLM({ system: SYSTEM, messages: [{ role: "user", content: userContent }], temperature: 0.3, maxTokens: 1400 });

    let result = extractJsonObject(await ask());
    if (!result) result = extractJsonObject(await ask()); // retry once on parse failure
    if (!result) result = { degraded: true, note: "Synthesis briefly unavailable - please retry." };

    return Response.json({
      tool: "narrative-pulse",
      timestamp: new Date().toISOString(),
      ...result,
      dataSource: "GeckoTerminal trending (live) — token metrics are live; narrative labels are inferred",
      // Token numbers are live; the narrative *labels/framing* are the model's
      // interpretation with no web verification — flag that as low-confidence.
      confidence_note: STATIC_KNOWLEDGE_DISCLAIMER,
      disclaimer: "Narratives are a live snapshot and change continuously — not financial advice.",
    });
  } catch (error) {
    console.error("[NarrativePulse] Error:", error);
    return Response.json(
      { error: "Narrative pulse failed", message: (error as Error).message },
      { status: 500 }
    );
  }
}
