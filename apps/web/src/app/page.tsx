"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import Navbar from "@/components/Navbar";
import { useLang } from "@/lib/i18n/context";
import { TOOL_COUNT } from "@/lib/agent-tools";

// Marketing surface → mono-forward. JetBrains Mono is the PRIMARY brand voice
// here (display headlines + reading body). DM Sans (.font-ui) is reserved for the
// product app's UI chrome — chat bubbles, dense tables — not this hero page.
const MONO = "'JetBrains Mono', monospace";

// ─── Data ────────────────────────────────────────────────────────────────────

// BlueAgent positioning — "The onchain Agent OS" (chain-neutral; spans
// Base + Robinhood Chain). Social proof leads with the flagship (Blue
// Hood live) + chain + x402 pricing so a visitor lands on positioning,
// not a legacy tool count. Skill count is dynamic (TOOL_COUNT) — never
// hardcode it.
const SOCIAL_PROOF = ["Blue Hood live", "Base + RH Chain", "x402 · $0.05/call", "MCP native", `${TOOL_COUNT} skills`];

const CHAT_COMMANDS = ["/idea", "/build", "/audit", "/ship", "/raise", "/pick", "/scan", "/wallet", "/launch"];

// Models available in Blue Chat — names verified against ChatMessages MODEL_LABELS.
// Switchable mid-conversation; frontier + open + private (E2EE).
const MODELS: { name: string; color: string; href?: string }[] = [
  { name: "Kimi K2",              color: "#818CF8" },
  { name: "DeepSeek V4",          color: "#34D399" },
  { name: "Claude Opus 4.7",      color: "#4FC3F7" },
  { name: "Grok 4",               color: "#E879F9" },
  { name: "Virtuals (RH-native)", color: "#22C55E" },
  { name: "Qwen3 235B",           color: "#FB923C" },
  { name: "Mistral Small",        color: "#60A5FA" },
  // Backed by `e2ee-deepseek-v4-flash` in the Virtuals catalog — the
  // claim is real. Link to the Private preset in Blue Chat so the
  // user can pick it in one click.
  { name: "Private (E2EE)",       color: "#6EE7B7", href: "/app/chat?preset=private" },
];

// BlueAgent Relaunch 2026-07-24 — product suite lead with Blue Hood
// (flagship: oracle-vs-DEX drift on Base + RH). Bank removed (archived, middleware
// redirects /bank + /pay to /chat). Image/video kept as Soon slots.
// icon: "logo" → BlueAgent logomark, otherwise an emoji glyph.
const PRODUCTS: { k: string; color: string; icon: string; href: string | null; soon?: boolean }[] = [
  { k: "hood",  color: "#34D399", icon: "🎯",  href: "/app/hood" },
  { k: "chat",  color: "#4FC3F7", icon: "logo", href: "/app/chat" },
  { k: "hub",   color: "#A78BFA", icon: "🛒",  href: "/hub" },
  { k: "mcp",   color: "#60A5FA", icon: "🔌",  href: "/docs/mcp" },
  { k: "conn",  color: "#34D399", icon: "🧩",  href: "/docs/blue-chat" },
  { k: "image", color: "#F472B6", icon: "🎨",  href: null, soon: true },
  { k: "video", color: "#E879F9", icon: "🎬",  href: null, soon: true },
];

// How you use Blue — modality tabs (Dot-style). `k` maps to home.use_<k>_label/desc.
// `soon` modalities render a placeholder preview instead of a live mock.
const USE_TABS: { k: string; color: string; icon: string; soon?: boolean }[] = [
  { k: "chat",    color: "#4FC3F7", icon: "💬" },
  { k: "code",    color: "#818CF8", icon: "‹›" },
  { k: "connect", color: "#34D399", icon: "🧩" },
  { k: "image",   color: "#F472B6", icon: "🎨", soon: true },
  { k: "video",   color: "#E879F9", icon: "🎬", soon: true },
];

const HUB_CATEGORIES = [
  { label: "RH RWA",       color: "#34D399", tools: "rh-stock-arb · rh-stock-movers · rh-stock-swap · rh-rwa-dca" },
  { label: "On-chain",     color: "#FBBF24", tools: "token price · pool scan · gas tracker · bridge route" },
  { label: "Security",     color: "#F87171", tools: "honeypot · risk gate · scam detector · scam-clone check" },
  { label: "Intelligence", color: "#4FC3F7", tools: "token alpha · narrative pulse · whale tracker" },
  { label: "DeFi",         color: "#34D399", tools: "cross-protocol yield · liquidity depth · morpho vault" },
  { label: "Builder",      color: "#A78BFA", tools: "repo health · founder check · roadmap validator" },
];

// Token-hold pricing tiers removed 2026-08 — BlueAgent positioning is
// x402 pay-per-call (USDC on Base), not hold-to-earn.

// ─── Helpers ──────────────────────────────────────────────────────────────────

