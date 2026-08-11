// x402/key-exposure — Check if wallet's public key is exposed on-chain
// Price: $0.50 — exposure verdict is computed from the real on-chain nonce
// (getTransactionCount). The LLM only writes the human-readable prose; it can
// never fabricate the exposed/txCount facts.

import { getWalletSnapshot } from "@/lib/onchain";
import { callLLM } from "@/app/api/_lib/llm";

type BankrMessage = { role: string; content: string };

// Bankr LLM (llm.bankr.bot) was 403-banned 2026-07-20 → route this local
// helper through callLLM (Virtuals). Signature kept so call sites are
// unchanged; the original 0.5 temperature default is preserved.
async function callBankrLLM(opts: {
  model?: string; system: string; messages: BankrMessage[];
  temperature?: number; maxTokens?: number;
}): Promise<string> {
  return (await callLLM({
    system: opts.system,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.5,
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

async function getBasescanTxList(address: string, limit = 100): Promise<unknown[]> {
  const key = process.env.BASESCAN_API_KEY ?? "";
  try {
    const res = await fetch(
      `https://api.etherscan.io/v2/api?chainid=8453&module=account&action=txlist&address=${address}&sort=desc&offset=${limit}&apikey=${key}`,
      { signal: AbortSignal.timeout(8000) }
    );
    const data = await res.json() as { status: string; result?: unknown[] };
    return data.status === "1" ? (data.result ?? []) : [];
  } catch {
    return [];
  }
}

const SYSTEM = `You are a quantum cryptography expert explaining whether an Ethereum/Base wallet's public key is exposed on-chain.

Facts (already determined from the chain — do NOT contradict them):
- When a wallet SENDS a transaction, the ECDSA signature reveals its public key. The account nonce is the exact count of sent transactions.
- nonce > 0 ⇒ public key is exposed on-chain (permanently). nonce = 0 ⇒ never sent ⇒ public key NOT exposed.
- An exposed public key is only a THEORETICAL future risk: no quantum computer can derive a private key from it today (CRQC estimated 5-15 years away).

You will be given the authoritative verdict and counts. Write ONLY the prose fields, in plain language for a non-technical user. Return ONLY valid JSON:
{ "explanation": "2-3 sentences explaining what the verdict means", "recommendation": "1-2 sentences of practical advice" }`;

export default async function handler(req: Request): Promise<Response> {
  try {
    let body: { address?: string; chain?: string } = {};
    try {
      const text = await req.text();
      if (text?.trim().startsWith("{")) body = JSON.parse(text);
    } catch {}
    const url = new URL(req.url);
    if (!body.address) body.address = url.searchParams.get("address") || undefined;
    if (!body.chain) body.chain = url.searchParams.get("chain") || "base";

    const { address } = body;
    if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
      return Response.json({ error: "Provide a valid wallet address (0x...)" }, { status: 400 });
    }

    console.log(`[KeyExposure] Checking: ${address}`);

    // AUTHORITATIVE: the account nonce (outgoing tx count) comes from a direct
    // Base RPC read, not a capped Basescan page. nonce > 0 is irrefutable proof
    // the public key is exposed. We never infer "SAFE" from an empty Basescan
    // response — if the RPC read fails we say so instead of guessing.
    const snap = await getWalletSnapshot(address);
    if (!snap || snap.txCount === null) {
      return Response.json({
        address,
        degraded: true,
        riskLevel: "UNKNOWN",
        note: "Could not read the wallet nonce from Base RPC — exposure status is unavailable. Please retry.",
        disclaimer: "Quantum key-exposure risk is forward-looking and theoretical — no quantum computer can break ECDSA today.",
      }, { status: 200 });
    }

    const nonce = snap.txCount;            // = number of transactions SENT
    const exposed = nonce > 0;

    // Optional: first-exposure date from Basescan (non-authoritative; may be
    // empty if rate-limited — the exposed verdict above does not depend on it).
    let firstExposureDate: string | null = null;
    if (exposed) {
      const txs = await getBasescanTxList(address, 100);
      const outgoing = (txs as { from?: string; timeStamp?: string }[]).filter(
        tx => tx.from?.toLowerCase() === address.toLowerCase()
      );
      const firstOutgoing = outgoing.length > 0 ? outgoing[outgoing.length - 1] : null;
      if (firstOutgoing?.timeStamp) {
        firstExposureDate = new Date(parseInt(firstOutgoing.timeStamp) * 1000).toISOString();
      }
    }

    const riskLevel = exposed ? "EXPOSED" : "SAFE";
    const riskScore = exposed ? 55 : 5;            // theoretical/forward-looking, never "today" risk
    const migrationUrgency = exposed ? "OPTIONAL" : "NOT_NEEDED";

    // LLM writes prose only; all facts below are computed, so it cannot fabricate them.
    let prose: Record<string, unknown> = {};
    try {
      const llmResponse = await callBankrLLM({
        system: SYSTEM,
        messages: [{ role: "user", content: `Wallet: ${address}\nAuthoritative verdict: ${riskLevel}\nTransactions sent (nonce): ${nonce}\nPublic key exposed: ${exposed}\nFirst send date: ${firstExposureDate ?? "unknown"}\n\nWrite the explanation and recommendation.` }],
        temperature: 0.3,
        maxTokens: 400,
      });
      prose = extractJsonObject(llmResponse) ?? {};
    } catch { /* prose is optional — facts already computed */ }

    return Response.json({
      address,
      exposed,
      txCount: nonce,
      outgoingTxCount: nonce,
      firstExposureDate,
      riskLevel,
      riskScore,
      migrationUrgency,
      explanation: (prose.explanation as string) ?? (exposed
        ? `This wallet has sent ${nonce} transaction(s), so its public key is permanently visible on-chain. This is only a theoretical future risk — no quantum computer can derive your private key from it today.`
        : `This wallet has never sent a transaction (nonce 0), so its public key is not exposed on-chain — the strongest possible position against a future quantum attacker.`),
      recommendation: (prose.recommendation as string) ?? (exposed
        ? "No action needed today. If holding long-term, consider moving funds to a fresh never-sent wallet once Ethereum ships post-quantum signatures."
        : "Keep using fresh receive-only addresses for cold storage to preserve this unexposed state."),
      dataSource: "live Base RPC nonce (authoritative)",
      disclaimer: "Quantum key-exposure risk is forward-looking and theoretical — no quantum computer can break ECDSA (secp256k1) today. 'EXPOSED' means the public key is visible, not that funds are at immediate risk.",
    });
  } catch (error) {
    console.error("[KeyExposure] Error:", error);
    return Response.json({ error: "Key exposure check failed", message: (error as Error).message }, { status: 500 });
  }
}
