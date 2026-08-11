"use client";

/**
 * RegistryProfileView — a single agent's graded profile (health score, verdict,
 * strengths, skills, collab, issues, re-audit).
 *
 * Reused by two routes so it resolves on BOTH hosts:
 *   • /hub/registry/[handle]      (public host)      → <RegistryProfileView />
 *   • /app/hub/registry/[handle]  (app.blueagent.dev) → <RegistryProfileView inShell />
 * The handle is read from the URL via useParams (works under either route file).
 * `inShell` only swaps the outer chrome (drops <Navbar/> + navbar height offsets)
 * so the content fills the AppShell instead of clipping. All logic is shared.
 */

import { useState, useEffect } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import Navbar from "@/components/Navbar";
import type { AgentProfile } from "@/app/api/agent-registry/submit/route";

// ─── Design tokens ────────────────────────────────────────────────────────────

const GRADE_COLORS: Record<string, string> = {
  A: "text-[#34D399] border-[#34D399]/30 bg-[#34D399]/5",
  B: "text-[#4FC3F7] border-[#4FC3F7]/30 bg-[#4FC3F7]/5",
  C: "text-[#A78BFA] border-[#A78BFA]/30 bg-[#A78BFA]/5",
  D: "text-yellow-400 border-yellow-400/30 bg-yellow-400/5",
  F: "text-red-400 border-red-400/30 bg-red-400/5",
};

const TYPE_COLORS: Record<string, string> = {
  trading: "text-yellow-400 border-yellow-400/20",
  builder: "text-[#4FC3F7] border-[#4FC3F7]/20",
  content: "text-[#A78BFA] border-[#A78BFA]/20",
  defi:    "text-[#34D399] border-[#34D399]/20",
  infra:   "text-cyan-400 border-cyan-400/20",
  general: "text-slate-400 border-slate-700",
};

const VERDICT_COLORS: Record<string, string> = {
  HEALTHY:    "text-[#34D399] border-[#34D399]/20 bg-[#34D399]/5",
  NEEDS_WORK: "text-yellow-400 border-yellow-400/20 bg-yellow-400/5",
  AT_RISK:    "text-orange-400 border-orange-400/20 bg-orange-400/5",
  INACTIVE:   "text-red-400 border-red-400/20 bg-red-400/5",
};

function ScoreBar({ score }: { score: number }) {
  const color =
    score >= 80 ? "bg-[#34D399]" :
    score >= 60 ? "bg-[#4FC3F7]" :
    score >= 40 ? "bg-[#A78BFA]" : "bg-red-500";
  return (
    <div className="flex items-center gap-3">
      <div className="flex-1 h-1 bg-[#1A1A2E] rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full`} style={{ width: `${score}%` }} />
      </div>
      <span className="font-mono text-sm font-bold text-white w-8 text-right">{score}</span>
    </div>
  );
}

// ─── View ─────────────────────────────────────────────────────────────────────