function Glyph({ icon, size = 24, className = "" }: { icon: string; size?: number; className?: string }) {
  if (icon === "logo") {
    return <img src="/logomark.svg" alt="BlueAgent" width={size} height={size} className={`rounded ${className}`} style={{ display: "inline-block" }} />;
  }
  return <span className={className} style={{ fontSize: size * 0.9, lineHeight: 1 }}>{icon}</span>;
}

// Subtle fade-up on scroll (respects reduced-motion & no-JS)
function Reveal({ children, className = "", delay = 0 }: { children: React.ReactNode; className?: string; delay?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce || typeof IntersectionObserver === "undefined") { setShown(true); return; }
    const io = new IntersectionObserver(
      ([e]) => { if (e.isIntersecting) { setShown(true); io.disconnect(); } },
      { threshold: 0.1, rootMargin: "0px 0px -40px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div ref={ref} className={className} style={{
      opacity: shown ? 1 : 0,
      transform: shown ? "none" : "translateY(18px)",
      transition: `opacity .6s cubic-bezier(.22,1,.36,1) ${delay}ms, transform .6s cubic-bezier(.22,1,.36,1) ${delay}ms`,
    }}>
      {children}
    </div>
  );
}

function SectionHead({ num, kicker, title, sub, accent = "#4FC3F7" }: {
  num: string; kicker: string; title: React.ReactNode; sub?: React.ReactNode; accent?: string;
}) {
  return (
    <Reveal className="mb-10 sm:mb-14">
      <div className="font-mono text-[11px] tracking-[0.22em] mb-4">
        <span style={{ color: accent }}>// {num}</span>
        <span className="text-slate-600 ml-2 uppercase">{kicker}</span>
      </div>
      <h2 className="text-3xl sm:text-4xl lg:text-[2.85rem] font-bold tracking-tight leading-[1.06] mb-4 max-w-2xl text-white">
        {title}
      </h2>
      {sub && <p className="text-slate-400 text-[15px] sm:text-lg leading-relaxed max-w-2xl">{sub}</p>}
    </Reveal>
  );
}

// ─── Chat mockup with typing animation ────────────────────────────────────────
// Reads the chain: the response numbers cite a live source (DexScreener + onchain
// transfers), not a fabricated multi-agent framing.

const CHAT_SEGMENTS: { t: string; cls: string }[] = [
  { t: "/pick", cls: "text-[#4FC3F7]" },
  { t: " AERO — asymmetric setup?", cls: "text-slate-400" },
  { t: "\n↳ token-pick-signal · whale-tracker", cls: "text-[#34D399]" },
  { t: "\n\n{ ", cls: "text-slate-500" },
  { t: '"signal"', cls: "text-slate-400" },
  { t: ": ", cls: "text-slate-500" },
  { t: '"BUY"', cls: "text-[#34D399] font-semibold" },
  { t: ", ", cls: "text-slate-500" },
  { t: '"token"', cls: "text-slate-400" },
  { t: ": ", cls: "text-slate-500" },
  { t: '"AERO"', cls: "text-[#4FC3F7] font-semibold" },
  { t: ", ", cls: "text-slate-500" },
  { t: '"confidence"', cls: "text-slate-400" },
  { t: ": 82, ", cls: "text-slate-500" },
  { t: '"entry"', cls: "text-slate-400" },
  { t: ": ", cls: "text-slate-500" },
  { t: '"$0.49"', cls: "text-white" },
  { t: ", ", cls: "text-slate-500" },
  { t: '"source"', cls: "text-slate-400" },
  { t: ': "live DexScreener + 50 transfers" }', cls: "text-slate-500" },
  { t: "\n\n$0.20 USDC · 2.1s · Base ", cls: "text-slate-500" },
  { t: "✓", cls: "text-[#34D399]" },
];

function ChatMockup() {
  const chars = useMemo(() => {
    const out: { ch: string; cls: string }[] = [];
    for (const s of CHAT_SEGMENTS) for (const ch of Array.from(s.t)) out.push({ ch, cls: s.cls });
    return out;
  }, []);
  const [n, setN] = useState(0);

  useEffect(() => {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) { setN(chars.length); return; }
    let i = 0;
    const id = setInterval(() => {
      i += 1;
      setN(i);
      if (i >= chars.length) clearInterval(id);
    }, 20);
    return () => clearInterval(id);
  }, [chars.length]);

  // group revealed chars into contiguous same-color spans
  const groups: { cls: string; text: string }[] = [];
  for (let k = 0; k < n && k < chars.length; k++) {
    const c = chars[k];
    const last = groups[groups.length - 1];
    if (last && last.cls === c.cls) last.text += c.ch;
    else groups.push({ cls: c.cls, text: c.ch });
  }

  return (
    <div className="rounded-2xl border border-[#1A1A2E] bg-[#0d0d12] overflow-hidden h-full flex flex-col">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-[#15151f]">
        <img src="/logomark.svg" alt="BlueAgent" width={18} height={18} className="rounded" />
        <span className="font-mono text-[12px] text-slate-300">Blue Chat</span>
        <span className="ml-auto flex gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-[#ff5f57]/60" />
          <span className="w-2.5 h-2.5 rounded-full bg-[#febc2e]/60" />
          <span className="w-2.5 h-2.5 rounded-full bg-[#28c840]/60" />
        </span>
      </div>
      <pre className="flex-1 p-4 sm:p-5 whitespace-pre-wrap break-words font-mono text-[12px] sm:text-[13px] leading-relaxed m-0">
        {groups.map((g, i) => <span key={i} className={g.cls}>{g.text}</span>)}
        <span className="animate-blink text-[#4FC3F7]">_</span>
      </pre>
    </div>
  );
}

