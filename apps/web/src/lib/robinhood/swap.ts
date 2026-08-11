// Robinhood Chain (chainId 4663) swap support via a custom, minimal
// RobinhoodSwapRouter (see contracts/RobinhoodSwapRouter.sol for the full
// rationale + security model comment).
//
// WHY A CUSTOM ROUTER: Robinhood Chain mainnet has no single authenticated
// Uniswap deployment — Blockscout verification lets anyone submit a source
// file under any contract name, so name-searching turns up 4+ different
// contracts all self-named "UniversalRouter" plus dozens of oddly-named
// "*Router" contracts, none carrying any official confirmation. Instead,
// this router only trusts:
//   - FACTORY: the one UniswapV3Factory whose deployed source (pulled from
//     Blockscout) is byte-for-byte identical to the genuine, unmodified
//     Uniswap V3 core `UniswapV3Factory.sol`.
//   - WETH9: independently confirmed by reading `token0()` directly on
//     4 separate live, real-volume pools via eth_call against
//     rpc.mainnet.chain.robinhood.com — all 4 point at the same factory
//     above and share this same token0. Cross-checked against Blockscout's
//     token API: 16,941 holders, live exchange_rate ~$1770 (matching ETH).
// Neither address is a guess — both were verified against live on-chain
// state, not just a Blockscout name search (which is spoofable).
import { encodeDeployData, encodeFunctionData, createPublicClient, http, getAddress } from "viem";
import artifact from "./RobinhoodSwapRouter.artifact.json";
import { robinhoodMainnet } from "./chains";

const ABI = artifact.abi;
const BYTECODE = artifact.bytecode as `0x${string}`;

export const ROBINHOOD_MAINNET_VERIFIED_FACTORY = "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA" as const;
export const ROBINHOOD_MAINNET_VERIFIED_WETH9 = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as const;

/**
 * Robinhood Chain testnet (46630) has NO equivalent Uniswap V3 deployment as
 * of this writing (confirmed: a Blockscout search for "UniswapV3Factory" on
 * explorer.testnet.chain.robinhood.com returns zero results — only
 * unrelated "LivoGraduator" V2/V4 bonding-curve launchpad contracts exist
 * there). So there is currently NO way to test this router end-to-end
 * against a real pool on testnet. Do not fill this in with a guess.
 */
export const ROBINHOOD_TESTNET_VERIFIED_FACTORY: `0x${string}` | null = null;
export const ROBINHOOD_TESTNET_VERIFIED_WETH9: `0x${string}` | null = null;

/**
 * The RobinhoodSwapRouter contract address deployed on Robinhood Chain mainnet
 * (chainId 4663). Deployed 2026-07-08 by 0xD5C1dFc036F9911348EA8065F73c8123f4013FAB.
 *
 * Verified end-to-end with a real tiny swap in the same session:
 * https://robinhoodchain.blockscout.com/tx/0xa3f8fba0845809cea97bfb86d7bdf863f82d8e130986c646c9be0dafda4013e9
 *   Method: swapExactInputSingleETH (0x2a5db29a)
 *   Path: 0.0005 ETH → wrap to WETH → CASHDOG/WETH 0.01% pool
 *          (0x61969805171fBE4F6Ba2252Fad652A13d9592C8e) → 4485.657 CASHDOG
 *          received by the caller. All 3 hops (deposit wrap → pool.swap →
 *          uniswapV3SwapCallback WETH payment → pool CASHDOG payout)
 *          confirmed by the on-chain token-transfer trace.
 *
 * Contract is immutable and non-custodial — no owner, no pause, no upgrade.
 * Anyone can call it; it holds no funds between transactions.
 */
export const ROBINHOOD_SWAP_ROUTER_ADDRESS: `0x${string}` | null =
  "0x3bb0e9E3dB75faDC5f1f8b7D7B9D761Ef15cd23D";

/** Build the raw contract-creation calldata to deploy RobinhoodSwapRouter. */
export function buildRouterDeployData(factory: `0x${string}`, weth9: `0x${string}`): `0x${string}` {
  return encodeDeployData({ abi: ABI, bytecode: BYTECODE, args: [factory, weth9] });
}

export interface SwapParams {
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  fee: number; // e.g. 500, 3000, 10000 (Uniswap V3 fee tiers, in hundredths of a bip)
  amountIn: bigint;
  amountOutMinimum: bigint;
  recipient: `0x${string}`;
  deadline: bigint; // unix seconds
}

