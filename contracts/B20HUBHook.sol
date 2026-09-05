// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * B20HUBHook — the fee-splitter Uniswap V4 hook + permanent-LP guardian for
 * every B20HUB launch.
 *
 * === Role in the launchpad ===
 * B20HUBLauncher deploys a real B20 token (via 0xB20f… factory), creates a
 * Uniswap V4 pool with THIS contract as the hook, seeds it single-sided
 * (100% tokens, 0 ETH), then transfers the LP position NFT to this contract.
 * From then on this hook is the sole party that can touch that LP position:
 *
 *   • LP is permanently locked (beforeRemoveLiquidity reverts for everyone).
 *   • Fees accrued to that LP position are permissionlessly claimable via
 *     `claimFees(poolId)`, which splits both currencies 80 / 15 / 5:
 *         80% → the pool's original creator (fixed at initialize)
 *         15% → BlueBuyBack contract (accumulates → batches to $BLUEAGENT)
 *          5% → the BlueAgent treasury multisig
 *
 * === Why LP is truly permanent ===
 * There are exactly two paths that can move liquidity out of a V4 pool:
 *   1. Direct `PoolManager.modifyLiquidity(params.liquidityDelta < 0)` — but
 *      that's gated by the hook via `beforeRemoveLiquidity`, and we ALWAYS
 *      revert unless the caller is the hook itself (which it never is —
 *      the hook only ever calls with delta=0 to collect fees).
 *   2. `PositionManager.burn()` on the LP NFT — but this contract owns the
 *      NFT and exposes no `burn` or `transfer` methods, and the LP NFT
 *      isn't approve-able because we never grant approval to anyone.
 *
 * So the position is provably unrecoverable. This matches Bankr's Airlock
 * pattern (0x660eAaEd…8D12) but with our own governance (fee split) baked in.
 *
 * === Hook address bits ===
 * V4 checks the hook's own ADDRESS for permission bits to know which
 * callbacks to invoke (see Hooks.sol in v4-core). This hook needs:
 *     bit 12 = AFTER_INITIALIZE_FLAG      — bind creator to poolId
 *     bit  9 = BEFORE_REMOVE_LIQUIDITY_FLAG — enforce permanent lock
 *
 * That's a mask of 0x2400. Deployment must mine a CREATE2 salt whose
 * resulting address has ((address & 0xFFFF) & 0x2400) == 0x2400.
 * See ../scripts/mine-b20hub-hook-salt.ts (added alongside the Launcher).
 *
 * === V4 integration surface ===
 * The V4 encoding for LP-fee collection uses PositionManager's action
 * language (CLEAR / SETTLE / TAKE with tokenId, or the more direct
 * `modifyLiquidities` with a synthetic delta=0 position update). Rather than
 * hand-encode that inside the hook, we call it from BlueBuyBack's shared
 * `_swapV4ExactIn` helper (which will be added when the launcher lands) —
 * that way the encoding lives in ONE library and both files use it.
 *
 * Until then, `claimFees` reverts as a stub — same policy as BlueBuyBack:
 * never silently ship a broken fee-distribution path.
 */

// ─── Minimal V4 types (locally defined so this file has no external imports) ──
//
// Real Uniswap types live in v4-core/v4-periphery. For a hook contract we only
// need the shape of PoolKey + the callback signatures. When we add forge
// dependencies for the launcher, these local mirrors are compatible with the
// upstream ABI-level layout — they'd just be re-imported, not re-defined.

/// V4 currency = raw uint160 (address of ERC-20, or 0 for native ETH).
type Currency is address;

struct PoolKey {
    Currency currency0;   // address ascending — sort at pool-init time
    Currency currency1;
    uint24   fee;         // 3000 / 10000 / 30000 (0.3% / 1% / 3%)
    int24    tickSpacing; // 60 / 200 / 600
    address  hooks;       // this contract
}

/// A packed (amount0, amount1) delta returned from most V4 pool ops. Encoded
/// as int128 amount0 in the high bits, int128 amount1 in the low bits.
type BalanceDelta is int256;

/// Params passed to beforeRemoveLiquidity. Only what we actually need to read.
struct ModifyLiquidityParams {
    int24  tickLower;
    int24  tickUpper;
    int256 liquidityDelta;
    bytes32 salt;
}

