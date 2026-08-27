import { NextRequest, NextResponse } from "next/server";
import { extractJsonObject, runAeonSkill, runMiroSharkSkill, runBlueSkill } from "@/app/api/_lib/llm";
import { fetchGitHubRepo, fetchGitHubCommits, fetchGitHubContents, formatRepoForLLM } from "@/app/api/_lib/realdata";
import { kvGet, kvSet, kvMutate } from "@/lib/kv";

// ─── Types ────────────────────────────────────────────────────────────────────

export type AgentProfile = {
  handle: string;
  owner: string;
  repo: string;
  fullName: string;
  name: string;
  description: string;
  submittedAt: string;
  auditedAt: string;
  github: string;
  website?: string;
  twitter?: string;
  // Audit
  health_score: number;
  grade: string;
  verdict: string;
  language: string;
  stars: number;
  agent_type: string;
  skills: string[];
  strengths: string[];
  collab_opportunities: string[];
  issues?: { severity: string; issue: string }[];
  recommendation: string;
  // Registry
  verified: boolean;
  featured: boolean;
};

// ─── KV helpers ───────────────────────────────────────────────────────────────

const KEY_INDEX   = "registry:index";
const KEY_AGENT   = (h: string) => `registry:agent:${h}`;

async function addToIndex(handle: string): Promise<void> {
  // `kvMutate` (task #150). The old code read the index through a swallowing
  // `kvGet` that turns a KV throw into `[]`, so the `includes` guard passed and
  // we wrote `[handle]` — replacing the registry index of every submitted agent
  // with a single entry. The profiles survive under `registry:agent:*` but
  // nothing lists them.
  const res = await kvMutate<string[]>(KEY_INDEX, [], (idx) =>
    idx.includes(handle) ? null : [...idx, handle],
  );
  if (res === "skipped") {
    console.error(`[agent-registry] ${handle} saved but NOT indexed — KV read failed; re-submit to index it`);
  }
}

// ─── Parse GitHub URL ─────────────────────────────────────────────────────────

