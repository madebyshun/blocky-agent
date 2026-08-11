/**
 * Phase 6 handler smoke test — agent skills (A1·A2·A3·A4).
 * Run: `npx tsx scripts/test-rh-rwa-phase6.ts`
 * Note: A3/A4 call Venice LLM — expect longer runtime.
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
  const wallet = "0xb058a1e305d9c720aa5b1bf42b6f2f6294b03b5f";

  const a1 = await call("rh-rwa-dca", {
    wallet, ticker: "TSLA", amount_usd: 0.05,   // WETH-denom-native amount
    cadence: "week", total_periods: 12,
    denom: "WETH", persist: false,
  });
  const a1d = a1.data as Record<string, unknown>;
  results["A1 DCA TSLA WETH"] = {
    status: a1.status,
    schedule_id: (a1d.schedule as { id?: string })?.id,
    quote_spot: (a1d.quote_preview as { spot_usd?: number })?.spot_usd,
    quote_expected: (a1d.quote_preview as { expected_out_per_period?: number })?.expected_out_per_period,
    first_run_route: (a1d.first_run as { route?: string })?.route,
    call_count: (a1d.first_run as { call_count?: number })?.call_count,
  };

  const a2 = await call("rh-stock-alert", {
    ticker: "AAPL", threshold_usd: 100, direction: "above", persist: false,
  });
  const a2d = a2.data as Record<string, unknown>;
  results["A2 alert AAPL >$100"] = {
    status: a2.status,
    status_field: (a2d.alert as { status?: string })?.status,
    met_now: a2d.met_now,
    last_price: (a2d.alert as { last_price_usd?: number })?.last_price_usd,
  };

  const a2b = await call("rh-stock-alert", {
    ticker: "AAPL", threshold_usd: 5000, direction: "above", persist: false,
  });
  const a2bd = a2b.data as Record<string, unknown>;
  results["A2 alert AAPL >$5000"] = {
    status: a2b.status,
    met_now: a2bd.met_now,
    note: a2bd.note,
  };

  const a4 = await call("rh-stock-agent-brief", { ticker: "AAPL" });
  const a4d = a4.data as Record<string, unknown>;
  results["A4 agent brief AAPL"] = {
    status: a4.status,
    verdict: a4d.verdict,
    chainlink: (a4d.facts as { chainlink_price_usd?: number })?.chainlink_price_usd,
    dex: (a4d.facts as { dex_price_usd?: number })?.dex_price_usd,
    context: a4d.one_line_context,
    sources: a4d.web_sources,
    risk_flags: a4d.risk_flags,
  };

  const a3 = await call("rh-stock-report", { ticker: "AAPL", horizon: "week" });
  const a3d = a3.data as Record<string, unknown>;
  results["A3 report AAPL"] = {
    status: a3.status,
    facts_chainlink: (a3d.facts as { chainlink_price_usd?: number })?.chainlink_price_usd,
    markdown_len: (a3d.report_markdown as string)?.length,
    markdown_preview: (a3d.report_markdown as string)?.slice(0, 300),
  };

  console.log(JSON.stringify(results, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
