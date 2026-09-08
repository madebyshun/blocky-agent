// Robinhood Chain RWA price sources.
//
// Order of preference:
//   1. Chainlink AggregatorV3 on-chain read (proxy → latestRoundData, decimals)
//      — deterministic, oracle-signed, 24h heartbeat per RH docs.
//   2. DEX pool spot — a live sanity check + fallback if the Chainlink feed is
//      unmapped (`chainlink-only-feeds` for tickers whose token isn't in the
//      registry yet, or vice-versa). The DEX *provider* is per-source: RH uses
//      GeckoTerminal, Base uses DexScreener (see `DexFeed` below for why).
//
// Never let an LLM invent a stock price. If both sources fail, return null +
// note so the tool can honestly say "insufficient data".

import { createPublicClient, http, fallback, type Address, type Chain } from "viem";
import { base } from "viem/chains";
import { robinhoodMainnet } from "@/lib/robinhood/chains";

/**
 * DexFeed — which DEX aggregator supplies the *spot price* for this source.
 *
 * WHY THIS IS PER-SOURCE AND NOT GLOBAL: GeckoTerminal's free tier meters by
 * IP, and that budget is shared across every network. The Blue Hood poller
 * reads RH's 24 tickers through GT first (`rwa-market.ts`), then Base's 4 —
 * so by the time the Base reads go out, our own RH desk has already exhausted
 * the per-IP window. Prod logs on 2026-08-24/25 caught this exactly: 12/12
 * Base reads returned `http=429 retry_after=0` in ms=8–15 (instant edge
 * rejection ⟹ the IP is hard-blocked, so an in-cycle retry is futile), against
 * 93 `[gt-fetch] 429` on `networks/robinhood/` in the same window. The Base
 * desk was 100% dark on `dex_unavailable` for that reason and no other.
 *
 * Moving Base onto DexScreener — a completely separate API with its own quota
 * — removes the contention at the root without touching the RH desk (longest
 * track record, do not disturb) and without adding cycle latency.
 *
 * SCOPE: this switches the Base *spot price* only. GeckoTerminal remains the
 * source for RH spot price AND for all OHLCV/sparkline reads (`rwa-market.ts`)
 * on both chains — none of that is touched here.
 *
 * `chain` is required on the dexscreener variant on purpose: DexScreener's
 * chain slug is its own namespace and must NOT be inferred from `gtNetwork`
 * (they coincide at "base" today, which is exactly the kind of coincidence
 * that turns into a silent wrong-chain price later). TypeScript enforces it.
 */
export type DexFeed =
  | { kind: "geckoterminal" }
  | { kind: "dexscreener"; chain: string };

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
 *   Base → { chain: base,             gtNetwork: "base",
 *            dexFeed: { kind: "dexscreener", chain: "base" } }
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
  /** DEX spot-price provider. Omitted ⟹ GeckoTerminal (every pre-existing RH
   *  caller keeps its exact behaviour). See `DexFeed` for why Base differs. */
  dexFeed?: DexFeed;
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
  /** Lowercased addresses of the assets a pool may be priced AGAINST on this
   *  chain. Required — see `ANCHOR_ASSETS` for why this is per-source and why
   *  there is no default. */
  anchors: ReadonlySet<string>;
}

