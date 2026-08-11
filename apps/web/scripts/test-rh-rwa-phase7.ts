/**
 * Phase 7 handler smoke test — bridge & builder kit (B1·B2·E1·E2·E3).
 * Run: `npx tsx scripts/test-rh-rwa-phase7.ts`
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

  const b1 = await call("rh-bridge-route", { from_chain: "base", to_chain: "robinhood", asset: "ETH" });
  const b1d = b1.data as Record<string, unknown>;
  results["B1 bridge base→rh ETH"] = {
    status: b1.status,
    canonical: (b1d.canonical_route as { name?: string })?.name,
    third_party_count: (b1d.third_party_routes as unknown[])?.length,
  };

  const b2 = await call("rh-usdg-route", { from_asset: "WETH", amount: 0.05 });
  const b2d = b2.data as Record<string, unknown>;
  results["B2 USDG from 0.05 WETH"] = {
    status: b2.status,
    weth_expected: (b2d.paths as { weth_to_usdg?: { expected_out_usdg?: number } })?.weth_to_usdg?.expected_out_usdg,
    v3_pool: (b2d.paths as { weth_to_usdg?: { v3_pool?: unknown } })?.weth_to_usdg?.v3_pool,
    swappable_count: (b2d.registry_tickers_swappable_to_usdg as unknown[])?.length,
  };

  const e1 = await call("rh-rwa-embed-kit", { ticker: "AAPL", theme: "dark" });
  const e1d = e1.data as Record<string, unknown>;
  results["E1 embed AAPL"] = {
    status: e1.status,
    ticker: e1d.ticker,
    current_price: e1d.current_price_usd,
    snippets_keys: Object.keys((e1d.snippets as Record<string, string>) ?? {}),
    buy_button_length: ((e1d.snippets as { buy_button?: string })?.buy_button ?? "").length,
    inspired_by: e1d.inspired_by,
  };

  const e2 = await call("rh-rwa-readme", { ticker: "MSTR" });
  const e2d = e2.data as Record<string, unknown>;
  results["E2 readme MSTR"] = {
    status: e2.status,
    current_price: e2d.current_price_usd,
    readme_length: (e2d.readme_markdown as string)?.length,
    readme_preview: (e2d.readme_markdown as string)?.slice(0, 200),
  };

  const e3 = await call("rh-rwa-pricing-kit", { ticker: "TSLA" });
  const e3d = e3.data as Record<string, unknown>;
  results["E3 pricing kit TSLA"] = {
    status: e3.status,
    current_price: e3d.current_price_usd,
    file_count: Object.keys((e3d.files as Record<string, string>) ?? {}).length,
    file_keys: Object.keys((e3d.files as Record<string, string>) ?? {}),
    hook_length: ((e3d.files as Record<string, string>)?.["useTSLAPrice.ts"] ?? "").length,
  };

  console.log(JSON.stringify(results, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
