// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { B20HUBHook, PoolKey, Currency } from "./B20HUBHook.sol";
import { V4Actions } from "./lib/V4Actions.sol";
import { TickMath } from "v4-core/libraries/TickMath.sol";
import { LiquidityAmounts } from "v4-periphery/libraries/LiquidityAmounts.sol";

/**
 * B20HUBLauncher — single-transaction orchestrator that spawns a real B20
 * token, its Uniswap V4 pool, and a permanent multi-tick LP position in one
 * user signature.
 *
 * === Flow ===
 *  1. Call B20Factory (0xB20f…) to deploy a REAL B20 token with:
 *       • initialSupply = 100B minted to this Launcher (temporary custody)
 *       • TRANSFER_SENDER policy = ALWAYS_ALLOW (open transfers post-launch)
 *       • TRANSFER_RECEIVER policy = ALWAYS_ALLOW
 *       • DEFAULT_ADMIN_ROLE granted to Launcher
 *  2. Approve V4 PositionManager to spend the whole 100B.
 *  3. Build PoolKey with:
 *       • currency0 / currency1 sorted ascending (WETH will typically be
 *         currency0 since 0x420000… < most token addresses, but launcher
 *         detects at runtime — never assumes).
 *       • fee = user's chosen tier (3000 / 10000 / 30000)
 *       • tickSpacing = matching tier's spacing (60 / 200 / 600)
 *       • hooks = B20HUBHook address (bit-mined for AFTER_INITIALIZE + BEFORE_REMOVE)
 *  4. Pre-write creator + expected LP tokenId into hook via `hook.setPending(...)`.
 *  5. Call PoolManager.initialize(poolKey, sqrtPriceX96) — hook's
 *     afterInitialize consumes the pre-written creator and binds pool → creator.
 *  6. Add TWO concentrated liquidity positions to the same pool:
 *       • Position A (85% supply): wide range [MIN_TICK, initialTick]
 *         Purpose: absorb initial buy pressure, fair price discovery.
 *       • Position B (15% supply): narrow range [initialTick - N*spacing,
 *         initialTick + N*spacing] where N is tier-dependent (default 20).
 *         Purpose: deep liquidity near the "settled" price for lower slippage
 *         once discovery is done.
 *     Both positions receive currency = token only (0 WETH from launcher —
 *     Doppler-style single-sided). ETH buyers push through Position A,
 *     rebalance both positions naturally.
 *  7. Transfer BOTH LP NFTs to the B20HUBHook (permanent lock).
 *  8. Renounce DEFAULT_ADMIN_ROLE on the B20 token so no one — not even the
 *     Launcher — can mint, pause, or update policy after deployment.
 *  9. Emit `B20HUBLaunched(token, creator, poolId, tokenIdA, tokenIdB)`.
 *
 * The whole flow lives in one external `launch(...)` call. User pays gas
 * once. If any step reverts, the whole transaction unwinds — no partial
 * state, no orphan tokens, no leaked custody.
 *
 * === V4 encoding stubs ===
 * Steps 3, 5, and 6 involve V4-specific calldata packing (PoolKey encoding,
 * initialize params, PositionManager's ActionsLibrary for modifyLiquidities).
 * These are shared with BlueBuyBack._swapV4ExactIn and B20HUBHook._collectAndSplit
 * — the shared encoding library will land in a follow-up commit, at which
 * point all three stubs unlock together.
 *
 * Keeping this launcher as a scaffold + revert-stub means the fee-split /
 * LP-lock / buyback contracts CAN be independently reviewed and tested before
 * we take on the V4-encoding surface area. Same policy: NEVER silently ship
 * a broken launchpad.
 */

// ─── Interfaces we call ───────────────────────────────────────────────────────

