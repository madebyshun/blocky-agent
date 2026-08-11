// x402/rh-rwa-readme (E2) — README-ready integrator docs for a RH RWA.
// Price: $0.05
//
// For a given ticker, returns a Markdown README section (chain config, live
// oracle usage, buy button, safety notes) that an integrator can paste into
// their own repo's README. Numbers come from real reads (Chainlink + GT).

import { findByTicker, RH_CHAIN } from "@/lib/robinhood/rwa-registry";
import { chainlinkLatest } from "@/lib/robinhood/rwa-price";

export default async function handler(req: Request): Promise<Response> {
  try {
    let body: { ticker?: string } = {};
    try { const t = await req.text(); if (t?.trim().startsWith("{")) body = JSON.parse(t); } catch {}
    const url = new URL(req.url);
    const ticker = (body.ticker ?? url.searchParams.get("ticker") ?? "").trim().toUpperCase();

    if (!ticker) return Response.json({ error: "Provide `ticker`." }, { status: 400 });
    const token = findByTicker(ticker);
    if (!token) return Response.json({ tool: "rh-rwa-readme", ticker, error: "Ticker not in registry." }, { status: 404 });

    const timestamp = new Date().toISOString();
    const quote = token.chainlinkFeed ? await chainlinkLatest(token.chainlinkFeed, token.chainlinkHeartbeat ?? 86400) : null;

    const md = `# Embedding \`${token.ticker}\` (${token.name}) — Robinhood Chain

**Robinhood-issued tokenized ${token.kind === "etf" ? "ETF" : "equity"}** on **Robinhood Chain (chainId ${RH_CHAIN.chainId})**.

- **Ticker:** \`${token.ticker}\`
- **Name:** ${token.name}
- **Contract:** [\`${token.contract}\`](${RH_CHAIN.explorer}/address/${token.contract})
- **Decimals:** ${token.decimals}
- **Issuer:** ${token.issuer === "RHJ" ? "Robinhood Assets (Jersey) Limited (RHJ)" : token.issuer}
- **Chainlink price feed:** ${token.chainlinkFeed ? "[`" + token.chainlinkFeed + "`](https://docs.chain.link/data-feeds/price-feeds/addresses?network=robinhood)" : "_none in current registry_"}
${quote ? `- **Live oracle price** (${new Date(quote.updated_at * 1000).toISOString()}): **$${quote.price_usd.toFixed(2)}**` : ""}

## Add Robinhood Chain to your wagmi config

\`\`\`ts
import { defineChain } from "viem";
export const robinhoodMainnet = defineChain({
  id: ${RH_CHAIN.chainId},
  name: "${RH_CHAIN.name}",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["${RH_CHAIN.rpc}"] } },
  blockExplorers: { default: { name: "Blockscout", url: "${RH_CHAIN.explorer}" } },
});
\`\`\`

## Read the live oracle price

Every Robinhood Stock Token has a Chainlink AggregatorV3 feed on RH Chain.
For **${token.ticker}**, the feed proxy is \`${token.chainlinkFeed ?? "(none)"}\`.

\`\`\`ts
const price = await client.readContract({
  address: "${token.chainlinkFeed ?? "0x…"}",
  abi: aggregatorV3Abi,
  functionName: "latestRoundData",
});
// price[1] is int256; divide by 10 ** decimals (8 on RH stock feeds).
\`\`\`

## Buy button (non-custodial)

Use the BlueAgent [\`rh-stock-swap-prepare\`](https://blueagent.dev/api/x402/rh-stock-swap-prepare) tool. It returns the unsigned tx sequence for a swap; the user's wallet signs and broadcasts.

\`\`\`ts
const res = await fetch("https://blueagent.dev/api/x402/rh-stock-swap-prepare", {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-PAYMENT": /* signed EIP-3009 header */ "" },
  body: JSON.stringify({
    ticker: "${token.ticker}",
    side: "buy",
    amount: 100,           // USDG amount
    denom: "USDG",
    recipient: userAddress,
  }),
});
const { calls } = await res.json();
for (const c of calls) await walletClient.sendTransaction({ to: c.to, data: c.data, value: BigInt(c.value ?? "0") });
\`\`\`

## Safety notes

- **Canonical only.** Only trust contracts issued by ${token.issuer === "RHJ" ? "RHJ (`0x4783C67b…`)" : "the canonical issuer"}. Verify with [\`rh-rwa-verify\`](https://blueagent.dev/api/x402/rh-rwa-verify) before displaying anything as \`${token.ticker}\`.
- **Beacon-proxy.** ${token.ticker} is a beacon-proxy contract; the implementation can be upgraded. Snapshot [\`rh-stock-beacon-check\`](https://blueagent.dev/api/x402/rh-stock-beacon-check) and alert on changes.
- **Not investment advice.** Prices are on-chain oracle data. Availability, holding limits, and settlement follow ${token.issuer === "RHJ" ? "Robinhood Assets (Jersey) Limited" : token.issuer} T&Cs.

## Docs

- Robinhood Chain: <${RH_CHAIN.explorer}>
- BlueAgent Hub: https://blueagent.dev/hub
- Vlad Tenev's builder call: https://x.com/vladtenev/status/2077266840477479424
`;

    return Response.json({
      tool: "rh-rwa-readme",
      ticker: token.ticker,
      name: token.name,
      contract: token.contract,
      readme_markdown: md,
      current_price_usd: quote?.price_usd ?? null,
      network: RH_CHAIN,
      data_sources: ["Chainlink AggregatorV3 (RH Chain)"],
      timestamp,
    });
  } catch (e) {
    return Response.json({ error: "rh-rwa-readme failed", message: (e as Error).message }, { status: 500 });
  }
}
