// ── V1 catalog-driven chat presets (client spec) ───────────────────────────
// Leaf module: no React, no ChatContext import. Both the ChatInput picker
// (upper layer) and ChatContext.send() (lower layer) read this, so it must not
// depend on either — otherwise ChatContext → ChatInput → ChatContext cycles.
//
// Shape mirrors `VirtualsPreset` in `/api/_lib/llm.ts`. This list is the STATIC
// fallback the picker shows until `/api/chat/presets` responds; the server may
// filter it down against the live catalogs (missing id → hidden). Never
// hardcode a model id anywhere else — this file and the server-side spec are
// the two authoritative sites.
export interface VirtualsPresetV1 {
  id: "free" | "fast" | "balanced" | "deep" | "private" | "grok" | "flash" | "search";
  /** Which upstream this dispatches to — see the server spec for why. */
  provider: "virtuals" | "venice";
  model: string;
  label: string;
  desc: string;
  cost: "●" | "●●" | "●●●";
  contextTokens: number;
  credits: number;
  privacy?: boolean;
  optional?: boolean;
  /** Venice-only live web search. Never set on a `virtuals` preset (#143). */
  webSearch?: boolean;
  /**
   * Chat-only: never register Hub tools for this preset. Set on the free tier
   * so a 0-credit message can't invoke a paid tool. The route enforces this
   * server-side from its OWN preset copy — this field only mirrors that fact
   * for the picker; a client can't turn tools on by flipping it.
   */
  noTools?: boolean;
}
// `contextTokens` here is the PRE-FETCH FALLBACK, reconciled with the live
// catalogs on 2026-09-04. It used to drift silently: `balanced` and `deep` both
// said 200k while the catalog said 1,000,000, and the Models page rendered that
// wrong number. Keep this list in lockstep with VIRTUALS_PRESETS in
// `_lib/llm.ts`; the display path prefers the live figure from
// `/api/chat/models` and only falls back to these.
export const VIRTUALS_PRESETS_V1: VirtualsPresetV1[] = [
  { id: "fast",     provider: "virtuals", model: "deepseek-deepseek-v4-flash", label: "Fast",     desc: "DeepSeek V4 Flash · cheapest, snappy",   cost: "●",   contextTokens: 1_048_576, credits: 10 },
  // Free tier — no credits, chat-only. Placed AFTER `fast` (not at index 0) on
  // purpose: the picker's `?? presets[0]` fallback must keep landing on a PAID
  // default for the legacy `pro` chatTier, because highlighting "Free/0 cr"
  // while the server actually runs sonnet@50cr is exactly the honesty defect
  // #143 is about. The model is a Venice one, so it depends on the provider
  // routing (PR feat/chat-venice-provider) to be reachable at all.
  { id: "free",     provider: "venice",   model: "qwen3-5-9b",                 label: "Free",     desc: "Qwen 3.5 9B · no credits · chat only",   cost: "●",   contextTokens: 256_000,   credits: 0,   noTools: true },
  { id: "balanced", provider: "virtuals", model: "anthropic-claude-sonnet-5",  label: "Balanced", desc: "Claude Sonnet 5 · default for most work", cost: "●●",  contextTokens: 1_000_000, credits: 50 },
  { id: "deep",     provider: "virtuals", model: "anthropic-claude-opus-4-8",  label: "Deep",     desc: "Claude Opus 4.8 · heavy reasoning",       cost: "●●●", contextTokens: 1_000_000, credits: 200 },
  { id: "private",  provider: "virtuals", model: "e2ee-deepseek-v4-flash",     label: "Private",  desc: "E2EE · no logs · DeepSeek V4",            cost: "●",   contextTokens: 1_000_000, credits: 30,  privacy: true },
  { id: "flash",    provider: "virtuals", model: "google-gemini-2-5-flash",    label: "Instant",  desc: "Gemini 2.5 Flash · fastest first token",  cost: "●",   contextTokens: 1_048_576, credits: 10 },
  { id: "grok",     provider: "virtuals", model: "x-ai-grok-4-20",             label: "Grok",     desc: "Grok 4 · 2M context window",              cost: "●●",  contextTokens: 2_000_000, credits: 60,  optional: true },
  { id: "search",   provider: "venice",   model: "grok-4-3",                   label: "Search",   desc: "Grok 4.3 · live web search · 1M ctx",     cost: "●●",  contextTokens: 1_000_000, credits: 60,  optional: true, webSearch: true },
];

/**
 * chatTier id → how to dispatch it. This replaces two older mechanisms that
 * disagreed with each other:
 *
 *   - `chatTier.startsWith("venice") ? "venice" : "virtuals"` in ChatContext,
 *     which could never be true because no preset id starts with "venice"; and
 *   - a separate `VENICE_MODEL_IDS` lookup table keyed on those same
 *     unreachable ids.
 *
 * Together they made the Venice branch dead code from the browser. Reading
 * both fields off the one preset record means a preset cannot be added with a
 * provider but no model id, or routed to an upstream it was never verified on.
 *
 * Unknown/legacy ids (values persisted in localStorage by older builds) fall
 * back to Virtuals with no model override, which is what the server already
 * does for them — see `presetForTier ?? VIRTUALS_CHAT_DEFAULT_MODEL`.
 */
export function resolvePresetDispatch(
  chatTier: string,
  presets: VirtualsPresetV1[] = VIRTUALS_PRESETS_V1,
): { provider: "virtuals" | "venice"; modelId?: string; webSearch: boolean } {
  const p = presets.find((x) => x.id === chatTier);
  if (!p) return { provider: "virtuals", webSearch: false };
  return {
    provider: p.provider,
    // Only the Venice branch reads `modelId` off the request; the Virtuals
    // branch resolves the model from `tier` server-side. Sending it for
    // Virtuals would be inert, but sending it only where it is read keeps the
    // wire payload honest about what is being asked for.
    modelId: p.provider === "venice" ? p.model : undefined,
    webSearch: p.webSearch === true,
  };
}

/** "1M" / "200k" — human-readable context size for the preset subtitle. */
export function formatContextTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return `${n}`;
}
