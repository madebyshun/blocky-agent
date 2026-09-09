// Robinhood Chain RWA market-data helpers (Phase 2 skills).
//
// Wraps GeckoTerminal's RH Chain endpoints with:
//   • timeouts
//   • lightweight in-memory memo (60s) — Vercel serverless is stateless, but
//     within a single warm invocation this collapses N calls to 1 network.
//   • honest null-returns on error (never guess numbers)

import { RH_PRICE_SOURCE } from "./rwa-price";

const GT = "https://api.geckoterminal.com/api/v2/networks/robinhood";

type Cache<T> = { at: number; data: T };
const MEMO = new Map<string, Cache<unknown>>();
const TTL_MS = 60_000;

/**
 * cacheAgeS — public helper so upstream (poller, snapshot) can attribute
 * freshness to a specific URL. Returns null if the URL was never fetched
 * or the memo has expired. Never touches network.
 */
export function cacheAgeS(url: string): number | null {
  const c = MEMO.get(url) as Cache<unknown> | undefined;
  if (!c) return null;
  const age = (Date.now() - c.at) / 1000;
  if (age > TTL_MS / 1000) return null;
  return age;
}

/**
 * fetchJson — GT wrapper with:
 *   • 60s in-memory memo (survives across handler invocations on the same
 *     warm instance — safely re-served without network)
 *   • honest null on failure (never fabricate)
 *   • 429 handling — logs `[gt-fetch]` and honors `Retry-After` (or 5s)
 *     with a single retry, so the burst-N-then-cool pattern GT free tier
 *     enforces doesn't silently trash the poller
 *   • status logging on any non-200 so downstream (Blue Hood poller,
 *     alerts) can attribute NO_DATA rows to the actual cause
 */
async function fetchJson<T>(url: string, timeoutMs = 6000): Promise<T | null> {
  const now = Date.now();
  const cached = MEMO.get(url) as Cache<T> | undefined;
  if (cached && now - cached.at < TTL_MS) return cached.data;
  // 2 retries — 429 windows tend to reset within 5-10s so two attempts
  // (5s + 5-15s waits) cover typical bursts without extending too far.
  return doFetch<T>(url, timeoutMs, 2);
}

async function doFetch<T>(url: string, timeoutMs: number, retriesLeft: number): Promise<T | null> {
  try {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json;version=20230302" },
    });
    if (r.status === 429) {
      // GT's `retry-after` on the RH endpoint is often "0" or missing — the
      // rate window resets on a fixed cadence, not per-request. Minimum
      // wait 5s prevents us from re-hammering an already-cooked window.
      const retryAfter = Number(r.headers.get("retry-after") ?? "5");
      const waitMs = Math.min(15_000, Math.max(5_000, retryAfter * 1000));
      console.warn(`[gt-fetch] 429 rate-limited ${url} retry_after_s=${retryAfter} wait_ms=${waitMs} retrying=${retriesLeft > 0}`);
      if (retriesLeft > 0) {
        await new Promise((res) => setTimeout(res, waitMs));
        return doFetch<T>(url, timeoutMs, retriesLeft - 1);
      }
      return null;
    }
    if (!r.ok) {
      console.warn(`[gt-fetch] non-200 status=${r.status} ${url}`);
      return null;
    }
    const d = (await r.json()) as T;
    MEMO.set(url, { at: Date.now(), data: d });
    return d;
  } catch (e) {
    // AbortController timeout / network error. Silent under normal use
    // (already handled by callers via null return) but logged so a burst
    // of timeouts is visible.
    console.warn(`[gt-fetch] error ${url} ${(e as Error).name}: ${(e as Error).message}`);
    return null;
  }
}

// ─── Pool metadata (used by M3 liquidity + M5 arb) ─────────────────────────