/**
 * ── The quote-asset anchor set (#223) ────────────────────────────────────────
 *
 * A pool's price is an EXCHANGE RATE, not a share price. `TSLAc/USDC` says what
 * a share costs; `TSLAc/STC` says what a share costs *in STC*, and calling that
 * a dollar price is only correct if STC is a dollar. Depth does not fix this —
 * a deep pool against a memecoin is still a deep pool — so sorting candidates
 * by liquidity and taking `[0]`, which is what both readers below used to do,
 * will happily return the STC rate the moment that pool out-ranks the USDC one.
 *
 * The rule is therefore: **the side of the pool that is NOT our token must be a
 * USD-anchored asset.** Stated symmetrically on purpose — `dexPriceGecko`
 * accepts pools where our token sits on the quote side, so "check the quote
 * token" would silently skip half the cases.
 *
 * PER-CHAIN, because the anchor differs: Base settles into **USDC**, RH into
 * **USDG**. A Base-only allowlist applied to this shared read path would blank
 * the entire RH desk. Held on `PriceSource` rather than a module constant so
 * adding a third chain cannot forget it — the field is required, so a source
 * without an anchor set does not compile.
 *
 * WETH is in both sets deliberately. It is not a stablecoin, but it has deep
 * external price discovery that a pool cannot fake, and it carries real depth
 * here: MEASURED 2026-09-08, RH COIN's deepest anchored pool is `COIN/WETH 0.3%`
 * ($535K) ahead of `COIN/USDG 1%` ($403K), and MSTR/TSLA/QQQ/SPY all hold WETH
 * pools in their top five. Dropping WETH would push those onto shallower pools
 * for no safety gain.
 *
 * ⚠️ The zero address is NOT an anchor even though it means native ETH. On
 * Uniswap V4, GeckoTerminal reports native-ETH pools with the counter-token id
 * `0x0000…0000` while NAMING the pool "WETH", so an address-keyed set is what
 * separates them and a name-keyed one would not. Measured the same day, every
 * such pool on the RH desk is a thin 5%-fee V4 pool quoting visibly worse
 * (COIN $190.05 vs $180.23, BABA $115.77 vs $111.79, QQQ $742.25 vs $718.90).
 * Excluding them costs nothing today and removes a class we cannot price-check.
 *
 * ⚠️ DO NOT import `ALLOWED_QUOTE_ASSETS` from
 * `scripts/base-stock-admission-probe.ts` here, and do not make that script
 * import this. The probe's gate 4b inspects the pool THIS CODE selected; if the
 * two shared a constant, the gate would be asserting production's output against
 * production's own rule — a tautology that can never fail. The duplication is
 * the test. Same reasoning as `saneBand` (wide production backstop) vs
 * `SANE_BAND` (tight independent acceptance test) in the registry.
 */
const ANCHOR_ASSETS = {
  /** Base 8453 — USDC is the settlement asset for every B20 pool. */
  base: new Set([
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // USDC
    "0x4200000000000000000000000000000000000006", // WETH
  ]),
  /** RH 4663 — USDG (Global Dollar), NOT USDC. USDC is not the RH anchor. */
  robinhood: new Set([
    "0x5fc5360d0400a0fd4f2af552add042d716f1d168", // USDG
    "0x0bd7d308f8e1639fab988df18a8011f41eacad73", // WETH
  ]),
} as const;

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
  anchors: ANCHOR_ASSETS.robinhood,
};

/**
 * Base mainnet (chainId 8453) source for Coinbase B20 tokenized stocks.
 *
 * Spot price comes from **DexScreener**, not GeckoTerminal — GT's per-IP free
 * quota is consumed by the RH desk earlier in the same poll cycle, which left
 * Base 100% dark on 429s (see `DexFeed`). `gtNetwork: "base"` is retained
 * because it is GT's correct slug for Base and the interface requires it, but
 * after this change nothing on the Base path reads it.
 *
 * Unlike RH, Base stocks carry a `multiplier()` rebase layer on their Chainlink
 * feed (total-return value), so the raw Chainlink answer is NOT the share price
 * — see `@/lib/base-stocks/b20-quote`, which divides it out. This source only
 * wires the chain + price feeds; the multiplier math and the impostor gate
 * (isB20 / decimals==8 / symbol) live in the Base-stocks module and are
 * deliberately untouched by the DEX-provider swap.
 */
