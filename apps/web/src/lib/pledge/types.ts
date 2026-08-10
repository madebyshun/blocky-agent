/**
 * Shared shapes for the pledge ledger.
 *
 * `amount` is kept as a decimal STRING of raw token units, never a JS number:
 * 1e27 raw units does not survive a `number`, and this value is the basis of
 * every published share. It is parsed back with `BigInt()` wherever it is
 * summed, and only converted to a display string at the very edge.
 */
import type { ChainKey } from "./config";

export interface PledgeTx {
  /** Checksummed sender — the wallet credited with the pledge. */
  wallet: string;
  chain: ChainKey;
  /** Raw token units as a decimal string (JSON-safe bigint). */
  amount: string;
  txHash: string;
  blockNumber: number;
  /** Unix seconds, or null when the source did not supply one. */
  timestamp: number | null;
}

/**
 * A source either returns a COMPLETE set of transfers or it fails. There is
 * deliberately no "partial" success: a half-read ledger renders as a holder's
 * pledge having vanished, which on this page is indistinguishable from theft.
 * `truncated` exists only for the hard page cap and is surfaced to the UI.
 */
export type SourceResult =
  | { ok: true; txs: PledgeTx[]; source: "indexer" | "rpc"; truncated: boolean }
  | { ok: false; error: string };

export interface WalletPledge {
  wallet: string;
  chain: ChainKey;
  totalAmount: string;
  totalFormatted: string;
  /** Percent of that chain's total supply, e.g. 0.4231 = 0.4231%. */
  pctOfSupply: number;
  txCount: number;
  txs: { txHash: string; timestamp: number | null; amount: string }[];
}

export interface ChainSummary {
  chain: ChainKey;
  label: string;
  shortLabel: string;
  tokenAddress: string;
  symbol: string;
  decimals: number;
  totalSupply: string;
  /** Whether the denominator came from the contract or the pinned fallback. */
  supplySource: "onchain" | "pinned";
  totalPledged: string;
  totalFormatted: string;
  pctOfSupply: number;
  walletCount: number;
  txCount: number;
  /** Which path produced these numbers. */
  source: "indexer" | "rpc" | "none";
  /**
   * `ok`       — read succeeded, numbers below are current.
   * `degraded` — read FAILED. Numbers below are whatever was last known, or
   *              zero if nothing was ever read. The UI must say so out loud;
   *              rendering a degraded chain as "0 pledged" is a lie that reads
   *              as "your pledge is gone".
   */
  status: "ok" | "degraded";
  error?: string;
  truncated?: boolean;
}

export interface LedgerSnapshot {
  /** ms epoch of the read that produced these numbers. */
  updatedAt: number;
  /** True when ANY chain is degraded. */
  degraded: boolean;
  /** True when this is a cached snapshot served because a refresh failed. */
  stale: boolean;
  staleAgeS: number;
  receivingWallet: string;
  deadlineIso: string | null;
  chains: Record<ChainKey, ChainSummary>;
  wallets: WalletPledge[];
}
