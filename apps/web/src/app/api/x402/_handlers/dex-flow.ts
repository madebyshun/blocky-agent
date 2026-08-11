// x402/dex-flow — DEX volume, buy/sell pressure and liquidity flow for any Base token
// Price: $0.15 — Fully self-contained, no external workspace imports

import { callLLM } from "@/app/api/_lib/llm";

type BankrMessage = { role: string; content: string };

// Delegates to the shared Virtuals → Venice → Bankr chain. Bankr was
// banned 2026-07-18; the direct-Bankr fetch this used to do is dead
// on prod. `callLLM` retries providers in order and returns text +
// provenance. Name/signature preserved so all call sites stay identical.
async function callBankrLLM(opts: {
  model?: string; system: string; messages: BankrMessage[];
  temperature?: number; maxTokens?: number;
}): Promise<string> {
  const r = await callLLM({
    system: opts.system,
    messages: opts.messages,
    temperature: opts.temperature,
    maxTokens: opts.maxTokens,
    model: opts.model,
  });
  return r.text;
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  let raw = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
  const s = raw.indexOf("{"), e = raw.lastIndexOf("}");
  if (s >= 0 && e > s) raw = raw.slice(s, e + 1);
  try { return JSON.parse(raw); } catch {}
  try { return JSON.parse(raw.replace(/[\x00-\x1F\x7F]/g, " ")); } catch {}
  return null;
}

const DEXSCREENER_URL = "https://api.dexscreener.com/latest/dex";

async function getDexData(token: string): Promise<unknown[]> {
  const isAddress = /^0x[a-fA-F0-9]{40}$/.test(token);
  const url = isAddress
    ? `${DEXSCREENER_URL}/tokens/${token}`
    : `${DEXSCREENER_URL}/search?q=${encodeURIComponent(token)}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`DexScreener error: ${res.status}`);
  const data = await res.json() as { pairs?: unknown[] };

  type Pair = { chainId?: string; volume?: { h24?: number }; dexId?: string; baseToken?: { symbol?: string }; quoteToken?: { symbol?: string }; priceUsd?: string; priceChange?: { h1?: number; h24?: number }; liquidity?: { usd?: number }; txns?: { h24?: { buys?: number; sells?: number } } };

  return ((data.pairs ?? []) as Pair[])
    .filter(p => p.chainId === "base")
    .sort((a, b) => (b.volume?.h24 ?? 0) - (a.volume?.h24 ?? 0))
    .slice(0, 5)
    .map(p => ({
      dex: p.dexId,
      pair: (p.baseToken?.symbol ?? "") + "/" + (p.quoteToken?.symbol ?? ""),
      price: p.priceUsd,
      priceChange1h: p.priceChange?.h1,
      priceChange24h: p.priceChange?.h24,
      volume24h: p.volume?.h24,
      liquidity: p.liquidity?.usd,
      txns24h: (p.txns?.h24?.buys ?? 0) + (p.txns?.h24?.sells ?? 0),
      buys24h: p.txns?.h24?.buys,
      sells24h: p.txns?.h24?.sells,
    }));
}

const SYSTEM = `You are a DEX flow analyst interpreting on-chain trading data for Base chain tokens.

Analyze volume, buy/sell pressure, liquidity, and price action to assess market sentiment and flow direction.

CRITICAL DATA RULE: Use ONLY the live DexScreener numbers provided in the user message. Derive pressureScore, buySellRatio, and volume from those exact buys/sells/volume figures. NEVER invent volume, ratios, or liquidity that aren't in the data.

Return ONLY valid JSON:

{
  "token": "string",
  "chain": "base",
  "pressure": "STRONG_BUY" | "BUY" | "NEUTRAL" | "SELL" | "STRONG_SELL",
  "pressureScore": number (0-100, 50=neutral, 100=max buy pressure),
  "volume24h": "string",
  "buySellRatio": "string (e.g. '65% buys / 35% sells')",
  "liquidityHealth": "DEEP" | "MODERATE" | "THIN" | "CRITICAL",
  "priceAction": "string (brief summary of recent price movement)",
  "topPairs": [
    {
      "dex": "string",
      "pair": "string",
      "volume24h": "string",
      "buySellRatio": "string"
    }
  ],
  "signals": ["signal1", "signal2"],
  "recommendation": "string (what does this flow data suggest?)"
}`;

export default async function handler(req: Request): Promise<Response> {
  try {
    let body: { token?: string } = {};
    try {
      const text = await req.text();
      if (text?.trim().startsWith("{")) body = JSON.parse(text);
    } catch {}
    const url = new URL(req.url);
    if (!body.token) body.token = url.searchParams.get("token") || url.searchParams.get("address") || undefined;

    const { token } = body;
    if (!token) return Response.json({ error: "Provide token address or ticker" }, { status: 400 });

    console.log(`[DexFlow] Analyzing flow for: ${token}`);

    let dexData: unknown[] = [];
    let fetchOk = true;
    try {
      dexData = await getDexData(token);
    } catch {
      fetchOk = false;
      console.warn("[DexFlow] DexScreener fetch failed");
    }

    // Don't fabricate flow metrics with no data. Separate a fetch failure
    // (retry) from a genuine no-listing.
    if (!fetchOk) {
      return Response.json({
        token, chain: "base", pressure: "UNKNOWN", pressureScore: null,
        volume24h: "n/a", buySellRatio: "n/a", liquidityHealth: "UNKNOWN",
        priceAction: "Live DEX data source (DexScreener) was unavailable.",
        topPairs: [], signals: [],
        recommendation: "Could not fetch live DEX flow — please retry shortly. No estimated flow metrics are shown to avoid fabricated numbers.",
        dataSource: "DexScreener (unavailable)",
        disclaimer: "DEX flow is a live snapshot and changes continuously — not financial advice.",
      });
    }
    if (dexData.length === 0) {
      return Response.json({
        token, chain: "base", pressure: "UNKNOWN", pressureScore: null,
        volume24h: "n/a", buySellRatio: "n/a", liquidityHealth: "UNKNOWN",
        priceAction: `No Base-chain DEX pairs found for "${token}".`,
        topPairs: [], signals: [],
        recommendation: `No live Base DEX pair matched "${token}". Check the token address, or it may have no DEX liquidity yet.`,
        dataSource: "DexScreener (live)",
        disclaimer: "DEX flow is a live snapshot and changes continuously — not financial advice.",
      });
    }

    const llmResponse = await callBankrLLM({
      system: SYSTEM,
      messages: [{ role: "user", content: `Analyze DEX flow for ${token} on Base chain.\n\nLive DexScreener data (Base chain) — use ONLY these numbers:\n${JSON.stringify(dexData, null, 2)}\n\nAssess buy/sell pressure, volume trends, and liquidity health from the exact figures above.` }],
      temperature: 0.3,
      maxTokens: 800,
    });
    let result = extractJsonObject(llmResponse);
    if (!result) result = { degraded: true, note: "Synthesis briefly unavailable - please retry." };
    return Response.json({
      ...result,
      dataSource: "DexScreener (live)",
      disclaimer: "DEX flow is a live snapshot and changes continuously — not financial advice.",
    });
  } catch (error) {
    console.error("[DexFlow] Error:", error);
    return Response.json({ error: "DEX flow analysis failed", message: (error as Error).message }, { status: 500 });
  }
}
