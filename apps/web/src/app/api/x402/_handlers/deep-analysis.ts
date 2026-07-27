// x402/deep-analysis
// Deep project/token analysis — comprehensive security + market + fundamentals on Base
// Price: $0.50 — full due diligence in one call

import { getTokenIdentity, tokenIdentityToPrompt, scanSourceSignals } from "@/lib/onchain";
import { callLLM } from "@/app/api/_lib/llm";

type Msg = { role: string; content: string };

// Bankr LLM (llm.bankr.bot) was 403-banned 2026-07-20 → route through callLLM
// (Virtuals). Signature/temperature defaults preserved so call sites are unchanged.
async function llm(system: string, user: string, temp = 0.3, tokens = 1000): Promise<string> {
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

// Combined Basescan lookup: contract info + token info + verified-source signals
async function deepBasescanLookup(address: string): Promise<{
  isToken: boolean;
  tokenName: string | null;
  tokenSymbol: string | null;
  tokenDecimals: number | null;
  verified: boolean;
  contractName: string | null;
  compilerVersion: string | null;
  isProxy: boolean;
  implementationAddress: string | null;
  licenseType: string | null;
  sourceSignals: string[];
  raw: string;
}> {
  const apiKey = process.env.BASESCAN_API_KEY ?? "";
  const base = "https://api.etherscan.io/v2/api?chainid=8453";
  const def = {
    isToken: false, tokenName: null, tokenSymbol: null, tokenDecimals: null,
    verified: false, contractName: null, compilerVersion: null, isProxy: false,
    implementationAddress: null, licenseType: null, sourceSignals: [], raw: "Basescan unavailable",
  };

  try {
    const [srcRes, tokenRes] = await Promise.all([
      fetch(`${base}&module=contract&action=getsourcecode&address=${address}&apikey=${apiKey}`, { signal: AbortSignal.timeout(8000) }),
      fetch(`${base}&module=token&action=tokeninfo&contractaddress=${address}&apikey=${apiKey}`,  { signal: AbortSignal.timeout(8000) }),
    ]);

    let verified = false, contractName: string | null = null,
        compilerVersion: string | null = null, isProxy = false,
        implementationAddress: string | null = null, licenseType: string | null = null,
        sourceSignals: string[] = [];

    if (srcRes.ok) {
      const sd = await srcRes.json() as {
        status: string;
        result?: {
          ContractName?: string; CompilerVersion?: string; Proxy?: string;
          Implementation?: string; LicenseType?: string; SourceCode?: string;
        }[];
      };
      if (sd.status === "1" && sd.result?.length) {
        const info = sd.result[0];
        const srcBody = info.SourceCode ?? "";
        verified = srcBody.length > 0;
        contractName    = info.ContractName ?? null;
        compilerVersion = info.CompilerVersion ?? null;
        isProxy         = info.Proxy === "1";
        implementationAddress = info.Implementation && info.Implementation !== "0x0000000000000000000000000000000000000000"
          ? info.Implementation : null;
        licenseType = info.LicenseType ?? null;
        if (verified) sourceSignals = scanSourceSignals(srcBody);
      }
    }

    let isToken = false, tokenName: string | null = null,
        tokenSymbol: string | null = null, tokenDecimals: number | null = null;
    if (tokenRes.ok) {
      const td = await tokenRes.json() as { status: string; result?: { tokenName?: string; symbol?: string; divisor?: string }[] };
      if (td.status === "1" && td.result?.length) {
        isToken     = true;
        tokenName   = td.result[0].tokenName ?? null;
        tokenSymbol = td.result[0].symbol ?? null;
        tokenDecimals = td.result[0].divisor ? parseInt(td.result[0].divisor) : null;
      }
    }

    const raw = [
      isToken ? `Token: ${tokenName} (${tokenSymbol})` : "Not a token / contract",
      `Verified: ${verified}`,
      verified ? `Contract: ${contractName}, Compiler: ${compilerVersion}, License: ${licenseType ?? "none"}` : "Source not verified",
      isProxy ? `Proxy → ${implementationAddress}` : "Not a proxy",
    ].join(" | ");

    return { isToken, tokenName, tokenSymbol, tokenDecimals, verified, contractName, compilerVersion, isProxy, implementationAddress, licenseType, sourceSignals, raw };
  } catch {
    return def;
  }
}

export default async function handler(req: Request): Promise<Response> {
  try {
    let body: { token?: string; address?: string; context?: string } = {};
    try {
      const t = await req.text();
      if (t?.trim().startsWith("{")) body = JSON.parse(t);
    } catch {}

    const url = new URL(req.url);
    const address = (body.token ?? body.address ?? url.searchParams.get("token") ?? url.searchParams.get("address") ?? "").trim();
    const context = body.context ?? url.searchParams.get("context") ?? "";

    if (!address) {
      return Response.json({ error: "token/address is required (Base mainnet contract address)" }, { status: 400 });
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
      return Response.json({ error: "Invalid address format. Must be 0x + 40 hex chars." }, { status: 400 });
    }

    // Authoritative on-chain identity (eth_getCode + ERC-20 metadata + market)
    // runs alongside the Basescan verification/proxy lookup. The chain — not
    // Basescan — decides whether this is a contract or a token.
    const [identity, info] = await Promise.all([
      getTokenIdentity(address),
      deepBasescanLookup(address),
    ]);

    // EOA short-circuit: a plain wallet has no code to audit. Without this the
    // LLM reads "no metadata" as red flags and fabricates a BEARISH/AVOID 0/100
    // verdict on a normal wallet. Return an honest, neutral result instead.
    if (identity && identity.isContract === false) {
      return Response.json({
        tool: "deep-analysis",
        timestamp: new Date().toISOString(),
        address,
        chain: "base",
        chainId: 8453,
        token: { isToken: false, isContract: false, name: null, symbol: null, decimals: null, verified: false, contractName: null, isProxy: false, url: `https://basescan.org/address/${address}` },
        composite_score: null,
        verdict: "NOT_A_CONTRACT",
        action: "N/A",
        security:     { score: null, critical_risks: [], medium_risks: [], positive_signals: [], ownership_risk: "n/a", liquidity_risk: "n/a", audit_status: "n/a", summary: "This address is an externally-owned account (EOA / normal wallet), not a smart contract or token — there is no code to audit. For a wallet, use the wallet tools (PnL, AML, key-exposure) instead." },
        market:       { score: null, community_trust: "n/a", tokenomics_risk: "n/a", team_transparency: "n/a", narrative: "n/a", trading_signals: [], summary: "" },
        fundamentals: { score: null, holder_risk: "n/a", activity_level: "wallet", whale_concentration: "n/a", age_signal: "n/a", on_chain_signals: [], summary: "" },
      });
    }

    // Non-token contract short-circuit: the address HAS code but exposes no
    // ERC-20 metadata — it is infrastructure (liquidity pool, router, multisig,
    // factory), not a tradeable token. Token-level scoring (price/market/holders)
    // does not apply, so do NOT run the token LLM analysis — it produces a
    // misleading BEARISH/AVOID verdict and invents token risks for a legit
    // contract. Return an honest "not a token" result instead.
    if (identity && identity.isContract === true && identity.isToken === false) {
      const label = info.contractName ?? identity.name ?? "contract";
      return Response.json({
        tool: "deep-analysis",
        timestamp: new Date().toISOString(),
        address,
        chain: "base",
        chainId: 8453,
        token: { isToken: false, isContract: true, name: identity.name, symbol: identity.symbol, decimals: identity.decimals, verified: info.verified, contractName: info.contractName, isProxy: info.isProxy, url: `https://basescan.org/address/${address}` },
        composite_score: null,
        verdict: "NOT_A_TOKEN",
        action: "N/A",
        security:     { score: null, critical_risks: [], medium_risks: [], positive_signals: info.verified ? ["source verified on Basescan"] : [], ownership_risk: "n/a", liquidity_risk: "n/a", audit_status: "n/a", summary: `This is a${info.verified ? " verified" : ""} non-token contract${info.contractName ? ` (${label})` : ""} — infrastructure such as a liquidity pool, router, factory, or multisig, not an ERC-20 token. Token-level analysis (price, market, holders) does not apply. For contract security use Contract Trust; for pool metrics use LP Analyzer.` },
        market:       { score: null, community_trust: "n/a", tokenomics_risk: "n/a", team_transparency: "n/a", narrative: "infra", trading_signals: [], summary: "" },
        fundamentals: { score: null, holder_risk: "n/a", activity_level: "n/a", whale_concentration: "n/a", age_signal: "n/a", on_chain_signals: [], summary: "" },
      });
    }

    const onchain = identity ? tokenIdentityToPrompt(identity) : `Address: ${address} (Base, chain 8453). On-chain identity read unavailable — fall back to Basescan signals below; do NOT assume EOA.`;

    const ctx = `
GROUND TRUTH (from direct Base RPC reads — treat as authoritative, do NOT contradict): the on-chain section below is fact. If it says the address has bytecode, it IS a contract; never call it an "EOA" or "not a contract". Do NOT lower scores merely because Basescan source is unverified — that is common for legit tokens.

${onchain}

Basescan verification signals (supplementary — may lag or be empty for unverified / Uniswap-v4 tokens; absence is NOT proof the address is an EOA):
${info.raw}
Source verified on Basescan: ${info.verified}
Contract name: ${info.contractName ?? "unknown"}
Compiler: ${info.compilerVersion ?? "unknown"}
Proxy: ${info.isProxy ? `yes → ${info.implementationAddress}` : "no"}
${info.verified ? `
VERIFIED-SOURCE SCAN (facts read from the actual public source — each line is PRESENT or ABSENT; TRUST IT over any pattern guess):
${info.sourceSignals.map(x => `- ${x}`).join("\n")}
RULES:
- TRUST THE SCAN, do not speculate. If a function is marked ABSENT it is genuinely NOT in the code — NEVER write "pause/blacklist likely present (standard Ownable pattern)" when the scan says ABSENT. Only flag risks for items marked PRESENT.
- An owner-controlled / uncapped mint() that is PRESENT is a CONCRETE dilution / soft-rug risk → critical_risks (or high), never vague "unverified mint/burn".
- ABSENT admin levers are a POSITIVE for a token, NOT a risk. "No pausable", "no blacklist", "no fees/limits" mean the owner has FEWER censorship/rug levers — put them in positive_signals. NEVER list "no pausable" or "no blacklist" as a risk (do not argue "can't halt in emergency / can't freeze malicious addresses" — that is protocol-think, wrong for a plain ERC-20). Do not double-count an absence as both positive and risk.
- "Non-proxy / immutable" is NOT a safety guarantee against owner privileges; do not present it as offsetting an active owner power.
- audit_status: this tool does not search audit registries — use "unknown" and phrase it as "no public third-party audit found", do NOT assert "unaudited" as fact.` : ""}
${context ? `Additional context: ${context}` : ""}
`.trim();

    // 3-agent parallel deep analysis: Blue security + MiroShark market + Aeon fundamentals
    const [blueRaw, msRaw, aeonRaw] = await Promise.all([
      // Blue Agent: security deep dive
      llm(
        `You are Blue Agent — deep security analyst for Base (chain ID 8453).
Perform a comprehensive security analysis of this contract/token.
Cover: code quality signals, proxy risks, ownership/admin key risks, mint/burn abuse potential, liquidity lock status, transfer restrictions, known attack patterns.
CRITICAL: Return ONLY raw JSON. No markdown.
Schema: {
  "security_score": <0-100>,
  "critical_risks": ["<risk>" or empty],
  "medium_risks": ["<risk>" or empty],
  "positive_signals": ["<signal>" or empty],
  "ownership_risk": "low|medium|high|unknown",
  "liquidity_risk": "low|medium|high|unknown",
  "audit_status": "audited|unknown",
  "security_summary": "<3 sentences — key findings>"
}`,
        ctx,
        0.2,
        900
      ),
      // MiroShark: market + community signal
      llm(
        `You are MiroShark — market intelligence specialist for Base tokens.
Analyze market fundamentals and community signals for this token/contract.
Cover: trading activity patterns, community sentiment, social signals, tokenomics red flags, team transparency, narrative fit.
WHAT market_score MEANS: it is TRADEABILITY / market health — liquidity depth, real 24h volume, and price discovery, all present in the context. It is NOT a re-scoring of security or dilution/mint risk (the security agent already scores those; re-penalizing here double-counts). A token with deep two-sided liquidity and real volume gets a HIGH market_score (deep liquidity + real volume ⇒ ~70-85) EVEN IF it has tokenomics concerns — capture those separately in tokenomics_risk, do not let them sink market_score.
DATA DISCIPLINE (critical): team_transparency / narrative_alignment / community_trust are OFF-CHAIN signals NOT in the context. If you genuinely recognize the project from its name/symbol (e.g. a known protocol with a public team/whitepaper), state them from that knowledge; otherwise use "unknown". "unknown" is NEUTRAL — NEVER lower market_score because off-chain data is missing (a token not exposing off-chain context is a tool limitation, not a project flaw; otherwise every legit token gets a false BEARISH). Do not guess "partial"/"low"/"other" from absence of data. Price is a volatile snapshot, never a fixed price. market cap ≠ FDV — keep them distinct; a high FDV-vs-mcap gap is dilution headroom to NOTE in tokenomics_risk, not a market_score penalty.
CRITICAL: Return ONLY raw JSON. No markdown.
Schema: {
  "market_score": <0-100>,
  "community_trust": "high|medium|low|unknown",
  "tokenomics_risk": "low|medium|high|unknown",
  "team_transparency": "transparent|partial|anonymous|unknown",
  "narrative_alignment": "<DeFi|AI agent|meme|infra|gaming|other|unknown>",
  "trading_signals": ["<signal>" or empty],
  "market_summary": "<2-3 sentences — market outlook>"
}`,
        ctx,
        0.3,
        700
      ),
      // Aeon: fundamentals + on-chain activity
      llm(
        `You are Aeon — onchain fundamentals analyst for Base.
Assess the fundamental quality and on-chain activity of this contract/token.
Cover: holder distribution risks, transaction patterns, deployment age signals, contract activity, whale concentration, contract interactions.

UNKNOWN ≠ BAD (critical scoring rule): holder distribution, whale concentration, holder_risk, and age require holder/transfer data that is NOT in the context. You therefore MUST return "unknown" for whale_concentration / holder_risk / age_signal — NEVER guess "high"/"low". It is self-contradictory to say "cannot assess holders" and then assign "high". Missing off-chain/holder data is a TOOL limitation, not a project flaw: do NOT lower fundamental_score because data is unavailable. Base fundamental_score on what IS known (verified source, real DEX liquidity/volume, contract activity); treat unknown dimensions as NEUTRAL (~60), not a penalty. Only concrete on-chain negatives lower the score.
CRITICAL: Return ONLY raw JSON. No markdown.
Schema: {
  "fundamental_score": <0-100>,
  "holder_risk": "low|medium|high|unknown",
  "activity_level": "high|medium|low|inactive",
  "whale_concentration": "low|medium|high|unknown",
  "age_signal": "established|recent|very_new|unknown",
  "on_chain_signals": ["<signal>" or empty],
  "fundamentals_summary": "<2-3 sentences — on-chain health>"
}`,
        ctx,
        0.2,
        700
      ),
    ]);

    const blue = parseJson(blueRaw) ?? {
      security_score: 50,
      critical_risks: [],
      medium_risks: info.verified ? [] : ["source not verified on Basescan"],
      positive_signals: info.verified ? ["source verified on Basescan"] : [],
      ownership_risk: "unknown",
      liquidity_risk: "unknown",
      audit_status: "unknown",
      security_summary: "Security analysis inconclusive. Verify on Basescan.",
    };

    const ms = parseJson(msRaw) ?? {
      market_score: 50,
      community_trust: "unknown",
      tokenomics_risk: "unknown",
      team_transparency: "unknown",
      narrative_alignment: "unknown",
      trading_signals: [],
      market_summary: "Market data unavailable.",
    };

    const aeon = parseJson(aeonRaw) ?? {
      fundamental_score: 50,
      holder_risk: "unknown",
      activity_level: "unknown",
      whale_concentration: "unknown",
      age_signal: "unknown",
      on_chain_signals: [],
      fundamentals_summary: "On-chain data unavailable.",
    };

    // Composite score
    const secScore   = (blue.security_score ?? 50) as number;
    const mktScore   = (ms.market_score ?? 50) as number;
    const fundScore  = (aeon.fundamental_score ?? 50) as number;
    const composite  = Math.round((secScore * 0.4 + mktScore * 0.3 + fundScore * 0.3));

    const verdict  = composite >= 70 ? "BULLISH" : composite >= 45 ? "NEUTRAL" : "BEARISH";
    const action   = composite >= 70 ? "CONSIDER" : composite >= 45 ? "DYOR" : "AVOID";

    return Response.json({
      tool: "deep-analysis",
      timestamp: new Date().toISOString(),
      address,
      chain: "base",
      chainId: 8453,
      token: {
        isToken: identity?.isToken ?? info.isToken,
        isContract: identity?.isContract ?? true,
        name: identity?.name ?? info.tokenName,
        symbol: identity?.symbol ?? info.tokenSymbol,
        decimals: identity?.decimals ?? info.tokenDecimals,
        totalSupply: identity?.totalSupply ?? null,
        priceUsd: identity?.market?.priceUsd ?? null,
        liquidityUsd: identity?.market?.liquidityUsd ?? null,
        fdv: identity?.market?.fdv ?? null,
        marketCap: identity?.market?.marketCap ?? null,
        // Market figures are a live snapshot — surface WHEN they were read so a
        // volatile price isn't mistaken for a fixed value.
        priceAsOf: identity?.market?.priceUsd != null ? new Date().toISOString() : null,
        priceNote: identity?.market?.priceUsd != null ? "live snapshot — volatile, varies by source/pool" : null,
        verified: info.verified,
        contractName: info.contractName,
        isProxy: info.isProxy,
        url: `https://basescan.org/address/${address}`,
      },
      composite_score: composite,
      verdict,
      action,
      security: {
        score:           secScore,
        critical_risks:  blue.critical_risks ?? [],
        medium_risks:    blue.medium_risks ?? [],
        positive_signals: blue.positive_signals ?? [],
        ownership_risk:  blue.ownership_risk ?? "unknown",
        liquidity_risk:  blue.liquidity_risk ?? "unknown",
        audit_status:    blue.audit_status ?? "unknown",
        summary:         blue.security_summary ?? "",
      },
      market: {
        score:             mktScore,
        community_trust:   ms.community_trust ?? "unknown",
        tokenomics_risk:   ms.tokenomics_risk ?? "unknown",
        team_transparency: ms.team_transparency ?? "unknown",
        narrative:         ms.narrative_alignment ?? "unknown",
        trading_signals:   ms.trading_signals ?? [],
        summary:           ms.market_summary ?? "",
      },
      fundamentals: {
        score:              fundScore,
        holder_risk:        aeon.holder_risk ?? "unknown",
        activity_level:     aeon.activity_level ?? "unknown",
        whale_concentration: aeon.whale_concentration ?? "unknown",
        age_signal:         aeon.age_signal ?? "unknown",
        on_chain_signals:   aeon.on_chain_signals ?? [],
        summary:            aeon.fundamentals_summary ?? "",
      },
    });
  } catch (error) {
    console.error("[DeepAnalysis]", error);
    return Response.json(
      { error: "Deep analysis failed", message: (error as Error).message },
      { status: 500 }
    );
  }
}
