"use client";

import { useState } from "react";
import Link from "next/link";
import Navbar from "@/components/Navbar";

// ─── Data ─────────────────────────────────────────────────────────────────────

const SOUL_SECTIONS = [
  {
    id: "identity",
    label: "Identity",
    sub: "Who Blue Agent is",
    content: [
      { k: "name",     v: "Blue Agent" },
      { k: "role",     v: "The onchain Agent OS" },
      { k: "chains",   v: "Robinhood Chain (4663) — flagship · Base (8453) — secondary" },
      { k: "built by", v: "Blocky Studio — @madebyshun" },
      { k: "token",    v: "$BLUEAGENT · 0xf895783b2931c919955e18b5e3343e7c7c456ba3 (Base)" },
    ],
  },
  {
    id: "values",
    label: "Core Values",
    sub: "5 principles",
    content: [
      { k: "01", v: "Ship over talk — always push toward action. Concrete > abstract." },
      { k: "02", v: "RH-native by default — every RWA answer written for Robinhood Chain, not mainnet." },
      { k: "03", v: "Honest over comfortable — give the real answer, not the soft one." },
      { k: "04", v: "Builder-first — assume the user knows what they're doing." },
      { k: "05", v: "Composable — prefer open standards, x402 payments, and non-custodial signing." },
    ],
  },
  {
    id: "tone",
    label: "Communication",
    sub: "Tone + phrases",
    content: [
      { k: "says",       v: "\"Here's what I'd do…\" · \"The real risk here is…\" · \"Skip X. Do Y instead.\"" },
      { k: "never says", v: "\"Certainly!\" · \"Great question!\" · \"Happy to help!\" · \"As an AI language model…\"" },
      { k: "style",      v: "Sharp, direct, opinionated. Concise — leads with the answer, not the context." },
    ],
  },
  {
    id: "decisions",
    label: "Decision Rules",
    sub: "How Blue Agent chooses",
    content: [
      { k: "uncertain", v: "Pick the option that ships faster → more non-custodial → less attack surface" },
      { k: "chains",    v: "RWA answers on Robinhood Chain (4663). Base (8453) for token launches. Never suggest ETH L1 as default." },
      { k: "addresses", v: "Only provide verified addresses from skills/base-addresses.md or Rialto/Arcus registries. Never guess." },
    ],
  },
  {
    id: "limits",
    label: "Hard Limits",
    sub: "What Blue Agent won't do",
    content: [
      { k: "✕", v: "Never invent contract addresses" },
      { k: "✕", v: "Never suggest Ethereum L1 over Robinhood Chain or Base" },
      { k: "✕", v: "Never call OpenAI / Anthropic directly — route via Virtuals AI or the internal LLM gateway" },
      { k: "✕", v: "Never give investment advice or price predictions" },
      { k: "✕", v: "Never claim to execute transactions — user signs all onchain actions" },
      { k: "✕", v: "Never hold a private key or delegate a session key without explicit review-and-sign" },
    ],
  },
];

// Aeon Skills removed 2026-08 — the aeon-* trading/research skill set is no
// longer surfaced here. This page now centers on SOUL.md (the forkable agent
// identity) + how skills fire. The grounding-file catalog lives at /docs/skills.

// ─── Components ───────────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="inline-flex items-center gap-2 mb-6">
      <div className="h-px w-8 bg-[#4FC3F740]" />
      <span className="font-mono text-[11px] text-[#4FC3F7] tracking-[0.2em] uppercase">{children}</span>
      <div className="h-px w-8 bg-[#4FC3F740]" />
    </div>
  );
}

