// x402/airdrop-check — Base airdrop eligibility check
// Price: $0.10 — heuristic eligibility grounded in real wallet activity; honest
// when a wallet has no activity or data is unreadable.

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

const SYSTEM = `You are a Base ecosystem airdrop analyst helping users identify their eligibility for upcoming and ongoing airdrops.

Analyze wallet activity to assess airdrop eligibility likelihood. Common airdrop criteria on Base:
- Protocol interaction history (Uniswap, Aerodrome, Morpho, Coinbase CDP, etc.)
- Transaction frequency and consistency
- Wallet age and activity patterns
- NFT holdings
- Liquidity provision history
- Bridge activity (Ethereum ↔ Base)
- Use of Coinbase products (Smart Wallet, OnchainKit)

Return ONLY valid JSON:

{
  "eligibilityScore": number (0-100, higher = more likely eligible for airdrops),
  "activityLevel": "INACTIVE" | "LOW" | "MODERATE" | "HIGH" | "POWER_USER",
  "likelyEligible": ["Protocol1 (reason)", "Protocol2 (reason)"],
  "activitySignals": ["signal1", "signal2", "signal3"],
  "weaknesses": ["missing activity1", "missing activity2"],
  "recommendations": ["action1 to improve eligibility", "action2"],
  "estimatedValue": "string (rough range, e.g. '$50-500 if eligible')",
  "topOpportunities": ["opportunity1", "opportunity2"],
  "summary": "2-3 sentence summary"
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

    console.log(`[AirdropCheck] Checking: ${address}`);

    const [{ txs, tokenTxs }, snap] = await Promise.all([
      getBasescanData(address).catch(() => ({ txs: [], tokenTxs: [] })),
      getWalletSnapshot(address),
    ]);

    // Guard: no readable activity → don't fabricate an eligibility score.
    const nonce = snap?.txCount ?? null;
    if (txs.length === 0 && tokenTxs.length === 0) {
      const neverActive = nonce === 0;
      return Response.json({
        address,
        eligibilityScore: neverActive ? 0 : null,
        activityLevel: "INACTIVE",
        likelyEligible: [],
        activitySignals: [],
        weaknesses: neverActive ? ["No on-chain activity — no protocol interactions to qualify for airdrops"] : [],
        recommendations: neverActive
          ? ["Start interacting with Base protocols (swap on Aerodrome/Uniswap, bridge funds, provide liquidity) to build an airdrop-eligible footprint."]
          : ["Transaction history could not be read (data source unavailable) — retry shortly."],
        estimatedValue: "n/a",
        topOpportunities: [],
        summary: neverActive
          ? "This wallet has no on-chain activity on Base, so there is nothing to qualify it for ecosystem airdrops yet."
          : "On-chain activity could not be read for this wallet; eligibility is indeterminate.",
        disclaimer: "Heuristic estimate only — airdrop criteria are set by each project and are usually unannounced. This is not a guarantee of any allocation.",
        dataSource: "Basescan tx history + live Base RPC nonce",
      });
    }

    type Tx = { to_address?: string };
    type TokenTx = { token_symbol?: string };

    const uniqueContracts = [...new Set((txs as Tx[]).map(tx => tx.to_address).filter(Boolean))].slice(0, 20);
    const uniqueTokens = [...new Set((tokenTxs as TokenTx[]).map(tx => tx.token_symbol))].slice(0, 15);

    const llmResponse = await callBankrLLM({
      system: SYSTEM,
      messages: [{ role: "user", content: `Analyze airdrop eligibility for Base wallet: ${address}\n\nOnchain activity:\n- Total transactions: ${txs.length}\n- Unique contracts interacted: ${uniqueContracts.length}\n- Tokens traded: ${uniqueTokens.join(", ")}\n- Contract addresses: ${uniqueContracts.slice(0, 10).join(", ")}\n\nAssess eligibility for Base ecosystem airdrops.` }],
      temperature: 0.5,
      maxTokens: 800,
    });
    let result = extractJsonObject(llmResponse);
    if (!result) result = { degraded: true, note: "Synthesis briefly unavailable - please retry." };
    return Response.json({
      ...result,
      address,
      dataSource: "Basescan tx history + live Base RPC nonce",
      disclaimer: "Heuristic estimate only — airdrop criteria are set by each project and usually unannounced. Not a guarantee of any allocation.",
    });
  } catch (error) {
    console.error("[AirdropCheck] Error:", error);
    return Response.json({ error: "Airdrop check failed", message: (error as Error).message }, { status: 500 });
  }
}
