/**
 * Phase 5 handler smoke test — discovery & analytics (D1·D2·D3·D4·D5).
 * Run: `npx tsx scripts/test-rh-rwa-phase5.ts`
 */
import { HANDLERS } from "../src/app/api/x402/_handlers";

async function call(id: string, body: unknown) {
  const req = new Request(`http://localhost/api/x402/${id}`, {
    method: "POST", headers: { "content-type": "application/json" },
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

  const d1 = await call("rh-stock-holders", { ticker: "AAPL", limit: 5 });
  const d1d = d1.data as Record<string, unknown>;
  results["D1 holders AAPL"] = {
    status: d1.status,
    returned: d1d.returned_count,
    concentration: d1d.concentration,
    holders_first: (d1d.holders as unknown[])?.[0],
  };

  const d2 = await call("rh-stock-flow", { ticker: "AAPL" });
  const d2d = d2.data as Record<string, unknown>;
  results["D2 flow AAPL"] = {
    status: d2.status,
    pressure: d2d.pressure,
    buy_vol: d2d.buy_volume_usd,
    sell_vol: d2d.sell_volume_usd,
    trades: d2d.trades_seen,
  };

  const d3 = await call("rh-stock-new-listings", { since_days: 90, limit: 10 });
  const d3d = d3.data as Record<string, unknown>;
  results["D3 new listings 90d"] = {
    status: d3.status,
    creations_seen: d3d.creations_seen,
    new_since_cutoff: d3d.new_since_cutoff,
    first_new: (d3d.new_only as unknown[])?.[0],
  };

  const d4 = await call("rh-stock-beacon-check", { ticker: "MSTR" });
  const d4d = d4.data as Record<string, unknown>;
  results["D4 beacon check MSTR"] = {
    status: d4.status,
    is_beacon_proxy: d4d.is_beacon_proxy,
    beacon: d4d.beacon,
    implementation: d4d.implementation,
    owner: d4d.beacon_owner,
  };

  const d5 = await call("rh-stock-correlations", { tickers: ["AAPL", "MSTR", "TSLA"], days: 14 });
  const d5d = d5.data as Record<string, unknown>;
  results["D5 correlations 3-ticker"] = {
    status: d5.status,
    series_lengths: d5d.series_lengths,
    correlations: d5d.correlations,
  };

  console.log(JSON.stringify(results, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
