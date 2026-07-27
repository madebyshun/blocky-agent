// x402/risk-gate
// Transaction risk gate — pre-trade risk assessment before executing any tx on Base
// Price: $0.20 — verdict: PROCEED / CAUTION / ABORT

import { getTokenIdentity } from "@/lib/onchain";
import { callLLM } from "@/app/api/_lib/llm";

type Msg = { role: string; content: string };

// Bankr LLM (llm.bankr.bot) was 403-banned 2026-07-20 → route through callLLM
// (Virtuals). Signature/temperature defaults preserved so call sites are unchanged.
async function llm(system: string, user: string, temp = 0.2, tokens = 700): Promise<string> {
  return (await callLLM({ system, messages: [{ role: "user", content: user }] as Msg[], temperature: temp, maxTokens: tokens })).text;
}

function parseJson(t: string): Record<string, unknown> | null {
  let s = t.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
  const i = s.indexOf("{"), j = s.lastIndexOf("}");
  if (i >= 0 && j > i) s = s.slice(i, j + 1);
  try { return JSON.parse(s); } catch {
    try { return JSON.parse(s.replace(/[\x00-\x1F\x7F]/g, " ")); } catch { return null; }
  }
}

// Look up address type on Basescan
async function getAddressInfo(address: string): Promise<{
  isContract: boolean;
  verified: boolean;
  contractName: string | null;
  raw: string;
}> {
  const apiKey = process.env.BASESCAN_API_KEY ?? "";
  const base = "https://api.etherscan.io/v2/api?chainid=8453";
  const def = { isContract: false, verified: false, contractName: null, raw: "Basescan unavailable" };

  try {
    const res = await fetch(
      `${base}&module=contract&action=getsourcecode&address=${address}&apikey=${apiKey}`,
      { signal: AbortSignal.timeout(7000) }
    );
    if (!res.ok) return def;
    const data = await res.json() as { status: string; result?: { ContractName?: string; SourceCode?: string; ABI?: string }[] };
    if (data.status !== "1" || !data.result?.length) return def;
    const info   = data.result[0];
    const hasABI = info.ABI && info.ABI !== "Contract source code not verified";
    const verified = !!info.SourceCode && info.SourceCode.length > 0;
    return {
      isContract:   hasABI || verified,
      verified,
      contractName: info.ContractName ?? null,
      raw: `${verified ? `Verified contract: ${info.ContractName}` : "Contract source not verified or EOA"}.`,
    };
  } catch {
    return def;
  }
}

