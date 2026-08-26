import { stateEvents } from "./events";
import type { WalletState, WalletSnapshot } from "./types";

/**
 * Below this, the app's own 2-decimal USD formatter prints "$0.00".
 *
 * It is not an arbitrary threshold: it is the point where the page stops being
 * able to *show* a value. A card that prints "$0.00" in every number and
 * "holds assets" in every conditional is lying in one of the two places, so the
 * floor is pinned to the formatter rather than picked.
 */
export const DUST_USD = 0.005;

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

  // ── The ETH leg ─────────────────────────────────────────────────────────
  // Priced or not priced — never priced-by-assumption. `ethUsd` was computed
  // a second time in BankClient with the same expression; both live here now
  // so the chart, the ratio and the "is this wallet empty" test cannot drift
  // apart the way the last two did.
  //
  // Zero ETH is worth $0 at *any* price, so a missing feed does not make it
  // unknown — the price only matters when there is a balance to multiply by.
  // Without this case a stables-only wallet reports its split as unknown while
  // a glance at it shows the split plainly is 100/0.
  const ethBal = snapshot.ethBal ?? 0;
  const ethUsd = ethBal === 0             ? 0
               : snapshot.ethUsdPrice != null ? ethBal * snapshot.ethUsdPrice
               : null;

  /** Stables + the ETH leg *if we can price it*. A LOWER BOUND when we can't. */
  const pricedTotal  = balance + (ethUsd ?? 0);
  /** We hold ETH and have no price for it — the total above is incomplete. */
  const ethUnpriced  = ethUsd == null && ethBal > 0;

  // ── The one answer to "does this wallet hold anything?" ──────────────────
  // There were two, in adjacent lines of the same card: the donut asked
  // `balance > 0` (stablecoins only) while the Stablecoin bar asked
  // `allocation.stablecoin != null` (stables *and* priced ETH). On a wallet
  // holding dust ETH and no stables they disagree — so the card printed
  // "No assets yet" and, directly beneath it, "Stablecoin 0%" with a bar.
  // That is the same defect the 100% literal was, one release later: a second
  // definition of a thing that must have exactly one.
  //
  // Unpriced ETH still counts as holding something. We know the wallet is not
  // empty; we just can't say what it's worth, and those are different claims.
  const holdsAssets = pricedTotal > DUST_USD || ethUnpriced;

  // ── Allocation ──────────────────────────────────────────────────────────
  // This was `const allocStablecoin = 100;` — a literal, justified by the note
  // "the pie chart only shows stables". The card above it renders ETH too, and
  // the bar drew itself full-width at 100% on a wallet holding NOTHING, under
  // the words "No assets yet". A percentage is a claim about a ratio, so it
  // needs both terms: no ETH price, or no assets, means no percentage.
  //
  // Gated on `holdsAssets` so the invariant holds BY CONSTRUCTION:
  //   allocation.stablecoin != null  ⟹  holdsAssets
  // i.e. a percentage can never again render under "No assets yet".
  const ratioKnown = holdsAssets && ethUsd != null && pricedTotal > DUST_USD;
  const allocStablecoin = ratioKnown ? Math.round((balance / pricedTotal) * 100) : null;
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
    gasReserveEth:       ethBal,
    ethUsd,
    pricedTotal,
    ethUnpriced,
    holdsAssets,
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
