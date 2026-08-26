import { stateEvents } from "./events";
import type { WalletState, WalletSnapshot } from "./types";

/**
 * Pure function — derives a canonical WalletState from raw on-chain readings.
 * Emits STATE_UPDATED after computing.
 *
 * Design rules:
 * - Every number here is DERIVED from the snapshot. Nothing is asserted.
 * - Missing input → `null` output, never a plausible-looking placeholder.
 * - healthScore is additive: 4 × 25-pt dimensions
 */
export function buildWalletState(snapshot: WalletSnapshot): WalletState {
  const inYield = (snapshot.aavePos ?? 0) + (snapshot.morphoPos ?? 0);
  const balance = (snapshot.walletUsdc ?? 0) + inYield;

  // ── Allocation ──────────────────────────────────────────────────────────
  // This was `const allocStablecoin = 100;` — a literal, justified by the note
  // "the pie chart only shows stables". The card above it renders ETH too, and
  // the bar drew itself full-width at 100% on a wallet holding NOTHING, under
  // the words "No assets yet". A percentage is a claim about a ratio, so it
  // needs both terms: no ETH price, or no assets, means no percentage.
  const ethUsd  = snapshot.ethUsdPrice != null ? (snapshot.ethBal ?? 0) * snapshot.ethUsdPrice : null;
  const priced  = ethUsd != null ? balance + ethUsd : null;
  const allocStablecoin = priced != null && priced > 0 ? Math.round((balance / priced) * 100) : null;
  const allocOther      = allocStablecoin != null ? 100 - allocStablecoin : null;

  // Gas saved was recomputed here as `transferCount × 0.001 × 2500` — a second,
  // fabricated ETH price sitting next to the real one the API had already used.
  // The route's value is the only one now.
  const gasSavedUsd = snapshot.gasSavedUsd ?? null;

  // Health score 0-100: 4 × 25-point dimensions
  const healthScore = Math.min(
    100,
    Math.round(
      (inYield > 0 ? 25 : 0) +
      (snapshot.bestApy != null ? 25 : 0) +
      (snapshot.ethBal > 0.005 ? 25 : 0) +
      (snapshot.transferCountMonth > 0 ? 25 : 0),
    ),
  );

  const state: WalletState = {
    balance,
    walletUsdc:          snapshot.walletUsdc ?? 0,
    inYield,
    gasReserveEth:       snapshot.ethBal ?? 0,
    allocation:          { stablecoin: allocStablecoin, other: allocOther },
    bestApy:             snapshot.bestApy,
    netFlowMonth:        snapshot.netFlowMonth ?? 0,
    transferCountMonth:  snapshot.transferCountMonth ?? 0,
    gasSavedUsd,
    healthScore,
    updatedAt:           new Date().toISOString(),
  };

  stateEvents.emit("STATE_UPDATED", state);
  return state;
}
