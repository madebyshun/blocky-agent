"use client";
import { useRef, useCallback, useState, useEffect } from "react";
import { useChat } from "../ChatContext";
import { PERSONAS } from "../personas";
import { creditCost } from "@/lib/credits";
import { useLang } from "@/lib/i18n/context";
import type { Attachment } from "../types";

// The V1 preset spec + dispatch helper moved to the leaf module `./presets`
// so ChatContext can read them without importing this component (which imports
// ChatContext → cycle). Imported here for the picker's own use, and re-exported
// so existing callers that import them from `./ChatInput` (e.g. ModelsPanel)
// keep resolving.
import { VIRTUALS_PRESETS_V1, formatContextTokens, type VirtualsPresetV1 } from "./presets";
export { VIRTUALS_PRESETS_V1, resolvePresetDispatch, formatContextTokens } from "./presets";
export type { VirtualsPresetV1 } from "./presets";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

const TEXT_EXTS = new Set([
  "sol", "ts", "tsx", "js", "jsx", "py", "rs", "go",
  "md", "txt", "json", "yaml", "yml", "toml", "env",
  "html", "css", "sh", "bash", "zsh",
]);

interface SlashCommand {
  cmd: string; icon: string; label: string; hint: string; example: string;
}

// Slash commands are natural language now — only 3 utility commands remain.
// /skill is handled client-side in ChatContext.tsx.
const SLASH_COMMANDS: SlashCommand[] = [
  { cmd: "skill",   icon: "📦", label: "Skill Packs", hint: "install / list / remove GitHub skill packs",      example: "/skill install owner/repo" },
];

export interface ModelTier {
  id: string; label: string; model: string;
  color: string; badge: string; note: string;
  // Pre-merge task #4 followup — Bankr got banned; the non-venice group
  // is now "virtuals" (routes through Virtuals server-side). Kept
  // "bankr" as a legacy alias so localStorage state written by older
  // clients still round-trips without a runtime error.
  group: "bankr" | "venice" | "privacy" | "virtuals";
  credits: number; // cost per msg
}

// User-facing model list — locked at 5 active models (one per preset).
// The previous 14-model raw menu has been retired in favour of preset-only
// selection. The cost-lookup tables in /lib/credits.ts and /lib/credit-
// pricing.ts keep all 14 IDs around so legacy chatTier values cached in
// localStorage still resolve to a price; the ChatContext bootstrap below
// remaps any unknown ID back to "pro" so the picker never lands on a
// model that doesn't exist in the UI any more.

// Pre-merge task #4 followup — every non-venice tier now routes to
// Virtuals with `anthropic-claude-sonnet-5` (see task-B commit cfaf061
// + label truthing commit 5cded17). The tier IDs stay (they still
// differentiate credit cost + are read by the server prompt for the
// system-line), but the picker LABEL now reflects what actually runs.
// When Virtuals tiers diverge (fast → haiku on Virtuals, etc.), swap
// each entry back to a distinct label. Group is renamed `virtuals` so
// the picker header says "Virtuals" instead of "Bankr" (Bankr = dead).
export const BANKR_TIERS: ModelTier[] = [
  { id: "fast",     label: "Sonnet 5 · Fast",   model: "anthropic-claude-sonnet-5", color: "#34D399", badge: "", note: "Sonnet 5 via Virtuals",         group: "virtuals", credits: 10  },
  { id: "pro",      label: "Sonnet 5 · Chat",   model: "anthropic-claude-sonnet-5", color: "#4FC3F7", badge: "", note: "Sonnet 5 via Virtuals",         group: "virtuals", credits: 50  },
  { id: "max",      label: "Sonnet 5 · Deep",   model: "anthropic-claude-sonnet-5", color: "#A78BFA", badge: "", note: "Sonnet 5 via Virtuals (deep)",  group: "virtuals", credits: 200 },
  { id: "deepseek", label: "Sonnet 5 · Long",   model: "anthropic-claude-sonnet-5", color: "#F59E0B", badge: "", note: "Sonnet 5 via Virtuals (long)",  group: "virtuals", credits: 10  },
  { id: "gemini",   label: "Sonnet 5 · Google", model: "anthropic-claude-sonnet-5", color: "#4285F4", badge: "", note: "Sonnet 5 via Virtuals",         group: "virtuals", credits: 20  },
  { id: "kimi",     label: "Sonnet 5 · Kimi",   model: "anthropic-claude-sonnet-5", color: "#06B6D4", badge: "", note: "Sonnet 5 via Virtuals",         group: "virtuals", credits: 20  },
];

