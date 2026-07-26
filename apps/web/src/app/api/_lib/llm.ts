// Shared LLM client for Next.js API routes.
//
// LLM POLICY (2026-07-25): Virtuals is the ONLY provider used for synthesis
// across the whole stack. Bankr and Venice HTTP paths were removed from
// callLLM's fallback chain because a 3-rung chain was producing hard-to-read
// error traces (venice:error can literally say "Bankr LLM 403…" because Venice
// had an internal Bankr fallback) and hiding real Virtuals failures behind
// silent fabrication from the other rungs. Now:
//
//   • callLLM → Virtuals only. On failure, throws a typed LLM_UNAVAILABLE
//     error the caller can degrade around (e.g. blue-hood arrow still fires
//     with facts intact, brief:null).
//   • callVeniceLLM stays exported for legacy handlers still importing it —
//     it now delegates to callVirtualsLLM under the hood so no HTTP call ever
//     reaches api.venice.ai. Handlers should migrate to callLLM in follow-up
//     work; the shim is deliberate to keep the chain-strip PR small.
//   • callBankrLLM stays untouched at the file level so ~46 handlers that
//     directly import it keep compiling. Those calls are DEAD in prod today
//     (Bankr account 403 banned) — see the migration task that follows.
//
// Env: VIRTUALS_API_KEY (required), VIRTUALS_MODEL (optional). VENICE_INFERENCE_KEY
// is no longer read anywhere in this file; a follow-up sweeps it out of the
// rest of the codebase (chat/route.ts, memory/embed, crypto-rpc, status).

import { getAeonOutput, formatAeonForLLM } from "./aeon-kv";

export type BankrMessage = { role: string; content: string };

// ─── Skill file cache (in-memory, per process) ────────────────────────────────

const _skillCache = new Map<string, { text: string; ts: number }>();
const SKILL_TTL_MS = 5 * 60 * 1000; // 5 min

async function loadSkillFile(url: string): Promise<string | null> {
  const cached = _skillCache.get(url);
  if (cached && Date.now() - cached.ts < SKILL_TTL_MS) return cached.text;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const text = await res.text();
    _skillCache.set(url, { text, ts: Date.now() });
    return text;
  } catch (e) { console.error("[llm] skill error:", (e as Error).message); return null; }
}

// ─── Real skill URLs ──────────────────────────────────────────────────────────

const GITHUB_BASE = "https://raw.githubusercontent.com/madebyshun/blue-agent/main";
const AEON_BASE   = "https://raw.githubusercontent.com/aaronjmars/aeon/main";

const SKILL_URLS = {
  miroshark:    `${GITHUB_BASE}/collab/miroshark-blueagent.prompt.md`,
  blueIdentity: `${GITHUB_BASE}/skills/blue-agent-identity.md`,
  baseEcosystem:`${GITHUB_BASE}/skills/base-ecosystem.md`,
  tokenLaunch:  `${GITHUB_BASE}/skills/token-launch-guide.md`,
  baseAddresses:`${GITHUB_BASE}/skills/base-addresses.md`,
};

// ─── Core LLM call ───────────────────────────────────────────────────────────

