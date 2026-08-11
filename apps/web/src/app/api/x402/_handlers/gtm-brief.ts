// x402/gtm-brief/index.ts
// Go-to-Market Brief — Blue idea + Aeon narrative-tracker + MiroShark influencer + retail
// Price: $0.50
// Fully self-contained

import { getAeonOutput, formatAeonForLLM } from "@/app/api/_lib/aeon-kv";
import { callLLM } from "@/app/api/_lib/llm";

// Virtuals-only synthesis (no web search). Market/metric framing is
// model-generated — grounded facts come from the Aeon narrative context, not live search.
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
    let body: { project?: string; product?: string; description?: string; target?: string } = {};
    try { const t = await req.text(); if (t.trim().startsWith("{")) body = JSON.parse(t); } catch {}
    // Accept "product" (Hub UI) as alias for both "project" and "description"
    const project     = body.project ?? body.product ?? "";
    const description = body.description ?? body.product ?? "";
    const target      = body.target ?? "";
    if (!project || !description) return Response.json({ error: "product description is required" }, { status: 400 });

    const [narrativeRaw, ideaRaw] = await Promise.all([
      aeon("narrative-tracker"),
      llm(`You are Blue Agent running 'blue idea'. Expand into GTM-focused brief.
CRITICAL: Return ONLY raw JSON.
Schema: {"target_user":"<who>","pain_point":"<specific pain>","entry_wedge":"<smallest beachhead>","distribution_channel":"<primary channel>","hook":"<1 sentence why they switch>"}`,
        `Project: ${project}\nDescription: ${description}\nTarget: ${target || "Base builders and crypto users"}`, 0.4, 600),
    ]);

    const brief = parseJson(ideaRaw) ?? {};

    const msRaw = await llm(`You are MiroShark — influencer(2.8x) + retail(1.0x) personas combined.
Evaluate GTM strategy from distribution perspective.
CRITICAL: Return ONLY raw JSON.
Schema: {"viral_potential":<0-10>,"distribution_fit":"strong|moderate|weak","best_channel":"<channel>","community_hooks":["<hook>"],"retail_pull":"<1 sentence>","influencer_appeal":"<1 sentence>","gtm_verdict":"<1 sentence>"}`,
      `Project: ${project}\nDescription: ${description}\nBrief: ${JSON.stringify(brief)}\nNarratives: ${narrativeRaw ?? "Base ecosystem"}`, 0.5, 600);
    const distribution = parseJson(msRaw) ?? {};

    const resultRaw = await llm(`You are Blue Agent — GTM brief engine for Base builders.
CRITICAL: Return ONLY raw JSON.
Schema: {
  "gtm_score": <0-100>,
  "positioning": "<10 words max tagline>",
  "target_segment": "<specific user>",
  "launch_channel": "<primary>",
  "distribution_playbook": ["<step 1>","<step 2>","<step 3>"],
  "narrative_angle": "<which narrative to ride>",
  "week_1_actions": ["<action>"],
  "success_metric": "<what does good look like at 30 days>",
  "community_strategy": "<1-2 sentences>",
  "avoid": ["<common GTM mistake>"]
}`,
      `Project: ${project}\nBrief: ${JSON.stringify(brief)}\nNarratives: ${narrativeRaw ?? "Base"}\nDistribution: ${JSON.stringify(distribution)}`, 0.3, 1000);

    let result = parseJson(resultRaw);
    if (!result) result = { degraded: true, note: "Synthesis briefly unavailable - please retry." };

    return Response.json({ tool: "gtm-brief", timestamp: new Date().toISOString(), project, brief, distribution, ...result, disclaimer: "AI-generated GTM advisory from model knowledge — scores and projections are estimates, not measured market data or a guarantee. Adapt to your own research." });
  } catch (e) {
    return Response.json({ error: "GTM brief failed", message: (e as Error).message }, { status: 500 });
  }
}
