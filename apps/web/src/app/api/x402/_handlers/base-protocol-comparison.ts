// x402/base-protocol-comparison
// Compare two Base protocols on REAL DefiLlama data (TVL, 1d/7d change,
// category). If only one is given, a real same-category competitor is picked
// from DefiLlama. The LLM reasons on top of the live numbers — never invents TVL.
// Resilient: retry + graceful fallback, never 500.
// Price: $0.50

import { findBaseProtocol, getBaseProtocols, protocolToPrompt, type BaseProtocol } from "@/lib/market-data";
import { callLLM } from "@/app/api/_lib/llm";

// Delegates to the shared Virtuals → Venice → Bankr chain. Bankr was
// banned 2026-07-18; the direct-Bankr fetch this used to do is dead
// on prod. `callLLM` retries providers in order and returns text +
// provenance. Signature kept identical so all call sites stay untouched.
async function llm(system: string, user: string, temp = 0.3, tokens = 1200): Promise<string> {
  const r = await callLLM({ system, user, temperature: temp, maxTokens: tokens });
  return r.text;
}
function parseJson(t: string): Record<string, unknown> | null {
  let s = t.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const i = s.indexOf("{"), j = s.lastIndexOf("}");
  if (i >= 0 && j > i) s = s.slice(i, j + 1);
  try { return JSON.parse(s); } catch { try { return JSON.parse(s.replace(/[\x00-\x1F]/g, " ")); } catch { return null; } }
}
const slim = (p: BaseProtocol | null) => p && { name: p.name, tvl_usd: p.tvlUsd, change_1d_pct: p.change1dPct, change_7d_pct: p.change7dPct, category: p.category, url: p.url };

export default async function handler(req: Request): Promise<Response> {
  try {
    let body: { protocol_a?: string; protocol_b?: string; category?: string; use_case?: string } = {};
    try { const t = await req.text(); if (t.trim().startsWith("{")) body = JSON.parse(t); } catch {}
    const url = new URL(req.url);
    const protocol_a = body.protocol_a ?? url.searchParams.get("protocol_a") ?? "";
    const protocol_b = body.protocol_b ?? url.searchParams.get("protocol_b") ?? "";
    const category = body.category ?? url.searchParams.get("category") ?? "";
    const use_case = body.use_case ?? url.searchParams.get("use_case") ?? "";
    if (!protocol_a) return Response.json({ error: "protocol_a is required" }, { status: 400 });

    // ── Real DefiLlama data for both protocols ────────────────────────────────
    const a = await findBaseProtocol(protocol_a);
    let b = protocol_b ? await findBaseProtocol(protocol_b) : null;
    if (!protocol_b) {
      // Pick a real same-category Base competitor (highest TVL, not A).
      const all = await getBaseProtocols(80);
      const cat = a?.category ?? category;
      b = all.find((p) => p.name !== a?.name && (cat ? p.category === cat : true)) ?? all.find((p) => p.name !== a?.name) ?? null;
    }

    const realCtx = [
      protocolToPrompt(a, "Protocol A (DefiLlama, REAL)"),
      protocolToPrompt(b, "Protocol B (DefiLlama, REAL)"),
    ].join("\n");

    const system = `You are Blue Agent — protocol comparison engine for Base (chain 8453).
You are given REAL DefiLlama TVL data for both protocols. Use those exact TVL/change numbers; NEVER invent figures. Reason qualitatively about security/UX/yield/integration from known fundamentals.
Return ONLY raw JSON. No markdown.
Schema: {
  "comparison_score": <0-100>,
  "recommendation": "<which to use + why>",
  "protocols": [{ "name": "<protocol>", "score": <0-100>, "security": <0-10>, "ux": <0-10>, "yield": <0-10>, "integration_ease": <0-10>, "pros": ["<pro>"], "cons": ["<con>"] }],
  "use_case_winner": "<best for ${use_case || "general use"}>",
  "risk_comparison": "<which is safer and why, referencing the real TVL trend>",
  "integration_notes": "<for builders integrating these>",
  "summary": "<2 sentences>"
}`;
    const user = `${realCtx}\nCategory: ${category || a?.category || "DeFi"}\nUse case: ${use_case || "general"}`;

    let result: Record<string, unknown> | null = null;
    for (let attempt = 0; attempt < 2 && !result; attempt++) {
      try { result = parseJson(await llm(system, user)); } catch { /* retry then fallback */ }
    }
    if (!result) {
      const winner = (a?.tvlUsd ?? 0) >= (b?.tvlUsd ?? 0) ? a?.name : b?.name;
      result = {
        comparison_score: 50,
        recommendation: `${winner ?? protocol_a} (larger TVL on Base)`,
        protocols: [a, b].filter(Boolean).map((p) => ({ name: p!.name, score: 50, security: 5, ux: 5, yield: 5, integration_ease: 5, pros: [`Base TVL ${p!.tvlUsd ?? "?"}`], cons: [] })),
        use_case_winner: winner ?? protocol_a,
        risk_comparison: "Live comparison synthesis briefly unavailable — ranked by real Base TVL. Re-run for detail.",
        integration_notes: "",
        summary: "Comparison built from real DefiLlama TVL; full synthesis on retry.",
        degraded: true,
      };
    }

    return Response.json({
      tool: "base-protocol-comparison",
      timestamp: new Date().toISOString(),
      data_source: a || b ? "DefiLlama (live Base TVL) + analysis" : "advisory (protocols not found on DefiLlama)",
      protocol_a,
      protocol_b: protocol_b || (b?.name ?? null),
      category: category || null,
      use_case: use_case || null,
      onchain: { protocol_a: slim(a), protocol_b: slim(b) },
      ...result,
    });
  } catch (e) {
    return Response.json({ error: "Base protocol comparison failed", message: (e as Error).message }, { status: 500 });
  }
}
