// x402/b20-check — detect B20 (compliance-aware ERC-20) patterns in a verified
// Base contract's source. Price: $0.20 — LLM analyses real Basescan source only.
//
// Native B20 tokens (deployed via B20Factory) are Rust precompiles with NO Solidity
// source on Basescan. We detect them first via the B20Factory isB20() on-chain check
// and route to inspectB20 — never fabricate analysis for them via LLM.

import { getBasescanSource } from "@/lib/moralis";
import { callLLM } from "@/app/api/_lib/llm";
import { inspectB20 } from "@/lib/b20/inspect";

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

const SYSTEM = `You are a Base chain analyst inspecting a Solidity contract source for "B20" patterns — a compliance-aware ERC-20 (ERC-20 plus on-chain compliance roles and transfer policies). Use ONLY the source provided. NEVER invent functions, roles, or token names not in the source. Return ONLY raw JSON starting with {. No markdown. If data unavailable, return field as null — never estimate.

B20 indicators to look for in the source:
- Compliance ROLES: e.g. COMPLIANCE_ROLE, ISSUER_ROLE, AGENT_ROLE, MINTER_ROLE, FREEZER_ROLE, UPGRADER_ROLE, AccessControl/Ownable role grants.
- Transfer POLICIES: allowlist/whitelist (isWhitelisted, kycVerified), blocklist/blacklist, transfer freezing (freeze/pause/forcedTransfer), identity registry (onchainID, claimTopics), region/lockup restrictions, canTransfer/_beforeTokenTransfer compliance hooks.
- Variant: "Asset" (security/RWA-style token with identity + transfer restrictions), "Stablecoin" (mint/burn + blacklist + pause, fiat-backed style), "Unknown" (compliance roles present but variant unclear), "Not B20" (plain ERC-20 with no compliance layer).

Return ONLY raw JSON:
{
  "is_b20": boolean,
  "b20_variant": "Asset" | "Stablecoin" | "Unknown" | "Not B20",
  "roles_detected": ["role name from source", "..."],
  "policies_detected": ["policy/restriction from source", "..."],
  "compliance_score": number (0-100, how complete the compliance layer is; null if cannot assess),
  "recommendation": "string (one-line assessment for an integrator)"
}`;

