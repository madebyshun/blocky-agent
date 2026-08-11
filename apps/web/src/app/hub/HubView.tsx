"use client";

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import Link from "next/link";
import Navbar from "@/components/Navbar";
import { AGENT_TOOLS } from "@/lib/agent-tools";
import { useAccount, useSignTypedData, useReadContract, useChainId, useSwitchChain } from "wagmi";
import { ConnectButton } from "@/components/ConnectModal";
import AppPageHeader from "@/components/app/AppPageHeader";
import HubHome from "./_components/HubHome";
import SubmitTool from "./_components/SubmitTool";
import DashboardView from "./_components/DashboardView";
import MarkdownOutput from "@/components/MarkdownOutput";

const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const ERC20_BAL_ABI = [{
  name: "balanceOf", type: "function", stateMutability: "view",
  inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }],
}] as const;

// ─── Tool registry ──────────────────────────────────────────────────────────

type Agent = "blue" | "aeon" | "miroshark";
type Category = "all" | "intelligence" | "builder" | "trading" | "content" | "agent-economy" | "base-ecosystem" | "on-chain";

// v2 marketplace filters (sidebar-driven, applied to the unified grid).
// Hosted tools (AI-tool / API-wrapper) are hidden from the marketplace for now —
// the backend (hub-hosted.ts + /api/hub/community/*) is kept for a later phase.
// The grid shows Native + live External only.
type SourceFilter = "all" | "native" | "external";
type PriceFilter  = "all" | "free" | "under" | "over";

// Parse a "$0.05" price string → number (community tools may carry raw values).
function priceNum(p: string): number { return parseFloat((p || "").replace(/[^0-9.]/g, "")) || 0; }
function matchPrice(f: PriceFilter, n: number): boolean {
  if (f === "all")  return true;
  if (f === "free") return n === 0;
  if (f === "under") return n > 0 && n < 0.5;
  return n >= 0.5; // "over"
}
const SOURCE_CHIPS: { key: SourceFilter; label: string; color: string }[] = [
  { key: "all",      label: "All",         color: "#94A3B8" },
  { key: "native",   label: "🔵 Native",   color: "#4FC3F7" },
  { key: "external", label: "🌐 External", color: "#34D399" },
];
const PRICE_CHIPS: { key: PriceFilter; label: string }[] = [
  { key: "all",   label: "Any"     },
  { key: "free",  label: "Free"    },
  { key: "under", label: "< $0.50" },
  { key: "over",  label: "$0.50+"  },
];
interface ToolInput { key: string; label: string; placeholder: string; required?: boolean; example?: string; }
interface Tool {
  id: string; name: string; cat: Category; price: string;
  agents: Agent[]; desc: string; inputs: ToolInput[]; featured?: boolean;
  x402Url?: string;
  x402Body?: (values: Record<string, string>) => Record<string, unknown>;
  // v2 marketplace metadata (defaulted via withV2Defaults in agent-tools.ts)
  verified?:       boolean;
  aiReady?:        boolean;
  builderAddress?: string;
  releasedAt?:    number;
  // Phase 3 — community-submitted tools: when set, ToolRunner POSTs here
  // instead of /api/x402/[id]. Hub registry proxy → builder's endpoint.
  callPath?:       string;
  // v2 marketplace: provenance + denormalized stats for the unified grid.
  source?:         "native" | "external" | "hosted";
  status?:         "live";   // external tools auto-live after x402 probe; grid shows live only
  creatorHandle?:  string;   // "@handle" or brand shown as "by …" on community cards
  logoUrl?:        string;   // creator-supplied logo (public) shown on the tool card
  callCount?:      number;   // lifetime paid runs (community tools carry this from KV)
  // Hosted tools invoke asynchronously (202 + job poll) — see ToolRunner.run().
  async?:          boolean;
}

const FEATURED_IDS = ["launch-simulator-1", "investor-memo", "market-fit", "token-launch-readiness"];