export default function RegistryProfileView({ inShell = false }: { inShell?: boolean }) {
  const params  = useParams<{ handle: string }>();
  const handle  = params?.handle ?? "";

  const [profile, setProfile]     = useState<AgentProfile | null>(null);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState("");
  const [reauditing, setReauditing] = useState(false);

  useEffect(() => {
    if (!handle) return;
    fetch(`/api/agent-registry/${handle}`)
      .then(r => r.json())
      .then((d: AgentProfile & { error?: string }) => {
        if (d.error) setError(d.error);
        else setProfile(d);
      })
      .catch(() => setError("Failed to load profile"))
      .finally(() => setLoading(false));
  }, [handle]);

  async function handleReaudit() {
    if (!profile) return;
    setReauditing(true);
    try {
      const res = await fetch("/api/agent-registry/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repo: profile.fullName,
          name: profile.name,
          website: profile.website,
          twitter: profile.twitter,
        }),
      });
      const data = await res.json() as AgentProfile;
      setProfile(data);
    } catch { /* silent */ }
    finally { setReauditing(false); }
  }

  if (loading) {
    return (
      <>
        {!inShell && <Navbar />}
        <div className={`flex bg-[#050508] font-mono items-center justify-center ${inShell ? "h-full" : "pt-14 h-screen"}`}>
          <p className="font-mono text-xs text-slate-700 animate-pulse">loading agent profile…</p>
        </div>
      </>
    );
  }

  if (error || !profile) {
    return (
      <>
        {!inShell && <Navbar />}
        <div className={`flex bg-[#050508] font-mono items-center justify-center ${inShell ? "h-full" : "pt-14 h-screen"}`}>
          <div className="text-center">
            <p className="font-mono text-xs text-red-400 mb-4">{error || "agent not found"}</p>
            <Link href="/hub/registry" className="font-mono text-[10px] text-[#4FC3F7] hover:underline">← back to registry</Link>
          </div>
        </div>
      </>
    );
  }

  const gradeColor  = GRADE_COLORS[profile.grade]    ?? GRADE_COLORS.F;
  const typeColor   = TYPE_COLORS[profile.agent_type] ?? TYPE_COLORS.general;
  const verdictColor = VERDICT_COLORS[profile.verdict] ?? VERDICT_COLORS.INACTIVE;
  const auditAgeH   = Math.floor((Date.now() - new Date(profile.auditedAt).getTime()) / 3_600_000);

  return (
    <>
      {!inShell && <Navbar />}
      <div className={`flex bg-[#050508] font-mono ${inShell ? "h-full" : "pt-14"}`}>
        <div className={`flex-1 overflow-y-auto px-6 py-8 max-w-4xl ${inShell ? "h-full" : "h-[calc(100vh-3.5rem)]"}`}>

          {/* ── Breadcrumb ── */}
          <div className="flex items-center gap-2 mb-6 font-mono text-[10px] text-slate-700 tracking-widest">
            <Link href="/hub" className="hover:text-slate-500 transition-colors">HUB</Link>
            <span>/</span>
            <Link href="/hub/registry" className="hover:text-slate-500 transition-colors">REGISTRY</Link>
            <span>/</span>
            <span className="text-slate-500">{profile.name}</span>
          </div>

          {/* ── Hero ── */}
          <div className="flex items-start gap-5 mb-8 pb-8 border-b border-[#1A1A2E]">
            {/* Grade */}
            <div className={`font-mono text-4xl font-black px-3 py-1 border-2 rounded-xl shrink-0 ${gradeColor}`}>
              {profile.grade}
            </div>

            <div className="flex-1 min-w-0">
              {/* Name + badges */}
              <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                <h1 className="font-mono text-2xl font-bold text-white">{profile.name}</h1>
                {profile.verified && (
                  <span className="font-mono text-[9px] px-1.5 py-0.5 border border-[#34D399]/30 text-[#34D399] rounded">✓ verified</span>
                )}
                {profile.featured && (
                  <span className="font-mono text-[9px] px-1.5 py-0.5 border border-[#A78BFA]/30 text-[#A78BFA] rounded">★ featured</span>
                )}
                <span className={`font-mono text-[9px] px-1.5 py-0.5 border rounded uppercase tracking-widest ${typeColor}`}>
                  {profile.agent_type}
                </span>
              </div>

              {/* Description */}
              <p className="font-mono text-xs text-slate-500 mb-3 leading-relaxed">{profile.description}</p>

              {/* Links */}
              <div className="flex items-center gap-4 flex-wrap">
                <a href={profile.github} target="_blank" rel="noopener noreferrer"
                  className="flex items-center gap-1.5 font-mono text-[10px] text-slate-500 hover:text-[#4FC3F7] transition-colors">
                  <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/>
                  </svg>
                  {profile.fullName}
                </a>
                {profile.twitter && (
                  <a href={`https://x.com/${profile.twitter.replace("@","")}`} target="_blank" rel="noopener noreferrer"
                    className="font-mono text-[10px] text-slate-500 hover:text-[#4FC3F7] transition-colors">
                    {profile.twitter}
                  </a>
                )}
                {profile.website && (
                  <a href={profile.website} target="_blank" rel="noopener noreferrer"
                    className="font-mono text-[10px] text-slate-500 hover:text-[#4FC3F7] transition-colors">
                    {profile.website.replace(/^https?:\/\//, "")}
                  </a>
                )}
                {profile.stars > 0 && <span className="font-mono text-[10px] text-slate-700">★ {profile.stars}</span>}
                <span className="font-mono text-[10px] text-slate-700">{profile.language}</span>
              </div>
            </div>

            {/* Re-audit */}
            <button onClick={handleReaudit} disabled={reauditing}
              className="shrink-0 px-3 py-1.5 border border-[#1A1A2E] hover:border-[#4FC3F7]/20 font-mono text-[10px] text-slate-600 hover:text-[#4FC3F7] rounded-lg transition-all disabled:opacity-40">
              {reauditing ? "auditing…" : "↻ re-audit"}
            </button>
          </div>

          {/* ── Score + verdict ── */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
            <div className="bg-[#0D0D1A] border border-[#1A1A2E] rounded-xl p-4">
              <p className="font-mono text-[10px] text-slate-600 tracking-widest mb-3">// HEALTH SCORE</p>
              <ScoreBar score={profile.health_score} />
            </div>
            <div className="bg-[#0D0D1A] border border-[#1A1A2E] rounded-xl p-4">
              <p className="font-mono text-[10px] text-slate-600 tracking-widest mb-3">// VERDICT</p>
              <span className={`font-mono text-xs px-2 py-1 border rounded uppercase tracking-widest ${verdictColor}`}>
                {profile.verdict.replace("_", " ")}
              </span>
            </div>
          </div>

          {/* ── Detail grid ── */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">

            {/* Strengths */}
            {profile.strengths.length > 0 && (
              <div className="bg-[#0D0D1A] border border-[#1A1A2E] rounded-xl p-4">
                <p className="font-mono text-[10px] text-slate-600 tracking-widest mb-3">// STRENGTHS</p>
                <ul className="space-y-2">
                  {profile.strengths.map((s, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <span className="font-mono text-[10px] text-[#34D399] mt-0.5 shrink-0">✓</span>
                      <span className="font-mono text-xs text-slate-400 leading-relaxed">{s}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Skills */}
            {profile.skills.length > 0 && (
              <div className="bg-[#0D0D1A] border border-[#1A1A2E] rounded-xl p-4">
                <p className="font-mono text-[10px] text-slate-600 tracking-widest mb-3">// SKILLS</p>
                <div className="flex flex-wrap gap-1.5">
                  {profile.skills.map(s => (
                    <span key={s} className="font-mono text-[9px] px-2 py-1 bg-[#050508] border border-[#1A1A2E] text-slate-400 rounded">
                      {s}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Collab */}
            {profile.collab_opportunities.length > 0 && (
              <div className="bg-[#0D0D1A] border border-[#1A1A2E] rounded-xl p-4">
                <p className="font-mono text-[10px] text-slate-600 tracking-widest mb-3">// COLLAB OPPORTUNITIES</p>
                <ul className="space-y-2">
                  {profile.collab_opportunities.map((c, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <span className="font-mono text-[10px] text-[#4FC3F7] mt-0.5 shrink-0">↔</span>
                      <span className="font-mono text-xs text-slate-400 leading-relaxed">{c}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Issues */}
            {profile.issues && profile.issues.length > 0 && (
              <div className="bg-[#0D0D1A] border border-[#1A1A2E] rounded-xl p-4">
                <p className="font-mono text-[10px] text-slate-600 tracking-widest mb-3">// ISSUES</p>
                <ul className="space-y-2">
                  {profile.issues.map((issue, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <span className={`font-mono text-[10px] mt-0.5 shrink-0 ${
                        issue.severity === "warning" ? "text-yellow-400" : "text-slate-600"
                      }`}>
                        {issue.severity === "warning" ? "⚠" : "·"}
                      </span>
                      <span className="font-mono text-xs text-slate-400 leading-relaxed">{issue.issue}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* ── Recommendation ── */}
          {profile.recommendation && (
            <div className="bg-[#4FC3F7]/5 border border-[#4FC3F7]/10 rounded-xl p-4 mb-4">
              <p className="font-mono text-[10px] text-[#4FC3F7] tracking-widest mb-2">// BLUE AGENT RECOMMENDATION</p>
              <p className="font-mono text-xs text-slate-300 leading-relaxed">{profile.recommendation}</p>
            </div>
          )}

          {/* ── Footer meta ── */}
          <div className="flex items-center justify-between font-mono text-[10px] text-slate-700 mt-8 pt-4 border-t border-[#1A1A2E]">
            <span>submitted {new Date(profile.submittedAt).toLocaleDateString()}</span>
            <span>audited {auditAgeH < 1 ? "just now" : `${auditAgeH}h ago`} · Blue + Aeon + MiroShark</span>
          </div>

          <div className="mt-4">
            <Link href="/hub/registry" className="font-mono text-[10px] text-slate-700 hover:text-slate-500 transition-colors">
              ← back to registry
            </Link>
          </div>

        </div>
      </div>
    </>
  );
}
