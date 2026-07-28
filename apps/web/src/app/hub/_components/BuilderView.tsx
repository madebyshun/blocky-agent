/**
 * BuilderView — presentational card for a public builder profile (identity,
 * stats, tool list). Server component: it receives already-fetched registry
 * data so the data fetch + notFound() guard stay in the route page.
 *
 * Reused by two routes so it resolves on BOTH hosts:
 *   • /hub/builders/[address]          (public host)      → <BuilderView … />
 *   • /app/hub/builders/[address]      (app.blueagent.dev) → <BuilderView … inShell />
 * The app subdomain rewrites /hub/* → /app/hub/*, so the app-subtree wrapper is
 * required or the profile gets swallowed by /app/hub/[tool] there. This page has
 * no <Navbar/> (its own minimal header), so `inShell` only swaps the
 * min-h-screen wrapper for h-full overflow-y-auto — otherwise it clips inside
 * the AppShell.
 */

import Link from "next/link";
import type { RegisteredTool, BuilderStats } from "@/lib/hub-registry";

function shortAddr(a: string) { return a.slice(0, 6) + "…" + a.slice(-4); }
function usdc(units: number)  { return `$${(units / 1_000_000).toFixed(4)}`; }
function relTime(ms: number) {
  const d = Date.now() - ms;
  if (d < 60_000)    return "just now";
  if (d < 3600_000)  return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

export default function BuilderView({
  address,
  tools,
  stats,
  inShell = false,
}: {
  address: string;
  tools: RegisteredTool[];
  stats: BuilderStats;
  inShell?: boolean;
}) {
  const agentName = tools[0]?.agentName ?? shortAddr(address);

  return (
    <div className={`bg-[#050508] text-white font-mono ${inShell ? "h-full overflow-y-auto" : "min-h-screen"}`}>

      {/* Header */}
      <div className="border-b border-[#1A1A2E] px-6 h-14 flex items-center gap-3">
        <Link href="/hub" className="text-xs text-slate-500 hover:text-white transition-colors">← Hub</Link>
        <span className="w-1 h-1 rounded-full bg-[#4FC3F7] animate-pulse" />
        <p className="text-xs text-[#4FC3F7] tracking-widest">// BUILDER</p>
      </div>

      <div className="max-w-3xl mx-auto px-6 py-8">

        {/* Identity */}
        <div className="flex items-start gap-4 mb-8">
          <div className="w-16 h-16 rounded-2xl border border-[#4FC3F7]/30 bg-[#4FC3F7]/5 flex items-center justify-center shrink-0">
            <span className="text-2xl font-bold text-[#4FC3F7]">{agentName.slice(0, 2).toUpperCase()}</span>
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-bold tracking-tight mb-1">{agentName}</h1>
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              <code className="text-[11px] text-slate-400">{shortAddr(address)}</code>
              <a href={`https://basescan.org/address/${address}`} target="_blank" rel="noopener noreferrer"
                 className="text-[10px] text-slate-700 hover:text-slate-400">Basescan ↗</a>
            </div>
            <p className="text-[11px] text-slate-600">Blue Hub builder — {stats.toolCount} tool{stats.toolCount !== 1 ? "s" : ""} listed</p>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-3 mb-8">
          <div className="rounded-2xl border border-[#1A1A2E] bg-[#0d0d12] px-5 py-4">
            <p className="text-[10px] tracking-widest mb-1 text-[#4FC3F7]">TOOLS</p>
            <p className="text-2xl font-bold leading-none text-[#4FC3F7]">{stats.toolCount}</p>
          </div>
          <div className="rounded-2xl border border-[#1A1A2E] bg-[#0d0d12] px-5 py-4">
            <p className="text-[10px] tracking-widest mb-1 text-[#A78BFA]">TOTAL CALLS</p>
            <p className="text-2xl font-bold leading-none text-[#A78BFA]">{stats.totalCalls.toLocaleString()}</p>
          </div>
          <div className="rounded-2xl border border-[#1A1A2E] bg-[#0d0d12] px-5 py-4">
            <p className="text-[10px] tracking-widest mb-1 text-[#34D399]">REVENUE</p>
            <p className="text-2xl font-bold leading-none text-[#34D399]">{usdc(stats.totalRevenue)}</p>
            <p className="text-[10px] text-slate-700 mt-1">95% builder share</p>
          </div>
        </div>

        {/* Tools */}
        {tools.length === 0 ? (
          <div className="rounded-2xl border border-[#1A1A2E] bg-[#0d0d12] p-8 text-center">
            <p className="text-sm text-slate-500">No tools registered yet.</p>
          </div>
        ) : (
          <div>
            <p className="text-[10px] text-slate-600 tracking-widest mb-3">TOOLS</p>
            <div className="rounded-2xl border border-[#1A1A2E] overflow-hidden">
              {tools.map(t => (
                <Link key={t.id} href={`/app/hub/${t.id}`}
                  className="grid grid-cols-[1fr_auto_auto_auto] gap-4 px-4 py-3 border-b border-[#1A1A2E] last:border-0 hover:bg-[#4FC3F7]/5 transition-colors items-center">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <p className="text-sm font-semibold truncate">{t.name}</p>
                      {t.verified && <span className="text-[9px] px-1.5 py-0.5 rounded border border-[#34D399]/30 text-[#34D399]/90 bg-[#34D399]/5">✓ Verified</span>}
                      {t.aiReady && <span className="text-[9px] px-1.5 py-0.5 rounded border border-[#A78BFA]/30 text-[#A78BFA]/90 bg-[#A78BFA]/5">🤖 AI Ready</span>}
                    </div>
                    <p className="text-[10px] text-slate-600 truncate">{t.description}</p>
                  </div>
                  <span className="text-[10px] text-slate-700">{(t.callCount ?? 0).toLocaleString()} calls</span>
                  <span className="text-xs text-slate-400">{t.price}</span>
                  <span className="text-[10px] text-slate-700 text-right">{relTime(t.submittedAt)}</span>
                </Link>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
