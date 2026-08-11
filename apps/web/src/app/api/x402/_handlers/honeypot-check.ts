// x402/honeypot-check
// Honeypot token detection — checks if a token can be bought but not sold on Base
// Price: $0.10 — verdict: SAFE / HONEYPOT / SUSPICIOUS

import { getTokenIdentity, tokenIdentityToPrompt } from "@/lib/onchain";
import { callLLM } from "@/app/api/_lib/llm";

type Msg = { role: string; content: string };

// Bankr LLM (llm.bankr.bot) was 403-banned 2026-07-20 → route through callLLM
// (Virtuals). Signature/temperature defaults preserved so call sites are unchanged.
async function llm(system: string, user: string, temp = 0.2, tokens = 600): Promise<string> {
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

// Fetch token info from Basescan
async function getTokenInfo(address: string): Promise<{
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  verified: boolean;
  contractName: string | null;
  raw: string;
}> {
  const apiKey = process.env.BASESCAN_API_KEY ?? "";
  const base = "https://api.etherscan.io/v2/api?chainid=8453";
  const def = { name: null, symbol: null, decimals: null, verified: false, contractName: null, raw: "Basescan unavailable" };

  try {
    const [tokenRes, srcRes] = await Promise.all([
      fetch(`${base}&module=token&action=tokeninfo&contractaddress=${address}&apikey=${apiKey}`, { signal: AbortSignal.timeout(8000) }),
      fetch(`${base}&module=contract&action=getsourcecode&address=${address}&apikey=${apiKey}`, { signal: AbortSignal.timeout(8000) }),
    ]);

    let name: string | null = null, symbol: string | null = null, decimals: number | null = null;
    if (tokenRes.ok) {
      const td = await tokenRes.json() as { status: string; result?: { tokenName?: string; symbol?: string; divisor?: string }[] };
      if (td.status === "1" && td.result?.length) {
        name    = td.result[0].tokenName ?? null;
        symbol  = td.result[0].symbol ?? null;
        decimals = td.result[0].divisor ? parseInt(td.result[0].divisor) : null;
      }
    }

    let verified = false, contractName: string | null = null;
    if (srcRes.ok) {
      const sd = await srcRes.json() as { status: string; result?: { ContractName?: string; SourceCode?: string }[] };
      if (sd.status === "1" && sd.result?.length) {
        verified = !!sd.result[0].SourceCode && sd.result[0].SourceCode.length > 0;
        contractName = sd.result[0].ContractName ?? null;
      }
    }

    const raw = `Token: ${name ?? "unknown"} (${symbol ?? "???"}) | Verified: ${verified} | Contract: ${contractName ?? "unknown"}`;
    return { name, symbol, decimals, verified, contractName, raw };
  } catch {
    return def;
  }
}

export default async function handler(req: Request): Promise<Response> {
  try {
    let body: { token?: string; address?: string } = {};
    try {
      const t = await req.text();
      if (t?.trim().startsWith("{")) body = JSON.parse(t);
    } catch {}

    const url = new URL(req.url);
    const address = (body.token ?? body.address ?? url.searchParams.get("token") ?? url.searchParams.get("address") ?? "").trim();

    if (!address) {
      return Response.json({ error: "token address is required" }, { status: 400 });
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
      return Response.json({ error: "Invalid address format. Must be 0x + 40 hex chars." }, { status: 400 });
    }

    // Authoritative on-chain identity (eth_getCode + ERC-20 metadata + live
    // DexScreener liquidity) alongside the Basescan verification lookup.
    const [identity, tokenInfo] = await Promise.all([
      getTokenIdentity(address),
      getTokenInfo(address),
    ]);

    // Guard: there is nothing to honeypot-check unless the address is an actual
    // ERC-20 token. An EOA (wallet) has no code; a non-token contract (liquidity
    // pool, router, multisig) has code but no ERC-20 transfer surface. In both
    // cases the LLM would read "no token metadata" as honeypot red flags and
    // return a dangerous false "HONEYPOT". Short-circuit to a clean NOT_A_TOKEN.
    if (identity && identity.isToken === false) {
      const isEOA = identity.isContract === false;
      return Response.json({
        tool: "honeypot-check",
        timestamp: new Date().toISOString(),
        address,
        chain: "base",
        chainId: 8453,
        token: { name: identity.name, symbol: identity.symbol, decimals: identity.decimals, verified: tokenInfo.verified, url: `https://basescan.org/address/${address}` },
        verdict: "NOT_A_TOKEN",
        action: "N/A",
        confidence: 0,
        is_honeypot: false,
        sell_tax_estimate: "n/a",
        buy_tax_estimate: "n/a",
        red_flags: [],
        green_flags: [],
        honeypot_patterns: [],
        community: { alert: "none", known_rug: false, rug_patterns: [], signal: "" },
        assessment: isEOA
          ? "This address is an externally-owned account (EOA / normal wallet), not a token contract — there is nothing to honeypot-check. Pass a token CONTRACT address to scan a token."
          : `This is a non-token contract${tokenInfo.contractName ? ` (${tokenInfo.contractName})` : ""} — infrastructure such as a liquidity pool or router, not an ERC-20 token. A honeypot check only applies to tradeable tokens.`,
      });
    }

    const tokenCtx = `
${identity ? tokenIdentityToPrompt(identity) : `Token address: ${address} (Base, chain 8453). On-chain identity read unavailable — do NOT assume EOA.`}

Basescan: source verified = ${tokenInfo.verified}, contract name = ${tokenInfo.contractName ?? "unknown"}. (An unverified source is common for legitimate tokens and is NOT, by itself, a honeypot signal.)
`.trim();

    // Run Blue Agent honeypot analysis + MiroShark degen signal in parallel
    const [blueRaw, msRaw] = await Promise.all([
      llm(
        `You are Blue Agent — token security specialist for Base (chain ID 8453).
Analyze whether this token is a honeypot (buy works, sell blocked or taxed to 100%).
Key honeypot patterns: trading disabled post-launch, massive sell tax (>50%), blacklist abuse, ownership not renounced with dangerous functions, transfer() reverts on sell.

EVIDENCE RULES (critical — avoid false positives):
- Only set is_honeypot=true when there is CONCRETE evidence of a sell restriction (sell blocked, sell tax >50%, blacklist, trading disabled, or a known rug). With no such evidence, set is_honeypot=false.
- Missing Basescan verification, missing metadata, or an unfamiliar token name is NOT evidence of a honeypot. Do NOT flag on absence of information.
- Healthy two-sided DEX liquidity and real 24h volume (in the context) are strong evidence the token is tradeable — weight them as green flags, not red.
- Do NOT invent tax numbers. If you cannot determine a tax, use "unknown" — never "extreme".
- Set confidence to reflect EVIDENCE strength, not how scary the unknowns feel.

CRITICAL: Return ONLY raw JSON. No markdown.
Schema: {
  "is_honeypot": <boolean>,
  "confidence": <0-100>,
  "sell_tax_estimate": "<0%|high|extreme|unknown>",
  "buy_tax_estimate": "<0%|low|high|unknown>",
  "red_flags": ["<flag>" or empty],
  "green_flags": ["<flag>" or empty],
  "honeypot_patterns": ["<pattern>" or empty],
  "assessment": "<2 sentences — is this safe to trade?>"
}`,
        tokenCtx,
        0.2,
        500
      ),
      llm(
        `You are MiroShark — degen intelligence on Base.
Give community signal on this token — is it a known rug/honeypot? Any red flags from the community? Known scam patterns?
CRITICAL: Return ONLY raw JSON. No markdown.
Schema: {
  "community_alert": "none|watch|danger",
  "known_rug": <boolean>,
  "rug_patterns": ["<pattern>" or empty],
  "community_signal": "<1-2 sentences>"
}`,
        tokenCtx,
        0.3,
        300
      ),
    ]);

    const hasLiquidity = (identity?.market?.liquidityUsd ?? 0) > 0;
    const blue = parseJson(blueRaw) ?? {
      is_honeypot: false,
      confidence: 50,
      sell_tax_estimate: "unknown",
      buy_tax_estimate: "unknown",
      red_flags: [],
      green_flags: [
        ...(tokenInfo.verified ? ["source verified on Basescan"] : []),
        ...(hasLiquidity ? ["active DEX liquidity on Base"] : []),
      ],
      honeypot_patterns: [],
      assessment: "Automated honeypot analysis was inconclusive (no concrete sell-block evidence found). This is not a honeypot verdict — verify liquidity and try a small test sell before trading.",
    };

    const ms = parseJson(msRaw) ?? {
      community_alert: "watch",
      known_rug: false,
      rug_patterns: [],
      community_signal: "No community data available.",
    };

    // Final verdict
    const isHoneypot   = blue.is_honeypot || ms.known_rug;
    const confidence   = (blue.confidence ?? 50) as number;
    const verdict      = isHoneypot ? "HONEYPOT" : confidence >= 70 ? "SAFE" : "SUSPICIOUS";
    const action       = verdict === "HONEYPOT" ? "DO_NOT_BUY" : verdict === "SUSPICIOUS" ? "DYOR" : "SAFE_TO_TRADE";

    return Response.json({
      tool: "honeypot-check",
      timestamp: new Date().toISOString(),
      address,
      chain: "base",
      chainId: 8453,
      token: {
        name: identity?.name ?? tokenInfo.name,
        symbol: identity?.symbol ?? tokenInfo.symbol,
        decimals: identity?.decimals ?? tokenInfo.decimals,
        verified: tokenInfo.verified,
        liquidityUsd: identity?.market?.liquidityUsd ?? null,
        url: `https://basescan.org/address/${address}`,
      },
      verdict,
      action,
      confidence,
      is_honeypot: isHoneypot,
      sell_tax_estimate: blue.sell_tax_estimate ?? "unknown",
      buy_tax_estimate:  blue.buy_tax_estimate  ?? "unknown",
      red_flags:         blue.red_flags ?? [],
      green_flags:       blue.green_flags ?? [],
      honeypot_patterns: blue.honeypot_patterns ?? [],
      community: {
        alert:   ms.community_alert ?? "watch",
        known_rug: ms.known_rug ?? false,
        rug_patterns: ms.rug_patterns ?? [],
        signal:  ms.community_signal ?? "",
      },
      assessment: blue.assessment ?? "",
    });
  } catch (error) {
    console.error("[HoneypotCheck]", error);
    return Response.json(
      { error: "Honeypot check failed", message: (error as Error).message },
      { status: 500 }
    );
  }
}
