/**
 * Full sample-output run — all 30 RH RWA skills.
 * Run: `npx tsx scripts/test-rh-rwa-all.ts`
 *
 * Prints trimmed live output per tool so a reviewer can eyeball the shape.
 */
import { HANDLERS } from "../src/app/api/x402/_handlers";

async function call(id: string, body: unknown = {}) {
  const req = new Request(`http://localhost/api/x402/${id}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const h = HANDLERS[id];
  if (!h) throw new Error(`No handler registered: ${id}`);
  const res = await h(req);
  const data = await res.json();
  return { id, status: res.status, data };
}

function short(v: unknown, maxKey = 8): unknown {
  if (Array.isArray(v)) return v.slice(0, 3).map((x) => short(x, maxKey));
  if (v && typeof v === "object") {
    const keys = Object.keys(v).slice(0, maxKey);
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = short((v as Record<string, unknown>)[k], maxKey);
    return out;
  }
  if (typeof v === "string" && v.length > 220) return v.slice(0, 220) + "…";
  return v;
}

function heading(text: string) {
  console.log("\n" + "═".repeat(72));
  console.log("  " + text);
  console.log("═".repeat(72));
}

async function main() {
  const wallet = "0xb058a1e305d9c720aa5b1bf42b6f2f6294b03b5f";

  const scenarios: { title: string; id: string; body?: unknown }[] = [
    // Phase 1
    { title: "L1  rh-stock-token          — MSTR lookup",       id: "rh-stock-token",       body: { query: "MSTR" } },
    { title: "L2  rh-rwa-index            — full catalog",       id: "rh-rwa-index" },
    { title: "L3  rh-stock-search         — fuzzy 'appl'",       id: "rh-stock-search",      body: { query: "appl", limit: 3 } },
    { title: "L4  rh-rwa-verify           — MSTR canonical",     id: "rh-rwa-verify",        body: { contract: "0xec262a75e413fAfD0dF80480274532C79D42da09" } },
    { title: "M1  rh-stock-quote          — AAPL Chainlink",     id: "rh-stock-quote",       body: { ticker: "AAPL" } },
    // Phase 2
    { title: "M2  rh-stock-ohlc           — AAPL day x7",         id: "rh-stock-ohlc",        body: { ticker: "AAPL", timeframe: "day", limit: 7 } },
    { title: "M3  rh-stock-liquidity      — TSLA",                id: "rh-stock-liquidity",   body: { ticker: "TSLA" } },
    { title: "M4  rh-stock-movers         — top 5",               id: "rh-stock-movers",      body: { limit: 5 } },
    { title: "M5  rh-stock-arb            — AAPL",                id: "rh-stock-arb",         body: { ticker: "AAPL" } },
    // Phase 3
    { title: "X1  rh-stock-swap-quote     — buy $100 USDG AAPL", id: "rh-stock-swap-quote",   body: { ticker: "AAPL", side: "buy", amount: 100, denom: "USDG" } },
    { title: "X2  rh-stock-swap-prepare   — buy 0.05 WETH TSLA", id: "rh-stock-swap-prepare", body: { ticker: "TSLA", side: "buy", amount: 0.05, denom: "WETH", recipient: wallet } },
    { title: "X3  rh-stock-swap-route     — TSLA↔WETH",           id: "rh-stock-swap-route",  body: { token_in: "TSLA", token_out: "WETH" } },
    // Phase 4
    { title: "P1  rh-stock-holdings       — Blue treasury",       id: "rh-stock-holdings",     body: { wallet } },
    { title: "P2  rh-stock-pnl            — Blue treasury MSTR",  id: "rh-stock-pnl",           body: { wallet, ticker: "MSTR" } },
    { title: "P3  rh-portfolio-rebalance  — 50/50 AAPL/TSLA",    id: "rh-portfolio-rebalance", body: { wallet, targets: { AAPL: 0.5, TSLA: 0.5 } } },
    { title: "P4  rh-sector-basket        — tech $100 equal",     id: "rh-sector-basket",       body: { sector: "tech", total_usd: 100, max_constituents: 5 } },
    // Phase 5
    { title: "D1  rh-stock-holders        — AAPL top 5",          id: "rh-stock-holders",       body: { ticker: "AAPL", limit: 5 } },
    { title: "D2  rh-stock-flow           — AAPL 24h",             id: "rh-stock-flow",          body: { ticker: "AAPL" } },
    { title: "D3  rh-stock-new-listings   — 90 days",              id: "rh-stock-new-listings",  body: { since_days: 90, limit: 5 } },
    { title: "D4  rh-stock-beacon-check   — MSTR",                 id: "rh-stock-beacon-check",  body: { ticker: "MSTR" } },
    { title: "D5  rh-stock-correlations   — 3-ticker",             id: "rh-stock-correlations",  body: { tickers: ["AAPL", "TSLA", "MSTR"], days: 14 } },
    // Phase 6
    { title: "A1  rh-rwa-dca              — TSLA weekly WETH",    id: "rh-rwa-dca",             body: { wallet, ticker: "TSLA", amount_usd: 50, cadence: "week", denom: "WETH" } },
    { title: "A2  rh-stock-alert          — AAPL > $350",          id: "rh-stock-alert",         body: { ticker: "AAPL", threshold_usd: 350, direction: "above" } },
    { title: "A3  rh-stock-report         — AAPL (LLM)",          id: "rh-stock-report",        body: { ticker: "AAPL", horizon: "week" } },
    { title: "A4  rh-stock-agent-brief    — AAPL verdict",         id: "rh-stock-agent-brief",   body: { ticker: "AAPL" } },
    // Phase 7
    { title: "B1  rh-bridge-route         — base→rh ETH",           id: "rh-bridge-route",        body: { from_chain: "base", to_chain: "robinhood", asset: "ETH" } },
    { title: "B2  rh-usdg-route           — 0.05 WETH",             id: "rh-usdg-route",          body: { from_asset: "WETH", amount: 0.05 } },
    { title: "E1  rh-rwa-embed-kit        — AAPL",                  id: "rh-rwa-embed-kit",       body: { ticker: "AAPL" } },
    { title: "E2  rh-rwa-readme           — MSTR",                  id: "rh-rwa-readme",          body: { ticker: "MSTR" } },
    { title: "E3  rh-rwa-pricing-kit      — TSLA",                  id: "rh-rwa-pricing-kit",     body: { ticker: "TSLA" } },
  ];

  let ok = 0, fail = 0;
  for (const s of scenarios) {
    heading(s.title);
    try {
      const r = await call(s.id, s.body ?? {});
      console.log(`status: ${r.status}`);
      console.log(JSON.stringify(short(r.data, 10), null, 2));
      ok++;
    } catch (e) {
      console.log(`❌ ${(e as Error).message}`);
      fail++;
    }
  }
  heading(`SUMMARY: ${ok}/${scenarios.length} OK · ${fail} failed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
