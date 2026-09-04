/**
 * Credit pricing — Phase 1 of the credit-economics redesign.
 *
 * Anchor:  1 credit = $0.0005 USD
 * Therefore: 1 USDC = 2000 credits
 *
 * This file holds the single source of truth for:
 *   - chatCreditCost(model, tier)  — credits per chat message
 *   - toolCreditCost(toolId, tier) — credits per x402 tool call
 *   - topupBundles                  — USDC → credits conversion at top-up time
 *
 * The dollar-equivalent anchor lets a direct x402 USDC payer and a credit
 * payer settle the same economic value, so there's no arbitrage between
 * the two billing rails.
 */

import { AGENT_TOOLS } from "./agent-tools";
import { getTierInfo, type TierInfo } from "./credits";
import { VIRTUALS_PRESETS_V1 } from "@/app/chat/components/presets";

// ─── Anchor rate ─────────────────────────────────────────────────────────────

/** USDC value of 1 credit. 1 cr = $0.0005 → 50 cr Sonnet msg = $0.025. */
export const CREDIT_USD = 0.0005;
/** Credits earned per USDC paid at top-up time (inverse of CREDIT_USD). */
export const CREDITS_PER_USDC = Math.round(1 / CREDIT_USD); // 2000

// ─── Chat message costs ──────────────────────────────────────────────────────

/**
 * Every live preset, priced by the preset spec itself.
 *
 * These entries used to be retyped by hand below, and four of them —
 * `balanced`, `deep`, `private`, `grok` — were simply never added. Because the
 * lookup falls back to `pro` (50), a preset could be mispriced by OMISSION
 * rather than by a wrong number, which is invisible in review. Measured
 * 2026-09-04, before this change: Deep quoted 200 and debited 50, Grok quoted
 * 60 and debited 50, and Private quoted 30 while debiting 50 — the user paid
 * 67% more than the composer told them they would.
 *
 * Deriving the map means a preset cannot be added without a price, and cannot
 * carry a price the picker disagrees with, because it is now the same number.
 */
const PRESET_COSTS: Record<string, number> = Object.fromEntries(
  VIRTUALS_PRESETS_V1.map((p) => [p.id, p.credits]),
);

/**
 * Base chat-message cost in credits, before tier discount. These align with
 * the cost-of-LLM-call math at CREDIT_USD = $0.0005:
 *   Haiku (fast)   ~$0.001 cost  → 10 cr ($0.005 charge,  5x markup)
 *   Sonnet (pro)   ~$0.003 cost  → 50 cr ($0.025 charge,  8x markup)
 *   Opus  (max)    ~$0.015 cost  → 200 cr ($0.10 charge, 6.7x markup)
 * Venice models are slotted by capability tier.
 */
export const CHAT_BASE_COST: Record<string, number> = {
  // ── Legacy ids ──
  // Not presets. These are `tier` values older builds persisted to
  // localStorage and may still send; kept as literals so an old client keeps
  // being charged what it was quoted.
  pro:      50,
  max:      200,
  deepseek: 10,
  gemini:   20,
  kimi:     20,
  // Venice — standard
  "venice-deepseek":     10,
  "venice-deepseek-pro": 30,
  "venice-kimi":         20,
  "venice-claude":       80,
  "venice-fable":        120,
  "venice-grok":         60,
  "venice-qwen":         40,
  "venice-mistral":      10,
  "venice-uncut":        20,
  // Venice — Privacy / E2EE
  "venice-e2ee-venice":  30,
  "venice-e2ee-gemma":   30,
  "venice-e2ee-qwen":    40,

  // ── Live presets, LAST so the spec always wins ──
  // Spread last on purpose: `fast` is both a preset id and a legacy Bankr tier,
  // and any future collision must resolve to the price the picker is showing,
  // not to a stale literal someone left above. `free` lands here as 0, which
  // the server reads as "skip the ledger debit" (see `debitChatCredits`'s
  // zero-cost-tier short-circuit) — not as a missing entry.
  ...PRESET_COSTS,
};