export type PoolMeta = {
  /** GeckoTerminal-reported identifier. On RH Chain this is a 32-byte
   *  Uniswap V4 pool ID (in the singleton PoolManager), NOT an EOA-style
   *  20-byte contract address. `is_v4_pool_id` disambiguates. */
  pool_ref: string;
  is_v4_pool_id: boolean;
  /** Kept as `address` alias for back-compat with early callers. */
  address: string;
  name: string;
  dex: string;
  base_token: string;         // lowercased addr, no chain prefix
  quote_token: string;        // lowercased addr, no chain prefix
  /**
   * The side of this pool that is NOT the token we queried — i.e. the asset
   * `price_usd` is implicitly denominated in. Derived from `token_is_base`, so
   * it is correct whichever side our token landed on, and it is the ONLY field
   * the anchor rule should ever be applied to (#227). Checking `quote_token`
   * alone silently skips every pool where our token sits on the quote side.
   *
   * When `poolFromItem` is called without `forToken` (`topPools`), our token is
   * by definition the base side, so this is the quote token.
   */
  counterparty_token: string;
  price_usd: number;          // ALWAYS for the token we queried
  /** The counterparty token's USD price (WETH ~$1800, USDG ~$1). Not a
   *  liquidity value — renamed from `counterparty_usd` for clarity. */
  counterparty_token_price_usd: number | null;
  /** @deprecated Use counterparty_token_price_usd. Kept for one release. */
  counterparty_usd: number | null;
  token_is_base: boolean;     // true if our token is on the base side of the pool
  reserve_usd: number;
  /** Approximate one-side USD depth used by xy=k first-order slippage.
   *  For balanced pools this is reserve_usd / 2; the true value can
   *  deviate if the pool is out-of-range in Uniswap V4. */
  one_side_usd: number;
  volume_24h_usd: number | null;
  change_1h: number | null;
  change_24h: number | null;
  fee_bps: number | null;
  url: string;
};

type PoolAttrs = {
  address?: string;
  name?: string;
  base_token_price_usd?: string;
  quote_token_price_usd?: string;
  reserve_in_usd?: string;
  volume_usd?: { h1?: string; h24?: string };
  price_change_percentage?: { h1?: string; h24?: string };
  pool_created_at?: string;
  base_token_address?: string;
  quote_token_address?: string;
  pool_fee_bps?: string | number;
};

type PoolItem = {
  attributes?: PoolAttrs;
  relationships?: {
    dex?: { data?: { id?: string } };
    base_token?: { data?: { id?: string } };
    quote_token?: { data?: { id?: string } };
  };
};

/** Strip GeckoTerminal's "robinhood_" chain prefix from token relationship IDs. */
function stripChainPrefix(id: string | undefined): string {
  if (!id) return "";
  return id.startsWith("robinhood_") ? id.slice("robinhood_".length).toLowerCase() : id.toLowerCase();
}

/**
 * Build a PoolMeta from a GT pool item. If `forToken` is set, the tool selects
 * whichever side (base / quote) matches that token so `price_usd` is the price
 * of *that* token, not the pool's default base. Otherwise defaults to base.
 */
function poolFromItem(p: PoolItem, forToken?: string): PoolMeta | null {
  const attr = p.attributes;
  if (!attr?.address) return null;
  const baseId = stripChainPrefix(p.relationships?.base_token?.data?.id);
  const quoteId = stripChainPrefix(p.relationships?.quote_token?.data?.id);
  const target = forToken?.toLowerCase();
  const isQuoteSide = !!(target && target === quoteId && target !== baseId);
  const tokenIsBase = !isQuoteSide;
  const priceStr = isQuoteSide ? attr.quote_token_price_usd : attr.base_token_price_usd;
  const counterpartyStr = isQuoteSide ? attr.base_token_price_usd : attr.quote_token_price_usd;
  if (!priceStr) return null;
  const price = parseFloat(priceStr);
  if (!Number.isFinite(price) || price <= 0) return null;
  const cp = counterpartyStr ? parseFloat(counterpartyStr) : NaN;
  const cpVal = Number.isFinite(cp) && cp > 0 ? cp : null;
  const poolRef = attr.address.toLowerCase();
  // RH Chain runs Uniswap V4 in a singleton PoolManager, so GT's "address"
  // for a pool is a 32-byte pool ID (64 hex chars + 0x). Legacy V3 pools
  // still use 20-byte contract addresses (40 hex chars).
  const isV4PoolId = poolRef.length >= 66;
  const reserve = parseFloat(attr.reserve_in_usd ?? "0");
  return {
    pool_ref: poolRef,
    is_v4_pool_id: isV4PoolId,
    address: poolRef, // back-compat
    name: attr.name ?? "",
    dex: p.relationships?.dex?.data?.id ?? "unknown",
    base_token: baseId,
    quote_token: quoteId,
    counterparty_token: isQuoteSide ? baseId : quoteId,
    price_usd: price,
    counterparty_token_price_usd: cpVal,
    counterparty_usd: cpVal, // deprecated alias
    token_is_base: tokenIsBase,
    reserve_usd: reserve,
    one_side_usd: reserve / 2,
    volume_24h_usd: attr.volume_usd?.h24 ? parseFloat(attr.volume_usd.h24) : null,
    change_1h: attr.price_change_percentage?.h1 ? parseFloat(attr.price_change_percentage.h1) : null,
    change_24h: attr.price_change_percentage?.h24 ? parseFloat(attr.price_change_percentage.h24) : null,
    fee_bps: attr.pool_fee_bps ? Number(attr.pool_fee_bps) : null,
    url: `https://www.geckoterminal.com/robinhood/pools/${poolRef}`,
  };
}

