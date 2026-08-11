// x402/rh-rwa-pricing-kit (E3) — Chainlink-feed React hook kit.
// Price: $0.05
//
// Standalone React hook + viem client + AggregatorV3 ABI: everything a
// builder needs to display a live RH RWA price. No wallet needed — this is
// the read-only path (which is often the first thing an integrator wants).

import { findByTicker, RH_CHAIN, CHAINLINK_ONLY_FEEDS } from "@/lib/robinhood/rwa-registry";
import { chainlinkLatest } from "@/lib/robinhood/rwa-price";

export default async function handler(req: Request): Promise<Response> {
  try {
    let body: { ticker?: string } = {};
    try { const t = await req.text(); if (t?.trim().startsWith("{")) body = JSON.parse(t); } catch {}
    const url = new URL(req.url);
    const ticker = (body.ticker ?? url.searchParams.get("ticker") ?? "").trim().toUpperCase();

    if (!ticker) return Response.json({ error: "Provide `ticker`." }, { status: 400 });

    // Look up either the fully-registered RWA or a Chainlink-only feed.
    let feed: string | null = null;
    let heartbeat = 86400;
    let name: string | null = null;
    const rwa = findByTicker(ticker);
    if (rwa?.chainlinkFeed) { feed = rwa.chainlinkFeed; heartbeat = rwa.chainlinkHeartbeat ?? 86400; name = rwa.name; }
    else {
      const cl = CHAINLINK_ONLY_FEEDS.find((f) => f.ticker === ticker);
      if (cl) { feed = cl.chainlinkFeed; heartbeat = cl.chainlinkHeartbeat; name = cl.name; }
    }
    if (!feed) {
      return Response.json({
        tool: "rh-rwa-pricing-kit", ticker,
        error: "No Chainlink feed on Robinhood Chain for this ticker. Kit requires a feed.",
      }, { status: 400 });
    }

    const timestamp = new Date().toISOString();
    const quote = await chainlinkLatest(feed as `0x${string}`, heartbeat);

    const abi = `[
  {
    "name": "latestRoundData", "type": "function", "stateMutability": "view",
    "inputs": [],
    "outputs": [
      { "name": "roundId", "type": "uint80" },
      { "name": "answer", "type": "int256" },
      { "name": "startedAt", "type": "uint256" },
      { "name": "updatedAt", "type": "uint256" },
      { "name": "answeredInRound", "type": "uint80" }
    ]
  },
  {
    "name": "decimals", "type": "function", "stateMutability": "view",
    "inputs": [], "outputs": [{ "type": "uint8" }]
  }
]`;

    const clientTs = `// One shared viem client for Robinhood Chain reads.
import { createPublicClient, http } from "viem";
export const rhClient = createPublicClient({
  transport: http("${RH_CHAIN.rpc}"),
  chain: { id: ${RH_CHAIN.chainId}, name: "${RH_CHAIN.name}",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: ["${RH_CHAIN.rpc}"] } },
  },
});`;

    const hookTs = `// Live Chainlink price hook — read-only, no wallet required.
import { useEffect, useState } from "react";
import { rhClient } from "./rhClient";
import aggregatorAbi from "./aggregatorV3Abi.json";

const ${ticker}_FEED = "${feed}";      // Chainlink AggregatorV3 proxy on Robinhood Chain
const REFRESH_MS = 60_000;              // 1 min UI refresh (feed heartbeat is ${heartbeat / 3600}h)

export function use${ticker}Price(): { price: number | null; updatedAt: number | null; loading: boolean } {
  const [price, setPrice] = useState<number | null>(${quote?.price_usd ?? "null"});
  const [updatedAt, setUpdatedAt] = useState<number | null>(${quote?.updated_at ?? "null"});
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    async function tick() {
      setLoading(true);
      try {
        const [round, dec] = await Promise.all([
          rhClient.readContract({ address: ${ticker}_FEED, abi: aggregatorAbi, functionName: "latestRoundData" }),
          rhClient.readContract({ address: ${ticker}_FEED, abi: aggregatorAbi, functionName: "decimals" }),
        ]);
        if (!alive) return;
        setPrice(Number((round as [bigint, bigint, bigint, bigint, bigint])[1]) / Math.pow(10, Number(dec)));
        setUpdatedAt(Number((round as [bigint, bigint, bigint, bigint, bigint])[3]));
      } finally {
        if (alive) setLoading(false);
      }
    }
    tick();
    const id = setInterval(tick, REFRESH_MS);
    return () => { alive = false; clearInterval(id); };
  }, []);
  return { price, updatedAt, loading };
}`;

    const usageTsx = `// Drop into any React component.
import { use${ticker}Price } from "./use${ticker}Price";
export function ${ticker}Badge() {
  const { price, updatedAt, loading } = use${ticker}Price();
  if (loading && price === null) return <span>Loading…</span>;
  if (price === null) return <span>Price unavailable</span>;
  const asOf = updatedAt ? new Date(updatedAt * 1000).toLocaleTimeString() : "";
  return (
    <span title={"as of " + asOf}>
      ${ticker}: <b>${'$'}{price.toFixed(2)}</b>
    </span>
  );
}`;

    return Response.json({
      tool: "rh-rwa-pricing-kit",
      ticker,
      name,
      chainlink_feed: feed,
      heartbeat_seconds: heartbeat,
      current_price_usd: quote?.price_usd ?? null,
      current_updated_at: quote?.updated_at ?? null,
      files: {
        "aggregatorV3Abi.json": abi,
        "rhClient.ts": clientTs,
        [`use${ticker}Price.ts`]: hookTs,
        [`${ticker}Badge.tsx`]: usageTsx,
      },
      dependencies: ["viem ^2", "react ^18"],
      network: RH_CHAIN,
      note: "Standalone read-only kit. No wallet, no server key, no cost per read. Update REFRESH_MS to trade freshness vs RPC load.",
      data_sources: ["Chainlink AggregatorV3 (RH Chain)"],
      timestamp,
    });
  } catch (e) {
    return Response.json({ error: "rh-rwa-pricing-kit failed", message: (e as Error).message }, { status: 500 });
  }
}