export const VENICE_TIERS: ModelTier[] = [
  { id: "venice-deepseek", label: "V4 Flash",   model: "deepseek-v4-flash", color: "#34D399", badge: "V", note: "Fastest · 1M ctx", group: "venice", credits: 10  },
  { id: "venice-grok",     label: "Grok 4",     model: "grok-4-3",          color: "#E879F9", badge: "V", note: "X search",         group: "venice", credits: 60  },
  { id: "venice-fable",    label: "Fable 5",    model: "claude-fable-5",    color: "#F472B6", badge: "V", note: "Claude · 1M ctx",   group: "venice", credits: 120 },
];

export const PRIVACY_TIERS: ModelTier[] = [
  { id: "venice-e2ee-gemma", label: "Private Gemma", model: "e2ee-gemma-3-27b-p", color: "#6EE7B7", badge: "🔒", note: "E2EE · No logs", group: "privacy", credits: 30 },
];

export const ALL_TIERS: ModelTier[] = [...BANKR_TIERS, ...VENICE_TIERS, ...PRIVACY_TIERS];

/**
 * Use-case presets — what most users actually want at the moment of
 * choosing. Each preset maps to one underlying tier ID so the rest of the
 * pipeline (cost, system prompt, tool routing) doesn't need to change.
 *
 * The raw 14-model list still ships behind an "Advanced ▾" expander for
 * power users; presets are the default landing.
 */
export interface ModelPreset {
  id:       string;
  label:    string;
  desc:     string;
  icon:     string;
  tier:     string;     // maps to a ModelTier id
  webSearch?: boolean;  // suggested webSearch default when picked
}

/**
 * 5 use-case presets, ordered by likely user intent (chat-first, then
 * cheap fast, then specialised web/deep/private). Each maps to one
 * underlying model tier + a sensible webSearch default so picking a
 * preset is a one-click setup.
 *
 * Funding model context:
 *   - Bankr-tier models (Chat, Deep Think) are funded via the $BLUEAGENT
 *     trade-fee partnership — Bankr accepts $BLUEAGENT for compute, and we
 *     earn $BLUEAGENT from Bankr trade fees. Closed loop.
 *   - Venice-tier models (Fast, Web Search, Private) are paid in USDC
 *     directly. Cheap enough that the credit price (1 cr = $0.0005)
 *     gives 17-25x margin on DeepSeek Flash / E2EE Gemma.
 *
 * A 6th "🛠️ Code" preset is planned for when a code-specialised model
 * lands; the slot is intentionally left for it.
 */
// All-Bankr lineup (funded by the $BLUEAGENT × Bankr loop). Web search is a
// separate tool (Anthropic web_search server-tool) toggled with 🔍 in the
// composer, so it works on any of these models — no Venice model in the picker.
// Deprecated. The V1 preset spec (`VIRTUALS_PRESETS_V1` above) is the
// source of truth. This array is kept only as a static fallback for
// `activePreset`/label lookups until the catalog fetch resolves — every
// entry maps 1:1 to a V1 preset id so the picker highlight stays sane.
export const MODEL_PRESETS: ModelPreset[] = [
  { id: "fast",     label: "Fast",     desc: "DeepSeek V4 Flash · cheapest, snappy",   icon: "⚡", tier: "fast",     webSearch: false },
  { id: "balanced", label: "Balanced", desc: "Claude Sonnet 5 · default for most work", icon: "💬", tier: "balanced", webSearch: false },
  { id: "deep",     label: "Deep",     desc: "Claude Opus 4.8 · heavy reasoning",       icon: "🔬", tier: "deep",     webSearch: false },
  { id: "private",  label: "Private",  desc: "E2EE · no logs · DeepSeek V4",            icon: "🔒", tier: "private",  webSearch: false },
  { id: "grok",     label: "Grok",     desc: "Grok 4 · 2M context window",              icon: "🧠", tier: "grok",     webSearch: false },
];

