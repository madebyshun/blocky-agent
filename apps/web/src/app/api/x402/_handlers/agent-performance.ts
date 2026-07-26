// x402/agent-performance
// Agent Performance Report — grounded in REAL GitHub activity when a repo is
// supplied (live stars/commits/recency → deterministic activity score). The LLM
// only writes the narrative on top; without a repo it's a labelled estimate.
// Resilient: retry + graceful fallback, never 500.
// Price: $0.35

import { fetchRepo, slugifyRepo, scoreRepoActivity, repoFactsPrompt, type RepoData } from "@/lib/github";
import { callLLM } from "@/app/api/_lib/llm";

async function llm(system: string, user: string, temp = 0.3, tokens = 900): Promise<string> {
  return (await callLLM({ system, user, temperature: temp, maxTokens: tokens })).text;
}
function parseJson(t: string): Record<string, unknown> | null {
  let s = t.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const i = s.indexOf("{"), j = s.lastIndexOf("}");
  if (i >= 0 && j > i) s = s.slice(i, j + 1);
  try { return JSON.parse(s); } catch { try { return JSON.parse(s.replace(/[\x00-\x1F]/g, " ")); } catch { return null; } }
}

export default async function handler(req: Request): Promise<Response> {
  try {
    let body: { handle?: string; repo?: string; agent?: string } = {};
    try { const t = await req.text(); if (t.trim().startsWith("{")) body = JSON.parse(t); } catch {}
    const url = new URL(req.url);
    const handle = body.handle ?? body.agent ?? url.searchParams.get("handle") ?? url.searchParams.get("agent") ?? "";
    const repo = body.repo ?? url.searchParams.get("repo") ?? "";
    if (!handle && !repo) return Response.json({ error: "handle (agent) or repo is required" }, { status: 400 });

    // ── Ground in real GitHub activity when a repo is provided ────────────────
    let repoData: RepoData | null = null;
    let scored: ReturnType<typeof scoreRepoActivity> | null = null;
    if (repo) {
      repoData = await fetchRepo(slugifyRepo(repo));
      if (repoData) scored = scoreRepoActivity(repoData);
    }
    const grounded = !!(repoData && scored);

    const ctx = grounded
      ? `Agent: ${handle || repoData!.fullName}\n${repoFactsPrompt(repoData!, scored!)}`
      : `Agent handle: ${handle || "(unknown)"} — NO GitHub repo supplied. Give a clearly-labelled qualitative ESTIMATE; do not present precise scores as measured.`;

    const system = `You are Blue Agent — agent performance report engine for Base.
${grounded
      ? "You are given REAL GitHub metrics + a computed activity score. Reference them exactly; never invent numbers. Anchor performance_score near the computed activity/community/hygiene."
      : "No live data was supplied — clearly frame the output as an estimate, not measured."}
Return ONLY raw JSON. No markdown.
Schema: {
  "performance_score": <0-100>,
  "trend": "improving|stable|declining|unknown",
  "ecosystem_standing": "leading|active|emerging|dormant",
  "top_strengths": ["<strength grounded in the data if available>"],
  "improvement_areas": ["<area>"],
  "recommended_next_skills": ["<skill to add>"],
  "report_summary": "<2-3 sentences>"
}`;

    let result: Record<string, unknown> | null = null;
    for (let attempt = 0; attempt < 2 && !result; attempt++) {
      try { result = parseJson(await llm(system, ctx)); } catch { /* retry then fallback */ }
    }
    if (!result) {
      result = {
        performance_score: scored?.score ?? null,
        trend: "unknown",
        ecosystem_standing: "emerging",
        top_strengths: [],
        improvement_areas: [],
        recommended_next_skills: [],
        report_summary: grounded
          ? "Narrative synthesis briefly unavailable — scores below are from real GitHub activity. Re-run for detail."
          : "Estimate unavailable this run; supply a GitHub repo to ground the report in real activity.",
        degraded: true,
      };
    }

    return Response.json({
      tool: "agent-performance",
      timestamp: new Date().toISOString(),
      data_source: grounded ? "GitHub API (live repo activity)" : "estimate (no repo supplied — not measured)",
      handle: handle || null,
      repo: repo || null,
      github: grounded
        ? {
            repo: repoData!.fullName,
            score: scored!.score,
            grade: scored!.grade,
            dimensions: scored!.dimensions,
            stars: repoData!.stars,
            forks: repoData!.forks,
            days_since_push: repoData!.daysSincePush,
            recent_commits: repoData!.commitCount,
            archived: repoData!.archived,
          }
        : null,
      ...result,
      // performance_score: prefer the real computed score over LLM when grounded
      ...(grounded ? { performance_score: scored!.score } : {}),
    });
  } catch (e) {
    return Response.json({ error: "Agent performance report failed", message: (e as Error).message }, { status: 500 });
  }
}
