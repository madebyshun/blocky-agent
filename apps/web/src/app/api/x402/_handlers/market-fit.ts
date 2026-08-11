// x402/market-fit
// Market Fit Validator — validates a (usually pre-launch) idea, so the verdict is an
// inherently QUALITATIVE judgement, clearly labelled as such. To keep it honest the
// timing read is anchored to REAL Base market context (live chain TVL + trending
// pools from DefiLlama/GeckoTerminal) instead of fabricated "movers". The LLM never
// presents the score as a measurement. Resilient: retry + graceful fallback, never 500.
// Price: $0.35

import { getBaseTvl, getBaseTrending, tvlToPrompt, poolsToPrompt } from "@/lib/market-data";
import { callLLM } from "@/app/api/_lib/llm";

type BankrMessage = { role: string; content: string };
// Delegates to the shared Virtuals → Venice → Bankr chain. Bankr was
// banned 2026-07-18; the direct-Bankr fetch this used to do is dead
// on prod. `callLLM` retries providers in order and returns text +
// provenance. Name/signature preserved so all call sites stay identical.
async function callBankrLLM(opts: { system: string; messages: BankrMessage[]; temperature?: number; maxTokens?: number }): Promise<string> {
  const r = await callLLM({ system: opts.system, messages: opts.messages, temperature: opts.temperature, maxTokens: opts.maxTokens });
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

export default async function handler(req: Request): Promise<Response> {
  try {
    let body: { description?: string; product?: string; project?: string; name?: string; stage?: string } = {};
    try { const t = await req.text(); if (t?.trim().startsWith("{")) body = JSON.parse(t); } catch {}
    const url = new URL(req.url);
    const rawDesc = body.description ?? body.product ?? body.project ?? url.searchParams.get("description") ?? url.searchParams.get("product") ?? url.searchParams.get("project") ?? "";
    const stage = body.stage ?? url.searchParams.get("stage") ?? "";
    const description = stage ? `${rawDesc}\n\nStage: ${stage}` : rawDesc;
    const name = body.name ?? url.searchParams.get("name") ?? "this project";
    if (!rawDesc) return Response.json({ error: "product description is required" }, { status: 400 });

    // ── Real Base market context (timing anchor) ──────────────────────────────
    const [tvl, trending] = await Promise.all([getBaseTvl(), getBaseTrending(8)]);
    const hasMarket = !!(tvl || trending.length);
    const marketCtx = [`Base market context (REAL):`, tvlToPrompt(tvl), `Trending Base pools right now:`, poolsToPrompt(trending)].join("\n");

    const briefRaw = await callBankrLLM({
      system: `You are Blue Agent running 'blue idea' for Base builders. Expand a rough concept into a structured brief. Return ONLY raw JSON. No markdown.
Schema: { "problem":"<>", "why_now":"<>", "why_base":"<>", "target_user":"<>", "mvp_scope":"<>", "biggest_risk":"<>" }`,
      messages: [{ role: "user", content: `Project: ${name}\n\n${description}\n\n${marketCtx}` }],
      temperature: 0.4, maxTokens: 700,
    }).catch(() => "");
    const brief = extractJsonObject(briefRaw) ?? { problem: rawDesc, why_now: "Market timing unclear", why_base: "Base ecosystem alignment", target_user: "Base builders", mvp_scope: "TBD", biggest_risk: "Unclear demand" };

    const verdictRaw = await (async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          return await callBankrLLM({
            system: `You are Blue Agent — market-fit verdict engine for Base builders (chain 8453).
This is an IDEA validation: the project is described in text and is likely pre-launch, so your score is a QUALITATIVE judgement, NOT a measurement — never imply it is measured. Anchor the timing read to the REAL Base market context provided (cite the live TVL/trend); do not invent market numbers.
Return ONLY raw JSON. No markdown.
Schema: {
  "verdict": "GO|WAIT|PIVOT",
  "score": <0-100>,
  "narrative_fit": {"aligned":<boolean>,"score":<0-10>,"note":"<reference the real Base market context>"},
  "consensus": {"bull":<0-100>,"bear":<0-100>,"neutral":<0-100>},
  "strengths": ["<strength>","<strength>"],
  "risks": ["<risk>","<risk>","<risk>"],
  "suggested_change": "<1 actionable change>",
  "timing": "now|3months|6months",
  "builder_note": "<1 sentence direct advice>"
}`,
            messages: [{ role: "user", content: `Project: ${name}\n\nBrief:\n${JSON.stringify(brief)}\n\n${marketCtx}` }],
            temperature: 0.3, maxTokens: 1000,
          });
        } catch { /* retry */ }
      }
      return "";
    })();

    const verdict = extractJsonObject(verdictRaw) ?? {
      verdict: "WAIT",
      score: null,
      narrative_fit: { aligned: null, score: null, note: "Synthesis briefly unavailable — Base market context below is real. Re-run." },
      consensus: { bull: null, bear: null, neutral: null },
      strengths: [],
      risks: ["Validation synthesis degraded this run"],
      suggested_change: "Re-run the validation",
      timing: "3months",
      builder_note: "Re-run for the full market-fit read.",
      degraded: true,
    };

    return Response.json({
      tool: "market-fit",
      timestamp: new Date().toISOString(),
      data_source: hasMarket
        ? "qualitative idea validation + live Base market context (DefiLlama/GeckoTerminal)"
        : "qualitative idea validation (live market context unavailable this run)",
      project: name,
      market: { base_tvl_usd: tvl?.tvlUsd ?? null, base_tvl_change_7d_pct: tvl?.change7dPct ?? null, trending: trending.slice(0, 5).map((p) => ({ symbol: p.baseSymbol, change_24h_pct: p.change.h24 })) },
      brief,
      ...verdict,
    });
  } catch (error) {
    console.error("[MarketFit]", error);
    return Response.json({ error: "Market fit validation failed", message: (error as Error).message }, { status: 500 });
  }
}
