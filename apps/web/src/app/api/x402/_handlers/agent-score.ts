// x402/agent-score
// Agent Score — anchored in REAL signals when supplied: GitHub repo activity
// (lib/github: live stars/commits/recency) for the agent's codebase, and/or on-chain
// wallet activity on Base (lib/onchain) for its interaction volume. The XP/community
// reputation dimension has no live feed, so it is a clearly labelled AI estimate.
// The LLM never invents the grounded numbers. Resilient: never 500.
// Price: $0.35

import { fetchRepo, slugifyRepo, scoreRepoActivity, repoFactsPrompt, type RepoData } from "@/lib/github";
import { getWalletSnapshot, snapshotToPrompt, normalizeAddress } from "@/lib/onchain";
import { callLLM } from "@/app/api/_lib/llm";

async function llm(system: string, user: string, temp = 0.3, tokens = 700): Promise<string> {
  return (await callLLM({ system, user, temperature: temp, maxTokens: tokens })).text;
}
function parseJson(t: string): Record<string, unknown> | null {
  let s = t.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
  const i = s.indexOf("{"), j = s.lastIndexOf("}");
  if (i >= 0 && j > i) s = s.slice(i, j + 1);
  try { return JSON.parse(s); } catch { try { return JSON.parse(s.replace(/[\x00-\x1F\x7F]/g, " ")); } catch { return null; } }
}

export default async function handler(req: Request): Promise<Response> {
  try {
    let body: { handle?: string; name?: string; repo?: string; github?: string; address?: string } = {};
    try { const t = await req.text(); if (t?.trim().startsWith("{")) body = JSON.parse(t); } catch {}
    const url = new URL(req.url);
    const handle = (body.handle ?? body.name ?? url.searchParams.get("handle") ?? url.searchParams.get("name") ?? "").replace(/^@/, "").trim();
    const repo = (body.repo ?? body.github ?? url.searchParams.get("repo") ?? "").trim();
    const address = (body.address ?? url.searchParams.get("address") ?? "").trim();
    if (!handle && !repo && !address) return Response.json({ error: "handle, repo (github), or address is required" }, { status: 400 });

    // ── Real grounding: GitHub repo activity + on-chain wallet activity ────────
    const [repoData, snap] = await Promise.all([
      repo ? fetchRepo(slugifyRepo(repo)) : Promise.resolve<RepoData | null>(null),
      address && normalizeAddress(address) ? getWalletSnapshot(address) : Promise.resolve(null),
    ]);
    const repoScored = repoData ? scoreRepoActivity(repoData) : null;
    const onchainGrounded = !!snap && (snap.txCount !== null || snap.transferCount > 0);
    const grounded = !!repoScored || onchainGrounded;

    const realCtx = [
      repoScored ? `REAL GitHub activity (agent codebase):\n${repoFactsPrompt(repoData!, repoScored)}` : "No GitHub repo supplied — development activity is an estimate.",
      onchainGrounded ? `REAL on-chain activity (agent wallet):\n${snapshotToPrompt(snap!)}` : "No wallet address supplied — interaction_volume is an estimate.",
      `Agent handle/name: ${handle || "(unknown)"} (Base ecosystem) — NO live XP/uptime feed; those are AI estimates, not measured.`,
    ].join("\n\n");

    const system = `You are Blue Agent — AI agent performance analyst for Base (chain 8453).
${grounded ? "You are given REAL signals (GitHub repo activity score and/or on-chain wallet activity). Anchor interaction_volume on the wallet data and development/uptime credibility on the GitHub data; reference them exactly, never invent numbers." : "No live signals were supplied — clearly frame the score as an estimate."}
The XP and community/reputation dimensions have no live data — treat them as qualitative estimates.
Return ONLY raw JSON. No markdown.
Schema: {
  "score": <0-100>,
  "tier": "apex|elite|active|emerging|unknown",
  "interaction_volume": "high|medium|low|unknown",
  "uptime_reliability": "high|medium|low|unknown",
  "xp_estimate": "<number or unknown — label as estimate>",
  "capabilities": ["<capability>"],
  "known_agent": <boolean>,
  "community": { "score": <0-100>, "ecosystem_impact": "high|medium|low|unknown", "agent_type": "trading|security|builder|social|general|unknown", "verdict": "<1 sentence, labelled estimate>" },
  "blue_assessment": "<2 sentences>"
}`;

    let blue: Record<string, unknown> | null = null;
    for (let attempt = 0; attempt < 2 && !blue; attempt++) {
      try { blue = parseJson(await llm(system, realCtx)); } catch { /* retry */ }
    }
    if (!blue) blue = { score: null, tier: "unknown", interaction_volume: "unknown", uptime_reliability: "unknown", xp_estimate: "unknown", capabilities: [], known_agent: false, community: { score: null, ecosystem_impact: "unknown", agent_type: "unknown", verdict: "Estimate unavailable this run." }, blue_assessment: "Synthesis briefly unavailable — re-run.", degraded: true };

    // When GitHub-grounded, anchor the headline score on the real activity score.
    const score = repoScored ? Math.round(repoScored.score * 0.6 + ((blue.score as number) ?? repoScored.score) * 0.4) : ((blue.score as number) ?? null);
    const tier = score == null ? "unknown" : score >= 85 ? "apex" : score >= 70 ? "elite" : score >= 50 ? "active" : score >= 30 ? "emerging" : "unknown";

    return Response.json({
      tool: "agent-score",
      timestamp: new Date().toISOString(),
      data_source: grounded
        ? `${repoScored ? "GitHub (live repo activity)" : ""}${repoScored && onchainGrounded ? " + " : ""}${onchainGrounded ? "Base RPC/Basescan (live on-chain)" : ""} + XP/community estimate`.trim()
        : "AI estimate (no repo/address supplied — XP/community not measured)",
      handle: handle || null,
      github: repoScored ? { repo: repoData!.fullName, score: repoScored.score, grade: repoScored.grade, dimensions: repoScored.dimensions, stars: repoData!.stars, days_since_push: repoData!.daysSincePush, recent_commits: repoData!.commitCount } : null,
      onchain: onchainGrounded ? { tx_count: snap!.txCount, distinct_tokens: snap!.distinctTokens, last_activity_days: snap!.lastActivityDays } : null,
      ...blue,
      ...(score != null ? { score, tier } : {}),
    });
  } catch (error) {
    console.error("[AgentScore]", error);
    return Response.json({ tool: "agent-score", timestamp: new Date().toISOString(), degraded: true, note: "Agent score unavailable this run — please retry.", message: (error as Error).message });
  }
}
