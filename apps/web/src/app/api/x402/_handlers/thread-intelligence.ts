// x402/thread-intelligence/index.ts
// Thread Intelligence — Aeon narrative-tracker + MiroShark influencer + Blue idea.
// This is a GENERATIVE content tool (hooks, thread outlines, posting strategy). It is
// NOT wired to a live CT/Twitter feed, so the scores (content_score, viral_potential,
// engagement_prediction) are AI ESTIMATES from model knowledge, not measured metrics.
// Output is labelled accordingly. Resilient: never 500.
// Price: $0.35

import { getAeonOutput, formatAeonForLLM } from "@/app/api/_lib/aeon-kv";
import { NO_FABRICATION_RULE, callLLM } from "@/app/api/_lib/llm";

// Delegates to the shared Virtuals → Venice → Bankr chain. Bankr was
// banned 2026-07-18; the direct-Bankr fetch this used to do is dead
// on prod. `callLLM` retries providers in order and returns text +
// provenance. Signature kept identical so all call sites stay untouched.
async function llm(system: string, user: string, temp = 0, tokens = 1000): Promise<string> {
  const r = await callLLM({ system: `${NO_FABRICATION_RULE}\n\n${system}`, user, temperature: temp, maxTokens: tokens });
  return r.text;
}
const DISCLAIMER = "Content strategy is AI-generated; the scores (content_score, viral_potential, engagement_prediction) are model ESTIMATES, not measured from live social data.";
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
    let body: { topic?: string; audience?: string; goal?: string } = {};
    try { const t = await req.text(); if (t.trim().startsWith("{")) body = JSON.parse(t); } catch {}
    const url = new URL(req.url);
    const topic = body.topic ?? url.searchParams.get("topic") ?? "";
    const audience = body.audience ?? url.searchParams.get("audience") ?? "Base builders and crypto traders";
    const goal = body.goal ?? url.searchParams.get("goal") ?? "engagement";

    const narrativeRaw = await aeon("narrative-tracker");
    const NARRATIVE_CTX = narrativeRaw
      ? `REAL Aeon narrative research (fresh daily — base ALL "what is resonating / trending angles" claims ONLY on these actual narratives/catalysts; do NOT invent trending topics, engagement numbers, or CT sentiment not present here):
${narrativeRaw}`
      : `No fresh Aeon narrative data — give qualitative angles labeled "model estimate"; do NOT fabricate trending topics, engagement metrics, or specific CT discourse.`;

    const msRaw = await llm(`You are MiroShark — influencer persona (2.8x weight).
You know what goes viral on CT. Evaluate thread potential.
CRITICAL: Return ONLY raw JSON.
Schema: {
  "viral_potential": <0-10>,
  "best_angle": "<the hook that will work>",
  "posting_time": "<when to post: e.g. 9am EST, market open>",
  "format": "thread|single|poll|reply",
  "influencer_take": "<1-2 sentences on what makes this land>"
}`,
      `Topic: ${topic || "Base ecosystem"}\nAudience: ${audience}\nGoal: ${goal}\nNarratives: ${NARRATIVE_CTX}`, 0, 500);
    const influencer = parseJson(msRaw) ?? {};

    const resultRaw = await llm(`You are Blue Agent — content intelligence engine for Base builders.
Generate actionable thread strategy.
CRITICAL: Return ONLY raw JSON.
Schema: {
  "content_score": <0-100>,
  "recommended_angle": "<the winning take>",
  "thread_outline": ["<tweet 1>", "<tweet 2>", "<tweet 3>", "<CTA>"],
  "hook_options": ["<hook 1>", "<hook 2>", "<hook 3>"],
  "best_posting_window": "<time and day>",
  "hashtags": ["<tag>"],
  "avoid": ["<what not to say>"],
  "engagement_prediction": "viral|high|medium|low",
  "summary": "<1-2 sentences>"
}`,
      `Topic: ${topic || "Base"}\nAudience: ${audience}\nGoal: ${goal}\nNarratives: ${NARRATIVE_CTX}\nInfluencer: ${JSON.stringify(influencer)}`, 0, 1000);

    let result = parseJson(resultRaw);
    if (!result) {
      result = {
        content_score: null,
        recommended_angle: "Re-run for a full content strategy",
        thread_outline: [],
        hook_options: [],
        best_posting_window: "weekday morning EST",
        hashtags: [],
        avoid: [],
        engagement_prediction: "medium",
        summary: "Content synthesis briefly unavailable this run — re-run.",
        degraded: true,
      };
    }

    return Response.json({
      tool: "thread-intelligence",
      timestamp: new Date().toISOString(),
      data_source: "AI estimate (no live social data — model-generated, not measured)",
      disclaimer: DISCLAIMER,
      topic,
      audience,
      goal,
      influencer,
      ...result,
    });
  } catch (e) {
    // Never 500 — return a labelled, degraded estimate.
    return Response.json({
      tool: "thread-intelligence",
      timestamp: new Date().toISOString(),
      data_source: "AI estimate (no live social data — model-generated, not measured)",
      disclaimer: DISCLAIMER,
      degraded: true,
      note: "Estimate unavailable this run — please retry.",
      message: (e as Error).message,
    });
  }
}