function CopyBtn({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      className="font-mono text-[10px] px-2 py-1 rounded border border-[#1A1A2E] text-slate-600 hover:text-white hover:border-slate-600 transition-all"
    >
      {copied ? "✓ copied" : label}
    </button>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

// /soul — the public SOUL.md page: agent identity, values, tone, hard limits.
//
// Lived at /skills until 2026-08. Renamed because "Skills" now unambiguously
// means the installed agent-skill catalog in the app shell (/skills →
// src/app/app/skills), and this page never described those — it's the
// personality config. Two pages on one path also broke localhost + Vercel
// preview, where marketing and app share a single origin and this route shadowed
// the catalog. /skills on the main host 301s here (see middleware).
export default function SoulPage() {
  const [openSection, setOpenSection] = useState<string | null>("identity");

  return (
    <div className="min-h-screen bg-[#050508] text-white">
      <Navbar />

      {/* Ambient glow */}
      <div className="fixed inset-x-0 top-0 h-[600px] pointer-events-none overflow-hidden">
        <div style={{ background: "radial-gradient(ellipse 70% 40% at 50% -5%, #4FC3F714 0%, transparent 70%)" }} className="absolute inset-0" />
      </div>

      <div className="relative">

        {/* ══ HERO ══════════════════════════════════════════════════════════════ */}
        <section className="max-w-5xl mx-auto px-6 pt-32 pb-20 text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-[#4FC3F730] bg-[#4FC3F708] mb-8">
            <span className="w-1.5 h-1.5 rounded-full bg-[#4FC3F7] animate-pulse" />
            <span className="font-mono text-[11px] text-[#4FC3F7] tracking-widest">SOUL.md · OPEN SOURCE · MIT</span>
          </div>

          <h1 className="text-5xl sm:text-6xl font-bold tracking-tight mb-6 leading-tight">
            Agent<br />
            <span className="text-[#4FC3F7]">Soul</span>
          </h1>

          <p className="text-slate-400 text-lg max-w-2xl mx-auto leading-relaxed mb-12">
            SOUL.md defines who Blue Agent is — its identity, values, tone, and hard limits.
            Open source, forkable, and loadable into any MCP-compatible agent session.
          </p>

          <div className="inline-grid grid-cols-3 gap-px bg-[#1A1A2E] rounded-2xl overflow-hidden border border-[#1A1A2E] mb-12">
            {[
              { value: "5",   label: "Values",  color: "#4FC3F7" },
              { value: "MIT", label: "License", color: "#34D399" },
              { value: "MCP", label: "Native",  color: "#2563EB" },
            ].map((s) => (
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
              Try in Blue Chat →
            </Link>
            <a href="https://github.com/madebyshun/blue-agent" target="_blank" rel="noopener noreferrer"
              className="px-6 py-3 rounded-xl font-mono text-sm border border-[#2a2a3e] text-slate-400 hover:text-white hover:border-[#4FC3F740] transition-all">
              GitHub →
            </a>
          </div>
        </section>

        {/* ══ SOUL.md ═══════════════════════════════════════════════════════════ */}
        <section className="max-w-5xl mx-auto px-6 py-20 border-t border-[#1A1A2E]">
          <div className="text-center mb-14">
            <SectionLabel>Identity</SectionLabel>
            <h2 className="text-3xl font-bold">SOUL.md</h2>
            <p className="text-slate-500 mt-3 text-sm max-w-xl mx-auto">
              Personality config — who Blue Agent is, how it thinks, what it won't do. Fork it to create your own agent.
            </p>
          </div>

          {/* File card with accordion */}
          <div className="rounded-2xl border border-[#1A1A2E] bg-[#0d0d12] overflow-hidden mb-8">
            <div className="flex items-center justify-between px-5 py-4 border-b border-[#1A1A2E] bg-[#0a0a0f]">
              <div className="flex items-center gap-3">
                <div className="flex gap-1.5">
                  <div className="w-2.5 h-2.5 rounded-full bg-red-500/50" />
                  <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/50" />
                  <div className="w-2.5 h-2.5 rounded-full bg-green-500/50" />
                </div>
                <span className="font-mono text-sm text-white">SOUL.md</span>
                <span className="font-mono text-[10px] text-slate-700 border border-[#1A1A2E] px-1.5 py-0.5 rounded">v0.1.0</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="font-mono text-[9px] px-1.5 py-0.5 border border-[#4FC3F7]/30 text-[#4FC3F7] rounded">FORKABLE</span>
                <CopyBtn text="https://raw.githubusercontent.com/madebyshun/blue-agent/main/SOUL.md" label="Copy raw" />
                <a href="https://github.com/madebyshun/blue-agent/blob/main/SOUL.md"
                  target="_blank" rel="noopener noreferrer"
                  className="font-mono text-[10px] px-2 py-1 rounded border text-[#4FC3F7] border-[#4FC3F7]/30 hover:bg-[#4FC3F7]/5 transition-all">
                  GitHub →
                </a>
              </div>
            </div>

            {SOUL_SECTIONS.map((sec) => (
              <div key={sec.id} className="border-b border-[#1A1A2E] last:border-0">
                <button
                  onClick={() => setOpenSection(openSection === sec.id ? null : sec.id)}
                  className="w-full flex items-center justify-between px-6 py-4 hover:bg-[#0a0a0f] transition-colors group"
                >
                  <div className="text-left">
                    <span className="font-mono text-sm text-white group-hover:text-[#4FC3F7] transition-colors">
                      ## {sec.label}
                    </span>
                    <span className="font-mono text-[10px] text-slate-600 ml-3">{sec.sub}</span>
                  </div>
                  <svg className={`w-3.5 h-3.5 text-slate-600 transition-transform shrink-0 ${openSection === sec.id ? "rotate-180" : ""}`}
                    fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {openSection === sec.id && (
                  <div className="px-6 pb-5 pt-1 space-y-2.5">
                    {sec.content.map((row) => (
                      <div key={row.k} className="flex gap-4 items-baseline">
                        <span className={`font-mono text-[11px] shrink-0 w-20 ${row.k === "✕" ? "text-red-400" : "text-slate-600"}`}>
                          {row.k}
                        </span>
                        <span className="font-mono text-sm text-slate-300 leading-relaxed">{row.v}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Fork in 3 steps */}
          <div className="grid sm:grid-cols-3 gap-4">
            {[
              { step: "01", label: "Clone",       cmd: "git clone github.com/madebyshun/blue-agent", desc: "Get the full repo with all skill files" },
              { step: "02", label: "Edit SOUL.md", cmd: "nano SOUL.md",                               desc: "Update identity, values, hard limits" },
              { step: "03", label: "Load",         cmd: "blueagent mcp add ./SOUL.md",                desc: "Load into any MCP-compatible client (Claude, Cursor)" },
            ].map((s) => (
              <div key={s.step} className="rounded-2xl border border-[#1A1A2E] bg-[#0d0d12] p-5">
                <div className="font-mono text-[10px] text-[#4FC3F7] mb-2">{s.step}</div>
                <div className="font-bold text-white text-sm mb-1">{s.label}</div>
                <div className="font-mono text-[11px] text-slate-600 mb-3 leading-relaxed">{s.desc}</div>
                <div className="font-mono text-[10px] text-[#a78bfa] bg-[#050508] border border-[#1A1A2E] rounded-lg px-3 py-2 truncate">
                  $ {s.cmd}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* AEON SKILLS section removed 2026-08 — the aeon-* skill set is no longer
            surfaced here. Grounding-file catalog lives at /docs/skills. */}

        {/* ══ HOW SKILLS WORK ═══════════════════════════════════════════════════ */}
        <section className="max-w-5xl mx-auto px-6 py-20 border-t border-[#1A1A2E]">
          <div className="text-center mb-14">
            <SectionLabel>How it works</SectionLabel>
            <h2 className="text-3xl font-bold">Trigger → Parse → Output</h2>
            <p className="text-slate-500 mt-3 text-sm max-w-xl mx-auto">
              Skills are read-to-apply markdown files. No plugins, no CLI — they load into the
              agent&apos;s context inside Blue Chat and any MCP client.
            </p>
          </div>

          <div className="grid sm:grid-cols-3 gap-4 mb-12">
            {[
              { step: "01", title: "Trigger", icon: "💬", desc: "User types a matching phrase — e.g. \"DD on this token\" or \"is there an arb on NVDA\"", color: "#4FC3F7" },
              { step: "02", title: "Parse",   icon: "⚙️", desc: "Blue Agent reads the skill .md file and applies its grounding rules and output format", color: "#A78BFA" },
              { step: "03", title: "Output",  icon: "📊", desc: "Structured signal — source-attributed, falsifiable, no hallucinated data or addresses", color: "#34D399" },
            ].map((s) => (
              <div key={s.step} className="rounded-2xl border border-[#1A1A2E] bg-[#0d0d12] p-6 text-center">
                <div className="w-12 h-12 rounded-2xl flex items-center justify-center text-2xl mx-auto mb-4"
                  style={{ background: `${s.color}12`, border: `1px solid ${s.color}25` }}>
                  {s.icon}
                </div>
                <div className="font-mono text-[10px] mb-2" style={{ color: s.color }}>{s.step}</div>
                <div className="font-bold text-white mb-2">{s.title}</div>
                <div className="font-mono text-[11px] text-slate-600 leading-relaxed">{s.desc}</div>
              </div>
            ))}
          </div>

          {/* Install command */}
          <div className="rounded-2xl border border-[#1A1A2E] bg-[#0d0d12] overflow-hidden">
            <div className="flex items-center gap-2 px-5 py-3.5 border-b border-[#1A1A2E] bg-[#0a0a0f]">
              <div className="flex gap-1.5">
                <div className="w-2.5 h-2.5 rounded-full bg-red-500/50" />
                <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/50" />
                <div className="w-2.5 h-2.5 rounded-full bg-green-500/50" />
              </div>
              <span className="font-mono text-xs text-slate-600 ml-1">terminal</span>
            </div>
            <div className="p-5 space-y-2 font-mono text-sm">
              <div><span className="text-slate-600"># connect Blue Agent to any MCP client</span></div>
              <div><span className="text-slate-600">$ </span><span className="text-[#4FC3F7]">claude mcp add --transport http blueagent https://blueagent.dev/api/mcp</span></div>
              <div className="pt-2"><span className="text-slate-600"># SOUL.md + skills load automatically — no API key</span></div>
              <div><span className="text-slate-600">$ </span><span className="text-white">claude</span><span className="text-slate-500"> → ask &quot;is there an arb on NVDA&quot;</span></div>
            </div>
          </div>
        </section>

        {/* ══ CTA ══════════════════════════════════════════════════════════════ */}
        <section className="max-w-5xl mx-auto px-6 py-20 border-t border-[#1A1A2E]">
          <div className="rounded-2xl border border-[#4FC3F720] bg-[#4FC3F705] p-12 text-center"
            style={{ boxShadow: "0 0 60px #4FC3F708" }}>
            <h2 className="text-3xl font-bold mb-4">Try the skills in Blue Chat</h2>
            <p className="text-slate-500 mb-8 max-w-md mx-auto text-sm leading-relaxed">
              SOUL.md and the agent&apos;s grounding skills are pre-loaded. Type any trigger phrase and the agent responds with structured, grounded signal.
            </p>
            <div className="flex items-center justify-center gap-4 flex-wrap">
              <Link href="/app/chat"
                className="px-8 py-3.5 rounded-xl font-mono text-sm font-bold transition-all hover:opacity-90"
                style={{ background: "linear-gradient(135deg, #4FC3F7, #29ABE2)", color: "#050508", boxShadow: "0 0 24px #4FC3F730" }}>
                Launch App →
              </Link>
              <a href="https://github.com/madebyshun/blue-agent" target="_blank" rel="noopener noreferrer"
                className="px-8 py-3.5 rounded-xl font-mono text-sm border border-[#2a2a3e] text-slate-400 hover:text-white hover:border-[#4FC3F740] transition-all">
                Fork on GitHub →
              </a>
              <Link href="/docs"
                className="px-8 py-3.5 rounded-xl font-mono text-sm border border-[#2a2a3e] text-slate-400 hover:text-white hover:border-[#4FC3F740] transition-all">
                Read Docs →
              </Link>
            </div>
          </div>
        </section>

      </div>
    </div>
  );
}
