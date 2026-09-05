// B20HUB — real B20 launchpad on Base with auto Uniswap V4 pool.
//
// Every address below is INDEPENDENTLY verified on Basescan (source code:
// "Exact Match", deployer address confirmed, contract name confirmed).
// This is what a B20HUB launch touches:
//
//   1. B20Factory (Rust precompile inside Base node, address hard-coded by the
//      protocol — same on mainnet + Sepolia).
//   2. Uniswap V4 core singleton + periphery (PositionManager for pool
//      creation + liquidity, PoolManager for swaps).
//   3. WETH9 as one leg of every B20HUB pool (B20/WETH).
//
// NEVER add an address here that isn't verified — hallucinated addresses in
// swap/liquidity paths destroy user funds. If Uniswap ships a new deployment,
// verify the new address on Basescan first, then update this file.
// See docs: https://developers.uniswap.org/contracts/v4/deployments

// ── Base chain ─────────────────────────────────────────────────────────────────

export const BASE_CHAIN_ID = 8453;
export const BASE_SEPOLIA_CHAIN_ID = 84532;

/**
 * Wrapped ETH on Base mainnet. Standard cross-chain deployment — the "other
 * leg" of every B20/ETH pool. Predeployed by the OP Stack, no external
 * verification needed (it's a chain built-in).
 *
 * Same address on Base mainnet + Base Sepolia (OP Stack convention).
 */
export const WETH9_BASE = "0x4200000000000000000000000000000000000006" as const;
export const WETH9_BASE_SEPOLIA = "0x4200000000000000000000000000000000000006" as const;

// ── B20 protocol ───────────────────────────────────────────────────────────────

/**
 * B20Factory — Base's Rust precompile at a fixed protocol address. `isB20()`
 * on this factory is the ONLY authoritative proof a token is a real B20.
 * Same address on Base mainnet + Sepolia.
 */
export const B20_FACTORY = "0xB20f000000000000000000000000000000000000" as const;

// ── Uniswap V4 on Base mainnet (verified 2026-07-08) ──────────────────────────

/**
 * V4 core — the singleton contract that holds ALL Uniswap V4 pool state on
 * Base. Users don't interact with this directly; they go through
 * PositionManager (for liquidity) and UniversalRouter (for swaps).
 * Verified: name "PoolManager", Solidity 0.8.26, deployer
 * 0x2179a608...b27b6 (Uniswap Labs' canonical V4 deployer on Base).
 * https://basescan.org/address/0x498581ff718922c3f8e6a244956af099b2652b2b
 */
export const V4_POOL_MANAGER = "0x498581Ff718922c3f8e6A244956aF099B2652b2b" as const;

/**
 * V4 periphery — the NFT-based liquidity position manager. Every B20HUB launch
 * calls this to (a) initialize the B20/WETH pool and (b) mint the initial LP
 * position. The LP NFT lands in the creator's wallet.
 * Verified: name "PositionManager", Solidity 0.8.26, same Uniswap deployer.
 * https://basescan.org/address/0x7c5f5a4bbd8fd63184577525326123b519429bdc
 */
export const V4_POSITION_MANAGER = "0x7C5f5A4bBd8fD63184577525326123B519429bDc" as const;

/**
 * V4 quoter — off-chain read helper for computing swap amounts (used by the
 * Trade UI to show "you'll receive ~X" before signing).
 * Source: Uniswap official deployments page. Not source-diffed here — read-
 * only, no fund custody, so a name-mismatch would only affect quote display.
 * https://basescan.org/address/0x0d5e0f971ed27fbff6c2837bf31316121532048d
 */
export const V4_QUOTER = "0x0d5e0F971ED27FBfF6c2837bf31316121532048D" as const;

/**
 * StateView — off-chain read helper for PoolManager state (slot0, liquidity,
 * positions). Used by Trade UI to detect pool existence + read pool price.
 * https://basescan.org/address/0xa3c0c9b65bad0b08107aa264b0f3db444b867a71
 */
