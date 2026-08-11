/**
 * Blue Hood — watchlist limits + the $BLUE premium gate, in ONE place.
 *
 * WHY A SEPARATE CONFIG FILE: the free/premium split is a product knob that
 * changes on a different clock than the code. Two things about it are NOT yet
 * fixed and must be changeable in exactly one edit, never by hunting logic:
 *
 *   1. The $BLUE hold that unlocks premium. $BLUE (the new token) hasn't
 *      relaunched — the number depends on target mcap + supply distribution,
 *      finalized WITH Virtuals AT launch. Putting a literal `500_000` in the
 *      code today is guessing on a token that has no final shape. So it lives
 *      in an env var (`WATCHLIST_PREMIUM_MIN_BLUE`) and DEFAULTS TO UNSET (0),
 *      which means "no premium tier exists yet — everyone is free".
 *
 *   2. Whether the tier gate is ENFORCED at all. Until 1.1 WalletProvider can
 *      hand us a real $BLUE balance AND the launch fixes the threshold, we do
 *      NOT block anyone by tier — the free feature (a single default list, a
 *      handful of tickers) works for every wallet, and we only LOG what the
 *      gate WOULD have blocked. `WATCHLIST_ENFORCE` flips that on later.
 *
 * Anti-bloat is orthogonal to the tier gate: a HARD absolute cap
 * (`HARD_MAX_ENTRIES`) is ALWAYS applied, gate on or off, so "we haven't
 * enabled tiers yet" can never mean "one wallet writes 10k tickers into KV"
 * (the exact quota-exhaustion class the 2026-07-27 Upstash-cap outage taught).
 */

export type WatchlistTierName = "free" | "premium";

export interface WatchlistTierLimit {
  /** Max tickers this tier may watch. */
  maxEntries: number;
  /** Whether the tier may create/name lists beyond the single default one. */
  allowCustom: boolean;
}

/** The two tiers. Change the numbers here only — every caller reads this map. */
export const WATCHLIST_LIMITS: Record<WatchlistTierName, WatchlistTierLimit> = {
  free:    { maxEntries: 5,  allowCustom: false },
  premium: { maxEntries: 50, allowCustom: true },
};

/**
 * Absolute anti-bloat ceiling, ALWAYS enforced regardless of the tier gate.
 * Equal to the most generous tier so a real premium user is never blocked by
 * it, but a runaway/abusive writer still can't balloon KV. This is the promise
 * behind Req 3 ("don't add a read/write source that can bloat KV").
 */
export const HARD_MAX_ENTRIES = WATCHLIST_LIMITS.premium.maxEntries;

/**
 * Min $BLUE balance to unlock premium. Read from env so it's set at launch,
 * not guessed now. `0` / unset ⇒ the premium tier is not live yet.
 */
export const WATCHLIST_PREMIUM_MIN_BLUE: number =
  Number(process.env.WATCHLIST_PREMIUM_MIN_BLUE ?? 0) || 0;

/**
 * Master switch for tier enforcement. Default OFF: the free feature works for
 * everyone and would-block decisions are logged, not applied. Flip to "1" once
 * 1.1 WalletProvider supplies a real balance AND the launch fixes the number.
 */
export const WATCHLIST_ENFORCE: boolean = process.env.WATCHLIST_ENFORCE_TIER === "1";

/**
 * Resolve a tier NAME from a $BLUE balance. Until the threshold is fixed
 * (WATCHLIST_PREMIUM_MIN_BLUE === 0), there is no premium tier and everyone
 * resolves to "free" — so the gate is a genuine no-op until launch, exactly as
 * intended. When 1.1 lands, pass `getTierInfo(balance).blueBalance` in here.
 */
export function watchlistTier(blueBalance: number | null | undefined): WatchlistTierName {
  if (!WATCHLIST_PREMIUM_MIN_BLUE) return "free";
  return (blueBalance ?? 0) >= WATCHLIST_PREMIUM_MIN_BLUE ? "premium" : "free";
}
