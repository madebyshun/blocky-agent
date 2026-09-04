"use client";
import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useChat } from "../ChatContext";
import { ToolResultCard } from "./ToolCards";
import ArtifactCard from "./ArtifactCard";
import { isArtifactCardLang } from "../artifacts";
import { useLang } from "@/lib/i18n/context";
import TopUpModal from "@/components/TopUpModal";

// B20 education starters — shown ONLY in the empty state when the UI language is
// Chinese (zh). These send a plain question that the chat's B20 Education Mode
// answers in 简体中文 from verified facts (no tool call, no fabrication).
const ZH_B20_PROMPTS = [
  "B20 和 ERC-20 有什么区别？",
  "如何在 Base 上发行 B20 代币？",
  "解释 B20 的角色权限",
  "B20 转账策略如何工作？",
];

// ── Animated dot ──────────────────────────────────────────────────────────────

function Dot({ delay }: { delay: number }) {
  return (
    <span
      style={{
        display: "inline-block", width: 5, height: 5,
        borderRadius: "50%", background: "#475569",
        animation: `pulse 1.2s ${delay}ms ease-in-out infinite`,
      }}
    />
  );
}

// ── Time formatter ────────────────────────────────────────────────────────────

function fmtTime(ts?: number): string {
  if (!ts) return "";
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ── Venice thinking block ─────────────────────────────────────────────────────

function ThinkingBlock({ content, isStreaming = false }: { content: string; isStreaming?: boolean }) {
  const [open, setOpen] = useState(false);
  const lines = content.trim().split("\n").filter(Boolean).length;

  return (
    <div className="mb-4 rounded-xl border border-[#1E1E30] overflow-hidden">
      <button
        onClick={() => !isStreaming && setOpen(o => !o)}
        className="w-full flex items-center gap-2.5 px-3.5 py-2.5 bg-[#0B0B16] hover:bg-[#0E0E1C] transition-colors text-left"
      >
        <span className="text-[13px]">🧠</span>
        <span className="font-mono text-[10px] text-slate-500 tracking-wide flex-1">
          {isStreaming ? "Reasoning…" : `Thinking · ${lines} line${lines !== 1 ? "s" : ""}`}
        </span>
        {isStreaming
          ? <span className="flex gap-1 mr-1"><Dot delay={0} /><Dot delay={160} /><Dot delay={320} /></span>
          : <span className="font-mono text-[10px] text-slate-700 select-none">{open ? "▲" : "▼"}</span>
        }
      </button>
      {(open || isStreaming) && content && (
        <div className="px-4 py-3.5 border-t border-[#1E1E30] bg-[#060610]">
          <p className="font-mono text-[12px] text-slate-600 leading-relaxed whitespace-pre-wrap break-words">
            {content}
          </p>
        </div>
      )}
    </div>
  );
}

// ── Inline markdown ───────────────────────────────────────────────────────────

function renderInline(text: string): React.ReactNode[] {
  const re = /(\*\*(.+?)\*\*|\*([^*\n]+)\*|`([^`\n]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))/g;
  const result: React.ReactNode[] = [];
  let last = 0, match: RegExpExecArray | null, idx = 0;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) result.push(text.slice(last, match.index));
    idx++;
    if (match[2] !== undefined)
      result.push(<strong key={idx} className="font-semibold text-white">{match[2]}</strong>);
    else if (match[3] !== undefined)
      result.push(<em key={idx} className="italic text-slate-200">{match[3]}</em>);
    else if (match[4] !== undefined)
      result.push(
        <code key={idx}
          className="font-mono bg-[#1A1A2E] text-[#7DD3FC] px-1.5 py-0.5 rounded border border-[#252540]"
          style={{ fontSize: "0.84em" }}>
          {match[4]}
        </code>
      );
    else if (match[5] !== undefined)
      result.push(
        <a key={idx} href={match[6]} target="_blank" rel="noopener noreferrer"
          className="text-[#4FC3F7] underline underline-offset-2 decoration-[#4FC3F740] hover:decoration-[#4FC3F7] transition-colors">
          {match[5]}
        </a>
      );
    last = match.index + match[0].length;
  }
  if (last < text.length) result.push(text.slice(last));
  return result;
}

// ── Block markdown renderer ───────────────────────────────────────────────────

