/**
 * Blue Hood — Base desk poll (Base P3).
 *
 * The Robinhood poller (`blue-hood/poller.ts`) owns the RH watchlist, the
 * permanent series archive, and every snapshot KV write. This module is
 * deliberately SMALLER and side-effect-free: it only produces `TickerSnapshot`
 * rows for the verified Coinbase B20 stocks in `registry.ts::BASE_STOCKS`
 * (NVDA / META / GOOGL / AAPL today — read the registry, never hardcode the
 * list) so the chain-agnostic rule engine can grade Base drift/arb alongside RH.
 *
 * ⚠️ IT DOES NOT PERSIST SNAPSHOTS OR TOUCH THE SERIES ARCHIVE. Base rows are
 * merged into the engine's in-memory snapshot only. The permanent series is
 * keyed by bare `ticker`, and NVDA/META/GOOGL/AAPL exist on BOTH chains — writing a
 * Base "NVDA" row into that no-TTL, no-backfill archive would corrupt the RH
 * "NVDA" history irreversibly. So Base stays out of `persistSnapshot`/series by
 * construction; the dedup/cooldown/grader keys are chain-qualified instead
 * (see `kv-keys.ts::chainSeg`, `rule-engine.ts::fireArrow`, `grader.ts`).
 *
 * ── Mapping contract (mirror of `poller.ts::pollOne`, sourced from
 *    `readBaseStockQuote` instead of the rh-stock-arb M5 tool) ────────────────
 *   • can_fire === false → verdict INSUFFICIENT_DATA **and** drift_pct null.
 *     This is the single most load-bearing line in the file: a paused /
 *     bad-multiplier / stale-feed / impostor / dead-sequencer token must be
 *     UNGRADEABLE. Two INDEPENDENT guards each stop `detectCandidate`
 *     (verdict-early-return AND null-drift), so no single one is load-bearing —
 *     this is hazard #1 (silent wrong price) defended in depth.
 *   • can_fire === true  → verdict derived with the SAME rules as rh-stock-arb
 *     (open: ALIGNED / LONG_DEX / SHORT_DEX; closed: FROZEN_ALIGNED /
 *     PREMARKET_DRIFT / AFTERHOURS_DRIFT). `drift_pct` already uses the
 *     identical sign convention (positive ⟹ DEX above oracle), so a Base row and
 *     an RH row with the same drift fire the same arrow and are M5-comparable.
 *
 * The Base underlyings are US equities, so they trade on the SAME NYSE clock as
 * RH stocks — we reuse `nyseMarketStatus()` verbatim (chain-agnostic hours).
 */
import { nyseMarketStatus } from "@/lib/robinhood/rwa-market";
// `BaseTickerSnapshot` — not `TickerSnapshot` — is the return type of every
// producer below. The shared type leaves `chain` optional (the RH desk omits
// it, and `chainOf` reads absence as robinhood), so a Base row that forgot the
// marker would compile and then be read as an RH row. Declaring the narrow type
// makes that omission a tsc error at the site that made it. See #162.
import type { BaseTickerSnapshot, M5Verdict, MarketSession } from "@/lib/blue-hood/types";
import { BASE_STOCKS, type BaseStock } from "./registry";
import { readBaseStockQuote, type BaseStockQuote } from "./b20-quote";

// Alignment bands — byte-identical to rh-stock-arb.ts so the two desks call the
// same drift "aligned" and the same drift a signal. Kept as local constants
// (not imported) because the handler is a Response route, not a lib export.
const ALIGNED_PCT_INHOURS = 0.5;
const ALIGNED_PCT_CLOSED = 1.5;

/** Just the market fields a snapshot row carries (drops `utc_offset_hours`). */
type MarketClock = { is_open: boolean; session: MarketSession; ny_time_iso: string };

/**
 * Derive the M5 verdict from drift + market hours — the SAME hard-map as
 * `rh-stock-arb.ts` lines 86-98. Sign convention: `drift_pct` positive ⟹ DEX
 * above oracle, so `< 0` ⟹ DEX cheap ⟹ LONG_DEX (exactly like rh-stock-arb's
 * `pct_delta < 0`). This is only ever called for a can_fire quote.
 */
export function baseVerdict(driftPct: number, market: MarketClock): M5Verdict {
  const alignedThreshold = market.is_open ? ALIGNED_PCT_INHOURS : ALIGNED_PCT_CLOSED;
  if (market.is_open) {
    if (Math.abs(driftPct) < alignedThreshold) return "ALIGNED";
    return driftPct < 0 ? "LONG_DEX" : "SHORT_DEX";
  }
  if (Math.abs(driftPct) < alignedThreshold) return "FROZEN_ALIGNED";
  return market.session === "premarket" ? "PREMARKET_DRIFT" : "AFTERHOURS_DRIFT";
}

/**
 * PURE quote → snapshot mapping. Split out (no I/O) so the can_fire ⟹
 * ungradeable contract and the verdict math are unit-testable without an RPC —
 * this is the function the checkpoint probe pins the gate assertions against.
 */