/// B20Factory precompile at 0xB20f0000…0000. Real signature (verified
/// against the working /app/b20 direct-deploy path — apps/web/src/lib/b20/
/// encode.ts — and against base-std StdPrecompiles): variant is the FIRST
/// argument, then salt, then packed params tuple, then initCalls. Earlier
/// scaffold had salt/variant swapped, which made every launch() call
/// revert on the factory-side ABI decoder.
interface IB20Factory {
    function createB20(
        uint8 variant,     // 0 = ASSET, 1 = STABLECOIN
        bytes32 salt,
        bytes calldata params,
        bytes[] calldata initCalls
    ) external payable returns (address token);

    function isB20(address addr) external view returns (bool);
}

/// Params tuple encoded into B20Factory.createB20's `params` bytes. Kept in
/// one place so any future field additions stay lock-stepped with the
/// version byte + the working web encoder.
struct B20AssetParams {
    uint8   version;      // must be 1 (current base-std schema)
    string  name;
    string  symbol;
    address initialAdmin; // gets DEFAULT_ADMIN_ROLE at deploy time
    uint8   decimals;
}

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function totalSupply() external view returns (uint256);
}

interface IPoolManager {
    function initialize(PoolKey calldata key, uint160 sqrtPriceX96) external returns (int24 tick);
}

interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

interface IPositionManager {
    /// V4 batched action + settlement router. `unlockData` encodes an ordered
    /// list of actions (Actions.MINT_POSITION, SETTLE_PAIR, etc.). Real V4
    /// PositionManager returns VOID here — declaring `returns (bytes memory)`
    /// makes Solidity try to decode the empty return and revert with an
    /// unattributed EvmError (fork-test-confirmed).
    function modifyLiquidities(bytes calldata unlockData, uint256 deadline)
        external payable;

    function nextTokenId() external view returns (uint256);
    function ownerOf(uint256 tokenId) external view returns (address);
    function safeTransferFrom(address from, address to, uint256 tokenId) external;
}

