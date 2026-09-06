// Blue Chat — Aave v3 yield execution config (NON-custodial).
//
// The user SIGNS approve + supply / withdraw from their OWN wallet via wagmi —
// Blue Agent never holds keys or funds. This file only supplies verified
// addresses + ABIs + amount parsing; the MoveToYieldCard composes the calls.
//
// Addresses are VERIFIED from the official Aave Address Book (bgd-labs), never
// guessed. Mirrors blueagent-runtime/src/core/execution.ts. Base only.
//   Base mainnet  Pool 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5
//   Base Sepolia  Pool 0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27

import { parseUnits, maxUint256, getAddress, type Abi } from "viem";
import { base, baseSepolia } from "wagmi/chains";

export type YieldNetwork = "base" | "baseSepolia";

export interface YieldNetCfg {
  chainId: number;
  label: string;
  short: string;
  explorer: string;
  /**
   * Display name for `explorer`. Exists because call sites kept hardcoding the
   * string "Basescan" next to a `net.explorer` href — so on Sepolia the link
   * read "Basescan" and went to sepolia.basescan.org. Carrying the label with
   * the URL makes that class of drift impossible.
   */
  explorerName: string;
  testnet: boolean;
  pool: `0x${string}`;
  usdc: `0x${string}`;
  aUsdc: `0x${string}`;
  usdcDecimals: number;
}

export const YIELD_NETWORKS: Record<YieldNetwork, YieldNetCfg> = {
  baseSepolia: {
    chainId: baseSepolia.id,
    label: "Base Sepolia (testnet)",
    short: "Sepolia",
    explorer: "https://sepolia.basescan.org",
    explorerName: "Sepolia Basescan",
    testnet: true,
    pool:  getAddress("0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27"),
    usdc:  getAddress("0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f"),
    aUsdc: getAddress("0x10F1A9D11CDf50041f3f8cB7191CBE2f31750ACC"),
    usdcDecimals: 6,
  },
  base: {
    chainId: base.id,
    label: "Base mainnet",
    short: "Base",
    explorer: "https://basescan.org",
    explorerName: "Basescan",
    testnet: false,
    pool:  getAddress("0xA238Dd80C259a72e81d7e4664a9801593F98d1c5"),
    usdc:  getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
    aUsdc: getAddress("0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB"),
    usdcDecimals: 6,
  },
};

export const ERC20_ABI = [
  { name: "approve", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { name: "allowance", type: "function", stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "balanceOf", type: "function", stateMutability: "view",
    inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "transfer", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  // `decimals` is the ONLY safe source for a token's scale. Anything that turns
  // a human-typed amount into base units (parseUnits) must read it from the
  // token itself — never from a constant, and never from a launch record, which
  // has no such field to carry it. The bug this closed (PR #414): the launch
  // trade modals hardcoded `const tokenDecimals = 18` and fed it straight to
  // parseUnits, so a 6-decimal token would have encoded 1e12× the intended
  // amount. Those modals were removed with /app/launches on 2026-09-07, but the
  // rule outlived them — it applies to every new call site.
  { name: "decimals", type: "function", stateMutability: "view",
    inputs: [], outputs: [{ type: "uint8" }] },
] as const satisfies Abi;

export const AAVE_POOL_ABI = [
  { name: "supply", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "asset", type: "address" }, { name: "amount", type: "uint256" }, { name: "onBehalfOf", type: "address" }, { name: "referralCode", type: "uint16" }], outputs: [] },
  { name: "withdraw", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "asset", type: "address" }, { name: "amount", type: "uint256" }, { name: "to", type: "address" }], outputs: [{ type: "uint256" }] },
  // Aave v3 ReserveData (legacy layout). We only read currentLiquidityRate (the
  // supply APR, in ray) to derive the live supply APY.
  { name: "getReserveData", type: "function", stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [{ type: "tuple", components: [
      { name: "configuration", type: "tuple", components: [{ name: "data", type: "uint256" }] },
      { name: "liquidityIndex", type: "uint128" },
      { name: "currentLiquidityRate", type: "uint128" },
      { name: "variableBorrowIndex", type: "uint128" },
      { name: "currentVariableBorrowRate", type: "uint128" },
      { name: "currentStableBorrowRate", type: "uint128" },
      { name: "lastUpdateTimestamp", type: "uint40" },
      { name: "id", type: "uint16" },
      { name: "aTokenAddress", type: "address" },
      { name: "stableDebtTokenAddress", type: "address" },
      { name: "variableDebtTokenAddress", type: "address" },
      { name: "interestRateStrategyAddress", type: "address" },
      { name: "accruedToTreasury", type: "uint128" },
      { name: "unbacked", type: "uint128" },
      { name: "isolationModeTotalDebt", type: "uint128" },
    ] }] },
] as const satisfies Abi;

