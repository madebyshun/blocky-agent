// x402/competitor-scan
// Competitor Scan — grounds named competitors in REAL DefiLlama data (live Base TVL +
// 1d/7d change + category) whenever they match a protocol on Base. The LLM reasons
// about positioning/moats on top of the real numbers; it never invents TVL. The
// subject project itself is described in text (no live metric pre-launch), so its
// score is qualitative — clearly labelled. Resilient: retry + fallback, never 500.
// Price: $0.75

import { findBaseProtocol, protocolToPrompt, type BaseProtocol } from "@/lib/market-data";
import { callVeniceLLM, STATIC_KNOWLEDGE_DISCLAIMER } from "@/app/api/_lib/llm";

async function llm(system: string, user: string, temp = 0.3, tokens = 1300): Promise<string> {
  return callVeniceLLM({ system, user, temperature: temp, maxTokens: tokens });
}
function parseJson(t: string): Record<string, unknown> | null {
  let s = t.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const i = s.indexOf("{"), j = s.lastIndexOf("}");
  if (i >= 0 && j > i) s = s.slice(i, j + 1);
  try { return JSON.parse(s); } catch { try { return JSON.parse(s.replace(/[\x00-\x1F]/g, " ")); } catch { return null; } }
}
const slim = (p: BaseProtocol) => ({ name: p.name, tvl_usd: p.tvlUsd, change_1d_pct: p.change1dPct, change_7d_pct: p.change7dPct, category: p.category, url: p.url });

export default async function handler(req: Request): Promise<Response> {
  try {
    let body: { project?: string; competitors?: string[] | string; description?: string } = {};
    try { const t = await req.text(); if (t.trim().startsWith("{")) body = JSON.parse(t); } catch {}
    const url = new URL(req.url);
    const project = body.project ?? url.searchParams.get("project") ?? "";
    const description = body.description ?? url.searchParams.get("description") ?? "";
    let competitors: string[] = Array.isArray(body.competitors)
      ? body.competitors
      : typeof body.competitors === "string"
        ? (body.competitors as string).split(",").map(x=>x.trim()).filter(Boolean)
        : [];
    if (!competitors.length) {
      const q = url.searchParams.get("competitors");
      if (q) competitors = q.split(",").map((s) => s.trim()).filter(Boolean);
    }
    if (!project) return Response.json({ error: "project is required" }, { status: 400 });

    // ── Resolve named competitors against real DefiLlama Base protocols ───────
    const resolved = await Promise.all(competitors.slice(0, 8).map(async (name) => ({ name, data: await findBaseProtocol(name) })));
    const matched = resolved.filter((r) => r.data);
    const realCtx = matched.length
      ? matched.map((r) => protocolToPrompt(r.data, `Competitor "${r.name}" (DefiLlama, REAL)`)).join("\n")
      : "No named competitors matched a Base protocol on DefiLlama — reason about the competitive set qualitatively from known fundamentals.";

    const system = `You are Blue Agent — competitive intelligence engine for Base builders (chain 8453).
You do NOT have live web access. Do NOT fabricate competitor URLs, funding rounds, valuations, or "current" market positions — you cannot verify them. Reason about the competitive set from the REAL data provided plus general fundamentals only.
${matched.length ? "You are given REAL DefiLlama TVL/change/category for the matched competitors. Use those exact numbers; NEVER invent TVL. Anchor each competitor's threat_level on its real TVL + 7d trend." : "No DefiLlama metrics were pre-matched — reason qualitatively from known fundamentals and mark any figure you cannot verify as \"[data unavailable]\" rather than guessing."}
The subject project is described in text only (likely pre-launch / no live metric), so its score is a qualitative judgement, not a measurement.
Return ONLY raw JSON. No markdown.
Schema: {
  "verdict": "STRONG|COMPETITIVE|WEAK",
  "score": <0-100>,
  "project_strengths": ["<strength>"],
  "project_weaknesses": ["<weakness>"],
  "competitors": [{"name":"<name>","threat_level":"high|medium|low","key_advantage":"<1 sentence, cite real TVL if known>","vulnerability":"<1 sentence>"}],
  "whitespace": ["<market gap to exploit>"],
  "recommended_positioning": "<1-2 sentences>",
  "win_condition": "<what it takes to win>"
}`;
    const user = `Project: ${project}\nDescription: ${description || "(none)"}\nNamed competitors: ${competitors.length ? competitors.join(", ") : "(none given — infer the top Base competitors)"}\n\n${realCtx}`;

    let result: Record<string, unknown> | null = null;
    for (let attempt = 0; attempt < 2 && !result; attempt++) {
      try { result = parseJson(await llm(system, user)); } catch { /* retry then fallback */ }
    }
    if (!result) {
      result = {
        verdict: "COMPETITIVE",
        score: null,
        project_strengths: [],
        project_weaknesses: [],
        competitors: matched.map((r) => ({ name: r.data!.name, threat_level: (r.data!.tvlUsd ?? 0) > 50_000_000 ? "high" : "medium", key_advantage: `Live Base TVL ${r.data!.tvlUsd ?? "?"}`, vulnerability: "" })),
        whitespace: [],
        recommended_positioning: "Synthesis briefly unavailable — competitor TVL below is real. Re-run for full analysis.",
        win_condition: "Re-run for detail.",
        degraded: true,
      };
    }

    return Response.json({
      tool: "competitor-scan",
      timestamp: new Date().toISOString(),
      data_source: matched.length ? "DefiLlama (live Base TVL for matched competitors) + analysis" : "advisory (no competitors matched on DefiLlama)",
      // When nothing matched a live DefiLlama protocol, the competitive read is
      // pure static-knowledge — flag it as low-confidence.
      ...(matched.length ? {} : { confidence_note: STATIC_KNOWLEDGE_DISCLAIMER }),
      project,
      competitors_requested: competitors,
      competitors_matched: matched.map((r) => r.name),
      onchain: matched.map((r) => slim(r.data!)),
      ...result,
    });
  } catch (e) {
    return Response.json({ error: "Competitor scan failed", message: (e as Error).message }, { status: 500 });
  }
}