export async function callBankrLLM(opts: {
  model?: string;
  system: string;
  messages: BankrMessage[];
  temperature?: number;
  maxTokens?: number;
  /** Force JSON output via assistant prefill */
  jsonMode?: boolean;
  /** Skip skill auto-enhancement (internal use) */
  _skipEnhance?: boolean;
}): Promise<string> {
  let system = opts.system;

  // ── Auto-inject real skills based on system prompt prefix ────────────────
  if (!opts._skipEnhance) {
    if (system.startsWith("You are MiroShark")) {
      const miroPrompt = await loadSkillFile(SKILL_URLS.miroshark);
      if (miroPrompt) {
        system = `${miroPrompt}\n\n---\n\n## Role for this task\n${system}`;
      }
    } else if (system.startsWith("You are Blue Agent") || system.startsWith("You are Aeon —")) {
      // For Blue Agent synthesis steps, inject identity + base context
      if (system.startsWith("You are Blue Agent")) {
        const [identity, baseCtx] = await Promise.all([
          loadSkillFile(SKILL_URLS.blueIdentity),
          loadSkillFile(SKILL_URLS.baseEcosystem),
        ]);
        const extra = [identity, baseCtx].filter(Boolean).join("\n\n---\n\n");
        if (extra) system = `${extra}\n\n---\n\n## Task\n${system}`;
      }
    }
  }

  // Auto-enable JSON prefill when system contains "Return ONLY raw JSON"
  const wantsJson = opts.jsonMode ?? system.includes("Return ONLY raw JSON");
  const messages: BankrMessage[] = wantsJson
    ? [...opts.messages, { role: "assistant", content: "{" }]
    : opts.messages;

  const res = await fetch("https://llm.bankr.bot/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.BANKR_API_KEY ?? "",
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: opts.model ?? "claude-haiku-4-5",
      system,
      messages,
      temperature: opts.temperature ?? 0.5,
      // Same floor as Virtuals + Venice — <400 causes JSON truncation.
      max_tokens: Math.max(400, opts.maxTokens ?? 1000),
    }),
    signal: AbortSignal.timeout(55_000),
  });
  if (!res.ok) {
    const errText = await res.text();
    console.error(`[llm] Bankr LLM error ${res.status}:`, errText);
    throw new Error(`Bankr LLM ${res.status}: ${errText.slice(0, 200)}`);
  }
  const d = await res.json() as { content?: { text: string }[]; text?: string };
  let text = "";
  if (d.content?.length) text = d.content[0].text;
  else if (d.text) text = d.text;
  else throw new Error("Invalid Bankr LLM response");
  return wantsJson ? "{" + text : text;
}

// ─── Fabrication guard ─────────────────────────────────────────────────────
//
// Virtuals has no web-search capability, so no rule promises one. Prompts must
// still block the model from inventing specific numbers — that's what
// NO_FABRICATION_RULE below does. The old WEB_SEARCH_RULE (which claimed the
// model *had* search) was Venice-only and was removed with the chain strip.

/** For any synthesis: forbid inventing numbers when the caller hasn't supplied them. */
export const NO_FABRICATION_RULE =
  "Do NOT invent specific numbers (market size, TAM, revenue, user counts, valuations, GitHub stars). If you do not have a verified source for a figure, write \"[data unavailable]\" instead of guessing.";

// ─── Degraded-confidence marker ────────────────────────────────────────────
//
// After the Virtuals-only strip there is NO live web search. Most handlers are
// grounded in live code-fetched data (DexScreener, Moralis, DefiLlama,
// GitHub, Aeon-KV) and the LLM only interprets those real numbers — those are
// NOT degraded and must NOT carry this marker (it would be false labeling).
//
// This marker is for the narrow set where the answer genuinely comes from the
// model's static training knowledge with no live grounding — i.e. tools that
// depend on FRESH facts (community sentiment, competitor web presence, grant
// programs). For those, silently returning a confident answer is more
// dangerous than saying "I can't verify this". Attach it as a `confidence_note`
// field in the JSON output so the caller/end-user sees the degradation.
export const STATIC_KNOWLEDGE_DISCLAIMER =
  "web verification unavailable, assessment from static knowledge only, treat as low-confidence";

// ─── Virtuals Compute (partner-sponsored, OpenAI-compatible) ────────────────
// Base URL: https://compute.virtuals.io/v1
//
// Model is read from `VIRTUALS_MODEL` env with a verified default
// (`deepseek-deepseek-v4-flash` — confirmed present in the live
// /v1/models catalog on 2026-07-18, $0.138 in / $0.275 out per 1M).
// A brief run is ~600in/80out → <$0.0001 per call.
//
// History: the previous default was `moonshotai-kimi-k2-7-code`, which
// Virtuals de-listed at some point; that dropped `provider: virtuals`
// to null on prod for 4 straight CI runs (#11–#14) with error text
// silently truncated in the attempts trace. Both defaults are now
// env-controlled and the retry logic below preserves the full upstream
// response body so this class of regression is grep-visible.
//
// No web search on Virtuals; Venice remains the fallback for that.

