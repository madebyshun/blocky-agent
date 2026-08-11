/**
 * Blue Agent Credit System — token-free daily allowance
 *
 * Chat credits are decoupled from $BLUEAGENT. Everyone gets a free daily
 * bucket — no token to hold, nothing to stake:
 *   Guest  (no wallet):     100 cr/day  (session/device — enough to feel it)
 *   Member (any wallet):    500 cr/day  (connect any wallet, no token needed)
 *
 * The daily allowance is use-it-or-lose-it and refreshes every 24h. Need more
 * than the daily bucket? Buy a credit pack in USDC on Base (x402) — that tops
 * up a cumulative pool the ledger drains after the daily bucket is spent.
 * Hub tools stay pay-per-call in USDC; there is no token discount anymore.
 */

export const BLUE_TOKEN     = "0xf895783b2931c919955e18b5e3343e7c7c456ba3";
export const BASE_RPC       = "https://mainnet.base.org";
export const STAKING_ADDRESS = "0x69e539684EE48F71eCDAd58618d8e8a2423E279d";

const REFRESH_MS = 24 * 60 * 60 * 1000; // 24 hours

// ── LocalStorage key for last-known daily allowance ───────────────────────────
// Used to detect real tier upgrades (user bought more BLUE) vs normal deductions
const dailyKey = (a?: string) => a ? `blue_cr_daily_${a.toLowerCase()}` : "blue_cr_daily_guest";

// ── Tiers ─────────────────────────────────────────────────────────────────────

// "Member" = any connected wallet (token-free). "Guest" = no wallet.
// "Starter" | "Pro" | "Max" are retained only so older persisted/default
// values still type-check — getTierInfo no longer produces them.
export type HolderTier = "Guest" | "Member" | "Starter" | "Pro" | "Max";

export interface TierInfo {
  tier:        HolderTier;
  blueBalance: number;
  dailyCr:     number;   // credits per day (finite for every tier)
  discount:    number;   // Hub tool discount 0–0.50
  color:       string;
  nextTier?:   { name: string; need: number; dailyCr: number };
}

// Flat daily allowances — no token thresholds. Guest = no wallet (session/
// device bucket); Member = any connected wallet. These are the ONLY knobs for
// the free daily bucket now; bump them to tune the free tier.
export const GUEST_DAILY  = 100;   // no wallet — keyed by session/device id
export const WALLET_DAILY = 500;   // any connected wallet, no token required

export function getTierInfo(blueBalance: number): TierInfo {
  // Token-free: every connected wallet gets the same flat daily allowance and
  // zero Hub-tool discount. `blueBalance` is ignored for tier selection (echoed
  // back only so callers that still read the field keep working). Guests get
  // GUEST_DAILY via getDailyCr(tier, hasWallet=false), below.
  return {
    tier:        "Member",
    blueBalance,
    dailyCr:     WALLET_DAILY,
    discount:    0,
    color:       "#4FC3F7",
  };
}

export function getDailyCr(tier: TierInfo, hasWallet: boolean): number {
  if (!hasWallet) return GUEST_DAILY;
  return tier.dailyCr;
}

// ── Credit costs ──────────────────────────────────────────────────────────────

export const BASE_COST: Record<string, number> = {
  // V1 Virtuals catalog-driven presets (2026-07-24 spec). These are the
  // stable ids saved to localStorage; server resolves them → Virtuals
  // model ids via `VIRTUALS_PRESETS` in `_lib/llm.ts`. Cost per preset
  // matches the "chốt preset" chart shared in chat.
  balanced:               50,  // anthropic-claude-sonnet-5 · 200k ctx
  deep:                  200,  // anthropic-claude-opus-4-8 · 200k ctx · heavy reason
  private:                30,  // e2ee-deepseek-v4-flash · E2EE, no logs
  grok:                   60,  // x-ai-grok-4-20 · 2M ctx · optional
  // Bankr-legacy tier ids kept for localStorage compatibility. `fast`
  // in the V1 spec (deepseek-flash) shares an id with the legacy fast
  // tier — happy coincidence, no rename needed.
  fast:                   10,
  pro:                    50,
  max:                   200,
  deepseek:               10,
  // Venice — standard
  "venice-deepseek":      10,
  "venice-deepseek-pro":  30,
  "venice-kimi":          20,
  "venice-claude":        80,
  "venice-fable":         120,
  "venice-grok":          60,
  "venice-qwen":          40,
  "venice-mistral":       10,
  "venice-uncut":         20,
  // Venice — Privacy / E2EE
  "venice-e2ee-venice":   30,
  "venice-e2ee-gemma":    30,
  "venice-e2ee-qwen":     40,
};

