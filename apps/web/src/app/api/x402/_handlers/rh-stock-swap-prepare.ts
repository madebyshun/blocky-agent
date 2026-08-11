// x402/rh-stock-swap-prepare (X2) — unsigned tx calldata for a RH stock swap.
// Price: $0.05
//
// Given a ticker + side + amount + slippage + recipient, returns the full
// call sequence the client must sign in order:
//   [approve(tokenIn, router, amountIn), swap(...)]  — for a direct route
//   [approve tokenIn, swap leg1 tokenIn→WETH, approve WETH, swap leg2 WETH→tokenOut]  — for multi-hop
//
// Non-custodial: this tool never signs or holds funds. It only encodes the
// bytes; the client's wallet signs and broadcasts. Router address is the
// verified live RobinhoodSwapRouter (see lib/robinhood/swap.ts).
//
// Requires `recipient` (0x…) so the swap output lands in the right wallet.

import { findByTicker, RH_CHAIN, RH_CHAINLINK_ETH_USD } from "@/lib/robinhood/rwa-registry";
import { chainlinkLatest } from "@/lib/robinhood/rwa-price";
import { poolsForToken, resolvePrimaryPool } from "@/lib/robinhood/rwa-market";
import {
  buildTokenToTokenSwapCalldata,
  ROBINHOOD_MAINNET_VERIFIED_WETH9,
  ROBINHOOD_SWAP_ROUTER_ADDRESS,
} from "@/lib/robinhood/swap";

const USDG_ADDR = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as const;

