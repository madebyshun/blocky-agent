/** Gate 4 — collect AAPL tool outputs to feed a clean-context agent. */
import { HANDLERS } from "../src/app/api/x402/_handlers";

async function callOne(tool: string, body: unknown) {
  const req = new Request(`http://localhost/api/x402/${tool}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = await HANDLERS[tool](req);
  return { tool, status: res.status, data: await res.json() };
}

async function main() {
  const bundle: Record<string, unknown> = {};
  const calls: Array<[string, unknown]> = [
    ["rh-stock-token", { query: "AAPL" }],
    ["rh-stock-quote", { ticker: "AAPL" }],
    ["rh-stock-arb", { ticker: "AAPL" }],
    ["rh-stock-liquidity", { ticker: "AAPL" }],
    ["rh-stock-flow", { ticker: "AAPL" }],
    ["rh-stock-holders", { ticker: "AAPL", limit: 5 }],
    ["rh-stock-swap-quote", { ticker: "AAPL", side: "buy", amount: 500, denom: "USDG" }],
    ["rh-stock-agent-brief", { ticker: "AAPL" }],
  ];
  for (const [tool, body] of calls) {
    const r = await callOne(tool, body);
    bundle[tool] = r.data;
    await new Promise((res) => setTimeout(res, 300));
  }
  console.log(JSON.stringify(bundle, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