export const V4_STATE_VIEW = "0xA3c0c9B65BAd0b08107Aa264b0f3dB444b867A71" as const;

/**
 * Universal Router — Uniswap's canonical swap entrypoint (V2/V3/V4 combined).
 * Every B20HUB trade routes through here. Verified: name "UniversalRouter",
 * Solidity 0.8.26.
 * https://basescan.org/address/0x6ff5693b99212da76ad316178a184ab56d299b43
 */
export const UNIVERSAL_ROUTER_V4 = "0x6fF5693b99212Da76ad316178A184AB56D299b43" as const;

/**
 * Permit2 — Uniswap's canonical approval router (single approval, many spenders).
 * The Universal Router pulls tokens via Permit2, so any ERC20 sell needs a
 * one-time Permit2 approval + a per-tx Permit2 permit signature.
 * Deployed at the same address on every chain (deterministic CREATE2).
 * https://basescan.org/address/0x000000000022D473030F116dDEE9F6B43aC78BA3
 */
export const PERMIT2_BASE = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;

// ── V4 fee tier + tick spacing table ───────────────────────────────────────────
//
// Uniswap V4's PoolKey requires BOTH a `fee` and a `tickSpacing`. Standard
// combinations mirror V3's tiers (100/500/3000/10000) with matching spacing.
// A pool at tier 3000 (0.30%) uses tickSpacing 60; at tier 10000 (1%) uses 200.
// Getting this wrong at initialize time creates an unusable pool.

export const V4_FEE_TIERS = {
  /** 0.01% — stablecoin-stablecoin pairs. Rarely used for launches. */
  LOWEST: { fee: 100,   tickSpacing: 1 },
  /** 0.05% — high-volume mainstream pairs. */
  LOW:    { fee: 500,   tickSpacing: 10 },
  /** 0.30% — most launched tokens land here. Default for B20HUB. */
  MEDIUM: { fee: 3000,  tickSpacing: 60 },
  /** 1.00% — memecoins + first-launch tokens with expected wide spread. */
  HIGH:   { fee: 10000, tickSpacing: 200 },
} as const;

export type V4FeeTierName = keyof typeof V4_FEE_TIERS;

// ── Uniswap V4 on Base Sepolia (verified via Uniswap docs 2026-07-09) ─────────
//
// Base Sepolia is where we deploy B20HUB first for smoke-testing before
// promoting to mainnet. B20 factory is at the same 0xB20f… address as mainnet
// (protocol convention). V4 addresses differ per chain — Uniswap deploys V4
// separately on each chain; treat these as documentation, not "same as
// mainnet".

/**
 * V4 PoolManager on Base Sepolia. Different address from mainnet — each
 * chain gets a fresh V4 deployment. Source:
 * https://developers.uniswap.org/contracts/v4/deployments
 */
export const V4_POOL_MANAGER_SEPOLIA = "0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408" as const;

/** V4 PositionManager on Base Sepolia. */
export const V4_POSITION_MANAGER_SEPOLIA = "0x4B2C77d209D3405F41a037Ec6c77F7F5b8e2ca80" as const;

/** V4 UniversalRouter on Base Sepolia. */
export const UNIVERSAL_ROUTER_V4_SEPOLIA = "0x492E6456D9528771018DeB9E87ef7750eF184104" as const;

/** V4 Quoter on Base Sepolia (read-only quotes). */
export const V4_QUOTER_SEPOLIA = "0x4A6513c898fe1B2d0E78d3b0e0A4a151589b1CBA" as const;

/** V4 StateView on Base Sepolia (read-only pool state). */
export const V4_STATE_VIEW_SEPOLIA = "0x571291b572ed32ce6751a2cb2486ebee8dEFB9b4" as const;

/**
 * Permit2 is deployed at the SAME address on every chain (deterministic
 * CREATE2 canonical deploy). Mainnet and Sepolia both use this.
 */
export const PERMIT2_SEPOLIA = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;