export default function ChatInput() {
  const {
    input, setInput, send, stop, streaming, outOfCredits,
    error, credits, cost, chatTier, holderTier, setChatTier,
    cmdMenu, setCmdMenu, cmdFilter, setCmdFilter,
    // `webSearch` / `setWebSearch` intentionally NOT destructured — the toggle
    // that used them is removed (see the comment where it stood). They remain on
    // the context and in the request payload so re-enabling is a small revert.
    pendingFiles, setPendingFiles,
    personaId, setPersonaId,
  } = useChat();
  const { t } = useLang();

  const textareaRef  = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [modelOpen,   setModelOpen]   = useState(false);
  const [cmdOpen,     setCmdOpen]     = useState(false);
  const [personaOpen, setPersonaOpen] = useState(false);

  // Catalog-driven V1 preset list. Starts as the static fallback so the
  // picker renders instantly; the /api/chat/presets fetch then trims
  // anything whose Virtuals model id has disappeared from /v1/models.
  // See `_lib/llm.ts` `getVirtualsCatalog` for the 6h cache + fail-open
  // semantics.
  const [virtualsPresets, setVirtualsPresets] = useState<VirtualsPresetV1[]>(VIRTUALS_PRESETS_V1);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/chat/presets")
      .then((r) => r.ok ? r.json() : null)
      .then((body: { ok?: boolean; presets?: VirtualsPresetV1[] } | null) => {
        if (cancelled) return;
        if (body && body.ok && Array.isArray(body.presets) && body.presets.length > 0) {
          setVirtualsPresets(body.presets);
        }
      })
      .catch(() => { /* fail-open — keep the static fallback */ });
    return () => { cancelled = true; };
  }, []);

  const activePersona = PERSONAS.find(p => p.id === personaId) ?? PERSONAS[0];

  // Active preset — highlighted in the picker when chatTier === preset.id.
  // V1 preset ids ARE the chatTier values (fast, balanced, deep, private,
  // grok), so the lookup is 1:1.
  const activeVirtualsPreset = virtualsPresets.find(p => p.id === chatTier) ?? virtualsPresets[0];
  const activePreset = MODEL_PRESETS.find(p => p.id === chatTier);

  const activeTier = ALL_TIERS.find(t => t.id === chatTier) ?? BANKR_TIERS[1];

  // ── File handling ────────────────────────────────────────────────────────────
  const handleFiles = useCallback(async (fileList: FileList | null) => {
    if (!fileList) return;
    const newFiles: Attachment[] = [];

    for (const file of Array.from(fileList)) {
      if (file.size > MAX_FILE_SIZE) { alert(`${file.name} is too large (max 10MB)`); continue; }
      const ext    = file.name.split(".").pop()?.toLowerCase() ?? "";
      const isText = TEXT_EXTS.has(ext) || file.type.startsWith("text/");

      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        if (isText) {
          reader.onload = () => resolve(reader.result as string);
          reader.readAsText(file);
        } else {
          reader.onload = () => resolve((reader.result as string).split(",")[1] ?? "");
          reader.readAsDataURL(file);
        }
        reader.onerror = reject;
      });

      newFiles.push({ name: file.name, mimeType: file.type || "application/octet-stream", size: file.size, data, isText });
    }

    if (newFiles.length) setPendingFiles([...pendingFiles, ...newFiles]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [pendingFiles, setPendingFiles]);

  // ── Input handling ───────────────────────────────────────────────────────────
  function handleInput(val: string) {
    setInput(val);
    if (val.startsWith("/")) {
      const filter = val.slice(1).toLowerCase();
      setCmdFilter(filter);
      setCmdMenu(true);
      setCmdOpen(false);
    } else {
      setCmdMenu(false);
      setCmdFilter("");
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Escape") { setCmdMenu(false); setCmdOpen(false); setModelOpen(false); setPersonaOpen(false); return; }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input); }
  }

  function selectCommand(cmd: SlashCommand) {
    const needsArg = !["credits", "help", "pick", "models", "skills", "status"].includes(cmd.cmd);
    const newVal   = needsArg ? `/${cmd.cmd} ` : `/${cmd.cmd}`;
    setInput(newVal);
    setCmdMenu(false);
    setCmdFilter("");
    setCmdOpen(false);
    textareaRef.current?.focus();
    if (!needsArg) setTimeout(() => send(`/${cmd.cmd}`), 50);
  }

  const filteredCmds = SLASH_COMMANDS.filter(c =>
    !cmdFilter || c.cmd.startsWith(cmdFilter) || c.label.toLowerCase().includes(cmdFilter)
  );

  const activeCmd    = input.match(/^\/(\w+)/)?.[1]?.toLowerCase();
  const activeCmdDef = SLASH_COMMANDS.find(c => c.cmd === activeCmd);

  return (
    <div className="border-t border-[#1A1A2E] bg-[#050508] px-4 sm:px-6 py-3 flex-shrink-0">
      <div className="max-w-4xl mx-auto relative">

        {/* ── Slash command menu (typed /) ─────────────────────────────────── */}
        {cmdMenu && filteredCmds.length > 0 && (
          <div className="absolute bottom-full mb-2 left-0 right-0 bg-[#0D0D14] border border-[#2A2A4E] rounded-xl overflow-hidden shadow-2xl z-20 max-h-72 overflow-y-auto">
            <div className="px-3 pt-2.5 pb-1.5 border-b border-[#1A1A2E]">
              <span className="font-mono text-[10px] text-slate-600 tracking-widest">COMMANDS</span>
            </div>
            {filteredCmds.map((c) => (
              <button
                key={c.cmd}
                onMouseDown={(e) => { e.preventDefault(); selectCommand(c); }}
                className="w-full flex items-center gap-3 px-4 py-2.5 min-h-[44px] hover:bg-[#1A1A2E] transition-colors text-left group"
              >
                <span className="text-base w-5 text-center shrink-0">{c.icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-[#4FC3F7]">/{c.cmd}</span>
                    <span className="font-mono text-xs text-slate-400">{c.label}</span>
                  </div>
                  <span className="font-mono text-[10px] text-slate-600 truncate block">{c.hint}</span>
                </div>
                <span className="font-mono text-[10px] text-slate-700 group-hover:text-slate-500 shrink-0 hidden sm:block">{c.example}</span>
              </button>
            ))}
          </div>
        )}

        {/* ── Commands popover (toolbar button) ───────────────────────────── */}
        {cmdOpen && (
          <div className="absolute bottom-full mb-2 left-0 bg-[#0D0D14] border border-[#2A2A4E] rounded-xl overflow-hidden shadow-2xl z-20 w-72 max-h-80 overflow-y-auto">
            <div className="px-3 pt-2.5 pb-1.5 border-b border-[#1A1A2E]">
              <span className="font-mono text-[10px] text-slate-600 tracking-widest">COMMANDS</span>
            </div>
            {SLASH_COMMANDS.map((c) => (
              <button
                key={c.cmd}
                onMouseDown={(e) => { e.preventDefault(); selectCommand(c); }}
                className="w-full flex items-center gap-3 px-4 py-3 min-h-[44px] hover:bg-[#1A1A2E] transition-colors text-left group"
              >
                <span className="text-sm w-5 text-center shrink-0">{c.icon}</span>
                <div className="flex-1 min-w-0">
                  <p className="font-mono text-[10px] text-slate-300 group-hover:text-white">/{c.cmd} · {c.label}</p>
                  <p className="font-mono text-[9px] text-slate-600 truncate">{c.hint}</p>
                </div>
              </button>
            ))}
          </div>
        )}

        {/* ── Persona selector popover ─────────────────────────────────────── */}
        {personaOpen && (
          <div className="absolute bottom-full mb-2 left-0 bg-[#0D0D14] border border-[#2A2A4E] rounded-xl overflow-hidden shadow-2xl z-20 w-80 max-h-[420px] overflow-y-auto">
            <div className="px-3 pt-2.5 pb-1.5 border-b border-[#1A1A2E] sticky top-0 bg-[#0D0D14] z-10">
              <span className="font-mono text-[10px] text-slate-600 tracking-widest">PERSONA · EXPERT ROLE</span>
            </div>
            <div className="py-1.5">
              {PERSONAS.map(p => {
                const isActive = personaId === p.id;
                return (
                  <button key={p.id}
                    onClick={() => { setPersonaId(p.id); setPersonaOpen(false); textareaRef.current?.focus(); }}
                    className="w-full text-left flex items-center gap-2.5 px-3 py-2 hover:bg-white/[0.02] transition-colors relative"
                    style={isActive ? { background: `${p.color}0a` } : undefined}>
                    {isActive && (
                      <span aria-hidden className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-r"
                            style={{ background: p.color, boxShadow: `0 0 8px ${p.color}80` }} />
                    )}
                    <span className="text-base shrink-0 w-5 text-center">{p.icon}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="font-mono text-[12px] font-bold" style={{ color: isActive ? p.color : "#e2e8f0" }}>
                          {p.label}
                        </span>
                        {isActive && <span className="font-mono text-[9px]" style={{ color: p.color }}>✓</span>}
                      </div>
                      <p className="font-mono text-[10px] text-slate-500 leading-snug truncate">{p.desc}</p>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Model selector popover — presets first, advanced behind toggle ── */}
        {modelOpen && (
          <div className="absolute bottom-full mb-2 left-0 bg-[#0D0D14] border border-[#2A2A4E] rounded-xl overflow-hidden shadow-2xl z-20 w-80 max-h-[520px] overflow-y-auto">
            <div className="px-3 pt-2.5 pb-1.5 border-b border-[#1A1A2E] sticky top-0 bg-[#0D0D14] z-10">
              <span className="font-mono text-[10px] text-slate-600 tracking-widest">CHOOSE A MODE</span>
            </div>

            {/* V1 catalog-driven Virtuals presets. The list is filtered
                server-side against /v1/models — anything whose model id
                disappeared from the catalog never renders here. Each row
                shows: icon · label · cost dots (●/●●/●●●) · context size · credits.
                The 5th preset (Grok) is `optional` — shown after a subtle
                divider so the primary 4 stay uncluttered. */}
            <div className="py-1.5">
              {virtualsPresets.map((p, idx) => {
                const isActive = chatTier === p.id;
                // Primary presets get an accent color; Grok (optional) stays muted.
                const accentByCost: Record<"●" | "●●" | "●●●", string> = {
                  "●":   "#34D399", // green — cheap
                  "●●":  "#4FC3F7", // blue — mid
                  "●●●": "#A78BFA", // purple — expensive
                };
                const accent = p.privacy ? "#6EE7B7" : accentByCost[p.cost];
                const prevOptional = virtualsPresets[idx - 1]?.optional === true;
                const showDividerBefore = p.optional && !prevOptional;
                const iconMap: Record<VirtualsPresetV1["id"], string> = {
                  free: "🎁", fast: "⚡", balanced: "💬", deep: "🔬", private: "🔒", grok: "🧠",
                  flash: "🚀", search: "🌐",
                };
                return (
                  <div key={p.id}>
                    {showDividerBefore && (
                      <div className="px-3 py-1">
                        <div className="border-t border-[#1A1A2E]" />
                        <p className="font-mono text-[9px] text-slate-700 pt-1">Optional</p>
                      </div>
                    )}
                    <button
                      onClick={() => {
                        setChatTier(p.id);
                        setModelOpen(false);
                        textareaRef.current?.focus();
                      }}
                      className="w-full text-left flex items-center gap-2.5 px-3 py-2 hover:bg-white/[0.02] transition-colors relative"
                      style={isActive ? { background: `${accent}0a` } : undefined}
                    >
                      {isActive && (
                        <span aria-hidden className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-r"
                              style={{ background: accent, boxShadow: `0 0 8px ${accent}80` }} />
                      )}
                      <span className="text-base shrink-0 w-5 text-center">{iconMap[p.id]}</span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-2">
                          <span className="font-mono text-[12px] font-bold" style={{ color: isActive ? accent : "#e2e8f0" }}>
                            {p.label}
                          </span>
                          <span className="font-mono text-[10px] tracking-tighter" style={{ color: accent }}>{p.cost}</span>
                          <span className="font-mono text-[9px] text-slate-600">{formatContextTokens(p.contextTokens)} ctx</span>
                          {isActive && (
                            <span className="font-mono text-[9px]" style={{ color: accent }}>✓</span>
                          )}
                        </div>
                        <p className="font-mono text-[10px] text-slate-500 leading-snug truncate">{p.desc}</p>
                      </div>
                      <span className="font-mono text-[10px] shrink-0" style={{ color: accent }}>
                        {p.credits === 0
                          ? <span className="font-bold">Free</span>
                          : <>{p.credits}<span className="text-slate-700"> cr</span></>}
                      </span>
                    </button>
                  </div>
                );
              })}
            </div>

            {/* Footnote — catalog is the single source of truth. If a
                preset ever disappears from this picker, it's because
                Virtuals delisted the underlying model id (see
                `getVirtualsCatalog` in `_lib/llm.ts`). No hardcoded
                lists downstream. */}
            <div className="px-3 py-1.5 border-t border-[#1A1A2E]">
              <p className="font-mono text-[9px] text-slate-700 leading-relaxed">
                {virtualsPresets.length}/{VIRTUALS_PRESETS_V1.length} presets live · Virtuals catalog-driven · ●=cheap ●●=mid ●●●=deep
              </p>
            </div>
          </div>
        )}

        {/* ── File chips ───────────────────────────────────────────────────── */}
        {pendingFiles.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {pendingFiles.map((f, i) => (
              <div
                key={i}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border font-mono text-[10px]"
                style={{ borderColor: "#4FC3F730", background: "#4FC3F708", color: "#94A3B8" }}
              >
                <span>{f.mimeType.startsWith("image/") ? "🖼" : f.name.endsWith(".pdf") ? "📄" : "📎"}</span>
                <span className="max-w-[120px] truncate">{f.name}</span>
                <span className="text-slate-600">({(f.size / 1024).toFixed(0)}KB)</span>
                <button onClick={() => setPendingFiles(pendingFiles.filter((_, j) => j !== i))} className="ml-0.5 text-slate-600 hover:text-red-400">×</button>
              </div>
            ))}
          </div>
        )}

        {/* ── Active command badge ─────────────────────────────────────────── */}
        {activeCmdDef && !cmdMenu && (
          <div className="flex items-center gap-2 mb-2 px-1">
            <span className="font-mono text-[10px] text-[#4FC3F7] border border-[#4FC3F7]/30 bg-[#4FC3F7]/5 px-2 py-0.5 rounded">
              {activeCmdDef.icon} /{activeCmdDef.cmd} · {activeCmdDef.label}
            </span>
            <span className="font-mono text-[10px] text-slate-600">{activeCmdDef.hint}</span>
          </div>
        )}

        {/* ── Out-of-credits upgrade card ──────────────────────────────── */}
        {outOfCredits && (
          <div className="mb-2 rounded-xl border border-[#F59E0B20] bg-[#F59E0B06] overflow-hidden">
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-[#F59E0B15]">
              <div className="flex items-center gap-2">
                <span className="text-xs">⚡</span>
                <span className="font-mono text-[11px] font-bold text-[#F59E0B]">Out of credits</span>
                <span className="font-mono text-[10px] text-slate-600">
                  {credits} left · need {cost}/msg
                </span>
              </div>
              <span className="font-mono text-[10px] text-slate-500">resets daily</span>
            </div>
            <div className="flex items-center gap-2 px-4 py-2">
              {/* Current daily allowance */}
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: holderTier.color }} />
              <span className="font-mono text-[10px]" style={{ color: holderTier.color }}>{holderTier.tier}</span>
              <span className="font-mono text-[10px] text-slate-600">
                {holderTier.dailyCr.toLocaleString()} cr/day · USDC credit packs coming soon
              </span>
            </div>
          </div>
        )}
        {error && !outOfCredits && (
          <p className="font-mono text-xs mb-2 px-1 text-red-400">{error}</p>
        )}

        {/* ── Hidden file input ────────────────────────────────────────────── */}
        <input
          ref={fileInputRef}
          id="blue-chat-file-input"
          type="file"
          className="hidden"
          multiple
          accept=".sol,.ts,.tsx,.js,.jsx,.py,.rs,.go,.md,.txt,.json,.yaml,.yml,.toml,.pdf,.png,.jpg,.jpeg,.gif,.webp"
          onChange={e => handleFiles(e.target.files)}
        />

        {/* ── Main input card ──────────────────────────────────────────────── */}
        <div
          className="rounded-2xl border transition-colors overflow-hidden"
          style={{ background: "#0D0D14", borderColor: outOfCredits ? "#EF444430" : "#1E1E30" }}
        >
          {/* Textarea row */}
          <div className="flex items-end gap-2 px-4 pt-3.5 pb-3">
            <textarea
              ref={textareaRef}
              id="chat-composer"
              value={input}
              onChange={(e) => handleInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={outOfCredits ? "No credits left — resets daily" : t("chat.placeholder")}
              rows={1}
              disabled={streaming || outOfCredits}
              className="flex-1 resize-none bg-transparent outline-none font-mono text-sm text-white placeholder:text-slate-700 leading-relaxed"
              style={{ maxHeight: 160, overflowY: "auto" }}
              onInput={(e) => {
                const el = e.currentTarget;
                el.style.height = "auto";
                el.style.height = Math.min(el.scrollHeight, 160) + "px";
              }}
            />
            {/* Send / Stop */}
            {streaming ? (
              <button
                onClick={stop}
                className="flex-shrink-0 w-8 h-8 rounded-xl flex items-center justify-center bg-[#EF444415] border border-[#EF444430] text-red-400 hover:bg-[#EF444425] transition-all font-mono text-xs"
              >■</button>
            ) : (
              <button
                onClick={() => send(input)}
                disabled={(!input.trim() && pendingFiles.length === 0) || outOfCredits}
                className="flex-shrink-0 w-8 h-8 rounded-xl flex items-center justify-center font-bold transition-all disabled:opacity-25"
                style={{ background: activeTier.color, color: "#050508" }}
              >↑</button>
            )}
          </div>

          {/* Toolbar row */}
          <div className="flex items-center gap-1.5 px-3 pb-2.5 pt-1 border-t border-[#1A1A2E]/60">

            {/* Attach file — plus icon */}
            <label
              htmlFor="blue-chat-file-input"
              className="flex items-center justify-center w-7 h-7 rounded-lg cursor-pointer transition-all border"
              style={pendingFiles.length > 0
                ? { color: "#4FC3F7", background: "#4FC3F710", borderColor: "#4FC3F730" }
                : { color: "#64748b", borderColor: "transparent" }}
              title="Attach file"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M12 4v16m8-8H4" />
              </svg>
            </label>

            {/* Persona selector pill — surfaces the active expert role so it's
                visible in the chat tab (not just buried in Settings) and lets
                the user switch inline. Mirrors the model pill pattern. */}
            <button
              onMouseDown={(e) => { e.preventDefault(); setPersonaOpen(!personaOpen); setModelOpen(false); setCmdOpen(false); }}
              className="flex items-center gap-1.5 h-7 px-2.5 rounded-lg border font-mono text-[11px] font-medium transition-all"
              style={{ color: activePersona.color, background: `${activePersona.color}10`, borderColor: `${activePersona.color}30` }}
              title={`Persona: ${activePersona.label}`}
            >
              <span className="text-[11px] leading-none">{activePersona.icon}</span>
              <span className="hidden sm:inline">{activePersona.label}</span>
              <svg className="w-2.5 h-2.5 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {/* Model selector pill */}
            <button
              onMouseDown={(e) => { e.preventDefault(); setModelOpen(!modelOpen); setCmdOpen(false); setPersonaOpen(false); }}
              className="flex items-center gap-1.5 h-7 px-2.5 rounded-lg border font-mono text-[11px] font-medium transition-all"
              style={{ color: activeTier.color, background: `${activeTier.color}10`, borderColor: `${activeTier.color}30` }}
            >
              <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: activeTier.color }} />
              {/* Show the V1 preset label (Fast / Balanced / Deep / Private / Grok)
                  with its cost dots. Fall back to the legacy static preset
                  or tier label so the collapsed button never shows raw ids. */}
              {activeVirtualsPreset
                ? <>{activeVirtualsPreset.label} <span className="opacity-70">{activeVirtualsPreset.cost}</span></>
                : (activePreset?.label ?? activeTier.label)}
              {activeTier.badge && <span className="text-[8px] opacity-60">{activeTier.badge}</span>}
              <svg className="w-2.5 h-2.5 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {/* Commands button */}
            <button
              onMouseDown={(e) => { e.preventDefault(); setCmdOpen(!cmdOpen); setModelOpen(false); setPersonaOpen(false); }}
              className="flex items-center gap-1.5 h-7 px-2.5 rounded-lg border font-mono text-[11px] transition-all"
              style={cmdOpen
                ? { color: "#4FC3F7", background: "#4FC3F710", borderColor: "#4FC3F730" }
                : { color: "#475569", borderColor: "transparent" }}
              title="Commands"
            >
              <span className="text-[11px]">/</span>
              <span className="hidden sm:inline">Cmds</span>
            </button>

            {/* Web search toggle — REMOVED, deliberately, not lost.
                It was a no-op that looked like a feature. Flipping it set
                `webSearch: true` on the request, and the ONLY branch the web
                client can reach is the Virtuals one, where `virtualsAutoSearch`
                is hard-coded `false` and no `web_search` tool is registered. The
                server read the flag and ignored it.
                (The Venice branch does honour it — but `chatTier` comes from
                VIRTUALS_PRESETS_V1, whose ids are fast/balanced/deep/private/
                grok. None start with "venice", and `provider` is derived as
                `chatTier.startsWith("venice") ? "venice" : "virtuals"`, so that
                branch is unreachable from this UI. VENICE_TIERS survives only as
                an `ALL_TIERS.find()` lookup that can never match.)
                That made it worse than merely useless: the button turned green
                and said "Search on", so a user had MORE confidence in an answer
                the model had produced from stale training data. A control that
                raises trust while doing nothing is the exact opposite of what
                this product sells.
                `webSearch` / `setWebSearch` state and the request field are left
                intact on purpose — when a real web_search tool is registered on
                the Virtuals branch, restoring this button is a small revert, not
                a rebuild. */}

            <div className="flex-1" />

            <span className="font-mono text-[10px] text-slate-700">{`${cost}cr/msg`}</span>
          </div>

          {/* Footer hint */}
          <div className="flex items-center justify-between px-3 pb-2.5">
            <span className="hidden md:inline font-mono text-[10px] text-slate-700">Enter ↵ send · Shift+Enter newline</span>
            <span className="font-mono text-[10px] text-slate-700">{`${credits} credits left`}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ModelGroup sub-component retired alongside the Advanced submenu — the
// preset grid in the main popover handles every model now.
