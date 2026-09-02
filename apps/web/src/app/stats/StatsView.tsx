"use client";

/**
 * StatsView — the animated, client-side render of the /stats traction page.
 *
 * The page.tsx server component fetches the sanitized aggregate (no per-user
 * data) and hands the plain object to this island. All motion lives here:
 *   - count-up numbers (rAF, easeOutCubic, triggered on scroll-into-view)
 *   - scroll reveals (fade + slide up, staggered)
 *   - animated bar charts (adoption funnel + most-used tools)
 * Everything respects `prefers-reduced-motion` (renders final values instantly).
 *
 * No number is invented here — this component only formats + animates the
 * values computed in buildPublicStats().
 */

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { PublicStats } from "@/lib/public-stats";
import type { BankrUsage, UsageWindow } from "@/lib/bankr-usage";

// ─── motion primitives ───────────────────────────────────────────────────────

function usePrefersReducedMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduce(mq.matches);
    const on = (e: MediaQueryListEvent) => setReduce(e.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return reduce;
}

function useInView<T extends HTMLElement>(rootMargin = "0px 0px -10% 0px") {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") { setInView(true); return; }
    const ob = new IntersectionObserver(
      ([e]) => { if (e.isIntersecting) { setInView(true); ob.disconnect(); } },
      { rootMargin, threshold: 0.15 },
    );
    ob.observe(el);
    return () => ob.disconnect();
  }, [rootMargin]);
  return { ref, inView };
}

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

function useCountUp(target: number, active: boolean, duration = 1300): number {
  const [val, setVal] = useState(0);
  const reduce = usePrefersReducedMotion();
  useEffect(() => {
    if (!active) return;
    if (reduce || duration <= 0) { setVal(target); return; }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      setVal(target * easeOutCubic(t));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, target, duration, reduce]);
  return val;
}

/** Count-up number. Pass a numeric `value`, or `raw` for an unparseable string ("—"). */
function AnimatedNumber({
  value, decimals = 0, prefix = "", suffix = "", raw, format, className, style,
}: {
  value?: number; decimals?: number; prefix?: string; suffix?: string;
  raw?: string; format?: (n: number) => string; className?: string; style?: React.CSSProperties;
}) {
  const { ref, inView } = useInView<HTMLSpanElement>();
  const v = useCountUp(value ?? 0, inView && raw === undefined);
  const text = raw !== undefined
    ? raw
    : format
      ? format(v)
      : prefix + v.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) + suffix;
  return <span ref={ref} className={className} style={style}>{text}</span>;
}

function Reveal({ children, delay = 0, className = "" }: { children: React.ReactNode; delay?: number; className?: string }) {
  const { ref, inView } = useInView<HTMLDivElement>();
  const reduce = usePrefersReducedMotion();
  return (
    <div
      ref={ref}
      className={className}
      style={{
        opacity: inView || reduce ? 1 : 0,
        transform: inView || reduce ? "none" : "translateY(18px)",
        transition: reduce ? undefined : `opacity .6s ease-out ${delay}ms, transform .6s ease-out ${delay}ms`,
      }}
    >
      {children}
    </div>
  );
}

// ─── formatting helpers ──────────────────────────────────────────────────────

/** Split a compact string like "822.3M" into value + suffix. "—" → not ok. */
function parseCompact(s: string): { value: number; suffix: string; ok: boolean } {
  const m = /^([\d.]+)\s*([KMBT]?)$/.exec((s ?? "").trim());
  if (!m) return { value: 0, suffix: "", ok: false };
  return { value: parseFloat(m[1]), suffix: m[2] || "", ok: true };
}

/** Compact token/number formatting: 3_300_000 → "3.3M". */
function compact(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return Math.round(n).toLocaleString("en-US");
}

