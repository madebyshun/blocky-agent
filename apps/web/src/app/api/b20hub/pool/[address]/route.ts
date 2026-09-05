import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, http, keccak256, encodeAbiParameters } from "viem";
import { base } from "viem/chains";
import { B20HUB_HOOK, WETH9_BASE, V4_FEE_TIERS } from "@/lib/b20hub/constants";

export const runtime = "nodejs";
export const revalidate = 30;

/**
 * GET /api/b20hub/pool/[address] — probe the hook for the first fee tier
 * whose creator/tokenId is bound. Returns null if the token isn't a
 * B20HUB pool at any of the 3 standard tiers.
 *
 * Server-side probing avoids client-side flakiness against public Base
 * RPC's aggressive rate limit — we cache the result for 30s so a page
 * refresh doesn't refire 3 RPC reads per visitor. Client just gets a
 * ready-made JSON.
 */

const B20_FACTORY    = "0xB20f000000000000000000000000000000000000" as const;
const STATE_VIEW     = "0xA3c0c9B65BAd0b08107Aa264b0f3dB444b867A71" as const;
const POSMGR         = "0x7C5f5A4bBd8fD63184577525326123B519429bDc" as const;

const HOOK_ABI = [
  { type: "function", name: "creatorOfPool", stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }], outputs: [{ name: "creator", type: "address" }] },
  { type: "function", name: "lpTokenIdOfPool", stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }], outputs: [{ name: "tokenId", type: "uint256" }] },
] as const;
const B20_ABI = [
  { type: "function", name: "isB20", stateMutability: "view",
    inputs: [{ name: "addr", type: "address" }], outputs: [{ type: "bool" }] },
] as const;
const ERC20_ABI = [
  { type: "function", name: "name",        stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "symbol",      stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "decimals",    stateMutability: "view", inputs: [], outputs: [{ type: "uint8"   }] },
] as const;
const STATE_VIEW_ABI = [
  { type: "function", name: "getSlot0", stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick",         type: "int24"   },
      { name: "protocolFee",  type: "uint24"  },
      { name: "lpFee",        type: "uint24"  },
    ] },
] as const;
const POSMGR_ABI = [
  { type: "function", name: "ownerOf", stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }], outputs: [{ type: "address" }] },
] as const;

const TIERS: Array<{ fee: number; spacing: number; label: string }> = [
  { fee: 3000,  spacing: V4_FEE_TIERS.MEDIUM.tickSpacing, label: "0.3%" },
  { fee: 10000, spacing: V4_FEE_TIERS.HIGH.tickSpacing,   label: "1%"   },
  { fee: 30000, spacing: 200,                             label: "3%"   },
];

const publicClient = createPublicClient({ chain: base, transport: http("https://mainnet.base.org") });

/**
 * Fetch ETH/USD spot from CoinGecko. Falls back to a hardcoded $3000 if the
 * upstream is down — we never want the whole detail page to fail on a
 * transient CG hiccup, and a stale $3000 default at least keeps the mcap
 * within an order of magnitude of reality.
 *
 * Cached in-module for 5 min (per lambda instance) via a tiny memo so a
 * burst of concurrent detail-page hits doesn't hammer CoinGecko. Vercel
 * lambdas warm-cache this too.
 */
let _ethCache: { at: number; usd: number | null } | null = null;
async function fetchEthPriceUsd(): Promise<number | null> {
  const now = Date.now();
  if (_ethCache && now - _ethCache.at < 5 * 60_000) return _ethCache.usd;
  try {
    const r = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
      { signal: AbortSignal.timeout(4000), headers: { Accept: "application/json" } },
    );
    if (!r.ok) throw new Error(`CG ${r.status}`);
    const j = (await r.json()) as { ethereum?: { usd?: number } };
    const usd = j?.ethereum?.usd;
    if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0) {
      throw new Error("bad CG payload");
    }
    _ethCache = { at: now, usd };
    return usd;
  } catch {
    _ethCache = { at: now, usd: 3000 };
    return 3000;
  }
}