// ─── How you use Blue — modality tabs ─────────────────────────────────────────
// Dot-style tabbed switcher. Each tab renders a left copy panel + a right preview.
// `chat`/`code`/`connect` are live; `image`/`video` are Soon placeholders.

function UsePreview({ tab }: { tab: string }) {
  if (tab === "chat") return <ChatMockup />;

  if (tab === "code") {
    return (
      <div className="rounded-2xl border border-[#1A1A2E] bg-[#0d0d12] overflow-hidden h-full flex flex-col">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[#15151f]">
          <span className="font-mono text-[12px] text-[#818CF8]">/build · Kimi K2</span>
          <span className="ml-auto font-mono text-[10px] text-slate-600">$0.50 · USDC</span>
        </div>
        <pre className="flex-1 p-4 sm:p-5 whitespace-pre-wrap break-words font-mono text-[12px] sm:text-[13px] leading-relaxed m-0">
<span className="text-[#818CF8]">/build</span><span className="text-slate-400"> a Base points program</span>
{"\n\n"}<span className="text-[#34D399]">▸ stack</span><span className="text-slate-400">   Next.js · viem · Base 8453</span>
{"\n"}<span className="text-[#34D399]">▸ contracts</span><span className="text-slate-400"> Points.sol · Distributor.sol</span>
{"\n"}<span className="text-[#34D399]">▸ tests</span><span className="text-slate-400">   claim · rate-limit · reentrancy</span>
{"\n\n"}<span className="text-slate-500">→ next: </span><span className="text-[#FBBF24]">/audit</span>
        </pre>
      </div>
    );
  }

  if (tab === "connect") {
    const conns = [
      { icon: "🐙", name: "GitHub",    tools: "repos · PRs · code search" },
      { icon: "🔵", name: "Base Docs", tools: "contracts · RPC · deploy" },
      { icon: "📝", name: "Notion",    tools: "pages · search · update" },
      { icon: "📖", name: "DeepWiki",  tools: "any public repo Q&A" },
    ];
    return (
      <div className="rounded-2xl border border-[#1A1A2E] bg-[#0d0d12] overflow-hidden h-full flex flex-col">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[#15151f]">
          <span className="font-mono text-[12px] text-[#34D399]">Blue Connector · MCP</span>
          <span className="ml-auto font-mono text-[10px] text-slate-600">attached</span>
        </div>
        <div className="flex-1 p-4 sm:p-5 space-y-2.5">
          {conns.map((c) => (
            <div key={c.name} className="flex items-center gap-3 rounded-lg border border-[#15151f] bg-[#0a0a10] px-3 py-2.5">
              <span className="text-lg">{c.icon}</span>
              <span className="font-mono text-[13px] text-slate-300">{c.name}</span>
              <span className="ml-auto font-mono text-[11px] text-slate-600">{c.tools}</span>
              <span className="w-1.5 h-1.5 rounded-full bg-[#34D399]" style={{ boxShadow: "0 0 6px #34D399" }} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  // image / video → Soon placeholder
  return (
    <div className="rounded-2xl border border-dashed border-[#1A1A2E] bg-[#0d0d12] h-full flex flex-col items-center justify-center gap-3 p-10 min-h-[280px]">
      <span className="text-4xl opacity-70">{tab === "image" ? "🎨" : "🎬"}</span>
      <span className="font-mono text-[11px] uppercase tracking-wider text-[#FBBF24] border border-[#FBBF24]/30 bg-[#FBBF24]/5 rounded px-2 py-0.5">Soon</span>
    </div>
  );
}

function HowYouUse() {
  const { t } = useLang();
  const [active, setActive] = useState("chat");
  const tab = USE_TABS.find((x) => x.k === active) ?? USE_TABS[0];
  return (
    <div>
      {/* Tab bar */}
      <Reveal className="mb-8">
        <div className="inline-flex flex-wrap gap-1.5 p-1.5 rounded-2xl border border-[#1A1A2E] bg-[#0a0a10]">
          {USE_TABS.map((x) => {
            const on = x.k === active;
            return (
              <button key={x.k} onClick={() => setActive(x.k)}
                className="flex items-center gap-2 font-mono text-[12px] sm:text-[13px] rounded-xl px-3.5 py-2 transition-all"
                style={on
                  ? { background: `${x.color}1a`, color: x.color, border: `1px solid ${x.color}40` }
                  : { color: "#64748b", border: "1px solid transparent" }}>
                <span>{x.icon}</span>
                {t(`home.use_${x.k}_label`)}
                {x.soon && <span className="text-[9px] uppercase tracking-wider text-[#FBBF24]">soon</span>}
              </button>
            );
          })}
        </div>
      </Reveal>

      {/* Panel */}
      <div className="grid lg:grid-cols-2 gap-4 sm:gap-5 items-stretch">
        <Reveal key={`copy-${active}`}>
          <div className="ba-card h-full rounded-2xl p-6 sm:p-7 flex flex-col justify-center">
            <div className="text-lg font-semibold mb-2" style={{ color: tab.color }}>
              {t(`home.use_${tab.k}_label`)}
            </div>
            <p className="text-slate-400 text-[14px] sm:text-[15px] leading-relaxed mb-5">
              {t(`home.use_${tab.k}_desc`)}
            </p>
            {tab.k === "chat" && (
              <div className="flex flex-wrap gap-2">
                {CHAT_COMMANDS.map((c) => (
                  <span key={c} className="font-mono text-[12px] text-[#4FC3F7] border border-[#4FC3F7]/20 bg-[#4FC3F7]/5 rounded-lg px-2.5 py-1">{c}</span>
                ))}
              </div>
            )}
          </div>
        </Reveal>
        <Reveal key={`prev-${active}`} delay={60}>
          <UsePreview tab={active} />
        </Reveal>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Home() {
  const { t, lang } = useLang();
  return (
    <div className="min-h-screen bg-[#050508] text-white" style={{ fontFamily: MONO }}>
      <Navbar />

      {/* Ambient glow */}
      <div className="fixed inset-x-0 top-0 h-[800px] pointer-events-none overflow-hidden" aria-hidden>
        <div className="absolute inset-0" style={{ background: "radial-gradient(ellipse 75% 50% at 50% -8%, #4FC3F71f 0%, transparent 70%)" }} />
      </div>

      <main className="relative">

        {/* ══════════ HERO ══════════ */}
        <section className="max-w-5xl mx-auto px-5 sm:px-6 pt-32 sm:pt-40 pb-16 sm:pb-24 text-center">
          <img src="/logomark.svg" alt="BlueAgent" width={40} height={40} className="mx-auto mb-6 rounded-xl animate-breathe" />

          <div className="inline-flex items-center gap-2 border border-[#4FC3F7]/20 bg-[#4FC3F7]/5 rounded-full px-3.5 py-1.5 mb-8">
            <span className="w-1.5 h-1.5 rounded-full bg-[#4FC3F7] animate-pulse" />
            <span className="font-mono text-[10px] text-[#4FC3F7] tracking-[0.18em] uppercase">{t("home.badge")}</span>
          </div>

          {/* BlueAgent hero — chain-neutral "The onchain Agent OS"
              positioning (agent-centric; spans Base + Robinhood Chain, no
              single chain named in the tagline). English fallback uses the
              copy directly; Chinese routes through `home.hero_title`. */}
          <h1 className="text-[2.75rem] leading-[1.04] sm:text-6xl lg:text-7xl font-bold tracking-tight mb-5">
            {lang === "zh"
              ? t("home.hero_title")
              : <>The onchain<br className="hidden sm:block" /> <span className="text-[#4FC3F7]">Agent OS.</span></>}
          </h1>
          <p className="text-base sm:text-xl text-slate-400 mb-9 max-w-2xl mx-auto leading-relaxed">
            {lang === "zh"
              ? t("home.hero_subtitle")
              : "One agent with skills, hands, and a signal track record — sees the market, acts on it, and takes the jobs you give it. Non-custodial. Every number verifiable."}
          </p>

          {/* Lead CTA changed from "Open Chat" → "Open Hood" (flagship).
              Chat CTA moved to secondary. Legacy DexScreener link kept
              but relabeled to make clear it's the Base $BLUEAGENT (RH
              Chain launch comes via Virtuals launchpad later). */}
          <div className="flex flex-wrap items-center justify-center gap-3 mb-10">
            <Link href="/app/hood" className="text-sm font-semibold px-7 py-3 rounded-xl transition-all hover:opacity-90 active:scale-[0.98]"
              style={{ background: "linear-gradient(135deg, #34D399, #10B981)", color: "#050508", boxShadow: "0 0 26px #34D39933" }}>
              Open Blue Hood →
            </Link>
            <Link href="/app/chat" className="text-sm font-semibold text-[#4FC3F7] border border-[#4FC3F7]/30 px-7 py-3 rounded-xl hover:bg-[#4FC3F7]/5 transition-all">
              {t("home.cta_open_chat")}
            </Link>
            <Link href="/hub" className="text-sm font-semibold text-[#A78BFA] border border-[#A78BFA]/30 px-7 py-3 rounded-xl hover:bg-[#A78BFA]/5 transition-all">
              {t("home.cta_browse_hub")}
            </Link>
          </div>

          <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2 font-mono text-[11px] text-slate-600">
            {SOCIAL_PROOF.map((s, i) => (
              <span key={s} className="flex items-center gap-3">
                {i > 0 && <span className="text-slate-800">·</span>}
                {s}
              </span>
            ))}
          </div>

          {/* Product mockup — Blue Chat window */}
          <Reveal delay={120} className="mt-14 sm:mt-20">
            <div className="relative max-w-3xl mx-auto">
              <div className="absolute -inset-4 rounded-3xl pointer-events-none" style={{ background: "radial-gradient(ellipse 70% 60% at 50% 30%, #4FC3F715 0%, transparent 70%)" }} />
              <div className="relative rounded-2xl border border-[#1A1A2E] bg-[#0a0a10] overflow-hidden shadow-2xl text-left">
                <div className="flex items-center gap-2 px-4 py-3 border-b border-[#15151f]">
                  <span className="w-2.5 h-2.5 rounded-full bg-[#ff5f57]/70" />
                  <span className="w-2.5 h-2.5 rounded-full bg-[#febc2e]/70" />
                  <span className="w-2.5 h-2.5 rounded-full bg-[#28c840]/70" />
                  <span className="font-mono text-[11px] text-slate-600 ml-2">Blue Chat · blueagent.dev</span>
                </div>
                <div className="p-4 sm:p-6 space-y-4">
                  <div className="flex justify-end">
                    <div className="bg-[#34D399]/10 border border-[#34D399]/20 rounded-2xl rounded-br-md px-4 py-2.5 max-w-[80%]">
                      <span className="font-mono text-[13px] text-[#6EE7B7]">/drift NVDA — is there an arb open right now?</span>
                    </div>
                  </div>
                  <div className="flex gap-3">
                    <span className="w-7 h-7 rounded-lg bg-[#34D399]/15 flex items-center justify-center shrink-0">
                      <img src="/logomark.svg" alt="BlueAgent" width={16} height={16} className="rounded" />
                    </span>
                    <div className="flex-1 space-y-2.5">
                      <div className="flex flex-wrap gap-1.5">
                        <span className="font-mono text-[10px] text-[#34D399] border border-[#34D399]/25 bg-[#34D399]/5 rounded px-2 py-0.5">↳ rh-stock-arb</span>
                        <span className="font-mono text-[10px] text-[#FBBF24] border border-[#FBBF24]/25 bg-[#FBBF24]/5 rounded px-2 py-0.5">↳ rh-stock-agent-brief</span>
                        <span className="font-mono text-[10px] text-slate-500 border border-[#1A1A2E] rounded px-2 py-0.5">$0.10 · USDC</span>
                      </div>
                      <p className="text-[13px] text-slate-300 leading-relaxed">
                        <span className="text-white font-semibold">NVDA</span> — Chainlink oracle $208.37, DEX pool $210.38 → drift +0.97%. Below 1% arb threshold, verdict <span className="text-[#FBBF24]">ALIGNED</span>. Watch premarket for widening; total pool depth $26.9M.
                      </p>
                      <p className="text-[11px] text-slate-600 font-mono">live Chainlink RH Chain + GeckoTerminal · $0.10 USDC via x402</p>
                    </div>
                  </div>
                </div>
                <div className="px-4 py-3 border-t border-[#15151f] flex items-center gap-2">
                  <div className="flex-1 bg-[#0f0f17] border border-[#1A1A2E] rounded-lg px-3 py-2 font-mono text-[12px] text-slate-600">Ask anything, or type /</div>
                  <span className="w-8 h-8 rounded-lg bg-[#4FC3F7]/15 flex items-center justify-center text-[#4FC3F7]">↑</span>
                </div>
              </div>
            </div>
          </Reveal>
        </section>

        {/* ══════════ MODELS STRIP ══════════ */}
        <section className="max-w-5xl mx-auto px-5 sm:px-6 py-14 sm:py-20 border-t border-[#13131d]">
          <Reveal className="text-center mb-8">
            <div className="font-mono text-[11px] tracking-[0.22em] mb-3">
              <span className="text-[#818CF8]">// 0.0</span>
              <span className="text-slate-600 ml-2 uppercase">{t("home.s_models_kicker")}</span>
            </div>
            <h2 className="text-2xl sm:text-3xl font-bold tracking-tight mb-3 text-white">
              {lang === "zh" ? t("home.s_models_title")
                : <>One chat. <span className="text-[#818CF8]">Every frontier model.</span></>}
            </h2>
            <p className="text-slate-400 text-[14px] sm:text-base leading-relaxed max-w-2xl mx-auto">{t("home.s_models_sub")}</p>
          </Reveal>
          <Reveal delay={80}>
            <div className="flex flex-wrap items-center justify-center gap-2.5 sm:gap-3">
              {MODELS.map((m) => {
                const chip = (
                  <span key={m.name}
                    className={"flex items-center gap-2 font-mono text-[12px] sm:text-[13px] rounded-full border px-3.5 py-1.5 " + (m.href ? "hover:brightness-125 transition-all cursor-pointer" : "")}
                    style={{ borderColor: `${m.color}33`, background: `${m.color}0d`, color: m.color }}>
                    <span className="w-1.5 h-1.5 rounded-full" style={{ background: m.color, boxShadow: `0 0 6px ${m.color}` }} />
                    {m.name}
                  </span>
                );
                return m.href
                  ? <a key={m.name} href={m.href} aria-label={`Open ${m.name} preset in Blue Chat`}>{chip}</a>
                  : chip;
              })}
            </div>
          </Reveal>
        </section>

        {/* ══════════ 1.0 ONE STACK ══════════ */}
        <section className="max-w-5xl mx-auto px-5 sm:px-6 py-16 sm:py-24 border-t border-[#13131d]">
          <SectionHead
            num="1.0" kicker={t("home.s_stack_kicker")}
            title={lang === "zh" ? t("home.s_stack_title")
              : <>One agent runtime on Base. <span className="text-[#4FC3F7]">Every surface shares it.</span></>}
            sub={t("home.s_stack_sub")}
          />
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
            {PRODUCTS.map((p, i) => {
              const label = t(`home.stack_${p.k}_label`);
              const desc  = t(`home.stack_${p.k}_desc`);
              const inner = (
                <div className="ba-card h-full rounded-2xl p-5 sm:p-6 relative">
                  {p.soon && (
                    <span className="absolute top-4 right-4 font-mono text-[10px] uppercase tracking-wider text-[#FBBF24] border border-[#FBBF24]/30 bg-[#FBBF24]/5 rounded px-1.5 py-0.5">
                      {t("home.stack_soon")}
                    </span>
                  )}
                  <div className="mb-3"><Glyph icon={p.icon} size={26} /></div>
                  <div className="text-base font-semibold mb-1.5" style={{ color: p.color }}>{label}</div>
                  <p className="font-mono text-[12px] text-slate-500 leading-relaxed">{desc}</p>
                </div>
              );
              return (
                <Reveal key={p.k} delay={i * 60}>
                  {p.href
                    ? <Link href={p.href} className="block h-full transition-transform hover:-translate-y-0.5">{inner}</Link>
                    : <div className="h-full opacity-90">{inner}</div>}
                </Reveal>
              );
            })}
          </div>
        </section>

        {/* ══════════ 2.0 MANIFESTO — reads the chain ══════════ */}
        <section className="max-w-5xl mx-auto px-5 sm:px-6 py-16 sm:py-24 border-t border-[#13131d]">
          <Reveal>
            <div className="font-mono text-[11px] tracking-[0.22em] mb-5">
              <span className="text-[#4FC3F7]">// 2.0</span>
              <span className="text-slate-600 ml-2 uppercase">{t("home.s_why_kicker")}</span>
            </div>
            <h2 className="text-3xl sm:text-5xl font-bold tracking-tight leading-[1.08] mb-6 max-w-3xl">
              {lang === "zh" ? t("home.s_why_title")
                : <>Most agents <span className="text-slate-500">guess</span> about markets.<br className="hidden sm:block" /> Blue Hood <span className="text-[#34D399]">watches them.</span></>}
            </h2>
            <p className="text-slate-400 text-[15px] sm:text-lg leading-relaxed max-w-2xl">
              {lang === "zh" ? t("home.s_why_sub")
                : "Tokenized stocks trade onchain 24/7 — but their Chainlink oracles only tick 24/5. Nobody owns that oracle-vs-DEX drift, or a public track record that grades every call. Blue Hood is the intelligence layer for tokenized-stock trading on Base (Coinbase B20) and Robinhood Chain: drift signals, every arrow signed by the user, every call graded in public — misses included."}
            </p>
          </Reveal>
        </section>

        {/* ══════════ 3.0 HOW YOU USE BLUE ══════════ */}
        <section className="max-w-5xl mx-auto px-5 sm:px-6 py-16 sm:py-24 border-t border-[#13131d]">
          <SectionHead
            num="3.0" kicker={t("home.s_chat_kicker")} accent="#34D399"
            title={lang === "zh" ? t("home.s_chat_title")
              : <>One chat. <span className="text-[#34D399]">Every job.</span></>}
            sub={t("home.s_chat_sub")}
          />
          <HowYouUse />
        </section>

        {/* ══════════ 4.0 HUB ══════════ */}
        <section className="max-w-5xl mx-auto px-5 sm:px-6 py-16 sm:py-24 border-t border-[#13131d]">
          <SectionHead
            num="4.0" kicker={t("home.s_hub_kicker")} accent="#A78BFA"
            title={lang === "zh" ? t("home.s_hub_title")
              : <>{TOOL_COUNT} tools. <span className="text-[#A78BFA]">Called inside the chat.</span></>}
            sub={t("home.s_hub_sub")}
          />
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4 mb-6">
            {HUB_CATEGORIES.map((cat, i) => (
              <Reveal key={cat.label} delay={i * 60}>
                <div className="ba-card h-full rounded-2xl p-5">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="w-1.5 h-1.5 rounded-full" style={{ background: cat.color, boxShadow: `0 0 6px ${cat.color}` }} />
                    <span className="text-sm font-semibold" style={{ color: cat.color }}>{cat.label}</span>
                  </div>
                  <p className="font-mono text-[12px] text-slate-500 leading-relaxed">{cat.tools}</p>
                </div>
              </Reveal>
            ))}
            <Reveal delay={300}>
              <Link href="/hub" className="ba-card h-full flex flex-col justify-center items-start rounded-2xl p-5">
                <span className="text-sm font-semibold text-[#A78BFA] mb-1">{t("home.hub_browse_all")}</span>
                <span className="font-mono text-[11px] text-slate-600">{t("home.hub_browse_sub")}</span>
              </Link>
            </Reveal>
          </div>
          <Reveal>
            <p className="font-mono text-[12px] text-slate-500">{t("home.hub_pricing_line")}</p>
          </Reveal>
        </section>

        {/* ══════════ 5.0 TWO WAYS IN ══════════ */}
        <section className="max-w-5xl mx-auto px-5 sm:px-6 py-16 sm:py-24 border-t border-[#13131d]">
          <SectionHead
            num="5.0" kicker={t("home.s_ways_kicker")} accent="#60A5FA"
            title={lang === "zh" ? t("home.s_ways_title")
              : <>One agent. <span className="text-[#60A5FA]">Two ways in.</span></>}
            sub={t("home.s_ways_sub")}
          />
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 sm:gap-4 mb-6">
            <Reveal>
              <div className="ba-card h-full rounded-2xl p-6 flex flex-col">
                <div className="text-sm font-semibold mb-2 text-[#4FC3F7]">{t("home.ways_chat_label")}</div>
                <p className="font-mono text-[12px] text-slate-500 leading-relaxed mb-5">{t("home.ways_chat_desc")}</p>
                <Link href="/app/chat" className="mt-auto text-sm font-semibold text-[#4FC3F7] border border-[#4FC3F7]/30 px-5 py-2.5 rounded-xl text-center hover:bg-[#4FC3F7]/5 transition-all">
                  {t("home.cta_open_chat")}
                </Link>
              </div>
            </Reveal>
            <Reveal delay={80}>
              <div className="ba-card h-full rounded-2xl p-6 flex flex-col">
                <div className="text-sm font-semibold mb-2 text-[#60A5FA]">{t("home.ways_api_label")}</div>
                <p className="font-mono text-[12px] text-slate-500 leading-relaxed mb-5">{t("home.ways_api_desc")}</p>
                <Link href="/docs/x402" className="mt-auto text-sm font-semibold text-[#60A5FA] border border-[#60A5FA]/30 px-5 py-2.5 rounded-xl text-center hover:bg-[#60A5FA]/5 transition-all">
                  {t("home.final_install_mcp")}
                </Link>
              </div>
            </Reveal>
          </div>
          <Reveal>
            <div className="rounded-2xl border border-[#1A1A2E] bg-[#0a0a10] overflow-hidden">
              <div className="flex items-center gap-2 px-4 py-2.5 border-b border-[#15151f]">
                <span className="w-2.5 h-2.5 rounded-full bg-[#ff5f57]/60" />
                <span className="w-2.5 h-2.5 rounded-full bg-[#febc2e]/60" />
                <span className="w-2.5 h-2.5 rounded-full bg-[#28c840]/60" />
                <span className="font-mono text-[11px] text-slate-600 ml-2">terminal</span>
              </div>
              <pre className="p-4 sm:p-5 overflow-x-auto font-mono text-[12px] leading-relaxed m-0">
<span className="text-slate-600">$ </span><span className="text-[#4FC3F7]">curl</span><span className="text-slate-300"> https://blueagent.dev/api/x402/rh-stock-arb \</span>
{"\n"}<span className="text-slate-500">    -d </span><span className="text-[#34D399]">{'\'{"ticker":"NVDA"}\''}</span>
{"\n"}<span className="text-slate-500">→ </span><span className="text-slate-300">{'{"verdict":"ALIGNED","oracle":208.37,"dex":210.38,"drift":0.97,...}'}</span>
{"\n"}<span className="text-slate-600">Charged: </span><span className="text-[#FBBF24]">$0.05 USDC · Base</span>
              </pre>
            </div>
          </Reveal>
        </section>

        {/* ══════════ 6.0 PRICING ══════════ */}
        <section className="max-w-5xl mx-auto px-5 sm:px-6 py-16 sm:py-24 border-t border-[#13131d]">
          <SectionHead
            num="6.0" kicker={t("home.s_pricing_kicker")} accent="#34D399"
            title={lang === "zh" ? t("home.s_pricing_title")
              : <>Two rails. <span className="text-[#34D399]">No subscription.</span></>}
            sub={t("home.s_pricing_sub")}
          />
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
            {[
              { label: t("home.pricing_chat_label"), price: t("home.pricing_chat_price"), desc: t("home.pricing_chat_desc"), accent: "#4FC3F7" },
              { label: t("home.pricing_hub_label"),  price: t("home.pricing_hub_price"),  desc: t("home.pricing_hub_desc"),  accent: "#34D399" },
              { label: t("home.pricing_mcp_label"),  price: t("home.pricing_mcp_price"),  desc: t("home.pricing_mcp_desc"),  accent: "#60A5FA" },
            ].map((c, i) => (
              <Reveal key={c.label} delay={i * 80}>
                <div className="ba-card h-full rounded-2xl p-6 flex flex-col">
                  <div className="text-sm font-semibold mb-3" style={{ color: c.accent }}>{c.label}</div>
                  <div className="text-2xl font-bold text-white mb-2 tracking-tight">{c.price}</div>
                  <p className="font-mono text-[12px] text-slate-500 leading-relaxed">{c.desc}</p>
                </div>
              </Reveal>
            ))}
          </div>
          <Reveal>
            <p className="font-mono text-[12px] text-slate-500 mt-6">{t("home.pricing_footnote")}</p>
          </Reveal>
        </section>

        {/* ══════════ FINAL CTA ══════════ */}
        <section className="max-w-5xl mx-auto px-5 sm:px-6 py-20 sm:py-28 border-t border-[#13131d]">
          <Reveal>
            <div className="rounded-3xl border border-[#4FC3F7]/20 p-8 sm:p-14 text-center" style={{ background: "radial-gradient(ellipse 80% 70% at 50% 40%, #4FC3F710 0%, transparent 70%)" }}>
              <h2 className="text-3xl sm:text-5xl font-bold tracking-tight mb-8">
                {lang === "zh" ? t("home.final_title")
                  : <>Put your <span className="text-[#4FC3F7]">onchain agent</span> to work</>}
              </h2>
              <div className="flex flex-wrap justify-center gap-3">
                <Link href="/app/chat" className="text-sm font-semibold px-7 py-3 rounded-xl transition-all hover:opacity-90 active:scale-[0.98]"
                  style={{ background: "linear-gradient(135deg, #4FC3F7, #29ABE2)", color: "#050508", boxShadow: "0 0 26px #4FC3F733" }}>
                  {t("home.final_open_chat")}
                </Link>
                <Link href="/hub" className="text-sm font-semibold text-[#4FC3F7] border border-[#4FC3F7]/30 px-7 py-3 rounded-xl hover:bg-[#4FC3F7]/5 transition-all">
                  {t("home.final_browse_hub")}
                </Link>
                <Link href="/docs/mcp" className="text-sm font-semibold text-slate-400 border border-[#1A1A2E] px-7 py-3 rounded-xl hover:text-white hover:border-[#4FC3F7]/30 transition-all">
                  {t("home.final_install_mcp")}
                </Link>
                <Link href="/docs" className="text-sm font-semibold text-slate-400 border border-[#1A1A2E] px-7 py-3 rounded-xl hover:text-white hover:border-[#4FC3F7]/30 transition-all">
                  {t("home.final_read_docs")}
                </Link>
              </div>
            </div>
          </Reveal>
        </section>

        {/* ══════════ FOOTER ══════════ */}
        <footer className="border-t border-[#1A1A2E] px-5 sm:px-6 py-10 max-w-5xl mx-auto">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-6">
            <div>
              <div className="flex items-center gap-2.5 mb-2">
                <img src="/logomark.svg" alt="BlueAgent" width={20} height={20} className="rounded-md" />
                <span className="font-semibold text-white">BlueAgent</span>
                <span className="text-xs text-slate-500">· {t("home.footer_tagline")}</span>
              </div>
              <p className="font-mono text-[11px] text-slate-600">{t("home.footer_powered")}</p>
            </div>
            <div className="flex items-center gap-5 font-mono text-xs text-slate-600">
              <a href="https://x.com/blueagent_" target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors">X</a>
              <a href="https://t.me/blueagent_hub" target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors">Telegram</a>
              <a href="https://github.com/madebyshun/blue-agent" target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors">GitHub</a>
              <Link href="/docs" className="hover:text-white transition-colors">Docs</Link>
            </div>
          </div>
        </footer>

      </main>
    </div>
  );
}