export const VIRTUALS_DEFAULT_MODEL = "deepseek-deepseek-v4-flash";

// ─── Virtuals catalog (kill the "id-doesn't-exist → 400" bug family) ──────
//
// Root cause of the same bug family, 3rd time (2026-07-24):
//   "Claude Haiku 4.5" preset → id `anthropic-claude-haiku-4-5` — NOT in
//   the Virtuals /v1/models catalog. Every call became a 400. The preset
//   list was hardcoded, so no CI signal fired.
//
// Fix: single source of truth is Virtuals' own catalog. Both server
// (before dispatching a call) and client (when rendering the picker)
// validate against it. If an id disappears from the catalog, it
// disappears from the picker on the next 6h refresh — no code change
// required.
//
// The 4 preset ids below were verified live against the catalog on
// 2026-07-24 (see the "chốt preset" spec). The `-fast` variants are
// deliberately absent: 6× the price for the same capability.
export interface VirtualsPreset {
  /** Stable UI id — never a Virtuals model id. */
  id: "fast" | "balanced" | "deep" | "private" | "grok";
  /** The Virtuals /v1/models `id`. Validated against the catalog. */
  model: string;
  /** Short user-facing name shown on the picker card. */
  label: string;
  /** 1-line description. */
  desc: string;
  /** Cost dot rendering — ●=cheap, ●●=mid, ●●●=expensive. */
  cost: "●" | "●●" | "●●●";
  /** Context window in tokens (used in the picker subtitle). */
  contextTokens: number;
  /** Credit price used by /lib/credits.ts. */
  credits: number;
  /** Show a lock icon (Private tier). */
  privacy?: boolean;
  /** Whether this preset is optional (hidden by default in the primary picker). */
  optional?: boolean;
}

export const VIRTUALS_PRESETS: VirtualsPreset[] = [
  { id: "fast",     model: "deepseek-deepseek-v4-flash", label: "Fast",     desc: "DeepSeek V4 Flash · cheapest, snappy",   cost: "●",   contextTokens: 1_000_000, credits: 10 },
  { id: "balanced", model: "anthropic-claude-sonnet-5",  label: "Balanced", desc: "Claude Sonnet 5 · default for most work", cost: "●●",  contextTokens: 200_000,   credits: 50 },
  { id: "deep",     model: "anthropic-claude-opus-4-8",  label: "Deep",     desc: "Claude Opus 4.8 · heavy reasoning",       cost: "●●●", contextTokens: 200_000,   credits: 200 },
  { id: "private",  model: "e2ee-deepseek-v4-flash",     label: "Private",  desc: "E2EE · no logs · DeepSeek V4",            cost: "●",   contextTokens: 1_000_000, credits: 30,  privacy: true },
  { id: "grok",     model: "x-ai-grok-4-20",             label: "Grok",     desc: "Grok 4 · 2M context window",              cost: "●●",  contextTokens: 2_000_000, credits: 60,  optional: true },
];

const CATALOG_CACHE_MS = 6 * 60 * 60 * 1000; // 6h — matches the "chốt preset" spec
let _virtualsCatalogCache: { ids: Set<string>; fetchedAt: number } | null = null;

/**
 * Fetches the current Virtuals /v1/models catalog and returns the set of
 * available model ids. Cached in-process for 6h; a failed fetch returns
 * the previous cache if we have one, else `null` (so callers can decide
 * whether to fail-open or fail-closed).
 *
 * Call sites:
 *   - `/api/chat/preset-catalog` — client picker fetches this to hide
 *     presets whose id is missing from the catalog.
 *   - `callVirtualsLLM` (below) — validates the model id before
 *     dispatching, so a stale preset in localStorage doesn't turn into a
 *     mysterious 400 in the wild.
 */
