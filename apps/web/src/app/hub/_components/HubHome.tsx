"use client";

/**
 * Blue Hub — Home + Browse view.
 *
 * Two display modes:
 *   1. HOME (default): 5 clean opinionated sections — search hero, intent
 *      cards, editor's picks, providers showcase, category tiles. Drill-down
 *      pattern (no flat dump of 60+ tools).
 *   2. BROWSE (search ≠ "" OR category ≠ "all"): filtered tool grid with
 *      sort controls + clear filter affordance.
 */

import Link from "next/link";
import { useState } from "react";
import { useAccount } from "wagmi";
import SpendConsole from "@/components/SpendConsole";

// ─── Types (shape mirrors the local Tool/Category from /hub/page.tsx) ─────────
// Kept loose on purpose — HubHome doesn't import from page.tsx to avoid a
// circular dep. The parent passes already-typed data.

export type Agent = "blue" | "aeon" | "miroshark";

export interface HubTool {
  id:       string;
  name:     string;
  desc:     string;
  cat:      string;
  agents:   Agent[];
  price:    string;
  verified?:boolean;
  aiReady?: boolean;
  releasedAt?: number;
  // v2 marketplace provenance + stats
  source?:        "native" | "external" | "hosted";
  creatorHandle?: string;
  logoUrl?:       string;   // creator-supplied logo (public); falls back to the source badge
  callCount?:     number;
}

// Source badge — provenance of a tool in the unified grid.
const SOURCE_META: Record<NonNullable<HubTool["source"]>, { icon: string; label: string; color: string }> = {
  native:   { icon: "🔵", label: "Native",   color: "#4FC3F7" },
  external: { icon: "🌐", label: "External", color: "#34D399" },
  hosted:   { icon: "✨", label: "Hosted",   color: "#A78BFA" },
};

function SourceBadge({ source }: { source?: HubTool["source"] }) {
  const m = SOURCE_META[source ?? "native"];
  return (
    <span className="font-mono text-[8px] px-1 py-0.5 rounded border inline-flex items-center gap-1"
      style={{ color: m.color, borderColor: `${m.color}40`, background: `${m.color}0d` }}>
      <span>{m.icon}</span>{m.label}
    </span>
  );
}

// A tool's real run count = max(usage counter, denormalized callCount).
// Native tools track usage:<id>; community tools also carry callCount from KV.
function toolRuns(t: HubTool, usage: Record<string, number>): number {
  return Math.max(usage[t.id] ?? 0, t.callCount ?? 0);
}

export interface HubGroup {
  id:    string;
  label: string;
  desc:  string;
  color: string;
  ids:   string[];
}

const AGENT_COLORS: Record<Agent, string> = {
  blue:      "#4FC3F7",
  aeon:      "#A78BFA",
  miroshark: "#34D399",
};
const AGENT_LABELS: Record<Agent, string> = {
  blue: "Blue", aeon: "Aeon", miroshark: "MiroShark",
};

// ─── Intent cards — 4 entry points for newcomers ──────────────────────────────

interface Intent { label: string; sub: string; emoji: string; color: string; categoryId: string; }
const INTENTS: Intent[] = [
  { label: "Build",    sub: "Idea → architecture → ship",  emoji: "🚀", color: "#A78BFA", categoryId: "founders" },
  { label: "Trade",    sub: "Signals, momentum, copytrade", emoji: "📈", color: "#4FC3F7", categoryId: "traders"  },
  { label: "Research", sub: "DD, narratives, ecosystem",    emoji: "🔍", color: "#34D399", categoryId: "investors"},
  { label: "Secure",   sub: "Audit, honeypot, risk-gate",   emoji: "🛡️", color: "#F87171", categoryId: "security" },
];

// ─── Props ────────────────────────────────────────────────────────────────────

export interface HubHomeProps {
  tools:       HubTool[];                  // ALL tools (unfiltered, for home view)
  filtered:    HubTool[];                  // PRE-FILTERED (for browse view, from parent)
  groups:      HubGroup[];
  usage:       Record<string, number>;
  featuredIds: Set<string>;
  recentIds:   string[];                   // tool ids of cached results
  search:      string;
  cat:         string;                     // "all" | group.id | category
  source?:     "all" | NonNullable<HubTool["source"]>; // v2 sidebar provenance filter
  price?:      "all" | "free" | "under" | "over";      // v2 sidebar price bucket
  onSearch:    (s: string) => void;
  onPickCat:   (id: string) => void;
  onSelect:    (t: HubTool) => void;
  onListTool?: () => void;                 // opens the "List your tool" modal (Hub only)
  onClearFilters?: () => void;             // resets search + cat + source + price
}