// ─── The quote-asset anchor, on the paid tool path (#227) ──────────────────
//
// A pool price is an EXCHANGE RATE, not a share price. `NVDA/USDG` says what a
// share costs; `AI/NVDA` says what a share costs *in AI*, and calling that a
// dollar price is only correct if AI is a dollar. Depth does not fix this — a
// deep pool against a memecoin is still a deep pool.
//
// #223/PR #435 established this rule and applied it to `dexPrice` in
// `rwa-price.ts`, the reader the Blue Hood desk polls. It did NOT reach this
// module, which is the reader the PAID x402 handlers call — so the same defect
// stayed live on the surface that charges money for the answer.
//
// MEASURED 2026-09-09 on the live GT endpoint, and the sharpest case is not the
// documented fallback but the OPTION:
//
//   `preferUsdgQuote: false` — passed by rh-stock-swap-quote, rh-stock-swap-
//   prepare and rh-rwa-dca on every `denom=WETH` call — skipped the USDG bucket
//   entirely and returned `pools[0]`, the deepest pool of ANY quote asset. So a
//   WETH-denominated quote took the unanchored path even when a perfectly good
//   USDG pool existed. That is how RH NVDA resolves to the `AI / NVDA` pool
//   (#435 measured it at $21.9M liq / $3.2M vol against the real NVDA/USDG
//   $6.4M / $31.9M — depth 3.4x overstated, volume 10x understated).
//
// The rule is stated against `counterparty_token`, never `quote_token`, because
// our token can sit on either side of a GT pool — see that field's note.
//
// WHY AN EMPTY ANCHORED BUCKET RETURNS `null` RATHER THAN FALLING THROUGH:
// falling back to an unanchored pool is the entire bug. The honest answer for a
// token with no dollar market is "no price", not a memecoin exchange rate. Every
// caller already handles `pool: null` (that is the `no_pool_found` path), so the
// degraded behaviour is a tool that declines to quote — not one that lies.
//
// The anchor set is READ FROM `RH_PRICE_SOURCE.anchors`, deliberately not
// re-declared here: one production definition per chain, so this module and the
// desk reader cannot drift apart again the way they just did. (The independent
// duplicate lives in `scripts/dex-anchor-check.ts`, where being a duplicate is
// the point — see its header.)
const RH_ANCHORS = RH_PRICE_SOURCE.anchors;
const USDG_LOWER = "0x5fc5360d0400a0fd4f2af552add042d716f1d168".toLowerCase();

/** Is this pool's non-our-token side a USD-anchored asset? */
export function isUsdAnchored(p: PoolMeta): boolean {
  return RH_ANCHORS.has(p.counterparty_token);
}

/**
 * The subset of `pools` whose price is denominated in dollars, order preserved
 * (so a deepest-first input stays deepest-first). Use this anywhere a pool is
 * about to become a USD claim — price, TVL, volume, or a candle series.
 *
 * NOT for routing. `rh-stock-swap-route` and `rh-usdg-route` legitimately need
 * unanchored pools: a token→token hop is a real route, and USDG's own pools are
 * all quoted against stocks, so anchoring them would return the empty set.
 */
export function anchoredPools(pools: PoolMeta[]): PoolMeta[] {
  return pools.filter(isUsdAnchored);
}