export async function getVirtualsCatalog(): Promise<Set<string> | null> {
  const now = Date.now();
  if (_virtualsCatalogCache && now - _virtualsCatalogCache.fetchedAt < CATALOG_CACHE_MS) {
    return _virtualsCatalogCache.ids;
  }
  const apiKey = process.env.VIRTUALS_API_KEY ?? "";
  if (!apiKey) {
    console.warn("[virtuals-catalog] VIRTUALS_API_KEY not set — cannot validate");
    return _virtualsCatalogCache?.ids ?? null;
  }
  try {
    const res = await fetch("https://compute.virtuals.io/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.warn(`[virtuals-catalog] /v1/models ${res.status} — using stale cache=${_virtualsCatalogCache?.ids.size ?? 0}`);
      return _virtualsCatalogCache?.ids ?? null;
    }
    const d = (await res.json()) as { data?: { id?: string }[] };
    const ids = new Set<string>();
    for (const row of d.data ?? []) {
      if (typeof row.id === "string" && row.id.length > 0) ids.add(row.id);
    }
    if (ids.size === 0) {
      console.warn("[virtuals-catalog] empty catalog — using stale cache");
      return _virtualsCatalogCache?.ids ?? null;
    }
    _virtualsCatalogCache = { ids, fetchedAt: now };
    console.log(`[virtuals-catalog] refreshed size=${ids.size}`);
    return ids;
  } catch (e) {
    console.warn(`[virtuals-catalog] fetch failed: ${(e as Error).message} — using stale cache`);
    return _virtualsCatalogCache?.ids ?? null;
  }
}

/**
 * Returns the presets whose model id is currently in the Virtuals
 * catalog. If the catalog fetch fails and we have no cache, returns the
 * full preset list (fail-open — the picker still works, and a bad id
 * will surface as a typed 4xx from the chat route rather than a
 * mysterious 400).
 */
export async function getAvailableVirtualsPresets(): Promise<VirtualsPreset[]> {
  const catalog = await getVirtualsCatalog();
  if (catalog === null) return VIRTUALS_PRESETS;
  const available = VIRTUALS_PRESETS.filter((p) => catalog.has(p.model));
  const missing = VIRTUALS_PRESETS.filter((p) => !catalog.has(p.model));
  if (missing.length > 0) {
    console.warn(`[virtuals-catalog] hiding presets missing from catalog: ${missing.map((p) => `${p.id}=${p.model}`).join(", ")}`);
  }
  return available;
}

/** Floor on `max_tokens` (all providers). Below ~400 tokens the model
 *  frequently truncates a JSON object mid-key, which — combined with
 *  reasoning models spending tokens inside `<think>…</think>` — is the
 *  #1 cause of "empty response" and "unparseable JSON" failures. */
const MIN_MAX_TOKENS = 400;

/** Strip a leading `<think>…</think>` block. Deepseek-R1 and derivatives
 *  emit reasoning wrapped in this tag; when the model burns most of the
 *  budget inside it, the visible `content` is either empty or contains
 *  ONLY the reasoning (no real answer).
 *   - Closed `<think>…</think>` → return the text after the closing tag.
 *   - Unclosed `<think>…` (reasoning ate the whole budget) → return "" so
 *     the caller falls back to `reasoning_content` (some gateways surface
 *     it as a separate field) or throws "empty response". */
function stripThinkBlock(text: string): string {
  const closed = /^\s*<think>[\s\S]*?<\/think>\s*/i.exec(text);
  if (closed) return text.slice(closed[0].length).trim();
  const openOnly = /^\s*<think>[\s\S]*/i.exec(text);
  if (openOnly) return "";
  return text;
}

