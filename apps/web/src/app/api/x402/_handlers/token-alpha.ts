// x402/token-alpha — single-token trade signal with whale confirmation for Base
// Price: $0.25 — Real price/liquidity (DexScreener) + whale flow (Moralis); LLM synthesis.

import { callLLM, extractJsonObject } from "@/app/api/_lib/llm";
import { getTokenMarket } from "@/lib/market-data";
import { getMoralisERC20Transfers } from "@/lib/moralis";
import { isLikelyScam } from "./_scam-filter";

const DEXSCREENER_URL = "https://api.dexscreener.com/latest/dex";

type DsPair = {
  chainId?: string;
  dexId?: string;
  baseToken?: { symbol?: string; name?: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  marketCap?: number;
  priceChange?: { h1?: number; h6?: number; h24?: number };
};

async function getBasePairs(token: string): Promise<DsPair[]> {
  const isAddress = /^0x[a-fA-F0-9]{40}$/.test(token);
  const url = isAddress
    ? `${DEXSCREENER_URL}/tokens/${token}`
    : `${DEXSCREENER_URL}/search?q=${encodeURIComponent(token)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const data = (await res.json()) as { pairs?: DsPair[] };
    return (data.pairs ?? [])
      .filter((p) => p.chainId === "base")
      .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))
      .slice(0, 3);
  } catch {
    return [];
  }
}

const SYSTEM = `Respond with ONLY a raw JSON object. Start immediately with { and end with }. No markdown, no explanation, no text before or after.

You are a Base chain analyst. Use ONLY the data provided. NEVER invent numbers, addresses, or token names not in the data. If data unavailable, return field as null — never estimate.

Produce a trade signal from the live price, liquidity, momentum and whale-flow data provided. Anchor entry_price to the real current price given. Derive stop_loss / target as plausible levels relative to that real price.

SIGNAL RULES: NO_SIGNAL is ONLY for a token with no live market data at all. When price/volume/liquidity data exists, pick STRONG_BUY/BUY/WATCH/SKIP from the momentum and liquidity. If the token is up >5% over 24h with 24h volume > $1M and liquidity > $1M, the signal MUST be at least WATCH. Never return NO_SIGNAL when clear momentum exists in the data.

Return JSON with this exact shape:
{
  "signal": "STRONG_BUY|BUY|WATCH|SKIP|NO_SIGNAL",
  "confidence": number,
  "entry_price": number | null,
  "stop_loss": number | null,
  "target": number | null,
  "whale_confirmation": boolean,
  "narrative_fit": "string",
  "momentum_score": number,
  "horizon": "string e.g. '2h - 6h'",
  "risk_flags": ["string"],
  "thesis": "string"
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

    console.log(`[TokenAlpha] Building signal for: ${token}`);

    const isAddress = /^0x[a-fA-F0-9]{40}$/.test(token);
    const [market, pairs, transfers] = await Promise.all([
      getTokenMarket(token).catch(() => null),
      getBasePairs(token),
      isAddress ? getMoralisERC20Transfers(token, 50).catch(() => []) : Promise.resolve([]),
    ]);

    const price = market?.priceUsd ?? (pairs[0]?.priceUsd != null ? Number(pairs[0].priceUsd) : null);
    const symbol = market?.symbol ?? pairs[0]?.baseToken?.symbol ?? null;

    // Token not found anywhere → no signal, no fabrication.
    if (!market && pairs.length === 0) {
      return Response.json({
        tool: "token-alpha",
        token,
        symbol,
        signal: "NO_SIGNAL",
        confidence: 0,
        entry_price: null,
        stop_loss: null,
        target: null,
        whale_confirmation: false,
        narrative_fit: null,
        momentum_score: null,
        risk_flags: ["No Base-chain DEX listing found for this token"],
        thesis: `No live Base market data found for "${token}".`,
        dataSource: "DexScreener + Moralis (no match)",
        timestamp: new Date().toISOString(),
      });
    }

    // getTokenMarket only resolves an ADDRESS — for a ticker it's null, so fall
    // back to the DexScreener pair (which has volume/liquidity/change too).
    const p0 = pairs[0];
    const mcap = market?.marketCap ?? p0?.marketCap ?? null;
    const vol24 = market?.volume24h ?? p0?.volume?.h24 ?? null;
    const liq = market?.liquidityUsd ?? p0?.liquidity?.usd ?? null;
    const ch1 = market?.change.h1 ?? p0?.priceChange?.h1 ?? null;
    const ch6 = market?.change.h6 ?? p0?.priceChange?.h6 ?? null;
    const ch24 = market?.change.h24 ?? p0?.priceChange?.h24 ?? null;

    // Scam guard — if resolved symbol matches impersonated brand or extreme pump,
    // return an AVOID signal immediately without spending LLM credits.
    const tokenName = pairs[0]?.baseToken?.name ?? null;
    if (isLikelyScam({ symbol, name: tokenName, change: ch24 ?? ch6 ?? ch1 })) {
      return Response.json({
        tool: "token-alpha",
        token,
        symbol,
        signal: "AVOID",
        confidence: 0,
        entry_price: null,
        stop_loss: null,
        target: null,
        whale_confirmation: false,
        narrative_fit: null,
        momentum_score: 0,
        risk_flags: [
          "SCAM_DETECTED: token matches known scam patterns (impersonated brand name or extreme price action)",
        ],
        thesis: `${symbol ?? token} has been flagged as a likely scam or impersonation. Blue Agent will not generate a trade signal for this token.`,
        scam_detected: true,
        liquidity_usd: liq,
        volume_24h: vol24,
        change_24h: ch24,
        dataSource: "Blue Agent scam filter",
        disclaimer: "Scam detection is heuristic-based — always verify independently.",
        timestamp: new Date().toISOString(),
      });
    }

    const whaleCount = Array.isArray(transfers) ? transfers.length : 0;
    const dataLines = [
      `Token: ${symbol ?? token}`,
      `Current price (USD): ${price ?? "unknown"}`,
      `Market cap (USD): ${mcap ?? "unknown"}`,
      `24h volume (USD): ${vol24 ?? "unknown"}`,
      `Liquidity (USD): ${liq ?? "unknown"}`,
      `Price change — 1h: ${ch1 ?? "?"}%, 6h: ${ch6 ?? "?"}%, 24h: ${ch24 ?? "?"}%`,
      `Recent on-chain transfers observed (last 50): ${whaleCount}`,
    ].join("\n");

    const content = `Live data for ${symbol ?? token} on Base — use ONLY these numbers. Anchor entry_price to the current price above.\n\n${dataLines}`;

    const ask = async () => (await callLLM({ system: SYSTEM, messages: [{ role: "user", content }], temperature: 0.3, maxTokens: 900 })).text;

    let result = extractJsonObject(await ask());
    if (!result) result = extractJsonObject(await ask()); // retry once on parse failure
    if (!result) result = { degraded: true, note: "Synthesis briefly unavailable - please retry." };

    return Response.json({
      tool: "token-alpha",
      token,
      symbol,
      // LLM output spread first — then grounded code values override any LLM estimates.
      ...result,
      // These MUST come AFTER ...result so LLM values cannot override real data.
      entry_price: price,           // real DexScreener price, always wins
      liquidity_usd: liq,
      volume_24h: vol24,
      change_24h: ch24,
      dataSource: "DexScreener (price/liquidity) + Moralis (transfers)",
      disclaimer: "Model-generated signal grounded in live data — not financial advice.",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[TokenAlpha] Error:", error);
    return Response.json({ error: "Token alpha signal failed", message: (error as Error).message }, { status: 500 });
  }
}