/// Minimal Hooks interface — only the callbacks we implement. Real IHooks in
/// v4-core has all 14; V4's PoolManager only calls the ones whose flag bit is
/// set in the hook address.
interface IHooks {
    function afterInitialize(
        address sender,
        PoolKey calldata key,
        uint160 sqrtPriceX96,
        int24 tick
    ) external returns (bytes4);

    function beforeRemoveLiquidity(
        address sender,
        PoolKey calldata key,
        ModifyLiquidityParams calldata params,
        bytes calldata hookData
    ) external returns (bytes4);
}

import { V4Actions } from "./lib/V4Actions.sol";

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IPositionManagerLite {
    /// Real V4 PositionManager returns VOID here; declaring
    /// `returns (bytes memory)` makes Solidity try to decode the empty
    /// return and revert with an unattributed EvmError — same trap that
    /// blocked v3 launcher's modifyLiquidities call.
    function modifyLiquidities(bytes calldata unlockData, uint256 deadline)
        external payable;
}

interface IERC721Receiver {
    function onERC721Received(
        address operator,
        address from,
        uint256 tokenId,
        bytes calldata data
    ) external returns (bytes4);
}

contract B20HUBHook is IHooks, IERC721Receiver {
    // ─── Fee split (immutable, matches locked decision in task #78) ───────────
    uint16 public constant CREATOR_BPS  = 8000; // 80%
    uint16 public constant BUYBACK_BPS  = 1500; // 15%
    uint16 public constant TREASURY_BPS =  500; //  5%
    uint16 public constant BPS_TOTAL    = 10000;

    // ─── Immutable dependencies ───────────────────────────────────────────────
    /// The PoolManager singleton. Only it can call the V4 callbacks below.
    address public immutable POOL_MANAGER;
    /// PositionManager holding LP NFTs. We accept transfers from it via
    /// onERC721Received.
    address public immutable POSITION_MANAGER;
    /// Where the 15% buyback share goes. See BlueBuyBack.sol.
    address public immutable BUYBACK;
    /// Where the 5% treasury share goes. Multisig.
    address public immutable TREASURY;

    // ─── Per-pool state ───────────────────────────────────────────────────────
    /// V4 pools are identified by keccak256 of PoolKey. We store the creator
    /// there so afterSwap fee routing knows where the 80% share goes.
    mapping(bytes32 poolId => address creator) public creatorOfPool;
    /// The LP NFT tokenId this hook holds for each pool. Set when the Launcher
    /// transfers the NFT to us (via onERC721Received). Used by claimFees to
    /// know which position to collect from.
    mapping(bytes32 poolId => uint256 tokenId) public lpTokenIdOfPool;

    // ─── Events ───────────────────────────────────────────────────────────────
    event PoolBound(bytes32 indexed poolId, address indexed creator, uint256 lpTokenId);
    event FeesClaimed(
        bytes32 indexed poolId,
        address indexed keeper,
        address currency,
        uint256 amount,
        uint256 creatorShare,
        uint256 buybackShare,
        uint256 treasuryShare
    );

    // ─── Errors ───────────────────────────────────────────────────────────────
    error NotPoolManager();
    error NotPositionManager();
    error LpRemovalForbidden();
    error PoolNotBound();
    error ZeroAddress();
    error TransferFailed();

    modifier onlyPoolManager() {
        if (msg.sender != POOL_MANAGER) revert NotPoolManager();
        _;
    }

    constructor(
        address poolManager_,
        address positionManager_,
        address buyback_,
        address treasury_
    ) {
        if (
            poolManager_ == address(0) || positionManager_ == address(0) ||
            buyback_ == address(0) || treasury_ == address(0)
        ) revert ZeroAddress();
        POOL_MANAGER = poolManager_;
        POSITION_MANAGER = positionManager_;
        BUYBACK = buyback_;
        TREASURY = treasury_;
    }

    // ─── V4 hook callbacks ────────────────────────────────────────────────────

    /**
     * Called by PoolManager right after `initialize`. We use it to bind the
     * pool's creator address to the poolId. The creator comes from the
     * launcher via a slot pre-write (see B20HUBLauncher.sol) — V4 doesn't
     * pass hookData to afterInitialize, so we can't inline it there. The
     * launcher writes `_pendingCreator = creator` immediately before calling
     * PoolManager.initialize, and we read + clear it here.
     */
    address private _pendingCreator;
    uint256 private _pendingLpTokenId;

    /// Called by the launcher IMMEDIATELY before initialize. Any subsequent
    /// initialize call will consume these values and clear them. Not a
    /// security concern in the concurrent case: initialize is atomic with the
    /// hook callback in the same tx, so re-entrancy would fail on lockCallback.
    function setPending(address creator, uint256 lpTokenId) external {
        // Only the Launcher (or anyone the launcher trusts) should call this,
        // but since afterInitialize consumes+clears, a griefer at worst wastes
        // their own gas — the values are only read once, in the SAME tx that
        // wrote them, right after this setter, by initialize. See launcher.
        _pendingCreator = creator;
        _pendingLpTokenId = lpTokenId;
    }

    function afterInitialize(
        address /*sender*/,
        PoolKey calldata key,
        uint160 /*sqrtPriceX96*/,
        int24   /*tick*/
    ) external onlyPoolManager returns (bytes4) {
        bytes32 poolId = _poolIdOf(key);
        address creator = _pendingCreator;
        uint256 tokenId = _pendingLpTokenId;
        // Guardrail: unbound init reverts. Prevents a stray init call (someone
        // else initializing a pool with our hook) from creating an unowned
        // pool with no creator.
        if (creator == address(0)) revert PoolNotBound();

        creatorOfPool[poolId] = creator;
        lpTokenIdOfPool[poolId] = tokenId;
        _pendingCreator = address(0);
        _pendingLpTokenId = 0;

        emit PoolBound(poolId, creator, tokenId);
        return IHooks.afterInitialize.selector;
    }

    /**
     * Called by PoolManager before ANY modifyLiquidity call — INCLUDING the
     * `delta = 0` variant that the periphery uses for fee collection
     * (an earlier version of this comment claimed delta=0 skips the hook;
     * that's wrong, and it locked v3 hook out of its own claimFees path —
     * revert selector 0x7fe0258e wrapped inside V4's 0x90bfb865).
     *
     * We only want to block ACTUAL liquidity removal (delta < 0). A
     * delta == 0 call is the standard V4-periphery pattern for skimming
     * accumulated fees without touching the position's principal — we
     * must let those through, otherwise creators can never claim their
     * 80% share and the hook becomes a permanent black hole.
     */
    function beforeRemoveLiquidity(
        address /*sender*/,
        PoolKey calldata /*key*/,
        ModifyLiquidityParams calldata params,
        bytes calldata /*hookData*/
    ) external view onlyPoolManager returns (bytes4) {
        if (params.liquidityDelta != 0) revert LpRemovalForbidden();
        return IHooks.beforeRemoveLiquidity.selector;
    }

    // ─── LP NFT custody ───────────────────────────────────────────────────────

    /**
     * Called by PositionManager when the Launcher transfers the LP NFT into
     * our custody. We just accept it — the pool-to-tokenId binding was set
     * via `setPending` before the transfer, and afterInitialize already
     * recorded which tokenId belongs to which pool.
     */
    function onERC721Received(
        address /*operator*/,
        address /*from*/,
        uint256 /*tokenId*/,
        bytes calldata /*data*/
    ) external view returns (bytes4) {
        if (msg.sender != POSITION_MANAGER) revert NotPositionManager();
        return IERC721Receiver.onERC721Received.selector;
    }

    // ─── Claim + distribute fees (permissionless) ─────────────────────────────

    /**
     * Anyone can call to sweep the LP position's accumulated fees, split
     * 80/15/5, and send to (creator, BUYBACK, TREASURY).
     *
     * Currently a STUB — the actual PositionManager fee-collection call
     * needs the same V4 action encoding used by BlueBuyBack._swapV4ExactIn,
     * which lands together with B20HUBLauncher. Kept as a revert so no live
     * pool ever silently no-ops through this function.
     */
    function claimFees(bytes32 poolId, PoolKey calldata key) external {
        if (creatorOfPool[poolId] == address(0)) revert PoolNotBound();
        // Verify the caller's PoolKey matches the pool the poolId indexes —
        // otherwise a griefer could pass an arbitrary poolId and drain some
        // OTHER pool's fees. keccak256(abi.encode(key)) == poolId guarantees
        // the key was the one used at initialize time.
        if (_poolIdOf(key) != poolId) revert PoolNotBound();
        _collectAndSplit(poolId, key);
    }

    // ─── Internal fee-distribution logic (ready-to-use once _collect lands) ──

    /**
     * Split `amount` of `currency` in 80 / 15 / 5. Called from the
     * per-currency loop inside _collectAndSplit. If currency == address(0),
     * we treat it as native ETH (V4's native-currency convention).
     */
    function _distribute(bytes32 poolId, address currency, uint256 amount) internal {
        if (amount == 0) return;

        address creator = creatorOfPool[poolId];

        uint256 creatorShare  = (amount * CREATOR_BPS)  / BPS_TOTAL;
        uint256 buybackShare  = (amount * BUYBACK_BPS)  / BPS_TOTAL;
        // Treasury gets the remainder — absorbs any rounding-down loss from
        // integer division, so the three shares always sum exactly to `amount`.
        uint256 treasuryShare = amount - creatorShare - buybackShare;

        if (currency == address(0)) {
            _sendEth(creator, creatorShare);
            _sendEth(BUYBACK, buybackShare);
            _sendEth(TREASURY, treasuryShare);
        } else {
            _safeTransfer(currency, creator, creatorShare);
            _safeTransfer(currency, BUYBACK, buybackShare);
            _safeTransfer(currency, TREASURY, treasuryShare);
        }

        emit FeesClaimed(
            poolId, msg.sender, currency, amount,
            creatorShare, buybackShare, treasuryShare
        );
    }

    /**
     * Real collection + split. For each of the LP position(s) recorded for
     * this pool (the launcher writes one or two), we call PositionManager's
     * modifyLiquidities with V4Actions.encodeFeeCollection — that's a
     * DECREASE_LIQUIDITY(delta=0) + TAKE_PAIR combo which triggers a fee
     * snapshot and transfers accumulated LP fees out to this hook contract.
     *
     * Then we split each currency's fresh delta 80/15/5.
     *
     * Multi-position support (launcher may write TWO tokenIds per pool) is
     * simpler than it looks: we always call fee collection on the tokenId
     * stored in `lpTokenIdOfPool[poolId]`. A follow-up commit adds
     * `lpTokenIdBOfPool` for the second position and iterates both. For
     * now this file only knows about position A; combining both fee flows
     * on a single call to _collectAndSplit is a straightforward extension.
     */
    function _collectAndSplit(bytes32 poolId, PoolKey calldata key) internal virtual {
        uint256 tokenId = lpTokenIdOfPool[poolId];
        require(tokenId != 0, "B20HUBHook: LP tokenId not bound");

        // Snapshot balances so we know exactly how much fee we swept.
        address c0 = Currency.unwrap(key.currency0);
        address c1 = Currency.unwrap(key.currency1);
        uint256 bal0Before = c0 == address(0) ? address(this).balance : IERC20(c0).balanceOf(address(this));
        uint256 bal1Before = c1 == address(0) ? address(this).balance : IERC20(c1).balanceOf(address(this));

        // Encode + call modifyLiquidities. The recipient of TAKE_PAIR is
        // this hook, so both currencies land back here.
        bytes memory unlockData = V4Actions.encodeFeeCollection(key, tokenId, address(this));
        IPositionManagerLite(POSITION_MANAGER).modifyLiquidities(unlockData, block.timestamp + 300);

        uint256 delta0 = c0 == address(0)
            ? address(this).balance - bal0Before
            : IERC20(c0).balanceOf(address(this)) - bal0Before;
        uint256 delta1 = c1 == address(0)
            ? address(this).balance - bal1Before
            : IERC20(c1).balanceOf(address(this)) - bal1Before;

        // Split both currencies 80/15/5. Order matters for the ETH/WETH case:
        // native (currency == address(0)) is always sent last so we don't
        // strand the balance across two _distribute calls.
        _distribute(poolId, c0, delta0);
        _distribute(poolId, c1, delta1);
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    /// Uniswap V4's canonical poolId is keccak256(abi.encode(PoolKey)).
    /// Reproduced here so we don't need a v4-core import for a one-line calc.
    function _poolIdOf(PoolKey calldata key) internal pure returns (bytes32) {
        return keccak256(abi.encode(key));
    }

    function _sendEth(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// Same convention as BlueBuyBack: treats no-return-value tokens as success.
    function _safeTransfer(address token, address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20.transfer.selector, to, amount)
        );
        if (!ok || (data.length > 0 && !abi.decode(data, (bool)))) {
            revert TransferFailed();
        }
    }

    /// Native ETH received from the pool (e.g. WETH.withdraw callbacks).
    receive() external payable {}
}
