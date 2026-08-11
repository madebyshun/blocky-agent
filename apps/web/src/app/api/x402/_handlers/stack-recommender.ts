// x402/stack-recommender/index.ts
// Stack Recommender — Blue build + Aeon deep-research + MiroShark analyst
// Price: $0.35
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
    let body: { project?: string; description?: string; team_size?: number; timeline?: string } = {};
    try { const t = await req.text(); if (t.trim().startsWith("{")) body = JSON.parse(t); } catch {}
    const { project = "", description = "", team_size = 1, timeline = "3 months" } = body;
    if (!project || !description) return Response.json({ error: "project and description are required" }, { status: 400 });

    const [ecosystemRaw, buildRaw] = await Promise.all([
      aeon("deep-research"),
      llm(`You are Blue Agent running 'blue build'. Recommend stack for Base builders.
CRITICAL: Return ONLY raw JSON.
Schema: {
  "recommended_stack": {
    "frontend": "<framework>",
    "backend": "<language/framework>",
    "smart_contracts": "<language>",
    "database": "<db>",
    "payments": "<x402/USDC approach>",
    "deployment": "<platform>"
  },
  "reasoning": "<2 sentences>",
  "alternatives": [{"layer":"<layer>","option":"<alt>","tradeoff":"<1 sentence>"}]
}`,
        `Project: ${project}\nDescription: ${description}\nTeam size: ${team_size}\nTimeline: ${timeline}`, 0.3, 800),
    ]);

    const buildRecommendation = parseJson(buildRaw) ?? {};

    const msRaw = await llm(`You are MiroShark analyst persona — data-driven, technical, skeptical.
Review this stack recommendation for a Base project.
CRITICAL: Return ONLY raw JSON.
Schema: {"confidence":<0-100>,"risks":["<tech risk>"],"ecosystem_fit":"strong|moderate|weak","battle_tested":<boolean>,"analyst_note":"<1-2 sentences>"}`,
      `Project: ${project}\nStack: ${JSON.stringify(buildRecommendation)}\nEcosystem context: ${ecosystemRaw ?? "Base ecosystem"}`, 0.3, 500);
    const analystTake = parseJson(msRaw) ?? {};

    const resultRaw = await llm(`You are Blue Agent — stack recommendation engine for Base builders.
CRITICAL: Return ONLY raw JSON.
Schema: {
  "confidence": <0-100>,
  "stack": <copy recommended_stack>,
  "why_this_stack": ["<reason>"],
  "time_to_mvp": "<estimate>",
  "hiring_complexity": "easy|medium|hard",
  "base_specific_tools": ["<tool> — <why>"],
  "week_1_setup": ["<setup step>"],
  "avoid": ["<antipattern>"]
}`,
      `Project: ${project}\nBuild: ${JSON.stringify(buildRecommendation)}\nEcosystem: ${ecosystemRaw ?? "Base"}\nAnalyst: ${JSON.stringify(analystTake)}`, 0.3, 900);

    let result = parseJson(resultRaw);
    if (!result) result = { degraded: true, note: "Synthesis briefly unavailable - please retry." };

    return Response.json({ tool: "stack-recommender", timestamp: new Date().toISOString(), project, team_size, timeline, analyst: analystTake, ...result, disclaimer: "AI-generated stack advisory from model knowledge — recommendations and any confidence score are estimates, not a guarantee. Validate against your own constraints." });
  } catch (e) {
    return Response.json({ error: "Stack recommender failed", message: (e as Error).message }, { status: 500 });
  }
}
