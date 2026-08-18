"use client";

import { useState, useEffect, useRef, useCallback, KeyboardEvent } from "react";
import Link from "next/link";
import Navbar from "@/components/Navbar";
import { AGENT_TOOLS } from "@/lib/agent-tools";
import AppPageHeader from "@/components/app/AppPageHeader";

// ─── Types ────────────────────────────────────────────────────────────────────

type LineType = "input" | "output" | "error" | "system" | "success" | "ai" | "table" | "blank";

interface OutputLine {
  id: string;
  type: LineType;
  text: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const VERSION  = "1.0.0";
const NETWORK  = "Base Mainnet";
const CHAIN_ID = "eip155:8453";
const USDC     = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO   = "0x02950ad38ada1d599375bd447e080cd404809205";

const CAT_COLOR: Record<string, string> = {
  intelligence:    "#4FC3F7",
  builder:         "#A78BFA",
  trading:         "#34D399",
  security:        "#F87171",
  "agent-economy": "#FACC15",
  "base-ecosystem":"#60A5FA",
  "on-chain":      "#FB923C",
  content:         "#E879F9",
  investor:        "#FACC15",
};

const ALL_COMMANDS = [
  "help", "clear", "whoami", "version", "echo",
  "blue idea", "blue build", "blue audit", "blue ship", "blue raise",
  "blue hub ls", "blue hub info", "blue hub run",
  "blue balance", "blue score", "blue stats",
];

// Shorthand aliases — allow typing without "blue" prefix
const ALIASES: Record<string, string> = {
  idea: "blue idea", build: "blue build", audit: "blue audit",
  ship: "blue ship", raise: "blue raise",
  balance: "blue balance", score: "blue score", stats: "blue stats",
  hub: "blue hub",
};

const WELCOME_LINES: { type: LineType; text: string }[] = [
  { type: "system",  text: "Blue Terminal v" + VERSION + " · " + NETWORK + " · " + CHAIN_ID },
  { type: "output",  text: AGENT_TOOLS.length + " tools · x402 payments · Bankr LLM" },
  { type: "blank",   text: "" },
  { type: "success", text: "Type 'help' for available commands." },
  { type: "blank",   text: "" },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

let _id = 0;
const uid = () => String(++_id);

const mkLine = (type: LineType, text: string): OutputLine => ({ id: uid(), type, text });

const pad = (s: string, n: number) => s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);

// ─── Color map ────────────────────────────────────────────────────────────────

const LINE_COLOR: Record<LineType, string> = {
  input:   "#64748B",
  output:  "#CBD5E1",
  error:   "#F87171",
  system:  "#4FC3F7",
  success: "#34D399",
  ai:      "#E2E8F0",
  table:   "#94A3B8",
  blank:   "transparent",
};

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function TerminalPage({ inShell = false }: { inShell?: boolean }) {
  const [lines,   setLines]   = useState<OutputLine[]>(() =>
    WELCOME_LINES.map(w => ({ id: uid(), ...w }))
  );
  const [input,   setInput]   = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);
  const [busy,    setBusy]    = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef  = useRef<HTMLInputElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines]);

  const focusInput = () => inputRef.current?.focus();

  const push = useCallback((...newLines: OutputLine[]) => {
    setLines(prev => [...prev, ...newLines]);
  }, []);

  // typewriter for AI responses
  const typewrite = useCallback((text: string): Promise<void> => {
    return new Promise(resolve => {
      const lineId = uid();
      setLines(prev => [...prev, { id: lineId, type: "ai", text: "▌" }]);
      const words = text.split(" ");
      let built = "";
      let i = 0;
      const tick = () => {
        if (i >= words.length) {
          setLines(prev => prev.map(l => l.id === lineId ? { ...l, text: built } : l));
          resolve();
          return;
        }
        built += (i === 0 ? "" : " ") + words[i++];
        setLines(prev => prev.map(l => l.id === lineId ? { ...l, text: built + " ▌" } : l));
        setTimeout(tick, 11);
      };
      tick();
    });
  }, []);

  // ── Command processor ─────────────────────────────────────────────────────

  const runCommand = useCallback(async (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;

    // Expand shorthand aliases (e.g. "stats" → "blue stats foo" → "blue stats foo")
    const firstWord = trimmed.split(/\s+/)[0].toLowerCase();
    const cmd = ALIASES[firstWord]
      ? ALIASES[firstWord] + trimmed.slice(firstWord.length)
      : trimmed;

    push(mkLine("input", "> " + trimmed));
    setHistory(p => [trimmed, ...p.filter(h => h !== trimmed)].slice(0, 50));
    setHistIdx(-1);

    const parts = cmd.split(/\s+/);
    const verb  = parts[0].toLowerCase();
    const sub   = parts[1]?.toLowerCase() ?? "";
    const rest  = parts.slice(2).join(" ");
    const allRest = parts.slice(1).join(" ");

    // ── built-ins ─────────────────────────────────────────────────────────

    if (verb === "clear") {
      setLines(WELCOME_LINES.map(w => ({ id: uid(), ...w })));
      return;
    }

    if (verb === "echo") {
      push(mkLine("output", allRest));
      return;
    }

    if (verb === "version") {
      push(
        mkLine("blank", ""),
        mkLine("output", "  Blue Terminal   v" + VERSION),
        mkLine("output", "  Blue Hub        " + AGENT_TOOLS.length + " tools live"),
        mkLine("output", "  Protocol        x402 v2"),
        mkLine("output", "  Chain           Base Mainnet (8453)"),
        mkLine("blank", ""),
      );
      return;
    }

    if (verb === "whoami") {
      push(
        mkLine("blank", ""),
        mkLine("system",  "  SESSION"),
        mkLine("output",  "  Network      " + NETWORK + " · " + CHAIN_ID),
        mkLine("output",  "  LLM          Bankr LLM (Haiku / Sonnet)"),
        mkLine("output",  "  Tools        " + AGENT_TOOLS.length + " live on Blue Hub"),
        mkLine("output",  "  payTo        " + PAY_TO),
        mkLine("output",  "  Registry     ERC-8257 · agentic.market · CDP Bazaar"),
        mkLine("blank", ""),
      );
      return;
    }

    if (verb === "help") {
      push(
        mkLine("blank",   ""),
        mkLine("system",  "  SYSTEM"),
        mkLine("output",  "    help                       Show this help"),
        mkLine("output",  "    clear                      Clear terminal"),
        mkLine("output",  "    whoami                     Session info"),
        mkLine("output",  "    version                    Version info"),
        mkLine("output",  "    echo <text>                Echo text"),
        mkLine("blank",   ""),
        mkLine("system",  "  BLUE  ·  Bankr LLM"),
        mkLine("output",  "    blue idea  <prompt>        Fundable brief              $0.05"),
        mkLine("output",  "    blue build <prompt>        Architecture + stack        $0.50"),
        mkLine("output",  "    blue audit <prompt>        Security review             $1.00"),
        mkLine("output",  "    blue ship  <prompt>        Deploy checklist            $0.10"),
        mkLine("output",  "    blue raise <prompt>        Pitch narrative             $0.20"),
        mkLine("blank",   ""),
        mkLine("system",  "  BLUE HUB  ·  " + AGENT_TOOLS.length + " x402 tools"),
        mkLine("output",  "    blue hub ls                List all tools"),
        mkLine("output",  "    blue hub ls --cat <cat>    Filter by category"),
        mkLine("output",  "    blue hub info <id>         Tool details + pricing"),
        mkLine("output",  "    blue hub run  <id>         Open tool in Blue Hub"),
        mkLine("blank",   ""),
        mkLine("system",  "  ONCHAIN  ·  Base Mainnet"),
        mkLine("output",  "    blue balance [address]     ETH + USDC balance"),
        mkLine("output",  "    blue score   <handle>      Builder Score (0–100)"),
        mkLine("output",  "    blue stats                 Hub analytics"),
        mkLine("blank",   ""),
        mkLine("output",  "  ↑↓ history · Tab autocomplete · Ctrl+L clear"),
        mkLine("output",  "  Shortcuts: idea / build / audit / ship / raise / score / balance / stats"),
        mkLine("blank",   ""),
      );
      return;
    }

    // ── blue hub ──────────────────────────────────────────────────────────

    if (verb === "blue" && sub === "hub") {
      const hubSub = parts[2]?.toLowerCase();

      if (!hubSub || hubSub === "ls") {
        const catFilterIdx = parts.indexOf("--cat");
        const catFilter = catFilterIdx >= 0 ? parts[catFilterIdx + 1] : null;
        const tools = catFilter
          ? AGENT_TOOLS.filter(t => t.category === catFilter)
          : AGENT_TOOLS;

        if (!tools.length) {
          push(mkLine("error", "  No tools found for category: " + catFilter));
          return;
        }
        push(
          mkLine("blank",  ""),
          mkLine("system", catFilter
            ? "  " + catFilter.toUpperCase() + " — " + tools.length + " tools"
            : "  BLUE HUB — " + AGENT_TOOLS.length + " tools · x402 · Base Mainnet"
          ),
          mkLine("blank",  ""),
          mkLine("system", "  " + pad("ID", 32) + pad("CATEGORY", 18) + "PRICE"),
          mkLine("system", "  " + "─".repeat(55)),
          ...tools.map(t =>
            mkLine("table", "  " + pad(t.id, 32) + pad(t.category, 18) + (t.price ?? "free"))
          ),
          mkLine("blank",  ""),
          mkLine("output", "  " + tools.length + " tools · blue hub info <id> for details"),
          mkLine("blank",  ""),
        );
        return;
      }

      if (hubSub === "info") {
        const toolId = parts[3];
        if (!toolId) { push(mkLine("error", "  Usage: blue hub info <tool-id>")); return; }
        const t = AGENT_TOOLS.find(x => x.id === toolId);
        if (!t) { push(mkLine("error", "  Tool not found: " + toolId)); return; }
        push(
          mkLine("blank",   ""),
          mkLine("success", "  " + t.name),
          mkLine("output",  "  id          " + t.id),
          mkLine("output",  "  category    " + t.category),
          mkLine("output",  "  agent       " + t.agentName),
          mkLine("output",  "  price       " + (t.price ?? "free")),
          mkLine("output",  "  endpoint    /api/x402/" + t.id),
          mkLine("output",  "  manifest    /.well-known/ai-tool/" + t.id + ".json"),
          mkLine("blank",   ""),
          mkLine("output",  "  " + t.description),
          mkLine("blank",   ""),
          t.inputs?.length
            ? mkLine("output", "  inputs      " + t.inputs.map(i => i.key + (i.required ? "*" : "")).join(", "))
            : mkLine("output", "  inputs      none"),
          mkLine("blank",   ""),
          mkLine("system",  "  → blue hub run " + t.id),
          mkLine("blank",   ""),
        );
        void CAT_COLOR;
        return;
      }

      if (hubSub === "run") {
        const toolId = parts[3];
        if (!toolId) { push(mkLine("error", "  Usage: blue hub run <tool-id>")); return; }
        const t = AGENT_TOOLS.find(x => x.id === toolId);
        if (!t) { push(mkLine("error", "  Tool not found: " + toolId)); return; }
        push(
          mkLine("blank",   ""),
          mkLine("output",  "  Opening " + t.name + "…"),
          mkLine("output",  "  → /hub/" + t.id),
          mkLine("blank",   ""),
        );
        setTimeout(() => window.open("/app/hub/" + t.id, "_blank"), 500);
        return;
      }

      push(mkLine("error", "  Unknown: blue hub <ls|info|run>"));
      return;
    }

    // ── blue stats ────────────────────────────────────────────────────────

    if (verb === "blue" && sub === "stats") {
      setBusy(true);
      push(mkLine("system", "  Fetching Blue Hub analytics…"));
      try {
        const res = await fetch("/api/stats");
        if (!res.ok) throw new Error(String(res.status));
        const d = await res.json() as {
          totals: { tools: number; totalRuns: number; totalRevenueEst: number };
          rows: { name: string; runs: number; revenueEst: number }[];
        };
        push(
          mkLine("blank",   ""),
          mkLine("success", "  BLUE HUB ANALYTICS"),
          mkLine("blank",   ""),
          mkLine("output",  "  Tools live      " + d.totals.tools),
          mkLine("output",  "  Total runs      " + d.totals.totalRuns.toLocaleString()),
          mkLine("output",  "  Est. revenue    $" + d.totals.totalRevenueEst.toFixed(2)),
          mkLine("blank",   ""),
          mkLine("system",  "  TOP TOOLS"),
          ...d.rows.slice(0, 5).map((r, i) =>
            mkLine("output", "  " + (i + 1) + ". " + pad(r.name, 28) + pad(r.runs + " runs", 12) + "$" + r.revenueEst.toFixed(2))
          ),
          mkLine("blank",   ""),
          mkLine("output",  "  → blueagent.dev/hub/stats"),
          mkLine("blank",   ""),
        );
      } catch (e) {
        push(mkLine("error", "  Error: " + (e as Error).message));
      }
      setBusy(false);
      return;
    }

    // ── blue balance ──────────────────────────────────────────────────────

    if (verb === "blue" && sub === "balance") {
      const addr = rest.trim() || PAY_TO;
      setBusy(true);
      push(mkLine("system", "  Querying " + addr.slice(0, 10) + "… on Base mainnet…"));
      try {
        const rpc = async (body: object) => {
          const r = await fetch("https://mainnet.base.org", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          return r.json();
        };
        const ethData = await rpc({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [addr, "latest"] }) as { result?: string };
        const eth = ethData.result ? (parseInt(ethData.result, 16) / 1e18).toFixed(6) : "?";
        const callData = "0x70a08231" + addr.slice(2).padStart(64, "0");
        const usdcData = await rpc({ jsonrpc: "2.0", id: 2, method: "eth_call", params: [{ to: USDC, data: callData }, "latest"] }) as { result?: string };
        const usdc = usdcData.result ? (parseInt(usdcData.result, 16) / 1e6).toFixed(2) : "?";
        push(
          mkLine("blank",   ""),
          mkLine("success", "  BALANCE · Base Mainnet"),
          mkLine("blank",   ""),
          mkLine("output",  "  " + addr),
          mkLine("output",  "  ETH     " + eth),
          mkLine("output",  "  USDC    $" + usdc),
          mkLine("blank",   ""),
          mkLine("output",  "  → basescan.org/address/" + addr),
          mkLine("blank",   ""),
        );
      } catch (e) {
        push(mkLine("error", "  RPC error: " + (e as Error).message));
      }
      setBusy(false);
      return;
    }

    // ── blue score ────────────────────────────────────────────────────────

    if (verb === "blue" && sub === "score") {
      const handle = rest.trim();
      if (!handle) { push(mkLine("error", "  Usage: blue score <handle>")); return; }
      setBusy(true);
      push(mkLine("system", "  Fetching builder score for " + handle + "…"));
      try {
        const res = await fetch("/api/score?handle=" + encodeURIComponent(handle));
        if (!res.ok) throw new Error(String(res.status));
        const d = await res.json() as Record<string, unknown>;
        const score = (d.score ?? d.builderScore ?? d.total ?? "?") as string | number;
        push(
          mkLine("blank",   ""),
          mkLine("success", "  BUILDER SCORE — " + handle),
          mkLine("blank",   ""),
          mkLine("output",  "  Score   " + score + " / 100"),
          mkLine("blank",   ""),
        );
      } catch (e) {
        push(mkLine("error", "  Error: " + (e as Error).message));
      }
      setBusy(false);
      return;
    }

    // ── blue idea / build / audit / ship / raise ──────────────────────────

    const BLUE_SUB: Record<string, string> = {
      idea: "idea", build: "build", audit: "audit", ship: "ship", raise: "raise",
    };

    if (verb === "blue" && BLUE_SUB[sub]) {
      const prompt = rest.trim();
      if (!prompt) { push(mkLine("error", "  Usage: blue " + sub + " <prompt>")); return; }
      setBusy(true);
      push(
        mkLine("blank",  ""),
        mkLine("system", "  blue " + sub + " · Bankr LLM running…"),
        mkLine("blank",  ""),
      );
      try {
        const res = await fetch("/api/console", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command: BLUE_SUB[sub], prompt }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
          throw new Error(err.error ?? res.statusText);
        }
        const data = await res.json() as { result: string };
        const paras = (data.result ?? "").split(/\n\n+/);
        for (const para of paras) {
          const trimmed = para.trim();
          if (!trimmed) { push(mkLine("blank", "")); continue; }
          for (const sl of trimmed.split("\n")) {
            await typewrite(sl.trim());
          }
          push(mkLine("blank", ""));
        }
      } catch (e) {
        push(mkLine("error", "  Error: " + (e as Error).message));
      }
      setBusy(false);
      return;
    }

    // ── unknown ───────────────────────────────────────────────────────────
    const suggest = ALL_COMMANDS.find(c =>
      c.split(" ").some(w => w.startsWith(parts[0].toLowerCase()))
    );
    push(
      mkLine("error",  "  command not found: " + parts[0]),
      suggest
        ? mkLine("output", "  did you mean: " + suggest + "?  (type 'help' for all commands)")
        : mkLine("output", "  type 'help' to see available commands"),
    );
  }, [push, typewrite]);

  // ── Keyboard ──────────────────────────────────────────────────────────────

  const handleKey = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !busy) {
      const cmd = input.trim();
      setInput("");
      if (cmd) runCommand(cmd);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setHistIdx(prev => {
        const next = Math.min(prev + 1, history.length - 1);
        setInput(history[next] ?? "");
        return next;
      });
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHistIdx(prev => {
        const next = Math.max(prev - 1, -1);
        setInput(next === -1 ? "" : (history[next] ?? ""));
        return next;
      });
    }
    if (e.key === "Tab") {
      e.preventDefault();
      const lc = input.toLowerCase();
      // Try full prefix match first, then alias match, then last-word match
      const match =
        ALL_COMMANDS.find(c => c.startsWith(lc) && c !== lc) ??
        Object.keys(ALIASES).find(a => a.startsWith(lc) && a !== lc) ??
        ALL_COMMANDS.find(c => {
          const lastPart = c.split(" ").at(-1) ?? "";
          return lastPart.startsWith(lc) && c !== lc;
        });
      if (match) {
        // If matched an alias, expand to full command; else use as-is
        setInput((ALIASES[match] ?? match) + " ");
      }
    }
    if (e.key === "l" && e.ctrlKey) {
      e.preventDefault();
      setLines(WELCOME_LINES.map(w => ({ id: uid(), ...w })));
    }
  }, [busy, input, history, runCommand]);

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <>
      {!inShell && <Navbar />}

      <div className={`bg-[#050508] ${inShell ? "h-full flex flex-col overflow-hidden" : "min-h-screen pt-14"}`}>
        {/* grid bg */}
        {!inShell && (
          <div
            className="fixed inset-0 pointer-events-none"
            style={{
              backgroundImage:
                "linear-gradient(rgba(79,195,247,0.02) 1px,transparent 1px)," +
                "linear-gradient(90deg,rgba(79,195,247,0.02) 1px,transparent 1px)",
              backgroundSize: "40px 40px",
            }}
          />
        )}

        {/* ── Shell header (replaces breadcrumb when inside app shell) ── */}
        {inShell ? (
          <AppPageHeader
            label="TERMINAL"
            subtitle={`Base-native CLI · ${AGENT_TOOLS.length} tools · x402 · Bankr LLM`}
            accent="#4FC3F7"
            right={
              <div className="flex items-center gap-2">
                {busy && (
                  <span className="flex items-center gap-1.5 text-[10px] text-[#FACC15]">
                    <span className="w-1.5 h-1.5 rounded-full bg-[#FACC15] animate-pulse" />
                    running
                  </span>
                )}
                <span className="text-[10px] text-slate-700 border border-[#1A1A2E] rounded px-2 py-0.5">{NETWORK}</span>
                <span className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#34D399]" style={{ boxShadow: "0 0 6px #34D399" }} />
                  <span className="text-[10px] text-[#34D399]">live</span>
                </span>
              </div>
            }
          />
        ) : null}

        <div className={`relative ${inShell ? "flex-1 px-4 sm:px-6 py-4 overflow-hidden flex flex-col" : "max-w-5xl mx-auto px-4 sm:px-6 py-6"}`}>

          {/* ── Public page header (breadcrumb) ───────────────────────── */}
          {!inShell && (
            <div className="flex items-start justify-between mb-5">
              <div>
                {/* breadcrumb */}
                <div className="flex items-center gap-2 font-mono text-xs mb-3">
                  <Link href="/" className="text-slate-600 hover:text-[#4FC3F7] transition-colors">Home</Link>
                  <span className="text-slate-800">/</span>
                  <span className="text-slate-500">Terminal</span>
                </div>
                <div className="flex items-center gap-3 mb-1">
                  <h1 className="font-mono text-xl font-bold text-white tracking-tight">Blue Terminal</h1>
                  <span className="font-mono text-[10px] text-slate-700 border border-[#1A1A2E] rounded px-2 py-0.5">
                    v{VERSION}
                  </span>
                </div>
                <p className="font-mono text-[11px] text-slate-600">
                  Base-native CLI · {AGENT_TOOLS.length} tools · x402 payments · Bankr LLM
                </p>
              </div>

              {/* status badges */}
              <div className="flex items-center gap-2 shrink-0">
                {busy && (
                  <span className="flex items-center gap-1.5 font-mono text-[10px] text-[#FACC15]">
                    <span className="w-1.5 h-1.5 rounded-full bg-[#FACC15] animate-pulse" />
                    running
                  </span>
                )}
                <span className="font-mono text-[10px] text-slate-700 border border-[#1A1A2E] rounded px-2 py-0.5">
                  {NETWORK} · {CHAIN_ID}
                </span>
                <span className="flex items-center gap-1.5">
                  <span
                    className="w-1.5 h-1.5 rounded-full bg-[#34D399]"
                    style={{ boxShadow: "0 0 6px #34D399" }}
                  />
                  <span className="font-mono text-[10px] text-[#34D399]">live</span>
                </span>
              </div>
            </div>
          )}

          {/* ── Terminal window ───────────────────────────────────────── */}
          <div
            className={`rounded-xl border border-[#1A1A2E] bg-[#0A0A12] overflow-hidden flex flex-col ${inShell ? "flex-1" : ""}`}
            style={inShell ? undefined : { height: "calc(100vh - 220px)", minHeight: "480px" }}
            onClick={focusInput}
          >
            {/* window chrome */}
            <div className="flex items-center gap-2 px-4 py-2.5 border-b border-[#1A1A2E] bg-[#080810] shrink-0">
              <span className="w-2.5 h-2.5 rounded-full bg-[#F87171]/60" />
              <span className="w-2.5 h-2.5 rounded-full bg-[#FACC15]/60" />
              <span className="w-2.5 h-2.5 rounded-full bg-[#34D399]/60" />
              <span className="flex-1" />
              <span className="font-mono text-[10px] text-slate-700">blue@terminal:~</span>
            </div>

            {/* output */}
            <div className="flex-1 overflow-y-auto px-4 py-4 space-y-0.5 font-mono">
              {lines.map(l => {
                if (l.type === "blank") return <div key={l.id} className="h-1.5" />;
                return (
                  <div
                    key={l.id}
                    className="text-[12px] leading-[1.65] whitespace-pre-wrap break-all"
                    style={{ color: LINE_COLOR[l.type] }}
                  >
                    {l.text}
                  </div>
                );
              })}
              <div ref={bottomRef} />
            </div>

            {/* input row */}
            <div className="shrink-0 border-t border-[#1A1A2E] bg-[#080810] px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="font-mono text-[12px] text-[#4FC3F7] shrink-0 select-none">
                  blue@terminal:~$
                </span>
                <input
                  ref={inputRef}
                  type="text"
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={handleKey}
                  disabled={busy}
                  autoFocus
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  placeholder={busy ? "running…" : ""}
                  className="flex-1 bg-transparent outline-none font-mono text-[12px] text-slate-200 placeholder:text-slate-800 caret-[#4FC3F7] disabled:opacity-30"
                />
              </div>
              <div className="flex gap-4 mt-1 pl-[148px]">
                <span className="font-mono text-[9px] text-[#1A1A2E]">↑↓ history</span>
                <span className="font-mono text-[9px] text-[#1A1A2E]">Tab autocomplete</span>
                <span className="font-mono text-[9px] text-[#1A1A2E]">Ctrl+L clear</span>
              </div>
            </div>
          </div>

          {/* ── Quick commands ────────────────────────────────────────── */}
          <div className="mt-4 flex flex-wrap gap-2">
            {[
              { label: "help",               cmd: "help" },
              { label: "blue hub ls",        cmd: "blue hub ls" },
              { label: "blue stats",         cmd: "blue stats" },
              { label: "blue idea …",        cmd: "blue idea " },
              { label: "blue audit …",       cmd: "blue audit " },
              { label: "blue balance",       cmd: "blue balance" },
            ].map(q => (
              <button
                key={q.cmd}
                onClick={() => {
                  setInput(q.cmd);
                  if (!q.cmd.endsWith(" ")) {
                    setTimeout(() => runCommand(q.cmd), 0);
                  }
                  focusInput();
                }}
                className="font-mono text-[10px] px-2.5 py-1 rounded border border-[#1A1A2E] text-slate-600 hover:text-[#4FC3F7] hover:border-[#4FC3F7]/30 transition-colors bg-[#0A0A12]"
              >
                {q.label}
              </button>
            ))}
          </div>

        </div>
      </div>
    </>
  );
}