/** Apply tier discount + minimum-1 to a base cost. */
function applyDiscount(base: number, tier: TierInfo): number {
  return Math.max(1, Math.round(base * (1 - tier.discount)));
}

/** Credits to charge for a single chat message, after tier discount. */
export function chatCreditCost(modelKey: string, tier: TierInfo): number {
  const base = CHAT_BASE_COST[modelKey] ?? CHAT_BASE_COST.pro;
  // A genuinely free tier (base 0) resolves to 0, not the Math.max(1,…) floor
  // in applyDiscount — that floor guards a discounted PAID tier from rounding
  // to free, the opposite concern. Only an explicit 0 base is free. Mirrors the
  // same guard in `creditCost` (credits.ts).
  if (base <= 0) return 0;
  return applyDiscount(base, tier);
}

// ─── Tool call costs ─────────────────────────────────────────────────────────

/**
 * Parses a price string like "$0.25" → 0.25 (number). Returns null for
 * non-numeric placeholders ("Free", "—", etc.).
 */
function parseUsd(price: string | undefined): number | null {
  if (!price) return null;
  const m = price.match(/\$?([\d.]+)/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** Round to nearest 10 credits — keeps the UI tidy ("100 cr" not "97 cr"). */
function roundCredits(n: number): number {
  return Math.max(1, Math.round(n / 10) * 10);
}

/**
 * Cost of a tool call in credits, computed from its x402 USDC price.
 *   tool.price = "$0.25"  →  500 cr at zero discount
 *                          → 400 cr at Pro tier (20% off)
 *                          → 300 cr at Max tier (40% off)
 *
 * Tools without a known USDC price (free utilities, hub_crypto_rpc) cost 0
 * — the caller should still respect daily allowance / rate limit, but no
 * credits are deducted.
 */
export function toolCreditCost(toolId: string, tier: TierInfo): number {
  // Every tier is metered. Max gets the deepest discount (40% off) but still
  // pays — no tier is free/unlimited.
  const tool = AGENT_TOOLS.find(t => t.id === toolId);
  const usd  = parseUsd(tool?.price);
  if (usd === null || usd <= 0) return 0;
  const baseCredits = roundCredits(usd * CREDITS_PER_USDC);
  return applyDiscount(baseCredits, tier);
}

/** Convenience: cost given an effective BLUE balance instead of a TierInfo. */
export function toolCreditCostFor(toolId: string, blueBalance: number): number {
  return toolCreditCost(toolId, getTierInfo(blueBalance));
}

// ─── Top-up bundles ──────────────────────────────────────────────────────────

/**
 * Bundles offered in the out-of-credits modal. The first bundle is the
 * cleanest 1:1 conversion at the anchor rate; the second adds a 25% bonus
 * to lift average ticket size from $5 → $20.
 */
export interface TopupBundle {
  id:        string;
  usdc:      number;     // USDC user pays
  credits:   number;     // credits added to ledger
  bonusPct:  number;     // 0 → no bonus, 0.25 → +25%
  label:     string;
}

export const TOPUP_BUNDLES: TopupBundle[] = [
  { id: "small", usdc:  5, credits:  5 * CREDITS_PER_USDC,                 bonusPct: 0,    label: "Starter top-up" },
  { id: "big",   usdc: 20, credits: Math.round(20 * CREDITS_PER_USDC * 1.25), bonusPct: 0.25, label: "Power user · +25% bonus" },
];

// ─── Display helpers ─────────────────────────────────────────────────────────

/** Format `1234` → "1,234 cr". */
export function fmtCredits(n: number): string {
  return `${n.toLocaleString()} cr`;
}

/** Format credits as USD-equivalent, e.g. 500 → "$0.25". */
export function creditsToUsd(n: number): string {
  const usd = n * CREDIT_USD;
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1)    return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}
