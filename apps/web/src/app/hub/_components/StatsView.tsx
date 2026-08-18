"use client";

/**
 * StatsView — Blue Hub analytics (KPIs, category/agent breakdown, registry
 * status, tool leaderboard). Live data from /api/stats.
 *
 * Reused by two routes so it resolves on BOTH hosts:
 *   • /hub/stats          (public host)      → <StatsView />
 *   • /app/hub/stats      (app.blueagent.dev) → <StatsView inShell />
 * The app subdomain rewrites /hub/* → /app/hub/*, so the app-subtree wrapper is
 * required or /hub/stats gets swallowed by /app/hub/[tool] there. `inShell`
 * drops the marketing <Navbar/> and swaps the min-h-screen wrapper for
 * h-full overflow-y-auto so the content scrolls inside the AppShell instead of
 * clipping. Both routes are noindex (set on their page/layout metadata).
 */

import { useState, useEffect, useMemo, useRef } from "react";
import Link from "next/link";
import Navbar from "@/components/Navbar";
import { AGENT_TOOLS } from "@/lib/agent-tools";

// ─── Types ────────────────────────────────────────────────────────────────────

type Row = {
  id: string;
  name: string;
  category: string;
  price: string;
  runs: number;
  revenueEst: number;
};

type Stats = {
  totals: {
    tools: number;
    totalRuns: number;
    totalRevenueEst: number;
    usdcBalance: number | null;
    wallet: string;
  };
  rows: Row[];
};

// ─── Design tokens ────────────────────────────────────────────────────────────

const CAT_META: Record<string, { label: string; color: string; bg: string }> = {
  intelligence:     { label: "Intelligence",   color: "#4FC3F7", bg: "rgba(79,195,247,0.12)"  },
  builder:          { label: "Builder",        color: "#A78BFA", bg: "rgba(167,139,250,0.12)" },
  trading:          { label: "Trading",        color: "#34D399", bg: "rgba(52,211,153,0.12)"  },
  security:         { label: "Security",       color: "#F87171", bg: "rgba(248,113,113,0.12)" },
  "agent-economy":  { label: "Agent Economy",  color: "#FACC15", bg: "rgba(250,204,21,0.12)"  },
  "base-ecosystem": { label: "Base Ecosystem", color: "#60A5FA", bg: "rgba(96,165,250,0.12)"  },
  "on-chain":       { label: "On-chain",       color: "#FB923C", bg: "rgba(251,146,60,0.12)"  },
  content:          { label: "Content",        color: "#E879F9", bg: "rgba(232,121,249,0.12)" },
  investor:         { label: "Investor",       color: "#FACC15", bg: "rgba(250,204,21,0.12)"  },
};

function catMeta(cat: string) {
  return CAT_META[cat] ?? { label: cat, color: "#6B6B7E", bg: "rgba(107,107,126,0.1)" };
}

const AGENT_META: Record<string, { label: string; color: string }> = {
  "Blue + Aeon":      { label: "Blue + Aeon",     color: "#4FC3F7" },
  "Blue":             { label: "Blue",             color: "#4FC3F7" },
  "Blue + MiroShark": { label: "Blue + MiroShark", color: "#34D399" },
};

const AGENT_MAP = Object.fromEntries(AGENT_TOOLS.map(t => [t.id, t.agentName]));

// ─── Hooks ────────────────────────────────────────────────────────────────────

