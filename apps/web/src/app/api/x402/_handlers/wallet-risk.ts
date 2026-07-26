// x402/wallet-risk — on-chain risk profile for any Base wallet
// Price: $0.15 — counts computed in code, risk_score/flags from the LLM over real
// Moralis tx data. Verdict is hard-mapped from the score, never LLM-chosen.

import { getMoralisNativeTx, getMoralisERC20Transfers } from "@/lib/moralis";
import { callLLM } from "@/app/api/_lib/llm";

type BankrMessage = { role: string; content: string };

async function callBankrLLM(opts: {
  model?: string; system: string; messages: BankrMessage[];
  temperature?: number; maxTokens?: number;
}): Promise<string> {
  return (await callLLM({ system: opts.system, messages: opts.messages, temperature: opts.temperature, maxTokens: opts.maxTokens })).text;
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  let raw = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
  const s = raw.indexOf("{"), e = raw.lastIndexOf("}");
  if (s >= 0 && e > s) raw = raw.slice(s, e + 1);
  try { return JSON.parse(raw); } catch {}
  try { return JSON.parse(raw.replace(/[\x00-\x1F\x7F]/g, " ")); } catch {}
  return null;
}

const SYSTEM = `You are a Base chain analyst assessing wallet risk from on-chain activity. Use ONLY the data provided. NEVER invent numbers, addresses, or token names not in the data. Return ONLY raw JSON starting with {. No markdown. If data unavailable, return field as null — never estimate.

You are given a wallet's transaction profile (counts already computed). Assess risk patterns: mixer/tumbler interaction, structuring (many small round-number transfers), rapid layering, spam-token dusting, ties to known-risky behaviour, abnormal velocity.

Return ONLY raw JSON:
{
  "risk_score": number (0-100, higher = riskier; null if you cannot assess),
  "flags": ["short risk flag", "..."],
  "aml_signals": ["specific AML pattern observed", "..."]
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

    console.log(`[WalletRisk] Profiling: ${address}`);

    const [nativeTxs, tokenTxs] = await Promise.all([
      getMoralisNativeTx(address, 100).catch(() => []),
      getMoralisERC20Transfers(address, 100).catch(() => []),
    ]);

    type Tx = { from_address?: string; to_address?: string; value?: string; block_timestamp?: string; receipt_status?: string };
    type TokenTx = { from_address?: string; to_address?: string; token_symbol?: string; possible_spam?: boolean };

    const cleanTokenTxs = (tokenTxs as TokenTx[]).filter((t) => !t.possible_spam);

    // Counts computed in CODE — never trusted to the LLM.
    const tx_count = (nativeTxs as Tx[]).length + cleanTokenTxs.length;

    const counterparties = new Set<string>();
    const self = address.toLowerCase();
    for (const t of nativeTxs as Tx[]) {
      if (t.from_address && t.from_address.toLowerCase() !== self) counterparties.add(t.from_address.toLowerCase());
      if (t.to_address && t.to_address.toLowerCase() !== self) counterparties.add(t.to_address.toLowerCase());
    }
    for (const t of cleanTokenTxs) {
      if (t.from_address && t.from_address.toLowerCase() !== self) counterparties.add(t.from_address.toLowerCase());
      if (t.to_address && t.to_address.toLowerCase() !== self) counterparties.add(t.to_address.toLowerCase());
    }
    const unique_counterparties = counterparties.size;

    // No history → honest indeterminate result, no LLM call, no fabricated score.
    if (tx_count === 0) {
      return Response.json({
        tool: "wallet-risk",
        address,
        risk_score: null,
        verdict: "CLEAN",
        flags: [],
        tx_count: 0,
        unique_counterparties: 0,
        aml_signals: [],
        note: "No on-chain transaction history found (fresh wallet or data unavailable). Nothing to assess yet.",
        data_source: "Moralis",
        timestamp: new Date().toISOString(),
      });
    }

    const profile = {
      tx_count,
      unique_counterparties,
      spam_token_transfers: (tokenTxs as TokenTx[]).length - cleanTokenTxs.length,
      token_symbols: [...new Set(cleanTokenTxs.map((t) => t.token_symbol).filter(Boolean))].slice(0, 12),
      recent_native: (nativeTxs as Tx[]).slice(0, 8).map((t) => ({
        direction: t.from_address?.toLowerCase() === self ? "OUT" : "IN",
        value_wei: t.value ?? null,
        status: t.receipt_status ?? null,
        timestamp: t.block_timestamp ? new Date(t.block_timestamp).toISOString() : null,
      })),
    };

    const llmResponse = await callBankrLLM({
      system: SYSTEM,
      messages: [{ role: "user", content: `Assess risk for Base wallet ${address}.\n\nComputed profile (counts are authoritative — do not recompute):\n${JSON.stringify(profile, null, 2)}` }],
      temperature: 0.2,
      maxTokens: 600,
    });

    const parsed = extractJsonObject(llmResponse);

    // risk_score: clamp to 0-100, else null. flags/aml_signals: arrays or [].
    let risk_score: number | null = null;
    if (parsed && typeof parsed.risk_score === "number" && Number.isFinite(parsed.risk_score)) {
      risk_score = Math.max(0, Math.min(100, Math.round(parsed.risk_score)));
    }
    const flags = parsed && Array.isArray(parsed.flags) ? (parsed.flags as unknown[]).map(String) : [];
    const aml_signals = parsed && Array.isArray(parsed.aml_signals) ? (parsed.aml_signals as unknown[]).map(String) : [];

    // Verdict hard-mapped from score in CODE — deterministic, never LLM-chosen.
    let verdict: "CLEAN" | "SUSPICIOUS" | "HIGH_RISK";
    if (risk_score == null) verdict = "CLEAN";
    else if (risk_score >= 70) verdict = "HIGH_RISK";
    else if (risk_score >= 40) verdict = "SUSPICIOUS";
    else verdict = "CLEAN";

    const out: Record<string, unknown> = {
      tool: "wallet-risk",
      address,
      risk_score,
      verdict,
      flags,
      tx_count,
      unique_counterparties,
      aml_signals,
      data_source: "Moralis",
      timestamp: new Date().toISOString(),
    };
    if (!parsed) out.note = "Risk synthesis briefly unavailable — counts are real; risk_score not assessed. Please retry.";
    return Response.json(out);
  } catch (error) {
    console.error("[WalletRisk] Error:", error);
    return Response.json(
      { error: "Wallet risk analysis failed", message: (error as Error).message },
      { status: 500 }
    );
  }
}
