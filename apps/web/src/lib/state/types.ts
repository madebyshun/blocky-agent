export interface WalletState {
  /** Stablecoins only — wallet USDC plus everything deployed in yield. */
  balance: number;
  walletUsdc: number;
  inYield: number;
  gasReserveEth: number;     // ETH balance, in ETH
  /** ETH leg in USD at the live price; `null` when the price feed failed. */
  ethUsd: number | null;
  /** `balance + (ethUsd ?? 0)` — a LOWER BOUND while `ethUnpriced` is true. */
  pricedTotal: number;
  /** Holds ETH but has no price for it, so `pricedTotal` is incomplete. */
  ethUnpriced: boolean;
  /**
   * The single answer to "does this wallet hold anything?".
   *
   * Every empty-state in the wallet UI must read THIS and not re-derive it.
   * Two independent derivations is exactly the bug this field exists to kill:
   * the allocation card once asked `balance > 0` for the chart and
   * `allocation.stablecoin != null` for the bar, and on a wallet holding dust
   * ETH and no stables it answered both "No assets yet" and "Stablecoin 0%".
   *
   * True when priced value clears the display floor (`DUST_USD`), OR when
   * there is ETH we cannot price — "not empty" and "worth $X" are separate
   * claims and only the second one needs a price.
   */
  holdsAssets: boolean;
  /**
   * Split of the portfolio by USD value. `null` on BOTH fields means the split
   * is unknown — either there is nothing to split, or the ETH leg has no price.
   * It used to be `{ stablecoin: 100, other: 0 }` unconditionally, a literal
   * that drew a full-width "Stablecoin 100%" bar on a wallet holding nothing.
   *
   * Invariant, enforced in buildWalletState: `stablecoin != null ⟹ holdsAssets`.
   */
  allocation: {
    stablecoin: number | null;   // % of priced value held in stablecoins
    other: number | null;        // % held in everything else (currently ETH)
  };
  netFlowMonth: number;
  transferCountMonth: number;
  gasSavedUsd: number | null; // null when no real tx data
  healthScore: number;         // 0-100
  updatedAt: string;
}

/**
 * Raw readings the wallet page hands in. Every field is something we MEASURED
 * about this user — a balance, a transfer count, a price we fetched to convert
 * one of them.
 *
 * `bestApy` used to sit in here and was the exception: the top USDC yield on
 * DefiLlama, a market-wide figure with nothing to do with the wallet being
 * described. It fed a 25-point term in `healthScore` and a "$X earning Y%" line
 * in the UI, where Y was a rate this user was not being paid. Removed when the
 * wallet stopped selling yield — and the shape of the type is the guardrail:
 * with no market data in the snapshot, no derived field can quietly become one.
 */
export interface WalletSnapshot {
  walletUsdc: number;
  aavePos: number;
  morphoPos: number;
  ethBal: number;
  netFlowMonth: number;
  transferCountMonth: number;
  /** Live ETH/USD from /api/wallet/transactions; `null` when the feed failed. */
  ethUsdPrice: number | null;
  /** Already derived server-side against the SAME live price — passed through,
   *  not recomputed, so the two can never disagree. */
  gasSavedUsd: number | null;
}