/** USD formatting: sub-cent gets more precision so "$0.0089" doesn't read as $0.00. */
function fmtUSD(n: number): string {
  if (n > 0 && n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const VENDOR_COLOR: Record<string, string> = {
  Anthropic: "#D97757", Google: "#4285F4", DeepSeek: "#4FC3F7", OpenAI: "#10A37F",
  xAI: "#E5E7EB", Moonshot: "#A78BFA", Alibaba: "#F59E0B", Mistral: "#FA520F", Meta: "#0866FF",
};

// ─── charts ──────────────────────────────────────────────────────────────────

/** Adoption funnel: Onboarded → Active → Creators. Real counts, animated bars. */
function Funnel({ claims, active, creators }: { claims: number; active: number; creators: number }) {
  const { ref, inView } = useInView<HTMLDivElement>();
  const reduce = usePrefersReducedMotion();
  const max = Math.max(claims, active, creators, 1);
  const rows = [
    { label: "Onboarded", sub: "free-credit claims", value: claims,   color: "#A78BFA" },
    { label: "Active",    sub: "wallets that spent", value: active,   color: "#4FC3F7" },
    { label: "Creators",  sub: "launched a token",   value: creators, color: "#34D399" },
  ];
  return (
    <div ref={ref} className="space-y-4">
      {rows.map((r, i) => {
        const pct = Math.max(3, Math.round((r.value / max) * 100));
        return (
          <div key={r.label}>
            <div className="flex items-baseline justify-between mb-1.5">
              <span className="font-mono text-[11px] text-slate-300">
                {r.label} <span className="text-slate-600">· {r.sub}</span>
              </span>
              <AnimatedNumber value={r.value} className="font-mono text-sm font-bold" style={{ color: r.color }} />
            </div>
            <div className="h-2.5 rounded-full bg-[#12121a] overflow-hidden">
              <div
                className="h-full rounded-full"
                style={{
                  width: inView || reduce ? `${pct}%` : "0%",
                  background: `linear-gradient(90deg, ${r.color}, ${r.color}99)`,
                  boxShadow: `0 0 12px ${r.color}55`,
                  transition: reduce ? undefined : `width 1s cubic-bezier(.22,1,.36,1) ${i * 120}ms`,
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Most-used tools — animated horizontal bars with count-up run totals. */
function ToolBars({ tools }: { tools: { name: string; runs: number }[] }) {
  const { ref, inView } = useInView<HTMLDivElement>();
  const reduce = usePrefersReducedMotion();
  const max = tools[0]?.runs || 1;
  return (
    <div ref={ref} className="rounded-2xl border border-[#1A1A2E] overflow-hidden divide-y divide-[#111119]">
      {tools.map((tl, i) => {
        const pct = Math.max(4, Math.round((tl.runs / max) * 100));
        return (
          <div key={`${tl.name}-${i}`} className="relative flex items-center gap-3 px-5 py-3 bg-[#0a0a0f]">
            <div
              className="absolute inset-y-0 left-0"
              aria-hidden
              style={{
                width: inView || reduce ? `${pct}%` : "0%",
                background: "linear-gradient(90deg, #4FC3F71f, #4FC3F708)",
                transition: reduce ? undefined : `width .9s cubic-bezier(.22,1,.36,1) ${i * 90}ms`,
              }}
            />
            <span className="relative font-mono text-[10px] text-slate-600 w-5 shrink-0">{i + 1}</span>
            <span className="relative font-mono text-xs text-white flex-1 truncate">{tl.name}</span>
            <AnimatedNumber value={tl.runs} className="relative font-mono text-xs text-[#4FC3F7] shrink-0" />
          </div>
        );
      })}
    </div>
  );
}

// ─── metric card ─────────────────────────────────────────────────────────────

interface Cell { label: string; sub?: string; color: string; value?: number; decimals?: number; prefix?: string; suffix?: string; raw?: string; }

function MetricGrid({ cells, cols }: { cells: Cell[]; cols: string }) {
  return (
    <div className={`grid ${cols} gap-px bg-[#1A1A2E] rounded-2xl overflow-hidden border border-[#1A1A2E]`}>
      {cells.map((c, i) => (
        <Reveal key={c.label} delay={i * 70}>
          <div className="group h-full bg-[#0a0a0f] p-5 transition-colors hover:bg-[#0d0d15]">
            <AnimatedNumber
              value={c.value} decimals={c.decimals} prefix={c.prefix} suffix={c.suffix} raw={c.raw}
              className="block font-mono text-2xl sm:text-3xl font-bold mb-1"
              style={{ color: c.color }}
            />
            <div className="font-mono text-[10px] text-slate-400 tracking-wide uppercase">{c.label}</div>
            {c.sub && <div className="font-mono text-[10px] text-slate-600 mt-1">{c.sub}</div>}
          </div>
        </Reveal>
      ))}
    </div>
  );
}

// ─── model usage (Bankr) ─────────────────────────────────────────────────────

function ModelUsageSection({ usage }: { usage: BankrUsage }) {
  const [win, setWin] = useState<7 | 30 | 90>(30);
  const active: UsageWindow | null = usage.windows[win];
  const { ref, inView } = useInView<HTMLDivElement>();
  const reduce = usePrefersReducedMotion();

  const summary = [
    { label: "Cost",     color: "#34D399", value: active?.cost ?? 0,     fmt: fmtUSD },
    { label: "Tokens",   color: "#4FC3F7", value: active?.tokens ?? 0,   fmt: compact },
    { label: "Requests", color: "#A78BFA", value: active?.requests ?? 0, fmt: (n: number) => compact(n) },
    { label: "Models",   color: "#FBBF24", value: active?.models ?? 0,   fmt: (n: number) => String(Math.round(n)) },
  ];
  const maxCost = active?.byModel[0]?.cost || 1;
  const hasData = !!active && active.requests > 0;

  return (
    <section className="max-w-5xl mx-auto px-6 py-6">
      <Reveal>
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div className="flex items-baseline gap-2">
            <h2 className="font-mono text-sm text-white">AI model usage</h2>
            <span className="font-mono text-[10px] text-slate-600">live · via Bankr</span>
          </div>
          {/* window toggle */}
          <div className="inline-flex rounded-full border border-[#1A1A2E] bg-[#0a0a0f] p-0.5">
            {([7, 30, 90] as const).map((d) => (
              <button
                key={d}
                onClick={() => setWin(d)}
                className={`font-mono text-[11px] px-3 py-1 rounded-full transition-colors ${
                  win === d ? "bg-[#4FC3F7] text-[#050508] font-bold" : "text-slate-500 hover:text-slate-300"
                }`}
              >
                {d}d
              </button>
            ))}
          </div>
        </div>
      </Reveal>

      {/* summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-[#1A1A2E] rounded-2xl overflow-hidden border border-[#1A1A2E]">
        {summary.map((s) => (
          <div key={s.label} className="bg-[#0a0a0f] p-5">
            <AnimatedNumber
              value={s.value} format={s.fmt}
              className="block font-mono text-2xl sm:text-3xl font-bold mb-1"
              style={{ color: s.color }}
            />
            <div className="font-mono text-[10px] text-slate-400 tracking-wide uppercase">{s.label}</div>
          </div>
        ))}
      </div>

      {/* usage by model */}
      <div ref={ref} className="mt-4 rounded-2xl border border-[#1A1A2E] bg-[#0a0a0f] overflow-hidden">
        <div className="flex items-baseline justify-between px-5 py-3 border-b border-[#111119]">
          <span className="font-mono text-xs text-white">Usage by model</span>
          <span className="font-mono text-[10px] text-slate-600">last {win} days</span>
        </div>

        {/* column header */}
        <div className="hidden sm:grid grid-cols-[1.5rem_1fr_6rem_5rem_5rem] gap-3 px-5 py-2 font-mono text-[9px] text-slate-600 uppercase tracking-widest">
          <span></span><span>Model</span><span className="text-right">Requests</span>
          <span className="text-right">Tokens</span><span className="text-right">Cost</span>
        </div>

        {!hasData ? (
          <div className="px-5 py-8 text-center font-mono text-[11px] text-slate-600">
            {active ? `No model calls in the last ${win} days.` : "Usage data unavailable."}
          </div>
        ) : (
          <div className="divide-y divide-[#111119]">
            {active!.byModel.map((m, i) => {
              const pct = Math.max(2, Math.round((m.cost / maxCost) * 100));
              const vc = VENDOR_COLOR[m.vendor] ?? "#4FC3F7";
              return (
                <div
                  key={`${m.model}-${i}`}
                  className="relative grid grid-cols-[1.5rem_1fr_auto] sm:grid-cols-[1.5rem_1fr_6rem_5rem_5rem] items-center gap-3 px-5 py-3"
                >
                  <div
                    className="absolute inset-y-0 left-0" aria-hidden
                    style={{
                      width: inView || reduce ? `${pct}%` : "0%",
                      background: `linear-gradient(90deg, ${vc}14, ${vc}03)`,
                      transition: reduce ? undefined : `width .9s cubic-bezier(.22,1,.36,1) ${i * 80}ms`,
                    }}
                  />
                  <span className="relative font-mono text-[10px] text-slate-600">{i + 1}</span>
                  <span className="relative min-w-0">
                    <span className="block font-mono text-xs text-white truncate">{m.model}</span>
                    <span className="font-mono text-[10px]" style={{ color: vc }}>{m.vendor}</span>
                  </span>
                  <span className="relative font-mono text-xs text-slate-300 text-right hidden sm:block">
                    <AnimatedNumber value={m.requests} format={compact} />
                  </span>
                  <span className="relative font-mono text-xs text-slate-300 text-right hidden sm:block">
                    <AnimatedNumber value={m.tokens} format={compact} />
                  </span>
                  <span className="relative font-mono text-xs text-[#34D399] text-right">
                    <AnimatedNumber value={m.cost} format={fmtUSD} />
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <p className="font-mono text-[10px] text-slate-600 mt-3 leading-relaxed">
        Live model spend, tokens, and requests for Blue Agent across Blue Chat + hub tools — read
        directly from Bankr for our API key. Aggregate account totals, no per-user data.
      </p>
    </section>
  );
}

// ─── main view ───────────────────────────────────────────────────────────────

export default function StatsView({ stats, usage: modelUsage }: { stats: PublicStats; usage: BankrUsage }) {
  const { launches, staking, product, usage, users, credits, settlement } = stats;
  const staked = parseCompact(staking.totalStakedBlue);
  const revenue = parseFloat((usage.revenueEst ?? "").replace(/[^0-9.]/g, "")) || 0;

  const heroCards: Cell[] = [
    { label: "Tool Runs", color: "#4FC3F7", value: usage.totalRuns },
    staked.ok
      ? { label: "BLUE Staked", color: "#34D399", value: staked.value, decimals: staked.suffix ? 1 : 0, suffix: staked.suffix }
      : { label: "BLUE Staked", color: "#34D399", raw: staking.totalStakedBlue },
    { label: "Tokens Launched", color: "#A78BFA", value: launches.total },
  ];

  const usageCells: Cell[] = [
    { label: "Total Tool Runs",   sub: "lifetime paid x402 calls",                      color: "#4FC3F7", value: usage.totalRuns },
    { label: "Est. Revenue",      sub: "Σ runs × price (USDC)",                          color: "#34D399", value: revenue, decimals: 2, prefix: "$" },
    { label: "Wallets Onboarded", sub: `free-credit claims · cap ${users.claimCap}`,     color: "#A78BFA", value: users.claims },
    { label: "Creators",          sub: "unique token launchers",                        color: "#FBBF24", value: launches.uniqueCreators },
  ];

  const activityCells: Cell[] = [
    { label: "Active Users",  sub: "distinct wallets that spent", color: "#4FC3F7", value: users.total },
    { label: "Credits Spent", sub: "Σ debited · chat + tools",    color: "#34D399", value: credits.spent },
    { label: "Chat Messages", sub: "credited chat turns",         color: "#A78BFA", value: credits.messages },
  ];

  return (
    <div className="relative">
      {/* keyframes for ambient hero motion */}
      <style>{`
        @keyframes statsGlow { 0%,100% { opacity:.55; transform:translateY(0) } 50% { opacity:1; transform:translateY(-8px) } }
        @keyframes statsSpin { to { transform:rotate(360deg) } }
      `}</style>

      {/* Ambient glow (breathing) */}
      <div className="fixed inset-x-0 top-0 h-[600px] pointer-events-none overflow-hidden">
        <div
          style={{
            background: "radial-gradient(ellipse 70% 40% at 50% -5%, #4FC3F714 0%, transparent 70%)",
            animation: "statsGlow 7s ease-in-out infinite",
          }}
          className="absolute inset-0"
        />
      </div>

      <div className="relative">
        {/* ══ HERO ══ */}
        <section className="max-w-5xl mx-auto px-6 pt-32 pb-16 text-center">
          <Reveal>
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-[#4FC3F730] bg-[#4FC3F708] mb-8">
              <span className="w-1.5 h-1.5 rounded-full bg-[#34D399] animate-pulse" />
              <span className="font-mono text-[11px] text-[#4FC3F7] tracking-widest">
                LIVE · ON-CHAIN VERIFIABLE · BASE
              </span>
            </div>
          </Reveal>

          <Reveal delay={80}>
            <h1 className="text-5xl sm:text-6xl font-bold tracking-tight mb-6 leading-tight">
              Built on Base.<br />
              <span className="text-[#4FC3F7]">Proven on-chain.</span>
            </h1>
          </Reveal>

          <Reveal delay={160}>
            <p className="text-slate-400 text-lg max-w-2xl mx-auto leading-relaxed mb-12">
              Every number here is aggregate and verifiable on Basescan. No vanity metrics,
              no per-user data — just what Blue Agent has shipped on Base.
            </p>
          </Reveal>

          <Reveal delay={240}>
            <div className="inline-grid grid-cols-3 gap-px bg-[#1A1A2E] rounded-2xl overflow-hidden border border-[#1A1A2E]">
              {heroCards.map((s) => (
                <div key={s.label} className="bg-[#0d0d12] px-6 sm:px-10 py-6 text-center transition-colors hover:bg-[#111119]">
                  <AnimatedNumber
                    value={s.value} decimals={s.decimals} prefix={s.prefix} suffix={s.suffix} raw={s.raw}
                    className="block font-mono text-2xl sm:text-3xl font-bold mb-1"
                    style={{ color: s.color }}
                  />
                  <div className="font-mono text-[10px] text-slate-600 tracking-widest">
                    {s.label.toUpperCase()}
                  </div>
                </div>
              ))}
            </div>
          </Reveal>
        </section>

        {/* ══ AI MODEL USAGE (Bankr) ══ */}
        <ModelUsageSection usage={modelUsage} />

        {/* ══ ADOPTION FUNNEL ══ */}
        <section className="max-w-5xl mx-auto px-6 py-6">
          <Reveal>
            <div className="flex items-baseline justify-between mb-4">
              <h2 className="font-mono text-sm text-white">Adoption funnel</h2>
              <span className="font-mono text-[10px] text-slate-600">onboarded → active → creators</span>
            </div>
            <div className="rounded-2xl border border-[#1A1A2E] bg-[#0a0a0f] p-6">
              <Funnel claims={users.claims} active={users.total} creators={launches.uniqueCreators} />
            </div>
          </Reveal>
        </section>

        {/* ══ USAGE & CREDITS ══ */}
        <section className="max-w-5xl mx-auto px-6 py-6">
          <Reveal>
            <div className="flex items-baseline justify-between mb-4">
              <h2 className="font-mono text-sm text-white">Usage &amp; credits</h2>
              <span className="font-mono text-[10px] text-slate-600">aggregate · real sources</span>
            </div>
          </Reveal>
          <MetricGrid cells={usageCells} cols="grid-cols-2 lg:grid-cols-4" />
          <p className="font-mono text-[10px] text-slate-600 mt-3 leading-relaxed">
            Credits are earned by staking $BLUEAGENT or claimed free at signup, then spent per Blue Chat message.
            Balances are per-wallet and private — only these aggregate counts are shown.
          </p>
        </section>

        {/* ══ ACTIVITY ══ */}
        <section className="max-w-5xl mx-auto px-6 py-6">
          <Reveal>
            <div className="flex items-baseline justify-between mb-4">
              <h2 className="font-mono text-sm text-white">Activity</h2>
              <span className="font-mono text-[10px] text-slate-600">all-time · from on-ledger history</span>
            </div>
          </Reveal>
          <MetricGrid cells={activityCells} cols="grid-cols-3" />
          <p className="font-mono text-[10px] text-slate-600 mt-3 leading-relaxed">
            Derived from the on-ledger spend history across all wallets — aggregate counts only, no wallet
            is ever exposed. Reflects real activity to date.
          </p>
        </section>

        {/* ══ ONCHAIN SETTLEMENT (Coinbase CDP) ══ */}
        <section className="max-w-5xl mx-auto px-6 py-6">
          <Reveal>
            <div className="flex items-baseline justify-between mb-4">
              <h2 className="font-mono text-sm text-white">Onchain settlement</h2>
              <span className="font-mono text-[10px] text-slate-600">real USDC · Coinbase CDP · Base</span>
            </div>
          </Reveal>
          <Reveal delay={80}>
            <div className="rounded-2xl border border-[#1A1A2E] bg-[#0a0a0f] p-6 transition-colors hover:border-[#0052FF40]">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                <div>
                  <p className="font-mono text-[10px] text-slate-600 tracking-widest uppercase mb-2">USDC settled</p>
                  {settlement.ok ? (
                    <AnimatedNumber
                      value={settlement.usdc} decimals={2} prefix="$"
                      className="font-mono text-3xl font-bold text-[#0052FF]"
                    />
                  ) : (
                    <span className="font-mono text-3xl font-bold text-slate-600">—</span>
                  )}
                </div>
                <div>
                  <p className="font-mono text-[10px] text-slate-600 tracking-widest uppercase mb-2">Settlements</p>
                  {settlement.ok ? (
                    <AnimatedNumber
                      value={settlement.count}
                      className="font-mono text-3xl font-bold text-[#4FC3F7]"
                    />
                  ) : (
                    <span className="font-mono text-3xl font-bold text-slate-600">—</span>
                  )}
                </div>
              </div>
              <p className="font-mono text-[11px] text-slate-500 leading-relaxed mt-4">
                Real USDC settled on Base through the Coinbase CDP x402 facilitator for paid tool
                calls — a live, forward-only meter of confirmed on-chain settlements. Aggregate only;
                no payer address is ever stored.
              </p>
              {settlement.ok && settlement.lastTx && (
                <a
                  href={`https://basescan.org/tx/${settlement.lastTx}`}
                  target="_blank" rel="noopener noreferrer"
                  className="font-mono text-[10px] text-[#0052FF] hover:underline"
                >
                  Latest settlement on Basescan ↗
                </a>
              )}
            </div>
          </Reveal>
        </section>

        {/* ══ STAKING + PRODUCT ══ */}
        <section className="max-w-5xl mx-auto px-6 py-6 grid grid-cols-1 md:grid-cols-2 gap-4">
          <Reveal>
            <div className="h-full rounded-2xl border border-[#1A1A2E] bg-[#0a0a0f] p-6 transition-colors hover:border-[#34D39930]">
              <p className="font-mono text-[10px] text-slate-600 tracking-widest uppercase mb-3">Staking</p>
              <div className="flex items-baseline gap-2 mb-2">
                {staked.ok ? (
                  <AnimatedNumber
                    value={staked.value} decimals={staked.suffix ? 1 : 0} suffix={staked.suffix}
                    className="font-mono text-3xl font-bold text-[#34D399]"
                  />
                ) : (
                  <span className="font-mono text-3xl font-bold text-[#34D399]">{staking.totalStakedBlue}</span>
                )}
                <span className="font-mono text-sm text-slate-500">BLUE</span>
              </div>
              <p className="font-mono text-[11px] text-slate-500 leading-relaxed">
                Total $BLUEAGENT staked in the BlueMarketStaking contract, earning
                Blue Chat credits. Verifiable on-chain on Base (8453).
              </p>
            </div>
          </Reveal>

          <Reveal delay={100}>
            <div className="h-full rounded-2xl border border-[#1A1A2E] bg-[#0a0a0f] p-6 transition-colors hover:border-[#4FC3F730]">
              <p className="font-mono text-[10px] text-slate-600 tracking-widest uppercase mb-3">Product surface</p>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <AnimatedNumber value={product.tools} className="block font-mono text-3xl font-bold text-[#4FC3F7]" />
                  <div className="font-mono text-[10px] text-slate-600 mt-1">x402 TOOLS</div>
                </div>
                <div>
                  <AnimatedNumber value={product.commands} className="block font-mono text-3xl font-bold text-[#A78BFA]" />
                  <div className="font-mono text-[10px] text-slate-600 mt-1">CORE COMMANDS</div>
                </div>
              </div>
              <p className="font-mono text-[11px] text-slate-500 leading-relaxed mt-4">
                Pay-per-use AI tools + the idea → build → audit → ship → raise workflow,
                MCP-native for Claude, Cursor & Claude Code.
              </p>
              <Link href="/hub" className="font-mono text-[10px] text-[#4FC3F7] hover:underline">
                Explore the Hub ↗
              </Link>
            </div>
          </Reveal>
        </section>

        {/* ══ TOP TOOLS BY RUNS ══ */}
        {usage.topTools.length > 0 && (
          <section className="max-w-5xl mx-auto px-6 py-10">
            <Reveal>
              <div className="flex items-baseline justify-between mb-4">
                <h2 className="font-mono text-sm text-white">Most-used tools</h2>
                <span className="font-mono text-[10px] text-slate-600">by lifetime runs</span>
              </div>
            </Reveal>
            <ToolBars tools={usage.topTools} />
          </section>
        )}

        {/* ══ TRUST STRIP ══ */}
        <section className="max-w-5xl mx-auto px-6 py-10">
          <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 font-mono text-[10px] text-slate-600">
            <span>◆ on-chain verifiable</span>
            <span>◆ non-custodial</span>
            <span>◆ Base native (8453)</span>
            <span>◆ aggregate only — no per-user data</span>
          </div>
          <p className="text-center font-mono text-[9px] text-slate-700 mt-4">
            Updated {new Date(stats.updatedAt).toISOString().replace("T", " ").slice(0, 16)} UTC · refreshes every 60s
          </p>
          <p className="text-center font-mono text-[10px] text-slate-500 mt-6">
            Want the signal receipts?{" "}
            <Link href="/track" className="text-[#4FC3F7] hover:underline">
              Blue Hood public track record →
            </Link>
          </p>
        </section>
      </div>
    </div>
  );
}