// ─── Example inputs per tool ──────────────────────────────────────────────────
// Keys must exactly match input.key fields in agent-tools.ts
const TOOL_EXAMPLES: Record<string, Record<string, string>> = {
  // ── Intelligence ─────────────────────────────────────────────────────────────
  "token-pick-signal":         { context: "rising volume, real liquidity" },
  "narrative-position":        { focus: "AI agents, Base DeFi" },
  "ecosystem-digest":          { focus: "DeFi protocols and AI agents" },
  "market-fit":                { description: "Pay-per-use AI research tool for Base builders — $0.50/report via x402 USDC micropayments", stage: "MVP" },
  "token-launch-readiness":    { name: "BLUEAI", description: "AI agent tooling on Base — 40 live tools, 200 weekly users, $2k MRR, community of 500 builders" },
  // ── Builder ───────────────────────────────────────────────────────────────────
  "roadmap-validator":         { project: "x402 AI tool marketplace on Base", roadmap: "Q1: 10 tools, Q2: open marketplace, Q3: agent registry, Q4: Tool NFTs" },
  "competitor-scan":           { project: "AI agent tool marketplace with x402 pay-per-call", category: "AI agent infrastructure" },
  "pitch-intelligence":        { project: "Blue Agent", description: "40 pay-per-use AI tools for Base builders via x402 micropayments. $2k MRR, 200 weekly users, raising $750k pre-seed." },
  "fundraise-timing":          { project: "x402 pay-per-call AI tool marketplace", stage: "pre-seed · 40 tools live · 200 weekly users · $2k MRR" },
  "gtm-brief":                 { project: "Blue Agent Hub", description: "40 AI tools for Base builders, pay per call in USDC, no signup", target: "Base builders, DeFi devs, AI agent teams" },
  "stack-recommender":         { project_type: "Multi-agent x402 tool marketplace on Base mainnet with USDC micropayments", constraints: "TypeScript, Next.js, solo dev" },
  "investor-memo":             { project: "Blue Agent", description: "40 pay-per-use AI tools for Base builders via x402 micropayments", ask: "$750k pre-seed" },
  "agent-performance":         { handle: "@blueagent_" },
  "agent-collab-match":        { agent_a: "Blue Agent — AI research + x402 tool execution on Base", agent_b: "any", collab_goal: "joint tool bundle or revenue share" },
  "repo-health":               { repo: "madebyshun/blue-agent" },
  "community-sentiment":       { project: "Base", channels: "@base Twitter, Base Discord, base.mirror.xyz" },
  "defi-opportunity":          { focus: "stablecoin yield above 8% APR on Base", risk_tolerance: "medium" },
  "builder-deep-dd":           { target: "@madebyshun" },
  // ── Launch Simulator (3 tiers) ────────────────────────────────────────────────
  "launch-simulator-1":        { project: "BlueAI", description: "AI agent tooling on Base — 69 live tools, 500 weekly users, $5k MRR, pre-launch", ticker: "$BLUEAI" },
  "launch-simulator-2":        { project: "BlueAI", description: "AI agent tooling on Base — 69 live tools, 500 weekly users, $5k MRR, pre-launch", ticker: "$BLUEAI", contract: "0xf895783b2931c919955e18b5e3343e7c7c456ba3" },
  "launch-simulator-3":        { project: "BlueAI", description: "AI agent tooling on Base — 69 live tools, 500 weekly users, $5k MRR, pre-launch", ticker: "$BLUEAI", contract: "0xf895783b2931c919955e18b5e3343e7c7c456ba3" },
  // ── Trading ───────────────────────────────────────────────────────────────────
  "whale-copy-signal":         { wallet: "", token: "WETH" },
  "token-momentum-scanner":    { timeframe: "24h", filter: "min $50k volume, AI agent narrative" },
  // ── Content ───────────────────────────────────────────────────────────────────
  "thread-intelligence":       { topic: "x402 pay-per-call changes how agents monetize on Base", angle: "alpha drop — explain the pattern, why it matters for agent builders" },
  "community-growth-playbook": { project: "Blue Agent", current_size: "500 Telegram members, 2k Twitter followers" },
  // ── Agent Economy ─────────────────────────────────────────────────────────────
  "multi-agent-workflow":      { goal: "Research top 5 AI agent tokens on Base and generate a buy/sell signal", agents: "Blue Agent, Aeon, MiroShark" },
  // ── Base Ecosystem ────────────────────────────────────────────────────────────
  "base-grant-finder":         { project: "AI tool marketplace with x402 pay-per-call micropayments on Base", stage: "MVP — live product with 200 weekly users" },
  "base-protocol-comparison":  { protocol_a: "Aerodrome", protocol_b: "Uniswap v4", use_case: "liquidity pool for BLUEAGENT/ETH pair" },
  // ── On-chain ─────────────────────────────────────────────────────────────────
  "protocol-risk-monitor":     { protocol: "Aerodrome Finance", position: "ETH/USDC LP — $5k deployed" },
  "contract-trust":            { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", context: "USDC token on Base" },
  // ── Console commands ──────────────────────────────────────────────────────────
  "blue-idea":  { prompt: "gasless USDC tipping app for Base builders — reward good code reviews" },
  "blue-build": { prompt: "x402 pay-per-call AI tool marketplace on Base with USDC micropayments" },
  "blue-audit": { prompt: "ERC20 token with staking and revenue share — check for reentrancy and access control issues" },
  "blue-ship":  { prompt: "Base mainnet launch of BLUEAGENT token with Uniswap v4 pool" },
  "blue-raise": { prompt: "AI agent tool marketplace on Base — 40 tools, $2k MRR, raising $750k pre-seed" },
  // ── Security ──────────────────────────────────────────────────────────────────
  "honeypot-check":  { token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
  "risk-gate":       { action: "buy token on Uniswap", contractAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount: "$50" },
  "deep-analysis":   { token: "0xf895783b2931c919955e18b5e3343e7c7c456ba3" },
  "agent-score":     { handle: "@blueagent_" },
  // ── Quantum ───────────────────────────────────────────────────────────────────
  "key-exposure":    { address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" },
  // ── On-chain Data ─────────────────────────────────────────────────────────────
  "aml-screen":      { address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" },
  "airdrop-check":   { address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" },
  "whale-tracker":   { token: "0xf895783b2931c919955e18b5e3343e7c7c456ba3" },
  "dex-flow":        { token: "0xf895783b2931c919955e18b5e3343e7c7c456ba3" },
  // ── Earn ──────────────────────────────────────────────────────────────────────
  "lp-analyzer":     { pool: "WETH/USDC 0.05%", position: "$5000 deployed" },
  // ── Alerts ────────────────────────────────────────────────────────────────────
  // ── Launch (extended) ─────────────────────────────────────────────────────────
  "grant-evaluator":    { project: "Blue Agent", description: "64 pay-per-use AI tools for Base builders via x402 micropayments. 500 weekly users, $5k MRR.", ask: "$50k" },
};

// Derive TOOLS from AGENT_TOOLS — single source of truth
const TOOLS: Tool[] = AGENT_TOOLS.map(t => ({
  id:     t.id,
  name:   t.name,
  cat:    t.category as Exclude<Category, "all">,
  price:  t.price ?? "",
  // Blue is the only real first-party provider. (Aeon / MiroShark were
  // display-only placeholders — removed to keep provider data honest.)
  agents: ["blue"] as Agent[],
  desc:   t.description,
  inputs: t.inputs,
  verified:       t.verified,
  aiReady:        t.aiReady,
  builderAddress: t.builderAddress,
  releasedAt:    t.releasedAt,
  x402Url:  t.x402Url,
  x402Body: t.x402Body,
  source:   "native",
}));

const CATEGORIES: { key: Category; label: string }[] = [
  { key: "all",           label: "All" },
  { key: "intelligence",  label: "Intelligence" },
  { key: "builder",       label: "Builder" },
  { key: "trading",       label: "Trading" },
  { key: "content",       label: "Content" },
  { key: "agent-economy", label: "Agent Economy" },
  { key: "base-ecosystem",label: "Base Ecosystem" },
  { key: "on-chain",      label: "On-chain" },
];

const AGENT_COLORS: Record<Agent, string> = {
  blue:      "#4FC3F7",
  aeon:      "#A78BFA",
  miroshark: "#34D399",
};
const AGENT_LABELS: Record<Agent, string> = {
  blue:      "Blue",
  aeon:      "Aeon",
  miroshark: "MiroShark",
};

// ─── Result renderer ─────────────────────────────────────────────────────────

const VERDICT_COLORS: Record<string, string> = {
  GO: "#34D399", BUY: "#34D399", SAFE: "#34D399", BULL: "#34D399",
  WAIT: "#FACC15", WATCH: "#FACC15", NEUTRAL: "#FACC15",
  PIVOT: "#FB923C", REDUCE: "#FB923C",
  NO_PICK: "#6B6B7E", SKIP: "#6B6B7E",
  CRITICAL: "#F87171", HIGH: "#F87171", SELL: "#F87171",
};

function stanceColor(s: string): string {
  const u = s.toUpperCase();
  return VERDICT_COLORS[u] ?? "#C8C8D0";
}

function VerdictBadge({ value }: { value: string }) {
  const color = VERDICT_COLORS[value.toUpperCase()] ?? "#6B6B7E";
  return (
    <span className="inline-block px-3 py-1 rounded-full text-sm font-bold font-mono" style={{ color, background: color + "15", border: `1px solid ${color}40` }}>
      {value}
    </span>
  );
}

function ScoreBar({ value, max = 100 }: { value: number; max?: number }) {
  const pct = Math.min(100, (value / max) * 100);
  const color = pct >= 70 ? "#34D399" : pct >= 45 ? "#FACC15" : "#F87171";
  return (
    <div className="flex items-center gap-3">
      <span className="font-mono text-xl font-bold" style={{ color }}>{value}</span>
      <div className="flex-1 h-1.5 bg-[#1A1A2E] rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="font-mono text-[10px] text-slate-600">/{max}</span>
    </div>
  );
}

function StringList({ items, color }: { items: string[]; color?: string }) {
  return (
    <ul className="space-y-1.5 mt-1">
      {items.map((s, i) => (
        <li key={i} className="flex gap-2 text-xs">
          <span style={{ color: color ?? "#4FC3F7" }} className="shrink-0 mt-0.5">›</span>
          <span className="text-slate-300 leading-relaxed">{s}</span>
        </li>
      ))}
    </ul>
  );
}

function PersonaCards({ personas }: { personas: Record<string, { stance: string; weight: number; rationale: string }> }) {
  return (
    <div className="grid grid-cols-2 gap-2 mt-1">
      {Object.entries(personas).map(([name, p]) => (
        <div key={name} className="border border-[#1A1A2E] rounded-lg p-2.5">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] font-mono text-slate-500 uppercase tracking-wider">{name}</span>
            <span className="text-[10px] font-mono font-bold" style={{ color: stanceColor(p.stance) }}>{p.stance.toUpperCase()}</span>
          </div>
          <p className="text-[10px] text-slate-500 leading-relaxed">{p.rationale}</p>
          <p className="text-[10px] text-slate-700 mt-1">weight: {p.weight}x</p>
        </div>
      ))}
    </div>
  );
}

function ChecklistItems({ items }: { items: { item: string; status: string; category?: string }[] }) {
  const statusIcon = (s: string) => s === "done" ? "✓" : s === "critical" ? "!" : "○";
  const statusColor = (s: string) => s === "done" ? "#34D399" : s === "critical" ? "#F87171" : "#FACC15";
  return (
    <ul className="space-y-1.5 mt-1">
      {items.map((item, i) => (
        <li key={i} className="flex gap-2 text-xs items-start">
          <span style={{ color: statusColor(item.status) }} className="shrink-0 font-mono font-bold mt-0.5">{statusIcon(item.status)}</span>
          <span className="text-slate-300">{item.item}</span>
          {item.category && <span className="text-[10px] text-slate-600 ml-auto shrink-0">{item.category}</span>}
        </li>
      ))}
    </ul>
  );
}

// Semantic field keys
const VERDICT_KEYS   = ["verdict", "blue_verdict", "recommendation", "timing", "action"];
const SCORE_KEYS     = ["score", "readiness_score", "confidence", "bull", "bear", "neutral"];
const STRENGTHS_KEYS = ["strengths", "opportunities", "pros", "positives"];
const RISKS_KEYS     = ["risks", "blockers", "weaknesses", "concerns", "risk_flags", "action_items"];
const SKIP_KEYS      = ["tool", "timestamp", "chain", "_settle", "period", "data_source", "tokens_analyzed", "headline"];
const TITLE_KEYS     = ["token", "symbol", "ticker", "name", "protocol", "title", "handle", "project"];

function SmartValue({ k, v }: { k: string; v: unknown }) {
  if (v === null || v === undefined) return <span className="text-slate-600 text-xs">—</span>;

  // Verdict / recommendation
  if (VERDICT_KEYS.includes(k) && typeof v === "string") return <VerdictBadge value={v} />;

  // Score bars
  if (SCORE_KEYS.includes(k) && typeof v === "number") return <ScoreBar value={v} />;

  // Boolean
  if (typeof v === "boolean") return (
    <span className={`text-xs font-mono font-semibold ${v ? "text-[#34D399]" : "text-red-400"}`}>{v ? "✓ Yes" : "✗ No"}</span>
  );

  // Plain number
  if (typeof v === "number") return <span className="text-[#4FC3F7] font-mono font-semibold">{v}</span>;

  // String arrays
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === "string") {
    const color = STRENGTHS_KEYS.includes(k) ? "#34D399" : RISKS_KEYS.includes(k) ? "#F87171" : undefined;
    return <StringList items={v as string[]} color={color} />;
  }

  // Checklist array
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === "object" && (v[0] as Record<string,unknown>).item) {
    return <ChecklistItems items={v as { item: string; status: string; category?: string }[]} />;
  }

  // Persona object
  if (k === "personas" && typeof v === "object" && !Array.isArray(v)) {
    return <PersonaCards personas={v as Record<string, { stance: string; weight: number; rationale: string }>} />;
  }

  // Nested object
  if (typeof v === "object" && !Array.isArray(v)) {
    return <ResultObj obj={v as Record<string, unknown>} nested />;
  }

  // Object array — render as cards with a prominent title field
  if (Array.isArray(v)) {
    return (
      <div className="space-y-2 mt-1">
        {(v as Record<string,unknown>[]).map((obj, i) => {
          const titleKey = TITLE_KEYS.find(tk => obj?.[tk]);
          const title = titleKey ? String(obj[titleKey]) : null;
          const rest = titleKey
            ? Object.fromEntries(Object.entries(obj).filter(([kk]) => kk !== titleKey))
            : obj;
          return (
            <div key={i} className="border border-[#1A1A2E] rounded-lg p-2.5 bg-[#0A0A12]">
              {title && (
                <div className="font-mono text-sm font-bold text-[#4FC3F7] mb-1.5">{title}</div>
              )}
              <ResultObj obj={rest} nested />
            </div>
          );
        })}
      </div>
    );
  }

  // String with sentiment coloring
  if (typeof v === "string") {
    const upper = v.toUpperCase();
    const color = VERDICT_COLORS[upper];
    if (color && v.length < 20) return <span className="text-sm font-mono font-semibold" style={{ color }}>{v}</span>;
    return <span className="text-slate-200 text-xs leading-relaxed">{v}</span>;
  }

  return <span className="text-slate-300 text-xs">{String(v)}</span>;
}

function ResultObj({ obj, nested = false }: { obj: Record<string, unknown>; nested?: boolean }) {
  const SKIP = nested ? [] : SKIP_KEYS;
  const headline = !nested && typeof obj.headline === "string" ? (obj.headline as string) : null;
  return (
    <>
      {headline && (
        <p className="text-lg font-semibold text-white leading-snug mb-5 pb-4 border-b border-[#1A1A2E]">
          {headline}
        </p>
      )}
      <dl className={nested ? "space-y-1.5" : "space-y-4"}>
        {Object.entries(obj).filter(([k]) => !SKIP.includes(k)).map(([k, v]) => (
          <div key={k}>
            <dt className="font-mono text-[10px] text-slate-500 uppercase tracking-wider mb-1">{k.replace(/_/g," ")}</dt>
            <dd><SmartValue k={k} v={v} /></dd>
          </div>
        ))}
      </dl>
    </>
  );
}


// ─── Agent scan log animation ─────────────────────────────────────────────────

type LogLine = { agent: "blue" | "sys"; text: string; delay: number };

function buildScanScript(tool: Tool): LogLine[] {
  const inp = Object.values(tool.inputs).map(i => i.key).join(", ");
  return [
    { agent: "sys",  text: `> initializing Blue Agent · tool=${tool.id}`,                          delay: 0   },
    { agent: "sys",  text: `> inputs=[${inp}] · chain=base · endpoint=/api/${tool.id}`,            delay: 180 },
    { agent: "blue", text: `[BLUE] loading identity · skills/blue-agent-identity.md`,              delay: 420 },
    { agent: "blue", text: `[BLUE] injecting base-ecosystem.md · base-addresses.md`,               delay: 720 },
    { agent: "blue", text: `[BLUE] pulling live data · ${new Date().toISOString().split("T")[0]}`, delay: 1080},
    { agent: "blue", text: `[BLUE] running analysis · scoring signals…`,                           delay: 1480},
    { agent: "blue", text: `[BLUE] generating verdict · confidence scoring…`,                       delay: 1900},
    { agent: "sys",  text: `> streaming response · parsing JSON output…`,                           delay: 2300},
  ];
}

function AgentScanLog({ tool }: { tool: Tool }) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [cursor, setCursor] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);
  const script = useRef(buildScanScript(tool));

  useEffect(() => {
    // reset on new tool
    setLines([]);
    script.current = buildScanScript(tool);
    const timers: ReturnType<typeof setTimeout>[] = [];

    script.current.forEach(line => {
      const t = setTimeout(() => {
        setLines(prev => [...prev, line]);
      }, line.delay);
      timers.push(t);
    });

    // cursor blink
    const cursorInterval = setInterval(() => setCursor(c => !c), 530);

    return () => {
      timers.forEach(clearTimeout);
      clearInterval(cursorInterval);
    };
  }, [tool.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines]);

  const agentColor: Record<string, string> = {
    blue: "#4FC3F7",
    sys:  "#475569",
  };

  return (
    <div className="flex flex-col items-center justify-center h-full px-8 py-12">
      {/* Provider status row */}
      <div className="flex items-center gap-6 mb-8">
        {(["blue"] as const).map(a => {
          const hasStarted = lines.some(l => l.agent === a);
          const isDone     = lines.length > 0 && lines[lines.length - 1].agent === "sys" && lines.length >= script.current.length - 1;
          return (
            <div key={a} className="flex items-center gap-2">
              <span
                className={`w-2 h-2 rounded-full transition-all duration-500 ${hasStarted ? "animate-pulse" : "opacity-20"}`}
                style={{ background: agentColor[a], boxShadow: hasStarted ? `0 0 6px ${agentColor[a]}` : "none" }}
              />
              <span
                className="font-mono text-xs font-bold transition-all duration-500"
                style={{ color: hasStarted ? agentColor[a] : "#1E293B" }}
              >
                Blue Agent
              </span>
              {isDone && hasStarted && (
                <span className="font-mono text-[9px] text-slate-600">✓</span>
              )}
            </div>
          );
        })}
      </div>

      {/* Terminal */}
      <div className="w-full max-w-lg bg-[#080810] border border-[#1A1A2E] rounded-xl overflow-hidden">
        {/* Terminal titlebar */}
        <div className="flex items-center gap-1.5 px-4 py-2.5 border-b border-[#1A1A2E] bg-[#0D0D1A]">
          <span className="w-2.5 h-2.5 rounded-full bg-[#FF5F57]" />
          <span className="w-2.5 h-2.5 rounded-full bg-[#FEBC2E]" />
          <span className="w-2.5 h-2.5 rounded-full bg-[#28C840]" />
          <span className="font-mono text-[10px] text-slate-600 ml-3">blue-agent · x402</span>
        </div>
        {/* Log output */}
        <div className="px-4 py-4 space-y-1.5 min-h-[200px] max-h-[280px] overflow-y-auto">
          {lines.map((line, i) => (
            <div key={i} className="flex gap-2 font-mono text-[11px] leading-relaxed animate-fadeIn">
              <span style={{ color: agentColor[line.agent] }} className="shrink-0 opacity-70">
                {line.agent === "sys" ? "›" : "○"}
              </span>
              <span style={{ color: line.agent === "sys" ? "#475569" : agentColor[line.agent] + "CC" }}>
                {line.text}
              </span>
            </div>
          ))}
          {/* blinking cursor on last line */}
          {lines.length > 0 && (
            <div className="flex gap-2 font-mono text-[11px]">
              <span className="text-slate-700">›</span>
              <span className="text-slate-700">{cursor ? "█" : " "}</span>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      <p className="font-mono text-[10px] text-slate-700 mt-5">
        {lines.length < script.current.length
          ? `processing · ${lines.length}/${script.current.length} steps`
          : "finalizing output…"}
      </p>
    </div>
  );
}

// ─── Tool runner ─────────────────────────────────────────────────────────────

type RunStep = "idle" | "calling" | "signing" | "paying" | "done" | "error";

function randomNonce(): `0x${string}` {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("")}`;
}

// Shared tool-info block (API endpoint + how-it-works pipeline) — rendered above
// the inline runner. Kept here so the in-app tool view matches the old public
// /hub/[tool] detail page without duplicating its markup.
function ToolInfoBlock({ tool }: { tool: Tool }) {
  const agents = tool.agents;
  const [open, setOpen] = useState(false);
  return (
    <div className="px-6 py-4 lg:py-5 border-b border-[#1A1A2E]">
      {/* Mobile: collapsed by default. Desktop (lg): always expanded, no toggle. */}
      <button
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="lg:hidden w-full flex items-center justify-between min-h-[44px] font-mono text-[10px] text-slate-500 tracking-widest"
      >
        <span>// API · HOW IT WORKS</span>
        <span className="text-base text-slate-600">{open ? "−" : "+"}</span>
      </button>
      <div className={`${open ? "block mt-3" : "hidden"} lg:block lg:mt-0 space-y-4`}>
        <div>
          <p className="font-mono text-[10px] text-slate-600 tracking-widest mb-1.5">// API ENDPOINT</p>
          <code className="font-mono text-[11px] text-[#4FC3F7] bg-[#0D0D1A] border border-[#1A1A2E] rounded-md px-2 py-1 inline-block">POST /api/x402/{tool.id}</code>
        </div>
        <div>
          <p className="font-mono text-[10px] text-[#A78BFA] tracking-widest mb-2">// HOW IT WORKS</p>
          <div className="flex flex-wrap items-center gap-1.5">
            {agents.map((a, i) => (
              <span key={a} className="flex items-center gap-1.5">
                <span className="px-2 py-0.5 rounded-lg border font-mono text-[10px]" style={{ color: AGENT_COLORS[a], borderColor: `${AGENT_COLORS[a]}30` }}>{AGENT_LABELS[a]}</span>
                {i < agents.length - 1 && <span className="text-slate-700 text-xs">→</span>}
              </span>
            ))}
          </div>
          <p className="font-mono text-[10px] text-slate-600 mt-2.5 leading-relaxed">
            {agents.length > 1
              ? "Multi-agent consensus — each agent contributes, then synthesizes into one verdict, grounded in live Base data."
              : "Runs on Base with live data grounding. Pay per call in USDC via x402 — no subscription, no API key."}
          </p>
        </div>
      </div>
    </div>
  );
}

function ToolRunner({ tool, onBack, cached, onResult }: {
  tool: Tool;
  onBack: () => void;
  cached: ToolResult | null;
  onResult: (r: ToolResult) => void;
}) {
  const [vals, setVals]       = useState<Record<string,string>>({});
  const [step, setStep]       = useState<RunStep>(cached ? "done" : "idle");
  const [result, setResult]   = useState<Record<string,unknown> | string | null>(cached?.result ?? null);
  const [err, setErr]         = useState<string | null>(null);
  const [isMock, setIsMock]   = useState(cached?.isMock ?? false);
  const [mobileTab, setMobileTab] = useState<"input" | "output">(cached ? "output" : "input");
  const [mockReason, setMockReason] = useState<"dev" | "service-down">(cached?.mockReason ?? "dev");
  const [copied, setCopied]   = useState(false);
  const [copiedJson, setCopiedJson] = useState(false);

  const toolExamples = TOOL_EXAMPLES[tool.id] ?? {};
  const hasExamples  = Object.keys(toolExamples).length > 0;

  function fillExample() {
    setVals(toolExamples);
    setErr(null);
  }

  async function copyJson() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(typeof result === "string" ? result : JSON.stringify(result, null, 2));
      setCopiedJson(true);
      setTimeout(() => setCopiedJson(false), 2000);
    } catch {}
  }

  const { address, isConnected } = useAccount();
  const { signTypedDataAsync }   = useSignTypedData();
  const walletChainId            = useChainId();
  const { switchChainAsync }     = useSwitchChain();

  const { data: usdcBalRaw } = useReadContract({
    address: USDC_ADDRESS,
    abi: ERC20_BAL_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: 8453,
    query: { enabled: !!address },
  });
  const usdcBalance = usdcBalRaw != null ? Number(usdcBalRaw) / 1e6 : null;

  const loading = step === "calling" || step === "signing" || step === "paying";

  async function shareResult() {
    if (!result) return;
    try {
      // Server-side short id so URLs are ~30 chars instead of 3 KB of base64
      const res = await fetch("/api/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toolId: tool.id, result, isMock, mockReason }),
      });
      const data = await res.json() as { id?: string };
      // Share the public per-tool page (/hub/tool/[slug]) — self-contained,
      // reachable without the app shell, with correct per-tool OG via
      // generateMetadata; ?s= loads the shared result inline. A hash like
      // /hub#s= can't carry OG (crawlers never see the fragment), which is
      // why shared links used to preview as generic Blue Chat.
      //
      // Always the MARKETING origin: /hub/tool/<slug> only exists on
      // blueagent.dev. On app.blueagent.dev the detail page is the clean
      // /hub/<slug> (no /tool/), so using window.location.origin there would
      // hand out a 404 link. The marketing host also owns the rich OG.
      const SHARE_ORIGIN = "https://blueagent.dev";
      const url = data.id
        ? `${SHARE_ORIGIN}/hub/tool/${tool.id}?s=${data.id}`
        : `${SHARE_ORIGIN}/hub/tool/${tool.id}`;
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback: copy plain tool page link (marketing origin — see above)
      await navigator.clipboard.writeText(`https://blueagent.dev/hub/tool/${tool.id}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  async function run() {
    const missing = tool.inputs.filter(i => i.required && !vals[i.key]?.trim());
    if (missing.length) { setErr(`Required: ${missing.map(i => i.label).join(", ")}`); return; }

    setErr(null); setResult(null); setIsMock(false);

    const body: Record<string,string> = {};
    tool.inputs.forEach(i => { if (vals[i.key]) body[i.key] = vals[i.key]; });

    // ── x402 flow: wallet connected + tool has price ──────────────────────────
    if (tool.x402Body && isConnected && address) {
      try {
        // Known constants — no discovery call needed
        const USDC        = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
        // Self-hosted x402: pay our Club wallet (CDP facilitator settles to it)
        const BANKR_WALLET = "0xb058a1e305d9c720aa5b1bf42b6f2f6294b03b5f" as const;
        const priceRaw    = tool.price.replace("$", "");
        const priceVal    = parseFloat(priceRaw) || 0;
        const priceUnits  = String(Math.round(priceVal * 1_000_000)); // USDC 6 decimals
        const validBefore = BigInt(Math.floor(Date.now() / 1000) + 300);

        // Pre-check balance so we don't make the user sign a doomed payment
        if (usdcBalance != null && usdcBalance < priceVal) {
          setErr(`Insufficient USDC — you have $${usdcBalance.toFixed(2)}, need ${tool.price}. Top up your wallet on Base.`);
          return;
        }

        // Hub x402 payments are USDC on Base (chainId 8453). If the connected
        // wallet is on another chain (e.g. user switched to Robinhood 4663 for
        // bridge/swap testing), signTypedData rejects with "Provided chainId
        // '8453' must match the active chainId '4663'". Auto-switch before sign.
        if (walletChainId !== 8453) {
          try {
            await switchChainAsync({ chainId: 8453 });
          } catch (e) {
            setErr(`Switch your wallet to Base (chainId 8453) to sign USDC payment. Currently on chainId ${walletChainId}. (${(e as Error).message})`);
            setStep("error");
            return;
          }
        }

        setStep("signing");

        // Sign EIP-3009 TransferWithAuthorization
        const nonce = randomNonce();
        const signature = await signTypedDataAsync({
          domain: {
            name:              "USD Coin",
            version:           "2",
            chainId:           8453,
            verifyingContract: USDC,
          },
          types: {
            TransferWithAuthorization: [
              { name: "from",        type: "address" },
              { name: "to",         type: "address" },
              { name: "value",      type: "uint256" },
              { name: "validAfter", type: "uint256" },
              { name: "validBefore",type: "uint256" },
              { name: "nonce",      type: "bytes32" },
            ],
          },
          primaryType: "TransferWithAuthorization",
          message: {
            from:        address,
            to:          BANKR_WALLET,
            value:       BigInt(priceUnits),
            validAfter:  BigInt(0),
            validBefore: validBefore,
            nonce,
          },
        });

        setStep("paying");

        // Single call with X-PAYMENT — proxy forwards to Bankr / CDP
        const xPayment = btoa(JSON.stringify({
          x402Version: 2,
          scheme:      "exact",
          network:     "eip155:8453",
          payload: {
            signature,
            authorization: {
              from:        address,
              to:          BANKR_WALLET,
              value:       priceUnits,
              validAfter:  "0",
              validBefore: validBefore.toString(),
              nonce,
            },
          },
        }));

        // ── Hosted tools: async invoke (202 + job_id) → poll job status ──────────
        // The invoke route verifies payment, returns immediately, runs in the
        // background, and settles ONLY on success — so a failure leaves the user
        // uncharged. We poll the job until it reports done | error.
        if (tool.async) {
          const inv = await fetch(tool.callPath!, {
            method:  "POST",
            headers: { "Content-Type": "application/json", "X-PAYMENT": xPayment },
            body:    JSON.stringify(tool.x402Body(body)),
          });
          const invJson = await inv.json() as { job_id?: string; poll?: string; error?: string; detail?: unknown };
          if (!inv.ok || !invJson.job_id) {
            throw new Error([invJson.error, invJson.detail].filter(Boolean).join(": ") || `Invoke failed ${inv.status}`);
          }
          const pollUrl = invJson.poll ?? `/api/hub/community/jobs/${invJson.job_id}`;
          type Job = { status: string; result?: { body?: string; contentType?: string }; error?: string };
          let done: Job | null = null;
          for (let i = 0; i < 40; i++) {              // ~60s budget (40 × 1.5s)
            await new Promise(res => setTimeout(res, 1500));
            const p = await fetch(pollUrl);
            if (!p.ok) continue;
            const pj = await p.json() as Job;
            if (pj.status === "done" || pj.status === "error") { done = pj; break; }
          }
          if (!done) throw new Error("Timed out waiting for the tool — you were not charged.");
          if (done.status === "error") throw new Error(done.error || "Tool failed — you were not charged.");
          const raw = done.result?.body ?? "";
          // Body is the tool output (never config). Render JSON as an object if it
          // parses, otherwise show the raw text.
          let parsed: Record<string,unknown> | string = raw;
          try { const j = JSON.parse(raw); if (j && typeof j === "object") parsed = j as Record<string,unknown>; } catch {}
          setResult(parsed);
          setStep("done");
          setMobileTab("output");
          onResult({ result: parsed, isMock: false, mockReason: "dev" });
          return;
        }

        // Single call with X-PAYMENT — proxy forwards to Bankr (synchronous)
        const r2 = await fetch(tool.callPath ?? `/api/x402/${tool.id}`, {
          method:  "POST",
          headers: { "Content-Type": "application/json", "X-PAYMENT": xPayment },
          body:    JSON.stringify(tool.x402Body(body)),
        });
        const d2 = await r2.json() as Record<string,unknown>;
        if (!r2.ok) throw new Error([d2.error, d2.message, d2.reason].filter(Boolean).join(": ") || `Payment failed ${r2.status}`);
        const res2 = (d2.result ?? d2) as Record<string,unknown>;
        // Show result immediately — don't block behind animation
        setResult(res2);
        setStep("done");
        setMobileTab("output");
        onResult({ result: res2, isMock: false, mockReason: "dev" });

      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setErr(msg.includes("rejected") || msg.includes("denied") ? "Signature cancelled" : msg);
        setStep("error");
      }
      return;
    }

    // ── Paid tool but wallet not connected → require connection, no free output ──
    if (tool.x402Body) {
      setErr("Connect your wallet to run this paid tool.");
      setStep("error");
      return;
    }

    // ── Free flow: only for genuinely free tools (no x402Body) ────────────────
    setStep("calling");

    try {
      const res = await fetch(tool.callPath ?? `/api/x402/${tool.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({})) as Record<string,unknown>;
      if (!res.ok) {
        setErr((data.message as string) ?? (data.error as string) ?? "Service temporarily unavailable");
        setStep("error");
        return;
      }
      setResult(data);
      setStep("done");
      setMobileTab("output");
      onResult({ result: data, isMock: false, mockReason: "dev" });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Request failed");
      setStep("error");
    }
  }

  return (
    <div className="flex flex-col h-full">

      {/* Back nav */}
      <div className="px-6 py-3 border-b border-[#1A1A2E] flex items-center gap-2 shrink-0">
        <button onClick={onBack} className="flex items-center gap-1.5 font-mono text-xs text-slate-500 hover:text-white transition-colors">
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
          Hub
        </button>
        <span className="font-mono text-[10px] text-slate-700">/</span>
        <span className="font-mono text-xs text-slate-400 truncate">{tool.name}</span>
        {/* Agents shown on desktop only — keep the mobile breadcrumb compact. */}
        <div className="ml-auto hidden sm:flex items-center gap-2">
          {tool.agents.map(a => (
            <span key={a} className="font-mono text-[9px] px-1.5 py-0.5 rounded-full"
              style={{ color: AGENT_COLORS[a], background: `${AGENT_COLORS[a]}10` }}>
              {AGENT_LABELS[a]}
            </span>
          ))}
        </div>
      </div>

      {/* Mobile tab bar — Input / Output */}
      <div className="lg:hidden flex border-b border-[#1A1A2E] shrink-0">
        {(["input", "output"] as const).map(tab => (
          <button key={tab} onClick={() => setMobileTab(tab)}
            className={`flex-1 py-2.5 font-mono text-xs font-semibold transition-colors ${
              mobileTab === tab
                ? "text-[#4FC3F7] border-b-2 border-[#4FC3F7]"
                : "text-slate-600"
            }`}
          >
            {tab === "input" ? "⌨ Input" : step === "done" ? "✓ Output" : "◎ Output"}
          </button>
        ))}
      </div>

      {/* 2-column body — tab-controlled on mobile, side-by-side on desktop */}
      <div className="flex flex-col lg:flex-row flex-1 overflow-y-auto lg:overflow-hidden">

        {/* ── Left panel: tool info + form ── */}
        <div className={`w-full lg:w-[400px] xl:w-[440px] shrink-0 border-b lg:border-b-0 lg:border-r border-[#1A1A2E] lg:overflow-y-auto flex flex-col ${mobileTab === "output" ? "hidden lg:flex" : ""}`}>

          {/* Tool header */}
          <div className="px-6 pt-6 pb-5 border-b border-[#1A1A2E]">
            <div className="inline-flex items-center gap-2 border border-[#A78BFA]/20 bg-[#A78BFA]/5 rounded-full px-3 py-1 mb-4">
              <span className="w-1 h-1 rounded-full bg-[#A78BFA] animate-pulse" />
              <span className="font-mono text-[9px] text-[#A78BFA] tracking-widest">
                {tool.cat.replace(/-/g, " ").toUpperCase()}
              </span>
            </div>
            <h2 className="font-mono text-xl font-bold text-white mb-2">{tool.name}</h2>
            <p className="font-mono text-xs text-slate-500 leading-relaxed">{tool.desc}</p>
            {tool.price && (
              <span className="inline-block mt-3 px-3 py-1 rounded-lg border border-[#4FC3F7]/30 bg-[#4FC3F7]/5 text-[#4FC3F7] font-mono text-xs font-bold">
                {tool.price} <span className="text-[10px] text-slate-500 font-normal">/ run</span>
              </span>
            )}
          </div>

          {/* API endpoint + how-it-works (shared info block) */}
          <ToolInfoBlock tool={tool} />

          {/* Input form */}
          <div className="px-6 py-5 flex-1">
            <div className="flex items-center justify-between mb-1">
              <p className="font-mono text-[10px] text-[#4FC3F7] tracking-widest">// INPUT</p>
              {hasExamples && (
                <button
                  onClick={fillExample}
                  className="font-mono text-[10px] text-[#A78BFA] hover:text-white border border-[#A78BFA]/30 hover:border-[#A78BFA]/60 px-2 py-0.5 rounded transition-all"
                >
                  Try example →
                </button>
              )}
            </div>
            <p className="font-mono text-[10px] text-slate-700 mb-4">
              Output quality depends on input accuracy — use real data for best results
            </p>
            <div className="space-y-4">
              {tool.inputs.map(input => (
                <div key={input.key}>
                  <label className="block font-mono text-xs text-slate-500 mb-1.5">
                    {input.label}{input.required && <span className="text-[#4FC3F7] ml-1">*</span>}
                  </label>
                  <textarea
                    rows={input.placeholder.length > 60 ? 3 : 2}
                    className="w-full bg-[#0D0D1A] border border-[#1A1A2E] rounded-lg px-3 py-2 font-mono text-xs text-white placeholder-slate-700 focus:outline-none focus:border-[#4FC3F7]/40 transition-colors resize-none"
                    placeholder={input.placeholder}
                    value={vals[input.key] ?? ""}
                    onChange={e => setVals(v => ({ ...v, [input.key]: e.target.value }))}
                  />
                </div>
              ))}
            </div>
          </div>

          {/* Run button + error */}
          <div className="px-6 pb-6 shrink-0">
            {step === "error" && err && (
              <p className="font-mono text-xs text-red-400 mb-3">{err}</p>
            )}
            {tool.x402Body && !isConnected && (
              <div className="mb-3 px-4 py-3 rounded-xl bg-[#0D0D1A] border border-[#1A1A2E] flex items-center justify-between gap-3">
                <div>
                  <p className="font-mono text-xs text-white font-semibold">{tool.price} · pay via x402</p>
                  <p className="font-mono text-[10px] text-slate-600 mt-0.5">USDC on Base · EIP-3009 · no signup</p>
                </div>
                <ConnectButton
                  label="Connect Wallet"
                  className="font-mono text-xs font-semibold px-3 py-1.5 rounded-lg border transition-all shrink-0"
                  style={{ borderColor: "#4FC3F7", color: "#4FC3F7", background: "#4FC3F710" }}
                />
              </div>
            )}
            {tool.x402Body && isConnected && usdcBalance != null && (
              <div className="flex items-center justify-between mb-2 px-1">
                <span className="font-mono text-[10px] text-slate-600">USDC balance</span>
                <span className={`font-mono text-[10px] font-semibold ${
                  usdcBalance < (parseFloat(tool.price.replace("$", "")) || 0) ? "text-red-400" : "text-[#34D399]"
                }`}>
                  ${usdcBalance.toFixed(2)}
                </span>
              </div>
            )}
            <button
              onClick={run}
              disabled={loading}
              className="w-full font-mono text-sm font-bold px-6 py-3.5 rounded-xl transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              style={{
                background: loading ? "#29ABE2" : "linear-gradient(135deg, #4FC3F7 0%, #29ABE2 100%)",
                color: "#050508",
                boxShadow: loading ? "none" : "0 0 20px rgba(79,195,247,0.25), 0 4px 12px rgba(79,195,247,0.15)",
              }}
            >
              {step === "signing" ? "✍ Sign in wallet…" :
               step === "paying"  ? "💸 Paying USDC…"  :
               loading            ? "⚡ Calling agents…" :
               (tool.x402Body && isConnected) ? `⚡ Run · ${tool.price}` : "⚡ Run →"}
            </button>
          </div>
        </div>

        {/* ── Right panel: output ── */}
        <div className={`flex-1 lg:overflow-y-auto lg:min-h-0 ${mobileTab === "input" ? "hidden lg:block" : "min-h-[60vh] lg:min-h-0"}`}>
          {loading && <AgentScanLog tool={tool} />}

          {step === "idle" && !result && (
            <div className="flex flex-col items-center justify-center h-full gap-4 px-8 py-10">
              {/* Agent pills */}
              <div className="flex items-center gap-3">
                {tool.agents.map(a => (
                  <div key={a} className="flex items-center gap-1.5 px-2.5 py-1 rounded-full border" style={{ borderColor: AGENT_COLORS[a] + "30", background: AGENT_COLORS[a] + "08" }}>
                    <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: AGENT_COLORS[a] }} />
                    <span className="font-mono text-xs font-bold" style={{ color: AGENT_COLORS[a] }}>{AGENT_LABELS[a]}</span>
                  </div>
                ))}
              </div>
              <p className="font-mono text-xs text-slate-600 text-center max-w-xs leading-relaxed">
                Fill in the inputs, then hit <span className="text-[#4FC3F7]">Run</span> to get live AI output.
              </p>
              {/* Example prompt preview */}
              {hasExamples && (
                <div className="w-full max-w-sm rounded-xl border border-[#A78BFA]/15 bg-[#0D0D1A] overflow-hidden">
                  <div className="px-3 py-2 border-b border-[#1A1A2E] flex items-center justify-between">
                    <span className="font-mono text-[9px] text-[#A78BFA] tracking-widest">EXAMPLE INPUT</span>
                    <button onClick={fillExample} className="font-mono text-[10px] text-[#A78BFA] hover:text-white transition-colors">
                      Use this →
                    </button>
                  </div>
                  <div className="px-3 py-2.5 space-y-1.5">
                    {Object.entries(toolExamples).slice(0, 3).map(([k, v]) => (
                      <div key={k}>
                        <span className="font-mono text-[9px] text-slate-700 uppercase tracking-wider">{k.replace(/_/g, " ")}</span>
                        <p className="font-mono text-[10px] text-slate-400 leading-relaxed truncate">{v}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <p className="font-mono text-[10px] text-slate-700">Output from {tool.price} · USDC · Base · EIP-3009</p>
            </div>
          )}

          {step === "done" && result && (
            <div className="p-6 lg:p-8">
              <div className="flex items-center gap-2 mb-6 pb-4 border-b border-[#1A1A2E]">
                <div className="glow-dot" />
                <span className="font-mono text-xs text-slate-400">{tool.name}</span>
                {isMock && (
                  <span className="font-mono text-[10px] px-1.5 py-0.5 rounded border border-amber-500/30 text-amber-500 ml-2">
                    PREVIEW
                  </span>
                )}
                {cached && !loading && (
                  <span className="font-mono text-[10px] px-1.5 py-0.5 rounded border border-[#34D399]/30 text-[#34D399] ml-1">
                    cached
                  </span>
                )}
                {!isMock && typeof result !== "string" && (result._settle as { ok?: boolean; tx?: string } | undefined)?.ok && (() => {
                  const settle = result._settle as { ok?: boolean; tx?: string };
                  const cls = "font-mono text-[10px] px-1.5 py-0.5 rounded border border-[#34D399]/30 text-[#34D399] ml-1";
                  return settle.tx
                    ? <a href={`https://basescan.org/tx/${settle.tx}`} target="_blank" rel="noopener noreferrer"
                         className={`${cls} hover:bg-[#34D399]/10 transition-colors`}>✓ Paid {tool.price} ↗</a>
                    : <span className={cls}>✓ Paid {tool.price}</span>;
                })()}
                <div className="ml-auto flex items-center gap-2">
                  <span className="font-mono text-xs text-slate-700 mr-1">Blue Agent</span>
                  <button
                    onClick={copyJson}
                    className={`font-mono text-[10px] px-2 py-1 rounded border transition-all ${
                      copiedJson
                        ? "text-[#A78BFA] border-[#A78BFA]/40 bg-[#A78BFA]/5"
                        : "text-slate-500 border-[#1A1A2E] hover:text-[#A78BFA] hover:border-[#A78BFA]/30"
                    }`}
                  >
                    {copiedJson ? "✓ JSON!" : "{ } JSON"}
                  </button>
                  <button
                    onClick={shareResult}
                    className={`font-mono text-[10px] px-2 py-1 rounded border transition-all ${
                      copied
                        ? "text-[#34D399] border-[#34D399]/40 bg-[#34D399]/5"
                        : "text-slate-500 border-[#1A1A2E] hover:text-[#4FC3F7] hover:border-[#4FC3F7]/30"
                    }`}
                  >
                    {copied ? "✓ Copied!" : "Share ↗"}
                  </button>
                  <button
                    onClick={() => { setResult(null); setStep("idle"); }}
                    className="font-mono text-[10px] text-slate-600 hover:text-white border border-[#1A1A2E] hover:border-[#4FC3F7]/30 px-2 py-1 rounded transition-all"
                  >
                    Re-run ↺
                  </button>
                </div>
              </div>
              {typeof result === "string"
                ? <MarkdownOutput content={result} />
                : <ResultObj obj={result} />}
              {tool.source && tool.source !== "native" ? (
                // Community tool — attribute the builder, not the 3-agent stack.
                <p className="font-mono text-[10px] text-slate-700 mt-6 pt-4 border-t border-[#1A1A2E]">
                  powered by <span className="text-[#A78BFA]">{tool.creatorHandle || "an independent builder"}</span> via Blue Hub
                  {!isMock && typeof result !== "string" && result.timestamp
                    ? `  ·  ${new Date(result.timestamp as string).toLocaleString()}`
                    : ""}
                </p>
              ) : isMock ? (
                <p className="font-mono text-[10px] text-slate-700 mt-6 pt-4 border-t border-[#1A1A2E]">
                  preview data — live results powered by Blue Agent
                </p>
              ) : (
                <p className="font-mono text-[10px] text-slate-700 mt-6 pt-4 border-t border-[#1A1A2E]">
                  {typeof result === "string"
                    ? "powered by Blue Agent · Base"
                    : [
                        result.data_source ? `source: ${result.data_source}` : "powered by Blue Agent · Base",
                        result.timestamp ? new Date(result.timestamp as string).toLocaleString() : null,
                      ].filter(Boolean).join("  ·  ")}
                </p>
              )}
            </div>
          )}
        </div>

      </div>
    </div>
  );
}

// ─── Tool groups (Option A — labeled sections) ────────────────────────────────

const TOOL_GROUPS: { id: string; label: string; desc: string; color: string; ids: string[] }[] = [
  {
    id: "traders",
    label: "For Traders",
    desc: "Signals, market intel, portfolio tools",
    color: "#4FC3F7",
    ids: ["token-pick-signal", "narrative-position", "whale-copy-signal", "defi-opportunity", "token-momentum-scanner", "ecosystem-digest", "protocol-risk-monitor", "base-alpha", "token-alpha", "narrative-pulse", "protocol-health"],
  },
  {
    id: "founders",
    label: "For Founders",
    desc: "Launch, market fit, growth, fundraising",
    color: "#A78BFA",
    ids: ["market-fit", "token-launch-readiness", "competitor-scan", "gtm-brief", "launch-simulator-1", "launch-simulator-2", "launch-simulator-3", "base-grant-finder", "grant-evaluator", "roadmap-validator", "stack-recommender"],
  },
  {
    id: "investors",
    label: "For Investors",
    desc: "Due diligence, memos, pitch intel",
    color: "#34D399",
    ids: ["builder-deep-dd", "investor-memo", "pitch-intelligence", "fundraise-timing", "base-protocol-comparison", "agent-score", "founder-check"],
  },
  {
    id: "blue",
    label: "Blue Commands",
    desc: "Idea → build → audit → ship → raise",
    color: "#60A5FA",
    ids: ["blue-idea", "blue-build", "blue-audit", "blue-ship", "blue-raise", "blue-research", "blue-compose", "blue-monitor", "blue-analytics", "blue-simulate", "blue-deploy", "blue-stream", "blue-registry"],
  },
  {
    id: "security",
    label: "Security & Safety",
    desc: "Honeypot, risk gate, contract trust, wallet & token safety",
    color: "#F87171",
    ids: ["honeypot-check", "risk-gate", "deep-analysis", "contract-trust", "key-exposure", "quick-safety", "wallet-risk", "b20-check", "liquidity-depth", "token-distribution"],
  },
  {
    id: "onchain",
    label: "On-chain Data",
    desc: "Wallet PnL, AML, airdrops, whale tracking, DEX flow",
    color: "#FACC15",
    ids: ["aml-screen", "airdrop-check", "whale-tracker", "dex-flow", "token-price", "pool-scan", "wallet-holdings", "new-pools", "gas-tracker", "base-activity-score", "scam-detector", "cross-protocol-yield", "agent-readiness", "base-pulse"],
  },
  {
    id: "earn",
    label: "Earn & DeFi",
    desc: "Yield optimization, LP analysis, tax reporting",
    color: "#34D399",
    ids: ["lp-analyzer"],
  },
  {
    id: "automation",
    label: "Analytics & Automation",
    desc: "Repo health, builder network, protocol monitoring",
    color: "#FB923C",
    ids: ["repo-health"],
  },
  {
    id: "agents",
    label: "Agent Economy",
    desc: "Multi-agent workflows, revenue, collab",
    color: "#94A3B8",
    ids: ["agent-performance", "agent-collab-match", "multi-agent-workflow", "community-sentiment", "community-growth-playbook", "thread-intelligence"],
  },
];

// ─── Empty / browse state ─────────────────────────────────────────────────────

type SortMode = "popular" | "newest" | "price-asc" | "price-desc";
type ViewMode = "grid" | "list";

function EmptyState({
  tools, onSelect, featuredIds, usage, recentIds,
  search, setSearch, cat, setCat, filtered, onListTool,
  source, price, onClearFilters,
}: {
  tools:       Tool[];
  onSelect:   (t: Tool) => void;
  featuredIds: Set<string>;
  usage:      Record<string, number>;
  recentIds:  string[];
  search:     string;
  setSearch:  (s: string) => void;
  cat:        Category;
  setCat:     (c: Category) => void;
  filtered:   Tool[];
  onListTool?: () => void;
  source:      SourceFilter;
  price:       PriceFilter;
  onClearFilters: () => void;
}) {
  // Thin wrapper around HubHome (in _components/) — keeps page.tsx focused on
  // routing / state, while HubHome owns the marketplace UX.
  return (
    <HubHome
      tools={tools as unknown as import("./_components/HubHome").HubTool[]}
      filtered={filtered as unknown as import("./_components/HubHome").HubTool[]}
      groups={TOOL_GROUPS as unknown as import("./_components/HubHome").HubGroup[]}
      usage={usage}
      featuredIds={featuredIds}
      recentIds={recentIds}
      search={search}
      cat={cat}
      source={source}
      price={price}
      onSearch={setSearch}
      onPickCat={(id) => setCat(id as Category)}
      onSelect={(t) => onSelect(t as unknown as Tool)}
      onListTool={onListTool}
      onClearFilters={onClearFilters}
    />
  );
}

// ─── Tool card components ─────────────────────────────────────────────────────

function VerifiedAiBadges({ tool }: { tool: Tool }) {
  return (
    <div className="flex items-center gap-1">
      {tool.verified && (
        <span title="Reviewed by Blue Agent" className="font-mono text-[8px] px-1 py-0.5 rounded border border-[#34D399]/30 text-[#34D399]/90 bg-[#34D399]/5">
          ✓ Verified
        </span>
      )}
      {tool.aiReady && (
        <span title="Returns structured JSON — agent-callable" className="font-mono text-[8px] px-1 py-0.5 rounded border border-[#A78BFA]/30 text-[#A78BFA]/90 bg-[#A78BFA]/5">
          🤖 AI Ready
        </span>
      )}
    </div>
  );
}

/**
 * Horizontal scrolling row — App Store style "shelf".
 * Hides overflow on small screens, snap-scrolls on touch.
 */
function SectionRow({
  label, sub, accent, tools, runsOf, onSelect, compact,
}: {
  label: string;
  sub: string;
  accent: string;
  tools: Tool[];
  runsOf: (id: string) => number;
  onSelect: (t: Tool) => void;
  compact?: boolean;
}) {
  return (
    <div className="mb-7">
      <div className="flex items-center gap-3 mb-3">
        <p className="font-mono text-[10px] tracking-widest font-semibold" style={{ color: accent }}>{label}</p>
        <span className="font-mono text-[10px] text-slate-700">{sub}</span>
        <div className="flex-1 h-px" style={{ background: `${accent}20` }} />
        <span className="font-mono text-[9px] text-slate-700">{tools.length}</span>
      </div>
      <div className="-mx-2 flex overflow-x-auto snap-x snap-mandatory pb-2 scrollbar-thin">
        {tools.map(tool => (
          <div key={tool.id} className={`px-2 shrink-0 snap-start ${compact ? "w-56" : "w-64"}`}>
            <ShelfCard tool={tool} runs={runsOf(tool.id)} onSelect={onSelect} accent={accent} compact={compact} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Shelf-style tool card — fits in horizontal scroll rows. */
function ShelfCard({
  tool, runs, onSelect, accent, compact,
}: { tool: Tool; runs: number; onSelect: (t: Tool) => void; accent: string; compact?: boolean }) {
  return (
    <button onClick={() => onSelect(tool)}
      className="w-full text-left rounded-xl p-3.5 transition-all group border flex flex-col h-full"
      style={{ borderColor: `${accent}25`, background: `${accent}06` }}
      onMouseEnter={e => (e.currentTarget.style.borderColor = `${accent}55`)}
      onMouseLeave={e => (e.currentTarget.style.borderColor = `${accent}25`)}>
      <div className="flex items-center gap-1.5 mb-2">
        {tool.agents.map(a => (
          <span key={a} className="w-1.5 h-1.5 rounded-full" style={{ background: AGENT_COLORS[a] }} />
        ))}
        <span className="font-mono text-[9px] text-slate-700 ml-auto">{tool.price}</span>
      </div>
      <p className="font-mono text-xs font-bold text-white mb-0.5 leading-snug group-hover:opacity-80 transition-opacity">{tool.name}</p>
      <p className={`font-mono text-[10px] text-slate-600 leading-relaxed line-clamp-2 ${compact ? "mb-2" : "mb-2"} flex-1`}>{tool.desc}</p>
      <div className="mb-2"><VerifiedAiBadges tool={tool} /></div>
      <div className="flex items-center justify-between pt-2 border-t" style={{ borderColor: `${accent}20` }}>
        <span className="font-mono text-[9px] text-slate-700">{runs > 0 ? `${runs} calls` : "new"}</span>
        <span className="font-mono text-[10px] font-semibold transition-opacity opacity-70 group-hover:opacity-100" style={{ color: accent }}>Try →</span>
      </div>
    </button>
  );
}

/** Provider showcase card — agent identity + stats. */
function ProviderCard({ provider }: { provider: { agent: Agent; toolCount: number; totalCalls: number } }) {
  const color = AGENT_COLORS[provider.agent];
  const label = AGENT_LABELS[provider.agent];
  const blurb =
    provider.agent === "blue"      ? "Multi-agent orchestration + console commands · idea → ship"
    : provider.agent === "aeon"    ? "Ecosystem signals, narrative tracking, token picks on Base"
    :                                "Sentiment consensus + crowd intelligence for trade decisions";
  return (
    <div className="rounded-2xl p-4 border flex flex-col" style={{ borderColor: `${color}25`, background: `${color}06` }}>
      <div className="flex items-center gap-2 mb-2">
        <div className="w-9 h-9 rounded-xl flex items-center justify-center font-bold text-sm shrink-0"
          style={{ background: `${color}18`, color, border: `1px solid ${color}40` }}>
          {label.slice(0, 2)}
        </div>
        <div className="min-w-0">
          <p className="font-mono text-sm font-bold" style={{ color }}>{label}</p>
          <p className="font-mono text-[10px] text-slate-700">Provider</p>
        </div>
        <span className="font-mono text-[9px] px-1.5 py-0.5 rounded border ml-auto"
          style={{ borderColor: `${color}40`, color, background: `${color}10` }}>
          ✓ Verified
        </span>
      </div>
      <p className="font-mono text-[10px] text-slate-500 leading-relaxed mb-3 flex-1">{blurb}</p>
      <div className="grid grid-cols-2 gap-2 pt-2 border-t" style={{ borderColor: `${color}15` }}>
        <div>
          <p className="font-mono text-[9px] text-slate-700">TOOLS</p>
          <p className="font-mono text-sm font-bold text-white tabular-nums">{provider.toolCount}</p>
        </div>
        <div>
          <p className="font-mono text-[9px] text-slate-700">CALLS</p>
          <p className="font-mono text-sm font-bold tabular-nums" style={{ color }}>{provider.totalCalls > 0 ? provider.totalCalls.toLocaleString() : "—"}</p>
        </div>
      </div>
    </div>
  );
}

// ─── Cached result type ───────────────────────────────────────────────────────

type ToolResult = { result: Record<string,unknown> | string; isMock: boolean; mockReason: "dev" | "service-down" };

// ─── Share encode / decode ────────────────────────────────────────────────────

function encodeShare(toolId: string, r: ToolResult): string {
  const payload = JSON.stringify({ toolId, ...r });
  return btoa(unescape(encodeURIComponent(payload)));
}

function decodeShare(hash: string): { toolId: string } & ToolResult | null {
  try {
    const raw = decodeURIComponent(escape(atob(hash)));
    const p = JSON.parse(raw) as { toolId: string } & ToolResult;
    if (!p.toolId || !p.result) return null;
    return p;
  } catch { return null; }
}

// ─── Hub page ─────────────────────────────────────────────────────────────────

export default function HubPage({ inShell = false, initialToolId, initialView = "browse" }: { inShell?: boolean; initialToolId?: string; initialView?: "browse" | "dashboard" | "submit" }) {
  const [cat, setCat]         = useState<Category>("all");
  const [selected, setSelected] = useState<Tool | null>(null);
  // View mode — "browse" shows the marketplace grid / tool runner; "dashboard"
  // renders the creator dashboard and "submit" the List-your-tool form, both
  // IN-SHELL (sidebar + nav kept), mirroring the per-tool inShell pattern so a
  // creator can jump back to Browse in one click.
  const [view, setView]       = useState<"browse" | "dashboard" | "submit">(initialView);
  const [search, setSearch]   = useState("");
  const [cache, setCache]     = useState<Map<string, ToolResult>>(new Map());
  // Result to preload into the runner. Set ONLY by the ?s=/#s= share readers
  // (server KV). A normal tool click never sets this → the runner opens to a
  // clean idle form, even if localStorage has an old run for that tool.
  const [preload, setPreload] = useState<{ toolId: string; data: ToolResult } | null>(null);
  const [usage, setUsage]     = useState<Record<string, number>>({});
  const [communityTools, setCommunityTools] = useState<Tool[]>([]);
  const [source, setSource] = useState<SourceFilter>("all"); // v2 sidebar: provenance filter
  const [price, setPrice]   = useState<PriceFilter>("all");  // v2 sidebar: price bucket
  const searchRef             = useRef<HTMLInputElement>(null);

  // ── Merge first-party (TOOLS) + community-submitted (registered) ──────────
  const allTools = useMemo<Tool[]>(() => [...TOOLS, ...communityTools], [communityTools]);

  // ── App-shell deep routing ────────────────────────────────────────────────
  // Selecting a tool updates the URL to /app/hub/[id] without a reload (the view
  // stays inline); clearSelected resets to /app/hub. Only active in the app shell.
  const selectTool = (t: Tool) => {
    setPreload(null); // normal click → fresh form, never an old result
    setSelected(t);
    if (inShell && typeof window !== "undefined") window.history.pushState(null, "", `/hub/${t.id}`);
  };
  const clearSelected = () => {
    setPreload(null);
    setSelected(null);
    if (inShell && typeof window !== "undefined") window.history.pushState(null, "", "/hub");
  };

  // Creator dashboard — switch the in-shell view (keeps sidebar + nav). URL is
  // updated to /hub/dashboard so a refresh/deep-link resolves to the same route.
  const openDashboard = () => {
    setSelected(null);
    setView("dashboard");
    if (typeof window !== "undefined") window.history.pushState(null, "", "/hub/dashboard");
  };
  // List-your-tool — same in-shell view swap (keeps sidebar + nav). URL → /hub/submit.
  const openSubmit = () => {
    setSelected(null);
    setView("submit");
    if (typeof window !== "undefined") window.history.pushState(null, "", "/hub/submit");
  };
  const backToBrowse = () => {
    setView("browse");
    if (typeof window !== "undefined") window.history.pushState(null, "", "/hub");
  };
  // Any sidebar filter (search / source / category / price) must drop you back
  // into the browse grid. Without this, picking a filter while on the Creator
  // Dashboard or Submit view mutates the filter state invisibly — the dashboard
  // stays on screen and the "filtered" tools never appear.
  const ensureBrowse = () => { if (view !== "browse") backToBrowse(); };

  // Open the tool from the route param (/app/hub/[tool]). Applies once the tool
  // is present (community tools load async), and only once.
  const initialApplied = useRef(false);
  useEffect(() => {
    if (initialApplied.current || !initialToolId) return;
    const t = allTools.find(x => x.id === initialToolId);
    if (t) { setSelected(t); initialApplied.current = true; }
  }, [initialToolId, allTools]);

  // Keep the inline view in sync with browser back/forward.
  useEffect(() => {
    if (!inShell || typeof window === "undefined") return;
    const onPop = () => {
      const path = window.location.pathname;
      setPreload(null); // back/forward → fresh form
      if (/\/hub\/dashboard$/.test(path)) { setView("dashboard"); setSelected(null); return; }
      if (/\/hub\/submit$/.test(path))    { setView("submit");    setSelected(null); return; }
      setView("browse");
      const m = path.match(/\/hub\/([^/?#]+)/);
      const id = m && m[1] !== "dashboard" ? m[1] : null;
      setSelected(id ? (allTools.find(x => x.id === id) ?? null) : null);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [inShell, allTools]);

  const RESULTS_KEY = "bluehub_results";

  function saveResult(toolId: string, r: ToolResult) {
    setCache(prev => {
      const next = new Map(prev).set(toolId, r);
      try { localStorage.setItem(RESULTS_KEY, JSON.stringify(Object.fromEntries(next))); } catch {}
      return next;
    });
  }

  // ── Load persisted results so paid runs survive refresh ───────────────────
  useEffect(() => {
    try {
      const raw = localStorage.getItem(RESULTS_KEY);
      if (raw) setCache(new Map(Object.entries(JSON.parse(raw) as Record<string, ToolResult>)));
    } catch {}
  }, []);

  // ── Fetch real usage counts → dynamic Featured (top by paid runs) ─────────
  useEffect(() => {
    fetch("/api/usage").then(r => r.json()).then(setUsage).catch(() => {});
  }, []);

  // ── Fetch community-submitted tools from the Builder Registry ──────────────
  // Maps RegisteredTool shape → local Tool shape and routes calls through the
  // Hub proxy (which forwards to the builder's endpoint + tracks usage). Kept as
  // a useCallback so the "List your tool" modal can refresh the grid on submit.
  const loadCommunityTools = useCallback(() => {
    type Registered = {
      id: string; name: string; description: string; category: string;
      price: string; priceUSDC: number;
      inputs: { key: string; label: string; placeholder: string; required?: boolean }[];
      verified: boolean; aiReady: boolean; status?: "live";
      builderAddress: string; submittedAt: number;
      agentName?: string; callCount?: number; logoUrl?: string;
    };
    const asCat = (c: string): Exclude<Category, "all"> =>
      (["intelligence","builder","trading","content","agent-economy","base-ecosystem","on-chain"] as const)
        .includes(c as never) ? (c as Exclude<Category, "all">) : "intelligence";
    const shortAddr = (a?: string) => a ? `${a.slice(0, 6)}…${a.slice(-4)}` : undefined;

    // External tools (builder hosts the endpoint; Hub proxies + forwards payment).
    // no-store: the registry is mutable (submit/delete) — a stale list would keep
    // showing a tool the creator just removed, so never serve a cached copy here.
    const external = fetch("/api/hub/tools", { cache: "no-store" })
      .then(r => r.ok ? r.json() : { tools: [] })
      .then((d: { tools: Registered[] }): Tool[] => (d.tools ?? []).map(r => ({
        id:             r.id,
        name:           r.name,
        cat:            asCat(r.category),
        price:          r.price,
        agents:         ["blue"],
        desc:           r.description,
        inputs:         r.inputs.map(i => ({ key: i.key, label: i.label, placeholder: i.placeholder, required: !!i.required })),
        verified:       r.verified,
        aiReady:        r.aiReady,
        builderAddress: r.builderAddress,
        releasedAt:    r.submittedAt,
        source:         "external",
        status:         r.status ?? "live",
        creatorHandle:  r.agentName || shortAddr(r.builderAddress),
        logoUrl:        r.logoUrl,
        callCount:      r.callCount,
        // Route through Hub proxy (forwards to builder endpoint + tracks usage/revenue)
        callPath:       `/api/hub/tools/${r.id}/call`,
        x402Body:       r.priceUSDC > 0
                          ? (vals: Record<string, string>) => vals as Record<string, unknown>
                          : undefined,
      })))
      .catch((): Tool[] => []);

    // NOTE: Hosted tools (AI-tool / API-wrapper) are intentionally NOT loaded into
    // the marketplace grid right now — the backend (/api/hub/hosted + community
    // /invoke + jobs) is kept intact for a later phase. To re-enable, fetch
    // /api/hub/hosted, map source:"hosted" + async:true + callPath
    // `/api/hub/community/<slug>/invoke`, and merge below.
    external.then(e => setCommunityTools(e));
  }, []);

  useEffect(() => { loadCommunityTools(); }, [loadCommunityTools]);

  const featuredIds = useMemo<Set<string>>(() => {
    // Most-run tools first, then pad with static FEATURED_IDS so we always show 4
    const ranked = Object.entries(usage)
      .filter(([, c]) => c > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => id);
    const combined = [...ranked, ...FEATURED_IDS].filter((id, i, arr) => arr.indexOf(id) === i);
    return new Set(combined.slice(0, 4));
  }, [usage]);

  // ── Keyboard shortcut: "/" focuses search, Esc closes tool ──────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "/" && !selected && document.activeElement?.tagName !== "INPUT" && document.activeElement?.tagName !== "TEXTAREA") {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (e.key === "Escape" && selected) clearSelected();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selected]);

  // ── On mount: deep-link ?tool=<id> (from /hub/[tool] pages & dashboard "Test") ──
  // Community tools (external + hosted) load ASYNC, so a target may not exist at
  // mount. Depend on allTools and retry until it appears — guarded to fire once.
  const toolDeepLinkApplied = useRef(false);
  useEffect(() => {
    if (toolDeepLinkApplied.current || typeof window === "undefined") return;
    const qTool = new URLSearchParams(window.location.search).get("tool");
    if (!qTool) { toolDeepLinkApplied.current = true; return; }
    const t = allTools.find(x => x.id === qTool);
    if (!t) return;   // community tool not loaded yet — re-run when allTools changes
    toolDeepLinkApplied.current = true;
    setSelected(t);
    // Normalize legacy ?tool= links to the clean per-tool path.
    window.history.replaceState(null, "", `/hub/${t.id}`);
  }, [allTools]);

  // ── On mount: load shared result from URL hash ────────────────────────────
  // Two formats supported:
  //   #s=<10-hex-id>      → short id, fetched from /api/share/[id]   (new)
  //   #s=<base64 payload> → legacy inline payload (kept for old links)
  useEffect(() => {
    if (typeof window === "undefined") return;
    const hash = window.location.hash.slice(1);
    if (!hash.startsWith("s=")) return;
    const value = hash.slice(2);

    const apply = (toolId: string, result: Record<string, unknown> | string, isMock: boolean, mockReason: "dev" | "service-down") => {
      const tool = allTools.find(t => t.id === toolId);
      if (!tool) return;
      setPreload({ toolId, data: { result, isMock, mockReason } });
      setSelected(tool);
      window.history.replaceState(null, "", window.location.pathname);
    };

    if (/^[a-f0-9]{6,32}$/.test(value)) {
      // Short id — fetch from server
      fetch(`/api/share/${value}`)
        .then(r => r.ok ? r.json() : null)
        .then((p: { toolId?: string; result?: Record<string, unknown>; isMock?: boolean; mockReason?: "dev" | "service-down" } | null) => {
          if (p?.toolId && p?.result) apply(p.toolId, p.result, !!p.isMock, p.mockReason ?? "dev");
        })
        .catch(() => {});
    } else {
      // Legacy inline base64 payload
      const shared = decodeShare(value);
      if (shared) apply(shared.toolId, shared.result, shared.isMock, shared.mockReason);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load a shared result from ?s=<id> (the /app/hub/[tool]?s= share link) ──
  // initialToolId selects the tool; this loads its shared output into the cache
  // so the inline runner shows it. Applies once the tool exists (community tools
  // load async), then strips ?s= for a clean URL.
  const sApplied = useRef(false);
  useEffect(() => {
    if (sApplied.current || typeof window === "undefined") return;
    const sid = new URLSearchParams(window.location.search).get("s");
    if (!sid || !/^[a-f0-9]{6,32}$/.test(sid)) { sApplied.current = true; return; }
    let off = false;
    fetch(`/api/share/${sid}`)
      .then(r => (r.ok ? r.json() : null))
      .then((p: { toolId?: string; result?: Record<string, unknown>; isMock?: boolean; mockReason?: "dev" | "service-down" } | null) => {
        if (off || !p?.toolId || p.result == null) return;
        const tool = allTools.find(t => t.id === p.toolId);
        if (!tool) return; // not loaded yet — re-runs when allTools updates
        sApplied.current = true;
        setPreload({ toolId: p.toolId, data: { result: p.result, isMock: !!p.isMock, mockReason: p.mockReason ?? "dev" } });
        setSelected(tool);
        // Drop ?s= but keep the current path so a refresh still resolves the
        // route (in-app: /app/hub/[tool]; public per-tool page: /hub/tool/[slug]).
        window.history.replaceState(null, "", window.location.pathname);
      })
      .catch(() => {});
    return () => { off = true; };
  }, [allTools]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── On mount: open a tool from ?tool=<id> (deep link from /hub/[tool] detail) ──
  useEffect(() => {
    if (typeof window === "undefined") return;
    const toolId = new URLSearchParams(window.location.search).get("tool");
    if (!toolId) return;
    const tool = allTools.find(t => t.id === toolId);
    if (tool) {
      setSelected(tool);
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = allTools.filter(t => {
    const matchesSearch = !search || t.name.toLowerCase().includes(search.toLowerCase()) || t.desc.toLowerCase().includes(search.toLowerCase());
    if (!matchesSearch) return false;
    // Marketplace shows Native + live External only. Hosted is hidden (backend
    // kept for a later phase); non-live externals never persist but guard anyway.
    const src = t.source ?? "native";
    if (src === "hosted") return false;
    if (src === "external" && (t.status ?? "live") !== "live") return false;
    // v2 marketplace filters — provenance + price bucket
    if (source !== "all" && src !== source) return false;
    if (!matchPrice(price, priceNum(t.price))) return false;
    if (cat === "all") { /* fall through to source/price-only result */ }
    else {
      // Check if cat matches a group id
      const group = TOOL_GROUPS.find(g => g.id === cat);
      if (group) { if (!group.ids.includes(t.id)) return false; }
      // Fallback to old category field
      else if (t.cat !== cat) return false;
    }
    return true;
  });

  // Per-source counts across the search/price/category-filtered set (drives sidebar chip labels).
  const sourceCounts: Record<SourceFilter, number> = {
    all:      allTools.length,
    native:   allTools.filter(t => (t.source ?? "native") === "native").length,
    external: allTools.filter(t => t.source === "external").length,
  };

  return (
    <>
      {!inShell && <Navbar />}
      <div className={`flex flex-col bg-[#050508] font-mono ${inShell ? "h-full overflow-hidden" : "pt-14"}`}>

        {/* ── Shell header ── */}
        {inShell && (
          <AppPageHeader
            label="HUB"
            subtitle="AI tools · multi-agent · x402 · Base"
            accent="#4FC3F7"
            right={<span style={{ color: "#4FC3F7" }}>{allTools.length} tools</span>}
          />
        )}

        <div className={`flex ${inShell ? "flex-1 overflow-hidden" : ""}`}>

        {/* ── Sidebar ──────────────────────────────────── */}
        <aside className={`hidden lg:flex flex-col w-72 shrink-0 border-r border-[#1A1A2E] ${inShell ? "h-full" : "sticky top-14 h-[calc(100vh-3.5rem)]"}`}>

          {/* Header */}
          <div className="px-5 h-14 flex items-center gap-3 border-b border-[#1A1A2E] shrink-0">
            <p className="font-mono text-xs text-[#4FC3F7] tracking-widest">// MARKETPLACE</p>
            <span className="font-mono text-[10px] text-slate-700">{filtered.length} of {allTools.length}</span>
          </div>

          {/* Filters — scrollable so the List / Creator actions stay pinned below */}
          <div className="flex-1 overflow-y-auto">

            {/* Search */}
            <div className="px-4 pt-3 pb-2">
              <input
                ref={searchRef}
                className="w-full bg-[#0D0D1A] border border-[#1A1A2E] rounded-lg px-3 py-2 font-mono text-xs text-white placeholder-slate-700 focus:outline-none focus:border-[#4FC3F7]/30 transition-colors"
                placeholder="Search tools… ( / )"
                value={search}
                onChange={e => { setSearch(e.target.value); ensureBrowse(); }}
              />
            </div>

            {/* Source filter */}
            <div className="px-4 pt-3 pb-3">
              <p className="font-mono text-[9px] text-slate-700 tracking-widest mb-2">SOURCE</p>
              <div className="flex flex-wrap gap-1.5">
                {SOURCE_CHIPS.map(s => {
                  const active = source === s.key;
                  const count = sourceCounts[s.key];
                  return (
                    <button key={s.key} onClick={() => { setSource(s.key); ensureBrowse(); }}
                      className="font-mono text-[10px] px-2 py-1 rounded border transition-colors"
                      style={active
                        ? { color: s.color, borderColor: `${s.color}55`, background: `${s.color}12` }
                        : { color: "#64748b", borderColor: "#1A1A2E" }}>
                      {s.label} <span className="opacity-60">{count}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Category filter */}
            <div className="px-4 pt-2 pb-3 border-t border-[#1A1A2E]">
              <p className="font-mono text-[9px] text-slate-700 tracking-widest mb-2">CATEGORY</p>
              <div className="flex flex-wrap gap-1.5">
                <button onClick={() => { setCat("all"); ensureBrowse(); }}
                  className={`font-mono text-[10px] px-2 py-1 rounded border transition-colors ${cat === "all" ? "bg-[#4FC3F7]/15 text-[#4FC3F7] border-[#4FC3F7]/40" : "text-slate-600 border-[#1A1A2E] hover:text-slate-300"}`}>
                  All
                </button>
                {TOOL_GROUPS.map(g => (
                  <button key={g.id} onClick={() => { setCat(g.id as Category); ensureBrowse(); }}
                    className="font-mono text-[10px] px-2 py-1 rounded border transition-colors"
                    style={cat === g.id
                      ? { background: g.color + "18", color: g.color, borderColor: g.color + "40" }
                      : { color: "#475569", borderColor: "#1A1A2E" }}
                    onMouseEnter={e => { if (cat !== g.id) (e.currentTarget as HTMLElement).style.color = g.color; }}
                    onMouseLeave={e => { if (cat !== g.id) (e.currentTarget as HTMLElement).style.color = "#475569"; }}
                  >
                    {g.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Price filter */}
            <div className="px-4 pt-2 pb-4 border-t border-[#1A1A2E]">
              <p className="font-mono text-[9px] text-slate-700 tracking-widest mb-2">PRICE</p>
              <div className="flex flex-wrap gap-1.5">
                {PRICE_CHIPS.map(p => {
                  const active = price === p.key;
                  return (
                    <button key={p.key} onClick={() => { setPrice(p.key); ensureBrowse(); }}
                      className={`font-mono text-[10px] px-2 py-1 rounded border transition-colors ${active ? "bg-[#34D399]/15 text-[#34D399] border-[#34D399]/40" : "text-slate-600 border-[#1A1A2E] hover:text-slate-300"}`}>
                      {p.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Clear filters — only when a filter is active */}
            {(search.trim() || cat !== "all" || source !== "all" || price !== "all") && (
              <div className="px-4 pb-4">
                <button onClick={() => { setSearch(""); setCat("all"); setSource("all"); setPrice("all"); ensureBrowse(); }}
                  className="font-mono text-[10px] text-slate-600 hover:text-white transition-colors">
                  ✕ Clear filters
                </button>
              </div>
            )}
          </div>

          {/* Builder actions (v2) */}
          <div className="px-4 pb-2 border-t border-[#1A1A2E] pt-3 space-y-1">
            <button
              type="button"
              onClick={view === "submit" ? backToBrowse : openSubmit}
              className={`flex items-center gap-2 w-full px-2 py-2 rounded-lg transition-colors group ${view === "submit" ? "bg-[#A78BFA]/10" : "hover:bg-[#A78BFA]/5"}`}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-[#A78BFA] animate-pulse shrink-0" />
              <span className={`font-mono text-[11px] transition-colors ${view === "submit" ? "text-[#A78BFA]" : "text-slate-500 group-hover:text-[#A78BFA]"}`}>
                {view === "submit" ? "← Browse tools" : "+ List your tool"}
              </span>
              {view !== "submit" && (
                <span className="ml-auto font-mono text-[9px] text-slate-700 group-hover:text-[#A78BFA]">
                  95/5
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={view === "dashboard" ? backToBrowse : openDashboard}
              className={`flex items-center gap-2 w-full px-2 py-2 rounded-lg transition-colors group ${view === "dashboard" ? "bg-[#34D399]/10" : "hover:bg-[#34D399]/5"}`}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-[#34D399] shrink-0" />
              <span className={`font-mono text-[11px] transition-colors ${view === "dashboard" ? "text-[#34D399]" : "text-slate-500 group-hover:text-[#34D399]"}`}>
                {view === "dashboard" ? "← Browse tools" : "Creator dashboard"}
              </span>
            </button>
          </div>

          {/* Footer */}
          <div className="px-4 py-4 border-t border-[#1A1A2E]">
            <p className="font-mono text-[10px] text-slate-700">multi-agent · Blue Hub v2 · Base</p>
          </div>
        </aside>

        {/* ── Main content ─────────────────────────────── */}
        <main className="flex-1 h-full overflow-hidden flex flex-col">

          {/* Mobile search + filter chips (browse state only) */}
          {!selected && view === "browse" && (
            <div className="lg:hidden px-4 pt-3 pb-2 border-b border-[#1A1A2E] shrink-0 space-y-2">
              {/* On the home state the large SearchHero is the single search bar;
                  this compact input only appears once browsing (search/category). */}
              <input
                className={`${!search.trim() && cat === "all" ? "hidden" : "block"} w-full bg-[#0D0D1A] border border-[#1A1A2E] rounded-lg px-3 py-2.5 font-mono text-sm text-white placeholder-slate-700 focus:outline-none focus:border-[#4FC3F7]/30 transition-colors`}
                placeholder="Search tools…"
                value={search}
                onChange={e => { setSearch(e.target.value); setCat("all"); }}
              />
              {/* Category chips — horizontal scroll with a right fade hinting more. */}
              <div className="relative">
                <div className="flex gap-1.5 overflow-x-auto pb-1 no-scrollbar pr-8">
                  <button onClick={() => { setSearch(""); setCat("all"); }}
                    className={`font-mono text-[10px] px-3 py-2 min-h-[40px] rounded-full whitespace-nowrap border transition-colors shrink-0 ${cat === "all" && !search ? "bg-[#4FC3F7]/15 text-[#4FC3F7] border-[#4FC3F7]/30" : "text-slate-600 border-[#1A1A2E]"}`}>
                    All
                  </button>
                  {TOOL_GROUPS.map(g => (
                    <button key={g.id}
                      onClick={() => { setSearch(""); setCat(g.id as Category); }}
                      className={`font-mono text-[10px] px-3 py-2 min-h-[40px] rounded-full whitespace-nowrap border shrink-0 transition-colors`}
                      style={cat === g.id
                        ? { background: g.color + "15", color: g.color, borderColor: g.color + "40" }
                        : { color: g.color + "80", borderColor: "#1A1A2E" }}
                    >
                      {g.label}
                    </button>
                  ))}
                </div>
                <div className="pointer-events-none absolute right-0 top-0 bottom-1 w-10 bg-gradient-to-l from-[#050508] to-transparent" />
              </div>
              {/* Source chips — only once community tools exist alongside native. */}
              {sourceCounts.external > 0 && (
                <div className="flex gap-1.5 overflow-x-auto pb-1 no-scrollbar">
                  {SOURCE_CHIPS.filter(s => s.key === "all" || sourceCounts[s.key] > 0).map(s => {
                    const active = source === s.key;
                    return (
                      <button key={s.key} onClick={() => setSource(s.key)}
                        className="font-mono text-[10px] px-3 py-1.5 rounded-full whitespace-nowrap border shrink-0 transition-colors"
                        style={active
                          ? { color: s.color, borderColor: `${s.color}55`, background: `${s.color}15` }
                          : { color: "#64748b", borderColor: "#1A1A2E" }}>
                        {s.label} <span className="opacity-60">{sourceCounts[s.key]}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {view === "submit"
            ? <SubmitTool variant="shell" onBack={backToBrowse} onSubmitted={() => loadCommunityTools()} />
            : view === "dashboard"
            ? <DashboardView inShell onBack={() => { loadCommunityTools(); backToBrowse(); }} />
            : selected
            ? <ToolRunner
                // Remount per tool (clean state); when a shared ?s= result
                // arrives, the key flips to ":shared" so the runner re-inits
                // into the "done" view instead of staying on the idle form.
                key={`${selected.id}:${preload?.toolId === selected.id ? "shared" : "fresh"}`}
                tool={selected}
                onBack={clearSelected}
                cached={preload?.toolId === selected.id ? preload.data : null}
                onResult={(r) => saveResult(selected.id, r)}
              />
            : <div className="overflow-y-auto flex-1"><EmptyState
                tools={allTools}
                onSelect={selectTool}
                featuredIds={featuredIds}
                usage={usage}
                recentIds={[...cache.keys()]}
                search={search}
                setSearch={setSearch}
                cat={cat}
                setCat={setCat}
                filtered={filtered}
                onListTool={openSubmit}
                source={source}
                price={price}
                onClearFilters={() => { setSearch(""); setCat("all"); setSource("all"); setPrice("all"); }}
              /></div>
          }
        </main>

        </div>{/* end flex row */}
      </div>
    </>
  );
}
