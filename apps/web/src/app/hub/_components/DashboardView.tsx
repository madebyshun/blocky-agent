"use client";

/**
 * DashboardView — Builder (creator) dashboard for Blue Hub v2.
 *
 * Reused by two routes so it resolves on BOTH hosts:
 *   • /hub/dashboard          (public host)      → <DashboardView />
 *   • /app/hub/dashboard      (app.blueagent.dev) → <DashboardView inShell />
 * The app subdomain rewrites /hub/* → /app/hub/*, so the app-subtree wrapper is
 * required or /hub/dashboard 404s there. `inShell` only swaps the outer container
 * (the AppShell already provides page chrome); all logic is shared.
 *
 * Shows every tool the connected wallet owns across BOTH registries:
 *   • 🌐 External — builder self-hosts the endpoint (95/5 split, per-tool revenue).
 *   • ✨ Hosted   — Blue Hub runs the tool (90/10 split, pooled earnings).
 *
 * Data comes from /api/hub/builders/[address]/dashboard (secrets stripped there).
 * Earnings are BOOKKEEPING only — the on-chain payout splitter is a Phase 4 hook.
 * "Test" deep-links into the Hub runner so a creator can run their own live tool.
 *
 * ── "—" IS A REAL STATE HERE (#150 group B) ──────────────────────────────────
 * Every figure on this page comes from a KV counter that can fail to READ. The
 * API now says so: earnings are `number | null` (null = unreadable) and the
 * response carries a `coverage` field. This component must never render a null
 * as "$0.0000" or an unavailable list as "No tools registered yet" — those are
 * claims about a builder's money and inventory, and during an Upstash cap
 * window (#123, #148) they were both false while the data sat intact in KV.
 *
 * So: null → "—", partial totals → "≥", and the empty state only appears when
 * `coverage === "complete"`. If you add a figure here, give it the same three
 * cases. `?? 0` at a render site re-creates the exact bug this file was fixed for.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useAccount, useSignMessage } from "wagmi";
import { ConnectButton } from "@/components/ConnectModal";
import { useToolDetailHref } from "@/lib/hub-links";
import { fetchServerNonce } from "@/lib/siwe-nonce";

type Source = "external" | "hosted";

/**
 * Byte-identical copy of hub-registry.removeToolSiweMessage — kept local so the
 * dashboard never imports the server registry lib (which pulls in @upstash/redis)
 * into the client bundle. If the lib format changes, change this too or the
 * server-side signature verification will reject the delete.
 */
function buildRemoveSiwe(registry: Source, slug: string, owner: string, nonce: string): string {
  return [
    `Blue Hub — remove tool`,
    ``,
    `I am permanently removing my tool from Blue Hub.`,
    ``,
    `Registry: ${registry}`,
    `Slug: ${slug}`,
    `Owner: ${owner.toLowerCase()}`,
    `Nonce: ${nonce}`,
  ].join("\n");
}

type Coverage = "complete" | "partial" | "unavailable";

interface DashboardItem {
  source:      Source;
  id:          string;
  name:        string;
  description: string;
  agentName?:  string;          // creator brand/handle (default = short owner addr)
  category:    string;
  price:       string;
  priceUSDC:   number;
  verified:    boolean;
  aiReady:     boolean;
  template?:   string;
  submittedAt: number;
  callCount:   number | null;   // null = counter unreadable, NOT zero
  earnedUnits: number | null;   // null = pooled (hosted) or unreadable — see earningsScope
  earningsScope: "per_tool" | "pooled";
  splitPct:    number;
}

interface DashboardData {
  address:  string;
  items:    DashboardItem[];
  counts:   { external: number; hosted: number; total: number };
  earnings: { externalUnits: number | null; hostedUnits: number | null; totalUnits: number | null };
  coverage: Coverage;
  warnings: string[];
}

const SOURCE_META: Record<Source, { icon: string; label: string; color: string; split: string }> = {
  external: { icon: "🌐", label: "External", color: "#34D399", split: "95% builder · 5% Hub" },
  hosted:   { icon: "✨", label: "Hosted",   color: "#A78BFA", split: "90% builder · 10% Hub" },
};

