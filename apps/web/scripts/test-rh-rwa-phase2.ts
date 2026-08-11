/**
 * Phase 2 handler smoke test. Run: `npx tsx scripts/test-rh-rwa-phase2.ts`
 * Verifies HANDLERS[id] returns real, non-fabricated data for M2·M3·M4·M5.
 */
import { HANDLERS } from "../src/app/api/x402/_handlers";

async function call(id: string, body: unknown) {
  const req = new Request(`http://localhost/api/x402/${id}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const h = HANDLERS[id];
  if (!h) throw new Error(`No handler registered: ${id}`);
  const res = await h(req);
  const data = await res.json();
  return { status: res.status, data };
}

async function main() {
  const results: Record<string, unknown> = {};

  // Ticker with high probability of DEX pools: MSTR? Actually let's try a common one
  // and one likely without a pool.

  // M2 rh-stock-ohlc — hourly candles for MSTR
  const ohlc = await call("rh-stock-ohlc", { ticker: "MSTR", timeframe: "hour", limit: 12 });
  results["M2 MSTR hourly x12"] = {
    status: ohlc.status,
    ticker: (ohlc.data as Record<string, unknown>).ticker,
    pool_address: (ohlc.data as Record<string, unknown>).pool_address,
    candle_count: ((ohlc.data as { candles?: unknown[] }).candles ?? []).length,
    summary: (ohlc.data as Record<string, unknown>).summary,
    note: (ohlc.data as Record<string, unknown>).note,
  };

  // M2 AAPL day
  const ohlcA = await call("rh-stock-ohlc", { ticker: "AAPL", timeframe: "day", limit: 7 });
  results["M2 AAPL day x7"] = {
    status: ohlcA.status,
    candle_count: ((ohlcA.data as { candles?: unknown[] }).candles ?? []).length,
    summary: (ohlcA.data as Record<string, unknown>).summary,
    note: (ohlcA.data as Record<string, unknown>).note,
  };

  // M3 rh-stock-liquidity — TVL + slippage for TSLA
  const liq = await call("rh-stock-liquidity", { ticker: "TSLA" });
  const liqData = liq.data as Record<string, unknown>;
  results["M3 TSLA liquidity"] = {
    status: liq.status,
    ticker: liqData.ticker,
    pool_count: liqData.pool_count,
    total_tvl_usd: liqData.total_tvl_usd,
    deepest_pool_name: (liqData.deepest_pool as { name?: string } | undefined)?.name,
    slippage_first_row: (liqData.slippage_upper_bound as { estimates?: unknown[] } | undefined)?.estimates?.[0],
    note: liqData.note,
  };

  // M4 rh-stock-movers
  const movers = await call("rh-stock-movers", { limit: 5 });
  const mv = movers.data as Record<string, unknown>;
  results["M4 movers"] = {
    status: movers.status,
    top_gainer: (mv.gainers as Array<{ ticker: string; change_24h_pct: number }> | undefined)?.[0],
    top_loser: (mv.losers as Array<{ ticker: string; change_24h_pct: number }> | undefined)?.[0],
    universe: mv.universe,
    note: mv.note,
  };

  // M5 rh-stock-arb — MSTR
  const arb = await call("rh-stock-arb", { ticker: "MSTR" });
  const a = arb.data as Record<string, unknown>;
  results["M5 MSTR arb"] = {
    status: arb.status,
    verdict: a.verdict,
    delta_pct: (a.delta as { pct?: number } | undefined)?.pct,
    chainlink_price: (a.chainlink as { price_usd?: number } | undefined)?.price_usd,
    dex_price: (a.dex as { price_usd?: number } | undefined)?.price_usd,
    note: a.note,
  };

  // M5 arb — AAPL
  const arbA = await call("rh-stock-arb", { ticker: "AAPL" });
  const aA = arbA.data as Record<string, unknown>;
  results["M5 AAPL arb"] = {
    status: arbA.status,
    verdict: aA.verdict,
    delta_pct: (aA.delta as { pct?: number } | undefined)?.pct,
    chainlink_price: (aA.chainlink as { price_usd?: number } | undefined)?.price_usd,
    dex_price: (aA.dex as { price_usd?: number } | undefined)?.price_usd,
    note: aA.note,
  };

  console.log(JSON.stringify(results, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