function parseGitHubRepo(input: string): string | null {
  // Accept: "owner/repo", "https://github.com/owner/repo", "github.com/owner/repo"
  const clean = input.trim().replace(/\.git$/, "");
  const match = clean.match(/(?:github\.com\/)?([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)/);
  return match ? match[1] : null;
}

// ─── POST /api/agent-registry/submit ─────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as Record<string, unknown>;
    const repoInput = (body.repo as string) ?? "";
    const nameInput = (body.name as string) ?? "";
    const website   = (body.website as string) ?? "";
    const twitter   = (body.twitter as string) ?? "";
    const force     = (body.force as boolean) ?? false;

    if (!repoInput) {
      return NextResponse.json({ error: "repo is required" }, { status: 400 });
    }

    const fullName = parseGitHubRepo(repoInput);
    if (!fullName) {
      return NextResponse.json({ error: "Invalid GitHub repo format. Use owner/repo or full URL." }, { status: 400 });
    }

    const [owner, repo] = fullName.split("/");
    const handle = `${owner}-${repo}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");

    // Check if already submitted — return cached if recent (< 24h) and not forced
    const existing = await kvGet<AgentProfile>(KEY_AGENT(handle));
    if (existing && !force) {
      const age = Date.now() - new Date(existing.auditedAt).getTime();
      if (age < 24 * 60 * 60 * 1000) {
        return NextResponse.json({ cached: true, ...existing });
      }
    }

    // ── Fetch real GitHub data ──────────────────────────────────────────────
    const [ghRepo, commits, rootFiles] = await Promise.all([
      fetchGitHubRepo(fullName),
      fetchGitHubCommits(fullName),
      fetchGitHubContents(fullName),
    ]);

    if (!ghRepo) {
      return NextResponse.json(
        { error: "Could not fetch repo. Make sure it's public and the URL is correct." },
        { status: 404 }
      );
    }

    const [skillFiles, docsFiles, agentFiles] = await Promise.all([
      fetchGitHubContents(fullName, "skills"),
      fetchGitHubContents(fullName, "docs"),
      fetchGitHubContents(fullName, "agents"),
    ]);

    const skillSample  = skillFiles.slice(0, 10);
    const docsSample   = docsFiles.slice(0, 5);
    const agentSample  = agentFiles.slice(0, 5);

    const realData = [
      formatRepoForLLM(ghRepo, commits, rootFiles),
      skillFiles.length  ? `\nSkill files (${skillFiles.length} total): ${skillSample.join(", ")}${skillFiles.length > 10 ? ` +${skillFiles.length - 10} more` : ""}` : "\nNo skills/ directory",
      docsFiles.length   ? `\nDocs files (${docsFiles.length} total): ${docsSample.join(", ")}${docsFiles.length > 5 ? ` +${docsFiles.length - 5} more` : ""}` : "\nNo docs/ directory",
      agentFiles.length  ? `\nAgent files: ${agentSample.join(", ")}` : "\nNo agents/ directory",
      `\nKey files: ${["README.md","CLAUDE.md","package.json","agent.json","Dockerfile",".github"].filter(f => rootFiles.includes(f)).join(", ") || "none detected"}`,
    ].join("\n").slice(0, 2000);

    // ── 3-agent audit (parallel) ────────────────────────────────────────────
    const [aeonRaw, narrativeRaw] = await Promise.all([
      runAeonSkill("deep-research",
        `Evaluate this AI agent project on GitHub. Assess builder credibility, code quality, and agent utility:\n${realData}`
      ),
      runAeonSkill("narrative-tracker",
        `What category of AI agent is this, and how does it fit into the current agent ecosystem?\n${realData}`
      ),
    ]);

    const msRaw = await runMiroSharkSkill({
      scenario: `Agent registry audit: ${fullName}`,
      context: {
        repo_data: realData.slice(0, 600),
        aeon: aeonRaw ?? "",
        narrative: narrativeRaw ?? "",
      },
      persona: "analyst — evaluates agent quality, ecosystem fit, and collab potential",
      outputSchema: `{"agent_type":"trading|builder|content|defi|general|infra","skills":["<from repo>"],"collab_fit":"<who would want to collab>","trust":"high|medium|low","standout":"<what makes this agent unique>"}`,
      maxTokens: 400,
    });

    const msSignal = extractJsonObject(msRaw ?? "") ?? {};

    const verdictRaw = await runBlueSkill({
      task: `Audit this AI agent's GitHub repo for the Blue Hub Agent Registry.
Base ALL findings on the real data provided. Be honest and specific.
CRITICAL: Return ONLY raw JSON. No markdown.
Schema: {
  "name": "<agent name from repo>",
  "description": "<what this agent does, 1 sentence>",
  "health_score": <0-100>,
  "grade": "A|B|C|D|F",
  "verdict": "HEALTHY|NEEDS_WORK|AT_RISK|INACTIVE",
  "language": "<primary language>",
  "agent_type": "trading|builder|content|defi|general|infra",
  "skills": ["<actual skill from repo>"],
  "strengths": ["<specific strength from real data>"],
  "collab_opportunities": ["<specific agent or project type that would benefit from collab>"],
  "issues": [{"severity":"warning|info","issue":"<real issue>"}],
  "recommendation": "<specific next step for this agent>"
}`,
      skillFiles: ["base-ecosystem.md"],
      input: `${realData}\n\nAeon:\n${(aeonRaw ?? "").slice(0, 600)}\n\nNarrative:\n${(narrativeRaw ?? "").slice(0, 400)}\n\nMiroShark:\n${JSON.stringify(msSignal).slice(0, 400)}`,
      maxTokens: 900,
    });

    const verdict = extractJsonObject(verdictRaw ?? "");
    if (!verdict) throw new Error("Failed to parse audit verdict");

    const v = verdict as Record<string, unknown>;

    // ── Build profile ───────────────────────────────────────────────────────
    const profile: AgentProfile = {
      handle,
      owner,
      repo,
      fullName,
      name: nameInput || (v.name as string) || repo,
      description: (v.description as string) || ghRepo.description || "",
      submittedAt: existing?.submittedAt ?? new Date().toISOString(),
      auditedAt: new Date().toISOString(),
      github: `https://github.com/${fullName}`,
      website: website || undefined,
      twitter: twitter || undefined,
      health_score: (v.health_score as number) ?? 50,
      grade: (v.grade as string) ?? "C",
      verdict: (v.verdict as string) ?? "NEEDS_WORK",
      language: (v.language as string) || ghRepo.language || "Unknown",
      stars: ghRepo.stars ?? 0,
      agent_type: (v.agent_type as string) ?? "general",
      skills: (v.skills as string[]) ?? [],
      strengths: (v.strengths as string[]) ?? [],
      collab_opportunities: (v.collab_opportunities as string[]) ?? [],
      issues: (v.issues as { severity: string; issue: string }[]) ?? [],
      recommendation: (v.recommendation as string) ?? "",
      verified: false,
      featured: false,
    };

    // ── Save to KV ──────────────────────────────────────────────────────────
    await Promise.all([
      kvSet(KEY_AGENT(handle), profile),
      addToIndex(handle),
    ]);

    return NextResponse.json({ cached: false, ...profile });
  } catch (err) {
    console.error("[agent-registry/submit]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Audit failed" },
      { status: 500 }
    );
  }
}
