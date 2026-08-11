// x402/rh-rwa-dca (A1) — recurring buy plan for a RH RWA token.
// Price: $0.20
//
// Composes rh-stock-swap-prepare + a cadence into a DCA config. Optionally
// persists to KV so a downstream cron/session-key worker (see Task #92
// blue_dca) can execute each buy on schedule.
//
// This tool is non-custodial: it returns a JSON plan + the first-tx
// unsigned calldata (via the same math as X2). Actual execution requires
// the caller's own wallet or a session-key delegation — never routed
// through this endpoint's server keys.

import { getAddress, isAddress } from "viem";
import { findByTicker, RH_CHAIN, RH_CHAINLINK_ETH_USD } from "@/lib/robinhood/rwa-registry";
import { chainlinkLatest } from "@/lib/robinhood/rwa-price";
import { poolsForToken, resolvePrimaryPool } from "@/lib/robinhood/rwa-market";
import {
  buildTokenToTokenSwapCalldata,
  ROBINHOOD_MAINNET_VERIFIED_WETH9,
  ROBINHOOD_SWAP_ROUTER_ADDRESS,
} from "@/lib/robinhood/swap";
import { kv } from "@vercel/kv";

const USDG_ADDR = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as const;
type Cadence = "hour" | "day" | "week";

const CADENCE_SECONDS: Record<Cadence, number> = {
  hour: 3600,
  day: 86400,
  week: 604800,
};

