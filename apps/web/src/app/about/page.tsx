"use client";

import Link from "next/link";
import Navbar from "@/components/Navbar";
import { TOOL_COUNT } from "@/lib/agent-tools";

// ── Data ──────────────────────────────────────────────────────────────────────

const SURFACES = [
  {
    icon: "🎯",
    name: "Blue Hood",
    handle: "blueagent.dev/app/hood",
    desc: "The flagship copilot for Robinhood Chain. 24/7 non-custodial arbitrage between Chainlink oracles and DEX pools. Review-and-sign trading — every arrow is user-signed, no session keys.",
    link: "/app/hood",
    linkLabel: "Open Hood →",
    color: "#34D399",
    stats: [{ label: "Chain", value: "RH 4663" }, { label: "Signing", value: "Non-custodial" }],
  },
  {
    icon: "💬",
    name: "Blue Chat",
    handle: "blueagent.dev/app/chat",
    desc: "Multi-model AI chat wired to live Base + RH Chain intelligence, tool execution, artifacts, and share links. Your wallet is your identity — pay per tool call via x402.",
    link: "/app/chat",
    linkLabel: "Open Chat →",
    color: "#4FC3F7",
    stats: [{ label: "Models", value: "6" }, { label: "Access", value: "Free tier" }],
  },
  {
    icon: "🛠️",
    name: "Blue Hub",
    handle: "blueagent.dev/app/hub",
    desc: `${TOOL_COUNT} pay-per-use AI tools for Base + RH Chain builders and agents. idea → build → audit → ship → raise. Pay per call in USDC on Base via x402.`,
    link: "/app/hub",
    linkLabel: "Open Hub →",
    color: "#A78BFA",
    stats: [{ label: "Tools", value: String(TOOL_COUNT) }, { label: "Commands", value: "5 core" }],
  },
  {
    icon: "⚡",
    name: "MCP Server",
    handle: "blueagent.dev/api/mcp",
    desc: "57 tools via MCP (15 blue_ + 42 hub_) — plug into Claude Desktop, Cursor, or any MCP client. No API key needed. Tools run free via internal bypass.",
    link: "https://blueagent.dev/api/mcp",
    linkLabel: "Connect MCP →",
    color: "#F59E0B",
    stats: [{ label: "Tools", value: "57" }, { label: "Clients", value: "Cursor · Claude" }],
  },
];

const ROADMAP = [
  {
    period: "Mar–Jun 2026",
    status: "done",
    items: [
      { done: true, text: "Web-native relaunch — onchain Agent OS console, non-custodial by default" },
      { done: true, text: `Blue Hub — ${TOOL_COUNT} x402 tools, pay-per-call in USDC on Base` },
      { done: true, text: "Blue Chat — multi-model AI, artifacts, public share links" },
      { done: true, text: "Blue Bank — send, swap, yield, invoices, QR pay (archived 2026-07)" },
      { done: true, text: "MCP Server — 57 tools, full x402 catalog parity" },
      { done: true, text: "Agent SDK — @blueagent/x402, agents pay + call tools onchain" },
      { done: true, text: "B20 — deploy from chat, plus tracker, check, analyze, launch" },
      { done: true, text: "x402 Builder Codes — every paid call attributed onchain" },
    ],
  },
  {
    period: "Q3 2026 — Robinhood Chain",
    status: "building",
    items: [
      { done: true,  text: "Blue Hood — See · Explain · Alert · Act on RH Chain (chainId 4663)" },
      { done: true,  text: "Market-aware grader — arrows scored in NYSE regular hours only" },
      { done: true,  text: "RH RWA Phases 1–7 — registry, market analytics, trading, portfolio, discovery, agent skills, bridge/builder kit" },
      { done: true,  text: "x402 pay-per-call — RH + Base tools billed in USDC on Base" },
      { done: false, text: "Blue Hood reputation — arrow track record → public builder scores" },
      { done: false, text: "Builder Registry — submit your tool, earn 95% in USDC" },
      { done: false, text: "Tool discovery — search, rank by calls/revenue, verified badges" },
      { done: false, text: "Tool chains — compose multiple tools, one payment" },
      { done: false, text: "Distribution — listed on Smithery, MCP.SO, CDP Bazaar, RH Agentic Directory" },
    ],
  },
  {
    period: "Q4 2026 — Network",
    status: "planned",
    items: [
      { done: false, text: "Public API — api.blueagent.dev, the Stripe of AI tools on Base + RH" },
      { done: false, text: "Cross-agent routing — best agent + tool per intent" },
      { done: false, text: "Agent registry — directory of active buyer agents" },
      { done: false, text: "Tool creator rewards — top tools earn weekly in USDC" },
      { done: false, text: "Cobalt-ready — gas in B20, account abstraction support" },
    ],
  },
];

