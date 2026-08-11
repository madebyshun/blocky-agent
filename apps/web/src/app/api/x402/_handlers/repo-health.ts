// x402/repo-health
// Repo Health Check — REAL GitHub data + LLM qualitative review.
// Price: $0.35. Fully self-contained (no workspace imports — Bankr-deployable).
//
// Numeric scores are derived from live GitHub metrics (stars, forks, open
// issues, commit recency/velocity, presence of tests/CI/docs), NOT guessed by
// the LLM. The model only writes the qualitative summary + flags, grounded in
// the fetched data.

import { callLLM } from "@/app/api/_lib/llm";

// Delegates to the shared Virtuals → Venice → Bankr chain. Bankr was
// banned 2026-07-18; the direct-Bankr fetch this used to do is dead
// on prod. `callLLM` retries providers in order and returns text +
// provenance. Signature kept identical so all call sites stay untouched.
async function llm(system: string, user: string, temp = 0.3, tokens = 700): Promise<string> {
  const r = await callLLM({ system, user, temperature: temp, maxTokens: tokens });
  return r.text;
}
function parseJson(t: string): Record<string, unknown> | null {
  let s = t.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const i = s.indexOf("{"), j = s.lastIndexOf("}");
  if (i >= 0 && j > i) s = s.slice(i, j + 1);
  try { return JSON.parse(s); } catch { return null; }
}

const GH = "https://api.github.com";
function ghHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Accept": "application/vnd.github+json", "User-Agent": "blue-agent" };
  if (process.env.GITHUB_TOKEN) h["Authorization"] = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}
function slugify(repo: string): string {
  return repo.replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "").replace(/\/$/, "").trim();
}

interface RepoData {
  fullName: string; description: string; stars: number; forks: number;
  openIssues: number; watchers: number; daysSincePush: number | null;
  language: string; license: string; archived: boolean; topics: string[];
  commitCount: number; commitDays: number | null; rootFiles: string[];
}

async function fetchRepo(slug: string): Promise<RepoData | null> {
  const res = await fetch(`${GH}/repos/${slug}`, { headers: ghHeaders(), signal: AbortSignal.timeout(6000) });
  if (!res.ok) return null;
  const d = await res.json() as Record<string, unknown>;
  const pushedAt = (d.pushed_at as string) ?? "";
  const daysSincePush = pushedAt ? Math.floor((Date.now() - new Date(pushedAt).getTime()) / 86_400_000) : null;

  // recent commits (velocity) + root contents (tests/CI/docs presence)
  const [commitsRes, contentsRes] = await Promise.all([
    fetch(`${GH}/repos/${slug}/commits?per_page=30`, { headers: ghHeaders(), signal: AbortSignal.timeout(6000) }).catch(() => null),
    fetch(`${GH}/repos/${slug}/contents`, { headers: ghHeaders(), signal: AbortSignal.timeout(6000) }).catch(() => null),
  ]);
  let commitCount = 0, commitDays: number | null = null;
  if (commitsRes?.ok) {
    const commits = await commitsRes.json() as Record<string, unknown>[];
    commitCount = commits.length;
    const last = ((commits[0]?.commit as Record<string, unknown>)?.author as Record<string, string>)?.date;
    const first = ((commits[commits.length - 1]?.commit as Record<string, unknown>)?.author as Record<string, string>)?.date;
    if (last && first) commitDays = Math.max(1, Math.floor((new Date(last).getTime() - new Date(first).getTime()) / 86_400_000));
  }
  let rootFiles: string[] = [];
  if (contentsRes?.ok) {
    const items = await contentsRes.json() as Record<string, unknown>[];
    if (Array.isArray(items)) rootFiles = items.map(i => (i.name as string) ?? "").filter(Boolean);
  }

  return {
    fullName:   (d.full_name as string) ?? slug,
    description:(d.description as string) ?? "",
    stars:      (d.stargazers_count as number) ?? 0,
    forks:      (d.forks_count as number) ?? 0,
    openIssues: (d.open_issues_count as number) ?? 0,
    watchers:   (d.subscribers_count as number) ?? 0,
    daysSincePush,
    language:   (d.language as string) ?? "unknown",
    license:    (d.license as Record<string, string>)?.spdx_id ?? "none",
    archived:   (d.archived as boolean) ?? false,
    topics:     (d.topics as string[]) ?? [],
    commitCount, commitDays, rootFiles,
  };
}

