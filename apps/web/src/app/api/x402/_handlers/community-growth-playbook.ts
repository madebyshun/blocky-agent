// x402/community-growth-playbook/index.ts
// Community Growth Playbook — Aeon narrative-tracker + MiroShark 4-persona + Blue idea
// Price: $0.50

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
    let body: { project?: string; description?: string; current_size?: string; goal?: string } = {};
    try { const t = await req.text(); if (t.trim().startsWith("{")) body = JSON.parse(t); } catch {}
    const url = new URL(req.url);
    const project = body.project ?? url.searchParams.get("project") ?? "";
    const description = body.description ?? url.searchParams.get("description") ?? "";
    const current_size = body.current_size ?? url.searchParams.get("current_size") ?? "0";
    const goal = body.goal ?? url.searchParams.get("goal") ?? "1000 members";
    if (!project) return Response.json({ error: "project is required" }, { status: 400 });

    const narrativeRaw = await aeon("narrative-tracker");

    const msRaw = await llm(`You are MiroShark — 4-persona community growth engine.
Personas: Analyst(1.8x), Influencer(2.8x), Retail(1.0x), Observer(0.5x).
Simulate what each persona needs to join and stay in this community.
CRITICAL: Return ONLY raw JSON.
Schema: {
  "personas": {
    "analyst":    {"join_reason":"<why>","retention":"<what keeps them>","weight":1.8},
    "influencer": {"join_reason":"<why>","retention":"<what keeps them>","weight":2.8},
    "retail":     {"join_reason":"<why>","retention":"<what keeps them>","weight":1.0},
    "observer":   {"join_reason":"<why>","retention":"<what keeps them>","weight":0.5}
  },
  "growth_lever": "<highest impact lever>",
  "consensus_strategy": "<1-2 sentences>"
}`,
      `Project: ${project}\nDescription: ${description}\nCurrent size: ${current_size}\nGoal: ${goal}\nNarratives: ${narrativeRaw ?? "Base ecosystem"}`, 0.5, 700);
    const consensus = parseJson(msRaw) ?? {};

    const resultRaw = await llm(`You are Blue Agent — community growth strategist for Base builders.
CRITICAL: Return ONLY raw JSON.
Schema: {
  "growth_score": <0-100>,
  "phase": "cold_start|early_growth|scaling|mature",
  "channels": [{"channel":"<Telegram|Twitter|Discord|etc>","priority":"high|medium|low","tactic":"<specific tactic>"}],
  "content_pillars": ["<content theme>"],
  "engagement_loops": ["<mechanic to retain members>"],
  "milestones": [{"target":"<e.g. 100 members>","tactic":"<how to get there>","timeline":"<e.g. week 1-2>"}],
  "quick_wins": ["<action to do this week>"],
  "avoid": ["<common mistake>"],
  "summary": "<2 sentences>"
}`,
      `Project: ${project}\nCurrent: ${current_size}\nGoal: ${goal}\nNarratives: ${narrativeRaw ?? "Base"}\nConsensus: ${JSON.stringify(consensus)}`, 0.3, 1200);

    let result = parseJson(resultRaw);
    if (!result) result = { degraded: true, note: "Synthesis briefly unavailable - please retry." };

    return Response.json({ tool: "community-growth-playbook", timestamp: new Date().toISOString(), project, current_size, goal, miroshark: consensus, ...result, disclaimer: "AI-generated growth advisory from model knowledge — scores and persona 'consensus' are model estimates, not measured audience research or a guarantee. Verify independently." });
  } catch (e) {
    return Response.json({ error: "Community growth playbook failed", message: (e as Error).message }, { status: 500 });
  }
}