export function baseQuoteToSnapshot(
  q: BaseStockQuote,
  name: string,
  market: MarketClock,
  polled_at_ms: number,
): BaseTickerSnapshot {
  // On Base the token trades in ONE Aerodrome pool, so primary == total depth.
  // `dex_liquidity_usd` is that pool's liquidity; null ⟹ the dust gate fails
  // closed (rowTotalTvl → 0 < $5k), which is the correct "can't confirm depth"
  // behaviour, identical to an RH row with null total_tvl_usd.
  const tvl = q.dex_liquidity_usd;

  if (!q.can_fire) {
    // Suppressed quote ⟹ UNGRADEABLE. verdict INSUFFICIENT_DATA makes
    // detectCandidate early-return; drift_pct null makes it return again even
    // if a future refactor loosened the verdict check. Belt AND suspenders.
    // Oracle/DEX levels are still surfaced for honest display, but they can
    // never become an arrow.
    return {
      ticker: q.ticker,
      chain: "base",
      name,
      contract: q.token,
      verdict: "INSUFFICIENT_DATA",
      oracle_usd: q.share_price_usd,
      dex_usd: q.dex_price_usd,
      tvl_usd: tvl,
      total_tvl_usd: tvl,
      volume_24h_usd: q.dex_volume_24h_usd,
      drift_pct: null,
      pool_ref: q.dex_pool_address,
      is_v4_pool_id: false, // Aerodrome pool address, not a Uniswap-v4 poolId
      market,
      warnings: q.suppressed_reason ? [`base_suppressed_${q.suppressed_reason}`] : [],
      polled_at_ms,
      data_age_s: q.feed_age_seconds,
      // Carried on the SUPPRESSED row too, not just the healthy one: a row
      // suppressed for `feed_stale` is exactly the row whose oracle timestamp a
      // later reader most wants, and dropping it here would leave the archive
      // unable to show why the desk went quiet.
      oracle_updated_at: q.feed_updated_at,
      sparkline: null,
      // A null DEX spot on a can_fire=false row is "no_pool" for the UI; any
      // other suppression (paused, multiplier, stale, sequencer) still has a
      // DEX print, so there is no data-absence to explain there.
      no_data_reason: q.dex_price_usd === null ? "no_pool" : null,
    };
  }

  // Healthy quote — full gradeable row. drift_pct is guaranteed non-null here
  // (can_fire requires it), but default to 0 for the verdict call's type.
  const drift = q.drift_pct ?? 0;
  return {
    ticker: q.ticker,
    chain: "base",
    name,
    contract: q.token,
    verdict: baseVerdict(drift, market),
    oracle_usd: q.share_price_usd,
    dex_usd: q.dex_price_usd,
    tvl_usd: tvl,
    total_tvl_usd: tvl,
    volume_24h_usd: q.dex_volume_24h_usd,
    drift_pct: q.drift_pct,
    pool_ref: q.dex_pool_address,
    is_v4_pool_id: false,
    market,
    warnings: [],
    polled_at_ms,
    data_age_s: q.feed_age_seconds,
    oracle_updated_at: q.feed_updated_at,
    sparkline: null,
    no_data_reason: null,
  };
}

/** Degrade one Base ticker to an ERROR row when the read itself throws.
 *  `readBaseStockQuote` is contractually no-throw, so this is the last-resort
 *  net for an unexpected RPC exception — it must be COUNTED in tokens_errored
 *  (never silently dropped) so the conservation identity holds. */
function baseErrorRow(
  stock: BaseStock,
  market: MarketClock,
  polled_at_ms: number,
  message: string,
): BaseTickerSnapshot {
  return {
    ticker: stock.ticker,
    chain: "base",
    name: stock.name,
    contract: stock.token,
    verdict: "ERROR",
    oracle_usd: null,
    dex_usd: null,
    tvl_usd: null,
    total_tvl_usd: null,
    volume_24h_usd: null,
    drift_pct: null,
    pool_ref: null,
    is_v4_pool_id: false,
    market,
    warnings: [],
    error: message,
    polled_at_ms,
    data_age_s: null,
    // `null`, not omitted: this desk records the field, and the read threw —
    // "we looked and got nothing" is a different fact from "this archive never
    // recorded it", which is what `undefined` means here.
    oracle_updated_at: null,
    sparkline: null,
    no_data_reason: "fetch_failed",
  };
}

/**
 * Poll every verified Base B20 stock in `BASE_STOCKS` into `TickerSnapshot`
 * rows. Never throws: a per-ticker exception becomes an ERROR row (so the
 * caller's metrics stay balanced). No stagger delay — the registry holds a
 * handful of tokens and `readBaseStockQuote` batches its on-chain reads via
 * multicall, so we sit far under any rate limit. (Revisit the no-stagger
 * assumption if the admission gate ever admits a much longer list.)
 */
export async function pollBaseStocks(cycleStart: number): Promise<BaseTickerSnapshot[]> {
  const status = nyseMarketStatus();
  const market: MarketClock = {
    is_open: status.is_open,
    session: status.session,
    ny_time_iso: status.ny_time_iso,
  };

  const rows: BaseTickerSnapshot[] = [];
  for (const stock of BASE_STOCKS) {
    const polled_at_ms = Date.now() - cycleStart;
    try {
      const q = await readBaseStockQuote(stock);
      const row = baseQuoteToSnapshot(q, stock.name, market, polled_at_ms);
      console.log(
        `[base-poller] ticker=${row.ticker} verdict=${row.verdict}` +
          ` can_fire=${q.can_fire} drift=${row.drift_pct === null ? "—" : row.drift_pct.toFixed(3)}%` +
          ` reason=${q.suppressed_reason ?? "—"}`,
      );
      rows.push(row);
    } catch (e) {
      const msg = (e as Error).message;
      console.warn(`[base-poller] ticker=${stock.ticker} threw: ${msg}`);
      rows.push(baseErrorRow(stock, market, polled_at_ms, msg));
    }
  }
  return rows;
}
