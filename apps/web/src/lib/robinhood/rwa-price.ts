// Robinhood Chain RWA price sources.
//
// Order of preference:
//   1. Chainlink AggregatorV3 on-chain read (proxy → latestRoundData, decimals)
//      — deterministic, oracle-signed, 24h heartbeat per RH docs.
//   2. GeckoTerminal DEX pool spot — a live sanity check + fallback if the
//      Chainlink feed is unmapped (`chainlink-only-feeds` for tickers whose
//      token isn't in the registry yet, or vice-versa).
//
// Never let an LLM invent a stock price. If both sources fail, return null +
// note so the tool can honestly say "insufficient data".

import { createPublicClient, http, type Address } from "viem";
import { robinhoodMainnet } from "@/lib/robinhood/chains";

const AGGREGATOR_V3_ABI = [
  {
    name: "latestRoundData", type: "function", stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId",         type: "uint80"  },
      { name: "answer",          type: "int256"  },
      { name: "startedAt",       type: "uint256" },
      { name: "updatedAt",       type: "uint256" },
      { name: "answeredInRound", type: "uint80"  },
    ],
  },
  {
    name: "decimals", type: "function", stateMutability: "view",
    inputs: [], outputs: [{ type: "uint8" }],
  },
] as const;

let _client: ReturnType<typeof createPublicClient> | null = null;
function rpc() {
  if (_client) return _client;
  _client = createPublicClient({ chain: robinhoodMainnet, transport: http() });
  return _client;
}

export type OnchainQuote = {
  source: "chainlink";
  price_usd: number;
  feed_address: Address;
  feed_decimals: number;
  raw_answer: string;   // BigInt as string
  updated_at: number;   // unix seconds
  age_seconds: number;
  heartbeat_seconds: number;
  is_stale: boolean;    // updated_at more than 2× heartbeat ago
};

export async function chainlinkLatest(feed: Address, heartbeat = 86400): Promise<OnchainQuote | null> {
  try {
    const [data, decRaw] = await Promise.all([
      rpc().readContract({ address: feed, abi: AGGREGATOR_V3_ABI, functionName: "latestRoundData" }),
      rpc().readContract({ address: feed, abi: AGGREGATOR_V3_ABI, functionName: "decimals" }),
    ]);
    // latestRoundData tuple: [roundId, answer, startedAt, updatedAt, answeredInRound]
    const answer   = data[1] as bigint;
    const updated  = Number(data[3] as bigint);
    const decimals = Number(decRaw as number);
    const now = Math.floor(Date.now() / 1000);
    const age = Math.max(0, now - updated);
    const price = Number(answer) / Math.pow(10, decimals);
    return {
      source: "chainlink",
      price_usd: price,
      feed_address: feed,
      feed_decimals: decimals,
      raw_answer: answer.toString(),
      updated_at: updated,
      age_seconds: age,
      heartbeat_seconds: heartbeat,
      is_stale: age > heartbeat * 2,
    };
  } catch {
    return null;
  }
}

export type DexQuote = {
  source: "dex-spot";
  price_usd: number;
  pool_address: string;
  dex: string;
  volume_24h_usd: number | null;
  liquidity_usd: number | null;
  change_24h: number | null;
  pool_url: string | null;
};

/** GeckoTerminal RH Chain price + pool metadata for a token. Free, no key.
 *  Picks whichever side (base / quote) the queried token sits on, so the
 *  returned price is always for our token — never the pool's counter-asset. */
