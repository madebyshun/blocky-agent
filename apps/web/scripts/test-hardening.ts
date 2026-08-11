/**
 * Verify hardening: M3 slippage /2, M4 dust filter, M5 market gate, A4 sync.
 */
import { HANDLERS } from "../src/app/api/x402/_handlers";
import { nyseMarketStatus } from "../src/lib/robinhood/rwa-market";

async function call(id: string, body: unknown = {}) {
  const req = new Request(`http://localhost/api/x402/${id}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = await HANDLERS[id](req);
  return { status: res.status, data: await res.json() };
}

async function main() {
  console.log("── Market status now ───────────────────────────");
  console.log(nyseMarketStatus());

  console.log("\n── M3 TSLA liquidity (expect one_side_usd + slippage /2) ──");
  const m3 = await call("rh-stock-liquidity", { ticker: "TSLA" });
  const m3d = m3.data as Record<string, unknown>;
  console.log("deepest_pool.one_side_usd:", (m3d.deepest_pool as { one_side_usd?: number })?.one_side_usd);
  console.log("deepest_pool.reserve_usd:", (m3d.deepest_pool as { reserve_usd?: number })?.reserve_usd);
  console.log("slippage @ $100:", (m3d.slippage_upper_bound as { estimates?: unknown[] })?.estimates?.[0]);
  console.log("slippage @ $10000:", (m3d.slippage_upper_bound as { estimates?: unknown[] })?.estimates?.[2]);
  console.log("warnings:", m3d.warnings);

  console.log("\n── M4 movers dust filter ($5k TVL / $500 vol) ──");
  const m4 = await call("rh-stock-movers", { limit: 10 });
  const m4d = m4.data as Record<string, unknown>;
  console.log("universe:", m4d.universe);
  console.log("dust_filter.filtered_out_count:", (m4d.dust_filter as { filtered_out_count?: number })?.filtered_out_count);
  console.log("dust_filter.filtered_out first 3:", (m4d.dust_filter as { filtered_out?: unknown[] })?.filtered_out?.slice(0, 3));
  console.log("gainers count:", (m4d.gainers as unknown[])?.length);
  console.log("losers count:", (m4d.losers as unknown[])?.length);

  console.log("\n── M4 with dust filter OFF ──");
  const m4raw = await call("rh-stock-movers", { limit: 10, min_tvl_usd: 0, min_volume_24h_usd: 0 });
  const m4raw_d = m4raw.data as Record<string, unknown>;
  console.log("universe:", m4raw_d.universe);
  console.log("gainers count:", (m4raw_d.gainers as unknown[])?.length);
  console.log("losers count:", (m4raw_d.losers as unknown[])?.length);

  console.log("\n── M5 AAPL arb (market-hours-aware) ──");
  const m5 = await call("rh-stock-arb", { ticker: "AAPL" });
  const m5d = m5.data as Record<string, unknown>;
  console.log("verdict:", m5d.verdict);
  console.log("market:", m5d.market);
  console.log("delta:", m5d.delta);
  console.log("chainlink.age_seconds:", (m5d.chainlink as { age_seconds?: number })?.age_seconds);
  console.log("dex.pool_ref:", (m5d.dex as { pool_ref?: string })?.pool_ref);
  console.log("dex.pool_selection:", (m5d.dex as { pool_selection?: string })?.pool_selection);
  console.log("warnings:", m5d.warnings);

  console.log("\n── A4 AAPL agent brief (should match M5 verdict semantics) ──");
  const a4 = await call("rh-stock-agent-brief", { ticker: "AAPL" });
  const a4d = a4.data as Record<string, unknown>;
  console.log("verdict:", a4d.verdict);
  console.log("verdict_note:", a4d.verdict_note);
  console.log("market:", a4d.market);
  console.log("facts.chainlink_age_seconds:", (a4d.facts as { chainlink_age_seconds?: number })?.chainlink_age_seconds);
  console.log("facts.pool_selection:", (a4d.facts as { pool_selection?: string })?.pool_selection);

  console.log("\n── M2 AAPL ohlc (candles<limit warning) ──");
  const m2 = await call("rh-stock-ohlc", { ticker: "AAPL", timeframe: "day", limit: 7 });
  const m2d = m2.data as Record<string, unknown>;
  console.log("candles_returned:", m2d.candles_returned);
  console.log("limit:", m2d.limit);
  console.log("pool_ref:", m2d.pool_ref, "· is_v4_pool_id:", m2d.is_v4_pool_id);
  console.log("candle_field_meta:", m2d.candle_field_meta);
  console.log("warnings:", m2d.warnings);
}

main().catch((e) => { console.error(e); process.exit(1); });