/** ERC20 -> ERC20 (or ERC20 -> WETH) exact-input swap. Requires prior `approve`. */
export function buildSwapExactInputSingleData(p: SwapParams): `0x${string}` {
  return encodeFunctionData({
    abi: ABI,
    functionName: "swapExactInputSingle",
    args: [p.tokenIn, p.tokenOut, p.fee, p.amountIn, p.amountOutMinimum, p.recipient, p.deadline],
  });
}

/** Native ETH -> ERC20 exact-input swap ("buy"). Send `amountIn` as tx value. */
export function buildSwapExactInputSingleETHData(p: Omit<SwapParams, "tokenIn" | "amountIn">): `0x${string}` {
  return encodeFunctionData({
    abi: ABI,
    functionName: "swapExactInputSingleETH",
    args: [p.tokenOut, p.fee, p.amountOutMinimum, p.recipient, p.deadline],
  });
}

/** ERC20 -> native ETH exact-input swap ("sell"). Requires prior `approve`. */
export function buildSwapExactInputSingleForETHData(p: Omit<SwapParams, "tokenOut">): `0x${string}` {
  return encodeFunctionData({
    abi: ABI,
    functionName: "swapExactInputSingleForETH",
    args: [p.tokenIn, p.fee, p.amountIn, p.amountOutMinimum, p.recipient, p.deadline],
  });
}

/** Standard ERC-20 `approve(spender, amount)` calldata — needed before any ERC20-input swap. */
export function buildErc20ApproveData(spender: `0x${string}`, amount: bigint): `0x${string}` {
  return encodeFunctionData({
    abi: [
      {
        type: "function",
        name: "approve",
        stateMutability: "nonpayable",
        inputs: [
          { name: "spender", type: "address" },
          { name: "amount", type: "uint256" },
        ],
        outputs: [{ type: "bool" }],
      },
    ],
    functionName: "approve",
    args: [spender, amount],
  });
}

export { ABI as ROBINHOOD_SWAP_ROUTER_ABI, BYTECODE as ROBINHOOD_SWAP_ROUTER_BYTECODE };

// ─── Token→token swaps ──────────────────────────────────────────────────────
//
// The deployed router only exposes THREE swap primitives (see ABI): the two
// single-hop native-side helpers (ETH→token, token→ETH) and one generic
// single-hop ERC20→ERC20 (`swapExactInputSingle`). There is NO `exactInput`
// with V3 `path` bytes — this router does not support atomic multi-hop.
//
// So for token→token we build the route ourselves off-chain:
//   1. Try a direct ERC20→ERC20 pool via the same 4-fee-tier probe.
//   2. If none, fall back to a 2-hop route through WETH9: tokenIn → WETH →
//      tokenOut, one direct pool at each leg. Because the router can't chain
//      atomically, the two legs are returned as two separate txs — the client
//      signs them sequentially. The intermediate WETH sits in the user's own
//      wallet between the two txs (non-custodial: never the server).
//   3. If neither leg exists, return `{ route: null, reason: "no route" }`
//      so the API/UI can show a helpful message instead of failing.

const V3_FEE_TIERS_LOCAL = [100, 500, 3000, 10000] as const;

const FACTORY_GET_POOL_ABI = [
  {
    type: "function",
    name: "getPool",
    stateMutability: "view",
    inputs: [
      { name: "tokenA", type: "address" },
      { name: "tokenB", type: "address" },
      { name: "fee", type: "uint24" },
    ],
    outputs: [{ type: "address" }],
  },
] as const;

const POOL_LIQUIDITY_ABI = [
  {
    type: "function",
    name: "liquidity",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint128" }],
  },
] as const;

const _client = createPublicClient({
  chain: robinhoodMainnet,
  transport: http("https://rpc.mainnet.chain.robinhood.com"),
});

const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as const;

/** Deepest-liquidity pool for the given ordered token pair, or null. */
async function bestPoolForPair(
  tokenA: `0x${string}`,
  tokenB: `0x${string}`,
): Promise<{ address: `0x${string}`; fee: number; liquidity: bigint } | null> {
  const factory = ROBINHOOD_MAINNET_VERIFIED_FACTORY as `0x${string}`;

  const addresses = await Promise.all(
    V3_FEE_TIERS_LOCAL.map((fee) =>
      _client
        .readContract({
          address: factory,
          abi: FACTORY_GET_POOL_ABI,
          functionName: "getPool",
          args: [tokenA, tokenB, fee],
        })
        .catch(() => ZERO_ADDR),
    ),
  );

  type LivePool = { address: `0x${string}`; fee: number; liquidity: bigint };
  const pools: (LivePool | null)[] = await Promise.all(
    addresses.map(async (addr, i): Promise<LivePool | null> => {
      if (addr === ZERO_ADDR) return null;
      try {
        const liq = await _client.readContract({
          address: addr as `0x${string}`,
          abi: POOL_LIQUIDITY_ABI,
          functionName: "liquidity",
        });
        if ((liq as bigint) === 0n) return null;
        return {
          address: getAddress(addr as string) as `0x${string}`,
          fee: V3_FEE_TIERS_LOCAL[i] as number,
          liquidity: liq as bigint,
        };
      } catch {
        return null;
      }
    }),
  );

  const live = pools.filter((p): p is LivePool => !!p);
  if (!live.length) return null;
  return live.reduce<LivePool>((best, p) => (p.liquidity > best.liquidity ? p : best), live[0]);
}

