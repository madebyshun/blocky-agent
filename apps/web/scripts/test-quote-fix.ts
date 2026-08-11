/** Verify X1/X2/A1 pool-quote fix + D2/D3 endpoints + P4 dust gate + preview honesty. */
import { HANDLERS } from "../src/app/api/x402/_handlers";

async function call(id: string, body: unknown = {}) {
  const req = new Request(`http://localhost/api/x402/${id}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = await HANDLERS[id](req);
  return { status: res.status, data: await res.json() };
}

async function main() {
  const wallet = "0xb058a1e305d9c720aa5b1bf42b6f2f6294b03b5f";

  console.log("── X1 buy 100 USDG AAPL — pool-basis expected & min_out ──");
  const x1 = await call("rh-stock-swap-quote", { ticker: "AAPL", side: "buy", amount: 100, denom: "USDG" });
  const x1d = x1.data as Record<string, unknown>;
  console.log("spot_source:", x1d.spot_source);
  console.log("pool_spot_usd:", x1d.pool_spot_usd, "chainlink_spot_usd:", x1d.chainlink_spot_usd);
  console.log("pool_oracle_delta_pct:", x1d.pool_oracle_delta_pct, "deviates:", x1d.pool_deviates_from_oracle);
  console.log("expected_out:", x1d.expected_out, "expected_after_impact:", x1d.expected_after_impact);
  console.log("min_out:", x1d.min_out, "trade_impact_pct:", x1d.trade_impact_pct);
  console.log("warnings:", x1d.warnings);

  console.log("\n── X2 buy 0.05 WETH TSLA — should use POOL basis min_out ──");
  const x2 = await call("rh-stock-swap-prepare", { ticker: "TSLA", side: "buy", amount: 0.05, denom: "WETH", recipient: wallet });
  const x2d = x2.data as Record<string, unknown>;
  console.log("quote:", x2d.quote);
  console.log("warnings:", x2d.warnings);

  console.log("\n── A1 DCA preview_only (persist=false) ──");
  const a1 = await call("rh-rwa-dca", { wallet, ticker: "TSLA", amount_usd: 50, cadence: "week", denom: "WETH" });
  const a1d = a1.data as Record<string, unknown>;
  console.log("mode:", a1d.mode, "persisted:", a1d.persisted);
  console.log("quote_preview.pool_oracle_delta_pct:", (a1d.quote_preview as { pool_oracle_delta_pct?: number })?.pool_oracle_delta_pct);
  console.log("quote_preview.min_out_per_period:", (a1d.quote_preview as { min_out_per_period?: number })?.min_out_per_period);

  console.log("\n── A2 alert preview_only ──");
  const a2 = await call("rh-stock-alert", { ticker: "AAPL", threshold_usd: 350, direction: "above" });
  const a2d = a2.data as Record<string, unknown>;
  console.log("mode:", a2d.mode, "status:", (a2d.alert as { status?: string })?.status, "met_now:", a2d.met_now);
  console.log("warnings:", a2d.warnings);

  console.log("\n── D2 flow AAPL — pool_ref + gt_status + warnings ──");
  const d2 = await call("rh-stock-flow", { ticker: "AAPL" });
  const d2d = d2.data as Record<string, unknown>;
  console.log("pool.pool_ref:", (d2d.pool as { pool_ref?: string })?.pool_ref);
  console.log("gt_trades_endpoint_status:", d2d.gt_trades_endpoint_status);
  console.log("trades_seen:", d2d.trades_seen, "buy/sell/total:", d2d.buy_volume_usd, d2d.sell_volume_usd, d2d.total_volume_usd);
  console.log("warnings:", d2d.warnings);

  console.log("\n── D3 new-listings via /tokens endpoint ──");
  const d3 = await call("rh-stock-new-listings", {});
  const d3d = d3.data as Record<string, unknown>;
  console.log("erc20_scanned:", d3d.erc20_scanned);
  console.log("rhj_named_found:", d3d.rhj_named_found);
  console.log("new_since_registry:", d3d.new_since_registry);
  console.log("first 3 new_only:", (d3d.new_only as Array<Record<string, unknown>>)?.slice(0, 3).map((r) => ({ symbol: r.symbol, name: r.name, holders: r.holders })));
  console.log("warnings:", d3d.warnings);

  console.log("\n── P4 sector-basket tech $100 — dust gate ──");
  const p4 = await call("rh-sector-basket", { sector: "tech", total_usd: 100, max_constituents: 10 });
  const p4d = p4.data as Record<string, unknown>;
  console.log("legs:", (p4d.legs as Array<Record<string, unknown>>)?.map((l) => ({ ticker: l.ticker, amount_usd: l.amount_usd, tvl: (l.liquidity_check as { tvl_usd?: number })?.tvl_usd })));
  console.log("skipped_legs:", p4d.skipped_legs);
  console.log("warnings:", p4d.warnings);

  console.log("\n── A4 warnings sync with M5 ──");
  const a4 = await call("rh-stock-agent-brief", { ticker: "AAPL" });
  const a4d = a4.data as Record<string, unknown>;
  console.log("verdict:", a4d.verdict);
  console.log("warnings:", a4d.warnings);
}

main().catch((e) => { console.error(e); process.exit(1); });