export async function dexPrice(contract: Address): Promise<DexQuote | null> {
  try {
    const r = await fetch(
      `https://api.geckoterminal.com/api/v2/networks/robinhood/tokens/${contract.toLowerCase()}/pools?page=1`,
      { signal: AbortSignal.timeout(6000), headers: { accept: "application/json" } },
    );
    if (!r.ok) return null;
    const d = await r.json() as {
      data?: Array<{
        attributes?: {
          address?: string;
          name?: string;
          base_token_price_usd?: string;
          quote_token_price_usd?: string;
          reserve_in_usd?: string;
          volume_usd?: { h24?: string };
          price_change_percentage?: { h24?: string };
          dex_id?: string;
        };
        relationships?: {
          dex?: { data?: { id?: string } };
          base_token?: { data?: { id?: string } };
          quote_token?: { data?: { id?: string } };
        };
      }>;
    };
    const target = contract.toLowerCase();
    const strip = (id: string | undefined) =>
      id ? (id.startsWith("robinhood_") ? id.slice("robinhood_".length).toLowerCase() : id.toLowerCase()) : "";
    // Materialize each pool with the correct side selected + non-null price.
    const enriched = (d.data ?? []).flatMap((p) => {
      const attr = p.attributes;
      if (!attr?.address) return [];
      const baseId = strip(p.relationships?.base_token?.data?.id);
      const quoteId = strip(p.relationships?.quote_token?.data?.id);
      const isQuoteSide = target === quoteId && target !== baseId;
      const priceStr = isQuoteSide ? attr.quote_token_price_usd : attr.base_token_price_usd;
      if (!priceStr) return [];
      const price = parseFloat(priceStr);
      if (!Number.isFinite(price) || price <= 0) return [];
      return [{ p, attr, priceStr, price }];
    });
    if (!enriched.length) return null;
    enriched.sort((a, b) => parseFloat(b.attr.reserve_in_usd ?? "0") - parseFloat(a.attr.reserve_in_usd ?? "0"));
    const { p, attr, price } = enriched[0];
    const poolAddr = (attr.address ?? "").toLowerCase();
    return {
      source: "dex-spot",
      price_usd: price,
      pool_address: poolAddr,
      dex: p.relationships?.dex?.data?.id ?? attr.dex_id ?? "unknown",
      volume_24h_usd: attr.volume_usd?.h24 ? parseFloat(attr.volume_usd.h24) : null,
      liquidity_usd: attr.reserve_in_usd ? parseFloat(attr.reserve_in_usd) : null,
      change_24h: attr.price_change_percentage?.h24 ? parseFloat(attr.price_change_percentage.h24) : null,
      pool_url: poolAddr ? `https://www.geckoterminal.com/robinhood/pools/${poolAddr}` : null,
    };
  } catch {
    return null;
  }
}

/** Minimal ERC-20 metadata read — used by hub_rh_rwa_verify to prove the
 *  contract is a real token and to surface its self-reported name/symbol. */
const ERC20_META_ABI = [
  { name: "name",     type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { name: "symbol",   type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8"  }] },
  { name: "totalSupply", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

export type OnchainErc20 = {
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  total_supply: string | null;
};

export async function readErc20Meta(contract: Address): Promise<OnchainErc20 | null> {
  try {
    const [name, symbol, decimals, totalSupply] = await Promise.allSettled([
      rpc().readContract({ address: contract, abi: ERC20_META_ABI, functionName: "name" }),
      rpc().readContract({ address: contract, abi: ERC20_META_ABI, functionName: "symbol" }),
      rpc().readContract({ address: contract, abi: ERC20_META_ABI, functionName: "decimals" }),
      rpc().readContract({ address: contract, abi: ERC20_META_ABI, functionName: "totalSupply" }),
    ]);
    // If nothing resolved we treat the address as not a token.
    if (name.status !== "fulfilled" && symbol.status !== "fulfilled") return null;
    return {
      name: name.status === "fulfilled" ? String(name.value) : null,
      symbol: symbol.status === "fulfilled" ? String(symbol.value) : null,
      decimals: decimals.status === "fulfilled" ? Number(decimals.value as number) : null,
      total_supply: totalSupply.status === "fulfilled" ? String(totalSupply.value) : null,
    };
  } catch {
    return null;
  }
}
