// x402/scam-detector — scam/rug/honeypot risk for a Base token contract
// Price: $0.25 — Grounds the LLM in real DexScreener liquidity/age + Basescan verification

import { callLLM } from "@/app/api/_lib/llm";
import { getBasescanSource } from "@/lib/moralis";

function extractJsonObject(text: string): Record<string, unknown> | null {
  let raw = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
  const s = raw.indexOf("{"), e = raw.lastIndexOf("}");
  if (s >= 0 && e > s) raw = raw.slice(s, e + 1);
  try { return JSON.parse(raw); } catch {}
  try { return JSON.parse(raw.replace(/[\x00-\x1F\x7F]/g, " ")); } catch {}
  return null;
}

type DexPair = {
  chainId?: string;
  liquidity?: { usd?: number };
  pairCreatedAt?: number;
  volume?: { h24?: number };
  priceChange?: { h24?: number };
  baseToken?: { symbol?: string };
  dexId?: string;
};

async function getDexPairs(contract: string): Promise<DexPair[]> {
  const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${contract}`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`DexScreener error: ${res.status}`);
  const data = (await res.json()) as { pairs?: DexPair[] };
  return ((data.pairs ?? []) as DexPair[]).filter((p) => p.chainId === "base");
}

const SYSTEM = `You are a Base chain analyst. Use ONLY the data provided. NEVER invent numbers, addresses, or token names not in the data. Return ONLY raw JSON starting with {. No markdown. If data unavailable, return field as null — never estimate.

You assess whether a Base token contract is a scam (honeypot / rug pull / pump & dump / fake token) or clean. Base your judgment on the real signals provided: total DEX liquidity, the age of the oldest pair, 24h volume, and whether the contract source is verified on Basescan.

Heuristics: very low liquidity (under $10,000) combined with an UNVERIFIED contract is a strong scam signal. A brand-new pair (hours old) with thin liquidity is high risk. A verified contract with deep, aged liquidity is a clean signal. If the contract has no DEX pairs at all, treat as unknown/high-risk, not clean.

Return ONLY raw JSON:
{
  "is_scam": boolean,
  "scam_type": "honeypot" | "rug_pull" | "pump_dump" | "fake_token" | "clean" | "unknown",
  "confidence": number (0-100),
  "evidence": ["string"],
  "safe_to_interact": boolean,
  "red_flags": ["string"],
  "green_flags": ["string"],
  "verdict": "SAFE" | "SUSPICIOUS" | "SCAM"
}`;

export default async function handler(req: Request): Promise<Response> {
  try {
    let body: { contract?: string } = {};
    try {
      const text = await req.text();
      if (text?.trim().startsWith("{")) body = JSON.parse(text);
    } catch {}
    const url = new URL(req.url);
    if (!body.contract) body.contract = url.searchParams.get("contract") || url.searchParams.get("address") || undefined;

    const contract = body.contract?.trim();
    if (!contract) return Response.json({ error: "Provide a contract address" }, { status: 400 });
    if (!/^0x[a-fA-F0-9]{40}$/.test(contract)) {
      return Response.json({ error: "Provide a valid 0x contract address" }, { status: 400 });
    }

    console.log(`[ScamDetector] Scanning contract: ${contract}`);

    let pairs: DexPair[] = [];
    try {
      pairs = await getDexPairs(contract);
    } catch (e) {
      console.warn("[ScamDetector] DexScreener fetch failed:", (e as Error).message);
    }

    let source: Record<string, unknown> | null = null;
    try {
      source = await getBasescanSource(contract);
    } catch (e) {
      console.warn("[ScamDetector] Basescan source fetch failed:", (e as Error).message);
    }

    const totalLiquidity = pairs.reduce((sum, p) => sum + (p.liquidity?.usd ?? 0), 0);
    const oldestCreatedAt = pairs.reduce<number | null>((min, p) => {
      const t = p.pairCreatedAt;
      if (typeof t !== "number") return min;
      return min === null ? t : Math.min(min, t);
    }, null);
    const pairAgeHours = oldestCreatedAt ? (Date.now() - oldestCreatedAt) / (60 * 60 * 1000) : null;
    const total24hVolume = pairs.reduce((sum, p) => sum + (p.volume?.h24 ?? 0), 0);
    // A non-empty, non-error SourceCode field on Basescan means the contract is verified.
    const srcCode = typeof source?.SourceCode === "string" ? (source.SourceCode as string) : "";
    const verified = !!srcCode && srcCode.trim() !== "" && !srcCode.toLowerCase().includes("not verified");

    const facts = {
      contract,
      dex_pairs_found: pairs.length,
      total_liquidity_usd: Math.round(totalLiquidity),
      pair_age_hours: pairAgeHours === null ? null : Math.round(pairAgeHours),
      volume_24h_usd: Math.round(total24hVolume),
      contract_verified: verified,
      contract_name: typeof source?.ContractName === "string" ? source.ContractName : null,
    };

    const llmResponse = (await callLLM({
      system: SYSTEM,
      webSearch: false,
      messages: [{
        role: "user",
        content: `Assess scam risk for this Base token contract. Use ONLY these real signals:\n${JSON.stringify(facts, null, 2)}\n\nReminder: liquidity under $10,000 with an unverified contract is a strong scam signal.`,
      }],
      temperature: 0,
      maxTokens: 800,
    })).text;

    let result = extractJsonObject(llmResponse);
    if (!result) result = { degraded: true, note: "Synthesis briefly unavailable - please retry." };

    return Response.json({
      tool: "scam-detector",
      contract,
      ...result,
      signals: facts,
      dataSource: "DexScreener (live) + Basescan verification",
      disclaimer: "Heuristic risk signal only — not financial advice. Always do your own research.",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[ScamDetector] Error:", error);
    return Response.json(
      { error: "Scam detection failed", message: (error as Error).message },
      { status: 500 }
    );
  }
}