// ─── Shared primary-pool selector ──────────────────────────────────────────
// Rule the whole tool catalog follows:
//   1. Discard every pool whose counterparty is not USD-anchored (above).
//   2. Prefer a USDG-quoted pool (stable USD frame, no double conversion).
//   3. Among those, pick deepest TVL.
//   4. If no USDG pool, pick the deepest remaining ANCHORED pool (WETH).
//   5. If nothing is anchored, return null — never an unanchored pool.
// This gives M1/M2/M5/L1 the SAME pool for the same ticker so an agent
// composing tools sees consistent price fields, and so pool_ref itself
// is a stable identifier across tool calls.
export async function resolvePrimaryPool(
  contract: string,
  opts: { preferUsdgQuote?: boolean } = {},
): Promise<{
  pool: PoolMeta | null;
  selection: string;
  /** Number of RH-Chain pools discovered for this token (all quote sides,
   *  anchored or not) — i.e. "how many pools exist", not "how many count". */
  pool_count: number;
  /** How many of those were USD-anchored, i.e. eligible to be `pool`. */
  anchored_pool_count: number;
  /** SUM of reserve_usd across every **anchored** pool for this token. This is
   *  the honest "how deep is the token's DOLLAR market in aggregate" — critical
   *  for the dust gate, because a $21M WETH pool + a $850k USDG pool should NOT
   *  be gated as dust just because the primary (USDG-quoted) pool is thin.
   *
   *  ⚠️ Changed in #227: this used to sum ALL pools. Unanchored depth is not
   *  dollar depth — counting the $21.9M `AI / NVDA` pool toward NVDA's dollar
   *  liquidity is what let a dust gate pass on liquidity that cannot be sold
   *  for dollars. `unanchored_tvl_usd` still reports it, separately. */
  total_tvl_usd: number;
  /** Depth we deliberately excluded, so nothing is hidden by the change above. */
  unanchored_tvl_usd: number;
}> {
  const pools = await poolsForToken(contract);
  const anchored = anchoredPools(pools);
  const total_tvl_usd = anchored.reduce((sum, p) => sum + (p.reserve_usd || 0), 0);
  const unanchored_tvl_usd = pools
    .filter((p) => !isUsdAnchored(p))
    .reduce((sum, p) => sum + (p.reserve_usd || 0), 0);
  const counts = {
    pool_count: pools.length,
    anchored_pool_count: anchored.length,
    total_tvl_usd,
    unanchored_tvl_usd,
  };

  if (!pools.length) {
    return { pool: null, selection: "no_pool_found", ...counts };
  }
  if (!anchored.length) {
    // Pools exist, but every one prices this token against something that is not
    // a dollar. Not an outage — an honest "no dollar market". See header.
    return { pool: null, selection: "no_usd_anchored_pool", ...counts };
  }
  if (opts.preferUsdgQuote !== false) {
    const usdgPools = anchored.filter((p) => p.counterparty_token === USDG_LOWER);
    if (usdgPools.length) {
      return { pool: usdgPools[0], selection: "deepest_usdg_pool", ...counts };
    }
  }
  return { pool: anchored[0], selection: "deepest_anchored_pool", ...counts };
}

// ─── Market-hours helper (used by M5 arb + A4 brief) ───────────────────────
// NYSE regular hours: Mon-Fri 09:30-16:00 ET.
// Rough conversion via fixed UTC-4 offset — ignores DST edges + market
// holidays. Good enough to distinguish "in-hours drift" from "overnight
// premarket". Any Chainlink RH stock feed will NOT tick outside these
// hours, so `age_seconds` > ~15min during hours == abnormal.
export function nyseMarketStatus(now: Date = new Date()): {
  is_open: boolean;
  session: "regular" | "premarket" | "afterhours" | "weekend";
  ny_time_iso: string;
  utc_offset_hours: number;
} {
  const ny = new Date(now.getTime() - 4 * 3600 * 1000);
  const day = ny.getUTCDay(); // 0 Sun..6 Sat
  const minutes = ny.getUTCHours() * 60 + ny.getUTCMinutes();
  const isWeekend = day === 0 || day === 6;
  if (isWeekend) return { is_open: false, session: "weekend", ny_time_iso: ny.toISOString(), utc_offset_hours: -4 };
  const REGULAR_OPEN = 9 * 60 + 30;   // 09:30
  const REGULAR_CLOSE = 16 * 60;      // 16:00
  if (minutes < REGULAR_OPEN)  return { is_open: false, session: "premarket",  ny_time_iso: ny.toISOString(), utc_offset_hours: -4 };
  if (minutes >= REGULAR_CLOSE) return { is_open: false, session: "afterhours", ny_time_iso: ny.toISOString(), utc_offset_hours: -4 };
  return { is_open: true, session: "regular", ny_time_iso: ny.toISOString(), utc_offset_hours: -4 };
}

