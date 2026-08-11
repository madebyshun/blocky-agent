// x402/whale-tracker — smart money / whale flow on Base.
// Movements are REAL: pulled from Basescan (Etherscan v2, chainid 8453) token
// transfers for the given address. The LLM only reads the real transfer list and
// produces a signal — it never invents a movement. topMovements is built in code
// from the on-chain data, not by the model.
// Price: $0.10

import { getMoralisERC20Transfers } from "@/lib/moralis";
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

type TokenTx = {
  value?: string;
  value_decimal?: string;
  token_decimals?: string;
  from_address?: string;
  to_address?: string;
  token_symbol?: string;
  block_timestamp?: string;
  possible_spam?: boolean;
};

async function getTokenTx(address: string, limit = 100): Promise<TokenTx[]> {
  try {
    const transfers = await getMoralisERC20Transfers(address, limit);
    return (transfers as TokenTx[]).filter((t) => !t.possible_spam);
  } catch {
    return [];
  }
}

const SYSTEM = `You are a smart-money / whale flow analyst for Base chain.
You are given a REAL list of recent large on-chain token transfers for an address.
Read ONLY those transfers — do not invent any movement, token or amount.
Return ONLY valid JSON:
{
  "whaleActivity": "ACCUMULATING|DISTRIBUTING|NEUTRAL|MIXED",
  "signal": "BULLISH|BEARISH|NEUTRAL",
  "signalStrength": <0-100>,
  "patterns": ["<pattern grounded in the transfers>"],
  "trend": "<summary of what the transfers show>",
  "recommendation": "<actionable signal>"
}`;

export default async function handler(req: Request): Promise<Response> {
  try {
    let body: { address?: string } = {};
    try {
      const text = await req.text();
      if (text?.trim().startsWith("{")) body = JSON.parse(text);
    } catch {}
    const url = new URL(req.url);
    const address = body.address ?? url.searchParams.get("address") ?? url.searchParams.get("token") ?? "";

    if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
      return Response.json({ error: "Provide a valid wallet or token address (0x...)" }, { status: 400 });
    }

    const txs = await getTokenTx(address, 100);

    // Build the real large-transfer list in code (top 15 by token amount).
    const largeTxs = txs
      .map((tx) => {
        const amount = tx.value_decimal != null
          ? parseFloat(tx.value_decimal)
          : parseFloat(tx.value ?? "0") / Math.pow(10, parseInt(tx.token_decimals || "18"));
        return {
          token: tx.token_symbol,
          amount: Number.isFinite(amount) ? amount : 0,
          direction: tx.to_address?.toLowerCase() === address.toLowerCase() ? "IN" : "OUT",
          from: (tx.from_address ?? "").slice(0, 10) + "…",
          to: (tx.to_address ?? "").slice(0, 10) + "…",
          timestamp: tx.block_timestamp ? new Date(tx.block_timestamp).toISOString() : null,
        };
      })
      .filter((t) => t.amount > 0)
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 15);

    const topMovements = largeTxs.map((t) => ({
      token: t.token,
      action: t.direction === "IN" ? "received" : "sent",
      amount: t.amount.toLocaleString(undefined, { maximumFractionDigits: 2 }),
      direction: t.direction,
      significance: t.amount >= 100_000 ? "HIGH" : t.amount >= 10_000 ? "MEDIUM" : "LOW",
    }));

    const base = {
      tool: "whale-tracker",
      timestamp: new Date().toISOString(),
      chain: "base",
      chainId: 8453,
      address,
      data_source: "Basescan (live on-chain transfers)",
      transfers_analyzed: txs.length,
      topMovements,
      url: `https://basescan.org/address/${address}`,
    };

    if (!txs.length) {
      return Response.json({
        ...base,
        whaleActivity: "NEUTRAL",
        signal: "NEUTRAL",
        signalStrength: 0,
        patterns: [],
        trend: "No recent token transfers found for this address on Base (or Basescan is unavailable).",
        recommendation: "No on-chain flow to act on right now.",
      });
    }

    const llmResponse = await callBankrLLM({
      system: SYSTEM,
      messages: [{ role: "user", content: `Address: ${address} (Base)\nRecent large transfers (real, on-chain):\n${JSON.stringify(topMovements, null, 2)}\nTotal transfers analyzed: ${txs.length}` }],
      temperature: 0.4,
      maxTokens: 600,
    });
    const analysis = extractJsonObject(llmResponse) ?? {};

    return Response.json({
      ...base,
      whaleActivity: analysis.whaleActivity ?? "NEUTRAL",
      signal: analysis.signal ?? "NEUTRAL",
      signalStrength: analysis.signalStrength ?? 50,
      patterns: analysis.patterns ?? [],
      trend: analysis.trend ?? "",
      recommendation: analysis.recommendation ?? "",
    });
  } catch (error) {
    console.error("[WhaleTracker]", error);
    return Response.json({ error: "Whale tracking failed", message: (error as Error).message }, { status: 500 });
  }
}
