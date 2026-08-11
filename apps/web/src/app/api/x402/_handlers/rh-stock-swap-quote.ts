// x402/rh-stock-swap-quote (X1) — quote for a RH tokenized-stock swap.
// Price: $0.05
//
// Given a ticker + side (buy/sell) + amount + optional denom (USDG default,
// or WETH), returns:
//   • best available route (direct pool at deepest liquidity, or multi-hop
//     via WETH if no direct pool exists)
//   • the pool's own address + fee tier (from the RH factory verified in
//     lib/robinhood/swap.ts)
//   • expected_out (spot-based estimate)
//   • min_out (expected_out × (1 − slippage_bps / 10000))
//   • deadline unix (default 5 min from now)
//
// Real, verifiable data:
//   • Route + pool selection: on-chain factory read (RH mainnet RPC)
//   • Price: Chainlink oracle when available, else GT DEX spot for the same
//     pool the swap will hit — self-consistent by construction.
//
// Estimate is spot-based (no V3 tick math). For very small trades relative
// to the pool this is ~exact; for large trades it under-reports slippage,
// which is why we also surface `slippage_upper_bound_from_liquidity`.

import { findByTicker, RH_CHAIN, RH_CHAINLINK_ETH_USD } from "@/lib/robinhood/rwa-registry";
import { chainlinkLatest } from "@/lib/robinhood/rwa-price";
import { poolsForToken, resolvePrimaryPool } from "@/lib/robinhood/rwa-market";
import {
  ROBINHOOD_MAINNET_VERIFIED_WETH9,
  ROBINHOOD_MAINNET_VERIFIED_FACTORY,
  ROBINHOOD_SWAP_ROUTER_ADDRESS,
  checkTokenToTokenRoute,
} from "@/lib/robinhood/swap";
import { findWethPools, bestPool } from "@/lib/robinhood/pool";

// If the pool spot deviates from the Chainlink oracle by more than this,
// the tool surfaces a `pool_deviates_from_oracle` warning so a caller can
// gate execution (or agent can rebalance min_out). Threshold matched to
// the reviewer's revert-analysis: >1% deviation on a $57k pool means the
// pool-vs-oracle basis exceeds a 1% user slippage → oracle-based min_out
// would revert on-chain.
const POOL_ORACLE_WARN_PCT = 1.0;

const USDG_ADDR = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as const;

type Side = "buy" | "sell";
type Denom = "USDG" | "WETH";