/**
 * Non-mutating V3-executability probe. Returns the same route kind that
 * `buildTokenToTokenSwapCalldata` would resolve, WITHOUT building the
 * calldata. Used by the quote handler (`rh-stock-swap-quote`) so it can
 * be honest about whether the swap the user is quoting will actually be
 * executable — before the fix, GT told the quote "direct pool exists"
 * (V3 OR V4), but prepare only executes V3, so V4-only tokens like SNDK
 * would get a green quote then a red prepare error. Now the quote can
 * refuse "direct" cleanly. See rh-stock-swap-prepare for the mirror.
 */
export async function checkTokenToTokenRoute(
  tokenIn: `0x${string}`,
  tokenOut: `0x${string}`,
): Promise<
  | { route: "direct" | "weth-hopped"; direct?: { address: `0x${string}`; fee: number } }
  | { route: null; reason: string }
> {
  const weth = ROBINHOOD_MAINNET_VERIFIED_WETH9 as `0x${string}`;
  const wethLower = weth.toLowerCase();
  const inLower = tokenIn.toLowerCase();
  const outLower = tokenOut.toLowerCase();
  if (inLower === outLower) return { route: null, reason: "tokenIn and tokenOut are the same" };

  const direct = await bestPoolForPair(tokenIn, tokenOut);
  if (direct) return { route: "direct", direct: { address: direct.address, fee: direct.fee } };

  // If either side already IS WETH, hopping through WETH is the same as
  // the direct we just tried — bail. Same short-circuit as the real
  // calldata builder.
  if (inLower === wethLower || outLower === wethLower) {
    return { route: null, reason: "no direct V3 pool for this pair (WETH side of pair)" };
  }
  const [legIn, legOut] = await Promise.all([
    bestPoolForPair(tokenIn, weth),
    bestPoolForPair(weth, tokenOut),
  ]);
  if (!legIn || !legOut) {
    return { route: null, reason: "no V3 route: neither a direct pool nor a WETH-hopped route exists" };
  }
  return { route: "weth-hopped" };
}

export interface TokenToTokenCalldataResult {
  /** "direct" = one single-hop tx. "multi-hop" = two sequential single-hop txs via WETH. null = no route. */
  route: "direct" | "multi-hop" | null;
  /** Only set when route === null — human-friendly reason for the UI. */
  reason?: string;
  /**
   * Ordered list of calls the client should sign in sequence. Each has:
   * `to` (contract to call), `data` (calldata hex), `value` (hex wei, "0x0"
   * for ERC20-only), and `kind` describing which step it is. When
   * `kind === "approve"` the client is approving the router to spend the
   * previous step's output — for multi-hop routes there are TWO approves
   * (one for tokenIn, one for the intermediate WETH after leg 1).
   */
  calls?: Array<{
    kind: "approve" | "swap";
    to: `0x${string}`;
    data: `0x${string}`;
    value: `0x${string}`;
    /** For "swap" calls: which leg this is when route === "multi-hop" (1 = in→WETH, 2 = WETH→out). */
    leg?: 1 | 2;
    /** For "swap" calls: the pool used for this leg. Helps the UI show fee tier. */
    pool?: { address: `0x${string}`; fee: number };
  }>;
}

export interface TokenToTokenParams {
  router: `0x${string}`;
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  amountIn: bigint;
  /**
   * Minimum out (base units of tokenOut) enforced on the FINAL leg.
   * For multi-hop we only bound the final leg; the intermediate WETH leg is
   * left unbounded because the client cannot know the exact amount coming
   * out of leg 1 at prepare time. This is the same trade-off Uniswap's own
   * multicall paths make for chained calls.
   */
  amountOutMinimum: bigint;
  recipient: `0x${string}`;
  deadline: bigint;
}

