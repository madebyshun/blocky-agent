import { NextRequest, NextResponse } from "next/server";
import { findWethPools, bestPool } from "@/lib/robinhood/pool";

// GET /api/robinhood/swap/quote?token=0x…&direction=buy|sell&amount=<decimal>
//
// Server-side route that answers "for this token, what pool should we route
// through and roughly how much do I get out?" — used by RobinhoodSwapCard in
// chat. (It also backed the Robinhood Trade modal on /app/launches until that
// page went out with the Bankr launch/fee surface on 2026-09-07; the chat card
// is the live caller now.) Non-custodial: no keys, no signing, just:
//   1. Probe every Uniswap V3 fee tier via factory.getPool() + liquidity read
//      to find the deepest pool (or return `no_pool` if none exists yet).
//   2. Ask GeckoTerminal for the token's live USD + WETH-relative price and
//      compute a rough amountOut *estimate* from it.
//
// The estimate is display-only. The real amount is settled by the router
// on-chain at swap time and bounded by the caller's `amountOutMinimum` — the
// server never touches funds and can't misprice anything downstream.
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const token = searchParams.get("token") ?? "";
    const direction = (searchParams.get("direction") ?? "buy") as "buy" | "sell";
    const amountStr = searchParams.get("amount") ?? "";

    if (!/^0x[a-fA-F0-9]{40}$/.test(token)) {
      return NextResponse.json({ error: "valid token address required" }, { status: 400 });
    }
    if (direction !== "buy" && direction !== "sell") {
      return NextResponse.json({ error: "direction must be buy or sell" }, { status: 400 });
    }
    const amount = parseFloat(amountStr);
    if (!Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json({ error: "amount must be a positive number" }, { status: 400 });
    }

    // (1) Pool discovery — on-chain reads via the verified factory.
    const pools = await findWethPools(token as `0x${string}`);
    const pool = bestPool(pools);
    if (!pool) {
      return NextResponse.json({
        ok: true,
        hasPool: false,
        note: "No Uniswap V3 WETH pool exists for this token on Robinhood Chain yet.",
      });
    }

    // (2) Price — GeckoTerminal has a real feed of Robinhood Chain pool prices.
    // We fetch the token's own price rather than pool math because computing
    // amountOut from slot0 + liquidity needs the full tickmap for anything but
    // trivial sizes, and GeckoTerminal already indexes this chain live.
    let priceUsd: number | null = null;
    let ethPriceUsd: number | null = null;
    try {
      const [tokenRes, ethRes] = await Promise.all([
        fetch(
          `https://api.geckoterminal.com/api/v2/networks/robinhood/tokens/${token}`,
          { headers: { Accept: "application/json" }, cache: "no-store" },
        ),
        fetch(
          "https://api.geckoterminal.com/api/v2/networks/robinhood/tokens/0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
          { headers: { Accept: "application/json" }, cache: "no-store" },
        ),
      ]);
      if (tokenRes.ok) {
        const tj = await tokenRes.json();
        const p = tj?.data?.attributes?.price_usd;
        if (p) priceUsd = parseFloat(p);
      }
      if (ethRes.ok) {
        const ej = await ethRes.json();
        const p = ej?.data?.attributes?.price_usd;
        if (p) ethPriceUsd = parseFloat(p);
      }
    } catch {
      // Fall through — return the pool without an estimate.
    }

    // (3) Estimate — honest label: `estimated_out` may be null.
    let estimatedOut: number | null = null;
    if (priceUsd && ethPriceUsd) {
      if (direction === "buy") {
        // amount is ETH in → USD in → token out at token's price.
        estimatedOut = (amount * ethPriceUsd) / priceUsd;
      } else {
        // amount is token in → USD → ETH out.
        estimatedOut = (amount * priceUsd) / ethPriceUsd;
      }
    }

    return NextResponse.json({
      ok: true,
      hasPool: true,
      pool: {
        address: pool.address,
        fee: pool.fee,
        liquidity: pool.liquidity,
        token0: pool.token0,
        token1: pool.token1,
      },
      allPools: pools.map((p) => ({ fee: p.fee, address: p.address, liquidity: p.liquidity })),
      price: {
        tokenUsd: priceUsd,
        ethUsd: ethPriceUsd,
      },
      estimate: {
        amountIn: amount,
        direction,
        // Display-only — settled on-chain by the router with the caller's own
        // amountOutMinimum slippage floor, never trusted for value transfer.
        amountOut: estimatedOut,
      },
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
