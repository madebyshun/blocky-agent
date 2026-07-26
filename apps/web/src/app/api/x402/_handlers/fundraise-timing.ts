// x402/fundraise-timing/index.ts
// Fundraise Timing — Aeon token-movers + narrative-tracker + MiroShark influencer + Blue raise
// Price: $0.50
// Fully self-contained

import { getAeonOutput, formatAeonForLLM } from "@/app/api/_lib/aeon-kv";
import { callLLM } from "@/app/api/_lib/llm";

async function llm(system: string, user: string, temp = 0.4, tokens = 1000): Promise<string> {
  return (await callLLM({ system, user, temperature: temp, maxTokens: tokens })).text;
}
function parseJson(t: string): Record<string, unknown> | null {
  let s = t.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const i = s.indexOf("{"), j = s.lastIndexOf("}");
  if (i >= 0 && j > i) s = s.slice(i, j + 1);
  try { return JSON.parse(s); } catch { try { return JSON.parse(s.replace(/[\x00-\x1F]/g, " ")); } catch { return null; } }
}
async function aeon(skill: string): Promise<string | null> {
  try {
    const fresh = await getAeonOutput(skill);
    if (fresh) return formatAeonForLLM(fresh);
  } catch {}
  return null;
}

export default async function handler(req: Request): Promise<Response> {
  try {
    let body: { project?: string; description?: string; ask?: string; stage?: string } = {};
    try { const t = await req.text(); if (t.trim().startsWith("{")) body = JSON.parse(t); } catch {}
    const { project = "", description = "", ask = "", stage = "pre-seed" } = body;
    if (!project) return Response.json({ error: "project is required" }, { status: 400 });

    const [moversRaw, narrativeRaw] = await Promise.all([
      aeon("token-movers"),
      aeon("narrative-tracker"),
    ]);

    const msRaw = await llm(`You are MiroShark influencer persona.
Assess investor sentiment and fundraising climate right now.
CRITICAL: Return ONLY raw JSON.
Schema: {"investor_appetite":"hot|warm|neutral|cold","raise_momentum":"building|peak|fading","best_narrative_angle":"<1 sentence>","timing_verdict":"<1 sentence>"}`,
      `Market: ${moversRaw ?? "Base market"}\nNarratives: ${narrativeRaw ?? "Base ecosystem"}`, 0.4, 400);
    const influencerTake = parseJson(msRaw) ?? { investor_appetite: "neutral", raise_momentum: "neutral", best_narrative_angle: "Base-native focus", timing_verdict: "Mixed signals" };

    const resultRaw = await llm(`You are Blue Agent — fundraise timing engine.
CRITICAL: Return ONLY raw JSON.
Schema: {
  "verdict": "RAISE_NOW|RAISE_SOON|WAIT|NOT_NOW",
  "timing_score": <0-100>,
  "market_window": "open|closing|closed|opening",
  "narrative_momentum": <0-10>,
  "investor_climate": "hot|warm|neutral|cold",
  "optimal_window": "<timeframe e.g. 'next 4-6 weeks'>",
  "catalysts_to_wait_for": ["<catalyst if WAIT>"],
  "raise_strategy": "<2-3 sentences>",
  "risk_of_waiting": "<1 sentence>",
  "risk_of_rushing": "<1 sentence>"
}`,
      `Project: ${project}\nDescription: ${description}\nAsk: ${ask}\nStage: ${stage}\nMarket: ${moversRaw ?? "Base"}\nNarratives: ${narrativeRaw ?? "Base"}\nInfluencer: ${JSON.stringify(influencerTake)}`, 0.3, 900);

    let result = parseJson(resultRaw);
    if (!result) result = { degraded: true, note: "Synthesis briefly unavailable - please retry." };

    return Response.json({ tool: "fundraise-timing", timestamp: new Date().toISOString(), project, stage, influencer: influencerTake, ...result, disclaimer: "AI estimate of the fundraising climate from model knowledge — investor appetite is NOT measured from a live data feed. Treat as directional guidance, not market data." });
  } catch (e) {
    return Response.json({ error: "Fundraise timing failed", message: (e as Error).message }, { status: 500 });
  }
}
