// x402/blue-monitor
// Blue Monitor — on-demand health + risk snapshot for a Base target (token,
// contract, or protocol). Grounds in REAL data (DexScreener market data +
// Basescan verification) and adds a recommended watch plan + alert thresholds.
// One LLM synthesis pass with retry + graceful fallback — never 500s.
// Price: $0.20

import { getTokenMarket, type TokenMarket } from "@/lib/market-data";
import { getBasescanSource } from "@/lib/moralis";
import { callLLM } from "@/app/api/_lib/llm";

// Delegates to the shared Virtuals → Venice → Bankr chain. Bankr was
// banned 2026-07-18; the direct-Bankr fetch this used to do is dead
// on prod. `callLLM` retries providers in order and returns text +
// provenance. Kept as `llm(system, user, temp, tokens)` so all
// call sites in this handler stay identical.
async function llm(system: string, user: string, temp = 0.3, tokens = 900): Promise<string> {
  const r = await callLLM({ system, user, temperature: temp, maxTokens: tokens });
  return r.text;
}

function parseJson(t: string): Record<string, unknown> | null {
  let s = t.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const i = s.indexOf("{"), j = s.lastIndexOf("}");
  if (i >= 0 && j > i) s = s.slice(i, j + 1);
  try { return JSON.parse(s); } catch {
    try { return JSON.parse(s.replace(/[\x00-\x1F]/g, " ")); } catch { return null; }
  }
}

// Lightweight Basescan verification check (contract trust signal).
async function getVerified(address: string): Promise<{ verified: boolean; name: string | null }> {
  try {
    const info = await getBasescanSource(address);
    if (info) {
      const sourceCode = info.SourceCode as string | undefined;
      const contractName = info.ContractName as string | undefined;
      return {
        verified: !!sourceCode && sourceCode.length > 0,
        name: contractName || null,
      };
    }
  } catch { /* ignore */ }
  return { verified: false, name: null };
}

function healthFromMarket(m: TokenMarket | null): { status: string; signals: string[] } {
  if (!m) return { status: "unknown", signals: ["No live market data found for this target."] };
  const signals: string[] = [];
  const liq = m.liquidityUsd ?? 0;
  const vol = m.volume24h ?? 0;
  const ch = m.change.h24 ?? 0;
  if (liq < 50_000) signals.push(`Thin liquidity ($${Math.round(liq).toLocaleString()}) — high slippage / exit risk.`);
  if (vol < 10_000) signals.push(`Low 24h volume ($${Math.round(vol).toLocaleString()}) — weak participation.`);
  if (Math.abs(ch) > 30) signals.push(`Extreme 24h move (${ch > 0 ? "+" : ""}${ch.toFixed(1)}%) — volatility / reversal risk.`);
  let status = "healthy";
  if (liq < 50_000 || Math.abs(ch) > 40) status = "critical";
  else if (liq < 250_000 || vol < 50_000 || Math.abs(ch) > 20) status = "degraded";
  return { status, signals };
}

export default async function handler(req: Request): Promise<Response> {
  try {
    let body: { target?: string; focus?: string } = {};
    try { const t = await req.text(); if (t.trim().startsWith("{")) body = JSON.parse(t); } catch {}
    const url = new URL(req.url);
    const target = (body.target ?? url.searchParams.get("target") ?? "").trim();
    const focus  = (body.focus ?? url.searchParams.get("focus") ?? "").trim();

    if (!target) {
      return Response.json(
        { error: "target is required — a Base token/contract address (0x…) or a protocol/token name." },
        { status: 400 }
      );
    }

    const isAddress = /^0x[0-9a-fA-F]{40}$/.test(target);

    // ── Gather real, grounded data ──────────────────────────────────────────
    let market: TokenMarket | null = null;
    let verified = false;
    let contractName: string | null = null;
    if (isAddress) {
      const [m, v] = await Promise.all([getTokenMarket(target), getVerified(target)]);
      market = m;
      verified = v.verified;
      contractName = v.name;
    }

    const heuristic = healthFromMarket(market);
    const realContext = isAddress
      ? [
          `Target: ${target} (Base mainnet, chain 8453)`,
          `Contract verified on Basescan: ${verified}${contractName ? ` (${contractName})` : ""}`,
          market
            ? `Live market: price $${market.priceUsd ?? "?"}, 24h ${market.change.h24 ?? "?"}%, liquidity $${Math.round(market.liquidityUsd ?? 0).toLocaleString()}, 24h volume $${Math.round(market.volume24h ?? 0).toLocaleString()}, symbol ${market.symbol ?? "?"}`
            : `No live DEX market data found (may be non-traded or a plain contract).`,
          `Heuristic health: ${heuristic.status}. Signals: ${heuristic.signals.join(" ") || "none flagged"}`,
        ].join("\n")
      : `Target: ${target} (a Base protocol/token name — no address supplied, assess from known profile).`;

    // ── One synthesis pass: qualitative risk + watch plan (grounded only) ────
    const system = `You are Blue Monitor — a continuous-monitoring advisor for Base (chain 8453).
You are given REAL data about a target. Reference ONLY what you're given; never invent prices, tickers, or percentages.
Produce a monitoring plan a builder/holder can act on.
Return ONLY raw JSON. No markdown.
Schema: {
  "health_status": "healthy|degraded|critical|unknown",
  "risk_signals": ["<grounded signal>"],
  "watch_thresholds": ["<concrete trigger to alert on, e.g. 'liquidity drops below $X' or 'price -15% in 1h'>"],
  "monitor_plan": ["<what to check + suggested cadence>"],
  "summary": "<2 sentences>"
}`;
    const user = `${realContext}${focus ? `\nFocus: ${focus}` : ""}`;

    let synth: Record<string, unknown> | null = null;
    for (let attempt = 0; attempt < 2 && !synth; attempt++) {
      try { synth = parseJson(await llm(system, user)); } catch { /* retry then fallback */ }
    }
    // Graceful fallback — never 500. Built from the real heuristic data.
    if (!synth) {
      synth = {
        health_status: heuristic.status,
        risk_signals: heuristic.signals,
        watch_thresholds: isAddress
          ? ["Liquidity drops > 30% in 24h", "Price moves > 20% in 1h", "Contract upgrade / ownership change"]
          : ["TVL drops > 20% in 24h", "Unusual governance proposal", "Oracle / bridge incident"],
        monitor_plan: ["Re-check this snapshot every 6–12h", "Set onchain alerts via Blue Sentinel"],
        summary: "Live synthesis was briefly unavailable — this snapshot is built from the grounded heuristic signals. Re-run for a full read.",
        degraded: true,
      };
    }

    return Response.json({
      tool: "blue-monitor",
      timestamp: new Date().toISOString(),
      data_source: isAddress ? "DexScreener + Basescan (live)" : "advisory (no address supplied)",
      target,
      target_type: isAddress ? "address" : "name",
      onchain: isAddress
        ? {
            verified,
            contract_name: contractName,
            symbol: market?.symbol ?? null,
            price_usd: market?.priceUsd ?? null,
            change_24h_pct: market?.change.h24 ?? null,
            liquidity_usd: market?.liquidityUsd ?? null,
            volume_24h_usd: market?.volume24h ?? null,
            url: `https://basescan.org/address/${target}`,
          }
        : null,
      ...synth,
      continuous_monitoring:
        "For always-on alerts, subscribe this target to Blue Sentinel via the alert-subscribe tool (Telegram / webhook).",
    });
  } catch (e) {
    return Response.json(
      { error: "Blue monitor failed", message: (e as Error).message },
      { status: 500 }
    );
  }
}