/** Animates a number from 0 → target over `duration` ms */
function useCountUp(target: number, duration = 900, active = false): number {
  const [display, setDisplay] = useState(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!active || target === 0) { setDisplay(target); return; }
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min((now - start) / duration, 1);
      // ease-out cubic
      const ease = 1 - Math.pow(1 - p, 3);
      setDisplay(Math.round(ease * target));
      if (p < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [target, duration, active]);

  return display;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function KpiCard({
  label,
  value,
  sub,
  accent,
  delay = 0,
  visible = false,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: string;
  delay?: number;
  visible?: boolean;
}) {
  return (
    <div
      className="rounded-xl border bg-[#0A0A12] p-5 flex flex-col gap-1 relative overflow-hidden transition-all duration-700"
      style={{
        borderColor: accent ? `${accent}30` : "#1A1A2E",
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0)" : "translateY(12px)",
        transitionDelay: `${delay}ms`,
      }}
    >
      {/* Corner glow */}
      {accent && (
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background: `radial-gradient(circle at 0% 110%, ${accent}18, transparent 65%)`,
          }}
        />
      )}
      {/* Scan line on hover */}
      <div
        className="absolute inset-0 pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-300"
        style={{
          background: `linear-gradient(180deg, transparent 0%, ${accent ?? "#4FC3F7"}08 50%, transparent 100%)`,
        }}
      />
      <p className="font-mono text-[10px] uppercase tracking-widest text-slate-600 relative z-10">{label}</p>
      <p className="font-mono text-2xl font-bold relative z-10" style={{ color: accent ?? "#fff" }}>
        {value}
      </p>
      {sub && <p className="font-mono text-[10px] text-slate-700 relative z-10">{sub}</p>}
    </div>
  );
}

function CategoryBar({
  cat,
  runs,
  revenue,
  maxRuns,
  delay = 0,
  animated = false,
}: {
  cat: string;
  runs: number;
  revenue: number;
  maxRuns: number;
  delay?: number;
  animated?: boolean;
}) {
  const m = catMeta(cat);
  const pct = maxRuns > 0 ? (runs / maxRuns) * 100 : 0;
  return (
    <div
      className="flex items-center gap-3 transition-all duration-500"
      style={{ opacity: animated ? 1 : 0, transitionDelay: `${delay}ms` }}
    >
      <div className="w-28 shrink-0">
        <span
          className="font-mono text-[10px] px-1.5 py-0.5 rounded"
          style={{ color: m.color, background: m.bg }}
        >
          {m.label}
        </span>
      </div>
      <div className="flex-1 h-1.5 bg-[#1A1A2E] rounded-full overflow-hidden">
        <div
          className="h-full rounded-full"
          style={{
            width: animated ? `${pct}%` : "0%",
            background: m.color,
            opacity: 0.7,
            transition: `width 800ms cubic-bezier(0.16,1,0.3,1) ${delay + 100}ms`,
          }}
        />
      </div>
      <span className="font-mono text-[11px] text-slate-400 tabular-nums w-14 text-right">
        {runs.toLocaleString()} runs
      </span>
      <span className="font-mono text-[10px] text-slate-600 tabular-nums w-14 text-right">
        ${revenue.toFixed(2)}
      </span>
    </div>
  );
}

// ─── Main view ────────────────────────────────────────────────────────────────