export default async function handler(req: Request): Promise<Response> {
  try {
    let body: { action?: string; to?: string; value?: string; data?: string; token?: string; amount?: string } = {};
    try {
      const t = await req.text();
      if (t?.trim().startsWith("{")) body = JSON.parse(t);
    } catch {}

    const url = new URL(req.url);
    // Accept `to` or `token` or `address` as the target
    const to     = (body.to ?? body.token ?? url.searchParams.get("to") ?? url.searchParams.get("token") ?? "").trim();
    const action = (body.action ?? url.searchParams.get("action") ?? "transfer").trim();
    const value  = body.value ?? body.amount ?? url.searchParams.get("value") ?? "";
    const data   = body.data ?? "";

    if (!to) {
      return Response.json({ error: "to address is required (target contract or wallet)" }, { status: 400 });
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(to)) {
      return Response.json({ error: "Invalid address format. Must be 0x + 40 hex chars." }, { status: 400 });
    }

    // Authoritative contract detection via on-chain eth_getCode, plus the
    // Basescan verification lookup (verified source / contract name) in parallel.
    // eth_getCode — not Basescan — decides EOA vs contract.
    const [addrInfo, identity] = await Promise.all([
      getAddressInfo(to),
      getTokenIdentity(to),
    ]);
    const isContract = identity?.isContract ?? addrInfo.isContract;
    const tokenDesc = identity?.isToken
      ? `Target is an ERC-20 token: ${identity.name ?? "?"} (${identity.symbol ?? "?"})`
      : isContract ? "Target is a smart contract (non-token or unrecognized)" : "Target is an externally-owned account (EOA / wallet)";

    const txCtx = `
Transaction details (Base mainnet, chain ID 8453):
Action: ${action}
Target address: ${to}
Value: ${value || "0 ETH"}
Calldata present: ${data ? "yes" : "no"}
Target type (from on-chain eth_getCode — authoritative): ${isContract ? "contract" : "EOA"}
${tokenDesc}
Basescan source verified: ${addrInfo.verified}
Contract name: ${addrInfo.contractName ?? "unknown"}
${addrInfo.raw}
`.trim();

    // Blue risk assessment + MiroShark AML signal in parallel
    const [blueRaw, msRaw] = await Promise.all([
      llm(
        `You are Blue Agent — transaction risk guard for Base (chain ID 8453).
Assess the risk of this transaction BEFORE it is executed.
Focus on: malicious contract patterns, phishing addresses, unusual calldata, AML red flags, drain/approval abuse, known attack vectors.

SCORE THE ACTION, NOT JUST THE TARGET (critical — avoid false ABORTs):
- Risk is about what THIS transaction does. A read-only action (e.g. "scan", "read", "view") and any transaction with value 0 AND no calldata transfers nothing and executes nothing — score it low (0-20) regardless of the target's verification status.
- Unverified source code is common for legitimate tokens and is NOT, by itself, grounds for CAUTION or ABORT. Do not raise the score solely because the target is unverified.
- Reserve high scores (>40) for transactions that actually move value, grant approvals, or execute calldata into a target with concrete red flags, and reserve ABORT (>70) for known drainers/phishing or clear drain/approval-abuse patterns.

CRITICAL: Return ONLY raw JSON. No markdown.
Schema: {
  "risk_score": <0-100>,
  "risk_level": "low|medium|high|critical",
  "red_flags": ["<flag>" or empty],
  "attack_vectors": ["<vector>" or empty],
  "aml_signals": ["<signal>" or empty],
  "assessment": "<2-3 sentences — is this transaction safe to execute?>"
}`,
        txCtx,
        0.2,
        600
      ),
      llm(
        `You are MiroShark — degen risk intelligence on Base.
Assess community risk signals for this transaction target — known drainer? phishing? rugpull history? suspicious contract?
CRITICAL: Return ONLY raw JSON. No markdown.
Schema: {
  "community_risk": "none|low|medium|high",
  "known_drainer": <boolean>,
  "known_phishing": <boolean>,
  "risk_signals": ["<signal>" or empty],
  "community_assessment": "<1-2 sentences>"
}`,
        txCtx,
        0.3,
        400
      ),
    ]);

    const blue = parseJson(blueRaw) ?? {
      risk_score: 50,
      risk_level: "medium",
      red_flags: [],
      attack_vectors: [],
      aml_signals: [],
      assessment: "Unable to fully assess risk. Proceed with caution.",
    };

    const ms = parseJson(msRaw) ?? {
      community_risk: "medium",
      known_drainer: false,
      known_phishing: false,
      risk_signals: [],
      community_assessment: "No community data available.",
    };

    const riskScore = (blue.risk_score ?? 50) as number;
    const knownBad  = ms.known_drainer || ms.known_phishing;
    const verdict   = knownBad || riskScore > 70 ? "ABORT" : riskScore > 40 ? "CAUTION" : "PROCEED";
    const action_out = verdict === "ABORT" ? "DO_NOT_EXECUTE" : verdict === "CAUTION" ? "REVIEW_CAREFULLY" : "SAFE_TO_EXECUTE";

    return Response.json({
      tool: "risk-gate",
      timestamp: new Date().toISOString(),
      transaction: {
        action,
        to,
        value: value || "0",
        hasCalldata: !!data,
      },
      chain: "base",
      chainId: 8453,
      target: {
        isContract,
        verified:   addrInfo.verified,
        contractName: addrInfo.contractName ?? (identity?.isToken ? `${identity.name ?? ""} (${identity.symbol ?? ""})`.trim() : null),
        url: `https://basescan.org/address/${to}`,
      },
      verdict,
      action: action_out,
      risk_score:  riskScore,
      risk_level:  blue.risk_level ?? "medium",
      red_flags:   blue.red_flags ?? [],
      attack_vectors: blue.attack_vectors ?? [],
      aml_signals: blue.aml_signals ?? [],
      community: {
        risk:         ms.community_risk ?? "medium",
        known_drainer: ms.known_drainer ?? false,
        known_phishing: ms.known_phishing ?? false,
        risk_signals: ms.risk_signals ?? [],
        assessment:   ms.community_assessment ?? "",
      },
      assessment: blue.assessment ?? "",
    });
  } catch (error) {
    console.error("[RiskGate]", error);
    return Response.json(
      { error: "Risk gate check failed", message: (error as Error).message },
      { status: 500 }
    );
  }
}
