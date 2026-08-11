/**
 * Phase 4 handler smoke test — portfolio (P1·P2·P3·P4).
 * Run: `npx tsx scripts/test-rh-rwa-phase4.ts`
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
  // Test wallet — Blue treasury on RH Chain (should have some balances or none, but exists)
  const wallet = "0xb058a1e305d9c720aa5b1bf42b6f2f6294b03b5f";

  const h = await call("rh-stock-holdings", { wallet });
  const hd = h.data as Record<string, unknown>;
  results["P1 holdings"] = {
    status: h.status,
    wallet: hd.wallet,
    total_value_usd: hd.total_value_usd,
    holdings_count: hd.holdings_count,
    priced_count: hd.priced_count,
    first_holding: (hd.holdings as unknown[])?.[0] ?? null,
  };

  const p = await call("rh-stock-pnl", { wallet, ticker: "MSTR" });
  const pd = p.data as Record<string, unknown>;
  results["P2 pnl MSTR"] = {
    status: p.status,
    total_value_usd: pd.total_value_usd,
    activity_count: (pd.activity as unknown[])?.length,
    activity_first: (pd.activity as unknown[])?.[0],
  };

  const rb = await call("rh-portfolio-rebalance", {
    wallet, targets: { "AAPL": 0.5, "TSLA": 0.5 }, min_swap_usd: 0.5,
  });
  const rbd = rb.data as Record<string, unknown>;
  results["P3 rebalance AAPL/TSLA"] = {
    status: rb.status,
    total_value_usd: rbd.total_value_usd,
    plan_count: rbd.plan_count,
    plan_first: (rbd.plan as unknown[])?.[0],
    note: rbd.note,
  };

  const sb = await call("rh-sector-basket", {
    sector: "tech", total_usd: 100, weighting: "equal", max_constituents: 5,
  });
  const sbd = sb.data as Record<string, unknown>;
  results["P4 sector basket tech 100 equal"] = {
    status: sb.status,
    sector: sbd.sector,
    weighting: sbd.weighting_used,
    constituent_count: sbd.constituent_count,
    legs: (sbd.legs as Array<Record<string, unknown>>)?.slice(0, 3),
  };

  const sb2 = await call("rh-sector-basket", {
    tickers: ["AAPL", "TSLA", "NVDA"], total_usd: 300, weighting: "market-cap",
  });
  const sb2d = sb2.data as Record<string, unknown>;
  results["P4 basket AAPL/TSLA/NVDA 300 tvl"] = {
    status: sb2.status,
    weighting: sb2d.weighting_used,
    constituent_count: sb2d.constituent_count,
    legs: (sb2d.legs as Array<Record<string, unknown>>)?.map((l) => ({
      ticker: l.ticker, weight: l.weight, amount_usd: l.amount_usd, expected_units: l.expected_units,
    })),
  };

  console.log(JSON.stringify(results, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