const clamp10 = (n: number) => Math.max(0, Math.min(10, Math.round(n)));
function scoreRepo(r: RepoData) {
  // Activity: recency + commit velocity (real)
  const recency = r.daysSincePush === null ? 3
    : r.daysSincePush <= 7 ? 10 : r.daysSincePush <= 30 ? 8 : r.daysSincePush <= 90 ? 5 : r.daysSincePush <= 180 ? 3 : 1;
  const velocity = r.commitDays ? Math.min(10, (r.commitCount / r.commitDays) * 7) : Math.min(10, r.commitCount / 3);
  const activity = r.archived ? 0 : clamp10(recency * 0.6 + velocity * 0.4);

  // Community: stars + forks + watchers (log-scaled, real)
  const community = clamp10(Math.log10(r.stars + 1) * 3 + Math.log10(r.forks + 1) * 2 + Math.log10(r.watchers + 1));

  // Documentation: README / docs presence (real file listing)
  const lf = r.rootFiles.map(f => f.toLowerCase());
  const hasReadme = lf.some(f => f.startsWith("readme"));
  const hasDocs   = lf.some(f => f === "docs" || f === "documentation");
  const hasLicense = r.license !== "none";
  const documentation = clamp10((hasReadme ? 5 : 0) + (hasDocs ? 3 : 0) + (hasLicense ? 2 : 0) + (r.description ? 1 : 0));

  // Security/hygiene: tests, CI, env example, lockfiles (real file listing)
  const hasTests = lf.some(f => /^tests?$|\.test\.|spec/.test(f) || f === "__tests__");
  const hasCI    = lf.includes(".github");
  const hasEnvEx = lf.some(f => f.includes(".env.example") || f === ".env.sample");
  const hasGitignore = lf.includes(".gitignore");
  const security = clamp10((hasTests ? 4 : 0) + (hasCI ? 3 : 0) + (hasEnvEx ? 1.5 : 0) + (hasGitignore ? 1.5 : 0));

  // Code quality proxy: issue ratio + has tests/CI (real)
  const issuePenalty = r.stars > 0 ? Math.min(4, (r.openIssues / Math.max(1, r.stars)) * 4) : 0;
  const codeQuality = clamp10(5 + (hasTests ? 2 : 0) + (hasCI ? 1 : 0) - issuePenalty + (r.license !== "none" ? 1 : 0));

  const health = Math.round(activity * 2.5 + codeQuality * 2 + documentation * 2 + security * 2 + community * 1.5);
  const grade = health >= 85 ? "A" : health >= 70 ? "B" : health >= 55 ? "C" : health >= 40 ? "D" : "F";
  const status = r.archived ? "stalled"
    : health >= 70 ? "healthy" : health >= 50 ? "needs_attention" : health >= 35 ? "at_risk" : "stalled";

  return {
    health_score: health, grade, status,
    dimensions: { activity, code_quality: codeQuality, documentation, security, community },
    signals: { hasReadme, hasDocs, hasTests, hasCI, hasEnvEx, hasLicense, archived: r.archived },
  };
}

export default async function handler(req: Request): Promise<Response> {
  try {
    let body: { repo?: string; description?: string } = {};
    try { const t = await req.text(); if (t.trim().startsWith("{")) body = JSON.parse(t); } catch {}
    const url = new URL(req.url);
    const repoInput = body.repo ?? url.searchParams.get("repo") ?? "";
    if (!repoInput) return Response.json({ error: "repo is required (e.g. 'user/repo' or a GitHub URL)" }, { status: 400 });

    const slug = slugify(repoInput);
    const data = await fetchRepo(slug);
    if (!data) {
      return Response.json({
        error: "Could not fetch this repo from GitHub",
        message: `'${slug}' was not found or GitHub rate-limited the request. Check the owner/repo and try again.`,
        repo: slug,
      }, { status: 404 });
    }

    const scored = scoreRepo(data);

    // LLM writes ONLY the qualitative narrative, grounded in the real metrics.
    const facts = [
      `Repo: ${data.fullName}`,
      `Description: ${data.description || "none"}`,
      `Language: ${data.language} | License: ${data.license}${data.archived ? " | ARCHIVED" : ""}`,
      `Stars: ${data.stars} | Forks: ${data.forks} | Watchers: ${data.watchers} | Open issues: ${data.openIssues}`,
      `Last push: ${data.daysSincePush === null ? "unknown" : `${data.daysSincePush} days ago`} | Recent commits: ${data.commitCount}${data.commitDays ? ` over ${data.commitDays} days` : ""}`,
      `Root files: ${data.rootFiles.slice(0, 40).join(", ") || "none"}`,
      `Computed scores (0-10): activity ${scored.dimensions.activity}, code_quality ${scored.dimensions.code_quality}, documentation ${scored.dimensions.documentation}, security ${scored.dimensions.security}, community ${scored.dimensions.community}`,
    ].join("\n");

    let summary = "", critical: string[] = [], wins: string[] = [];
    try {
      const raw = await llm(
        `You are Blue Agent's repo-health analyst. You are GIVEN real GitHub metrics + computed scores — do NOT invent numbers. Write a grounded assessment ONLY from the facts. Return ONLY raw JSON: {"summary":"<2 sentences>","critical_issues":["<issue grounded in the data>"],"quick_wins":["<concrete fix>"]}`,
        facts, 0.3, 600,
      );
      const j = parseJson(raw) ?? {};
      summary  = (j.summary as string) ?? "";
      critical = Array.isArray(j.critical_issues) ? j.critical_issues as string[] : [];
      wins     = Array.isArray(j.quick_wins) ? j.quick_wins as string[] : [];
    } catch { /* metrics still returned even if narrative fails */ }

    return Response.json({
      tool: "repo-health",
      timestamp: new Date().toISOString(),
      repo: data.fullName,
      source: "github-api",
      metrics: {
        stars: data.stars, forks: data.forks, watchers: data.watchers, open_issues: data.openIssues,
        days_since_push: data.daysSincePush, recent_commits: data.commitCount,
        language: data.language, license: data.license, archived: data.archived, topics: data.topics,
      },
      ...scored,
      critical_issues: critical,
      quick_wins: wins,
      summary,
    });
  } catch (e) {
    return Response.json({ error: "Repo health check failed", message: (e as Error).message }, { status: 500 });
  }
}
