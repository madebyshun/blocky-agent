// x402/rh-stock-swap-route (X3) — inspect all pools + route options for a
// swap pair on Robinhood Chain. Price: $0.10
//
// Given `token_in` and `token_out` (either as `0x…` addresses OR canonical
// RWA tickers), probes:
//   1. Every V3 fee tier for a direct pool via the RH factory.
//   2. Every WETH-hopped route (in→WETH, WETH→out) for a multi-hop option.
// Returns the full pool map with liquidity per tier — so a client can pick
// its own path if it doesn't want our best-liquidity default.
//
// Distinct from X1/X2: this tool does NOT compute a quote or build calldata.
// It's a pure route inspector — the primitive an agent or router would call
// before deciding how to split a large trade.

import { RH_CHAIN, findByTicker, RWA_TOKENS } from "@/lib/robinhood/rwa-registry";
import { V3_FEE_TIERS, findWethPools } from "@/lib/robinhood/pool";
import { poolsForToken } from "@/lib/robinhood/rwa-market";
import { createPublicClient, http, getAddress } from "viem";
import { robinhoodMainnet } from "@/lib/robinhood/chains";
import { ROBINHOOD_MAINNET_VERIFIED_FACTORY, ROBINHOOD_MAINNET_VERIFIED_WETH9 } from "@/lib/robinhood/swap";

const _client = createPublicClient({ chain: robinhoodMainnet, transport: http() });

const FACTORY_ABI = [{
  type: "function", name: "getPool", stateMutability: "view",
  inputs: [
    { name: "tokenA", type: "address" },
    { name: "tokenB", type: "address" },
    { name: "fee", type: "uint24" },
  ],
  outputs: [{ type: "address" }],
}] as const;

const POOL_ABI = [{
  type: "function", name: "liquidity", stateMutability: "view",
  inputs: [], outputs: [{ type: "uint128" }],
}] as const;

const ZERO = "0x0000000000000000000000000000000000000000";

function resolveInput(v: string): { address: `0x${string}` | null; ticker: string | null } {
  const trimmed = v.trim();
  if (/^0x[a-fA-F0-9]{40}$/.test(trimmed)) return { address: trimmed as `0x${string}`, ticker: null };
  const token = findByTicker(trimmed);
  if (token) return { address: token.contract, ticker: token.ticker };
  return { address: null, ticker: null };
}

async function probeAllTiers(a: `0x${string}`, b: `0x${string}`) {
  const addresses = await Promise.all(
    V3_FEE_TIERS.map((fee) =>
      _client.readContract({
        address: ROBINHOOD_MAINNET_VERIFIED_FACTORY as `0x${string}`,
        abi: FACTORY_ABI, functionName: "getPool", args: [a, b, fee],
      }).catch(() => ZERO as `0x${string}`),
    ),
  );
  const rows = await Promise.all(addresses.map(async (addr, i) => {
    if (addr === ZERO) return { fee: V3_FEE_TIERS[i], address: null, liquidity: null };
    try {
      const liq = await _client.readContract({
        address: addr as `0x${string}`, abi: POOL_ABI, functionName: "liquidity",
      });
      return { fee: V3_FEE_TIERS[i], address: getAddress(addr as string), liquidity: (liq as bigint).toString() };
    } catch {
      return { fee: V3_FEE_TIERS[i], address: getAddress(addr as string), liquidity: null };
    }
  }));
  return rows;
}