export default async function handler(req: Request): Promise<Response> {
  try {
    let body: { contract?: string } = {};
    try {
      const text = await req.text();
      if (text?.trim().startsWith("{")) body = JSON.parse(text);
    } catch {}
    const url = new URL(req.url);
    if (!body.contract) {
      body.contract = url.searchParams.get("contract") || url.searchParams.get("address") || undefined;
    }

    const { contract } = body;
    if (!contract || !/^0x[a-fA-F0-9]{40}$/.test(contract)) {
      return Response.json({ error: "Provide a valid contract address (0x...)" }, { status: 400 });
    }

    console.log(`[B20Check] Inspecting: ${contract}`);

    // ── Native B20 gate ────────────────────────────────────────────────────────
    // Native B20 tokens (deployed via B20Factory) are Rust precompiles — they
    // have NO Solidity source on Basescan. LLM source analysis would fabricate.
    // Check B20Factory.isB20() first; if true, return real on-chain data from
    // inspectB20 and skip the source/LLM path entirely.
    // Try mainnet first; fall back to sepolia for testnet addresses.
    let nativeB20Check: Awaited<ReturnType<typeof inspectB20>> | null = null;
    try {
      const mainnetCheck = await inspectB20(contract, "mainnet");
      if (mainnetCheck.isB20) {
        nativeB20Check = mainnetCheck;
      } else {
        // Try sepolia — some deployments are testnet-only
        const sepoliaCheck = await inspectB20(contract, "sepolia");
        if (sepoliaCheck.isB20) nativeB20Check = sepoliaCheck;
      }
    } catch { /* network error — fall through to source path */ }

    if (nativeB20Check?.isB20) {
      const info = nativeB20Check;
      return Response.json({
        tool:           "b20-check",
        contract,
        is_b20:         true,
        native_b20:     true,
        network:        info.network,
        b20_variant:    info.variant ?? "UNKNOWN",
        name:           info.name ?? null,
        symbol:         info.symbol ?? null,
        decimals:       info.decimals ?? null,
        total_supply:   info.totalSupplyFormatted ?? null,
        supply_cap:     info.supplyCapFormatted ?? null,
        paused:         info.paused ?? null,
        policies:       info.policies ?? null,
        roles_detected: [],   // roles not enumerable on native B20 (no AccessControlEnumerable)
        policies_detected: info.policies
          ? Object.entries(info.policies)
              .filter(([, p]) => p.restricted)
              .map(([scope, p]) => `${scope}: policyId ${p.policyId}`)
          : [],
        compliance_score: null,
        recommendation: `Native B20 token (${info.variant ?? "unknown variant"}) — use hub_b20_inspect for full on-chain state. Source-based analysis does not apply (no Solidity source — it's a Rust node precompile).`,
        data_source:    "B20Factory.isB20() + on-chain multicall",
        explorer_url:   info.explorerUrl,
        note:           info._note,
        timestamp:      new Date().toISOString(),
      });
    }

    // ── Non-native path: source + LLM analysis ────────────────────────────────
    const source = await getBasescanSource(contract).catch(() => null);
    const sourceCode = typeof source?.SourceCode === "string" ? source.SourceCode : "";
    const contractName = typeof source?.ContractName === "string" ? source.ContractName : null;
    const abi = typeof source?.ABI === "string" ? source.ABI : "";

    // No verified source → honest "Unknown", no LLM, no fabricated detection.
    if (!sourceCode || sourceCode.trim() === "" || abi === "Contract source code not verified") {
      return Response.json({
        tool: "b20-check",
        contract,
        is_b20: false,
        b20_variant: "Unknown",
        roles_detected: [],
        policies_detected: [],
        compliance_score: null,
        recommendation: "Contract source is not verified on Basescan, so B20 compliance patterns cannot be inspected. Re-run once the source is verified.",
        note: "Verified contract source unavailable.",
        timestamp: new Date().toISOString(),
      });
    }

    // Cap source size sent to the LLM to stay within token budget.
    const snippet = sourceCode.slice(0, 14000);

    const llmResponse = await callBankrLLM({
      system: SYSTEM,
      messages: [{ role: "user", content: `Contract: ${contract}${contractName ? `\nName: ${contractName}` : ""}\n\nVerified Solidity source (truncated if long):\n${snippet}` }],
      temperature: 0.2,
      maxTokens: 700,
    });

    const parsed = extractJsonObject(llmResponse);
    if (!parsed) {
      return Response.json({
        tool: "b20-check",
        contract,
        is_b20: false,
        b20_variant: "Unknown",
        roles_detected: [],
        policies_detected: [],
        compliance_score: null,
        recommendation: "Analysis synthesis briefly unavailable — source was read but not analysed. Please retry.",
        degraded: true,
        note: "Synthesis briefly unavailable - please retry.",
        timestamp: new Date().toISOString(),
      });
    }

    const variantRaw = String(parsed.b20_variant ?? "Unknown");
    const b20_variant = (["Asset", "Stablecoin", "Unknown", "Not B20"].includes(variantRaw)
      ? variantRaw
      : "Unknown") as "Asset" | "Stablecoin" | "Unknown" | "Not B20";

    let compliance_score: number | null = null;
    if (typeof parsed.compliance_score === "number" && Number.isFinite(parsed.compliance_score)) {
      compliance_score = Math.max(0, Math.min(100, Math.round(parsed.compliance_score)));
    }

    return Response.json({
      tool: "b20-check",
      contract,
      is_b20: parsed.is_b20 === true,
      b20_variant,
      roles_detected: Array.isArray(parsed.roles_detected) ? (parsed.roles_detected as unknown[]).map(String) : [],
      policies_detected: Array.isArray(parsed.policies_detected) ? (parsed.policies_detected as unknown[]).map(String) : [],
      compliance_score,
      recommendation: typeof parsed.recommendation === "string" ? parsed.recommendation : "",
      contract_name: contractName,
      data_source: "Basescan (verified source)",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[B20Check] Error:", error);
    return Response.json(
      { error: "B20 check failed", message: (error as Error).message },
      { status: 500 }
    );
  }
}
