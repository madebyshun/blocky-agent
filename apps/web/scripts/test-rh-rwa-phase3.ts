/**
 * Phase 3 handler smoke test — trading execution (X1·X2·X3).
 * Run: `npx tsx scripts/test-rh-rwa-phase3.ts`
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

  // X1 quote: BUY $100 AAPL with USDG
  const q1 = await call("rh-stock-swap-quote", { ticker: "AAPL", side: "buy", amount: 100, denom: "USDG" });
  const q1d = q1.data as Record<string, unknown>;
  results["X1 buy 100 USDG AAPL"] = {
    status: q1.status,
    ticker: q1d.ticker,
    side: q1d.side,
    denom_in: q1d.denom_in,
    spot_usd: q1d.spot_usd,
    spot_source: q1d.spot_source,
    expected_out: q1d.expected_out,
    min_out: q1d.min_out,
    route: q1d.route,
    slippage_upper: q1d.slippage_upper_bound_from_liquidity_pct,
  };

  // X1 quote: SELL 1 TSLA to USDG
  const q2 = await call("rh-stock-swap-quote", { ticker: "TSLA", side: "sell", amount: 1, denom: "USDG" });
  const q2d = q2.data as Record<string, unknown>;
  results["X1 sell 1 TSLA to USDG"] = {
    status: q2.status,
    spot_usd: q2d.spot_usd,
    expected_out: q2d.expected_out,
    min_out: q2d.min_out,
    route_kind: (q2d.route as { kind?: string })?.kind,
  };

  // X2 prepare: BUY $100 AAPL with USDG — expected to fail (V4 pools only)
  const p1 = await call("rh-stock-swap-prepare", {
    ticker: "AAPL", side: "buy", amount: 100, denom: "USDG",
    recipient: "0xb058a1e305d9c720aa5b1bf42b6f2f6294b03b5f", slippage_bps: 100,
  });
  const p1d = p1.data as Record<string, unknown>;
  results["X2 buy AAPL USDG (V4-only)"] = {
    status: p1.status,
    error: p1d.error,
    v4_pools_count: (p1d.v4_pools_detected as unknown[])?.length,
    v4_note: p1d.v4_note,
  };

  // X2 prepare: BUY 0.05 WETH → TSLA — should succeed via V3 pool
  const p2 = await call("rh-stock-swap-prepare", {
    ticker: "TSLA", side: "buy", amount: 0.05, denom: "WETH",
    recipient: "0xb058a1e305d9c720aa5b1bf42b6f2f6294b03b5f", slippage_bps: 100,
  });
  const p2d = p2.data as Record<string, unknown>;
  results["X2 buy TSLA WETH (V3 route)"] = {
    status: p2.status,
    route_kind: (p2d.route as { kind?: string })?.kind,
    call_count: (p2d.calls as unknown[])?.length,
    swap_pool: (p2d.calls as Array<Record<string, unknown>>)?.find((c) => c.kind === "swap")?.pool,
    quote: p2d.quote,
  };

  // X3 route: AAPL <-> USDG (V4 territory)
  const r1 = await call("rh-stock-swap-route", { token_in: "AAPL", token_out: "USDG" });
  const r1d = r1.data as Record<string, unknown>;
  const r1v4 = (r1d.v4_info_only as { pools?: unknown[] } | undefined)?.pools ?? [];
  results["X3 route AAPL <-> USDG"] = {
    status: r1.status,
    v3_has_direct: (r1d.v3 as { has_direct?: boolean } | undefined)?.has_direct,
    v4_pool_count: r1v4.length,
    v4_first: r1v4[0],
    note: r1d.note,
  };

  // X3 route: TSLA <-> WETH (V3 territory)
  const r3 = await call("rh-stock-swap-route", { token_in: "TSLA", token_out: "WETH" });
  const r3d = r3.data as Record<string, unknown>;
  results["X3 route TSLA <-> WETH"] = {
    status: r3.status,
    v3_has_direct: (r3d.v3 as { has_direct?: boolean } | undefined)?.has_direct,
    v3_recommended: (r3d.v3 as { recommended?: string } | undefined)?.recommended,
    v3_best: ((r3d.v3 as { direct?: { best?: unknown } } | undefined)?.direct?.best),
  };

  // X3 route: TSLA <-> AAPL (both stocks, likely multi-hop)
  const r2 = await call("rh-stock-swap-route", { token_in: "TSLA", token_out: "AAPL" });
  const r2d = r2.data as Record<string, unknown>;
  results["X3 route TSLA <-> AAPL"] = {
    status: r2.status,
    has_direct: r2d.has_direct,
    has_multi_hop: r2d.has_multi_hop,
    recommended: r2d.recommended_route,
  };

  console.log(JSON.stringify(results, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