/**
 * Build the calldata for a token→token swap on Robinhood Chain. Non-custodial:
 * this function only *encodes* the calls; the client signs and sends. Returns
 * a null-route sentinel when no direct OR WETH-hopped pool exists, so the
 * API can 200-return with a clear error code instead of throwing.
 *
 * ⚠️ WETH9 short-circuit: if `tokenIn` or `tokenOut` is WETH9 itself, we
 * skip the multi-hop path and just do a single ERC20→ERC20 direct swap
 * (a WETH↔token pool is the same thing) — no need to hop through WETH twice.
 */
export async function buildTokenToTokenSwapCalldata(
  p: TokenToTokenParams,
): Promise<TokenToTokenCalldataResult> {
  const weth = ROBINHOOD_MAINNET_VERIFIED_WETH9 as `0x${string}`;
  const wethLower = weth.toLowerCase();
  const inLower = p.tokenIn.toLowerCase();
  const outLower = p.tokenOut.toLowerCase();

  if (inLower === outLower) {
    return { route: null, reason: "tokenIn and tokenOut are the same" };
  }

  // 1) Try a direct pool first.
  const direct = await bestPoolForPair(p.tokenIn, p.tokenOut);
  if (direct) {
    const approveData = buildErc20ApproveData(p.router, p.amountIn);
    const swapData = buildSwapExactInputSingleData({
      tokenIn: p.tokenIn,
      tokenOut: p.tokenOut,
      fee: direct.fee,
      amountIn: p.amountIn,
      amountOutMinimum: p.amountOutMinimum,
      recipient: p.recipient,
      deadline: p.deadline,
    });
    return {
      route: "direct",
      calls: [
        { kind: "approve", to: p.tokenIn, data: approveData, value: "0x0" },
        {
          kind: "swap",
          to: p.router,
          data: swapData,
          value: "0x0",
          pool: { address: direct.address, fee: direct.fee },
        },
      ],
    };
  }

  // 2) No direct pool → try WETH-hopped route. But if either side already IS
  //    WETH, a "hop through WETH" is the same as the direct path we just
  //    tried, so there's nothing more to find — bail out.
  if (inLower === wethLower || outLower === wethLower) {
    return { route: null, reason: "no direct pool for this pair on Robinhood Chain" };
  }

  const [legIn, legOut] = await Promise.all([
    bestPoolForPair(p.tokenIn, weth),
    bestPoolForPair(weth, p.tokenOut),
  ]);
  if (!legIn || !legOut) {
    return { route: null, reason: "no route: neither a direct pool nor a WETH-hopped route exists" };
  }

  // Leg 1: tokenIn → WETH (bounded by 0 — final slippage guard is on leg 2).
  const approveInData = buildErc20ApproveData(p.router, p.amountIn);
  const leg1Data = buildSwapExactInputSingleData({
    tokenIn: p.tokenIn,
    tokenOut: weth,
    fee: legIn.fee,
    amountIn: p.amountIn,
    amountOutMinimum: 0n,
    recipient: p.recipient, // WETH lands in the user's wallet between the two txs
    deadline: p.deadline,
  });

  // Leg 2: WETH → tokenOut. We can't know the exact WETH amount at prepare
  // time (leg 1 hasn't run yet), so we approve MaxUint256 for WETH and set
  // amountIn to a placeholder marker (uint256 max). The client MUST replace
  // both after leg 1 lands, using its own on-chain balance read. This is
  // signaled by the special "amountIn: max" convention in the meta below.
  const MAX_UINT256 = (1n << 256n) - 1n;
  const approveOutData = buildErc20ApproveData(p.router, MAX_UINT256);
  const leg2Data = buildSwapExactInputSingleData({
    tokenIn: weth,
    tokenOut: p.tokenOut,
    fee: legOut.fee,
    amountIn: MAX_UINT256, // placeholder — client rebuilds with actual balance
    amountOutMinimum: p.amountOutMinimum,
    recipient: p.recipient,
    deadline: p.deadline,
  });

  return {
    route: "multi-hop",
    calls: [
      { kind: "approve", to: p.tokenIn, data: approveInData, value: "0x0" },
      {
        kind: "swap",
        to: p.router,
        data: leg1Data,
        value: "0x0",
        leg: 1,
        pool: { address: legIn.address, fee: legIn.fee },
      },
      { kind: "approve", to: weth, data: approveOutData, value: "0x0" },
      {
        kind: "swap",
        to: p.router,
        data: leg2Data,
        value: "0x0",
        leg: 2,
        pool: { address: legOut.address, fee: legOut.fee },
      },
    ],
  };
}