export default async function handler(req: Request): Promise<Response> {
  try {
    let body: {
      ticker?: string;
      side?: string;
      amount?: string | number;
      denom?: string;
      slippage_bps?: number;
      deadline_minutes?: number;
    } = {};
    try { const t = await req.text(); if (t?.trim().startsWith("{")) body = JSON.parse(t); } catch {}
    const url = new URL(req.url);

    const ticker = (body.ticker ?? url.searchParams.get("ticker") ?? "").trim();
    const side   = ((body.side ?? url.searchParams.get("side") ?? "buy") as string).toLowerCase() as Side;
    const denomIn = ((body.denom ?? url.searchParams.get("denom") ?? "USDG") as string).toUpperCase() as Denom;
    const slippageBps = Math.max(1, Math.min(5000, Number(body.slippage_bps ?? url.searchParams.get("slippage_bps") ?? 100)));
    const deadlineMin = Math.max(1, Math.min(60, Number(body.deadline_minutes ?? url.searchParams.get("deadline_minutes") ?? 5)));
    const amountStr = String(body.amount ?? url.searchParams.get("amount") ?? "").trim();

    if (!ticker || !amountStr) {
      return Response.json({ error: "Provide `ticker` and `amount` (human-readable, e.g. 100 for $100 USDG)." }, { status: 400 });
    }
    if (side !== "buy" && side !== "sell") {
      return Response.json({ error: "`side` must be `buy` or `sell`." }, { status: 400 });
    }
    if (denomIn !== "USDG" && denomIn !== "WETH") {
      return Response.json({ error: "`denom` must be `USDG` or `WETH`." }, { status: 400 });
    }

    const amount = parseFloat(amountStr);
    if (!Number.isFinite(amount) || amount <= 0) {
      return Response.json({ error: "`amount` must be a positive number." }, { status: 400 });
    }

    const token = findByTicker(ticker);
    if (!token) return Response.json({ tool: "rh-stock-swap-quote", ticker, error: "Ticker not in registry." }, { status: 404 });

    const timestamp = new Date().toISOString();

    // Resolve tokenIn / tokenOut based on side.
    const quoteAddr = denomIn === "USDG" ? USDG_ADDR : ROBINHOOD_MAINNET_VERIFIED_WETH9;
    const quoteDecimals = denomIn === "USDG" ? 6 : 18;
    const tokenIn  = (side === "buy") ? quoteAddr : token.contract;
    const tokenOut = (side === "buy") ? token.contract : quoteAddr;
    const tokenInDecimals  = (side === "buy") ? quoteDecimals : token.decimals;
    const tokenOutDecimals = (side === "buy") ? token.decimals : quoteDecimals;

    // ── Use SHARED primary pool selector so X1 quotes against exactly the
    //    same pool X2 will execute against, and so M2/M5/A4/L1 stay
    //    consistent for the same ticker. ─────────────────────────────────
    const primary = await resolvePrimaryPool(token.contract, { preferUsdgQuote: denomIn === "USDG" });
    const primaryPool = primary.pool;

    // Legacy GT probe kept for `directGt` route-hint on the response.
    const gtPools = await poolsForToken(token.contract);
    const denomLower = quoteAddr.toLowerCase();
    const directGt = gtPools.find(
      (p) => (p.base_token === denomLower || p.quote_token === denomLower) && p.reserve_usd > 0,
    );

    // On-chain WETH pool probe — always accurate.
    let bestWethPool = null;
    if (denomIn === "WETH") {
      const pools = await findWethPools(token.contract);
      bestWethPool = bestPool(pools) ?? null;
    }

    // Chainlink oracle → cross-check ONLY, never the quote spot itself.
    const oracle = token.chainlinkFeed
      ? await chainlinkLatest(token.chainlinkFeed, token.chainlinkHeartbeat ?? 86400)
      : null;

    // ── QUOTE spot MUST come from the pool the swap will hit, not the
    //    Chainlink oracle. Previously we used oracle → min_out based on
    //    a price the pool doesn't trade at → V3/V4 swap reverts because
    //    the amountOutMinimum was set against oracle, not pool basis.
    //    Fix: pool_spot_usd is authoritative. Oracle is a sanity check.
    const pool_spot_usd: number | null = primaryPool?.price_usd ?? gtPools[0]?.price_usd ?? null;
    const chainlink_spot_usd: number | null = oracle && !oracle.is_stale ? oracle.price_usd : null;
    const spot_usd = pool_spot_usd ?? chainlink_spot_usd;
    const spot_source: "pool" | "chainlink" | null =
      pool_spot_usd !== null ? "pool" : (chainlink_spot_usd !== null ? "chainlink" : null);

    // Cross-check: how far is the pool from the oracle? > threshold ⇒ warn.
    const pool_oracle_delta_pct = (pool_spot_usd !== null && chainlink_spot_usd !== null && chainlink_spot_usd > 0)
      ? +(((pool_spot_usd - chainlink_spot_usd) / chainlink_spot_usd) * 100).toFixed(4)
      : null;
    const pool_deviates_from_oracle =
      pool_oracle_delta_pct !== null && Math.abs(pool_oracle_delta_pct) > POOL_ORACLE_WARN_PCT;

    // ── Compute expected_out from POOL spot (not oracle) ─────────────────
    let expected_out: number | null = null;
    let route_kind: "direct" | "multi-hop" | null = null;
    if (spot_usd !== null) {
      if (denomIn === "USDG") {
        // USDG ~ $1 anchor (Chainlink USDG/USD publishes ~1.0 on RH Chain).
        expected_out = side === "buy" ? amount / spot_usd : amount * spot_usd;
        route_kind = directGt ? "direct" : "multi-hop";
      } else {
        // WETH denom → get WETH USD via Chainlink ETH/USD (deterministic).
        const ethQuote = await chainlinkLatest(RH_CHAINLINK_ETH_USD, 86400);
        let weth_usd: number | null = ethQuote?.price_usd ?? null;
        if (!weth_usd) {
          const wethPool = gtPools.find((p) => p.base_token === ROBINHOOD_MAINNET_VERIFIED_WETH9.toLowerCase() || p.quote_token === ROBINHOOD_MAINNET_VERIFIED_WETH9.toLowerCase());
          weth_usd = wethPool?.counterparty_token_price_usd ?? wethPool?.price_usd ?? null;
        }
        if (weth_usd) {
          expected_out = side === "buy" ? (amount * weth_usd) / spot_usd : (amount * spot_usd) / weth_usd;
          route_kind = bestWethPool ? "direct" : "multi-hop";
        }
      }
    }

    // ── V3 EXECUTABILITY CHECK ─────────────────────────────────────────
    // Directly probe on-chain V3 factory (same probe prepare uses). If GT
    // says "direct pool exists" but that pool is Uniswap V4, our router
    // will fail at prepare-time — the user sees a valid quote and then
    // "prepare failed · no route". Real bug found on SNDK 2026-07-23.
    // Now we downgrade the route to null with an honest warning so the
    // panel disables the Sign button BEFORE the user tries to sign.
    let route_executable = false;
    let route_unavailable_reason: string | null = null;
    if (route_kind !== null) {
      const probe = await checkTokenToTokenRoute(
        tokenIn as `0x${string}`,
        tokenOut as `0x${string}`,
      );
      if (probe.route === null) {
        route_kind = null;
        route_executable = false;
        route_unavailable_reason = probe.reason;
      } else {
        route_executable = true;
        // Reconcile: if GT's directGt said "direct" but V3 probe found
        // only a WETH-hopped path, honestly say "multi-hop". Multi-hop
        // is v1-blocked (panel disables Sign for it), but at least the
        // reason is truthful and the token can be traded in a future
        // multicall version.
        if (probe.route === "weth-hopped") route_kind = "multi-hop";
      }
    }

    // ── Additional slippage from trade impact on the actual pool ─────────
    // xy=k first-order: fill worsens by ~trade_notional / one_side_usd.
    // A $93 trade in a $28.7k one-side pool ≈ 0.32% additional impact
    // beyond the quoted spot. min_out must account for BOTH user slippage
    // AND the trade-impact term so the on-chain swap doesn't revert.
    const one_side_usd = primaryPool?.one_side_usd ?? ((gtPools[0]?.reserve_usd ?? 0) / 2);
    const notional_usd = denomIn === "USDG"
      ? (side === "buy" ? amount : (expected_out ?? amount))
      : ((expected_out ?? amount) * (spot_usd ?? 0));
    const trade_impact_pct = (one_side_usd > 0 && notional_usd > 0)
      ? +(100 * notional_usd / (one_side_usd + notional_usd)).toFixed(4)
      : 0;

    // Full min_out = pool_expected × (1 − user_slippage) × (1 − trade_impact)
    const expected_after_impact = expected_out !== null ? expected_out * (1 - trade_impact_pct / 100) : null;
    const min_out = expected_after_impact !== null ? expected_after_impact * (1 - slippageBps / 10000) : null;

    // ── Base-units (bigint-ish) representation for X2 to consume ─────────
    const amountInBaseUnits = BigInt(Math.round(amount * Math.pow(10, tokenInDecimals))).toString();
    const minOutBaseUnits = min_out !== null
      ? BigInt(Math.max(0, Math.floor(min_out * Math.pow(10, tokenOutDecimals)))).toString()
      : null;

    const warnings: string[] = [];
    if (pool_deviates_from_oracle) warnings.push(`pool_deviates_from_oracle: pool spot ${pool_oracle_delta_pct}% off Chainlink — quote uses pool basis so on-chain swap won't revert, but oracle-comparing agents should widen slippage tolerance`);
    if (spot_source === "chainlink") warnings.push("no_pool_price_available: quote fell back to Chainlink oracle; on-chain swap MAY revert if pool has drifted");
    if (one_side_usd > 0 && notional_usd / one_side_usd > 0.05) warnings.push(`heavy_trade: notional is ${(100 * notional_usd / one_side_usd).toFixed(1)}% of one-side depth — real slip will exceed the first-order xy=k figure`);
    // Surface V3 executability honestly — the user must not sign a swap
    // that will fail at prepare-time because the pool is V4.
    if (!route_executable && route_unavailable_reason) {
      warnings.push(`no_executable_route_v3_only: ${route_unavailable_reason}. Router runs Uniswap V3 only; if this token's liquidity is on a V4 pool, the swap cannot execute until Task #75 (V4 router) ships. Quote is spot-only.`);
    }

    return Response.json({
      tool: "rh-stock-swap-quote",
      ticker: token.ticker,
      name: token.name,
      contract: token.contract,
      side,
      denom_in: denomIn,
      amount_in: amount,
      amount_in_base_units: amountInBaseUnits,
      spot_usd,
      spot_source,
      pool_spot_usd,
      chainlink_spot_usd,
      pool_oracle_delta_pct,
      pool_deviates_from_oracle,
      expected_out,                         // pool-based expected, pre-impact
      expected_out_base_units: expected_out !== null
        ? BigInt(Math.max(0, Math.floor(expected_out * Math.pow(10, tokenOutDecimals)))).toString()
        : null,
      expected_after_impact,                // pool-based, after trade-impact
      min_out,                              // pool-based × (1-slippage) × (1-impact)
      min_out_base_units: minOutBaseUnits,
      slippage_bps: slippageBps,
      trade_impact_pct,                     // additional fill worsening from moving the pool
      one_side_usd_used: one_side_usd,      // depth used for the impact math
      pool_selection: primary.selection,
      warnings,
      route: {
        kind: route_kind,
        // `executable` is the honest "can prepare build V3 calldata" flag.
        // The panel should ONLY enable Sign when this is true. Before
        // the SNDK fix, kind === "direct" was based on GT (V3+V4); a V4
        // pool would show green quote → red prepare. Now: quote refuses
        // to say "direct" unless V3 factory actually returns a pool.
        executable: route_executable,
        unavailable_reason: route_unavailable_reason,
        note: !route_executable
          ? "Not executable: no V3 pool for this pair. Router runs V3 only — a V4 pool may exist but cannot be used yet (see Task #75)."
          : route_kind === "multi-hop"
            ? "No direct pool at the requested denom — X2 will build a WETH-hopped path (2 approves + 2 swaps)."
            : route_kind === "direct"
              ? "Direct V3 pool available at the requested denom."
              : "Cannot resolve a route at spot pricing — try WETH denom or verify token liquidity.",
        direct_pool_gt: directGt
          ? { address: directGt.address, name: directGt.name, dex: directGt.dex, fee_bps: directGt.fee_bps, tvl_usd: directGt.reserve_usd }
          : null,
        direct_pool_on_chain_weth: bestWethPool
          ? { address: bestWethPool.address, fee: bestWethPool.fee, liquidity: bestWethPool.liquidity }
          : null,
      },
      execution: {
        token_in: tokenIn,
        token_out: tokenOut,
        token_in_decimals: tokenInDecimals,
        token_out_decimals: tokenOutDecimals,
        router: ROBINHOOD_SWAP_ROUTER_ADDRESS,
        factory: ROBINHOOD_MAINNET_VERIFIED_FACTORY,
        deadline_unix: Math.floor(Date.now() / 1000) + deadlineMin * 60,
        deadline_minutes: deadlineMin,
      },
      chainlink: oracle,
      data_sources: [
        "on-chain RH V3 factory (getPool + liquidity)",
        "api.geckoterminal.com (RH Chain)",
        oracle ? "Chainlink AggregatorV3 (RH Chain)" : null,
      ].filter(Boolean),
      network: RH_CHAIN,
      timestamp,
    });
  } catch (e) {
    return Response.json({ error: "rh-stock-swap-quote failed", message: (e as Error).message }, { status: 500 });
  }
}