// ── B20HUB deployed contracts on Base mainnet ─────────────────────────────────
//
// v6 deployment 2026-07-11 at block 48496774. Fresh BuyBack v5 + Hook v5 +
// Launcher v6 in one script run. Same functional stack as v5 — the only
// change is the launcher's OPENING_SQRT_PRICE_X96 constant (~$2.4K → ~$6K
// opening mcap at ETH=$1800). BuyBack + Hook re-deployed for a fresh
// per-launch fee accumulator + clean hook state.

/**
 * BlueBuyBack v5 — receives 15% of every B20HUB swap as WETH, then anyone can
 * call distribute() to swap it into $BLUE and forward to treasury. Keeper
 * reward: 0.1% of BLUE bought to the caller.
 * https://basescan.org/address/0xe389AcfABe2a4F17187ebA2354555a096BC2A1c9
 */
export const B20HUB_BUYBACK = "0xe389AcfABe2a4F17187ebA2354555a096BC2A1c9" as const;

/**
 * B20HUBHook v5 — the Uniswap V4 hook. Splits swap fees 80/15/5 via
 * claimFees. beforeRemoveLiquidity gates on `params.liquidityDelta != 0`
 * so delta=0 fee collection flows through.
 * Address low 14 bits = 0x1200 (AFTER_INITIALIZE + BEFORE_REMOVE_LIQUIDITY).
 * https://basescan.org/address/0xACbBD7846596162cE6436D65fA8E4f02Eb1Cd200
 */
export const B20HUB_HOOK = "0xACbBD7846596162cE6436D65fA8E4f02Eb1Cd200" as const;

/**
 * B20HUBLauncher v6 — pump.fun-style, uniform launch. User picks name +
 * symbol + fee tier; everything else is baked into contract bytecode:
 *   • 100B supply
 *   • OPENING_SQRT_PRICE_X96 = 13722720286502977928233463417143296
 *     → 3.333 ETH per 100B tokens
 *     → ~$6K mcap at ETH=$1800, ~$10K at $3K, ~$13.3K at $4K
 *   • 80/15/5 fee split, permanent LP lock, admin renounce
 * `/api/b20hub/prepare` builds calldata for the 8-field LaunchParams tuple.
 * https://basescan.org/address/0xb9AA8bCa1eaEb702498DF251380AfD94b8dD8658
 */
export const B20HUB_LAUNCHER = "0xb9AA8bCa1eaEb702498DF251380AfD94b8dD8658" as const;

/**
 * Prior deployments — reference only. Immutable, cannot be reused.
 *   v1 0x8eEe…Ba4b (launcher)  — createB20 argument order swapped
 *   v2 0xb681…4A8B (launcher)  — tick range straddled currentTick, Permit2,
 *                                modifyLiquidities return-type mismatch
 *   v3 0xc6e4…f466 (launcher)  — hook v3 claimFees never worked
 *   v3 hook 0xe3B8…1200        — beforeRemoveLiquidity self-locked
 *   v5 0xdde2…7714 (launcher)  — functional but opens at only ~$2.4K
 *                                (1.333 ETH per 100B); v6 bumps to 3.333
 */
export const B20HUB_LAUNCHER_V1_BROKEN = "0x8eEe57660b086c31D0ECc98F48A122f829dDBa4b" as const;
export const B20HUB_LAUNCHER_V2_BROKEN = "0xb68120DC451CbcB391D4A651c0c1d3dE95744A8B" as const;
export const B20HUB_LAUNCHER_V3_BROKEN = "0xc6e402C0b544Ef4f69cF61AE4eCA114532Fbf466" as const;
export const B20HUB_LAUNCHER_V5_LOWCAP = "0xdde24849f47B34151132b8C05db3aE505EB17714" as const;
export const B20HUB_HOOK_V3_BROKEN     = "0xe3B801B6721B0bB77AD43e5F9cAfC02780061200" as const;
export const B20HUB_HOOK_V4_LEGACY     = "0xC3E89575CDd9e2C78462AF59a760fdc1B5Bc9200" as const;
export const B20HUB_BUYBACK_V4_LEGACY  = "0x7186EAfBa8009D92DFe051Bc71eaed924b2345Ef" as const;
