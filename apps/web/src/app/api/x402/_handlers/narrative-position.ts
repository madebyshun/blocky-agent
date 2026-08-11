// x402/narrative-position
// Narrative map for Base, anchored to REAL trending tokens (GeckoTerminal). The
// LLM frames narratives and position calls, but every token it references must be
// in the live trending set — no invented tickers. Narrative phase/velocity are
// analysis; the tokens and their moves are real.
// Price: $0.25

import { getBaseTrending, poolsToPrompt, type Pool } from "@/lib/market-data";
import { callLLM } from "@/app/api/_lib/llm";

type BankrMessage = { role: string; content: string };

// Bankr LLM (llm.bankr.bot) was 403-banned 2026-07-20 → route this local
// helper through callLLM (Virtuals). Signature kept so call sites are
// unchanged; the original 0.4 temperature default is preserved.
async function callBankrLLM(opts: {
  model?: string; system: string; messages: BankrMessage[];
  temperature?: number; maxTokens?: number;
}): Promise<string> {
  return (await callLLM({
    system: opts.system,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.4,
    maxTokens: opts.maxTokens ?? 1000,
  })).text;
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  let raw = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
  const s = raw.indexOf("{"), e = raw.lastIndexOf("}");
  if (s >= 0 && e > s) raw = raw.slice(s, e + 1);
  try { return JSON.parse(raw); } catch {}
  try { return JSON.parse(raw.replace(/[\x00-\x1F\x7F]/g, " ")); } catch {}
  return null;
}

export default async function handler(req: Request): Promise<Response> {
  try {
    let body: { topic?: string; focus?: string } = {};
    try { const t = await req.text(); if (t?.trim().startsWith("{")) body = JSON.parse(t); } catch {}
    const url = new URL(req.url);
    const topic = body.topic ?? body.focus ?? url.searchParams.get("topic") ?? url.searchParams.get("focus") ?? "";

    const trending: Pool[] = await getBaseTrending(15);
    if (!trending.length) {
      return Response.json(
        { error: "Live Base trending data is unavailable right now. Retry shortly." },
        { status: 503 }
      );
    }

    const validSymbols = Array.from(new Set(trending.map((p) => p.baseSymbol)));
    const realContext = `Live trending Base tokens (GeckoTerminal — real prices + 24h moves):\n${poolsToPrompt(trending)}${topic ? `\n\nUser focus: ${topic}` : ""}`;

    const synthesis = await callBankrLLM({
      system: `You are Blue Agent — narrative intelligence for Base. You are given the REAL trending Base tokens right now with live %-moves.
Rules:
- Group these real movers into narratives (e.g. AI agents, memes, DeFi, RWA). Any token you cite MUST be in this list: ${validSymbols.join(", ")}.
- Never invent a ticker. "Base" is the chain, not a token.
- Narrative phase/velocity/position calls are your analysis; the tokens and moves are real.
Return ONLY raw JSON. No markdown.
Schema: {
  "narratives": [
    {"name":"<narrative>","phase":"Emerging|Rising|Peak|Fading|Dead","velocity":"↑↑|↑|→|↓|↓↓","tokens":["<symbol from list>"],"position_call":"FRONT-RUN|RIDE|FADE|WATCH|IGNORE","driver":"<real catalyst>","bear_case":"<1 sentence>"}
  ],
  "transitions": ["<narrative>: <old phase> → <new phase>"],
  "top_opportunity": "<narrative name>",
  "reflexivity_alert": "<narrative showing cope/reflexivity or null>",
  "quiet_day": <boolean>
}`,
      messages: [{ role: "user", content: realContext }],
      temperature: 0.4,
      maxTokens: 1100,
    });

    let result = extractJsonObject(synthesis);
    if (!result) result = { degraded: true, note: "Synthesis briefly unavailable - please retry." };

    return Response.json({
      tool: "narrative-position",
      timestamp: new Date().toISOString(),
      topic: topic || null,
      data_source: "GeckoTerminal (live Base trending)",
      tokens_scanned: trending.length,
      ...result,
    });
  } catch (error) {
    console.error("[NarrativePosition]", error);
    return Response.json({ error: "Narrative position failed", message: (error as Error).message }, { status: 500 });
  }
}
