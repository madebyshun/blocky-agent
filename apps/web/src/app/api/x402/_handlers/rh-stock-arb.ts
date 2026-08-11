// x402/rh-stock-arb (M5) — Chainlink vs DEX arbitrage delta.
// Price: $0.05
//
// For a given RH RWA ticker, reads:
//   • Chainlink AggregatorV3 latestRoundData (oracle-truth price)
//   • Deepest DEX pool spot on RH Chain (executable price)
// and returns the delta in absolute and percentage terms, plus a directional
// verdict (LONG_DEX, SHORT_DEX, ALIGNED).
//
// This is a real trading signal, not an LLM opinion. The verdict is derived
// deterministically from the numeric delta.

import { findByTicker, RH_CHAIN } from "@/lib/robinhood/rwa-registry";
import { chainlinkLatest } from "@/lib/robinhood/rwa-price";
import { resolvePrimaryPool, nyseMarketStatus } from "@/lib/robinhood/rwa-market";

// Base drift threshold below which we call the pair aligned. During
// regular NYSE hours a fresh feed means a real arb; when the market is
// closed Chainlink freezes on the last print while the DEX keeps trading,
// so we widen the alignment band and flip the verdict prefix to
// "PREMARKET_DRIFT" / "AFTERHOURS_DRIFT" instead of "LONG_DEX" /
// "SHORT_DEX" (see Task #79 / product note in the reviewer feedback).
const ALIGNED_PCT_INHOURS = 0.5;
const ALIGNED_PCT_CLOSED  = 1.5;
// Anything past this while market is OPEN is a legit price-discovery gap.
const FEED_FRESH_MAX_AGE_INHOURS_SECONDS = 15 * 60;