/** All pools for a token, sorted by deepest liquidity. Price is always for
 *  the queried token, whether it's the pool's base or quote side. */
export async function poolsForToken(contract: string): Promise<PoolMeta[]> {
  const d = await fetchJson<{ data?: PoolItem[] }>(
    `${GT}/tokens/${contract.toLowerCase()}/pools?page=1`,
  );
  if (!d?.data) return [];
  const pools = d.data
    .map((p) => poolFromItem(p, contract))
    .filter((p): p is PoolMeta => p !== null);
  pools.sort((a, b) => b.reserve_usd - a.reserve_usd);
  return pools;
}

/** Top pools on RH Chain by 24h volume (used by M4 movers). Price is the
 *  pool's own base-side price — caller cross-references our RWA registry
 *  by base_token to filter to RWA-only pools. */
export async function topPools(limit = 50): Promise<PoolMeta[]> {
  const d = await fetchJson<{ data?: PoolItem[] }>(
    `${GT}/pools?page=1&sort=h24_volume_usd_desc`,
  );
  if (!d?.data) return [];
  return d.data
    .map((p) => poolFromItem(p))
    .filter((p): p is PoolMeta => p !== null)
    .slice(0, limit);
}

// ─── OHLC (used by M2) ─────────────────────────────────────────────────────

export type Candle = {
  t: number;    // unix seconds
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;    // volume USD
};

type OhlcvResp = {
  data?: {
    attributes?: {
      ohlcv_list?: [number, number, number, number, number, number][];
    };
  };
};

export type OhlcTimeframe = "minute" | "hour" | "day";

/** GeckoTerminal ohlcv for a pool. Timeframe: minute|hour|day. Max 1000.
 *  Options:
 *   • invert          — flip o/h/l/c to 1/x (used when the caller's token is
 *                       the pool's quote side, so raw candles are for the
 *                       counterparty). After inversion h/l roles swap.
 *   • usd_multiplier  — multiply o/h/l/c by this after (optional) inversion,
 *                       to convert raw ratio → USD when the counterparty is a
 *                       stablecoin ≈ $1 (or a known USD-priced token).      */
export async function poolOhlc(
  pool: string,
  timeframe: OhlcTimeframe = "hour",
  limit = 100,
  options: { invert?: boolean; usd_multiplier?: number } = {},
): Promise<Candle[] | null> {
  const d = await fetchJson<OhlcvResp>(
    `${GT}/pools/${pool.toLowerCase()}/ohlcv/${timeframe}?limit=${limit}`,
    8000,
  );
  const rows = d?.data?.attributes?.ohlcv_list;
  if (!rows?.length) return null;
  // GeckoTerminal returns rows as [timestamp, open, high, low, close, volume]
  // Newest-first — flip to chronological (oldest-first) so charting is trivial.
  const invert = !!options.invert;
  const mul = options.usd_multiplier ?? 1;
  return rows
    .map(([t, o, h, l, c, v]) => {
      if (invert) {
        // 1/x flips high & low: max of 1/l vs 1/h → high
        const io = safeInv(o), ic = safeInv(c);
        const ih = safeInv(l), il = safeInv(h);
        return { t, o: io * mul, h: ih * mul, l: il * mul, c: ic * mul, v };
      }
      return { t, o: o * mul, h: h * mul, l: l * mul, c: c * mul, v };
    })
    .reverse();
}

function safeInv(x: number): number { return x > 0 && Number.isFinite(x) ? 1 / x : 0; }

// ─── OHLC math helpers (used by M2 summary + M5 arb history) ───────────────

export function pctChange(from: number, to: number): number | null {
  if (!Number.isFinite(from) || from === 0) return null;
  return ((to - from) / from) * 100;
}

export function candleSummary(candles: Candle[]): {
  first: Candle | null;
  last: Candle | null;
  high: number | null;
  low: number | null;
  volume_total: number | null;
  change_pct: number | null;
} {
  if (!candles.length) {
    return { first: null, last: null, high: null, low: null, volume_total: null, change_pct: null };
  }
  const first = candles[0], last = candles[candles.length - 1];
  const high = Math.max(...candles.map((c) => c.h));
  const low  = Math.min(...candles.map((c) => c.l));
  const vol  = candles.reduce((s, c) => s + (c.v || 0), 0);
  return { first, last, high, low, volume_total: vol, change_pct: pctChange(first.o, last.c) };
}