export const BASE_PRICE_SOURCE: PriceSource = {
  chain: base,
  gtNetwork: "base",
  dexFeed: { kind: "dexscreener", chain: "base" },
  rpcUrls: baseRpcUrls(),
  multicall: true,
  anchors: ANCHOR_ASSETS.base,
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

/**
 * logDexMiss — one structured line per FAILED `dexPrice` read.
 *
 * WHY THIS EXISTS: every failure path below used to be a bare `return null`
 * with no log, which made the Base desk's total blackout invisible in prod.
 * All four Base B20 tickers reported `dex_unavailable` on 16/16 reads across
 * four cycles (2026-08-24) and there was NOTHING in the logs to say whether
 * the cause was a 429, a 404, a timeout, or a 200-with-no-pools — three of
 * which have completely different fixes. Diagnostic first, fix second.
 *
 * Deliberately failure-only: `dexPrice` is NOT on the RH poller's hot path
 * (that goes through `rwa-market.ts::fetchJson`, which has its own
 * `[gt-fetch]` logging), so this costs ~4 lines per poll cycle — one per Base
 * ticker — and stays silent when the read succeeds.
 *
 * `src=` was added when Base moved to DexScreener: with two providers behind
 * one function, a bare `net=base` line no longer identifies which API failed.
 * The `[dex-price] MISS` prefix is unchanged so existing log greps still work.
 */
function logDexMiss(src: string, net: string, token: string, ms: number, detail: string) {
  console.warn(`[dex-price] MISS src=${src} net=${net} token=${token} ms=${ms} ${detail}`);
}

/**
 * DEX spot price + pool metadata for a token, from whichever provider this
 * source declares. Dispatch happens HERE, inside the price layer, so callers
 * — most importantly `@/lib/base-stocks/b20-quote` — need no change at all:
 * the impostor gate and the multiplier division live there and stay untouched.
 */
export async function dexPrice(
  contract: Address,
  source: PriceSource = RH_PRICE_SOURCE,
): Promise<DexQuote | null> {
  const feed = source.dexFeed ?? { kind: "geckoterminal" as const };
  return feed.kind === "dexscreener"
    ? dexPriceDexScreener(contract, feed.chain, source.anchors)
    : dexPriceGecko(contract, source.gtNetwork, source.anchors);
}

/** GeckoTerminal price + pool metadata for a token. Free, no key.
 *  Picks whichever side (base / quote) the queried token sits on, so the
 *  returned price is always for our token — never the pool's counter-asset.
 *
 *  ── #223: why this reader needed the anchor rule too ───────────────────────
 *  It is tempting to think GT is immune: it publishes `base_token_price_usd` /
 *  `quote_token_price_usd` computed from ITS OWN cross-market view, so a
 *  hijacked pool does not move the price the way DexScreener's `priceUsd` does.
 *  That is true of the PRICE and false of everything else. `pool_address`,
 *  `liquidity_usd`, `volume_24h_usd` and `change_24h` are all read off the
 *  winning pool verbatim, and `liquidity_usd`/`volume_24h_usd` feed the
 *  dead-pool liveness gate in `rule-engine.ts` — the gate that decides whether
 *  an arrow is allowed to fire at all.
 *
 *  MEASURED 2026-09-08, and this one had already happened: RH **NVDA** resolved
 *  to the `AI / NVDA` pool (liquidity $21.9M, 24h volume $3.2M) instead of
 *  `NVDA / USDG 0.05%` (liquidity $6.4M, 24h volume $31.9M). The price was
 *  right to within 0.17%; the reported depth was 3.4× too high and the volume
 *  was 10× too LOW. Same shape on MU ($36.0M/$66K reported against the real
 *  $1.7M/$3.4M), and on ORCL, SNDK, USAR, CRWV, INTC, QQQ — 8 of 24 RH tickers
 *  were priced on a pool whose metadata belonged to some other token. */
async function dexPriceGecko(
  contract: Address,
  net: string,
  anchors: ReadonlySet<string>,
): Promise<DexQuote | null> {
  const token = contract.toLowerCase();
  const t0 = Date.now();
  try {
    const r = await fetch(
      `https://api.geckoterminal.com/api/v2/networks/${net}/tokens/${token}/pools?page=1`,
      { signal: AbortSignal.timeout(6000), headers: { accept: "application/json" } },
    );
    if (!r.ok) {
      // 429 = rate-limited (the suspected cause); 404 = token not indexed on
      // this network; 5xx = GT-side. `retry-after` is logged verbatim because
      // GT often sends "0" or omits it, which changes the retry strategy.
      const retryAfter = r.status === 429 ? ` retry_after=${r.headers.get("retry-after") ?? "none"}` : "";
      logDexMiss("geckoterminal", net, token, Date.now() - t0, `http=${r.status}${retryAfter}`);
      return null;
    }
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
    const target = token;
    const prefix = `${net}_`;
    const strip = (id: string | undefined) =>
      id ? (id.startsWith(prefix) ? id.slice(prefix.length).toLowerCase() : id.toLowerCase()) : "";
    // Materialize each pool with the correct side selected + non-null price.
    let unanchored = 0;
    const enriched = (d.data ?? []).flatMap((p) => {
      const attr = p.attributes;
      if (!attr?.address) return [];
      const baseId = strip(p.relationships?.base_token?.data?.id);
      const quoteId = strip(p.relationships?.quote_token?.data?.id);
      const isQuoteSide = target === quoteId && target !== baseId;
      // #223 — the OTHER side must be USD-anchored. Symmetric, because our token
      // can sit on either side here: whichever side is not ours is the one whose
      // value we are implicitly quoting in.
      const counterAsset = isQuoteSide ? baseId : quoteId;
      if (!anchors.has(counterAsset)) { unanchored++; return []; }
      const priceStr = isQuoteSide ? attr.quote_token_price_usd : attr.base_token_price_usd;
      if (!priceStr) return [];
      const price = parseFloat(priceStr);
      if (!Number.isFinite(price) || price <= 0) return [];
      return [{ p, attr, priceStr, price }];
    });
    if (!enriched.length) {
      // Three very different causes, separated because they need opposite fixes:
      //   pools=0     → GT does not index this token on this network at all
      //                 (wrong slug / unindexed pool) — retrying never helps.
      //   unanchored  → pools exist but every one is quoted against something
      //                 that is not USD-anchored (#223). NOT an outage: the
      //                 honest answer for a token with no dollar-denominated
      //                 market is "no price", not a memecoin exchange rate.
      //   usable=0    → anchored pools exist but none priced OUR token on
      //                 either side (missing *_token_price_usd, id mismatch).
      const pools = d.data?.length ?? 0;
      logDexMiss(
        "geckoterminal", net, token, Date.now() - t0,
        pools === 0
          ? "http=200 pools=0 (token not indexed on this network)"
          : `http=200 pools=${pools} usable=0 unanchored=${unanchored} (no USD-anchored pool priced this token)`,
      );
      return null;
    }
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
  } catch (e) {
    // `TimeoutError` = we hit the 6s AbortSignal (ms= will read ~6000);
    // anything else is a DNS/TLS/socket failure. Distinguishing the two
    // decides whether the fix is a longer timeout or a retry.
    const err = e as Error;
    logDexMiss("geckoterminal", net, token, Date.now() - t0, `throw=${err.name}: ${err.message}`);
    return null;
  }
}

/** DexScreener token-pairs response — only the fields we consume. */
type DsPair = {
  chainId?: string;
  dexId?: string;
  url?: string;
  pairAddress?: string;
  baseToken?: { address?: string; symbol?: string };
  quoteToken?: { address?: string; symbol?: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  priceChange?: { h24?: number };
};

/** `liquidity.usd` / `volume.h24` are numbers in the DS schema but are absent on
 *  thin pairs — normalise to a real number or null, never NaN. */
function dsNum(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * DexScreener price + pool metadata for a token. Free, no key, quota separate
 * from GeckoTerminal's — which is the entire point (see `DexFeed`).
 *
 * TWO SAFETY RULES, both load-bearing:
 *
 *  1. **Chain filter.** The token endpoint is address-keyed and returns pairs
 *     across EVERY chain DS indexes. The same address can exist on another
 *     chain, so anything not on `chain` is discarded before we look at a price.
 *
 *  2. **Base-side pairs only.** DexScreener's `priceUsd` is always the price of
 *     the pair's `baseToken`. When our token sits on the quote side, `priceUsd`
 *     is the COUNTER-asset's price — reading it would report (e.g.) USDC's $1
 *     as NVDA's share price and hand the drift engine a ~99% fake gap. It is
 *     derivable via `priceUsd / priceNative`, but we do not need it: verified
 *     2026-08-25 across all four B20 tickers then live, the deepest Base pair is
 *     the base-side Aerodrome/USDC pool in every case (NVDA $1.06M, GOOGL $742K,
 *     AAPL $713K, META $671K liquidity), so base-side-only loses no depth. The
 *     skipped quote-side count is logged so a future regression is visible
 *     rather than silent.
 *
 *  3. **USD-anchored quote asset (#223).** Rules 1–2 keep us on the side of the
 *     pair whose price `priceUsd` reports; neither asks what the OTHER side is,
 *     so the deepest-liquidity sort could hand back an exchange rate against an
 *     arbitrary token as if it were a share price. `quoteToken.address` must now
 *     be in this source's `anchors` set (see `ANCHOR_ASSETS`).
 *
 * MEASURED 2026-09-08 on TSLAc (an admission candidate, NOT yet in BASE_STOCKS):
 * before rule 3 this function returned **$14,226.33** against a ~$358 Chainlink
 * share price — 39.7× wrong — because DexScreener labels the illiquid
 * `TSLAc/STC` V4 pool ($263,361) with TSLAc on the base side and it out-ranked
 * the genuine `TSLAc/USDC` Aerodrome pool ($185,546, $358.08). Rule 3 drops the
 * STC pool and returns $358.08.
 *
 * WHY THE ANCHORED BUCKET DOES NOT FALL THROUGH TO AN UNANCHORED POOL: an
 * earlier draft of this comment proposed partitioning and falling back "only
 * when the first bucket is empty". That is `resolvePrimaryPool`'s step 3 in
 * `rwa-market.ts`, and it reintroduces exactly the bug — the fallback fires
 * precisely in the case the rule exists to catch. Measured the same day, the
 * fallback is also unnecessary: 0 of 24 RH tickers and 0 of 7 admitted Base
 * tickers lack an anchored pool. So an empty bucket returns `null`, which
 * surfaces as the honest `dex_unavailable` that #140 built.
 *
 * BLAST RADIUS OF THE OLD BEHAVIOUR ON BASE: none — all seven admitted tickers
 * already resolved to their USDC pool and are byte-identical after this change.
 * The defect was live only on the RH side (see `dexPriceGecko`) and on TSLA,
 * which is why TSLA admission was blocked behind this fix.
 */
async function dexPriceDexScreener(
  contract: Address,
  chain: string,
  anchors: ReadonlySet<string>,
): Promise<DexQuote | null> {
  const token = contract.toLowerCase();
  const t0 = Date.now();
  try {
    const r = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${token}`,
      {
        signal: AbortSignal.timeout(6000),
        // DS 403s some default UAs (Node's bare fetch included) — identify us.
        headers: { accept: "application/json", "user-agent": "blue-agent/1.0 (+https://blueagent.dev)" },
      },
    );
    if (!r.ok) {
      const retryAfter = r.status === 429 ? ` retry_after=${r.headers.get("retry-after") ?? "none"}` : "";
      logDexMiss("dexscreener", chain, token, Date.now() - t0, `http=${r.status}${retryAfter}`);
      return null;
    }
    const d = await r.json() as { pairs?: DsPair[] | null };
    const pairs = d.pairs ?? [];
    if (!pairs.length) {
      // DS returns `pairs: null` for an address it has never indexed.
      logDexMiss("dexscreener", chain, token, Date.now() - t0, "http=200 pairs=0 (token not indexed)");
      return null;
    }
    const onChain = pairs.filter((p) => p.chainId === chain);
    if (!onChain.length) {
      // Indexed, but not on the chain we asked for — a config/slug error, never
      // a transient one. `chains_seen` names the mistake outright.
      const seen = [...new Set(pairs.map((p) => p.chainId).filter(Boolean))].slice(0, 5).join(",");
      logDexMiss(
        "dexscreener", chain, token, Date.now() - t0,
        `http=200 pairs=${pairs.length} on_chain=0 (chains_seen=${seen || "none"})`,
      );
      return null;
    }
    let quoteSideSkipped = 0;
    let unanchored = 0;
    const usable = onChain.flatMap((p) => {
      if ((p.baseToken?.address ?? "").toLowerCase() !== token) {
        quoteSideSkipped++;
        return [];
      }
      // #223 — rule 3. Rule 2 already pinned our token to the base side, so the
      // "other side" is unambiguously the quote token here.
      if (!anchors.has((p.quoteToken?.address ?? "").toLowerCase())) {
        unanchored++;
        return [];
      }
      const price = parseFloat(p.priceUsd ?? "");
      if (!Number.isFinite(price) || price <= 0) return [];
      return [{ p, price, liq: dsNum(p.liquidity?.usd) }];
    });
    if (!usable.length) {
      // `unanchored` separates "this token has no dollar market" from the
      // pre-existing "DS indexed it but priced nothing" — opposite fixes, and
      // only the first is a legitimate reason to stay dark.
      logDexMiss(
        "dexscreener", chain, token, Date.now() - t0,
        `http=200 pairs=${pairs.length} on_chain=${onChain.length} usable=0 quote_side_skipped=${quoteSideSkipped} unanchored=${unanchored}`,
      );
      return null;
    }
    usable.sort((a, b) => (b.liq ?? 0) - (a.liq ?? 0));
    const { p, price, liq } = usable[0];
    const poolAddr = (p.pairAddress ?? "").toLowerCase();
    return {
      source: "dex-spot",
      price_usd: price,
      pool_address: poolAddr,
      dex: p.dexId ?? "unknown",
      volume_24h_usd: dsNum(p.volume?.h24),
      liquidity_usd: liq,
      change_24h: dsNum(p.priceChange?.h24),
      pool_url: p.url ?? (poolAddr ? `https://dexscreener.com/${chain}/${poolAddr}` : null),
    };
  } catch (e) {
    const err = e as Error;
    logDexMiss("dexscreener", chain, token, Date.now() - t0, `throw=${err.name}: ${err.message}`);
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
