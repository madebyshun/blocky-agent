export interface WalletState {
  balance: number;
  walletUsdc: number;
  inYield: number;
  gasReserveEth: number;     // ETH balance, in ETH
  /**
   * Split of the portfolio by USD value. `null` on BOTH fields means the split
   * is unknown — either there is nothing to split, or the ETH leg has no price.
   * It used to be `{ stablecoin: 100, other: 0 }` unconditionally, a literal
   * that drew a full-width "Stablecoin 100%" bar on a wallet holding nothing.
   */
  allocation: {
    stablecoin: number | null;   // % of priced value held in stablecoins
    other: number | null;        // % held in everything else (currently ETH)
  };
  bestApy: number | null;
  netFlowMonth: number;
  transferCountMonth: number;
  gasSavedUsd: number | null; // null when no real tx data
  healthScore: number;         // 0-100
  updatedAt: string;
}

export interface WalletSnapshot {
  walletUsdc: number;
  aavePos: number;
  morphoPos: number;
  ethBal: number;
  bestApy: number | null;
  netFlowMonth: number;
  transferCountMonth: number;
  /** Live ETH/USD from /api/wallet/transactions; `null` when the feed failed. */
  ethUsdPrice: number | null;
  /** Already derived server-side against the SAME live price — passed through,
   *  not recomputed, so the two can never disagree. */
  gasSavedUsd: number | null;
}