function shortAddr(a: string) { return a.slice(0, 6) + "…" + a.slice(-4); }
function usdc(units: number)  { return `$${(units / 1_000_000).toFixed(4)}`; }

/**
 * The only sanctioned way to put a KV-backed figure on this page.
 * `null` → "—" (we could not read it). `partial` → "≥" (what we read is a floor).
 * Never substitute `?? 0` — that is the #150 bug, re-entered from the view layer.
 */
function fig(units: number | null, coverage: Coverage, fmt: (n: number) => string): string {
  if (units === null) return "—";
  return coverage === "complete" ? fmt(units) : `≥ ${fmt(units)}`;
}
function relTime(ms: number)  {
  const d = Date.now() - ms;
  if (d < 60_000)     return "just now";
  if (d < 3600_000)   return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

export default function DashboardView({ inShell = false, onBack }: { inShell?: boolean; onBack?: () => void }) {
  const { address, isConnected } = useAccount();
  const [data, setData]       = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr]         = useState<string | null>(null);

  const load = useCallback(() => {
    if (!address) { setData(null); return; }
    setLoading(true);
    setErr(null);
    fetch(`/api/hub/builders/${address}/dashboard`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((d: DashboardData) => setData(d))
      .catch((e: Error) => setErr(e.message))
      .finally(() => setLoading(false));
  }, [address]);

  useEffect(() => { load(); }, [load]);

  const items    = data?.items ?? [];
  const coverage = data?.coverage ?? "complete";
  // Run counts: one unreadable counter makes the sum a floor, and if EVERY row
  // is unreadable there is no sum at all. Both are visible, neither is "0".
  const callable = items.filter(t => t.callCount !== null);
  const stats = {
    tools:   data ? String(data.counts.total) : "—",
    calls:   items.length > 0 && callable.length === 0
               ? "—"
               : fig(callable.reduce((s, t) => s + (t.callCount ?? 0), 0),
                     callable.length === items.length ? coverage : "partial",
                     n => n.toLocaleString()),
    revenue: data ? fig(data.earnings.totalUnits, coverage, usdc) : "—",
  };
  // Only a fully-read, genuinely empty inventory may say "no tools yet".
  const trulyEmpty = !!data && coverage === "complete" && items.length === 0;

  return (
    <div className={`${inShell ? "h-full overflow-y-auto" : "min-h-screen"} bg-[#050508] text-white font-mono`}>

      {/* Header */}
      <div className="border-b border-[#1A1A2E] px-6 h-14 flex items-center gap-3">
        {onBack
          ? <button onClick={onBack} className="text-xs text-slate-500 hover:text-white transition-colors">← Browse</button>
          : <Link href="/hub" className="text-xs text-slate-500 hover:text-white transition-colors">← Hub</Link>}
        <span className="w-1 h-1 rounded-full bg-[#34D399] animate-pulse" />
        <p className="text-xs text-[#34D399] tracking-widest">// CREATOR DASHBOARD</p>
        <p className="text-[10px] text-slate-700 hidden sm:block">Your tools, runs, and earnings</p>
        <div className="ml-auto flex items-center gap-3">
          <Link href="/hub/submit" className="text-[11px] px-3 py-1.5 rounded-lg border border-[#A78BFA]/30 text-[#A78BFA] bg-[#A78BFA]/5 hover:bg-[#A78BFA]/10 transition-all">
            + Submit tool
          </Link>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-6 py-8">

        {!isConnected ? (
          <div className="rounded-2xl border border-[#1A1A2E] bg-[#0d0d12] p-12 text-center">
            <div className="w-16 h-16 rounded-2xl bg-[#34D399]/10 border border-[#34D399]/20 flex items-center justify-center mx-auto mb-6">
              <svg className="w-7 h-7 text-[#34D399]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 18 9 11.25l4.306 4.306a11.95 11.95 0 0 1 5.814-5.518l2.74-1.22m0 0-5.94-2.281m5.94 2.28-2.28 5.941" />
              </svg>
            </div>
            <h2 className="text-lg font-bold mb-2">Connect to view your dashboard</h2>
            <p className="text-sm text-slate-500 mb-6 max-w-xs mx-auto">
              See tools you&apos;ve registered, live run counts, and accrued USDC earnings.
            </p>
            <ConnectButton label="Connect Wallet" />
          </div>
        ) : (
          <>
            {/* Stats row */}
            <div className="grid grid-cols-3 gap-3 mb-6">
              <StatCard label="TOOLS"    value={coverage === "unavailable" ? "—" : stats.tools} accent="#4FC3F7"
                sub={data && coverage !== "unavailable" ? `${data.counts.external} ext · ${data.counts.hosted} hosted` : undefined} />
              <StatCard label="RUNS"     value={stats.calls} accent="#A78BFA" />
              <StatCard label="EARNINGS" value={stats.revenue} accent="#34D399"
                sub={stats.revenue === "—" ? "could not read — not $0" : "accrued · your share"} />
            </div>

            {/* Degraded-read banner. Amber, not red: nothing is broken or lost —
                the numbers above are simply incomplete, and saying so is the
                whole point of #150 group B. */}
            {data && coverage !== "complete" && (
              <div className="mb-6 rounded-xl border border-amber-500/25 bg-amber-500/5 p-3">
                <p className="text-[11px] font-semibold text-amber-400 mb-1">
                  {coverage === "unavailable"
                    ? "Couldn't read your tools or earnings"
                    : "This page is incomplete"}
                </p>
                <p className="text-[10px] text-amber-400/70 leading-relaxed">
                  {coverage === "unavailable"
                    ? "The registry didn't answer. Nothing has been lost or changed — your tools and accrued earnings are untouched. Reload in a moment."
                    : "Some figures below couldn't be read, so totals are shown as a minimum (≥) and \"—\" means unknown, not zero. Nothing has been lost."}
                </p>
                {data.warnings.length > 0 && (
                  <ul className="mt-2 space-y-0.5">
                    {data.warnings.map((w, i) => (
                      <li key={i} className="text-[10px] text-amber-400/50">· {w}</li>
                    ))}
                  </ul>
                )}
                <button onClick={load} className="mt-2 text-[10px] px-2 py-1 rounded-lg border border-amber-500/30 text-amber-400 hover:bg-amber-500/10 transition-all">
                  Retry
                </button>
              </div>
            )}

            {/* Wallet badge */}
            <div className="mb-6 rounded-xl border border-[#1A1A2E] bg-[#0d0d12] px-4 py-3 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="w-2 h-2 rounded-full bg-[#4FC3F7] animate-pulse" />
                <span className="text-xs text-slate-300">Wallet</span>
                <code className="text-xs text-[#4FC3F7]">{address ? shortAddr(address) : ""}</code>
              </div>
              <a href={`https://basescan.org/address/${address}`} target="_blank" rel="noopener noreferrer"
                 className="text-[10px] text-slate-600 hover:text-slate-400 transition-colors">
                Basescan ↗
              </a>
            </div>

            {/* Loading / error */}
            {loading && <p className="text-xs text-slate-600">Loading your tools…</p>}
            {err && (
              <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-3 mb-4">
                <p className="text-xs text-red-400">{err}</p>
              </div>
            )}

            {/* Empty — ONLY when we actually read an empty inventory. A KV
                failure is handled by the banner above, never by this card:
                telling a builder with 12 live tools that they have none is the
                exact lie #150 group B exists to remove. */}
            {!loading && !err && trulyEmpty && (
              <div className="rounded-2xl border border-[#1A1A2E] bg-[#0d0d12] p-8 text-center">
                <p className="text-2xl mb-2">🛠️</p>
                <p className="text-sm font-semibold mb-1">No tools registered yet</p>
                <p className="text-[11px] text-slate-600 mb-4 max-w-sm mx-auto">
                  List your first tool and earn USDC on every call. Point Blue Hub at your API,
                  or let us host an AI prompt or API wrapper for you — no server required.
                </p>
                <Link href="/hub/submit" className="inline-block text-xs px-4 py-2 rounded-xl border border-[#A78BFA]/30 text-[#A78BFA] bg-[#A78BFA]/5 hover:bg-[#A78BFA]/10 transition-all">
                  Submit your first tool →
                </Link>
              </div>
            )}

            {/* Tool list */}
            {items.length > 0 && address && (
              <div className="space-y-2">
                {items.map(t => (
                  <ToolRow key={`${t.source}:${t.id}`} t={t} owner={address} onRemoved={load} />
                ))}
              </div>
            )}

            {/* Earnings breakdown + withdraw (Phase 4 hook).
                Shown when there is anything to say — including "we couldn't
                read one side of it", which the old `revenue > 0` gate hid
                entirely (a null total silently removed the whole block). */}
            {data && (data.earnings.externalUnits !== null || data.earnings.hostedUnits !== null) &&
             (data.earnings.totalUnits === null || data.earnings.totalUnits > 0) && (
              <div className="mt-6 rounded-xl border border-[#A78BFA]/20 bg-[#A78BFA]/5 p-4">
                <div className="flex items-center justify-between gap-4 mb-3">
                  <div>
                    <p className="text-xs font-semibold mb-0.5">
                      {stats.revenue === "—"
                        ? "Accrued balance unavailable"
                        : `${stats.revenue} accrued · ready to claim`}
                    </p>
                    <p className="text-[10px] text-slate-600">On-chain payout splitter launches Phase 4. Bookkeeping is live now.</p>
                  </div>
                  <button disabled className="shrink-0 text-xs font-semibold px-3 py-1.5 rounded-lg border border-[#A78BFA]/30 text-[#A78BFA]/60 bg-[#A78BFA]/5 cursor-not-allowed">
                    Withdraw (soon)
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-3 pt-3 border-t border-[#A78BFA]/15">
                  <div>
                    <p className="text-[9px] tracking-widest text-slate-600">🌐 EXTERNAL · 95%</p>
                    <p className="text-sm font-bold text-[#34D399] tabular-nums">{fig(data.earnings.externalUnits, coverage, usdc)}</p>
                  </div>
                  <div>
                    <p className="text-[9px] tracking-widest text-slate-600">✨ HOSTED · 90% (pooled)</p>
                    <p className="text-sm font-bold text-[#A78BFA] tabular-nums">{fig(data.earnings.hostedUnits, coverage, usdc)}</p>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ToolRow({ t, owner, onRemoved }: { t: DashboardItem; owner: string; onRemoved: () => void }) {
  const m = SOURCE_META[t.source];
  const { signMessageAsync } = useSignMessage();
  const [removing, setRemoving] = useState(false);
  const [rowErr, setRowErr]     = useState<string | null>(null);
  const toolHref = useToolDetailHref();
  // Who listed this tool — the creator's brand if they set one, else their wallet short-addr.
  const creator = t.agentName?.trim() || shortAddr(owner);

  async function handleRemove() {
    if (removing) return;
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Remove "${t.name}"? This delists it from Blue Hub. Your accrued earnings are kept. This cannot be undone.`)) return;
    setRowErr(null);
    setRemoving(true);
    try {
      // Server-issued (#172). The old fallback here was `String(Date.now())` —
      // a nonce an attacker can not only replay but predict. Both paths are gone:
      // the server mints it, records it, and burns it once.
      const nonce   = await fetchServerNonce();
      const message = buildRemoveSiwe(t.source, t.id, owner, nonce);
      const signature = await signMessageAsync({ message });
      const endpoint  = t.source === "hosted" ? `/api/hub/hosted/${t.id}` : `/api/hub/tools/${t.id}`;
      const res  = await fetch(endpoint, {
        method:  "DELETE",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ owner, signature, nonce }),
      });
      const json = await res.json().catch(() => ({})) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) throw new Error(json.error || `Remove failed (${res.status})`);
      onRemoved();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setRowErr(msg.includes("rejected") || msg.includes("denied") ? "Signature cancelled" : msg);
      setRemoving(false);
    }
  }

  return (
    <div className="rounded-xl border border-[#1A1A2E] bg-[#0d0d12] p-4 hover:border-[#A78BFA]/30 transition-colors">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className="font-mono text-[8px] px-1 py-0.5 rounded border inline-flex items-center gap-1"
              style={{ color: m.color, borderColor: `${m.color}40`, background: `${m.color}0d` }}>
              <span>{m.icon}</span>{m.label}
            </span>
            {t.template && (
              <span className="font-mono text-[8px] px-1 py-0.5 rounded border border-slate-700 text-slate-500">{t.template}</span>
            )}
            {t.verified ? (
              <span className="text-[8px] px-1.5 py-0.5 rounded border border-[#34D399]/30 text-[#34D399]/90 bg-[#34D399]/5">✓ Verified</span>
            ) : (
              <span className="text-[8px] px-1.5 py-0.5 rounded border border-amber-500/30 text-amber-400 bg-amber-500/5">pending review</span>
            )}
            <span className="text-[9px] text-slate-700 ml-auto">{relTime(t.submittedAt)}</span>
          </div>
          <p className="text-sm font-semibold truncate">{t.name}</p>
          <p className="text-[10px] text-slate-500 mb-0.5">
            by <span className="text-[#A78BFA]">{creator}</span>
          </p>
          <p className="text-[10px] text-slate-600 line-clamp-1 mb-2">{t.description}</p>

          {/* Metrics. Three states per figure, never two — a null counter says
              "—", it does not say zero. */}
          <div className="flex items-center gap-4 text-[10px] text-slate-500">
            {t.callCount !== null ? (
              <span><span className="text-white font-semibold tabular-nums">{t.callCount.toLocaleString()}</span> runs</span>
            ) : (
              <span className="text-slate-600" title="The run counter could not be read — this is not zero.">— runs</span>
            )}
            <span>·</span>
            <span className="text-slate-600">{t.price} / call</span>
            <span>·</span>
            {t.earningsScope === "pooled" ? (
              <span className="text-slate-600" title="Hosted earnings are pooled across your hosted tools — see the breakdown below.">earnings pooled ✨</span>
            ) : t.earnedUnits !== null ? (
              <span><span className="text-[#34D399] font-semibold tabular-nums">{usdc(t.earnedUnits)}</span> earned</span>
            ) : (
              <span className="text-amber-400/70" title="This tool's revenue counter could not be read — this is not $0.">earnings unavailable</span>
            )}
          </div>
          <p className="text-[9px] text-slate-700 mt-1">{m.split}</p>
        </div>

        {/* Actions */}
        <div className="flex flex-col gap-1.5 shrink-0">
          <Link href={toolHref(t.id)}
            className="text-[10px] px-2.5 py-1 rounded-lg border border-[#4FC3F7]/30 text-[#4FC3F7] bg-[#4FC3F7]/5 hover:bg-[#4FC3F7]/10 transition-all text-center">
            Test ▸
          </Link>
          <button onClick={handleRemove} disabled={removing}
            className="text-[10px] px-2.5 py-1 rounded-lg border border-red-500/30 text-red-400/90 bg-red-500/5 hover:bg-red-500/10 transition-all text-center disabled:opacity-50 disabled:cursor-not-allowed">
            {removing ? "Signing…" : "Remove"}
          </button>
        </div>
      </div>

      {rowErr && <p className="text-[10px] text-red-400 mt-2">{rowErr}</p>}
    </div>
  );
}

function StatCard({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent: string }) {
  return (
    <div className="rounded-2xl border border-[#1A1A2E] bg-[#0d0d12] px-5 py-4">
      <p className="text-[10px] tracking-widest mb-1" style={{ color: accent }}>{label}</p>
      <p className="text-2xl font-bold leading-none" style={{ color: accent }}>{value}</p>
      {sub && <p className="text-[10px] text-slate-700 mt-1">{sub}</p>}
    </div>
  );
}