export default function HubHome(props: HubHomeProps) {
  const isBrowse =
    props.search.trim() !== "" ||
    (props.cat !== "all" && props.cat !== "") ||
    (!!props.source && props.source !== "all") ||
    (!!props.price && props.price !== "all");
  return isBrowse ? <BrowseView {...props} /> : <HomeView {...props} />;
}

// ─── HOME view — clean, opinionated ───────────────────────────────────────────

function HomeView(props: HubHomeProps) {
  const { tools, usage, featuredIds, recentIds, onSearch, onPickCat, onSelect, onListTool } = props;
  // Read here rather than threaded down from HubView: the parent has no other
  // use for it, and a prop chained through two components for one panel is a
  // thing that silently goes stale. Providers wrap the root layout, so this is
  // safe on the marketing host and in the app shell alike.
  const { address } = useAccount();
  const byId = new Map(tools.map(t => [t.id, t] as const));
  const runsOf = (id: string) => { const t = byId.get(id); return t ? toolRuns(t, usage) : (usage[id] ?? 0); };

  // How many community (external + hosted) tools are live — surfaced as a badge.
  const communityCount = tools.filter(t => t.source === "external" || t.source === "hosted").length;

  // Featured — ONE section merging the old "Editor's Picks" + "Trending" (which
  // overlapped, showing the same top tools twice). Real usage ranks first, then
  // curated featuredIds pad it out; deduped by id, capped at 8 for a tight grid.
  const featured: HubTool[] = (() => {
    const seen = new Set<string>();
    const out: HubTool[] = [];
    const push = (t?: HubTool) => { if (t && !seen.has(t.id)) { seen.add(t.id); out.push(t); } };
    [...tools]
      .filter(t => runsOf(t.id) > 0)
      .sort((a, b) => runsOf(b.id) - runsOf(a.id))
      .forEach(push);
    [...featuredIds].map(id => byId.get(id)).forEach(push);
    return out.slice(0, 8);
  })();

  const recentTools = recentIds
    .map(id => tools.find(t => t.id === id))
    .filter((t): t is HubTool => !!t)
    .reverse()
    .slice(0, 6);

  // Providers — Blue is the only REAL first-party provider. Its tools carry
  // agents:["blue"] and track real usage via usage:<id>. (Aeon / MiroShark were
  // display-only placeholders with fabricated tool/call numbers — removed to keep
  // provider stats honest. Real partners get a "coming soon" card, no fake data.)
  const blueProvider = {
    agent: "blue" as Agent,
    toolCount:  tools.filter(t => t.agents.includes("blue")).length,
    totalCalls: tools.filter(t => t.agents.includes("blue")).reduce((s, t) => s + runsOf(t.id), 0),
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8">

        {/* ── HERO — marketplace thesis + dual CTA + big search ── */}
        <section className="mb-8">
          <h1 className="font-mono text-2xl sm:text-3xl font-bold text-white tracking-tight mb-2 leading-tight">
            The x402 tool marketplace <span className="text-[#4FC3F7]">on Base</span>.
          </h1>
          <p className="font-mono text-sm sm:text-base text-slate-400 mb-5 max-w-xl">
            Agents call. Creators earn <span className="text-[#A78BFA] font-semibold">95%</span>.
            <span className="text-slate-600"> No signup, no API key — USDC per call.</span>
          </p>
          <div className="flex flex-wrap gap-2 mb-5">
            <button
              type="button"
              onClick={() => { const el = document.getElementById("hub-featured"); el?.scrollIntoView({ behavior: "smooth" }); }}
              className="font-mono text-xs font-semibold px-4 py-2.5 rounded-xl border border-[#4FC3F7]/40 bg-[#4FC3F7]/10 text-[#4FC3F7] hover:bg-[#4FC3F7]/20 transition-colors">
              Browse {tools.length} tools →
            </button>
            {(() => {
              const cls = "font-mono text-xs font-semibold px-4 py-2.5 rounded-xl border border-[#A78BFA]/40 bg-[#A78BFA]/10 text-[#A78BFA] hover:bg-[#A78BFA]/20 transition-colors";
              const inner = <>List your tool · earn 95% →</>;
              return onListTool
                ? <button type="button" onClick={onListTool} className={cls}>{inner}</button>
                : <Link href="/hub/submit" className={cls}>{inner}</Link>;
            })()}
          </div>
          <SearchHero value={props.search} onChange={onSearch} totalTools={tools.length} />
        </section>

        {/* ── Recent (only if user has any) ── */}
        {recentTools.length > 0 && (
          <section className="mb-7">
            <SectionHeader emoji="↺" label="Pick up where you left off" accent="#34D399" />
            <div className="flex flex-wrap gap-2">
              {recentTools.map(t => (
                <button key={t.id} onClick={() => onSelect(t)}
                  className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-[#34D399]/20 bg-[#34D399]/5 hover:bg-[#34D399]/10 hover:border-[#34D399]/40 transition-all">
                  <span className="w-1 h-1 rounded-full bg-[#34D399]" />
                  <span className="font-mono text-[11px] text-slate-200">{t.name}</span>
                </button>
              ))}
            </div>
          </section>
        )}

        {/* ── Agent spend — only for a connected wallet ──────────────────────
            Mounted HERE, on the marketplace home, because this is where the
            money is actually spent: every row in it was paid for by clicking a
            tool on this page. /app/usage has the same panel, but a user
            browsing tools should not have to leave to find out what the last
            ones cost.

            Gated on `address`, not rendered-then-emptied: with no address there
            is no question to ask, and the component's own disconnected copy is
            aimed at a page you visit to ask about YOUR spend. On a marketplace
            home an unconnected visitor gets no panel at all rather than a
            connect-prompt competing with the two CTAs above. */}
        {address && (
          <section className="mb-9">
            <SpendConsole address={address} />
          </section>
        )}

        {/* ── INTENT CARDS — 4 entry points ── */}
        <section className="mb-9">
          <SectionHeader emoji="🎯" label="What do you want to do?" accent="#4FC3F7" />
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {INTENTS.map(intent => (
              <button key={intent.label} onClick={() => onPickCat(intent.categoryId)}
                className="text-left rounded-2xl border p-4 transition-all hover:scale-[1.02] group"
                style={{ borderColor: `${intent.color}25`, background: `${intent.color}06` }}>
                <div className="text-2xl mb-2">{intent.emoji}</div>
                <p className="font-mono text-sm font-bold mb-0.5" style={{ color: intent.color }}>{intent.label}</p>
                <p className="font-mono text-[10px] text-slate-600 leading-relaxed">{intent.sub}</p>
                <p className="mt-2 font-mono text-[10px] opacity-70 group-hover:opacity-100 transition-opacity" style={{ color: intent.color }}>
                  Explore →
                </p>
              </button>
            ))}
          </div>
        </section>

        {/* ── FEATURED — merged picks + trending, deduped, full-width grid ── */}
        {featured.length > 0 && (
          <section id="hub-featured" className="mb-9">
            <SectionHeader emoji="⭐" label="Featured" accent="#A78BFA"
              sub="Most-run + curated tools to try first" />
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
              {featured.map(t => (
                <PickCard key={t.id} tool={t} runs={runsOf(t.id)} onSelect={onSelect} />
              ))}
            </div>
          </section>
        )}

        {/* ── PROVIDERS — compact single row (Blue + partner). "List your tool"
            lives in the hero CTA + sidebar; categories live in the sidebar filter,
            so both are dropped here to cut the page's vertical length. ── */}
        <section className="mb-9">
          <SectionHeader emoji="🤖" label="Providers" accent="#FFFFFF"
            sub={communityCount > 0 ? `${communityCount} community tool${communityCount !== 1 ? "s" : ""} live` : "Blue Agent + partners integrating"} />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <ProviderCard p={blueProvider} />
            <PartnerComingSoonCard />
          </div>
          {/* Dashboard entry — the desktop sidebar has this link but it's hidden on
              mobile (lg:flex), so surface it here too for builders on small screens. */}
          <Link href="/hub/dashboard"
            className="mt-3 flex items-center justify-center gap-1.5 font-mono text-[11px] text-slate-600 hover:text-[#34D399] transition-colors">
            <span className="w-1.5 h-1.5 rounded-full bg-[#34D399]" />
            Already listed a tool? Creator dashboard →
          </Link>
        </section>

        {/* Footer — minimal */}
        <p className="font-mono text-[10px] text-slate-700 text-center pb-6">
          x402 · EIP-3009 · Base · {tools.length} live tools
        </p>
      </div>
    </div>
  );
}

// ─── BROWSE view — filtered grid ──────────────────────────────────────────────

type SortMode = "popular" | "newest" | "price-asc" | "price-desc";

function BrowseView(props: HubHomeProps) {
  const { filtered, search, cat, groups, usage, onSelect, onSearch, onPickCat, onListTool, onClearFilters, source } = props;
  const [sortMode, setSortMode] = useState<SortMode>("popular");
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const byId = new Map(filtered.map(t => [t.id, t] as const));
  const runsOf = (id: string) => { const t = byId.get(id); return t ? toolRuns(t, usage) : (usage[id] ?? 0); };

  const clearAll = onClearFilters ?? (() => { onSearch(""); onPickCat("all"); });

  const sorted = (() => {
    const tools = verifiedOnly ? filtered.filter(t => t.verified) : filtered;
    const price = (t: HubTool) => parseFloat(t.price.replace("$", "")) || 0;
    if (sortMode === "price-asc")  return [...tools].sort((a, b) => price(a) - price(b));
    if (sortMode === "price-desc") return [...tools].sort((a, b) => price(b) - price(a));
    if (sortMode === "newest")     return [...tools].sort((a, b) => (b.releasedAt ?? 0) - (a.releasedAt ?? 0));
    return [...tools].sort((a, b) => runsOf(b.id) - runsOf(a.id));
  })();

  // Provenance labels for the header + empty state.
  const sourceLabel = source && source !== "all" ? SOURCE_META[source].label : "";
  const isCommunitySource = source === "external" || source === "hosted";

  const activeGroup = groups.find(g => g.id === cat);
  const title = search.trim()
    ? `Results for “${search}”`
    : sourceLabel ? `${SOURCE_META[source as NonNullable<HubTool["source"]>].icon} ${sourceLabel} tools`
    : activeGroup ? activeGroup.label : "Filtered tools";

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6">

        {/* Breadcrumb + title */}
        <div className="flex items-center gap-3 mb-4 flex-wrap">
          <button onClick={clearAll}
            className="font-mono text-[11px] text-slate-500 hover:text-white transition-colors">
            ← Hub home
          </button>
          <span className="font-mono text-[11px] text-slate-700">/</span>
          <h2 className="font-mono text-lg sm:text-xl font-bold text-white">{title}</h2>
          <span className="font-mono text-[10px] text-slate-700 ml-auto">
            {sorted.length} of {filtered.length}
          </span>
        </div>

        {/* Sort + filter row */}
        <div className="flex items-center gap-2 mb-5 flex-wrap">
          <span className="font-mono text-[10px] text-slate-700">Sort:</span>
          {([
            { mode: "popular",    label: "Popular"   },
            { mode: "newest",     label: "Newest"    },
            { mode: "price-asc",  label: "Price ↑"   },
            { mode: "price-desc", label: "Price ↓"   },
          ] as { mode: SortMode; label: string }[]).map(s => (
            <button key={s.mode} onClick={() => setSortMode(s.mode)}
              className={`font-mono text-[10px] inline-flex items-center px-3 py-2 min-h-[44px] sm:px-2 sm:py-0.5 sm:min-h-0 rounded border transition-colors ${
                sortMode === s.mode
                  ? "text-[#4FC3F7] border-[#4FC3F7]/30 bg-[#4FC3F7]/5"
                  : "text-slate-600 border-transparent hover:text-slate-300"
              }`}>
              {s.label}
            </button>
          ))}
          <span className="w-px h-3 bg-[#1A1A2E] mx-1" />
          <button onClick={() => setVerifiedOnly(v => !v)}
            className={`font-mono text-[10px] px-2 py-0.5 rounded border transition-colors ${
              verifiedOnly
                ? "text-[#34D399] border-[#34D399]/30 bg-[#34D399]/5"
                : "text-slate-600 border-transparent hover:text-slate-300"
            }`}>
            ✓ Verified
          </button>
        </div>

        {/* Empty state — community sources get a "be the first" recruiting CTA */}
        {sorted.length === 0 ? (
          isCommunitySource ? (
            <div className="text-center py-12 max-w-md mx-auto">
              <div className="text-3xl mb-3">{SOURCE_META[source as NonNullable<HubTool["source"]>].icon}</div>
              <p className="font-mono text-sm text-white font-bold mb-1">No {sourceLabel.toLowerCase()} tools yet.</p>
              <p className="font-mono text-[11px] text-slate-500 mb-4">
                Be the first to list — creators keep <span className="text-[#A78BFA] font-semibold">95%</span> of every call, in USDC on Base.
              </p>
              {(() => {
                const cls = "inline-block font-mono text-xs font-semibold px-4 py-2.5 rounded-xl border border-[#A78BFA]/40 bg-[#A78BFA]/10 text-[#A78BFA] hover:bg-[#A78BFA]/20 transition-colors";
                const inner = <>List your tool → earn 95%</>;
                return onListTool
                  ? <button type="button" onClick={onListTool} className={cls}>{inner}</button>
                  : <Link href="/hub/submit" className={cls}>{inner}</Link>;
              })()}
              <div className="mt-4">
                <button onClick={clearAll} className="font-mono text-[11px] text-slate-600 hover:text-white transition-colors">
                  ← Back to all tools
                </button>
              </div>
            </div>
          ) : (
          <div className="text-center py-12">
            <p className="font-mono text-sm text-slate-500 mb-2">No tools match your filter.</p>
            <button onClick={clearAll}
              className="font-mono text-[11px] text-[#4FC3F7] hover:underline">
              Clear and browse all →
            </button>
          </div>
          )
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {sorted.map(t => <PickCard key={t.id} tool={t} runs={runsOf(t.id)} onSelect={onSelect} />)}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Building blocks ──────────────────────────────────────────────────────────

function SectionHeader({ emoji, label, accent, sub }: { emoji: string; label: string; accent: string; sub?: string }) {
  return (
    <div className="flex items-baseline gap-3 mb-3">
      <span className="text-base leading-none">{emoji}</span>
      <h2 className="font-mono text-sm font-bold tracking-tight" style={{ color: accent }}>{label}</h2>
      {sub && <p className="font-mono text-[10px] text-slate-700">{sub}</p>}
    </div>
  );
}

function SearchHero({ value, onChange, totalTools }: { value: string; onChange: (s: string) => void; totalTools: number }) {
  return (
    <div className="relative">
      <input
        autoFocus
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={`Search ${totalTools} tools by name or use case…`}
        className="w-full bg-[#0D0D1A] border border-[#1A1A2E] rounded-2xl px-5 py-3 pr-24 font-mono text-sm sm:text-base text-white placeholder-slate-700 focus:outline-none focus:border-[#4FC3F7]/40 transition-colors"
      />
      <kbd className="absolute right-4 top-1/2 -translate-y-1/2 font-mono text-[10px] text-slate-700 border border-[#1A1A2E] rounded px-1.5 py-0.5">⌘ K</kbd>
    </div>
  );
}

function VerifiedAiBadges({ tool }: { tool: HubTool }) {
  return (
    <div className="flex items-center gap-1">
      {tool.verified && (
        <span className="font-mono text-[8px] px-1 py-0.5 rounded border border-[#34D399]/30 text-[#34D399]/90 bg-[#34D399]/5">✓ Verified</span>
      )}
      {tool.aiReady && (
        <span className="font-mono text-[8px] px-1 py-0.5 rounded border border-[#A78BFA]/30 text-[#A78BFA]/90 bg-[#A78BFA]/5">🤖 AI Ready</span>
      )}
    </div>
  );
}

function PickCard({ tool, runs, onSelect }: { tool: HubTool; runs: number; onSelect: (t: HubTool) => void }) {
  const isCommunity = tool.source === "external" || tool.source === "hosted";
  return (
    <button onClick={() => onSelect(tool)}
      className="text-left rounded-2xl border border-[#1A1A2E] hover:border-[#A78BFA]/40 bg-[#0d0d12] p-4 transition-all flex flex-col group">
      <div className="flex items-center gap-1.5 mb-2.5">
        {tool.logoUrl && (
          // Creator logo — hides itself on load error so the badge/dots remain.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={tool.logoUrl} alt="" className="w-4 h-4 rounded object-cover shrink-0"
            onError={e => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
        )}
        {tool.agents.map(a => (
          <span key={a} className="w-1.5 h-1.5 rounded-full" style={{ background: AGENT_COLORS[a] }} />
        ))}
        <SourceBadge source={tool.source} />
        <span className="font-mono text-[9px] text-slate-700 ml-auto">{tool.price}</span>
      </div>
      <p className="font-mono text-sm font-bold text-white mb-1 leading-snug group-hover:text-[#A78BFA] transition-colors">{tool.name}</p>
      {isCommunity && tool.creatorHandle && (
        <p className="font-mono text-[9px] text-slate-600 mb-1">by {tool.creatorHandle}</p>
      )}
      <p className="font-mono text-[10px] text-slate-500 leading-relaxed line-clamp-2 flex-1 mb-3">{tool.desc}</p>
      <VerifiedAiBadges tool={tool} />
      <div className="flex items-center justify-between mt-3 pt-2.5 border-t border-[#1A1A2E]">
        <span className="font-mono text-[10px] text-slate-600">{runs > 0 ? <><span className="text-white font-semibold">{runs}</span> runs</> : "new"}</span>
        <span className="font-mono text-[10px] font-semibold text-[#A78BFA] opacity-70 group-hover:opacity-100 transition-opacity">Use →</span>
      </div>
    </button>
  );
}

function ProviderCard({ p }: { p: { agent: Agent; toolCount: number; totalCalls: number } }) {
  const color = AGENT_COLORS[p.agent];
  const label = AGENT_LABELS[p.agent];
  const blurb = "Live onchain AI tools · console commands · idea → ship on Base";
  return (
    <div className="rounded-2xl p-4 border flex flex-col" style={{ borderColor: `${color}25`, background: `${color}06` }}>
      <div className="flex items-center gap-2 mb-2">
        <div className="w-9 h-9 rounded-xl flex items-center justify-center font-bold text-sm shrink-0"
          style={{ background: `${color}18`, color, border: `1px solid ${color}40` }}>
          {label.slice(0, 2)}
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-mono text-sm font-bold" style={{ color }}>{label}</p>
          <p className="font-mono text-[10px] text-slate-700">Provider · ✓ Verified</p>
        </div>
      </div>
      <p className="font-mono text-[10px] text-slate-500 leading-relaxed mb-3 flex-1">{blurb}</p>
      <div className="grid grid-cols-2 gap-2 pt-2 border-t" style={{ borderColor: `${color}15` }}>
        <div>
          <p className="font-mono text-[9px] text-slate-700">TOOLS</p>
          <p className="font-mono text-sm font-bold text-white tabular-nums">{p.toolCount}</p>
        </div>
        <div>
          <p className="font-mono text-[9px] text-slate-700">CALLS</p>
          <p className="font-mono text-sm font-bold tabular-nums" style={{ color }}>{p.totalCalls > 0 ? p.totalCalls.toLocaleString() : "—"}</p>
        </div>
      </div>
    </div>
  );
}

// A real partner that's mid-integration — shown WITHOUT tool/call numbers because
// none are live yet (zero-fabricated-data rule). Only PMFI qualifies today.
function PartnerComingSoonCard() {
  const color = "#64748B";
  return (
    <div className="rounded-2xl p-4 border border-dashed flex flex-col" style={{ borderColor: `${color}40`, background: `${color}08` }}>
      <div className="flex items-center gap-2 mb-2">
        <div className="w-9 h-9 rounded-xl flex items-center justify-center font-bold text-sm shrink-0"
          style={{ background: `${color}18`, color, border: `1px solid ${color}40` }}>
          PM
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-mono text-sm font-bold text-slate-300">PMFI</p>
          <a href="https://x.com/pmfi_cc" target="_blank" rel="noopener noreferrer"
            className="font-mono text-[10px] text-slate-600 hover:text-slate-400 transition-colors">@pmfi_cc ↗</a>
        </div>
        <span className="font-mono text-[8px] px-1.5 py-0.5 rounded border self-start"
          style={{ color, borderColor: `${color}55`, background: `${color}0d` }}>integrating</span>
      </div>
      <p className="font-mono text-[10px] text-slate-500 leading-relaxed mb-3 flex-1">Prediction market arbitrage signals · coming soon to Blue Hub</p>
      <div className="pt-2 border-t" style={{ borderColor: `${color}20` }}>
        <p className="font-mono text-[10px] text-slate-700">Partner — tools not live yet</p>
      </div>
    </div>
  );
}