export async function callVirtualsLLM(opts: {
  system: string;
  user?: string;
  messages?: BankrMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
}): Promise<string> {
  const apiKey = process.env.VIRTUALS_API_KEY ?? "";
  if (!apiKey) throw new Error("VIRTUALS_API_KEY not set");
  const model = opts.model ?? process.env.VIRTUALS_MODEL ?? VIRTUALS_DEFAULT_MODEL;
  // Pre-flight: validate the model id against the catalog. If the
  // catalog has never been fetched (or the fetch is currently down), we
  // still dispatch — the upstream 400 is the last line of defence and
  // the throw path preserves the full response body. This just gives us
  // a *loud, typed* error a whole class of stale-preset regressions
  // instead of a mystery 400 that took 4 CI runs to trace.
  const catalog = await getVirtualsCatalog();
  if (catalog !== null && !catalog.has(model)) {
    throw new Error(`Virtuals model "${model}" not in catalog (catalog_size=${catalog.size}). Check the preset spec — this class of bug fired 3 times before catalog-driven validation landed.`);
  }
  const msgs = opts.messages ?? (opts.user != null ? [{ role: "user", content: opts.user }] : []);
  const maxTokens = Math.max(MIN_MAX_TOKENS, opts.maxTokens ?? 1000);
  const res = await fetch("https://compute.virtuals.io/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      // Pre-merge task #7 — minimal payload. History of the "empty
      // response" saga:
      //   - PR #211 sent `disable_thinking: true` + `reasoning_effort:
      //     "none"` hoping strict schemas would ignore unknowns.
      //   - PR #212 dropped `disable_thinking` after Virtuals returned
      //     `400: "Unrecognized key(s): 'disable_thinking'"`, kept
      //     `reasoning_effort` since the validator only flagged the
      //     first unknown key.
      //   - 2026-07-21 brief #0008: same virtuals chain error — the
      //     validator's next unknown-key flag was almost certainly
      //     `reasoning_effort`. Only way to be sure: minimal payload.
      // So this call now sends ONLY what OpenAI-compat mandates:
      //   { model, messages, max_tokens, temperature }
      // Every hint that could trip the schema is gone. The
      // `stripThinkBlock` post-processor on the response side is the
      // only defence against `<think>` blocks eating the token budget —
      // and the `MIN_MAX_TOKENS = 400` floor gives the model enough
      // budget that even a thinking model has room for real content
      // after the `</think>` tag.
      model,
      messages: [{ role: "system", content: opts.system }, ...msgs],
      max_tokens: maxTokens,
      temperature: opts.temperature ?? 0.3,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    // Verbatim upstream response (up to 400 chars — enough for a full
    // Virtuals error object like {"error":{"message":"Invalid model
    // provided","type":"invalid_request_error"}}). The chain layer above
    // stores this string on `attempts[i].error`; do NOT truncate to a
    // generic "Virtuals 4xx" because that's how the model-string bug
    // survived 4 CI runs.
    throw new Error(`Virtuals ${res.status} model=${model}: ${(await res.text()).slice(0, 400)}`);
  }
  const d = (await res.json()) as { choices?: { message?: { content?: string; reasoning_content?: string } }[] };
  const rawContent = d.choices?.[0]?.message?.content ?? "";
  // Fallback: if content is empty but the upstream surfaced a separate
  // `reasoning_content` field (some deepseek gateways split them), use
  // it. Otherwise strip a leading think block from `content`.
  const text = stripThinkBlock(rawContent) || d.choices?.[0]?.message?.reasoning_content?.trim() || "";
  if (!text) throw new Error(`Virtuals empty response (content_len=${rawContent.length} model=${model})`);
  return text;
}

/**
 * Synthesis via **Virtuals only**. On failure, throws `LLM_UNAVAILABLE` with
 * the upstream error text preserved on `.attempts[0].error`. Callers should
 * degrade cleanly (arrow still fires with facts; brief:null; log the error)
 * rather than fabricate.
 *
 * The chain used to be Virtuals → Venice → Bankr. That was removed because:
 *   - The 3-rung retry mixed provider errors (Venice's own Bankr fallback
 *     could surface a "Bankr LLM 403…" string in the venice attempt slot).
 *   - It hid real Virtuals failures behind silent fabrication from the other
 *     rungs, defeating the whole point of a "primary provider" model.
 *   - Every rung was a separate log line to parse.
 *
 * `LlmResult` retains its shape (attempts array, web_search_used flag) for
 * API compatibility with callers that render "which provider answered" —
 * they just always see `virtuals`. `web_search_used` is always false; Virtuals
 * has no web-search capability, and the fabrication guard sits in the system
 * prompt now.
 */