export default async function handler(req: Request): Promise<Response> {
  try {
    let body: { token_in?: string; token_out?: string } = {};
    try { const t = await req.text(); if (t?.trim().startsWith("{")) body = JSON.parse(t); } catch {}
    const url = new URL(req.url);

    const inRaw  = (body.token_in  ?? url.searchParams.get("token_in")  ?? "").trim();
    const outRaw = (body.token_out ?? url.searchParams.get("token_out") ?? "").trim();

    if (!inRaw || !outRaw) {
      return Response.json({ error: "Provide `token_in` and `token_out` (0x address or RWA ticker)." }, { status: 400 });
    }

    const inp  = resolveInput(inRaw);
    const outp = resolveInput(outRaw);
    if (!inp.address || !outp.address) {
      return Response.json({
        error: "Could not resolve one of the inputs. Provide a valid 0x address or a canonical RWA ticker.",
        input: { token_in: inRaw, resolved: inp.address, token_out: outRaw, resolved_out: outp.address },
      }, { status: 400 });
    }
    if (inp.address.toLowerCase() === outp.address.toLowerCase()) {
      return Response.json({ error: "token_in and token_out are the same." }, { status: 400 });
    }

    const timestamp = new Date().toISOString();
    const weth = ROBINHOOD_MAINNET_VERIFIED_WETH9 as `0x${string}`;

    // 1) Direct route probe
    const direct = await probeAllTiers(inp.address, outp.address);
    const directLive = direct.filter((r) => r.address && r.liquidity && r.liquidity !== "0");

    // 2) Multi-hop probes only when neither side is already WETH
    type HopPool = { fee: (typeof V3_FEE_TIERS)[number]; address: `0x${string}`; liquidity: string };
    let hopIn: HopPool[] = [];
    let hopOut: HopPool[] = [];
    if (
      inp.address.toLowerCase() !== weth.toLowerCase() &&
      outp.address.toLowerCase() !== weth.toLowerCase()
    ) {
      [hopIn, hopOut] = await Promise.all([
        findWethPools(inp.address).then((ps) => ps.map((p): HopPool => ({ fee: p.fee, address: p.address, liquidity: p.liquidity }))),
        findWethPools(outp.address).then((ps) => ps.map((p): HopPool => ({ fee: p.fee, address: p.address, liquidity: p.liquidity }))),
      ]);
    }

    // Registry annotations — nice-to-have for the client UI.
    const registryLookup = new Map(RWA_TOKENS.map((t) => [t.contract.toLowerCase(), t]));
    const inRwa  = registryLookup.get(inp.address.toLowerCase());
    const outRwa = registryLookup.get(outp.address.toLowerCase());

    const has_direct    = directLive.length > 0;
    const has_multi_hop = hopIn.length > 0 && hopOut.length > 0;

    // ── Info-only: V4 pools discovered via GeckoTerminal ─────────────────
    // The verified V3 router (RobinhoodSwapRouter) can't execute against V4
    // pools, but a builder using the Uniswap Universal Router or a V4-native
    // integration can. Surface them so the caller has full visibility.
    const inAddr = inp.address as `0x${string}`;
    const outAddr = outp.address as `0x${string}`;
    const inLower = inAddr.toLowerCase();
    const outLower = outAddr.toLowerCase();
    const inGt  = await poolsForToken(inAddr).catch(() => []);
    const outGt = await poolsForToken(outAddr).catch(() => []);
    const inV4  = inGt.filter((p) =>
      p.dex.includes("v4") &&
      (p.base_token === outLower || p.quote_token === outLower)
    );
    const outV4 = outGt.filter((p) =>
      p.dex.includes("v4") &&
      (p.base_token === inLower || p.quote_token === inLower)
    );
    const v4Pools = [...new Map([...inV4, ...outV4].map((p) => [p.address, p])).values()];

    return Response.json({
      tool: "rh-stock-swap-route",
      token_in:  { address: inp.address,  ticker: inRwa?.ticker  ?? inp.ticker  ?? null, name: inRwa?.name  ?? null },
      token_out: { address: outp.address, ticker: outRwa?.ticker ?? outp.ticker ?? null, name: outRwa?.name ?? null },
      // V3-only route info (executable via the verified RobinhoodSwapRouter).
      v3: {
        has_direct,
        has_multi_hop,
        recommended: has_direct ? "direct" : has_multi_hop ? "multi-hop" : null,
        direct: {
          pools: direct,
          best: has_direct
            ? directLive.reduce((b, p) => (BigInt(p.liquidity!) > BigInt(b.liquidity!) ? p : b))
            : null,
        },
        multi_hop: has_multi_hop ? {
          via: weth,
          leg1_pools_in_to_weth: hopIn,
          leg2_pools_weth_to_out: hopOut,
        } : null,
      },
      // V4 pools discovered via GT — info-only, current router can't execute
      // against them. Requires Uniswap Universal Router / V4-native tooling.
      v4_info_only: {
        pools: v4Pools.map((p) => ({
          address: p.address,
          name: p.name,
          dex: p.dex,
          tvl_usd: p.reserve_usd,
          volume_24h_usd: p.volume_24h_usd,
        })),
        note: "V4 pools shown for visibility. The verified RobinhoodSwapRouter is V3-only — executing against these requires Uniswap Universal Router or a V4-native integration (see Task #98).",
      },
      // Back-compat top-level for callers written against the earlier shape.
      has_direct,
      has_multi_hop,
      recommended_route: has_direct ? "direct" : has_multi_hop ? "multi-hop" : null,
      note: !has_direct && !has_multi_hop && v4Pools.length === 0
        ? "No V3 pool and no known V4 pool exists for this pair on Robinhood Chain."
        : !has_direct && !has_multi_hop && v4Pools.length > 0
          ? "No V3 route — RWA liquidity for this pair sits in V4 pools. See v4_info_only for pool addresses."
          : null,
      data_sources: ["on-chain RH V3 factory + pool liquidity reads", "api.geckoterminal.com (RH Chain)"],
      network: RH_CHAIN,
      timestamp,
    });
  } catch (e) {
    return Response.json({ error: "rh-stock-swap-route failed", message: (e as Error).message }, { status: 500 });
  }
}
