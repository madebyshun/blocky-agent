// x402/aml-screen — AML compliance screening for any wallet
// Price: $0.25 — heuristic screening grounded in real on-chain activity. Never
// returns a confident "CLEAN/APPROVE" from an empty data response.

import { getWalletSnapshot } from "@/lib/onchain";
import { getMoralisNativeTx, getMoralisERC20Transfers } from "@/lib/moralis";
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

async function getBasescanData(address: string) {
  const [nativeTxs, tokenTxs] = await Promise.all([
    getMoralisNativeTx(address, 100).catch(() => []),
    getMoralisERC20Transfers(address, 50).catch(() => []),
  ]);
  return {
    txs: nativeTxs,
    tokenTxs: tokenTxs.filter((t) => !t.possible_spam),
  };
}

const SYSTEM = `You are an AML (Anti-Money Laundering) compliance specialist analyzing blockchain wallets for financial crime risk.

Analyze transaction patterns for AML red flags:
- Structuring (many small transactions to avoid thresholds)
- Layering (rapid fund movement through multiple wallets)
- Mixer/tumbler interactions (Tornado Cash or similar)
- High-frequency transfers with round numbers
- Connections to known high-risk addresses
- Unusual transaction velocity
- Cross-chain bridge abuse

Note: This is an AI-based screening tool, not a regulatory compliance product. Results are indicative only.

Return ONLY valid JSON:

{
  "amlRisk": "LOW" | "MEDIUM" | "HIGH" | "CRITICAL",
  "riskScore": number (0-100),
  "verdict": "CLEAN" | "MONITOR" | "SUSPICIOUS" | "HIGH_RISK",
  "flags": ["flag1", "flag2"],
  "patterns": ["pattern1", "pattern2"],
  "transactionProfile": "string (brief description of wallet behavior)",
  "recommendedAction": "APPROVE" | "MANUAL_REVIEW" | "REJECT",
  "disclaimer": "AI screening only — not regulatory compliance",
  "recommendation": "string"
}`;

export default async function handler(req: Request): Promise<Response> {
  try {
    let body: { address?: string } = {};
    try {
      const text = await req.text();
      if (text?.trim().startsWith("{")) body = JSON.parse(text);
    } catch {}
    const url = new URL(req.url);
    if (!body.address) body.address = url.searchParams.get("address") || undefined;

    const { address } = body;
    if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
      return Response.json({ error: "Provide a valid wallet address (0x...)" }, { status: 400 });
    }

    console.log(`[AMLScreen] Screening: ${address}`);

    const [{ txs, tokenTxs }, snap] = await Promise.all([
      getBasescanData(address).catch(() => ({ txs: [], tokenTxs: [] })),
      getWalletSnapshot(address),
    ]);

    const nonce = snap?.txCount ?? null;   // authoritative outgoing-tx count (RPC)

    // Guard: if we could read NO transaction history at all, do not let the LLM
    // fabricate a confident "CLEAN / APPROVE". A wallet that genuinely never
    // transacted (nonce 0) has no behaviour to screen; a data-fetch failure is
    // even less screenable. Either way, return an honest indeterminate verdict.
    const hasData = txs.length > 0 || tokenTxs.length > 0;
    if (!hasData) {
      const neverTxd = nonce === 0;
      return Response.json({
        address,
        amlRisk: "UNKNOWN",
        riskScore: null,
        verdict: neverTxd ? "NO_HISTORY" : "INSUFFICIENT_DATA",
        flags: [],
        patterns: [],
        transactionProfile: neverTxd
          ? "Wallet has never sent a transaction (nonce 0) — no transaction behaviour exists to screen."
          : "On-chain transaction history could not be read (data source unavailable or rate-limited).",
        recommendedAction: "MANUAL_REVIEW",
        recommendation: neverTxd
          ? "Fresh/unused wallet — nothing to screen yet. Re-screen after it has on-chain activity."
          : "Transaction data was unavailable. Retry shortly before relying on this result.",
        disclaimer: "AI heuristic screening only — not a regulatory compliance product and not a sanctions-list check.",
        dataSource: "Basescan tx history + live Base RPC nonce",
      });
    }

    type Tx = { from_address?: string; to_address?: string; value?: string; block_timestamp?: string };
    type TokenTx = { token_symbol?: string };

    const profile = {
      totalSentTx_nonce: nonce,
      lastActivityDays: snap?.lastActivityDays ?? null,
      sampledTx: txs.length,
      uniqueCounterparties: new Set([...(txs as Tx[]).map(t => t.from_address), ...(txs as Tx[]).map(t => t.to_address)]).size,
      tokenTypes: [...new Set((tokenTxs as TokenTx[]).map(t => t.token_symbol))].slice(0, 10),
      recentActivity: (txs as Tx[]).slice(0, 5).map(tx => ({
        direction: tx.from_address?.toLowerCase() === address.toLowerCase() ? "OUT" : "IN",
        to: tx.to_address?.slice(0, 10),
        value: tx.value,
        timestamp: tx.block_timestamp ? new Date(tx.block_timestamp).toISOString() : null,
      })),
    };

    const llmResponse = await callBankrLLM({
      system: SYSTEM,
      messages: [{ role: "user", content: `AML screening for wallet: ${address}\n\nTransaction profile:\n${JSON.stringify(profile, null, 2)}\n\nAssess for money laundering risk patterns.` }],
      temperature: 0.2,
      maxTokens: 700,
    });
    let result = extractJsonObject(llmResponse);
    if (!result) result = { degraded: true, note: "Synthesis briefly unavailable - please retry." };
    return Response.json({ ...result, address, dataSource: "Basescan tx history + live Base RPC nonce" });
  } catch (error) {
    console.error("[AMLScreen] Error:", error);
    return Response.json({ error: "AML screening failed", message: (error as Error).message }, { status: 500 });
  }
}