export default async function handler(req: Request): Promise<Response> {
  try {
    let body: {
      ticker?: string;
      side?: string;
      amount?: string | number;
      denom?: string;
      slippage_bps?: number;
      recipient?: string;
      deadline_minutes?: number;
    } = {};
    try { const t = await req.text(); if (t?.trim().startsWith("{")) body = JSON.parse(t); } catch {}
    const url = new URL(req.url);

    const ticker    = (body.ticker ?? url.searchParams.get("ticker") ?? "").trim();
    const side      = ((body.side ?? url.searchParams.get("side") ?? "buy") as string).toLowerCase();
    const denomIn   = ((body.denom ?? url.searchParams.get("denom") ?? "USDG") as string).toUpperCase();
    const slippageBps = Math.max(1, Math.min(5000, Number(body.slippage_bps ?? url.searchParams.get("slippage_bps") ?? 100)));
    const recipient = (body.recipient ?? url.searchParams.get("recipient") ?? "").trim();
    const deadlineMin = Math.max(1, Math.min(60, Number(body.deadline_minutes ?? url.searchParams.get("deadline_minutes") ?? 5)));
    const amountStr = String(body.amount ?? url.searchParams.get("amount") ?? "").trim();

    if (!ticker || !amountStr || !recipient) {
      return Response.json({ error: "Provide `ticker`, `amount`, and `recipient`." }, { status: 400 });
    }
    if (side !== "buy" && side !== "sell") {
      return Response.json({ error: "`side` must be `buy` or `sell`." }, { status: 400 });
    }
    if (denomIn !== "USDG" && denomIn !== "WETH") {
      return Response.json({ error: "`denom` must be `USDG` or `WETH`." }, { status: 400 });
    }
    if (!/^0x[a-fA-F0-9]{40}$/.test(recipient)) {
      return Response.json({ error: "`recipient` must be a valid 0x address." }, { status: 400 });
    }
    if (!ROBINHOOD_SWAP_ROUTER_ADDRESS) {
      return Response.json({ error: "RobinhoodSwapRouter not deployed / configured." }, { status: 500 });
    }

    const amount = parseFloat(amountStr);
    if (!Number.isFinite(amount) || amount <= 0) {
      return Response.json({ error: "`amount` must be a positive number." }, { status: 400 });
    }

    const token = findByTicker(ticker);
    if (!token) return Response.json({ tool: "rh-stock-swap-prepare", ticker, error: "Ticker not in registry." }, { status: 404 });

    const timestamp = new Date().toISOString();

    const quoteAddr = denomIn === "USDG" ? USDG_ADDR : ROBINHOOD_MAINNET_VERIFIED_WETH9;
    const quoteDecimals = denomIn === "USDG" ? 6 : 18;
    const tokenIn         = (side === "buy") ? quoteAddr : token.contract;
    const tokenOut        = (side === "buy") ? token.contract : quoteAddr;
    const tokenInDecimals = (side === "buy") ? quoteDecimals : token.decimals;
    const tokenOutDecimals= (side === "buy") ? token.decimals : quoteDecimals;

    // ── QUOTE MUST come from the pool that will EXECUTE the swap ─────────
    // Previously used Chainlink oracle → min_out set against a price the
    // pool doesn't trade at → V3/V4 swap reverts. Fix: pool spot is
    // authoritative; oracle is a cross-check that emits a warning when it
    // deviates so callers can widen slippage before signing.
    const [oracle, gtPools, primary] = await Promise.all([
      token.chainlinkFeed
        ? chainlinkLatest(token.chainlinkFeed, token.chainlinkHeartbeat ?? 86400)
        : Promise.resolve(null),
      poolsForToken(token.contract),
      resolvePrimaryPool(token.contract, { preferUsdgQuote: denomIn === "USDG" }),
    ]);
    const pool_spot_usd = primary.pool?.price_usd ?? gtPools[0]?.price_usd ?? null;
    const chainlink_spot_usd = oracle && !oracle.is_stale ? oracle.price_usd : null;
    const spot_usd = pool_spot_usd ?? chainlink_spot_usd;
    const spot_source: "pool" | "chainlink" | null =
      pool_spot_usd !== null ? "pool" : (chainlink_spot_usd !== null ? "chainlink" : null);
    const pool_oracle_delta_pct = (pool_spot_usd !== null && chainlink_spot_usd !== null && chainlink_spot_usd > 0)
      ? +(((pool_spot_usd - chainlink_spot_usd) / chainlink_spot_usd) * 100).toFixed(4)
      : null;
    const pool_deviates_from_oracle = pool_oracle_delta_pct !== null && Math.abs(pool_oracle_delta_pct) > 1;

    let expected_out: number | null = null;
    if (spot_usd !== null) {
      if (denomIn === "USDG") {
        expected_out = side === "buy" ? amount / spot_usd : amount * spot_usd;
      } else {
        const ethQuote = await chainlinkLatest(RH_CHAINLINK_ETH_USD, 86400);
        let weth_usd: number | null = ethQuote?.price_usd ?? null;
        if (!weth_usd) {
          const wethPool = gtPools.find((p) => p.base_token === ROBINHOOD_MAINNET_VERIFIED_WETH9.toLowerCase() || p.quote_token === ROBINHOOD_MAINNET_VERIFIED_WETH9.toLowerCase());
          weth_usd = wethPool?.counterparty_token_price_usd ?? wethPool?.price_usd ?? null;
        }
        if (weth_usd) {
          expected_out = side === "buy" ? (amount * weth_usd) / spot_usd : (amount * spot_usd) / weth_usd;
        }
      }
    }

    if (expected_out === null) {
      return Response.json({
        tool: "rh-stock-swap-prepare",
        ticker: token.ticker,
        error: "Cannot compute an expected_out at this time (no pool spot + no oracle).",
        network: RH_CHAIN,
        timestamp,
      }, { status: 502 });
    }

    // Additional slip from trade impact on the actual pool (xy=k first-order).
    const one_side_usd = primary.pool?.one_side_usd ?? ((gtPools[0]?.reserve_usd ?? 0) / 2);
    const notional_usd = denomIn === "USDG"
      ? (side === "buy" ? amount : expected_out)
      : (expected_out * (spot_usd ?? 0));
    const trade_impact_pct = (one_side_usd > 0 && notional_usd > 0) ? (100 * notional_usd / (one_side_usd + notional_usd)) : 0;

    // min_out = pool_expected × (1 − user_slippage) × (1 − trade_impact)
    const expected_after_impact = expected_out * (1 - trade_impact_pct / 100);
    const min_out = expected_after_impact * (1 - slippageBps / 10000);
    const amountIn = BigInt(Math.round(amount * Math.pow(10, tokenInDecimals)));
    const amountOutMinimum = BigInt(Math.max(0, Math.floor(min_out * Math.pow(10, tokenOutDecimals))));
    const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineMin * 60);

    const warnings: string[] = [];
    if (pool_deviates_from_oracle) warnings.push(`pool_deviates_from_oracle: pool spot ${pool_oracle_delta_pct}% off Chainlink — min_out is set from the POOL basis so the swap won't revert on that account`);
    if (spot_source === "chainlink") warnings.push("no_pool_price_available: fell back to oracle for quote — on-chain swap MAY revert if pool has drifted from oracle. Prefer denom: WETH.");
    if (one_side_usd > 0 && notional_usd / one_side_usd > 0.05) warnings.push(`heavy_trade: notional is ${(100 * notional_usd / one_side_usd).toFixed(1)}% of one-side depth — real slip may exceed the first-order figure`);

    const built = await buildTokenToTokenSwapCalldata({
      router: ROBINHOOD_SWAP_ROUTER_ADDRESS,
      tokenIn: tokenIn as `0x${string}`,
      tokenOut: tokenOut as `0x${string}`,
      amountIn,
      amountOutMinimum,
      recipient: recipient as `0x${string}`,
      deadline,
    });

    if (!built.route) {
      // Surface V4 pools we do see — the honest answer is often "no V3 route
      // because the RWA liquidity lives in Uniswap V4 pools this router can't
      // execute against yet". Callers know exactly why and can pivot.
      const denomAddrLower = quoteAddr.toLowerCase();
      const v4 = gtPools.filter(
        (p) =>
          p.dex.includes("v4") &&
          (p.base_token === denomAddrLower || p.quote_token === denomAddrLower),
      );
      return Response.json({
        tool: "rh-stock-swap-prepare",
        ticker: token.ticker,
        error: `Cannot build a route: ${built.reason ?? "no route"}.`,
        route: null,
        v4_pools_detected: v4.map((p) => ({
          address: p.address,
          name: p.name,
          dex: p.dex,
          tvl_usd: p.reserve_usd,
        })),
        v4_note: v4.length
          ? "V4 pool(s) exist for this pair, but the verified V3 router can't execute against them. Use the Uniswap Universal Router or wait for the V4 tool (Task #98). Try `denom: WETH` for a V3-only path if you just want to swap."
          : null,
        quote: { spot_usd, expected_out, min_out },
        network: RH_CHAIN,
        timestamp,
      }, { status: 404 });
    }

    return Response.json({
      tool: "rh-stock-swap-prepare",
      ticker: token.ticker,
      name: token.name,
      side,
      denom_in: denomIn,
      recipient,
      quote: {
        spot_usd,                    // pool spot when available; oracle only when no pool
        spot_source,
        pool_spot_usd,
        chainlink_spot_usd,
        pool_oracle_delta_pct,
        pool_deviates_from_oracle,
        expected_out,                // pool-basis, pre-impact
        expected_after_impact,       // after moving the pool
        min_out,                     // × (1 − slippage) × (1 − impact)
        trade_impact_pct,
        one_side_usd_used: one_side_usd,
        slippage_bps: slippageBps,
        pool_selection: primary.selection,
        amount_in_base_units: amountIn.toString(),
        amount_out_minimum_base_units: amountOutMinimum.toString(),
      },
      warnings,
      route: {
        kind: built.route,   // "direct" | "multi-hop"
        call_count: built.calls?.length ?? 0,
      },
      // Serializable-for-JSON view of the tx sequence. `value` is hex wei.
      calls: (built.calls ?? []).map((c) => ({
        kind: c.kind,
        to: c.to,
        data: c.data,
        value: c.value,
        leg: c.leg ?? null,
        pool: c.pool ? { address: c.pool.address, fee: c.pool.fee } : null,
      })),
      deadline_unix: Number(deadline),
      notes: [
        "Non-custodial: this endpoint only encodes calldata. Client's own wallet signs and broadcasts.",
        built.route === "multi-hop"
          ? "Multi-hop path: sign 4 txs in order (approve · leg1 · approve · leg2). After leg 1 confirms, the client MUST rebuild leg 2's `amountIn` from its actual WETH balance — the returned amountIn is a MAX_UINT256 placeholder."
          : "Direct path: sign 2 txs in order (approve · swap).",
      ],
      network: RH_CHAIN,
      timestamp,
    });
  } catch (e) {
    return Response.json({ error: "rh-stock-swap-prepare failed", message: (e as Error).message }, { status: 500 });
  }
}
