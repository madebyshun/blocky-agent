"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import Navbar from "@/components/Navbar";

type AgentScoreResult = {
  handle: string;
  xp: number;
  tier: string;
  badge: string;
  status: "online" | "offline" | "unknown";
  dimensions: {
    skillDepth: number;
    onchainActivity: number;
    reliability: number;
    interoperability: number;
    reputation: number;
  };
  strengths: string[];
  gaps: string[];
};

const TIER_COLORS: Record<string, string> = {
  Bot:       "text-slate-400",
  Specialist:"text-blue-400",
  Operator:  "text-purple-400",
  Sovereign: "text-[#4FC3F7]",
};

const GRID_BG = {
  backgroundImage:
    "linear-gradient(rgba(79,195,247,0.03) 1px,transparent 1px),linear-gradient(90deg,rgba(79,195,247,0.03) 1px,transparent 1px)",
  backgroundSize: "40px 40px",
};

function ScoreBar({ label, score, max }: { label: string; score: number; max: number }) {
  const pct = Math.round((score / max) * 100);
  return (
    <div className="space-y-1">
      <div className="flex justify-between">
        <span className="font-mono text-[10px] text-slate-500 capitalize">{label.replace(/([A-Z])/g, " $1").trim()}</span>
        <span className="font-mono text-[10px] text-white">{score}<span className="text-slate-700">/{max}</span></span>
      </div>
      <div className="h-1.5 bg-[#1A1A2E] rounded-full overflow-hidden">
        <div
          className="h-full bg-[#4FC3F7] rounded-full transition-all duration-700"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function detectStack(handle: string): string[] {
  const h = handle.toLowerCase();
  const tags: string[] = [];
  if (h.includes("blue") || h.includes("agent")) tags.push("Base");
  if (h.includes("bankr")) tags.push("Bankr LLM");
  if (h.includes("langchain") || h.includes("lang")) tags.push("LangChain");
  if (h.includes("vercel") || h.includes("ai")) tags.push("Vercel AI");
  if (h.includes("kit")) tags.push("AgentKit");
  if (tags.length === 0) tags.push("Base", "Bankr LLM");
  return tags;
}

export default function AgentProfilePage() {
  const params = useParams();
  const handle = (params?.handle as string) ?? "";
  const [data, setData] = useState<AgentScoreResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!handle) return;
    setLoading(true);
    setError(null);
    fetch(`/api/agent-score?handle=${encodeURIComponent(handle)}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => setData(d))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [handle]);

  const stackTags = detectStack(handle);

  const dimensions = data
    ? [
        { name: "skillDepth",       score: data.dimensions.skillDepth,       max: 25 },
        { name: "onchainActivity",  score: data.dimensions.onchainActivity,  max: 25 },
        { name: "reliability",      score: data.dimensions.reliability,       max: 20 },
        { name: "interoperability", score: data.dimensions.interoperability,  max: 20 },
        { name: "reputation",       score: data.dimensions.reputation,        max: 10 },
      ]
    : [];

  const shareText = data
    ? `My Blue Agent Score: ${data.xp} XP (${data.tier}) — ${data.badge}\n\nCheck yours: blueagent.dev/agent/${handle}`
    : "";

  return (
    <>
      <Navbar />
      <main className="bg-[#050508] font-mono min-h-screen pt-14" style={GRID_BG}>
        <div className="max-w-2xl mx-auto px-6 py-16">
          {/* Back */}
          <a href="/hub/registry" className="font-mono text-[10px] text-slate-700 hover:text-white transition-colors mb-8 block">
            ← registry
          </a>

          {loading && (
            <div className="card-surface rounded-lg p-8 text-center">
              <div className="glow-dot mx-auto mb-4" />
              <p className="font-mono text-xs text-slate-600">Scoring agent {handle}…</p>
            </div>
          )}

          {error && (
            <div className="card-surface rounded-lg p-8 text-center border border-red-500/20">
              <p className="font-mono text-xs text-red-400 mb-2">Error loading score</p>
              <p className="font-mono text-[10px] text-slate-600">{error}</p>
            </div>
          )}

          {data && (
            <div className="space-y-4">
              {/* Profile header */}
              <div className="card-surface rounded-lg p-6">
                <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 mb-4">
                  <div className="w-14 h-14 rounded-full bg-[#1A1A2E] border border-[#1A1A2E] flex items-center justify-center shrink-0">
                    <span className="font-mono text-xl text-[#4FC3F7]">
                      {handle.charAt(0).toUpperCase()}
                    </span>
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <span className="font-mono text-white font-semibold">{data.handle}</span>
                      <span className={`font-mono text-xs ${TIER_COLORS[data.tier] ?? "text-white"}`}>
                        {data.badge} {data.tier}
                      </span>
                      <span className={`font-mono text-[10px] px-1.5 py-0.5 rounded ${
                        data.status === "online"
                          ? "text-green-400 bg-green-400/10"
                          : "text-slate-600 bg-[#1A1A2E]"
                      }`}>
                        ● {data.status.toUpperCase()}
                      </span>
                    </div>
                    {/* Stack tags */}
                    <div className="flex flex-wrap gap-1">
                      {stackTags.map((tag) => (
                        <span key={tag} className="font-mono text-[10px] text-slate-600 border border-[#1A1A2E] px-1.5 py-0.5 rounded">
                          {tag}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <span className="font-mono text-4xl font-bold text-white">{data.xp}</span>
                    <span className="font-mono text-sm text-slate-700"> XP</span>
                    <p className="font-mono text-[10px] text-slate-600 mt-1">Agent Score</p>
                  </div>
                </div>
              </div>

              {/* XP breakdown */}
              <div className="card-surface rounded-lg p-6 space-y-4">
                <p className="font-mono text-[10px] text-slate-700 tracking-widest mb-2">XP BREAKDOWN</p>
                {dimensions.map((d) => (
                  <ScoreBar key={d.name} label={d.name} score={d.score} max={d.max} />
                ))}
              </div>

              {/* Strengths + Gaps */}
              {(data.strengths.length > 0 || data.gaps.length > 0) && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="card-surface rounded-lg p-4">
                    <p className="font-mono text-[10px] text-slate-700 tracking-widest mb-3">STRENGTHS</p>
                    <div className="space-y-1">
                      {data.strengths.map((s) => (
                        <p key={s} className="font-mono text-[10px] text-green-400/70">+ {s}</p>
                      ))}
                    </div>
                  </div>
                  <div className="card-surface rounded-lg p-4">
                    <p className="font-mono text-[10px] text-slate-700 tracking-widest mb-3">GAPS</p>
                    <div className="space-y-1">
                      {data.gaps.map((g) => (
                        <p key={g} className="font-mono text-[10px] text-red-400/70">− {g}</p>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* Badge URL */}
              <div className="card-surface rounded-lg p-4">
                <p className="font-mono text-[10px] text-slate-700 mb-1">Badge URL</p>
                <p className="font-mono text-[10px] text-[#4FC3F7] break-all">
                  blueagent.dev/badge/agent/{handle}
                </p>
              </div>

              {/* Actions */}
              <div className="flex flex-wrap gap-3">
                <button
                  onClick={() => {
                    const url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}`;
                    window.open(url, "_blank");
                  }}
                  className="font-mono text-xs text-slate-400 border border-[#1A1A2E] px-4 py-2 rounded hover:border-[#4FC3F7]/30 hover:text-white transition-all"
                >
                  Share on X →
                </button>
                <a
                  href="/hub"
                  className="font-mono text-xs text-slate-400 border border-[#1A1A2E] px-4 py-2 rounded hover:border-[#4FC3F7]/30 hover:text-white transition-all"
                >
                  View Tasks →
                </a>
                <button
                  className="font-mono text-xs text-slate-700 border border-[#1A1A2E] px-4 py-2 rounded cursor-not-allowed"
                  title="Coming soon"
                >
                  Download Score Card <span className="text-[10px] text-[#4FC3F7] border border-[#4FC3F7]/30 px-1 rounded ml-1">soon</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </main>
    </>
  );
}