const STATS = [
  { value: String(TOOL_COUNT), label: "AI Tools",      color: "#4FC3F7" },
  { value: String(TOOL_COUNT), label: "API Endpoints", color: "#A78BFA" },
  { value: "RH+Base", label: "Chains",        color: "#34D399" },
  { value: "x402",   label: "Payment rail",   color: "#F59E0B" },
];

// ── Components ────────────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="inline-flex items-center gap-2 mb-6">
      <div className="h-px w-8 bg-[#4FC3F740]" />
      <span className="font-mono text-[11px] text-[#4FC3F7] tracking-[0.2em] uppercase">{children}</span>
      <div className="h-px w-8 bg-[#4FC3F740]" />
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AboutPage() {
  return (
    <div className="min-h-screen bg-[#050508] text-white">
      <Navbar />

      {/* ── Ambient glow ── */}
      <div className="fixed inset-x-0 top-0 h-[600px] pointer-events-none overflow-hidden">
        <div style={{ background: "radial-gradient(ellipse 70% 40% at 50% -5%, #4FC3F714 0%, transparent 70%)" }} className="absolute inset-0" />
      </div>

      <div className="relative">

        {/* ══ HERO ══════════════════════════════════════════════════════════════ */}
        <section className="max-w-5xl mx-auto px-6 pt-32 pb-24 text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-[#4FC3F730] bg-[#4FC3F708] mb-8">
            <span className="w-1.5 h-1.5 rounded-full bg-[#4FC3F7] animate-pulse" />
            <span className="font-mono text-[11px] text-[#4FC3F7] tracking-widest">BUILT FOR ROBINHOOD CHAIN + BASE</span>
          </div>

          <h1 className="text-5xl sm:text-6xl font-bold tracking-tight mb-6 leading-tight">
            The onchain<br />
            <span className="text-[#4FC3F7]">Agent OS</span>
          </h1>

          <p className="text-slate-400 text-lg max-w-2xl mx-auto leading-relaxed mb-12">
            Not a generic AI assistant. Not a Telegram bot with a GPT wrapper.
            A full economic actor — holds a wallet, reads Chainlink oracles vs DEX pools,
            surfaces asymmetric arbitrage on Robinhood Chain, and settles every trade
            with your own signature. Non-custodial by default.
          </p>

          {/* Stats row */}
          <div className="inline-grid grid-cols-4 gap-px bg-[#1A1A2E] rounded-2xl overflow-hidden border border-[#1A1A2E] mb-12">
            {STATS.map((s) => (
              <div key={s.label} className="bg-[#0d0d12] px-8 py-5 text-center">
                <div className="font-mono text-2xl font-bold mb-1" style={{ color: s.color }}>{s.value}</div>
                <div className="font-mono text-[10px] text-slate-600 tracking-widest">{s.label.toUpperCase()}</div>
              </div>
            ))}
          </div>

          <div className="flex items-center justify-center gap-4">
            <Link href="/app/chat"
              className="px-6 py-3 rounded-xl font-mono text-sm font-bold transition-all hover:opacity-90"
              style={{ background: "linear-gradient(135deg, #4FC3F7, #29ABE2)", color: "#050508", boxShadow: "0 0 24px #4FC3F730" }}>
              Launch App →
            </Link>
            <Link href="/hub"
              className="px-6 py-3 rounded-xl font-mono text-sm border border-[#2a2a3e] text-slate-400 hover:text-white hover:border-[#4FC3F740] transition-all">
              Explore Hub
            </Link>
          </div>
        </section>

        {/* ══ STORY ════════════════════════════════════════════════════════════ */}
        <section className="max-w-3xl mx-auto px-6 py-20 border-t border-[#1A1A2E]">
          <div className="text-center mb-12">
            <SectionLabel>Our Story</SectionLabel>
            <h2 className="text-3xl font-bold">Why Blue Agent exists</h2>
          </div>

          <div className="space-y-6 text-slate-400 leading-relaxed text-base">
            <p>
              Blue Agent started as a Telegram bot — a simple idea to bring AI
              and onchain actions together on Base. It outgrew the chat window.
              So we rebuilt it from scratch, web-native, on Base. Since March 2026,
              it&apos;s grown into the onchain Agent OS.
            </p>
            <p>
              AI tools should work like onchain transactions — instant, composable, paid exactly for what you use.
              No subscriptions. No monthly seats. No middlemen taking 70%.
              x402 makes that possible: one HTTP header, one USDC micropayment, one tool call.
            </p>
            <p>
              We built Blue Hub around that primitive — {TOOL_COUNT} tools covering everything a Base builder needs:
              token analysis, security audits, launch simulation, grant discovery, DeFi yield, whale signals.
              Every tool is a live API endpoint. Agents and developers call them directly, pay in USDC, get structured data back.
            </p>
            <p>
              Blue Chat layers on top — a multi-model AI interface where your wallet is your identity.
              Every tool call settles as an x402 micropayment: no subscription, no seats, pay only for
              what you run. Value flows to the builders behind each tool, and the loop closes onchain.
            </p>
            <p className="text-slate-300">
              MCP makes the whole stack agent-native: 57 tools plug directly into Claude Desktop and Cursor,
              no API key, no setup. The same tools that power Blue Chat run inside your IDE.
              One platform. Three surfaces. Built on Base.
            </p>
          </div>
        </section>

        {/* ══ THREE SURFACES ═══════════════════════════════════════════════════ */}
        <section className="max-w-5xl mx-auto px-6 py-20 border-t border-[#1A1A2E]">
          <div className="text-center mb-14">
            <SectionLabel>Three Surfaces</SectionLabel>
            <h2 className="text-3xl font-bold">One agent, three ways to access</h2>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {SURFACES.map((s) => (
              <div key={s.name}
                className="rounded-2xl border border-[#1A1A2E] bg-[#0d0d12] p-6 flex flex-col"
                style={{ boxShadow: `0 0 40px ${s.color}06` }}>

                <div className="flex items-center gap-3 mb-4">
                  <div className="w-10 h-10 rounded-xl flex items-center justify-center text-xl"
                    style={{ background: `${s.color}12`, border: `1px solid ${s.color}25` }}>
                    {s.icon}
                  </div>
                  <div>
                    <div className="font-bold text-white text-sm">{s.name}</div>
                    <div className="font-mono text-[10px]" style={{ color: s.color }}>{s.handle}</div>
                  </div>
                </div>

                <p className="text-slate-500 text-sm leading-relaxed flex-1 mb-5">{s.desc}</p>

                <div className="flex gap-3 mb-5">
                  {s.stats.map(st => (
                    <div key={st.label} className="flex-1 rounded-lg bg-[#0a0a0f] border border-[#1A1A2E] px-3 py-2 text-center">
                      <div className="font-mono text-sm font-bold text-white">{st.value}</div>
                      <div className="font-mono text-[9px] text-slate-600 mt-0.5">{st.label.toUpperCase()}</div>
                    </div>
                  ))}
                </div>

                <Link href={s.link}
                  className="font-mono text-xs font-bold transition-all hover:opacity-80 text-center py-2.5 rounded-xl border"
                  style={{ color: s.color, borderColor: `${s.color}30`, background: `${s.color}08` }}>
                  {s.linkLabel}
                </Link>
              </div>
            ))}
          </div>
        </section>

        {/* ══ TOKEN section removed 2026-08 — token-hold / stake-to-earn narrative
            retired from marketing; positioning is non-custodial Agent OS + x402
            pay-per-call. $BLUEAGENT still exists on Base but is no longer a
            marketing surface here. ══════════════════════════════════════════ */}

        {/* ══ ROADMAP ═══════════════════════════════════════════════════════════ */}
        <section className="max-w-3xl mx-auto px-6 py-20 border-t border-[#1A1A2E]">
          <div className="text-center mb-14">
            <SectionLabel>Roadmap</SectionLabel>
            <h2 className="text-3xl font-bold">Where we&apos;ve been, where we&apos;re going</h2>
          </div>

          <div className="space-y-8">
            {ROADMAP.map((era) => {
              const statusColor = era.status === "done" ? "#22C55E" : era.status === "building" ? "#4FC3F7" : "#475569";
              const statusLabel = era.status === "done" ? "DONE" : era.status === "building" ? "BUILDING" : "PLANNED";
              return (
                <div key={era.period} className="flex gap-6">
                  {/* Timeline line */}
                  <div className="flex flex-col items-center">
                    <div className="w-2.5 h-2.5 rounded-full mt-1.5 shrink-0"
                      style={{ background: statusColor, boxShadow: era.status !== "planned" ? `0 0 8px ${statusColor}` : "none" }} />
                    <div className="w-px flex-1 mt-2" style={{ background: `${statusColor}30` }} />
                  </div>
                  {/* Content */}
                  <div className="pb-4 flex-1">
                    <div className="flex items-center gap-3 mb-3">
                      <span className="font-bold text-white">{era.period}</span>
                      <span className="font-mono text-[10px] px-2 py-0.5 rounded tracking-widest"
                        style={{ color: statusColor, background: `${statusColor}15`, border: `1px solid ${statusColor}30` }}>
                        {statusLabel}
                      </span>
                    </div>
                    <div className="space-y-2">
                      {era.items.map((item, i) => (
                        <div key={i} className="flex items-start gap-2.5">
                          <span className="text-sm mt-0.5">{item.done ? "✅" : era.status === "building" ? "🔄" : "📋"}</span>
                          <span className={`text-sm leading-relaxed ${item.done ? "text-slate-400" : era.status === "building" ? "text-white" : "text-slate-600"}`}>
                            {item.text}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* ══ CTA ══════════════════════════════════════════════════════════════ */}
        <section className="max-w-5xl mx-auto px-6 py-20 border-t border-[#1A1A2E]">
          <div className="rounded-2xl border border-[#4FC3F720] bg-[#4FC3F705] p-12 text-center"
            style={{ boxShadow: "0 0 60px #4FC3F708" }}>
            <h2 className="text-3xl font-bold mb-4">Ready to trade Robinhood Chain?</h2>
            <p className="text-slate-500 mb-8 max-w-md mx-auto">
              {TOOL_COUNT} AI tools. 5 core commands. Blue Hood copilot 24/7. Non-custodial. RH + Base.
            </p>
            <div className="flex items-center justify-center gap-4 flex-wrap">
              <Link href="/app/chat"
                className="px-8 py-3.5 rounded-xl font-mono text-sm font-bold transition-all hover:opacity-90"
                style={{ background: "linear-gradient(135deg, #4FC3F7, #29ABE2)", color: "#050508", boxShadow: "0 0 24px #4FC3F730" }}>
                Launch App →
              </Link>
              <Link href="/hub"
                className="px-8 py-3.5 rounded-xl font-mono text-sm border border-[#2a2a3e] text-slate-400 hover:text-white hover:border-[#4FC3F740] transition-all">
                Explore Hub
              </Link>
              <Link href="/app/hood"
                className="px-8 py-3.5 rounded-xl font-mono text-sm border border-[#34D399]/30 text-[#34D399] hover:bg-[#34D399]/10 transition-all">
                Open Blue Hood →
              </Link>
            </div>
          </div>
        </section>

      </div>
    </div>
  );
}