// maxUint256 = "withdraw all" (Aave convention).
export const WITHDRAW_ALL = maxUint256;

export function parseUsdc(amount: number, network: YieldNetwork): bigint {
  return parseUnits(String(amount), YIELD_NETWORKS[network].usdcDecimals);
}

// Aave supply APY from currentLiquidityRate (APR in ray, 1e27), compounded per
// second — matches the % Aave's own UI shows. Returns a percentage (e.g. 4.21).
const RAY = 1e27;
const SECONDS_PER_YEAR = 31_536_000;
export function supplyApyPct(liquidityRateRay: bigint): number {
  const apr = Number(liquidityRateRay) / RAY;
  return ((1 + apr / SECONDS_PER_YEAR) ** SECONDS_PER_YEAR - 1) * 100;
}

// ─── ERC-4626 (Morpho MetaMorpho vaults) ─────────────────────────────────────
// Standard vault interface: deposit USDC → shares, withdraw/redeem → USDC.
export const ERC4626_ABI = [
  { name: "deposit", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "assets", type: "uint256" }, { name: "receiver", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "withdraw", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "assets", type: "uint256" }, { name: "receiver", type: "address" }, { name: "owner", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "redeem", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "shares", type: "uint256" }, { name: "receiver", type: "address" }, { name: "owner", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "maxWithdraw", type: "function", stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "uint256" }] },
] as const satisfies Abi;

// ─── Yield venues (best-rate routing) ────────────────────────────────────────
// Each venue carries verified per-network addresses + which protocol interface
// to use. Morpho's vault was verified on-chain (asset()==Base USDC, ERC-4626,
// $442M TVL, curator Gauntlet). Morpho is mainnet-only (no real testnet vault).
const MORPHO_GAUNTLET_USDC_PRIME = getAddress("0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61");

export type VenueId  = "aave" | "morpho";
export type Protocol = "aave" | "erc4626";

export interface VenueNet {
  spender: `0x${string}`;   // approve USDC here (Aave Pool / Morpho vault)
  target:  `0x${string}`;   // call supply/deposit/withdraw/redeem here
  usdc:    `0x${string}`;
  receipt: `0x${string}`;   // aToken / vault share token — balanceOf for position
  receiptDecimals: number;  // aUSDC = 6, vault shares = 18
  usdcDecimals: number;
}

export interface VenueCfg {
  id: VenueId;
  label: string;            // full name
  short: string;            // chip/button label
  protocol: Protocol;
  llamaProject: string;     // maps to /api/yield/rates project → APY
  nets: Partial<Record<YieldNetwork, VenueNet>>;
}

export const VENUES: Record<VenueId, VenueCfg> = {
  aave: {
    id: "aave", label: "Aave v3", short: "Aave", protocol: "aave", llamaProject: "aave-v3",
    nets: {
      baseSepolia: { spender: YIELD_NETWORKS.baseSepolia.pool, target: YIELD_NETWORKS.baseSepolia.pool, usdc: YIELD_NETWORKS.baseSepolia.usdc, receipt: YIELD_NETWORKS.baseSepolia.aUsdc, receiptDecimals: 6, usdcDecimals: 6 },
      base:        { spender: YIELD_NETWORKS.base.pool,        target: YIELD_NETWORKS.base.pool,        usdc: YIELD_NETWORKS.base.usdc,        receipt: YIELD_NETWORKS.base.aUsdc,        receiptDecimals: 6, usdcDecimals: 6 },
    },
  },
  morpho: {
    id: "morpho", label: "Morpho · Gauntlet USDC Prime", short: "Morpho", protocol: "erc4626", llamaProject: "morpho-blue",
    nets: {
      base: { spender: MORPHO_GAUNTLET_USDC_PRIME, target: MORPHO_GAUNTLET_USDC_PRIME, usdc: YIELD_NETWORKS.base.usdc, receipt: MORPHO_GAUNTLET_USDC_PRIME, receiptDecimals: 18, usdcDecimals: 6 },
    },
  },
};

export const VENUE_LIST: VenueCfg[] = [VENUES.aave, VENUES.morpho];
