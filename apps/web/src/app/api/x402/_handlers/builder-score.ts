// x402/builder-score
// Builder Score — anchored in REAL signals:
//   • GitHub profile + repos by handle (public API, no key) — followers, repos,
//     stars, languages, account age.
//   • GitHub repo activity if a repo slug is supplied (lib/github).
//   • On-chain wallet activity on Base if an address is supplied (lib/onchain).
// No live web search (Virtuals-only): score is grounded in GitHub + on-chain
// data; CT/Farcaster presence cannot be verified and is reported [data unavailable]
// in real results, not guessed from the handle name. The LLM never invents the
// grounded numbers; missing data is labelled "unavailable". Resilient: never 500.
// Price: $0.35

import { fetchRepo, slugifyRepo, scoreRepoActivity, repoFactsPrompt, type RepoData } from "@/lib/github";
import { getWalletSnapshot, snapshotToPrompt, normalizeAddress } from "@/lib/onchain";
import { callVeniceLLM, extractJsonObject } from "@/app/api/_lib/llm";

// ─── GitHub profile + repos by handle (public API, no key) ───────────────────
type GhUser = { login: string; name?: string | null; public_repos: number; followers: number; created_at: string };
type GhRepo = { name: string; stargazers_count: number; language: string | null; fork: boolean };
type GhProfile = {
  login: string;
  public_repos: number;
  followers: number;
  created_at: string;
  total_stars: number;
  top_repos: { name: string; stars: number; language: string | null }[];
};

async function fetchGithub(handle: string): Promise<GhProfile | null> {
  // GitHub usernames: alphanumeric + hyphen, ≤39 chars.
  if (!/^[a-zA-Z0-9-]{1,39}$/.test(handle)) return null;
  // GitHub REQUIRES a User-Agent or it 403s.
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "blue-agent" };
  try {
    const [uRes, rRes] = await Promise.all([
      fetch(`https://api.github.com/users/${handle}`, { headers, signal: AbortSignal.timeout(8000) }),
      fetch(`https://api.github.com/users/${handle}/repos?per_page=100&sort=updated`, { headers, signal: AbortSignal.timeout(8000) }),
    ]);
    if (!uRes.ok) return null; // 404 (not a GitHub user) / 403 (rate limit) → unavailable
    const u = (await uRes.json()) as GhUser;
    const repos = rRes.ok ? ((await rRes.json()) as GhRepo[]) : [];
    const owned = Array.isArray(repos) ? repos.filter((r) => !r.fork) : [];
    const total_stars = owned.reduce((s, r) => s + (r.stargazers_count || 0), 0);
    const top_repos = owned
      .slice()
      .sort((a, b) => (b.stargazers_count || 0) - (a.stargazers_count || 0))
      .slice(0, 5)
      .map((r) => ({ name: r.name, stars: r.stargazers_count || 0, language: r.language ?? null }));
    return { login: u.login, public_repos: u.public_repos, followers: u.followers, created_at: u.created_at, total_stars, top_repos };
  } catch {
    return null;
  }
}

function parseJson(t: string): Record<string, unknown> | null {
  return extractJsonObject(t);
}

