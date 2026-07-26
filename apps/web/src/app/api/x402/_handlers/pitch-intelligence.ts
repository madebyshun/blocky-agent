// x402/pitch-intelligence/index.ts
// Pitch Intelligence — Blue raise + Aeon narrative-tracker + MiroShark influencer
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
    let body: { project?: string; description?: string; pitch_summary?: string; ask?: string; stage?: string } = {};
    try { const t = await req.text(); if (t.trim().startsWith("{")) body = JSON.parse(t); } catch {}
    // Accept "pitch_summary" (Hub UI) as alias for "description"
    const project     = body.project ?? "";
    const description = body.description ?? body.pitch_summary ?? "";
    const ask         = body.ask ?? "";
    const stage       = body.stage ?? "pre-seed";
    if (!project || !description) return Response.json({ error: "project and pitch summary are required" }, { status: 400 });

    const [narrativeRaw, raiseRaw] = await Promise.all([
      aeon("narrative-tracker"),
      llm(`You are Blue Agent running 'blue raise'. Build pitch narrative for Base builders.
The project name is EXACTLY "${project}". NEVER alter, shorten, abbreviate, or rename it — use it verbatim.
CRITICAL: Return ONLY raw JSON.
Schema: {"market_framing":"<1-2 sentences>","why_this_wins":"<1-2 sentences>","why_now":"<1 sentence>","why_base":"<1 sentence>","ask_framing":"<1 sentence>","target_investor_type":"<e.g. crypto-native, generalist, strategic>"}`,
        `Project: ${project}\nDescription: ${description}\nAsk: ${ask || "not specified"}\nStage: ${stage}`, 0.4, 700),
    ]);

    const raisePitch = parseJson(raiseRaw) ?? {};

    const msRaw = await llm(`You are MiroShark influencer persona — narrative-driven, focuses on virality, community, social momentum.
Evaluate this pitch from an influencer/KOL perspective. Would you hype this?
CRITICAL: Return ONLY raw JSON.
Schema: {"would_hype":<boolean>,"hype_score":<0-10>,"narrative_hooks":["<hook>"],"weak_points":["<weak point>"],"suggested_angle":"<best narrative angle>","influencer_verdict":"<1 sentence>"}`,
        `Project: ${project}\nDescription: ${description}\nNarratives: ${narrativeRaw ?? "Base ecosystem"}\nPitch: ${JSON.stringify(raisePitch)}`, 0.5, 600);
    const influencerTake = parseJson(msRaw) ?? { would_hype: false, hype_score: 5, narrative_hooks: [], weak_points: [], suggested_angle: "Focus on Base-native angle", influencer_verdict: "Needs stronger narrative" };

    const resultRaw = await llm(`You are Blue Agent — pitch intelligence engine.
The project name is EXACTLY "${project}". NEVER alter, shorten, abbreviate, or rename it — output it verbatim in every field.
CRITICAL: Return ONLY raw JSON.
Schema: {
  "pitch_score": <0-100>,
  "narrative_timing": "perfect|good|neutral|bad",
  "narrative_fit_score": <0-10>,
  "pitch_angles": ["<angle>"],
  "investor_thesis": "<2-3 sentences ready to paste>",
  "one_liner": "<10 words or less>",
  "strengthen": ["<specific improvement>"],
  "avoid": ["<what not to say>"],
  "best_investor_type": "<specific profile>"
}`,
      `Project: ${project}\nDescription: ${description}\nAsk: ${ask}\nStage: ${stage}\nPitch: ${JSON.stringify(raisePitch)}\nNarratives: ${narrativeRaw ?? "Base"}\nInfluencer: ${JSON.stringify(influencerTake)}`, 0.3, 1000);

    let result = parseJson(resultRaw);
    if (!result) result = { degraded: true, note: "Synthesis briefly unavailable - please retry." };

    return Response.json({ tool: "pitch-intelligence", timestamp: new Date().toISOString(), project, stage, raise_pitch: raisePitch, influencer: influencerTake, ...result, disclaimer: "Pitch scores (hype_score, verdict) are AI estimates from model knowledge, not measured from live investor or social data." });
  } catch (e) {
    return Response.json({ error: "Pitch intelligence failed", message: (e as Error).message }, { status: 500 });
  }
}
