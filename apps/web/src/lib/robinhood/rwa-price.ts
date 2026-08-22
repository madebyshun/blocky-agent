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

import { createPublicClient, http, fallback, type Address, type Chain } from "viem";
import { base } from "viem/chains";
import { robinhoodMainnet } from "@/lib/robinhood/chains";

/**
 * PriceSource — the per-chain adapter that makes every read in this file
 * chain-agnostic. This module used to be hardcoded to Robinhood Chain in FOUR
 * places: the RPC chain, the GeckoTerminal tokens URL, the GT token-id prefix,
 * and the GT pool permalink. Three of those four are the SAME GeckoTerminal
 * network slug ("robinhood") appearing in three URL/id contexts — they must
 * always agree (you cannot read the tokens API on `base` but build a pool link
 * on `robinhood`), so they collapse into a single `gtNetwork` field. Keeping
 * them as one field structurally prevents the misconfiguration where the three
 * drift apart — which would be a silent wrong-chain price bug.
 *
 *   RH   → { chain: robinhoodMainnet, gtNetwork: "robinhood" }
 *   Base → { chain: base,             gtNetwork: "base" }   (added in Phase 2)
 *
 * Every exported reader takes `source` as a trailing optional arg defaulting to
 * `RH_PRICE_SOURCE`, so all pre-existing RH callers are byte-identical.
 */
export interface PriceSource {
  /** viem chain used for on-chain reads (Chainlink feed, ERC-20 metadata). */
  chain: Chain;
  /** GeckoTerminal network slug — used in the tokens URL, the `<net>_<addr>`
   *  token-id prefix GT prepends, and the pool permalink. */
  gtNetwork: string;
  /** Explicit RPC endpoints. When set, reads use a viem `fallback` transport
   *  across them (cross-endpoint failover) instead of the chain's single default
   *  RPC. RH omits this — its default RPC is reliable and singular. Base sets a
   *  list because the free public Base endpoints rate-limit hard under the
   *  poller's concurrent reads (a single endpoint drops calls; a fallback list
   *  survives). Override via `BASE_RPC_URLS` / `BASE_RPC_URL` env. */
  rpcUrls?: string[];
  /** Enable viem multicall batching (collapses concurrent `eth_call`s into one
   *  Multicall3 call — ~5× fewer requests). ONLY safe where Multicall3 is
   *  deployed at the canonical address: true for Base, OMITTED for RH (no
   *  Multicall3 there yet — task #88), so RH client construction stays
   *  byte-identical to the pre-multichain path. */
  multicall?: boolean;
}

// Reliable keyless Base RPCs, in fallback order. Verified 2026-08-23 to serve
// contract reads (NVDA `multiplier()` → 1e18). `base.llamarpc.com` (CF 521) and
// `base.meowrpc.com` (eth_call disabled) were rejected during that check.
const DEFAULT_BASE_RPCS = [
  "https://base-rpc.publicnode.com",
  "https://base.drpc.org",
  "https://mainnet.base.org",
  "https://1rpc.io/base",
];
function baseRpcUrls(): string[] {
  const env =
    (typeof process !== "undefined" &&
      (process.env.BASE_RPC_URLS || process.env.BASE_RPC_URL)) ||
    "";
  const fromEnv = env.split(",").map((s) => s.trim()).filter(Boolean);
  return fromEnv.length ? fromEnv : DEFAULT_BASE_RPCS;
}

export const RH_PRICE_SOURCE: PriceSource = {
  chain: robinhoodMainnet,
  gtNetwork: "robinhood",
};

/**
 * Base mainnet (chainId 8453) source for Coinbase B20 tokenized stocks.
 * `gtNetwork: "base"` is GeckoTerminal's slug for Base — verified indexing
 * Aerodrome Slipstream pools for the B20 tickers. Unlike RH, Base stocks carry
 * a `multiplier()` rebase layer on their Chainlink feed (total-return value),
 * so the raw Chainlink answer is NOT the share price — see
 * `@/lib/base-stocks/b20-quote`, which divides it out. This source only wires
 * the chain + GT slug; the multiplier math lives in the Base-stocks module.
 */
export const BASE_PRICE_SOURCE: PriceSource = {
  chain: base,
  gtNetwork: "base",
  rpcUrls: baseRpcUrls(),
  multicall: true,
};

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

// One cached viem client PER chain id. RH callers still resolve to a single
// shared client (identical to the pre-multichain behaviour); a Base source gets
// its own client keyed by chain id, so the two never cross-talk. Exported as
// `clientForSource` so the Base-stocks module reads B20 multiplier/pause/isB20
// on the SAME cached client — letting viem multicall-batch those reads together
// with the Chainlink feed read in a single cycle.
const _clients = new Map<number, ReturnType<typeof createPublicClient>>();
export function clientForSource(source: PriceSource = RH_PRICE_SOURCE) {
  const existing = _clients.get(source.chain.id);
  if (existing) return existing;
  const transport = source.rpcUrls?.length
    ? fallback(source.rpcUrls.map((u) => http(u)))
    : http();
  const client = createPublicClient({
    chain: source.chain,
    transport,
    // Multicall batching only where Multicall3 exists (Base). Omitting the
    // `batch` key entirely on RH keeps its client byte-identical to before.
    ...(source.multicall ? { batch: { multicall: true } } : {}),
  });
  _clients.set(source.chain.id, client);
  return client;
}
// Back-compat local alias — every existing reader in this file calls `rpc()`.
const rpc = clientForSource;

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

export async function chainlinkLatest(
  feed: Address,
  heartbeat = 86400,
  source: PriceSource = RH_PRICE_SOURCE,
): Promise<OnchainQuote | null> {
  try {
    const [data, decRaw] = await Promise.all([
      rpc(source).readContract({ address: feed, abi: AGGREGATOR_V3_ABI, functionName: "latestRoundData" }),
      rpc(source).readContract({ address: feed, abi: AGGREGATOR_V3_ABI, functionName: "decimals" }),
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
export async function dexPrice(
  contract: Address,
  source: PriceSource = RH_PRICE_SOURCE,
): Promise<DexQuote | null> {
  const net = source.gtNetwork;
  try {
    const r = await fetch(
      `https://api.geckoterminal.com/api/v2/networks/${net}/tokens/${contract.toLowerCase()}/pools?page=1`,
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
    const prefix = `${net}_`;
    const strip = (id: string | undefined) =>
      id ? (id.startsWith(prefix) ? id.slice(prefix.length).toLowerCase() : id.toLowerCase()) : "";
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
      pool_url: poolAddr ? `https://www.geckoterminal.com/${net}/pools/${poolAddr}` : null,
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

export async function readErc20Meta(
  contract: Address,
  source: PriceSource = RH_PRICE_SOURCE,
): Promise<OnchainErc20 | null> {
  try {
    const [name, symbol, decimals, totalSupply] = await Promise.allSettled([
      rpc(source).readContract({ address: contract, abi: ERC20_META_ABI, functionName: "name" }),
      rpc(source).readContract({ address: contract, abi: ERC20_META_ABI, functionName: "symbol" }),
      rpc(source).readContract({ address: contract, abi: ERC20_META_ABI, functionName: "decimals" }),
      rpc(source).readContract({ address: contract, abi: ERC20_META_ABI, functionName: "totalSupply" }),
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
