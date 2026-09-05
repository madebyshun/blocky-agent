// The chains the wallet can display, and the dollar token each one settles in.
//
// This exists because the wallet used to read its network config out of
// `yield-execution.ts` — the Aave supply/withdraw module. Every chain the wallet
// could show therefore had to be a chain Aave had a lending market on, and
// deleting Earn from the wallet would have taken the network switcher with it.
// Identity ("which chain am I looking at, and what is cash here?") is a wallet
// concern; a lending pool address is not. They are separate files now.
//
// Deliberately NOT here: pool / aUsdc / venue addresses. If a field only makes
// sense to Earn, it belongs to Earn.

import { getAddress } from "viem";
import { base, baseSepolia } from "wagmi/chains";
import { robinhoodMainnet } from "@/lib/robinhood/chains";

export type WalletChain = "base" | "baseSepolia" | "robinhood";

export interface WalletChainCfg {
  chainId: number;
  /** Full name, for banners and the network chip. */
  label: string;
  /** Short name, for inline prose ("add USDC on Base"). */
  short: string;
  explorer: string;
  /**
   * Display name for `explorer`. Carried WITH the URL because call sites kept
   * hardcoding "Basescan" next to an explorer href — so on Sepolia the link read
   * "Basescan" and went to sepolia.basescan.org. Same trap now applies double:
   * Robinhood Chain's explorer is Blockscout, and the two chains share no state,
   * so a Basescan link for a 4663 address resolves to nothing.
   */
  explorerName: string;
  testnet: boolean;
  /**
   * The chain's canonical dollar token — what this wallet calls "cash".
   *
   * Named `stable`, not `usdc`, because it is NOT always USDC: Robinhood Chain
   * settles in USDG. A field named for one token while holding another is how
   * the "Basescan" bug above happened, one layer down.
   */
  stable: `0x${string}`;
  stableSymbol: "USDC" | "USDG";
  stableDecimals: number;
}

/**
 * Every address here is verified on ITS OWN chain — Base contracts on Base,
 * Robinhood contracts on Robinhood. The two chains share no state, so an
 * explorer check on the wrong one proves nothing.
 *
 * USDG is the repo's existing registry value (`lib/robinhood/rwa-registry.ts`,
 * which carries a deployer check), re-confirmed live 2026-09-05 against
 * rpc.mainnet.chain.robinhood.com: symbol() → "USDG", decimals() → 6,
 * eth_chainId → 0x1237 (4663). Base USDC re-confirmed the same day against
 * mainnet.base.org: symbol() → "USDC", decimals() → 6.
 */
export const WALLET_CHAINS: Record<WalletChain, WalletChainCfg> = {
  base: {
    chainId: base.id,
    label: "Base mainnet",
    short: "Base",
    explorer: "https://basescan.org",
    explorerName: "Basescan",
    testnet: false,
    stable: getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
    stableSymbol: "USDC",
    stableDecimals: 6,
  },
  baseSepolia: {
    chainId: baseSepolia.id,
    label: "Base Sepolia (testnet)",
    short: "Sepolia",
    explorer: "https://sepolia.basescan.org",
    explorerName: "Sepolia Basescan",
    testnet: true,
    stable: getAddress("0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f"),
    stableSymbol: "USDC",
    stableDecimals: 6,
  },
  robinhood: {
    chainId: robinhoodMainnet.id,
    label: "Robinhood Chain",
    short: "Robinhood",
    explorer: "https://robinhoodchain.blockscout.com",
    explorerName: "Blockscout",
    testnet: false,
    stable: getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"),
    stableSymbol: "USDG",
    stableDecimals: 6,
  },
};

/**
 * The order the network switcher renders — deliberately narrower than
 * `WALLET_CHAINS`. Defining a chain is not the same as shipping it in the UI,
 * and keeping the two separate means adding a chain to the switcher is a
 * one-line change to a list rather than an edit spread across a component.
 *
 * Robinhood is configured but not yet listed: the wallet's balance reads, send
 * and swap paths are still Base-shaped, so surfacing it before those are ready
 * would offer the user a chain the buttons cannot actually transact on.
 */
export const WALLET_CHAIN_ORDER: readonly WalletChain[] = ["base", "baseSepolia"];

/** Reverse lookup for a numeric chainId, e.g. decoding an EIP-681 URI. */
export function walletChainByChainId(chainId: number): WalletChain | undefined {
  return (Object.keys(WALLET_CHAINS) as WalletChain[]).find(
    (k) => WALLET_CHAINS[k].chainId === chainId,
  );
}
