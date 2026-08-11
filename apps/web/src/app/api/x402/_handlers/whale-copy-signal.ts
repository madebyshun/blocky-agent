// x402/whale-copy-signal — copy-trade signal from REAL on-chain whale flow.
// Movements are pulled from Moralis (Base ERC-20 transfers) for the given
// wallet/token. The LLM reads ONLY the real transfer
// list and produces a copy signal — it never invents a movement, a wallet
// count, a price, or a target. topMovements is built in code from on-chain
// data. Price: $0.35

import { callLLM } from "@/app/api/_lib/llm";

// Delegates to the shared Virtuals → Venice → Bankr chain. Bankr was
// banned 2026-07-18; the direct-Bankr fetch this used to do is dead
// on prod. `callLLM` retries providers in order and returns text +
// provenance. Signature kept identical so all call sites stay untouched.
async function llm(system: string, user: string, temp = 0.3, tokens = 600): Promise<string> {
  const r = await callLLM({ system, user, temperature: temp, maxTokens: tokens });
  return r.text;
}

function parseJson(t: string): Record<string, unknown> | null {
  let s = t.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const i = s.indexOf("{"), j = s.lastIndexOf("}");
  if (i >= 0 && j > i) s = s.slice(i, j + 1);
  try { return JSON.parse(s); } catch { try { return JSON.parse(s.replace(/[\x00-\x1F]/g, " ")); } catch { return null; } }
}

// Moralis ERC-20 transfers (Base) — more reliable than the Etherscan v2 multichain
// endpoint, and it returns a ready decimal value + spam flag.
type TokenTx = {
  value: string;
  value_decimal?: string | null;
  token_decimals?: string | null;
  from_address?: string;
  to_address?: string;
  token_symbol: string;
  block_timestamp: string;
  possible_spam?: boolean;
};

async function getTokenTx(address: string, limit = 100): Promise<TokenTx[]> {
  const key = process.env.MORALIS_API_KEY ?? "";
  if (!key) return [];
  try {
    const res = await fetch(
      `https://deep-index.moralis.io/api/v2.2/${address}/erc20/transfers?chain=base&limit=${limit}`,
      { headers: { "X-API-Key": key, Accept: "application/json" }, signal: AbortSignal.timeout(10000) }
    );
    if (!res.ok) return [];
    const data = await res.json() as { result?: TokenTx[] };
    // Drop spam-flagged tokens so the signal reads real flow only.
    return (data.result ?? []).filter((t) => !t.possible_spam);
  } catch {
    return [];
  }
}

const SYSTEM = `You are a smart-money / copy-trade signal analyst for Base chain.
You are given a REAL list of recent large on-chain token transfers for a wallet.
Read ONLY those transfers — never invent a movement, token, amount, wallet count or price.
Decide whether this wallet is worth copying based on what the transfers actually show.
Return ONLY valid JSON:
{
  "signal": "STRONG_BUY|BUY|WATCH|PASS",
  "whale_activity": "accumulating|distributing|neutral|mixed",
  "confidence": <0-100>,
  "entry_timing": "<immediate|wait for dip|wait for confirmation|no clear entry>",
  "patterns": ["<pattern grounded in the transfers>"],
  "summary": "<2 sentences grounded ONLY in the transfers above>"
}`;

export default async function handler(req: Request): Promise<Response> {
  try {
    let body: { token?: string; wallet?: string; address?: string } = {};
    try { const t = await req.text(); if (t.trim().startsWith("{")) body = JSON.parse(t); } catch {}
    const url = new URL(req.url);
    // Copy-signal is about a specific whale wallet (preferred) or token address.
    const address = body.wallet ?? body.token ?? body.address
      ?? url.searchParams.get("wallet") ?? url.searchParams.get("token") ?? url.searchParams.get("address") ?? "";

    if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
      return Response.json(
        { error: "Provide a whale WALLET address (0x…) to analyse its real on-chain flow and get a copy signal." },
        { status: 400 },
      );
    }

    const txs = await getTokenTx(address, 100);

    // Build the real large-transfer list in code (top 15 by token amount).
    const largeTxs = txs
      .map((tx) => {
        const amount = tx.value_decimal != null && tx.value_decimal !== ""
          ? parseFloat(tx.value_decimal)
          : parseFloat(tx.value) / Math.pow(10, parseInt(tx.token_decimals || "18"));
        return {
          token: tx.token_symbol,
          amount: Number.isFinite(amount) ? amount : 0,
          direction: tx.to_address?.toLowerCase() === address.toLowerCase() ? "IN" : "OUT",
          timestamp: tx.block_timestamp, // Moralis returns ISO already
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
      tool: "whale-copy-signal",
      timestamp: new Date().toISOString(),
      chain: "base",
      chainId: 8453,
      address,
      data_source: "Moralis (live Base ERC-20 transfers)",
      transfers_analyzed: txs.length,
      topMovements,
      url: `https://basescan.org/address/${address}`,
    };

    // No real flow → no signal. Never fabricate one, never crash.
    if (!txs.length) {
      return Response.json({
        ...base,
        signal: "PASS",
        whale_activity: "neutral",
        confidence: 0,
        entry_timing: "no clear entry",
        patterns: [],
        summary: "No on-chain transfer data available for this address. Verify the address or retry shortly.",
        note: "No recent token transfers found on Base (or the data provider is unavailable). Nothing on-chain to copy right now.",
      });
    }

    // LLM synthesis is non-fatal: if it fails, still return the REAL on-chain
    // movements (topMovements) instead of 500-ing the whole tool.
    let analysis: Record<string, unknown> | null = null;
    try {
      analysis = parseJson(await llm(
        SYSTEM,
        `Wallet: ${address} (Base)\nRecent large transfers (real, on-chain):\n${JSON.stringify(topMovements, null, 2)}\nTotal transfers analysed: ${txs.length}`,
        0.3,
        600,
      ));
    } catch (e) {
      console.error("[WhaleCopy] LLM synthesis unavailable:", (e as Error).message);
    }

    if (!analysis) {
      return Response.json({
        ...base,
        signal: "WATCH",
        whale_activity: "neutral",
        confidence: 0,
        entry_timing: "no clear entry",
        patterns: [],
        summary: "On-chain transfers loaded — see topMovements for the real flow. Signal synthesis is briefly unavailable; retry for the read.",
        degraded: true,
      });
    }

    return Response.json({
      ...base,
      signal: analysis.signal ?? "WATCH",
      whale_activity: analysis.whale_activity ?? "neutral",
      confidence: analysis.confidence ?? 50,
      entry_timing: analysis.entry_timing ?? "wait for confirmation",
      patterns: analysis.patterns ?? [],
      summary: analysis.summary ?? "",
    });
  } catch (e) {
    return Response.json({ error: "Whale copy signal failed", message: (e as Error).message }, { status: 500 });
  }
}