export type LlmProvider = "virtuals";
export interface LlmResult {
  text: string;
  provider: LlmProvider;
  web_search_used: boolean;
  duration_ms: number;
  attempts: Array<{
    provider: LlmProvider;
    status: "success" | "error";
    duration_ms: number;
    error?: string;
  }>;
}

function llmLog(entry: {
  provider: LlmProvider;
  status: "success" | "error";
  duration_ms: number;
  web_search?: boolean;
  reason?: string;
}) {
  const parts = [
    `[llm]`,
    `provider=${entry.provider}`,
    `status=${entry.status}`,
    `duration_ms=${entry.duration_ms}`,
    entry.web_search !== undefined ? `web_search=${entry.web_search}` : null,
    entry.reason ? `reason="${entry.reason.replace(/"/g, "'").slice(0, 200)}"` : null,
  ].filter(Boolean);
  console.log(parts.join(" "));
}

export async function callLLM(opts: {
  system: string;
  user?: string;
  messages?: BankrMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** Ignored — retained for API compatibility with old callers. Virtuals has
   *  no web-search capability; every response is `web_search_used: false`. */
  webSearch?: boolean;
}): Promise<LlmResult> {
  const chainStart = Date.now();
  const attempts: LlmResult["attempts"] = [];

  const t0 = Date.now();
  try {
    const text = await callVirtualsLLM(opts);
    const dur = Date.now() - t0;
    llmLog({ provider: "virtuals", status: "success", duration_ms: dur, web_search: false });
    attempts.push({ provider: "virtuals", status: "success", duration_ms: dur });
    return { text, provider: "virtuals", web_search_used: false, duration_ms: Date.now() - chainStart, attempts };
  } catch (e) {
    const dur = Date.now() - t0;
    const msg = (e as Error).message;
    llmLog({ provider: "virtuals", status: "error", duration_ms: dur, reason: msg });
    attempts.push({ provider: "virtuals", status: "error", duration_ms: dur, error: msg });
    // Clean degradation contract: throw a typed error so callers can decide
    // to degrade (e.g. blue-hood brief.ts catches this and persists
    // arrow.brief=null, keeping the arrow's numbers intact — no fabrication).
    const err = new Error(`LLM_UNAVAILABLE: virtuals=${msg}`);
    (err as Error & { code?: string; attempts?: unknown }).code = "LLM_UNAVAILABLE";
    (err as Error & { attempts?: unknown }).attempts = attempts;
    throw err;
  }
}

/**
 * @deprecated LEGACY SHIM. Venice HTTP was removed 2026-07-25 (Virtuals-only
 * policy). This export stays so ~15 x402 handlers that import `callVeniceLLM`
 * keep compiling — internally it now delegates to Virtuals. `webSearch` is
 * ignored (Virtuals can't search). Migrate to `callLLM(opts)` when touching
 * a handler; that path throws a typed `LLM_UNAVAILABLE` on failure instead
 * of returning a bare string, which is what most callers actually want.
 */
let _veniceDeprecationLogged = false;
export async function callVeniceLLM(opts: {
  system: string;
  user?: string;
  messages?: BankrMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  webSearch?: boolean;
}): Promise<string> {
  if (!_veniceDeprecationLogged) {
    console.warn("[llm] callVeniceLLM is a deprecated shim → Virtuals. Migrate to callLLM().");
    _veniceDeprecationLogged = true;
  }
  return callVirtualsLLM({
    system: opts.system,
    user: opts.user,
    messages: opts.messages,
    // opts.model was previously a Venice model id (llama-3.3-70b, etc.);
    // dropping it here lets Virtuals pick from its own catalog. If a caller
    // needs a specific Virtuals model, migrate to callLLM/callVirtualsLLM.
    temperature: opts.temperature,
    maxTokens: opts.maxTokens,
  });
}