export default async function handler(req: Request): Promise<Response> {
  try {
    let body: {
      wallet?: string;
      ticker?: string;
      amount_usd?: number;
      cadence?: string;      // hour | day | week
      denom?: string;         // USDG | WETH
      total_periods?: number; // how many recurrences before schedule ends
      slippage_bps?: number;
      persist?: boolean;      // opt-in KV registration for the cron worker
    } = {};
    try { const t = await req.text(); if (t?.trim().startsWith("{")) body = JSON.parse(t); } catch {}
    const url = new URL(req.url);

    const walletRaw = (body.wallet ?? url.searchParams.get("wallet") ?? "").trim();
    const ticker    = (body.ticker ?? url.searchParams.get("ticker") ?? "").trim();
    const amountUsd = Number(body.amount_usd ?? url.searchParams.get("amount_usd") ?? 0);
    const cadenceRaw = ((body.cadence ?? url.searchParams.get("cadence") ?? "week") as string).toLowerCase();
    const cadence  = (["hour","day","week"].includes(cadenceRaw) ? cadenceRaw : "week") as Cadence;
    const denom    = ((body.denom ?? url.searchParams.get("denom") ?? "USDG") as string).toUpperCase();
    const totalPeriods = Math.max(1, Math.min(365, Number(body.total_periods ?? url.searchParams.get("total_periods") ?? 12)));
    const slippageBps  = Math.max(1, Math.min(5000, Number(body.slippage_bps ?? url.searchParams.get("slippage_bps") ?? 100)));
    const persist = body.persist === true;

    if (!isAddress(walletRaw)) return Response.json({ error: "Provide `wallet` (0x address)." }, { status: 400 });
    if (!ticker || amountUsd <= 0) return Response.json({ error: "Provide `ticker` and `amount_usd` > 0." }, { status: 400 });
    if (denom !== "USDG" && denom !== "WETH") return Response.json({ error: "`denom` must be USDG or WETH." }, { status: 400 });

    const wallet = getAddress(walletRaw);
    const token = findByTicker(ticker);
    if (!token) return Response.json({ tool: "rh-rwa-dca", ticker, error: "Ticker not in registry." }, { status: 404 });
    if (!ROBINHOOD_SWAP_ROUTER_ADDRESS) {
      return Response.json({ error: "RobinhoodSwapRouter not configured." }, { status: 500 });
    }

    const timestamp = new Date().toISOString();
    const nowUnix = Math.floor(Date.now() / 1000);

    // ── Same quote math as X2 so plan preview matches an eventual execution ─
    const quoteAddr = denom === "USDG" ? USDG_ADDR : ROBINHOOD_MAINNET_VERIFIED_WETH9;
    const quoteDecimals = denom === "USDG" ? 6 : 18;
    const tokenIn = quoteAddr;
    const tokenOut = token.contract;
    // Pool-based quote (fix: previously used Chainlink → per-period min_out
    // would revert on-chain whenever pool deviates from oracle > user slippage).
    const [oracle, gtPools, primary] = await Promise.all([
      token.chainlinkFeed ? chainlinkLatest(token.chainlinkFeed, token.chainlinkHeartbeat ?? 86400) : Promise.resolve(null),
      poolsForToken(token.contract),
      resolvePrimaryPool(token.contract, { preferUsdgQuote: denom === "USDG" }),
    ]);
    const pool_spot_usd = primary.pool?.price_usd ?? gtPools[0]?.price_usd ?? null;
    const chainlink_spot_usd = oracle && !oracle.is_stale ? oracle.price_usd : null;
    const spot_usd = pool_spot_usd ?? chainlink_spot_usd;
    const pool_oracle_delta_pct = (pool_spot_usd !== null && chainlink_spot_usd !== null && chainlink_spot_usd > 0)
      ? +(((pool_spot_usd - chainlink_spot_usd) / chainlink_spot_usd) * 100).toFixed(4)
      : null;

    let expected_out: number | null = null;
    let amountInHuman = amountUsd; // USDG denom: amountUsd IS the amount
    if (spot_usd !== null) {
      if (denom === "USDG") {
        expected_out = amountUsd / spot_usd;
      } else {
        const ethQuote = await chainlinkLatest(RH_CHAINLINK_ETH_USD, 86400);
        const weth_usd = ethQuote?.price_usd ?? null;
        if (weth_usd) {
          amountInHuman = amountUsd / weth_usd;
          expected_out = (amountInHuman * weth_usd) / spot_usd;
        }
      }
    }

    // Include trade-impact so cron-executed periods don't revert either.
    const one_side_usd = primary.pool?.one_side_usd ?? ((gtPools[0]?.reserve_usd ?? 0) / 2);
    const trade_impact_pct = (one_side_usd > 0 && amountUsd > 0) ? (100 * amountUsd / (one_side_usd + amountUsd)) : 0;
    const expected_after_impact = expected_out !== null ? expected_out * (1 - trade_impact_pct / 100) : null;
    const min_out = expected_after_impact !== null ? expected_after_impact * (1 - slippageBps / 10000) : null;
    const amountIn = BigInt(Math.round(amountInHuman * Math.pow(10, quoteDecimals)));
    const amountOutMinimum = min_out !== null ? BigInt(Math.max(0, Math.floor(min_out * Math.pow(10, token.decimals)))) : 0n;
    const deadline = BigInt(nowUnix + 300);

    // Build first-run tx calldata (V3-only; V4-only pairs return null with note).
    const built = await buildTokenToTokenSwapCalldata({
      router: ROBINHOOD_SWAP_ROUTER_ADDRESS,
      tokenIn: tokenIn as `0x${string}`,
      tokenOut: tokenOut as `0x${string}`,
      amountIn, amountOutMinimum,
      recipient: wallet as `0x${string}`,
      deadline,
    });

    const scheduleId = `rh-dca:${wallet.toLowerCase()}:${token.ticker.toLowerCase()}:${cadence}`;
    const nextRun = nowUnix + CADENCE_SECONDS[cadence];
    const scheduleConfig = {
      id: scheduleId,
      wallet,
      ticker: token.ticker,
      contract: token.contract,
      denom,
      amount_usd_per_period: amountUsd,
      cadence,
      cadence_seconds: CADENCE_SECONDS[cadence],
      total_periods: totalPeriods,
      periods_remaining: totalPeriods,
      next_run_unix: nextRun,
      slippage_bps: slippageBps,
      created_at_unix: nowUnix,
    };

    let persisted = false;
    if (persist) {
      try {
        await kv.set(scheduleId, scheduleConfig, { ex: CADENCE_SECONDS[cadence] * totalPeriods + 86400 });
        persisted = true;
      } catch (e) {
        console.warn("[rh-rwa-dca] KV persist failed:", (e as Error).message);
      }
    }

    const warnings: string[] = [];
    if (pool_oracle_delta_pct !== null && Math.abs(pool_oracle_delta_pct) > 1) {
      warnings.push(`pool_deviates_from_oracle: ${pool_oracle_delta_pct}% — per-period min_out is set from POOL basis so cron won't revert on that account`);
    }
    // Reviewer honesty rule: if persist=false, the response looks like a
    // "registered schedule" but nothing will run. Label the response so a
    // downstream agent doesn't tell the user their DCA is active.
    const mode = persisted ? "registered_kv" : "preview_only";

    return Response.json({
      tool: "rh-rwa-dca",
      mode,
      wallet,
      ticker: token.ticker,
      name: token.name,
      schedule: scheduleConfig,
      quote_preview: {
        spot_usd,
        pool_spot_usd,
        chainlink_spot_usd,
        pool_oracle_delta_pct,
        expected_out_per_period: expected_out,
        expected_after_impact_per_period: expected_after_impact,
        min_out_per_period: min_out,
        trade_impact_pct,
        one_side_usd_used: one_side_usd,
        estimated_total_over_schedule: expected_out !== null ? expected_out * totalPeriods : null,
      },
      first_run: {
        route: built.route,
        route_reason: built.reason ?? null,
        call_count: built.calls?.length ?? 0,
        calls: (built.calls ?? []).map((c) => ({ kind: c.kind, to: c.to, data: c.data, value: c.value, pool: c.pool ?? null })),
      },
      persisted,
      persist_note: persist && !persisted ? "KV registration failed — schedule returned only, not stored." : null,
      warnings,
      note: mode === "preview_only"
        ? "MODE preview_only: this response is a PLAN, not an active DCA. Nothing will run automatically. Pass `persist: true` to register in KV, and see Task #92 for the cron worker that reads the KV registration."
        : !built.route
          ? "First-run path unroutable via V3 today (RH RWA liquidity mostly V4). Try `denom: WETH`, or wait for the V4 execution tool (Task #98)."
          : "Registered in KV. First-run calldata attached. Task #92's cron will consume the schedule and sign each period via Blue Session key.",
      data_sources: ["Chainlink AggregatorV3 (RH Chain)", "on-chain RH V3 factory", persisted ? "@vercel/kv" : null].filter(Boolean),
      network: RH_CHAIN,
      timestamp,
    });
  } catch (e) {
    return Response.json({ error: "rh-rwa-dca failed", message: (e as Error).message }, { status: 500 });
  }
}
