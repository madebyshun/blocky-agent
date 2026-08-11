// x402/rh-usdg-route (B2) — cheapest USDG acquisition path.
// Price: $0.05
//
// USDG (Global Dollar) is native to Robinhood Chain (0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168).
// Depending on where the user's funds sit, the route is:
//   • Already on RH + holding WETH/native ETH → swap via V3 pool
//     (WETH/USDG has the deepest USDG liquidity on RH).
//   • Holding a different RH RWA → sell RWA → USDG (V4-only for USDG↔RWA
//     pairs; use Universal Router or wait for Task #98).
//   • Off-chain fiat / other chain → bridge to RH via canonical bridge
//     (see B1), then swap.
// This tool returns each viable path with a live spot quote where possible.

import { RH_CHAIN, findByTicker, RWA_TOKENS } from "@/lib/robinhood/rwa-registry";
import { poolsForToken } from "@/lib/robinhood/rwa-market";
import { findWethPools, bestPool } from "@/lib/robinhood/pool";
import { ROBINHOOD_MAINNET_VERIFIED_WETH9 } from "@/lib/robinhood/swap";

const USDG_ADDR = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as const;

export default async function handler(req: Request): Promise<Response> {
  try {
    let body: { from_asset?: string; amount?: number } = {};
    try { const t = await req.text(); if (t?.trim().startsWith("{")) body = JSON.parse(t); } catch {}
    const url = new URL(req.url);
    const fromAsset = ((body.from_asset ?? url.searchParams.get("from_asset") ?? "WETH") as string).toUpperCase();
    const amount = Math.max(0.0001, Number(body.amount ?? url.searchParams.get("amount") ?? 0.05));

    const timestamp = new Date().toISOString();

    // ── Path A: WETH → USDG via WETH pool ─────────────────────────────────
    let wethPath: unknown = null;
    if (fromAsset === "WETH" || fromAsset === "ETH") {
      // The USDG contract has WETH pools on GT.
      const gt = await poolsForToken(USDG_ADDR);
      const wethPool = gt.find((p) => p.base_token === ROBINHOOD_MAINNET_VERIFIED_WETH9.toLowerCase() || p.quote_token === ROBINHOOD_MAINNET_VERIFIED_WETH9.toLowerCase());
      const v3Pools = await findWethPools(USDG_ADDR).catch(() => []);
      const v3Deepest = bestPool(v3Pools);
      wethPath = {
        via: "WETH pool (RH V3 factory + GT confirmed)",
        expected_out_usdg: wethPool ? (amount * (wethPool.counterparty_usd ?? 0)) : null,
        v3_pool: v3Deepest ? { address: v3Deepest.address, fee: v3Deepest.fee, liquidity: v3Deepest.liquidity } : null,
        gt_pool: wethPool ? { address: wethPool.address, name: wethPool.name, tvl_usd: wethPool.reserve_usd, dex: wethPool.dex } : null,
        executable_via: v3Deepest ? "rh-stock-swap-prepare with denom=WETH" : "Universal Router (V4 pool)",
      };
    }

    // ── Path B: sell RWA → USDG ──────────────────────────────────────────
    // For any RH RWA in the registry, the deepest USDG-quoted pool is a
    // direct sell path. Most of these are V4 pools (executable via UR).
    let rwaPath: unknown = null;
    const rwaMatch = findByTicker(fromAsset);
    if (rwaMatch && rwaMatch.kind !== "stable" && rwaMatch.kind !== "wrapped") {
      const gt = await poolsForToken(rwaMatch.contract);
      const usdgPool = gt.find((p) => p.base_token === USDG_ADDR.toLowerCase() || p.quote_token === USDG_ADDR.toLowerCase());
      rwaPath = {
        via: `Sell ${rwaMatch.ticker} → USDG on deepest pool`,
        expected_out_usdg: usdgPool ? amount * usdgPool.price_usd : null,
        gt_pool: usdgPool ? { address: usdgPool.address, name: usdgPool.name, tvl_usd: usdgPool.reserve_usd, dex: usdgPool.dex } : null,
        executable_via: usdgPool?.dex.includes("v4") ? "Universal Router (V4 pool) — Task #98 for direct integration" : "rh-stock-swap-prepare",
      };
    }

    // ── Path C: bridge to RH first ───────────────────────────────────────
    const bridgePath = {
      via: "Bridge to Robinhood Chain, then swap to USDG",
      steps: [
        "Use rh-bridge-route (B1) for canonical or third-party bridge",
        "Swap using WETH → USDG via V3 pool once funds land",
      ],
    };

    return Response.json({
      tool: "rh-usdg-route",
      from_asset: fromAsset,
      amount,
      paths: {
        weth_to_usdg: wethPath,
        rwa_to_usdg:  rwaPath,
        bridge_first: bridgePath,
      },
      registry_tickers_swappable_to_usdg: RWA_TOKENS
        .filter((t) => t.kind === "stock" || t.kind === "etf")
        .map((t) => t.ticker),
      note: "USDG is native to Robinhood Chain. Cheapest live path depends on where funds currently sit. Live quote via rh-stock-swap-quote for the specific pair.",
      data_sources: ["on-chain RH V3 factory", "api.geckoterminal.com (RH Chain)"],
      network: RH_CHAIN,
      timestamp,
    });
  } catch (e) {
    return Response.json({ error: "rh-usdg-route failed", message: (e as Error).message }, { status: 500 });
  }
}