export function extractJsonObject(text: string): Record<string, unknown> | null {
  let raw = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
  const s = raw.indexOf("{");
  if (s < 0) return null;
  const e = raw.lastIndexOf("}");
  if (e > s) raw = raw.slice(s, e + 1);
  else raw = raw.slice(s); // no closing brace — truncated

  // 1. Direct parse
  try { return JSON.parse(raw); } catch {}
  // 2. Strip control chars
  try { return JSON.parse(raw.replace(/[\x00-\x1F\x7F]/g, " ")); } catch {}
  // 3. Repair truncated JSON (LLM hit max_tokens mid-output)
  try { return JSON.parse(repairTruncatedJson(raw)); } catch {}
  return null;
}

/**
 * Repair JSON that was cut off mid-stream (e.g. LLM hit max_tokens).
 * Walks the string tracking string/brace/bracket state, drops any
 * trailing incomplete token, then closes all open structures.
 */
function repairTruncatedJson(raw: string): string {
  const stack: string[] = [];
  let inStr = false, escaped = false;
  let lastSafe = 0; // index after the last closed container, closed string, or comma

  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') { inStr = false; lastSafe = i + 1; }
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    else if (c === "{") stack.push("}");
    else if (c === "[") stack.push("]");
    else if (c === "}" || c === "]") { stack.pop(); lastSafe = i + 1; }
    else if (c === ",") lastSafe = i; // safe to cut before the comma
  }

  // Roll back to last complete value, drop dangling comma, then drop a
  // dangling key that has no value yet (model cut off after `"key":`)
  let fixed = raw.slice(0, lastSafe).replace(/,\s*$/, "");
  fixed = fixed.replace(/,?\s*"[^"]*"\s*:?\s*$/, "");
  // Recompute open structures up to the cut point
  const reopen: string[] = [];
  let s2 = false, esc = false;
  for (let i = 0; i < fixed.length; i++) {
    const c = fixed[i];
    if (s2) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') s2 = false; continue; }
    if (c === '"') s2 = true;
    else if (c === "{") reopen.push("}");
    else if (c === "[") reopen.push("]");
    else if (c === "}" || c === "]") reopen.pop();
  }
  while (reopen.length) fixed += reopen.pop();
  return fixed;
}

// ─── Aeon skill runner — prefer REAL KV output; LLM is a labelled fallback ───
//
// Per CLAUDE.md: Aeon facts must come from the research-loop KV (getAeonOutput),
// NOT from "synthesize from training knowledge" — that fabricates. So we try KV
// first and return the real output. Only if KV is missing/stale do we produce a
// model-generated DRAFT, and we (a) instruct the model not to invent measured
// numbers and (b) LABEL the result so nothing downstream mistakes it for real
// Aeon data.

export async function runAeonSkill(skill: string, varInput = ""): Promise<string | null> {
  // 1. Real Aeon output from KV (fed by the research-loop cron).
  const real = await getAeonOutput(skill);
  if (real) return formatAeonForLLM(real);

  // 2. Fallback: model-generated estimate, explicitly labelled — not real data.
  try {
    const skillPrompt = await loadSkillFile(`${AEON_BASE}/skills/${skill}/SKILL.md`);
    if (!skillPrompt) return null;
    const today   = new Date().toISOString().split("T")[0];
    const varLine = varInput ? `\nFocus on: ${varInput}` : "";
    const draft = await callBankrLLM({
      model: "claude-haiku-4-5",
      system: `You are drafting a MODEL-GENERATED ESTIMATE in the style of the Aeon skill below. You do NOT have live data. Produce a plausible framework only — NEVER invent specific prices, market caps, volumes, or on-chain figures as if measured. Today is ${today}.`,
      messages: [{ role: "user", content: `Follow this skill template. Where a real figure would go, write "unknown" instead of inventing one.\n\nSkill:\n${skillPrompt}${varLine}\n\nReturn only the skill output, no preamble.` }],
      temperature: 0.2,
      maxTokens: 1200,
      _skipEnhance: true, // Aeon has its own identity
    });
    if (!draft) return null;
    return `=== MODEL-GENERATED ESTIMATE (no live Aeon data for "${skill}") ===\n${draft}`;
  } catch (e) { console.error("[llm] skill error:", (e as Error).message); return null; }
}