function buildKey(token: `0x${string}`, fee: number, spacing: number) {
  const wethIsSmaller = WETH9_BASE.toLowerCase() < token.toLowerCase();
  return {
    currency0:  (wethIsSmaller ? WETH9_BASE : token) as `0x${string}`,
    currency1:  (wethIsSmaller ? token : WETH9_BASE) as `0x${string}`,
    fee, tickSpacing: spacing, hooks: B20HUB_HOOK as `0x${string}`,
  };
}
function poolIdOf(key: ReturnType<typeof buildKey>): `0x${string}` {
  return keccak256(encodeAbiParameters(
    [{ type: "tuple", components: [
      { name: "currency0",   type: "address" },
      { name: "currency1",   type: "address" },
      { name: "fee",         type: "uint24"  },
      { name: "tickSpacing", type: "int24"   },
      { name: "hooks",       type: "address" },
    ] }],
    [key],
  ));
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return NextResponse.json({ ok: false, error: "invalid address" }, { status: 400 });
  }
  const token = address as `0x${string}`;

  try {
    const [isB20, name, symbol, totalSupply, decimals] = await Promise.all([
      publicClient.readContract({ address: B20_FACTORY, abi: B20_ABI, functionName: "isB20", args: [token] }),
      publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "name" }).catch(() => "?"),
      publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "symbol" }).catch(() => "?"),
      publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "totalSupply" }).catch(() => 0n),
      publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "decimals" }).catch(() => 18),
    ]);

    if (!isB20) {
      return NextResponse.json({
        ok: true, isB20: false, name, symbol,
        totalSupply: (totalSupply as bigint).toString(),
        decimals: Number(decimals),
        pool: null,
      });
    }

    // Fetch ETH/USD spot in parallel with the pool probe so we can compute
    // an onchain-native market cap (pump.fun / Bankr pattern — every
    // launchpad displays its own mcap from pool state + ETH price rather
    // than waiting for DexScreener to index the pool after the first trade).
    const ethPricePromise = fetchEthPriceUsd();

    // Probe fee tiers sequentially so an error on one doesn't kill others.
    // 30s cache absorbs the cost of doing this per request.
    let pool: {
      poolId:            `0x${string}`;
      feeTier:           number;
      feeLabel:          string;
      creator:           `0x${string}`;
      lpTokenIdA:        string;
      lpNftOwner?:       `0x${string}` | null;
      slot0?:            { sqrtPriceX96: string; tick: number; protocolFee: number; lpFee: number } | null;
      // Onchain-computed metrics — independent of DexScreener indexer.
      computedPriceUsd?: number | null;
      computedMcapUsd?:  number | null;
      ethPriceUsd?:      number | null;
    } | null = null;

    for (const t of TIERS) {
      const key = buildKey(token, t.fee, t.spacing);
      const id  = poolIdOf(key);
      const c = await publicClient.readContract({
        address: B20HUB_HOOK as `0x${string}`, abi: HOOK_ABI,
        functionName: "creatorOfPool", args: [id],
      }).catch(() => "0x0000000000000000000000000000000000000000" as const);
      if (c !== "0x0000000000000000000000000000000000000000") {
        const [lpId, slot0raw, ownerRaw] = await Promise.all([
          publicClient.readContract({
            address: B20HUB_HOOK as `0x${string}`, abi: HOOK_ABI,
            functionName: "lpTokenIdOfPool", args: [id],
          }).catch(() => 0n),
          publicClient.readContract({
            address: STATE_VIEW, abi: STATE_VIEW_ABI,
            functionName: "getSlot0", args: [id],
          }).catch(() => null),
          // Compute owner of the LP NFT — should be the hook (locked).
          publicClient.readContract({
            address: B20HUB_HOOK as `0x${string}`, abi: HOOK_ABI,
            functionName: "lpTokenIdOfPool", args: [id],
          }).then((tid) =>
            publicClient.readContract({
              address: POSMGR, abi: POSMGR_ABI,
              functionName: "ownerOf", args: [tid as bigint],
            }).catch(() => null),
          ).catch(() => null),
        ]);
        // Compute onchain-native price + mcap. Works for any B20HUB pool
        // (WETH is currency0 since 0x4200… < 0xb200…), no trades required.
        //
        //   sqrtP = sqrtPriceX96 / 2^96
        //   P     = sqrtP^2  (= amount1 / amount0 = base_tokens / wei_WETH)
        //   1 token_whole = 10^decimals base
        //   1 ETH        = 10^18 wei
        //   → token_price_wei_WETH  = 1e_decimals / P
        //   → token_price_ETH       = token_price_wei_WETH / 1e18
        //   → mcap_USD              = totalSupply_whole × token_price_ETH × ETH_USD
        let computedPriceUsd: number | null = null;
        let computedMcapUsd:  number | null = null;
        const ethPriceUsd = await ethPricePromise.catch(() => null);
        if (slot0raw && ethPriceUsd != null) {
          const sqrtP_X96 = slot0raw[0] as bigint;
          // Do the math in FP; fine for display since we're aiming at
          // 4-6 significant digits, not gwei precision.
          const sqrtP = Number(sqrtP_X96) / Math.pow(2, 96);
          const P     = sqrtP * sqrtP;               // base_tokens / wei_WETH
          const dec   = Number(decimals);
          const supplyWhole = Number(totalSupply as bigint) / Math.pow(10, dec);
          if (P > 0) {
            const tokenPriceWETH_wei = Math.pow(10, dec) / P;   // wei_WETH per whole token
            const tokenPriceETH      = tokenPriceWETH_wei / 1e18;
            computedPriceUsd = tokenPriceETH * ethPriceUsd;
            computedMcapUsd  = supplyWhole * computedPriceUsd;
          }
        }

        pool = {
          poolId:            id,
          feeTier:           t.fee,
          feeLabel:          t.label,
          creator:           c as `0x${string}`,
          lpTokenIdA:        (lpId as bigint).toString(),
          lpNftOwner:        ownerRaw as `0x${string}` | null,
          slot0: slot0raw ? {
            sqrtPriceX96: (slot0raw[0] as bigint).toString(),
            tick:         Number(slot0raw[1]),
            protocolFee:  Number(slot0raw[2]),
            lpFee:        Number(slot0raw[3]),
          } : null,
          computedPriceUsd,
          computedMcapUsd,
          ethPriceUsd,
        };
        break;
      }
    }

    return NextResponse.json({
      ok: true,
      isB20: true,
      name, symbol,
      totalSupply: (totalSupply as bigint).toString(),
      decimals: Number(decimals),
      pool,
    }, { headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60" } });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
