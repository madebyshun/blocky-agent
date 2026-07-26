// x402/builder-deep-dd/index.ts
// Builder Deep DD — Aeon deep-research + Blue audit + MiroShark analyst
// Price: $1.00 — comprehensive due diligence on a builder or project
// Fully self-contained

import { slugifyRepo, fetchRepo, scoreRepoActivity, repoFactsPrompt } from "@/lib/github";

import { getAeonOutput, formatAeonForLLM } from "@/app/api/_lib/aeon-kv";
import { callLLM } from "@/app/api/_lib/llm";

async function llm(system: string, user: string, temp = 0, tokens = 1000, model = "claude-haiku-4-5"): Promise<string> {
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
    let body: { target?: string; type?: string; context?: string } = {};
    try { const t = await req.text(); if (t.trim().startsWith("{")) body = JSON.parse(t); } catch {}
    const url = new URL(req.url);
    const target = body.target ?? url.searchParams.get("target") ?? "";
    const type = body.type ?? url.searchParams.get("type") ?? "project";
    const context = body.context ?? url.searchParams.get("context") ?? "";
    if (!target) return Response.json({ error: "target is required (builder handle, project name, or GitHub repo)" }, { status: 400 });

    // ── REAL grounding: GitHub repo activity (no hallucinated metrics) ──────────
    let ghFacts = "";
    try {
      const slug = slugifyRepo(target.includes("/") ? target : (context.includes("/") ? context : target));
      if (slug && slug.includes("/")) {
        const repo = await fetchRepo(slug);
        if (repo) ghFacts = repoFactsPrompt(repo, scoreRepoActivity(repo));
      }
    } catch {}
    const GROUNDING = ghFacts
      ? `REAL GitHub signals (authoritative — use ONLY these GitHub numbers for technical/shipping claims. You have NO on-chain/financial data source. HARD RULE: NEVER state any TVL, dollar amount, transaction count, agent/user count, growth %, or named integration (Uniswap/Aave/etc) — you cannot know these. Every shipping_evidence item must be derivable from the GitHub facts below or omitted. Fabricating financial metrics = critical failure):
${ghFacts}`
      : `NO live GitHub/on-chain data was resolved for this target. You therefore CANNOT cite specific metrics. Do NOT invent transaction counts, agent counts, TVL, dates, framework integrations, or third-party endorsements (e.g. "Coinbase recommends"). State clearly that technical DD is "insufficient data — provide a GitHub repo (user/repo) for grounded analysis" and keep all assessments explicitly qualitative and labeled as model estimate.`;

    // Step 1: Aeon deep-research (single KV read — both legs previously fetched
    // the same key, so the "background" copy was redundant).
    const projectResearch = await aeon("deep-research");

    // Step 3: Blue audit — code/product quality signals
    const auditRaw = await llm(`${GROUNDING}

You are Blue Agent running 'blue audit'. Assess product and technical quality signals.
CRITICAL: Return ONLY raw JSON.
Schema: {
  "product_score": <0-10>,
  "technical_credibility": <0-10>,
  "shipping_evidence": ["<evidence of shipping>"],
  "security_concerns": ["<concern or 'none identified'>"],
  "open_source": <boolean>,
  "audit_verdict": "<1-2 sentences>"
}`,
      `Target: ${target}\nType: ${type}\nContext: ${context}\nResearch: ${projectResearch ?? target}`, 0.3, 700);
    const audit = parseJson(auditRaw) ?? {};

    // Step 4: MiroShark analyst — investment/collaboration grade
    const msRaw = await llm(`${GROUNDING}

You are MiroShark analyst persona — data-driven, skeptical, fundamentals-focused.
Perform analyst-grade due diligence assessment.
CRITICAL: Return ONLY raw JSON.
Schema: {
  "grade": "A|B|C|D|F",
  "conviction": "high|medium|low",
  "bull_case": "<2 sentences>",
  "bear_case": "<2 sentences>",
  "key_risks": ["<risk>"],
  "key_strengths": ["<strength>"],
  "comparable": "<similar project or builder>",
  "analyst_verdict": "<2-3 sentences>"
}`,
      `Target: ${target}\nProject research: ${projectResearch ?? target}\nAudit: ${JSON.stringify(audit)}`, 0.3, 800);
    const analyst = parseJson(msRaw) ?? {};

    // Step 5: Blue Agent final DD synthesis
    const resultRaw = await llm(`${GROUNDING}

You are Blue Agent — deep due diligence engine for Base builders and investors.
CRITICAL: Return ONLY raw JSON.
Schema: {
  "dd_score": <0-100>,
  "verdict": "STRONG_BUY|BUY|WATCH|PASS|RED_FLAG",
  "confidence": <0-100>,
  "summary": "<3-4 sentences comprehensive summary>",
  "thesis": "<investment/collaboration thesis in 2 sentences>",
  "strengths": ["<strength>"],
  "risks": ["<risk>"],
  "red_flags": ["<red flag or 'none'>"],
  "data_basis": "<state EXACTLY what real data backs this DD (e.g. GitHub commits/stars/recency); explicitly flag what is NOT verifiable — onchain, funding, partnerships>",
  "recommended_action": "<specific next step>",
  "open_questions": ["<question to answer before deciding>"]
}`,
      `Target: ${target}\nType: ${type}\nProject: ${projectResearch ?? target}\nAudit: ${JSON.stringify(audit)}\nAnalyst: ${JSON.stringify(analyst)}`,  0, 1500, "claude-sonnet-4-5");

    let result = parseJson(resultRaw);
    // HARDMAP verdict from dd_score (deterministic, no LLM flip)
    if (result && typeof result.dd_score === "number") {
      const v = result.dd_score;
      result.verdict = v >= 80 ? "STRONG_BUY" : v >= 60 ? "BUY" : v >= 40 ? "WATCH" : v >= 20 ? "PASS" : "RED_FLAG";
    }
    if (!result) result = { degraded: true, note: "Synthesis briefly unavailable - please retry." };

    return Response.json({
      tool: "builder-deep-dd",
      timestamp: new Date().toISOString(),
      target,
      type,
      audit,
      analyst,
      ...result,
      disclaimer: "AI-generated due-diligence from model knowledge — NOT verified findings. The dd_score, confidence, and every checklist pass/fail are unverified estimates. Independently confirm code, team, and security claims before relying on them.",
    });
  } catch (e) {
    return Response.json({ error: "Builder deep DD failed", message: (e as Error).message }, { status: 500 });
  }
}
