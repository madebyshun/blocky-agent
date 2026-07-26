// x402/base-grant-finder/index.ts
// Base Grant Finder — Aeon deep-research + MiroShark analyst + Blue raise
// Price: $0.35

import { getAeonOutput, formatAeonForLLM } from "@/app/api/_lib/aeon-kv";
import { callLLM } from "@/app/api/_lib/llm";

async function llm(system: string, user: string, temp = 0.4, tokens = 1000): Promise<string> {
  return (await callLLM({ system, user, temperature: temp, maxTokens: tokens })).text;
}

// Real, stable Base funding ladder — used as a graceful fallback when the live
// LLM match fails, so a paid call never 500s. Amounts kept deliberately vague
// (we don't fabricate precise figures); program names + channels are accurate.
function fallbackGrants(stage: string): Record<string, unknown> {
  return {
    match_score: 55,
    grants: [
      {
        name: "Base Builder Grants",
        org: "Coinbase / Base",
        amount: "builder-tier (varies)",
        fit: "good",
        requirements: ["Building on Base mainnet", "Working prototype or clear plan", "Active development"],
        apply_by: "Rolling",
        application_tip: "Apply via the official Base grants channel; lead with a working demo on Base.",
      },
      {
        name: "Optimism RetroPGF (Superchain)",
        org: "Optimism Collective",
        amount: "varies by round",
        fit: stage === "live" ? "good" : "stretch",
        requirements: ["Shipped product with measurable impact", "Public-good contribution to the ecosystem"],
        apply_by: "Seasonal rounds",
        application_tip: "Frame your work as public goods that improve Base / Superchain UX.",
      },
      {
        name: "Coinbase Ventures",
        org: "Coinbase",
        amount: "equity (varies)",
        fit: "stretch",
        requirements: ["Incorporated entity", "Early traction", "Clear go-to-market"],
        apply_by: "Via warm intro",
        application_tip: "Pursue after an MVP + early traction; position as consumer infra on Base.",
      },
    ],
    strongest_narrative: "Position the project as infrastructure that strengthens the Base ecosystem and drives onchain activity.",
    application_priorities: ["Ship an MVP on Base mainnet", "Show real usage / traction", "Emphasize Base-native value"],
    missing_credentials: ["Working MVP", "Early user traction"],
    estimated_total: "varies",
    summary: "Tailored live matching was briefly unavailable — this is the standard Base funding ladder. Re-run the tool for a project-specific match.",
    degraded: true,
  };
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
    let body: { project?: string; description?: string; stage?: string; sector?: string } = {};
    try { const t = await req.text(); if (t.trim().startsWith("{")) body = JSON.parse(t); } catch {}
    const url = new URL(req.url);
    const project = body.project ?? url.searchParams.get("project") ?? "";
    const description = body.description ?? url.searchParams.get("description") ?? "";
    const stage = body.stage ?? url.searchParams.get("stage") ?? "early";
    const sector = body.sector ?? url.searchParams.get("sector") ?? "";
    if (!project) return Response.json({ error: "project is required" }, { status: 400 });

    // Grants are verifiable facts that change — NEVER let the model invent names/amounts/deadlines.
    // fallbackGrants() is the curated source of truth; LLM only ranks/personalizes within it.
    // Compute once and reuse (CURATED list, no-result fallback, and final grants).
    const fallback = fallbackGrants(stage);
    const CURATED = fallback.grants;
    const researchRaw = await aeon("deep-research");

    // Analyst pass — non-fatal: a hiccup here shouldn't sink the whole call.
    let analyst: Record<string, unknown> = {};
    try {
      const msRaw = await llm(`You are MiroShark analyst persona — grant and funding specialist.
Match within CURATED only. HARD RULE: never invent grant names, amounts, deadlines, or success %.
CRITICAL: Return ONLY raw JSON.
Schema: {
  "grant_fit": "excellent|good|fair|poor",
  "best_match": "<MUST be a name from CURATED — never invent>",
  "fit_reason": "<why it fits, 1 sentence>",
  "analyst_verdict": "<1-2 sentences>"
}`,
        `CURATED (only real grants):\n${JSON.stringify(CURATED)}\n\nProject: ${project}\nDescription: ${description}\nStage: ${stage}\nSector: ${sector}`, 0, 500);
      analyst = parseJson(msRaw) ?? {};
    } catch { analyst = {}; }

    const resultSystem = `You are Blue Agent — grant finder for Base ecosystem builders.
CRITICAL: Return ONLY raw JSON.
Schema: {
  "match_score": <0-100>,
  "grant_tips": [{"name":"<name from CURATED only>","fit":"perfect|good|stretch","application_tip":"<how to win, 1 sentence>"}],
  "strongest_narrative": "<the angle that wins grants>",
  "application_priorities": ["<what to emphasize>"],
  "missing_credentials": ["<what to build before applying>"],
  "summary": "<2 sentences>"
}`;
    const resultUser = `CURATED (only real grants — personalize these, NEVER invent others or amounts):\n${JSON.stringify(CURATED)}\n\nProject: ${project}\nDescription: ${description}\nStage: ${stage}\nSector: ${sector}\nAnalyst: ${JSON.stringify(analyst)}`;

    // Up to 2 attempts, then a graceful real-data fallback — never 500 on a paid call.
    let result: Record<string, unknown> | null = null;
    for (let attempt = 0; attempt < 2 && !result; attempt++) {
      try {
        result = parseJson(await llm(resultSystem, resultUser, 0, 1200));
      } catch { /* retry, then fall through to fallback */ }
    }
    if (!result) result = fallback;

    return Response.json({ tool: "base-grant-finder", timestamp: new Date().toISOString(), project, stage, sector, analyst, ...result, grants: fallback.grants, disclaimer: "Grant programs are known Base/ecosystem programs from model knowledge plus AI matching — they may be out of date. Verify current status, deadlines and eligibility on each program's official channel before applying." });
  } catch (e) {
    return Response.json({ error: "Base grant finder failed", message: (e as Error).message }, { status: 500 });
  }
}