export default function StatsView({ inShell = false }: { inShell?: boolean }) {
  const [data, setData]       = useState<Stats | null>(null);
  const [err, setErr]         = useState<string | null>(null);
  const [ts, setTs]           = useState<string>("");
  const [phase, setPhase]     = useState(0); // 0=loading 1=kpis 2=mid 3=table

  useEffect(() => {
    fetch("/api/stats")
      .then(async r => {
        if (!r.ok) { setErr("Failed to load stats."); return; }
        const d = await r.json();
        setData(d);
        setTs(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
        // Staggered section reveals
        setTimeout(() => setPhase(1), 60);
        setTimeout(() => setPhase(2), 300);
        setTimeout(() => setPhase(3), 500);
      })
      .catch(() => setErr("Failed to load stats."));
  }, []);

  // ── derived ──
  const catStats = useMemo(() => {
    if (!data) return [];
    const map: Record<string, { runs: number; revenue: number; count: number }> = {};
    for (const r of data.rows) {
      const k = r.category || "other";
      if (!map[k]) map[k] = { runs: 0, revenue: 0, count: 0 };
      map[k].runs    += r.runs;
      map[k].revenue += r.revenueEst;
      map[k].count   += 1;
    }
    return Object.entries(map)
      .map(([cat, v]) => ({ cat, ...v }))
      .sort((a, b) => b.runs - a.runs || b.revenue - a.revenue);
  }, [data]);

  const agentStats = useMemo(() => {
    if (!data) return [];
    const map: Record<string, { runs: number; count: number }> = {};
    for (const r of data.rows) {
      const agent = AGENT_MAP[r.id] ?? "Blue";
      if (!map[agent]) map[agent] = { runs: 0, count: 0 };
      map[agent].runs  += r.runs;
      map[agent].count += 1;
    }
    return Object.entries(map)
      .map(([agent, v]) => ({ agent, ...v }))
      .sort((a, b) => b.count - a.count);
  }, [data]);

  const maxRuns    = data ? Math.max(1, ...data.rows.map(r => r.runs)) : 1;
  const maxCatRuns = catStats.length ? Math.max(1, ...catStats.map(c => c.runs)) : 1;

  // Count-up values
  const animTools   = useCountUp(data?.totals.tools ?? 0,       700, phase >= 1);
  const animRuns    = useCountUp(data?.totals.totalRuns ?? 0,   1000, phase >= 1);
  const animRevRaw  = useCountUp(
    Math.round((data?.totals.totalRevenueEst ?? 0) * 100),
    900, phase >= 1
  );
  const animRev     = (animRevRaw / 100).toFixed(2);

  return (
    <>
      {!inShell && <Navbar />}

      {/* global keyframes injected via style tag */}
      <style>{`
        @keyframes fadeSlideUp {
          from { opacity: 0; transform: translateY(16px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes shimmer {
          0%   { background-position: -200% center; }
          100% { background-position:  200% center; }
        }
        @keyframes scanPulse {
          0%, 100% { opacity: 0.3; }
          50%       { opacity: 0.7; }
        }
        .row-fade { animation: fadeSlideUp 0.4s ease-out forwards; opacity: 0; }
      `}</style>

      <div className={`relative bg-[#050508] font-mono text-slate-200 ${inShell ? "h-full overflow-y-auto" : "min-h-screen pt-14"}`}>
        {/* Grid background */}
        <div
          className="fixed inset-0 pointer-events-none"
          style={{
            backgroundImage:
              "linear-gradient(rgba(79,195,247,0.02) 1px,transparent 1px)," +
              "linear-gradient(90deg,rgba(79,195,247,0.02) 1px,transparent 1px)",
            backgroundSize: "40px 40px",
          }}
        />
        {/* Ambient top glow */}
        <div
          className="fixed top-0 left-1/2 -translate-x-1/2 w-[600px] h-[200px] pointer-events-none"
          style={{
            background: "radial-gradient(ellipse at 50% 0%, rgba(79,195,247,0.06), transparent 70%)",
          }}
        />

        <div className="relative max-w-5xl mx-auto px-6 py-8">

          {/* Breadcrumb */}
          <div
            className="flex items-center gap-2 mb-6 text-xs"
            style={{ animation: "fadeSlideUp 0.5s ease-out forwards" }}
          >
            <Link href="/hub" className="text-slate-500 hover:text-[#4FC3F7] transition-colors">Hub</Link>
            <span className="text-slate-700">/</span>
            <span className="text-slate-400">Analytics</span>
          </div>

          {/* Header */}
          <div
            className="flex items-start justify-between mb-8"
            style={{ animation: "fadeSlideUp 0.5s ease-out 80ms forwards", opacity: 0 }}
          >
            <div>
              <div className="flex items-center gap-3 mb-2">
                <span className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-[#34D399] animate-pulse"
                    style={{ boxShadow: "0 0 8px #34D399, 0 0 16px rgba(52,211,153,0.4)" }} />
                  <span className="font-mono text-[10px] text-[#34D399] uppercase tracking-widest">Live</span>
                </span>
                <span className="font-mono text-[10px] text-slate-700 px-2 py-0.5 rounded border border-[#1A1A2E]">
                  Base Mainnet · eip155:8453
                </span>
              </div>
              <h1 className="text-2xl font-bold text-white tracking-tight">Blue Hub Analytics</h1>
              <p className="font-mono text-[11px] text-slate-600 mt-1">
                Tool usage · revenue estimates · registry status · agent distribution
              </p>
            </div>
            {ts && (
              <div className="text-right shrink-0">
                <p className="font-mono text-[10px] text-slate-700">Updated</p>
                <p className="font-mono text-[11px] text-slate-500">{ts}</p>
              </div>
            )}
          </div>

          {/* Error */}
          {err && (
            <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-4 font-mono text-xs text-red-400 mb-6">
              {err}
            </div>
          )}

          {/* Loading skeleton */}
          {!err && !data && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
              {[...Array(3)].map((_, i) => (
                <div
                  key={i}
                  className="h-20 rounded-xl border border-[#1A1A2E] overflow-hidden relative"
                  style={{ background: "#0A0A12" }}
                >
                  <div
                    className="absolute inset-0"
                    style={{
                      background: "linear-gradient(90deg, transparent 0%, rgba(79,195,247,0.04) 50%, transparent 100%)",
                      backgroundSize: "200% 100%",
                      animation: "shimmer 1.8s infinite",
                    }}
                  />
                </div>
              ))}
            </div>
          )}

          {data && (
            <>
              {/* ── KPI row (3 cards) ─────────────────────────────────── */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
                <KpiCard
                  label="Tools live"
                  value={String(animTools)}
                  sub="on Blue Hub"
                  accent="#4FC3F7"
                  delay={0}
                  visible={phase >= 1}
                />
                <KpiCard
                  label="Total runs"
                  value={animRuns.toLocaleString()}
                  sub="all time"
                  delay={80}
                  visible={phase >= 1}
                />
                <KpiCard
                  label="Est. revenue"
                  value={`$${animRev}`}
                  sub="gross, before fees"
                  accent="#34D399"
                  delay={160}
                  visible={phase >= 1}
                />
              </div>

              {/* ── Mid: Category + Agent + Registry ─────────────────── */}
              <div
                className="grid grid-cols-1 lg:grid-cols-5 gap-4 mb-6 transition-all duration-500"
                style={{
                  opacity: phase >= 2 ? 1 : 0,
                  transform: phase >= 2 ? "translateY(0)" : "translateY(12px)",
                }}
              >
                {/* Category breakdown */}
                <div className="lg:col-span-3 rounded-xl border border-[#1A1A2E] bg-[#0A0A12] p-5">
                  <div className="flex items-center justify-between mb-4">
                    <p className="font-mono text-[10px] uppercase tracking-widest text-slate-500">
                      Category Breakdown
                    </p>
                    <span className="font-mono text-[10px] text-slate-700">by runs</span>
                  </div>
                  <div className="flex flex-col gap-3">
                    {catStats.map((c, i) => (
                      <CategoryBar
                        key={c.cat}
                        cat={c.cat}
                        runs={c.runs}
                        revenue={c.revenue}
                        maxRuns={maxCatRuns}
                        delay={i * 60}
                        animated={phase >= 2}
                      />
                    ))}
                  </div>
                </div>

                {/* Right column */}
                <div className="lg:col-span-2 flex flex-col gap-4">

                  {/* Agent distribution */}
                  <div className="rounded-xl border border-[#1A1A2E] bg-[#0A0A12] p-5 flex-1">
                    <p className="font-mono text-[10px] uppercase tracking-widest text-slate-500 mb-4">
                      Agent Distribution
                    </p>
                    <div className="flex flex-col gap-3">
                      {agentStats.map((a, i) => {
                        const m   = AGENT_META[a.agent] ?? { label: a.agent, color: "#4FC3F7" };
                        const tot = agentStats.reduce((s, x) => s + x.count, 0);
                        const pct = tot > 0 ? Math.round((a.count / tot) * 100) : 0;
                        return (
                          <div
                            key={a.agent}
                            className="transition-all duration-500"
                            style={{ opacity: phase >= 2 ? 1 : 0, transitionDelay: `${i * 80}ms` }}
                          >
                            <div className="flex items-center justify-between mb-1.5">
                              <div className="flex items-center gap-2">
                                <span
                                  className="w-2 h-2 rounded-full shrink-0"
                                  style={{ background: m.color, boxShadow: `0 0 6px ${m.color}` }}
                                />
                                <span className="font-mono text-[11px] text-slate-300">{m.label}</span>
                              </div>
                              <div className="flex items-center gap-2">
                                <span className="font-mono text-[10px] text-slate-600">
                                  {a.runs.toLocaleString()} runs
                                </span>
                                <span className="font-mono text-[11px] font-bold tabular-nums" style={{ color: m.color }}>
                                  {a.count}
                                </span>
                              </div>
                            </div>
                            {/* mini pct bar */}
                            <div className="h-0.5 bg-[#1A1A2E] rounded-full overflow-hidden">
                              <div
                                className="h-full rounded-full"
                                style={{
                                  width: phase >= 2 ? `${pct}%` : "0%",
                                  background: m.color,
                                  opacity: 0.5,
                                  transition: `width 700ms cubic-bezier(0.16,1,0.3,1) ${i * 80 + 100}ms`,
                                }}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Registry status */}
                  <div className="rounded-xl border border-[#1A1A2E] bg-[#0A0A12] p-5">
                    <p className="font-mono text-[10px] uppercase tracking-widest text-slate-500 mb-4">
                      Registry Status
                    </p>
                    <div className="flex flex-col gap-2.5">
                      {[
                        { label: "ERC-8257 ToolRegistry",  note: "64 tools · Base",          href: "https://basescan.org/address/0x265BB2DBFC0A8165C9A1941Eb1372F349baD2cf1" },
                        { label: "agentic.market",          note: "1 service endpoint",       href: "https://agentic.market/services/blueagent-dev" },
                        { label: "CDP Bazaar",              note: "merchant indexed",         href: "https://api.cdp.coinbase.com/platform/v2/x402/discovery/merchant?payTo=0x02950ad38ada1d599375bd447e080cd404809205" },
                        { label: "OpenAPI spec",            note: "/.well-known/openapi.json",href: "https://blueagent.dev/.well-known/openapi.json" },
                        { label: "ai-plugin.json",          note: "ChatGPT-compatible",       href: "https://blueagent.dev/.well-known/ai-plugin.json" },
                      ].map((r, i) => (
                        <a
                          key={r.label}
                          href={r.href}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center justify-between group transition-all duration-400"
                          style={{
                            opacity: phase >= 2 ? 1 : 0,
                            transform: phase >= 2 ? "translateX(0)" : "translateX(-8px)",
                            transition: `all 400ms ease ${i * 60 + 200}ms`,
                          }}
                        >
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] text-[#34D399]">✓</span>
                            <span className="font-mono text-[11px] text-slate-300 group-hover:text-[#4FC3F7] transition-colors">
                              {r.label}
                            </span>
                          </div>
                          <span className="font-mono text-[9px] text-slate-700">{r.note}</span>
                        </a>
                      ))}
                    </div>
                  </div>

                </div>
              </div>

              {/* ── Tool Leaderboard ───────────────────────────────────── */}
              <div
                className="rounded-xl border border-[#1A1A2E] bg-[#0A0A12] overflow-hidden transition-all duration-600"
                style={{
                  opacity: phase >= 3 ? 1 : 0,
                  transform: phase >= 3 ? "translateY(0)" : "translateY(16px)",
                }}
              >
                <div className="flex items-center justify-between px-5 py-3 border-b border-[#1A1A2E]">
                  <p className="font-mono text-[10px] uppercase tracking-widest text-slate-500">
                    Tool Leaderboard
                  </p>
                  <span className="font-mono text-[10px] text-slate-700">
                    {data.rows.length} tools · sorted by runs
                  </span>
                </div>

                {/* Column headers */}
                <div
                  className="grid items-center px-5 py-2 border-b border-[#1A1A2E]/60 font-mono text-[9px] uppercase tracking-wider text-slate-700"
                  style={{ gridTemplateColumns: "2rem 1fr 6.5rem 5.5rem 5rem 4rem 4.5rem" }}
                >
                  <span>#</span>
                  <span>Tool</span>
                  <span>Category</span>
                  <span>Agent</span>
                  <span className="text-right">Price</span>
                  <span className="text-right">Runs</span>
                  <span className="text-right">Est. rev</span>
                </div>

                {/* Rows with staggered fade */}
                {data.rows.map((r, i) => {
                  const cat    = catMeta(r.category);
                  const agent  = AGENT_MAP[r.id] ?? "Blue";
                  const agentM = AGENT_META[agent] ?? { label: agent, color: "#4FC3F7" };
                  const barPct = maxRuns > 0 ? (r.runs / maxRuns) * 100 : 0;

                  return (
                    <div
                      key={r.id}
                      className="row-fade grid items-center px-5 py-2.5 border-b border-[#1A1A2E]/40 hover:bg-[#4FC3F7]/[0.025] transition-colors group"
                      style={{
                        gridTemplateColumns: "2rem 1fr 6.5rem 5.5rem 5rem 4rem 4.5rem",
                        animationDelay: `${i * 28}ms`,
                        animationFillMode: "forwards",
                      }}
                    >
                      {/* Rank */}
                      <span className="font-mono text-[10px] text-slate-700 tabular-nums">{i + 1}</span>

                      {/* Tool name + bar */}
                      <div className="min-w-0 pr-3">
                        <Link
                          href={`/hub/${r.id}`}
                          className="font-mono text-xs text-slate-200 hover:text-[#4FC3F7] transition-colors truncate block"
                        >
                          {r.name}
                        </Link>
                        <div className="h-0.5 mt-1.5 bg-[#1A1A2E] rounded-full overflow-hidden max-w-[180px]">
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: phase >= 3 ? `${barPct}%` : "0%",
                              background: "#4FC3F7",
                              opacity: 0.45,
                              transition: `width 600ms cubic-bezier(0.16,1,0.3,1) ${i * 22 + 300}ms`,
                            }}
                          />
                        </div>
                      </div>

                      {/* Category badge */}
                      <div>
                        <span
                          className="font-mono text-[9px] px-1.5 py-0.5 rounded truncate inline-block max-w-full"
                          style={{ color: cat.color, background: cat.bg }}
                        >
                          {cat.label}
                        </span>
                      </div>

                      {/* Agent */}
                      <div className="flex items-center gap-1.5">
                        <span
                          className="w-1.5 h-1.5 rounded-full shrink-0"
                          style={{ background: agentM.color }}
                        />
                        <span className="font-mono text-[9px] text-slate-500 truncate">{agentM.label}</span>
                      </div>

                      {/* Price */}
                      <span className="font-mono text-[11px] text-slate-500 text-right tabular-nums">
                        {r.price || "—"}
                      </span>

                      {/* Runs */}
                      <span className="font-mono text-xs text-white text-right tabular-nums">
                        {r.runs.toLocaleString()}
                      </span>

                      {/* Revenue */}
                      <span className="font-mono text-xs text-[#34D399] text-right tabular-nums">
                        ${r.revenueEst.toFixed(2)}
                      </span>
                    </div>
                  );
                })}
              </div>

              {/* Footer */}
              <p
                className="font-mono text-[9px] text-slate-800 mt-4 text-center transition-opacity duration-700"
                style={{ opacity: phase >= 3 ? 1 : 0 }}
              >
                wallet {data.totals.wallet} · est. revenue = runs × price (gross, before x402 fees)
              </p>
            </>
          )}
        </div>
      </div>
    </>
  );
}
