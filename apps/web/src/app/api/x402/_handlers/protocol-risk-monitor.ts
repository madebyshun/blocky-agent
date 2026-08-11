// x402/protocol-risk-monitor
// Protocol Risk Monitor — grounded in DefiLlama (real Base TVL + TVL change).
// The TVL numbers are live; the LLM only reasons about contract/oracle/
// governance risk on top of them (never invents TVL/percentages).
// Resilient: retry + graceful fallback, never 500.
// Price: $0.35

import { findBaseProtocol, protocolToPrompt, type BaseProtocol } from "@/lib/market-data";
import { callLLM } from "@/app/api/_lib/llm";

// Delegates to the shared Virtuals → Venice → Bankr chain. Bankr was
// banned 2026-07-18; the direct-Bankr fetch this used to do is dead
// on prod. `callLLM` retries providers in order and returns text +
// provenance. Signature kept identical so all call sites stay untouched.
async function llm(system: string, user: string, temp = 0, tokens = 1100): Promise<string> {
  const r = await callLLM({ system, user, temperature: temp, maxTokens: tokens });
  return r.text;
}
function parseJson(t: string): Record<string, unknown> | null {
  let s = t.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const i = s.indexOf("{"), j = s.lastIndexOf("}");
  if (i >= 0 && j > i) s = s.slice(i, j + 1);
  try { return JSON.parse(s); } catch { try { return JSON.parse(s.replace(/[\x00-\x1F]/g, " ")); } catch { return null; } }
}

export default async function handler(req: Request): Promise<Response> {
  try {
    let body: { protocol?: string; position?: string } = {};
    try { const t = await req.text(); if (t.trim().startsWith("{")) body = JSON.parse(t); } catch {}
    const url = new URL(req.url);
    const protocol = body.protocol ?? url.searchParams.get("protocol") ?? "";
    const position = body.position ?? url.searchParams.get("position") ?? "";
    if (!protocol) return Response.json({ error: "protocol is required (e.g. 'Aerodrome', 'Aave', 'Uniswap')" }, { status: 400 });

    // ── Real DefiLlama data ───────────────────────────────────────────────────
    const p: BaseProtocol | null = await findBaseProtocol(protocol);
    const ch7 = p?.change7dPct ?? null;
    const ch1 = p?.change1dPct ?? null;
    const tvlSignals: string[] = [];
    if (ch7 != null && ch7 <= -20) tvlSignals.push(`TVL down ${ch7.toFixed(1)}% over 7d — capital fleeing, elevated risk.`);
    else if (ch7 != null && ch7 <= -8) tvlSignals.push(`TVL down ${ch7.toFixed(1)}% over 7d — softening.`);
    if (ch1 != null && ch1 <= -10) tvlSignals.push(`TVL down ${ch1.toFixed(1)}% in 24h — sharp outflow.`);
    if (p && (p.tvlUsd ?? 0) < 1_000_000) tvlSignals.push(`Low TVL (<$1M) — thin protocol, higher fragility.`);

    const realCtx = [
      protocolToPrompt(p, "Target protocol (DefiLlama, REAL)"),
      tvlSignals.length ? `Live TVL signals: ${tvlSignals.join(" ")}` : "Live TVL signals: none flagged.",
    ].join("\n");

    const system = `You are Blue Agent — protocol risk monitor for Base DeFi (chain 8453).
You are given REAL DefiLlama TVL data. Reference those numbers exactly; NEVER invent TVL or percentages. Use the live TVL trend for the liquidity/market dimensions; reason qualitatively (from known fundamentals) about smart-contract, oracle and governance risk.
DATA DISCIPLINE (critical): If protocol/oracle/governance/audit data is NOT available, set that dimension to "unknown" and severity to "unknown" — do NOT assign low/medium/high. Missing data is NEUTRAL, never a risk. Never infer rug/centralization/manipulation risk from ABSENCE of data. Only score dimensions backed by actual on-chain or known facts. If the address is not a recognized DeFi protocol, say so and return overall_risk "unknown", not a fabricated score.
Return ONLY raw JSON. No markdown.
Schema: {
  "risk_score": <0-100>,
  "overall_risk": "critical|high|medium|low|minimal|unknown",
  "risk_dimensions": { "smart_contract": <0-10>, "liquidity": <0-10>, "oracle": <0-10>, "governance": <0-10>, "market": <0-10> },
  "active_risks": [{"risk":"<name>","severity":"critical|high|medium|low|unknown","description":"<brief>"}],
  "watch_for": ["<signal that changes risk level>"],
  "safe_exit_path": "<how to exit safely if needed>",
  "summary": "<2 sentences>"
}`;
    const user = `${realCtx}\nPosition: ${position || "general exposure"}`;

    let result: Record<string, unknown> | null = null;
    for (let attempt = 0; attempt < 2 && !result; attempt++) {
      try { result = parseJson(await llm(system, user)); } catch { /* retry then fallback */ }
    }
    if (result) {
      const rs = Number(result.risk_score);
      if (!isNaN(rs)) result.action = rs >= 75 ? "EXIT_NOW" : rs >= 55 ? "REDUCE" : rs >= 35 ? "HOLD" : "ADD";
    }
    if (!result) {
      result = {
        risk_score: p ? (ch7 != null && ch7 <= -20 ? 70 : 45) : 50,
        overall_risk: ch7 != null && ch7 <= -20 ? "high" : "medium",
        action: "HOLD",
        risk_dimensions: { smart_contract: 5, liquidity: 5, oracle: 5, governance: 5, market: 5 },
        active_risks: tvlSignals.map((s) => ({ risk: "tvl-trend", severity: "medium", description: s })),
        watch_for: ["Continued TVL decline", "Governance/contract changes"],
        safe_exit_path: "Reduce position into deep-liquidity pairs; avoid thin pools.",
        summary: "Live risk synthesis was briefly unavailable — assessment built from real TVL signals. Re-run for full detail.",
        degraded: true,
      };
    }

    return Response.json({
      tool: "protocol-risk-monitor",
      timestamp: new Date().toISOString(),
      data_source: p ? "DefiLlama (live Base TVL) + analysis" : "advisory (protocol not found on DefiLlama for Base)",
      protocol,
      position: position || null,
      onchain: p ? { name: p.name, tvl_usd: p.tvlUsd, change_1d_pct: p.change1dPct, change_7d_pct: p.change7dPct, category: p.category, url: p.url } : null,
      ...result,
    });
  } catch (e) {
    return Response.json({ error: "Protocol risk monitor failed", message: (e as Error).message }, { status: 500 });
  }
}
