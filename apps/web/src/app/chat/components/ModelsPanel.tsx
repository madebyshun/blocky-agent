"use client";

import { useChat } from "../ChatContext";
import { VIRTUALS_PRESETS_V1, formatContextTokens, type VirtualsPresetV1 } from "./ChatInput";

/**
 * Models page — a readable catalog of every model Blue Chat can run, so users
 * understand what's available and what each one is for before picking. Each
 * card maps a use-case preset to its underlying model + credit cost, and
 * selecting one sets the active chat model (same pipeline + same preset ids as
 * the composer model picker).
 *
 * Data is sourced 1:1 from VIRTUALS_PRESETS_V1 in ChatInput — the single source
 * of truth the composer also uses. Most presets run through the Virtuals
 * gateway; the venice-provider presets (e.g. Search) run through Venice. There
 * is no per-model funding story and no token.
 */

// Per-preset accent + icon + longer "best for" guidance. VIRTUALS_PRESETS_V1
// carries the model facts (id, model, credits, context); this map only adds the
// display trim, so we never duplicate a model claim.
const PRESET_META: Record<VirtualsPresetV1["id"], { icon: string; color: string; bestFor: string }> = {
  fast:     { icon: "⚡", color: "#34D399", bestFor: "High-volume or long-context work where speed and cost matter more than depth. 1M-token context." },
  balanced: { icon: "💬", color: "#4FC3F7", bestFor: "Everyday building, brainstorming, and the 5 blue commands. The balanced default." },
  deep:     { icon: "🔬", color: "#A78BFA", bestFor: "Hard reasoning: audits, architecture, tricky debugging, multi-step analysis." },
  private:  { icon: "🔒", color: "#6EE7B7", bestFor: "Sensitive prompts — runs end-to-end encrypted with no logs retained." },
  flash:    { icon: "🚀", color: "#FBBF24", bestFor: "Snappy back-and-forth — Gemini 2.5 Flash for the fastest first token. 1M-token context." },
  grok:     { icon: "🧠", color: "#E879F9", bestFor: "Live-data and huge-context tasks — Grok 4 with a 2M-token window." },
  search:   { icon: "🌐", color: "#22D3EE", bestFor: "Questions that need the live web — Grok 4.3 on Venice with real-time search. 1M-token context." },
};

export default function ModelsPanel({ onPick }: { onPick?: () => void }) {
  const { chatTier, setChatTier } = useChat();

  function pick(id: string) {
    setChatTier(id);
    onPick?.();
  }

  return (
    <div className="flex flex-col h-full bg-[#050508] overflow-y-auto">
      {/* Header */}
      <div className="px-5 py-4 border-b border-[#1A1A2E] flex-shrink-0">
        <p className="font-mono text-[10px] text-slate-500 tracking-widest mb-1">MODELS</p>
        <p className="font-mono text-[10px] text-slate-700">
          The engines behind Blue Chat. Pick by use-case — selecting one sets your active model.
        </p>
      </div>

      {/* Cards */}
      <div className="flex-1 px-5 py-4">
        <div className="grid gap-2.5 sm:grid-cols-2">
          {VIRTUALS_PRESETS_V1.map(preset => {
            const meta     = PRESET_META[preset.id];
            const isActive = chatTier === preset.id;
            const chip     = preset.privacy
              ? { label: "Private · E2EE", color: "#6EE7B7" }
              : preset.provider === "venice"
                ? { label: preset.webSearch ? "Venice · Search" : "Venice", color: "#22D3EE" }
                : { label: "Virtuals",       color: "#4FC3F7" };

            return (
              <button
                key={preset.id}
                onClick={() => pick(preset.id)}
                className="group text-left rounded-2xl border p-4 transition-all"
                style={{
                  borderColor: isActive ? `${meta.color}55` : "#1A1A2E",
                  background:  isActive ? `${meta.color}0d` : "#0A0A12",
                }}
                onMouseEnter={e => { if (!isActive) e.currentTarget.style.borderColor = `${meta.color}33`; }}
                onMouseLeave={e => { if (!isActive) e.currentTarget.style.borderColor = "#1A1A2E"; }}
              >
                {/* Title row */}
                <div className="flex items-center gap-2.5 mb-2">
                  <span
                    className="w-9 h-9 rounded-xl flex items-center justify-center text-lg shrink-0"
                    style={{ background: `${meta.color}14` }}
                  >
                    {meta.icon}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm font-semibold text-white truncate">{preset.label}</span>
                      {isActive && (
                        <span
                          className="font-mono text-[8px] px-1.5 py-0.5 rounded-full font-bold tracking-wider shrink-0"
                          style={{ background: meta.color, color: "#050508" }}
                        >
                          ACTIVE
                        </span>
                      )}
                    </div>
                    <span className="font-mono text-[11px] text-slate-500 truncate block">{preset.model}</span>
                  </div>
                </div>

                {/* Description */}
                <p className="font-mono text-[11px] text-slate-400 leading-relaxed mb-3">
                  {meta.bestFor}
                </p>

                {/* Meta row — spec chips */}
                <div className="flex flex-wrap items-center gap-1.5">
                  <span
                    className="font-mono text-[9px] px-2 py-0.5 rounded-md"
                    style={{ background: `${chip.color}12`, color: chip.color }}
                  >
                    {chip.label}
                  </span>
                  <span className="font-mono text-[9px] px-2 py-0.5 rounded-md bg-[#1A1A2E] text-slate-400">
                    {formatContextTokens(preset.contextTokens)} ctx
                  </span>
                  <span className="font-mono text-[9px] px-2 py-0.5 rounded-md bg-[#1A1A2E] text-slate-300 ml-auto">
                    ~{preset.credits} cr/msg
                  </span>
                </div>
              </button>
            );
          })}
        </div>

        <p className="font-mono text-[10px] text-slate-700 mt-4 leading-relaxed">
          Cost shown is the credit price per message. 1 credit ≈ $0.0005.
          Everyone gets a free daily bucket — connect any wallet for 500 credits/day,
          or top up with USDC on Base.
        </p>
      </div>
    </div>
  );
}
