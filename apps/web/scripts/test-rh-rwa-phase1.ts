/**
 * Phase 1 handler smoke test. Run: `npx tsx scripts/test-rh-rwa-phase1.ts`
 * Verifies HANDLERS[id] returns non-error JSON for each of the 5 new tools.
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

  // L2 rh-rwa-index — zero-input catalog
  results["L2 rh-rwa-index"] = summarizeIndex(await call("rh-rwa-index", {}));

  // L1 rh-stock-token — MSTR (canonical)
  results["L1 rh-stock-token MSTR"] = summarizeToken(await call("rh-stock-token", { query: "MSTR" }));

  // L1 rh-stock-token — Tesla by name
  results["L1 rh-stock-token Tesla"] = summarizeToken(await call("rh-stock-token", { query: "Tesla" }));

  // L1 rh-stock-token — bogus ticker → fuzzy suggestions
  results["L1 rh-stock-token BOGUS"] = summarizeToken(await call("rh-stock-token", { query: "BOGUS" }));

  // L1 rh-stock-token — chainlink-only ticker (RGTI has feed, no token)
  results["L1 rh-stock-token RGTI (chainlink-only)"] = summarizeToken(await call("rh-stock-token", { query: "RGTI" }));

  // L3 rh-stock-search — typo
  results["L3 rh-stock-search 'appl'"] = summarizeSearch(await call("rh-stock-search", { query: "appl" }));

  // L4 rh-rwa-verify — canonical (MSTR)
  results["L4 rh-rwa-verify MSTR canonical"] = summarizeVerify(await call("rh-rwa-verify", { contract: "0xec262a75e413fAfD0dF80480274532C79D42da09" }));

  // L4 rh-rwa-verify — random address
  results["L4 rh-rwa-verify random addr"] = summarizeVerify(await call("rh-rwa-verify", { contract: "0x0000000000000000000000000000000000001234" }));

  // M1 rh-stock-quote — MSTR (chainlink)
  results["M1 rh-stock-quote MSTR"] = summarizeQuote(await call("rh-stock-quote", { ticker: "MSTR" }));

  // M1 rh-stock-quote — AAPL (chainlink)
  results["M1 rh-stock-quote AAPL"] = summarizeQuote(await call("rh-stock-quote", { ticker: "AAPL" }));

  // M1 rh-stock-quote — bogus
  results["M1 rh-stock-quote BOGUS"] = summarizeQuote(await call("rh-stock-quote", { ticker: "BOGUS" }));

  console.log(JSON.stringify(results, null, 2));
}

type Ok<T> = { status: number; data: T };

function summarizeIndex(r: Ok<Record<string, unknown>>) {
  const d = r.data as { counts?: Record<string, number>; stocks?: unknown[]; etfs?: unknown[] };
  return { status: r.status, counts: d.counts, first_stock: (d.stocks ?? [])[0] };
}
function summarizeToken(r: Ok<Record<string, unknown>>) {
  const d = r.data as Record<string, unknown>;
  return {
    status: r.status,
    verdict: d.verdict,
    ticker: d.ticker,
    contract: d.contract,
    price_usd: d.price_usd,
    price_source: d.price_source,
    chainlink_updated_at: (d.chainlink as { updated_at?: number } | null)?.updated_at,
    suggestions: (d.suggestions as unknown[])?.slice(0, 3),
  };
}
function summarizeSearch(r: Ok<Record<string, unknown>>) {
  const d = r.data as { matches?: unknown[]; match_count?: number };
  return { status: r.status, match_count: d.match_count, matches: d.matches?.slice(0, 3) };
}
function summarizeVerify(r: Ok<Record<string, unknown>>) {
  return { status: r.status, verdict: r.data.verdict, canonical: r.data.canonical, warning: r.data.warning };
}
function summarizeQuote(r: Ok<Record<string, unknown>>) {
  const d = r.data as Record<string, unknown>;
  return {
    status: r.status,
    ticker: d.ticker,
    price_usd: d.price_usd,
    source: d.source,
    chainlink_updated_at: (d.chainlink as { updated_at?: number } | null)?.updated_at,
  };
}

main().catch((e) => { console.error(e); process.exit(1); });
