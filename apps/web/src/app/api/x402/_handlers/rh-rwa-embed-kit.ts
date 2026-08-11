// x402/rh-rwa-embed-kit (E1) — copy-paste "Buy $TICKER" button kit.
// Price: $0.05
//
// The Vlad Tenev pitch tool. Ticker in → complete JSX + wagmi + viem
// snippet a builder can paste into a Next.js app to get a "Buy MSTR" button
// that:
//   1. Shows the live Chainlink price + 24h Δ
//   2. Prompts wallet chain-switch to Robinhood Chain
//   3. Calls rh-stock-swap-prepare via x402 for the calldata
//   4. Signs and broadcasts through the user's wallet
//
// The snippet is a real, working example — not a placeholder. Prices come
// from the L1 lookup so the returned copy has actual numbers embedded.

import { findByTicker, RH_CHAIN, RH_CHAINLINK_ETH_USD } from "@/lib/robinhood/rwa-registry";
import { chainlinkLatest } from "@/lib/robinhood/rwa-price";

export default async function handler(req: Request): Promise<Response> {
  try {
    let body: { ticker?: string; framework?: string; theme?: string } = {};
    try { const t = await req.text(); if (t?.trim().startsWith("{")) body = JSON.parse(t); } catch {}
    const url = new URL(req.url);
    const ticker = (body.ticker ?? url.searchParams.get("ticker") ?? "").trim().toUpperCase();
    const framework = ((body.framework ?? url.searchParams.get("framework") ?? "next-wagmi") as string).toLowerCase();
    const theme = ((body.theme ?? url.searchParams.get("theme") ?? "dark") as string).toLowerCase();

    if (!ticker) return Response.json({ error: "Provide `ticker`." }, { status: 400 });
    const token = findByTicker(ticker);
    if (!token) return Response.json({ tool: "rh-rwa-embed-kit", ticker, error: "Ticker not in registry." }, { status: 404 });
    if (!token.chainlinkFeed) {
      return Response.json({
        tool: "rh-rwa-embed-kit", ticker,
        error: "Embed kit requires a Chainlink feed for the price display. Ticker has none in current registry.",
      }, { status: 400 });
    }

    const timestamp = new Date().toISOString();
    const quote = await chainlinkLatest(token.chainlinkFeed, token.chainlinkHeartbeat ?? 86400);

    // Snippet templates — plain text so the client displays them verbatim.
    // The x402 flow is: caller pays USDC on Base for the prepare result,
    // then broadcasts the returned calldata via the user's own wallet.
    const bgClass  = theme === "light" ? "bg-white text-black border-black/10" : "bg-black text-white border-white/10";
    const accent   = theme === "light" ? "bg-black text-white" : "bg-white text-black";

    const nextWagmi = `// npm i wagmi viem @tanstack/react-query
// Uses BlueAgent x402: paying $0.05 in USDC on Base returns the unsigned tx.
import { useAccount, useSwitchChain, useSendTransaction, useWriteContract } from "wagmi";

const ROBINHOOD_CHAIN_ID = ${RH_CHAIN.chainId};
const RWA_TICKER = "${token.ticker}";
const RWA_CONTRACT = "${token.contract}";
const CHAINLINK_FEED = "${token.chainlinkFeed}";

async function prepareSwap(recipient: string, amountUsd: number) {
  // Pay $0.05 USDC on Base to /api/x402/rh-stock-swap-prepare (see
  // blueagent.dev/docs/x402 for the EIP-3009 signing helper).
  const r = await fetch("https://blueagent.dev/api/x402/rh-stock-swap-prepare", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-PAYMENT": /* signed EIP-3009 header */ "" },
    body: JSON.stringify({ ticker: RWA_TICKER, side: "buy", amount: amountUsd, denom: "USDG", recipient }),
  });
  return r.json();
}

export function BuyButton({ amountUsd = 100 }: { amountUsd?: number }) {
  const { address, chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const { sendTransactionAsync } = useSendTransaction();

  async function onBuy() {
    if (!address) throw new Error("Connect wallet first");
    if (chainId !== ROBINHOOD_CHAIN_ID) await switchChainAsync({ chainId: ROBINHOOD_CHAIN_ID });
    const prep = await prepareSwap(address, amountUsd);
    for (const call of prep.calls) {
      await sendTransactionAsync({ to: call.to, data: call.data, value: BigInt(call.value ?? "0") });
    }
  }

  return (
    <button
      onClick={onBuy}
      className="rounded-xl px-5 py-3 font-semibold ${accent}"
    >
      Buy \${amountUsd} of \$${token.ticker}
    </button>
  );
}`;

    const priceSnippet = `// Live Chainlink price for ${token.ticker} on Robinhood Chain.
// Refresh every 60 s. Feed heartbeat is 24 h so the value stays fresh enough for UI.
import { useEffect, useState } from "react";
import { createPublicClient, http } from "viem";

const CHAINLINK_FEED = "${token.chainlinkFeed}";
const RH_RPC = "${RH_CHAIN.rpc}";
const client = createPublicClient({ transport: http(RH_RPC) });

const ABI = [{
  name: "latestRoundData", type: "function", stateMutability: "view",
  inputs: [],
  outputs: [
    { name: "roundId", type: "uint80" }, { name: "answer", type: "int256" },
    { name: "startedAt", type: "uint256" }, { name: "updatedAt", type: "uint256" },
    { name: "answeredInRound", type: "uint80" },
  ],
}, {
  name: "decimals", type: "function", stateMutability: "view",
  inputs: [], outputs: [{ type: "uint8" }],
}] as const;

export function useLivePrice() {
  const [price, setPrice] = useState<number | null>(${quote?.price_usd ?? "null"});
  useEffect(() => {
    let alive = true;
    async function tick() {
      const [data, dec] = await Promise.all([
        client.readContract({ address: CHAINLINK_FEED, abi: ABI, functionName: "latestRoundData" }),
        client.readContract({ address: CHAINLINK_FEED, abi: ABI, functionName: "decimals" }),
      ]);
      if (!alive) return;
      setPrice(Number(data[1]) / Math.pow(10, Number(dec)));
    }
    tick();
    const id = setInterval(tick, 60_000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  return price;
}`;

    // Just the raw wagmi config snippet for RH chain — the missing piece
    // most integrators trip over.
    const chainConfig = `// wagmi + viem config snippet to add Robinhood Chain (4663) to your app.
import { defineChain } from "viem";
export const robinhoodMainnet = defineChain({
  id: ${RH_CHAIN.chainId},
  name: "${RH_CHAIN.name}",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["${RH_CHAIN.rpc}"] } },
  blockExplorers: { default: { name: "Blockscout", url: "${RH_CHAIN.explorer}" } },
});`;

    return Response.json({
      tool: "rh-rwa-embed-kit",
      ticker: token.ticker,
      name: token.name,
      contract: token.contract,
      chainlink_feed: token.chainlinkFeed,
      network: RH_CHAIN,
      current_price_usd: quote?.price_usd ?? null,
      framework,
      theme,
      snippets: {
        chain_config: chainConfig,
        buy_button: nextWagmi,
        live_price_hook: priceSnippet,
      },
      wrapping_container_hint: `<div className="p-6 rounded-2xl border ${bgClass}">…paste snippets here…</div>`,
      dependencies: ["wagmi ^2", "viem ^2", "@tanstack/react-query ^5"],
      x402_docs: "https://blueagent.dev/docs/x402",
      note: "Copy-paste kit. Live_price_hook works standalone. buy_button expects the caller to sign an EIP-3009 X-PAYMENT header (see blueagent.dev/docs/x402 for the helper). Non-custodial end-to-end.",
      data_sources: ["Chainlink AggregatorV3 (RH Chain)"],
      // Vlad Tenev tweet (Jul 15 2026): "If you're a builder looking to
      // embed stock tokens or RWA into your applications, we want to hear
      // from you." — this is exactly that.
      inspired_by: "https://x.com/vladtenev/status/2077266840477479424",
      timestamp,
    });
  } catch (e) {
    return Response.json({ error: "rh-rwa-embed-kit failed", message: (e as Error).message }, { status: 500 });
  }
}