export function creditCost(chatTier: string, holderTier: TierInfo): number {
  const base = BASE_COST[chatTier] ?? BASE_COST.pro;
  return Math.max(1, Math.round(base * (1 - holderTier.discount)));
}

// ── LocalStorage keys ─────────────────────────────────────────────────────────

const crKey      = (a?: string) => a ? `blue_cr_${a.toLowerCase()}`         : "blue_cr_guest";
const refreshKey = (a?: string) => a ? `blue_cr_refresh_${a.toLowerCase()}` : "blue_cr_refresh_guest";

// ── Credit helpers ────────────────────────────────────────────────────────────

export function getCredits(address?: string): number {
  if (typeof window === "undefined") return 0;
  const raw = localStorage.getItem(crKey(address));
  return raw !== null ? Math.max(0, parseInt(raw, 10)) : -1; // -1 = never initialized
}

export function setCredits(amount: number, address?: string): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(crKey(address), String(Math.max(0, amount)));
}

export function deductCredits(amount: number, address?: string): number {
  const next = Math.max(0, getCredits(address) - amount);
  setCredits(next, address);
  return next;
}

export function addCredits(amount: number, address?: string): number {
  const next = Math.max(0, getCredits(address)) + amount;
  setCredits(next, address);
  return next;
}

// ── Daily refresh ─────────────────────────────────────────────────────────────

export function getLastRefresh(address?: string): number {
  if (typeof window === "undefined") return 0;
  const raw = localStorage.getItem(refreshKey(address));
  return raw ? parseInt(raw, 10) : 0;
}

export function getNextRefresh(address?: string): number {
  return getLastRefresh(address) + REFRESH_MS;
}

export interface RefreshResult {
  credits:   number;
  refreshed: boolean;
  daily:     number;
}

/**
 * Call on mount after fetching blue balance.
 * Grants daily credits if 24h have passed since last refresh.
 */
export function refreshCreditsIfNeeded(
  blueBalance: number,
  address?: string,
): RefreshResult {
  if (typeof window === "undefined") return { credits: 0, refreshed: false, daily: 0 };

  const tier    = getTierInfo(blueBalance);
  const daily   = getDailyCr(tier, !!address);
  const last    = getLastRefresh(address);
  const now     = Date.now();
  const current = getCredits(address);

  const isFirstTime = current === -1;
  const isDue       = now - last >= REFRESH_MS;

  // Tier upgrade: only fires when daily QUOTA itself increased (user bought more BLUE).
  // Compare against last-known daily rather than current credits — otherwise any deduction
  // would look like a "tier upgrade" and reset credits back to full. Bug fix: was previously
  // `daily > current` which reset credits after every WalletBar re-fetch cycle.
  const lastKnownDaily = parseInt(localStorage.getItem(dailyKey(address)) ?? "0", 10);
  const tierUpgraded   = current >= 0 && lastKnownDaily > 0 && daily > lastKnownDaily;

  if (isFirstTime || isDue || tierUpgraded) {
    setCredits(daily, address);
    localStorage.setItem(refreshKey(address), String(now));
    localStorage.setItem(dailyKey(address), String(daily));
    return { credits: daily, refreshed: true, daily };
  }

  // First time we've seen a daily value — store it (without resetting credits)
  if (lastKnownDaily === 0 && current >= 0) {
    localStorage.setItem(dailyKey(address), String(daily));
  }

  return { credits: Math.max(0, current), refreshed: false, daily };
}

// ── BLUE balance (token-free stub) ────────────────────────────────────────────

/**
 * Token-free build: chat credits no longer depend on any on-chain balance, so
 * we no longer read $BLUEAGENT holdings or the staking contract. Kept as a
 * 0-returning async to preserve the import surface — callers still feed the
 * result into `getTierInfo`, which now ignores it. (The old multi-RPC
 * balanceOf + stakeInfo reader lived here; removed with the token tiers.)
 */
export async function fetchBlueBalance(address: string): Promise<number> {
  void address; // kept for the import surface; balance no longer affects credits
  return 0;
}