export default async function handler(req: Request): Promise<Response> {
  try {
    let body: { handle?: string; repo?: string; github?: string; address?: string } = {};
    try { const t = await req.text(); if (t?.trim().startsWith("{")) body = JSON.parse(t); } catch {}
    const url = new URL(req.url);
    const handle = (body.handle ?? url.searchParams.get("handle") ?? "").replace(/^@/, "").trim();
    const repo = (body.repo ?? body.github ?? url.searchParams.get("repo") ?? "").trim();
    const address = (body.address ?? url.searchParams.get("address") ?? "").trim();
    if (!handle && !repo && !address) return Response.json({ error: "handle, repo (github), or address is required" }, { status: 400 });

    // ── Real grounding: GitHub (repo slug AND/OR handle profile) + on-chain ────
    const [repoData, gh, snap] = await Promise.all([
      repo ? fetchRepo(slugifyRepo(repo)) : Promise.resolve<RepoData | null>(null),
      handle ? fetchGithub(handle) : Promise.resolve<GhProfile | null>(null),
      address && normalizeAddress(address) ? getWalletSnapshot(address) : Promise.resolve(null),
    ]);
    const repoScored = repoData ? scoreRepoActivity(repoData) : null;
    const onchainGrounded = !!snap && (snap.txCount !== null || snap.transferCount > 0);
    const githubGrounded = !!repoScored || !!gh;
    const grounded = githubGrounded || onchainGrounded;

    const realCtx = [
      repoScored ? `REAL GitHub repo activity:\n${repoFactsPrompt(repoData!, repoScored)}` : "",
      gh
        ? `REAL GitHub profile @${gh.login}: public_repos=${gh.public_repos}, followers=${gh.followers}, account_created=${gh.created_at}, total_stars(owned)=${gh.total_stars}. Top repos: ${gh.top_repos.map((r) => `${r.name} (${r.stars}★${r.language ? ", " + r.language : ""})`).join(", ") || "none"}.`
        : "",
      !githubGrounded ? `github: unavailable — no GitHub data found for "${handle || repo || "(none)"}". Do NOT infer GitHub activity, shipping history, or technical skill from the handle NAME.` : "",
      onchainGrounded ? `REAL on-chain activity:\n${snapshotToPrompt(snap!)}` : "onchain: unavailable — no wallet address supplied. Do NOT infer on-chain activity.",
      `Builder X/Twitter handle: @${handle || "(unknown)"}. No live web/social access — you cannot verify CT / Farcaster presence, so write "[data unavailable]" for community/CT signals rather than guessing.`,
    ].filter(Boolean).join("\n\n");

    const system = `You are Blue Agent — builder reputation analyst for Base (chain 8453).
You are given REAL signals where available (GitHub profile/repo activity, on-chain wallet activity). Anchor shipping_history + technical_credibility on the GitHub data and onchain_activity on the wallet data — reference the real numbers, never invent them.
CRITICAL: Never infer skill, output, or reputation from the handle's NAME or vibe. If a dimension has no real data, set it to "unknown" and say so. There is NO live web/social access, so community/CT presence cannot be verified — write "[data unavailable]" for it, never a guess.
Return ONLY raw JSON. No markdown.
Schema: {
  "score": <0-100 or null if no data>,
  "tier": "legendary|elite|active|emerging|unknown",
  "onchain_activity": "high|medium|low|unknown",
  "shipping_history": "prolific|active|occasional|unknown",
  "technical_credibility": "high|medium|low|unknown",
  "base_ecosystem_score": <0-100 or null>,
  "known_projects": ["<project, only if verified>"],
  "community": { "score": <0-100 or null>, "ct_presence": "strong|moderate|minimal|unknown", "verdict": "<1 sentence, cite source or [data unavailable]>" },
  "blue_assessment": "<2 sentences grounded in the real data above>"
}`;

    let blue: Record<string, unknown> | null = null;
    for (let attempt = 0; attempt < 2 && !blue; attempt++) {
      try { blue = parseJson(await callVeniceLLM({ system, user: realCtx, temperature: 0.3, maxTokens: 900 })); } catch { /* retry */ }
    }
    if (!blue) blue = { score: null, tier: "unknown", onchain_activity: "unknown", shipping_history: "unknown", technical_credibility: "unknown", base_ecosystem_score: null, known_projects: [], community: { score: null, ct_presence: "unknown", verdict: "Estimate unavailable this run." }, blue_assessment: "Synthesis briefly unavailable — see github/onchain data below, or re-run.", degraded: true };

    // Anchor the headline score on the real GitHub repo score when available.
    const score = repoScored ? Math.round(repoScored.score * 0.6 + ((blue.base_ecosystem_score as number) ?? repoScored.score) * 0.4) : ((blue.score as number) ?? null);
    const tier = score == null ? "unknown" : score >= 85 ? "legendary" : score >= 70 ? "elite" : score >= 50 ? "active" : score >= 30 ? "emerging" : "unknown";

    return Response.json({
      tool: "builder-score",
      timestamp: new Date().toISOString(),
      data_source: [
        repoScored ? "GitHub repo (live)" : "",
        gh ? "GitHub profile (live)" : "",
        onchainGrounded ? "Base RPC/Basescan (live)" : "",
        "CT/community: [data unavailable] (no live web access)",
      ].filter(Boolean).join(" + "),
      handle: handle || null,
      url: handle ? `https://x.com/${handle}` : null,
      github: repoScored
        ? { repo: repoData!.fullName, score: repoScored.score, grade: repoScored.grade, dimensions: repoScored.dimensions, stars: repoData!.stars, days_since_push: repoData!.daysSincePush, recent_commits: repoData!.commitCount }
        : gh
        ? { profile: gh.login, public_repos: gh.public_repos, followers: gh.followers, account_created: gh.created_at, total_stars: gh.total_stars, top_repos: gh.top_repos }
        : "unavailable",
      onchain: onchainGrounded ? { eth_balance: snap!.ethBalance, tx_count: snap!.txCount, distinct_tokens: snap!.distinctTokens, last_activity_days: snap!.lastActivityDays } : "unavailable",
      ...blue,
      ...(score != null ? { score, tier } : {}),
    });
  } catch (error) {
    console.error("[BuilderScore]", error);
    return Response.json({ tool: "builder-score", timestamp: new Date().toISOString(), degraded: true, note: "Builder score unavailable this run — please retry.", message: (error as Error).message });
  }
}