// ─── MiroShark skill runner (uses real collab prompt) ────────────────────────
//
// MiroShark is a scenario simulator — it spawns a crowd of agents and returns
// a confidence-weighted forecast. Use this for community/market consensus steps.

export async function runMiroSharkSkill(opts: {
  /** The scenario to simulate — e.g. "Launch $TOKEN with these metrics" */
  scenario: string;
  /** Structured context passed to MiroShark */
  context: Record<string, unknown>;
  /** Persona hint: "retail" | "analyst" | "influencer" | "observer" | "4-persona" */
  persona?: string;
  /** JSON output schema hint */
  outputSchema?: string;
  maxTokens?: number;
}): Promise<string | null> {
  try {
    const miroPrompt = await loadSkillFile(SKILL_URLS.miroshark);
    const personaLine = opts.persona
      ? `\n\n## Active persona: ${opts.persona}`
      : "";
    const schemaLine = opts.outputSchema
      ? `\n\nReturn ONLY raw JSON.\nSchema: ${opts.outputSchema}`
      : "";

    const system = miroPrompt
      ? `${miroPrompt}${personaLine}${schemaLine}`
      : `You are MiroShark — scenario simulator. ${personaLine}${schemaLine}`;

    return await callBankrLLM({
      model: "claude-haiku-4-5",
      system,
      messages: [{
        role: "user",
        content: `Scenario: ${opts.scenario}\n\nContext:\n${JSON.stringify(opts.context, null, 2)}`,
      }],
      temperature: 0.5,
      maxTokens: opts.maxTokens ?? 600,
      _skipEnhance: true, // already loaded real prompt above
    });
  } catch (e) { console.error("[llm] skill error:", (e as Error).message); return null; }
}

// ─── Blue Agent skill runner (uses real identity + skill files) ───────────────
//
// Use for Blue Agent synthesis / verdict steps.
// skillFiles: list of filenames from skills/ dir (e.g. ["token-launch-guide.md"])

export async function runBlueSkill(opts: {
  /** What Blue Agent is doing — the task description */
  task: string;
  /** Additional skill files from skills/ to load */
  skillFiles?: string[];
  /** Input context string */
  input: string;
  /** JSON output schema */
  outputSchema?: string;
  maxTokens?: number;
}): Promise<string | null> {
  try {
    const [identity, ...extras] = await Promise.all([
      loadSkillFile(SKILL_URLS.blueIdentity),
      ...(opts.skillFiles ?? []).map(f =>
        loadSkillFile(`${GITHUB_BASE}/skills/${f}`)
      ),
    ]);

    const skillContext = [identity, ...extras].filter(Boolean).join("\n\n---\n\n");
    const schemaLine   = opts.outputSchema
      ? `\n\nReturn ONLY raw JSON.\nSchema: ${opts.outputSchema}`
      : "";

    const system = skillContext
      ? `${skillContext}\n\n---\n\n## Task\n${opts.task}${schemaLine}`
      : `You are Blue Agent — AI-native intelligence for Base builders.\n\n## Task\n${opts.task}${schemaLine}`;

    return await callBankrLLM({
      model: "claude-haiku-4-5",
      system,
      messages: [{ role: "user", content: opts.input }],
      temperature: 0.3,
      maxTokens: opts.maxTokens ?? 1000,
      _skipEnhance: true,
    });
  } catch (e) { console.error("[llm] skill error:", (e as Error).message); return null; }
}
