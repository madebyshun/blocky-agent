"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import Navbar from "@/components/Navbar";

type Dimension = { name: string; score: number; max: number };

// Shape returned by /api/builder-score (the x402 builder-score handler).
type BuilderScoreResult = {
  handle: string | null;
  score: number | null;
  tier: string;
  blue_assessment?: string;
  base_ecosystem_score?: number | null;
  github?: { score: number } | null;
  onchain?: { tx_count: number | null } | null;
  community?: { score: number | null } | null;
};

const TIER_COLORS: Record<string, string> = {
  Explorer: "text-slate-400",
  Builder:  "text-blue-400",
  Maker:    "text-purple-400",
  Founder:  "text-[#4FC3F7]",
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
        <span className="font-mono text-[10px] text-slate-500 capitalize">{label}</span>
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

export default function BuilderProfilePage() {
  const params = useParams();
  const handle = (params?.handle as string) ?? "";
  const [data, setData] = useState<BuilderScoreResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!handle) return;
    setLoading(true);
    setError(null);
    fetch(`/api/builder-score?handle=${encodeURIComponent(handle)}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => setData(d))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [handle]);

  const summary = data?.blue_assessment ?? "";
  const shareText = data
    ? `My Blue Agent Builder Score: ${data.score ?? "—"}/100 (${data.tier})${summary ? ` — ${summary}` : ""}\n\nCheck yours: blueagent.dev/builder/${handle}`
    : "";

  // Real sub-scores the handler actually produces (0-100); only show the ones present.
  const dimensions: Dimension[] = data
    ? ([
        data.github          ? { name: "github",         score: data.github.score,          max: 100 } : null,
        data.community       ? { name: "community",      score: data.community.score ?? 0,  max: 100 } : null,
        data.base_ecosystem_score != null ? { name: "base ecosystem", score: data.base_ecosystem_score, max: 100 } : null,
      ].filter(Boolean) as Dimension[])
    : [];

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
              <p className="font-mono text-xs text-slate-600">Scoring @{handle}…</p>
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
              <div className="card-surface rounded-lg p-6 flex flex-col sm:flex-row items-start sm:items-center gap-4">
                {/* Avatar placeholder */}
                <div className="w-14 h-14 rounded-full bg-[#1A1A2E] border border-[#1A1A2E] flex items-center justify-center shrink-0">
                  <span className="font-mono text-xl text-[#4FC3F7]">
                    {handle.charAt(0).toUpperCase()}
                  </span>
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-mono text-white font-semibold">@{data.handle ?? handle}</span>
                    <span className={`font-mono text-xs ${TIER_COLORS[data.tier] ?? "text-white"}`}>
                      {data.tier}
                    </span>
                  </div>
                  <p className="font-mono text-[10px] text-slate-500">{summary}</p>
                </div>
                <div className="text-right shrink-0">
                  <span className="font-mono text-4xl font-bold text-white">{data.score}</span>
                  <span className="font-mono text-sm text-slate-700">/100</span>
                  <p className="font-mono text-[10px] text-slate-600 mt-1">Builder Score</p>
                </div>
              </div>

              {/* Dimension bars */}
              <div className="card-surface rounded-lg p-6 space-y-4">
                <p className="font-mono text-[10px] text-slate-700 tracking-widest mb-2">SCORE BREAKDOWN</p>
                {dimensions.map((d) => (
                  <ScoreBar key={d.name} label={d.name} score={d.score} max={d.max} />
                ))}
              </div>

              {/* Badge URL */}
              <div className="card-surface rounded-lg p-4">
                <p className="font-mono text-[10px] text-slate-700 mb-1">Badge URL</p>
                <p className="font-mono text-[10px] text-[#4FC3F7] break-all">
                  blueagent.dev/badge/builder/{handle}
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
                <button
                  className="font-mono text-xs text-slate-700 border border-[#1A1A2E] px-4 py-2 rounded cursor-not-allowed"
                  title="Coming soon"
                >
                  Download Score Card <span className="text-[10px] text-[#4FC3F7] border border-[#4FC3F7]/30 px-1 rounded ml-1">soon</span>
                </button>
                <button
                  className="font-mono text-xs text-slate-700 border border-[#1A1A2E] px-4 py-2 rounded cursor-not-allowed"
                  title="Coming soon"
                >
                  Claim Profile <span className="text-[10px] text-[#4FC3F7] border border-[#4FC3F7]/30 px-1 rounded ml-1">soon</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </main>
    </>
  );
}