/**
 * Trust chip rendered above the message body when the upstream model
 * actually browsed the web. Click toggles a source list — each entry is a
 * direct link to the page Anthropic surfaced so the user can verify the
 * claim rather than trust the prose alone.
 */
function WebSearchChip({ ws }: {
  ws: { provider: string; sources: number; urls?: Array<{ url: string; title: string }> }
}) {
  const [open, setOpen] = useState(false);
  const hasLinks = !!ws.urls?.length;
  return (
    <div className="mb-1.5 rounded-lg border overflow-hidden"
         style={{ borderColor: "#22C55E20", background: "#22C55E07" }}>
      <button
        onClick={() => hasLinks && setOpen(o => !o)}
        disabled={!hasLinks}
        className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-white/[0.02] transition-colors disabled:cursor-default text-left">
        <span className="text-xs shrink-0">🌐</span>
        <span className="font-mono text-[10px] font-semibold shrink-0" style={{ color: "#22C55E" }}>
          Web Search
        </span>
        <span className="font-mono text-[10px] text-slate-500 flex-1 truncate capitalize">
          {ws.provider}
        </span>
        <span className="font-mono text-[9px] shrink-0" style={{ color: "#22C55E" }}>
          ✓ {ws.sources} source{ws.sources === 1 ? "" : "s"}
        </span>
        {hasLinks && (
          <span className={`text-slate-600 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}>▾</span>
        )}
      </button>
      {open && hasLinks && (
        <div className="border-t border-[#22C55E15] bg-[#0a0a0f]/40 px-3 py-2 space-y-1">
          {ws.urls!.map((s, i) => {
            let host = "";
            try { host = new URL(s.url).host.replace(/^www\./, ""); } catch {}
            return (
              <a key={i} href={s.url} target="_blank" rel="noopener noreferrer"
                 className="flex items-baseline gap-2 hover:bg-white/[0.02] rounded px-1.5 py-1 -mx-1.5 transition-colors group">
                <span className="font-mono text-[9px] text-slate-700 shrink-0 w-4 text-right">{i + 1}.</span>
                <span className="font-mono text-[11px] text-slate-300 truncate flex-1 group-hover:text-[#22C55E] transition-colors">
                  {s.title}
                </span>
                {host && (
                  <span className="font-mono text-[9px] text-slate-700 shrink-0">{host}</span>
                )}
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Splits assistant content into the main markdown body and the trailing
 * follow-up suggestions. The system prompt asks the model to append 2-3
 * lines prefixed with "↳ " at the very end; this helper finds the first
 * contiguous run of those lines anchored at the end of the message and
 * lifts them out so the UI can render them as clickable chips.
 *
 * Tolerant to: leading whitespace on the marker line, the model wrapping
 * follow-ups in a bullet list (e.g. "- ↳ ..."), or trailing whitespace.
 * If no follow-ups are present the body is returned unchanged.
 */
function splitFollowups(content: string): { body: string; followups: string[] } {
  const lines = content.split("\n");
  const followups: string[] = [];
  let lastBodyEnd = lines.length;

  // Walk from the end and consume "↳ ..." lines plus the blank lines between
  // them. Stop at the first non-followup, non-blank line.
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i];
    const trim = raw.trim();
    if (!trim) continue;                                     // skip blanks
    const m = trim.match(/^(?:[-*]\s+)?↳\s*(.+)$/);
    if (m) {
      followups.unshift(m[1].trim().replace(/[.,;:]+$/, "")); // drop trailing punctuation
      lastBodyEnd = i;
      continue;
    }
    break;
  }

  return {
    body:      lines.slice(0, lastBodyEnd).join("\n").trimEnd(),
    followups: followups.slice(0, 4),                         // hard cap, model can over-shoot
  };
}

export function MarkdownRenderer({ content }: { content: string }) {
  const lines = content.split("\n");
  const elems: React.ReactNode[] = [];
  let i = 0;
  let listType: "ul" | "ol" | null = null;
  let listItems: React.ReactNode[] = [];

  function flushList() {
    if (!listItems.length) return;
    elems.push(
      listType === "ul"
        ? <ul key={`ul-${i}`} className="my-3 space-y-2">{listItems}</ul>
        : <ol key={`ol-${i}`} className="my-3 space-y-2">{listItems}</ol>
    );
    listItems = []; listType = null;
  }

  function tryTable(): boolean {
    if (!lines[i]?.trim().startsWith("|")) return false;
    const sepLine = lines[i + 1] ?? "";
    if (!sepLine.match(/^\|[\s\-|:]+\|?\s*$/)) return false;
    const headers  = lines[i].split("|").map(s => s.trim()).filter(Boolean);
    const dataRows: string[][] = [];
    let j = i + 2;
    while (j < lines.length && lines[j].trim().startsWith("|")) {
      dataRows.push(lines[j].split("|").map(s => s.trim()).filter(Boolean));
      j++;
    }
    elems.push(
      <div key={`tbl-${i}`} className="my-4 overflow-x-auto rounded-xl border border-[#1E1E32]">
        <table className="w-full font-mono text-[13px]">
          <thead className="bg-[#0D0D18]">
            <tr>{headers.map((h, hi) => (
              <th key={hi} className="px-4 py-2.5 text-left text-slate-400 font-semibold border-b border-[#1E1E32] whitespace-nowrap">
                {renderInline(h)}
              </th>
            ))}</tr>
          </thead>
          <tbody>{dataRows.map((row, ri) => (
            <tr key={ri} className={ri % 2 === 0 ? "bg-[#08080F]" : "bg-[#0A0A14]"}>
              {row.map((cell, ci) => (
                <td key={ci} className="px-4 py-2.5 text-slate-300 border-b border-[#141420]">
                  {renderInline(cell)}
                </td>
              ))}
            </tr>
          ))}</tbody>
        </table>
      </div>
    );
    i = j - 1;
    return true;
  }

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith("```")) {
      flushList();
      const lang = line.slice(3).trim();
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) { code.push(lines[i]); i++; }
      const codeStr = code.join("\n");
      // Substantial code in a supported language → render as an artifact card
      // (filename, preview, Preview/Download/Open). Otherwise a plain block.
      if (isArtifactCardLang(lang) && code.length > 20) {
        elems.push(<ArtifactCard key={`art-${i}`} lang={lang} code={codeStr} />);
      } else {
        elems.push(
          <div key={`code-${i}`} className="my-4 rounded-xl overflow-hidden border border-[#1E1E32] group/code">
            <div className="flex items-center justify-between px-4 py-1.5 bg-[#0B0B16] border-b border-[#1E1E32]">
              <span className="font-mono text-[10px] text-slate-500 tracking-widest uppercase">{lang || "code"}</span>
              <button onClick={() => navigator.clipboard?.writeText(codeStr)}
                className="font-mono text-[10px] text-slate-700 hover:text-[#4FC3F7] transition-colors opacity-0 group-hover/code:opacity-100">
                copy
              </button>
            </div>
            <pre className="px-4 py-4 overflow-x-auto bg-[#050510]">
              <code className="font-mono text-[13px] text-slate-200 leading-relaxed">{codeStr}</code>
            </pre>
          </div>
        );
      }
      i++; continue;
    }

    flushList();
    if (tryTable()) { i++; continue; }

    const h1 = line.match(/^# (.+)/);
    const h2 = line.match(/^## (.+)/);
    const h3 = line.match(/^### (.+)/);
    const h4 = line.match(/^#### (.+)/);

    if (h1) {
      elems.push(<h1 key={i} className="text-[22px] font-bold text-white mt-6 mb-3 pb-2 border-b border-[#1A1A2E] leading-tight">{renderInline(h1[1])}</h1>);
    } else if (h2) {
      elems.push(<h2 key={i} className="text-[18px] font-bold text-white mt-5 mb-2.5 leading-tight">{renderInline(h2[1])}</h2>);
    } else if (h3) {
      elems.push(<h3 key={i} className="text-[15px] font-semibold text-slate-100 mt-4 mb-2 leading-tight">{renderInline(h3[1])}</h3>);
    } else if (h4) {
      elems.push(<h4 key={i} className="text-[12px] font-semibold text-slate-500 mt-3 mb-1.5 uppercase tracking-widest">{renderInline(h4[1])}</h4>);
    } else if (/^---+$/.test(line.trim())) {
      elems.push(<hr key={i} className="border-[#1E1E32] my-5" />);
    } else if (line.startsWith("> ")) {
      elems.push(
        <blockquote key={i} className="my-3 pl-4 border-l-2 border-[#4FC3F740] text-slate-400 italic text-[14px] leading-relaxed">
          {renderInline(line.slice(2))}
        </blockquote>
      );
    } else if (/^[-*] (.+)/.test(line)) {
      const text = line.match(/^[-*] (.+)/)![1];
      if (listType !== "ul") { flushList(); listType = "ul"; }
      listItems.push(
        <li key={i} className="flex gap-2.5 text-slate-300 leading-relaxed text-[15px]">
          <span className="text-slate-600 mt-[6px] shrink-0" style={{ fontSize: 8 }}>●</span>
          <span>{renderInline(text)}</span>
        </li>
      );
    } else if (/^  [-*] (.+)/.test(line)) {
      const text = line.match(/^  [-*] (.+)/)![1];
      if (listType !== "ul") { flushList(); listType = "ul"; }
      listItems.push(
        <li key={i} className="flex gap-2.5 text-slate-400 leading-relaxed text-[14px] ml-5">
          <span className="text-slate-700 mt-[6px] shrink-0" style={{ fontSize: 7 }}>○</span>
          <span>{renderInline(text)}</span>
        </li>
      );
    } else if (/^\d+\. (.+)/.test(line)) {
      const text = line.match(/^\d+\. (.+)/)![1];
      const num  = line.match(/^(\d+)\./)![1];
      if (listType !== "ol") { flushList(); listType = "ol"; }
      listItems.push(
        <li key={i} className="flex gap-2.5 text-slate-300 leading-relaxed text-[15px]">
          <span className="text-slate-500 shrink-0 font-mono text-[12px] w-5 text-right mt-px">{num}.</span>
          <span>{renderInline(text)}</span>
        </li>
      );
    } else if (line.trim() === "") {
      flushList();
    } else {
      flushList();
      elems.push(
        <p key={i} className="text-[15px] text-slate-300 leading-[1.75]">{renderInline(line)}</p>
      );
    }
    i++;
  }

  flushList();
  return <div className="space-y-2.5">{elems}</div>;
}

// ── Model label / color maps ───────────────────────────────────────────────────

// Pre-merge task #4 — label bug. Bankr was banned 2026-07-18; every
// non-venice tier now routes to Virtuals with model
// `anthropic-claude-sonnet-5` (server-side `VIRTUALS_CHAT_DEFAULT_MODEL`
// env, default sonnet-5). The old map showed "Claude Haiku 4.5" for
// `fast` tier while the request was actually served by Sonnet 5 via
// Virtuals — pure lie. Every non-venice tier now points at the ACTUAL
// runtime label so the footer + system-prompt `modelLine` agree.
// When Virtuals tiers diverge (fast → haiku on Virtuals, etc.) update
// this map to match — or better, drive it from an SSE `model_used`
// event the server emits per-message (follow-up).
const NON_VENICE_LABEL = "Sonnet 5 · Virtuals";
const MODEL_LABELS: Record<string, string> = {
  fast: NON_VENICE_LABEL, pro: NON_VENICE_LABEL, max: NON_VENICE_LABEL,
  deepseek: NON_VENICE_LABEL,
  "venice-deepseek": "DeepSeek V4 Flash", "venice-deepseek-pro": "DeepSeek V4 Pro",
  "venice-kimi": "Kimi K2", "venice-claude": "Claude Opus 4",
  "venice-grok": "Grok 4", "venice-qwen": "Qwen3 235B",
  "venice-fable": "Fable 5",
  "venice-mistral": "Mistral Small", "venice-uncut": "Uncensored",
  "venice-e2ee-venice": "Private Venice", "venice-e2ee-gemma": "Private Gemma",
  "venice-e2ee-qwen": "Private Qwen",
};

const MODEL_COLORS: Record<string, string> = {
  fast: "#64748b", pro: "#4FC3F7", max: "#A78BFA",
  "venice-deepseek": "#34D399", "venice-deepseek-pro": "#2DD4BF",
  "venice-kimi": "#818CF8", "venice-claude": "#F472B6",
  "venice-grok": "#E879F9", "venice-qwen": "#FB923C",
  "venice-mistral": "#60A5FA", "venice-uncut": "#F59E0B",
  "venice-e2ee-venice": "#6EE7B7", "venice-e2ee-gemma": "#6EE7B7",
  "venice-e2ee-qwen": "#6EE7B7",
};

// ── Starters ──────────────────────────────────────────────────────────────────
// `label` = compact display; `text` = the natural language prompt sent on click.
// Cards send immediately — they are plain English questions, not slash commands.
interface Starter { icon: string; label: string; text: string; color: string; }
interface EmptyState { heading: string; sub: string; starters: Starter[]; examples: string[]; }

const EMPTY_STATE: EmptyState = {
  heading: "What are you building?",
  sub:     "Build anything on Base",
  examples: [
    "build me a DeFi app on Base",
    "launch a token called BlueBot",
    "what's trending on Base today?",
  ],
  starters: [
    { icon: "💡", label: "Idea",   text: "idea brief: USDC payroll app for freelancers on Base", color: "#4FC3F7" },
    { icon: "🛠️", label: "Build",  text: "build an ERC-4337 agent wallet on Base",               color: "#A78BFA" },
    { icon: "🛡️", label: "Audit",  text: "audit my token launch plan for risks",                 color: "#F87171" },
    { icon: "🚀", label: "Launch", text: "launch a token called BlueBot on Base",                color: "#34D399" },
  ],
};

// ── Main ──────────────────────────────────────────────────────────────────────

export default function ChatMessages() {
  const {
    activeTask, streaming, outOfCredits, send, setInput, chatTier,
    triggerWalletRefresh,
  } = useChat();

  // Top-up modal — a single instance lifted to the component root so the inline
  // "credits low" notice (rendered per-message in the map below) can open it
  // without spawning one modal per message.
  const [topUpOpen, setTopUpOpen] = useState(false);

  const bottomRef  = useRef<HTMLDivElement>(null);
  const messages   = activeTask?.messages ?? [];
  const isEmpty    = messages.length === 0;
  const tierColor  = MODEL_COLORS[chatTier] ?? "#4FC3F7";
  const empty      = EMPTY_STATE;
  const { lang }   = useLang();

  // ── Share conversation ────────────────────────────────────────────────────
  const [shareStatus, setShareStatus] = useState<"idle" | "loading" | "copied">("idle");

  const shareConversation = async () => {
    if (!activeTask || streaming || shareStatus === "loading") return;
    setShareStatus("loading");
    try {
      const res = await fetch("/api/chat/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title:    activeTask.title || "Shared conversation",
          messages: activeTask.messages,
        }),
      });
      if (!res.ok) throw new Error("share failed");
      const { id } = await res.json() as { id: string };
      const url = `${window.location.origin}/share/${id}`;
      await navigator.clipboard.writeText(url);
      setShareStatus("copied");
      setTimeout(() => setShareStatus("idle"), 2500);
    } catch {
      setShareStatus("idle");
    }
  };

  // Thinking timer
  const [elapsed, setElapsed] = useState(0);
  const timerStart = useRef<number | null>(null);

  useEffect(() => {
    if (streaming) {
      timerStart.current = Date.now();
      setElapsed(0);
      const id = setInterval(() => {
        if (timerStart.current !== null)
          setElapsed(Math.floor((Date.now() - timerStart.current) / 1000));
      }, 500);
      return () => clearInterval(id);
    } else {
      timerStart.current = null;
    }
  }, [streaming]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  return (
    <div className="flex-1 overflow-y-auto flex flex-col">
      {isEmpty ? (
        /* ── Empty state ─────────────────────────────────────────────────── */
        <div className="flex-1 flex flex-col items-center justify-center px-6 py-6 sm:py-10 text-center">

          {/* Logo + wordmark */}
          <div className="flex items-center gap-3 mb-6">
            <img src="/logomark.svg" alt="Blue Agent" width={48} height={48} className="rounded-2xl shrink-0" />
            <span className="font-mono text-2xl font-bold tracking-widest">
              BLUE<span style={{ color: "#4FC3F7" }}>AGENT</span>
            </span>
          </div>

          {/* Heading */}
          <h2 className="font-mono text-2xl sm:text-3xl font-bold text-white tracking-tight mb-2">
            {empty.heading}
          </h2>
          <p className="font-mono text-sm text-slate-600 mb-8">
            {empty.sub}
          </p>

          {/* NL example starters */}
          <div className="w-full max-w-sm space-y-2 mb-6">
            {empty.examples.map(q => (
              <div
                key={q}
                className="w-full text-left font-mono text-[11px] px-3 py-2 rounded-xl text-slate-500 cursor-default select-none"
                style={{ background: "#0d0d12", border: "1px solid #1A1A2E" }}
              >
                {q}
              </div>
            ))}
          </div>

          {/* B20 education prompts — Chinese builders only. Clickable → sends the
              question, answered in 简体中文 by B20 Education Mode. */}
          {lang === "zh" && (
            <div className="w-full max-w-sm mb-6">
              <p className="font-mono text-[10px] text-slate-600 mb-2 tracking-widest uppercase">
                B20 学习
              </p>
              <div className="grid grid-cols-1 gap-2">
                {ZH_B20_PROMPTS.map(q => (
                  <button
                    key={q}
                    onClick={() => !streaming && send(q)}
                    disabled={streaming || outOfCredits}
                    className="w-full text-left font-mono text-[11px] px-3 py-2 rounded-xl text-slate-300 transition-colors disabled:opacity-40 hover:border-[#4FC3F7]/40"
                    style={{ background: "#0d0d12", border: "1px solid #1A1A2E" }}
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}

          {outOfCredits && (
            <p className="font-mono text-[10px] text-red-400 mt-2">Out of credits — resets daily · connect a wallet for 500/day</p>
          )}
        </div>
      ) : (
        /* ── Message list ────────────────────────────────────────────────── */
        <div className="w-full max-w-4xl mx-auto px-4 sm:px-6 py-6 space-y-1">

          {/* Share bar — top-right, only when ≥1 completed assistant turn */}
          {messages.some(m => m.role === "assistant" && m.content) && (
            <div className="flex justify-end mb-2">
              <button
                onClick={shareConversation}
                disabled={streaming || shareStatus === "loading"}
                className="inline-flex items-center gap-1.5 font-mono text-[10px] px-2.5 py-1 rounded-lg border transition-all disabled:opacity-40"
                style={shareStatus === "copied"
                  ? { borderColor: "#34D39940", background: "#34D39910", color: "#34D399" }
                  : { borderColor: "#1A1A2E", background: "#08080F", color: "#64748b" }
                }
              >
                {shareStatus === "loading" ? (
                  <>
                    <span className="w-2.5 h-2.5 border border-slate-600 border-t-transparent rounded-full animate-spin" />
                    sharing…
                  </>
                ) : shareStatus === "copied" ? (
                  <>✓ Link copied</>
                ) : (
                  <>
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
                    </svg>
                    Share
                  </>
                )}
              </button>
            </div>
          )}

          {messages.map((msg, i) => {
            const isAssistant = msg.role === "assistant";

            return (
              <div key={i}
                className={`group/row flex gap-3 px-2 py-1.5 rounded-xl transition-colors hover:bg-white/[0.015] ${
                  isAssistant ? "" : "justify-end"
                }`}
              >
                {/* ── Content column ──────────────────────────────────────── */}
                <div className={`flex-1 min-w-0 ${isAssistant ? "" : "flex flex-col items-end"}`}>

                  {/* Name + timestamp header — logo inline with name */}
                  <div className={`flex items-center gap-2 mb-1.5 ${isAssistant ? "" : "flex-row-reverse"}`}>
                    {isAssistant && (
                      <img
                        src="/logomark.svg"
                        alt="Blue Agent"
                        width={20} height={20}
                        className="rounded-md shrink-0"
                      />
                    )}
                    <span className="font-mono text-[12px] font-bold text-white">
                      {isAssistant ? "Blue Agent" : "You"}
                    </span>
                    {msg.createdAt && (
                      <span className="font-mono text-[10px] text-slate-700">
                        {fmtTime(msg.createdAt)}
                      </span>
                    )}
                  </div>

                  {/* ── Assistant message body ────────────────────────────── */}
                  {isAssistant ? (
                    <div className="group/msg relative">

                      {/* Web search trust chip — emitted whenever the upstream
                          model actually browsed (Anthropic server tool, or a
                          Venice model with browsing flag confirmed). Click
                          to expand the source list when URLs are available. */}
                      {msg.webSearch && msg.webSearch.sources > 0 && (
                        <WebSearchChip ws={msg.webSearch} />
                      )}

                      {/* Tool execution logs + result cards */}
                      {!!msg.toolLogs?.length && (
                        <div className="flex flex-col gap-1.5 mb-4">
                          {msg.toolLogs.map((log, j) => (
                            // No tool-exec chip. The provider badge
                            // ("⚡ Blue Agent · <tool> ✓ 1.2s") was noise above
                            // every result; #139 dropped it for the action cards,
                            // and we now drop it for ALL tools/skills. A skill
                            // speaks through its result card (or the answer text);
                            // "still working" is shown by the streaming dots
                            // below, so no progress signal is lost.
                            <React.Fragment key={j}>
                              {log.status === "done" && log.result != null && (
                                <ToolResultCard tool={log.tool} result={log.result as Record<string, unknown>} />
                              )}
                            </React.Fragment>
                          ))}
                        </div>
                      )}

                      {/* Venice thinking block */}
                      {msg.thinkingContent !== undefined && (
                        <ThinkingBlock content={msg.thinkingContent} isStreaming={msg.isThinking === true} />
                      )}

                      {/* Main content. The system prompt asks the model to
                          append follow-up suggestions on their own lines
                          prefixed with "↳ "; we split those off before
                          rendering so the body stays clean markdown and the
                          follow-ups can render as clickable suggestion chips
                          below. */}
                      {msg.content ? (
                        (() => {
                          const { body, followups } = splitFollowups(msg.content);
                          return (
                            <>
                              <div className="font-mono">
                                <MarkdownRenderer content={body} />
                              </div>
                              {followups.length > 0 && (
                                <div className="mt-3 flex flex-col gap-1.5">
                                  {followups.map((q, k) => (
                                    <button key={k} onClick={() => send(q)}
                                      className="group/sg flex items-center gap-2 text-left font-mono text-[12px] text-slate-400 hover:text-[#4FC3F7] transition-colors">
                                      <span className="text-slate-700 group-hover/sg:text-[#4FC3F7] transition-colors">↳</span>
                                      <span className="underline-offset-4 group-hover/sg:underline">{q}</span>
                                    </button>
                                  ))}
                                </div>
                              )}
                            </>
                          );
                        })()
                      ) : !msg.thinkingContent ? (
                        <span className="flex gap-1.5 items-center mt-1">
                          <Dot delay={0} /><Dot delay={160} /><Dot delay={320} />
                          {streaming && elapsed > 0 && (
                            <span className="font-mono text-[10px] text-slate-700 ml-1">{elapsed}s</span>
                          )}
                        </span>
                      ) : null}

                      {/* Response metadata + cost summary */}
                      {msg.modelUsed && msg.responseMs !== undefined && (
                        <div className="flex items-center gap-2 mt-3 flex-wrap">
                          <span className="w-1.5 h-1.5 rounded-full shrink-0"
                            style={{ background: MODEL_COLORS[msg.modelUsed] ?? "#4FC3F7" }} />
                          <span className="font-mono text-[10px] text-slate-700">
                            {MODEL_LABELS[msg.modelUsed] ?? msg.modelUsed}
                          </span>
                          <span className="font-mono text-[10px] text-slate-800">·</span>
                          <span className="font-mono text-[10px] text-slate-700">
                            {(msg.responseMs / 1000).toFixed(1)}s
                          </span>
                          {!!msg.toolLogs?.length && (
                            <>
                              <span className="font-mono text-[10px] text-slate-800">·</span>
                              <span className="font-mono text-[10px] text-slate-700">
                                {msg.toolLogs.length} tool{msg.toolLogs.length > 1 ? "s" : ""}
                              </span>
                            </>
                          )}
                          {(() => {
                            const msgCr = msg.creditsUsed ?? 0;
                            const toolCr = (msg.toolLogs ?? []).reduce((s, l) => s + (l.credits ?? 0), 0);
                            const total = msgCr + toolCr;
                            // No charge (Max tier, a free model, or a blocked/
                            // refunded turn) → show nothing. A "Free" chip just
                            // adds noise; only surface a chip when cr was spent.
                            if (total <= 0) return null;
                            // Show breakdown when both pieces contributed,
                            // collapsed to a single number when only one did
                            // (avoids "50 + 0 = 50" noise on tool-free turns).
                            const showBreakdown = msgCr > 0 && toolCr > 0;
                            return (
                              <span
                                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-mono text-[9px] font-semibold"
                                style={{ background: "#4FC3F715", color: "#4FC3F7" }}
                                title={showBreakdown ? `${msgCr} cr chat + ${toolCr} cr tools` : undefined}
                              >
                                ⚡ {total} cr
                                {showBreakdown && (
                                  <span className="text-[#4FC3F7]/60 font-normal">
                                    ({msgCr}+{toolCr})
                                  </span>
                                )}
                              </span>
                            );
                          })()}
                        </div>
                      )}

                      {/* Insufficient-credits notice — rendered inline when the
                          chat or tool ledger debit hit an empty balance. Credits
                          reset daily and connecting any wallet raises the daily
                          allowance; the USDC credit-pack top-up lands next. The
                          link points at the credits doc so users have a path
                          forward. */}
                      {msg.insufficientCredits && (
                        <div className="mt-2 rounded-xl border border-[#F59E0B]/30 bg-[#F59E0B]/[0.06] px-3 py-2.5">
                          <div className="flex items-start gap-2.5">
                            <span className="text-[#F59E0B] shrink-0 mt-0.5">⚡</span>
                            <div className="min-w-0 flex-1">
                              <p className="font-mono text-[11px] text-[#F59E0B] font-bold tracking-widest mb-0.5">
                                {msg.insufficientCredits.kind === "tool" ? "TOOL CREDITS LOW" : "CHAT CREDITS LOW"}
                              </p>
                              <p className="font-mono text-[11px] text-slate-300 leading-relaxed">
                                {msg.insufficientCredits.message ?? (
                                  <>Need <span className="text-white font-medium">{msg.insufficientCredits.needed}</span> cr · have <span className="text-white font-medium">{msg.insufficientCredits.balance}</span></>
                                )}
                              </p>
                              <div className="flex gap-2 mt-2 flex-wrap items-center">
                                <button onClick={() => setTopUpOpen(true)}
                                  className="inline-flex items-center gap-1 font-mono text-[10px] font-bold px-2.5 py-1 rounded-md border transition-opacity hover:opacity-90"
                                  style={{ background: "#4FC3F7", color: "#050508", borderColor: "#4FC3F7" }}>
                                  Top up with USDC
                                </button>
                                <Link href="/docs/credits"
                                  className="inline-flex items-center gap-1 font-mono text-[10px] font-bold px-2.5 py-1 rounded-md bg-[#F59E0B]/15 text-[#F59E0B] border border-[#F59E0B]/40 hover:bg-[#F59E0B]/25 transition-colors">
                                  How credits work →
                                </Link>
                                <span className="font-mono text-[10px] text-slate-700 self-center">
                                  Resets daily · connect a wallet for 500/day
                                </span>
                              </div>
                            </div>
                          </div>
                        </div>
                      )}

                      {/* Hover copy */}
                      {msg.content && (
                        <div className="flex gap-1 mt-1 opacity-0 group-hover/msg:opacity-100 transition-opacity">
                          <button onClick={() => navigator.clipboard?.writeText(msg.content)}
                            className="font-mono text-[10px] text-slate-700 hover:text-slate-400 px-2 py-0.5 rounded border border-[#1A1A2E] bg-[#08080F] transition-colors">
                            copy
                          </button>
                        </div>
                      )}
                    </div>
                  ) : (
                    /* ── User message body — compact bubble ────────────────── */
                    <div className="max-w-[70%]">
                      {/* Attachments */}
                      {!!msg.attachments?.length && (
                        <div className="flex flex-wrap gap-1.5 mb-2 justify-end">
                          {msg.attachments.map((f, j) => (
                            <div key={j} className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border font-mono text-[10px]"
                              style={{ borderColor: "#4FC3F720", background: "#4FC3F708", color: "#64748b" }}>
                              <span>{f.mimeType.startsWith("image/") ? "🖼" : f.name.endsWith(".pdf") ? "📄" : "📎"}</span>
                              <span className="max-w-[140px] truncate">{f.name}</span>
                            </div>
                          ))}
                        </div>
                      )}
                      <div className="px-3.5 py-2.5 rounded-2xl rounded-tr-sm"
                        style={{ background: "#0F0F1E", border: "1px solid #1E1E32" }}>
                        <p className="font-mono text-[13px] text-slate-200 leading-relaxed whitespace-pre-wrap">
                          {msg.content}
                        </p>
                      </div>
                    </div>
                  )}
                </div>

                {/* User avatar — right side */}
              </div>
            );
          })}

          {/* Streaming wait indicator removed — dots shown inside message placeholder */}

          <div ref={bottomRef} />
        </div>
      )}

      {/* Non-custodial USDC top-up — opened by the inline "credits low" notice.
          Single instance for the whole message list; refresh the balance on a
          successful credit so the header count updates without a reload. */}
      <TopUpModal
        open={topUpOpen}
        onClose={() => setTopUpOpen(false)}
        onCredited={triggerWalletRefresh}
      />
    </div>
  );
}