export default async function handler(req: Request): Promise<Response> {
  try {
    let body: { ticker?: string } = {};
    try { const t = await req.text(); if (t?.trim().startsWith("{")) body = JSON.parse(t); } catch {}
    const url = new URL(req.url);
    const ticker = (body.ticker ?? url.searchParams.get("ticker") ?? "").trim();
    if (!ticker) return Response.json({ error: "Provide `ticker` (e.g. MSTR, AAPL)." }, { status: 400 });

    const token = findByTicker(ticker);
    if (!token) return Response.json({ tool: "rh-stock-arb", ticker, error: "Ticker not in registry." }, { status: 404 });

    const timestamp = new Date().toISOString();
    const market = nyseMarketStatus();

    const [chainlink, primary] = await Promise.all([
      token.chainlinkFeed
        ? chainlinkLatest(token.chainlinkFeed, token.chainlinkHeartbeat ?? 86400)
        : Promise.resolve(null),
      resolvePrimaryPool(token.contract),
    ]);

    const dex = primary.pool;

    // Cannot arb without both sources — return honest INSUFFICIENT_DATA.
    if (!chainlink || !dex) {
      return Response.json({
        tool: "rh-stock-arb",
        ticker: token.ticker,
        name: token.name,
        contract: token.contract,
        verdict: "INSUFFICIENT_DATA",
        chainlink: chainlink ?? null,
        dex: dex ?? null,
        market,
        note: !chainlink && !dex
          ? "Neither Chainlink feed nor a DEX pool available for this ticker."
          : !chainlink
            ? "No Chainlink feed available for this ticker."
            : "No DEX pool found for this token on Robinhood Chain.",
        data_sources: [
          chainlink ? "Chainlink AggregatorV3 on-chain (RH Chain)" : null,
          dex ? "api.geckoterminal.com (RH Chain)" : null,
        ].filter(Boolean),
        network: RH_CHAIN,
        timestamp,
      });
    }

    const cl = chainlink.price_usd;
    const dx = dex.price_usd;
    const abs_delta = dx - cl;
    const pct_delta = (abs_delta / cl) * 100;

    // Verdict — hard-mapped from sign + magnitude + market hours. Two modes:
    //   • arb (market OPEN):    LONG_DEX / SHORT_DEX / ALIGNED
    //   • drift (market CLOSED): PREMARKET_DRIFT / AFTERHOURS_DRIFT / FROZEN_ALIGNED
    // Same numeric delta means very different things depending on whether
    // Wall Street is tickering — a downstream agent MUST see that context.
    const alignedThreshold = market.is_open ? ALIGNED_PCT_INHOURS : ALIGNED_PCT_CLOSED;
    let verdict:
      | "ALIGNED" | "LONG_DEX" | "SHORT_DEX"
      | "FROZEN_ALIGNED" | "PREMARKET_DRIFT" | "AFTERHOURS_DRIFT";
    if (market.is_open) {
      if (Math.abs(pct_delta) < alignedThreshold) verdict = "ALIGNED";
      else if (pct_delta < 0) verdict = "LONG_DEX";
      else verdict = "SHORT_DEX";
    } else {
      if (Math.abs(pct_delta) < alignedThreshold) verdict = "FROZEN_ALIGNED";
      else if (market.session === "premarket")   verdict = "PREMARKET_DRIFT";
      else                                       verdict = "AFTERHOURS_DRIFT";
    }

    // Feed-freshness sanity: during REGULAR hours a Chainlink stock feed
    // should have updated in the last ~15 min. Older == abnormal (and
    // downgrades any verdict's confidence).
    const feed_abnormal_stale = market.is_open && chainlink.age_seconds > FEED_FRESH_MAX_AGE_INHOURS_SECONDS;

    // Warnings: `thin_dex_pool` now considers TOTAL token liquidity (all
    // pools summed), not just the primary pool. Otherwise a $21M
    // bankr-robinhood WETH pool + a $850k USDG pool would trigger a
    // dust warning when the token is objectively deep — that would blind
    // downstream consumers (and Blue Hood's dust gate) to real depth.
    const warnings: string[] = [];
    if (!market.is_open) warnings.push(`market_closed_session_${market.session}: Chainlink is frozen on the last regular-hours print; DEX keeps trading 24/7. Verdict reflects post-close drift, NOT arb.`);
    if (feed_abnormal_stale) warnings.push(`feed_abnormally_stale: Chainlink last updated ${chainlink.age_seconds}s ago while market is OPEN — expected <${FEED_FRESH_MAX_AGE_INHOURS_SECONDS}s. Treat verdict as low-confidence.`);
    if (primary.total_tvl_usd < 5_000) warnings.push(`thin_dex_pool: only $${primary.total_tvl_usd.toFixed(0)} TVL across all ${primary.pool_count} pool(s) — spot may be dominated by a single trade.`);

    return Response.json({
      tool: "rh-stock-arb",
      ticker: token.ticker,
      name: token.name,
      contract: token.contract,
      verdict,
      market,
      delta: {
        abs_usd: +abs_delta.toFixed(6),
        pct: +pct_delta.toFixed(4),
        aligned_threshold_pct: alignedThreshold,
      },
      chainlink,
      dex: {
        pool_ref: dex.pool_ref,
        is_v4_pool_id: dex.is_v4_pool_id,
        pool_name: dex.name,
        dex_id: dex.dex,
        price_usd: dex.price_usd,
        // `tvl_usd` = deprecated alias for `primary_pool_tvl_usd`. Kept
        // for back-compat with agents/tools that already consume it. New
        // consumers should read `primary_pool_tvl_usd` and `total_tvl_usd`
        // explicitly — the naming makes the semantics unambiguous.
        tvl_usd: dex.reserve_usd,
        primary_pool_tvl_usd: dex.reserve_usd,
        total_tvl_usd: primary.total_tvl_usd,
        pool_count: primary.pool_count,
        one_side_usd: dex.one_side_usd,
        volume_24h_usd: dex.volume_24h_usd,
        change_24h_pct: dex.change_24h,
        pool_url: dex.url,
        pool_selection: primary.selection,
      },
      warnings,
      data_sources: [
        "Chainlink AggregatorV3 on-chain (RH Chain)",
        "api.geckoterminal.com (RH Chain)",
      ],
      network: RH_CHAIN,
      timestamp,
    });
  } catch (e) {
    return Response.json({ error: "rh-stock-arb failed", message: (e as Error).message }, { status: 500 });
  }
}