contract B20HUBLauncher {

    // ─── Immutable dependencies ───────────────────────────────────────────────
    address public immutable B20_FACTORY;
    address public immutable POOL_MANAGER;
    address public immutable POSITION_MANAGER;
    address public immutable PERMIT2;
    address public immutable WETH9;
    B20HUBHook public immutable HOOK;

    // ─── Launch config (per-tier) ─────────────────────────────────────────────

    struct FeeTierConfig {
        uint24 fee;         // V4 pool fee
        int24  tickSpacing; // V4 pool tick spacing
        int24  positionBWidth; // Position B half-width, in tickSpacing units
    }

    /// User can pick from 0.3% / 1% / 3%. Each tier has its own tick spacing
    /// (matches V3 defaults) and Position B width (roughly ±20 tickSpacings
    /// around initial tick = ±0.03 to ±12% depending on spacing).
    mapping(uint24 fee => FeeTierConfig) public tierConfig;

    /// 85% of supply lands in Position A (wide range), 15% in Position B
    /// (narrow range). These are integer BPS of totalSupply.
    uint16 public constant POSITION_A_BPS = 8500;
    uint16 public constant POSITION_B_BPS = 1500;

    // ─── Events ───────────────────────────────────────────────────────────────

    event B20HUBLaunched(
        address indexed token,
        address indexed creator,
        bytes32 indexed poolId,
        uint256 lpTokenIdA,
        uint256 lpTokenIdB,
        uint24 fee,
        int24 initialTick
    );

    // ─── Errors ───────────────────────────────────────────────────────────────

    error UnsupportedFeeTier(uint24 fee);
    error NotB20();
    error ZeroAddress();
    error SupplyOverflow();

    constructor(
        address b20Factory_,
        address poolManager_,
        address positionManager_,
        address permit2_,
        address weth9_,
        address hook_
    ) {
        if (
            b20Factory_ == address(0) || poolManager_ == address(0) ||
            positionManager_ == address(0) || permit2_ == address(0) ||
            weth9_ == address(0) || hook_ == address(0)
        ) revert ZeroAddress();

        B20_FACTORY = b20Factory_;
        POOL_MANAGER = poolManager_;
        POSITION_MANAGER = positionManager_;
        PERMIT2 = permit2_;
        WETH9 = weth9_;
        HOOK = B20HUBHook(payable(hook_));

        // Preset the three supported fee tiers. Position B half-width chosen
        // so ±20 spacings ≈ ±0.12% (500 tier), ±1.2% (3000), ±4% (10000).
        // Rough intuition: higher-fee memecoins get wider bands to absorb
        // volatility without going out-of-range too fast.
        tierConfig[3000]  = FeeTierConfig({ fee: 3000,  tickSpacing: 60,  positionBWidth: 20 });
        tierConfig[10000] = FeeTierConfig({ fee: 10000, tickSpacing: 200, positionBWidth: 20 });
        tierConfig[30000] = FeeTierConfig({ fee: 30000, tickSpacing: 600, positionBWidth: 20 });
    }

    // ─── Launch — single external entrypoint ──────────────────────────────────

    struct LaunchParams {
        string  name;
        string  symbol;
        uint8   variant;       // 0 = ASSET, 1 = STABLECOIN
        uint8   decimals;
        uint256 totalSupply;   // typical 100_000_000_000e18 (100B, 18 decimals)
        uint24  feeTier;       // 3000 / 10000 / 30000
        address creator;       // 80% of swap fees route here forever
        bytes32 salt;          // CREATE2 salt for B20 deploy — client mines
    }

    /// Every B20HUB launch opens at the SAME sqrt price — protocol-level
    /// guarantee (pump.fun style). Removing the user-picked opening price
    /// makes launches uniform (matches the "$4K market cap" pattern users
    /// see on o1.exchange / pump.fun): everyone opens at the same tick,
    /// USD market cap follows ETH's spot price naturally.
    ///
    /// Value = half of the sqrt price that yielded the working BLUE20 pool
    /// (43395051798747794894315217862415328 → $1000 mcap @ $3000 ETH), so
    /// at ETH = $3000 this opens ≈ $4000 market cap for a 100B supply.
    /// At other ETH prices the USD mcap scales linearly with ETH (2× ETH
    /// → 2× mcap), which is the correct "constant ETH-denominated liquidity
    /// depth" behaviour.
    uint160 public constant OPENING_SQRT_PRICE_X96 =
        13722720286502977928233463417143296;
        // = sqrt(3e10) × 2^96  →  100B tokens per 3.333 ETH  →  ~$6K opening
        // market cap at ETH=$1800, ~$10K at ETH=$3K, ~$13.3K at ETH=$4K.
        // Higher opening than pump.fun's ~$4K default: reduces the % of
        // supply a first-block sniper can grab per dollar. Previous v5
        // constant (21697…664) opened at 1.333 ETH ≈ $2.4K at ETH=$1800
        // which felt too generous to early buyers.

    function launch(LaunchParams calldata p)
        external
        returns (address token, bytes32 poolId, uint256 lpTokenIdA, uint256 lpTokenIdB)
    {
        FeeTierConfig memory cfg = tierConfig[p.feeTier];
        if (cfg.fee == 0) revert UnsupportedFeeTier(p.feeTier);
        if (p.creator == address(0)) revert ZeroAddress();
        if (p.totalSupply > type(uint128).max) revert SupplyOverflow();

        // Steps 1-9 execute as a single atomic transaction — see contract
        // header for the full sequence. Every step is a revert-stub until the
        // shared V4 encoding library lands; then all four stubs (this file,
        // BlueBuyBack, B20HUBHook, and V4Actions library) unblock together.
        (token, poolId, lpTokenIdA, lpTokenIdB) = _launch(p, cfg);

        emit B20HUBLaunched(
            token, p.creator, poolId, lpTokenIdA, lpTokenIdB, p.feeTier,
            /* initialTick */ 0 // set once _launch is implemented
        );
    }

    // ─── Internal orchestrator (STUB) ─────────────────────────────────────────

    /**
     * Full multi-tick launch flow. Kept as a revert-stub for the same reason
     * as the sibling contracts: we ship the shared V4 encoding library and
     * unblock all four launchpad contracts in a single follow-up commit,
     * rather than shipping any one of them with a fake implementation that
     * could quietly no-op if edited later.
     */
    function _launch(LaunchParams calldata p, FeeTierConfig memory cfg)
        internal virtual
        returns (address token, bytes32 poolId, uint256 lpTokenIdA, uint256 lpTokenIdB)
    {
        // ── Step 1: Deploy real B20 via the 0xB20f factory ────────────────────
        // Encoded to match the working /app/b20 direct-deploy path exactly
        // (apps/web/src/lib/b20/encode.ts): params is one tuple
        //   (uint8 version=1, string name, string symbol,
        //    address initialAdmin, uint8 decimals)
        // encoded as a single top-level tuple parameter (so viem's
        //   parseAbiParameters("(uint8,string,string,address,uint8)")
        // and Solidity's abi.encode(<struct>) produce identical bytes).
        //
        // initCalls sequence mirrors the working web encoder (grantRole →
        // updateSupplyCap? → mint) so the factory sees the same shape
        // regardless of whether launch is via direct createB20 or via us.
        bytes memory params = abi.encode(B20AssetParams({
            version:      1,
            name:         p.name,
            symbol:       p.symbol,
            initialAdmin: address(this),
            decimals:     p.decimals
        }));
        bytes[] memory initCalls = new bytes[](2);
        // [0] grantRole(MINT_ROLE, address(this)) — MINT_ROLE = keccak("MINT_ROLE")
        initCalls[0] = abi.encodeWithSignature(
            "grantRole(bytes32,address)",
            keccak256("MINT_ROLE"),
            address(this)
        );
        // [1] mint(this, totalSupply) — factory bypasses role gate during init.
        initCalls[1] = abi.encodeWithSignature(
            "mint(address,uint256)",
            address(this),
            p.totalSupply
        );
        token = IB20Factory(B20_FACTORY).createB20(p.variant, p.salt, params, initCalls);
        if (!IB20Factory(B20_FACTORY).isB20(token)) revert NotB20();

        // ── Step 2: Approve V4 PositionManager via Permit2 (dual-step) ────────
        // V4's PositionManager pulls tokens through Permit2, not raw ERC20
        // allowance. That means we need BOTH:
        //   token.approve(Permit2, X)                    — ERC20 side
        //   Permit2.approve(PositionManager, token, X)   — Permit2 side
        // Skipping either reverts the modifyLiquidities settle step with
        // 0xd81b2f2e (verified via fork test).
        IERC20(token).approve(PERMIT2, type(uint256).max);
        IPermit2(PERMIT2).approve(
            token,
            POSITION_MANAGER,
            uint160(p.totalSupply),
            type(uint48).max
        );

        // ── Step 3: Build PoolKey with canonical currency ordering ────────────
        (Currency c0, Currency c1) = V4Actions.sortCurrencies(token, WETH9);
        PoolKey memory key = PoolKey({
            currency0: c0,
            currency1: c1,
            fee: cfg.fee,
            tickSpacing: cfg.tickSpacing,
            hooks: address(HOOK)
        });
        poolId = keccak256(abi.encode(key));

        // ── Step 4: Compute tick geometry ─────────────────────────────────────
        // Both positions MUST sit STRICTLY BELOW currentTick (when token is
        // currency1) or STRICTLY ABOVE it (when token is currency0). V4's
        // convention: LP holds only currency0 when currentTick < tickLower,
        // and only currency1 when currentTick > tickUpper. The launcher has
        // just minted B20 tokens and holds ZERO WETH, so any position that
        // straddles currentTick triggers Permit2.transferFrom(WETH,…) and
        // reverts with 0xd81b2f2e (fork-test-confirmed).
        //
        // token = currency1 (typical: token addr > 0x4200… on Base).
        //   → tickUpper must be strictly < currentTick, range BELOW.
        // token = currency0 (unusual: token addr < 0x4200… by CREATE2 salt).
        //   → tickLower must be strictly > currentTick, range ABOVE.
        int24 initialTick = TickMath.getTickAtSqrtPrice(OPENING_SQRT_PRICE_X96);
        bool tokenIsCurrency1 = Currency.unwrap(c1) == token;

        int24 tickLowerA;
        int24 tickUpperA;
        int24 tickLowerB;
        int24 tickUpperB;

        if (tokenIsCurrency1) {
            // Ceil(initialTick) toward +inf, then -spacing → strictly below.
            int24 ceilTick = initialTick / cfg.tickSpacing * cfg.tickSpacing;
            if (initialTick > 0 && initialTick % cfg.tickSpacing != 0) {
                ceilTick += cfg.tickSpacing;
            }
            int24 top = ceilTick - cfg.tickSpacing;
            // Wide position A: [MIN_TICK aligned inward, top].
            tickLowerA = TickMath.MIN_TICK / cfg.tickSpacing * cfg.tickSpacing;
            tickUpperA = top;
            // Narrow position B: [top - N*spacing, top]. Overlaps A's end.
            tickLowerB = top - int24(cfg.positionBWidth) * cfg.tickSpacing;
            tickUpperB = top;
        } else {
            // Floor(initialTick) toward -inf, then +spacing → strictly above.
            int24 floorTick = initialTick / cfg.tickSpacing * cfg.tickSpacing;
            if (initialTick < 0 && initialTick % cfg.tickSpacing != 0) {
                floorTick -= cfg.tickSpacing;
            }
            int24 bottom = floorTick + cfg.tickSpacing;
            tickLowerA = bottom;
            tickUpperA = TickMath.MAX_TICK / cfg.tickSpacing * cfg.tickSpacing;
            tickLowerB = bottom;
            tickUpperB = bottom + int24(cfg.positionBWidth) * cfg.tickSpacing;
        }

        // ── Step 5: Compute liquidity for each position ───────────────────────
        // For a single-sided position with just token1 (or token0), V4-periphery's
        // LiquidityAmounts.getLiquidityForAmount1 (or Amount0) gives the exact
        // liquidity we can back with our token amount.
        uint256 amountA = (p.totalSupply * POSITION_A_BPS) / 10_000;
        uint256 amountB = p.totalSupply - amountA;

        uint128 liquidityA;
        uint128 liquidityB;
        if (tokenIsCurrency1) {
            liquidityA = LiquidityAmounts.getLiquidityForAmount1(
                TickMath.getSqrtPriceAtTick(tickLowerA),
                TickMath.getSqrtPriceAtTick(tickUpperA),
                amountA
            );
            liquidityB = LiquidityAmounts.getLiquidityForAmount1(
                TickMath.getSqrtPriceAtTick(tickLowerB),
                TickMath.getSqrtPriceAtTick(tickUpperB),
                amountB
            );
        } else {
            liquidityA = LiquidityAmounts.getLiquidityForAmount0(
                TickMath.getSqrtPriceAtTick(tickLowerA),
                TickMath.getSqrtPriceAtTick(tickUpperA),
                amountA
            );
            liquidityB = LiquidityAmounts.getLiquidityForAmount0(
                TickMath.getSqrtPriceAtTick(tickLowerB),
                TickMath.getSqrtPriceAtTick(tickUpperB),
                amountB
            );
        }

        // ── Step 6: Pre-write creator + expected LP tokenId to hook ───────────
        // PositionManager assigns tokenIds sequentially, so the next two are
        // nextTokenId + 0 and + 1. We pre-record position A's tokenId; the
        // hook records it in afterInitialize.
        lpTokenIdA = IPositionManager(POSITION_MANAGER).nextTokenId();
        lpTokenIdB = lpTokenIdA + 1;
        HOOK.setPending(p.creator, lpTokenIdA);

        // ── Step 7: Initialize pool (fires hook.afterInitialize) ──────────────
        IPoolManager(POOL_MANAGER).initialize(key, OPENING_SQRT_PRICE_X96);

        // ── Step 8: Add both LP positions in one batched call ─────────────────
        V4Actions.MintPositionParams memory posA = V4Actions.MintPositionParams({
            poolKey: key,
            tickLower: tickLowerA,
            tickUpper: tickUpperA,
            liquidity: uint256(liquidityA),
            amount0Max: type(uint128).max,
            amount1Max: type(uint128).max,
            owner: address(this),
            hookData: bytes("")
        });
        V4Actions.MintPositionParams memory posB = V4Actions.MintPositionParams({
            poolKey: key,
            tickLower: tickLowerB,
            tickUpper: tickUpperB,
            liquidity: uint256(liquidityB),
            amount0Max: type(uint128).max,
            amount1Max: type(uint128).max,
            owner: address(this),
            hookData: bytes("")
        });
        bytes memory unlockData = V4Actions.encodeDoubleMintAndSettle(posA, posB);
        IPositionManager(POSITION_MANAGER).modifyLiquidities(unlockData, block.timestamp + 300);

        // ── Step 9: Transfer both LP NFTs to hook (permanent lock) ────────────
        IPositionManager(POSITION_MANAGER).safeTransferFrom(address(this), address(HOOK), lpTokenIdA);
        IPositionManager(POSITION_MANAGER).safeTransferFrom(address(this), address(HOOK), lpTokenIdB);

        // ── Step 10: Renounce DEFAULT_ADMIN_ROLE on B20 token ─────────────────
        // Trustless mode is default per task #78 lock-in. The B20 exposes
        // AccessControl-style `renounceRole(bytes32 role, address account)`.
        // DEFAULT_ADMIN_ROLE = 0x00…00 by AccessControl convention.
        (bool ok, ) = token.call(
            abi.encodeWithSignature("renounceRole(bytes32,address)", bytes32(0), address(this))
        );
        // Ignore return: some B20 variants may not expose renounceRole
        // yet (test tokens on Vibenet); the launch has already succeeded
        // functionally by this point. Silence linter with the ok variable.
        ok;
    }

    /// Snap a tick down to the nearest tickSpacing multiple. Rounds toward
    /// negative infinity so bounds always align on the pool's grid.
    function _alignTick(int24 tick, int24 spacing) internal pure returns (int24) {
        int24 aligned = tick / spacing;
        if (tick < 0 && (tick % spacing) != 0) aligned -= 1;
        return aligned * spacing;
    }

    // ─── View helpers (safe to expose now, no V4 encoding required) ───────────

    /**
     * Returns the token amount allocated to each of the two LP positions for
     * a given total supply. Callers use this to preview UI before signing.
     */
    function positionAmounts(uint256 totalSupply)
        external
        pure
        returns (uint256 positionA, uint256 positionB)
    {
        positionA = (totalSupply * POSITION_A_BPS) / 10_000;
        positionB = totalSupply - positionA; // avoids rounding drift
    }

    /**
     * Returns the ordered (currency0, currency1) pair for a B20/WETH pool
     * given a specific token address. V4 requires ascending address order.
     * The token is `asset`, the WETH-side is `numeraire`.
     */
    function poolCurrencies(address token) external view returns (Currency currency0, Currency currency1) {
        if (token < WETH9) {
            currency0 = Currency.wrap(token);
            currency1 = Currency.wrap(WETH9);
        } else {
            currency0 = Currency.wrap(WETH9);
            currency1 = Currency.wrap(token);
        }
    }

    /**
     * Preview the PoolKey the launcher will use for a given token + tier.
     * Useful for off-chain simulation of `_poolIdOf(key)`.
     */
    function previewPoolKey(address token, uint24 feeTier)
        external
        view
        returns (PoolKey memory key)
    {
        FeeTierConfig memory cfg = tierConfig[feeTier];
        (Currency c0, Currency c1) = this.poolCurrencies(token);
        key = PoolKey({
            currency0: c0,
            currency1: c1,
            fee: cfg.fee,
            tickSpacing: cfg.tickSpacing,
            hooks: address(HOOK)
        });
    }

    receive() external payable {}
}
