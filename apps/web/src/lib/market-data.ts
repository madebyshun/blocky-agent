// Shared real-data layer for Base market tools.
// Every number returned here comes from a live source — never the LLM.
//   - DexScreener   (api.dexscreener.com)     — token price / volume / liquidity / change
//   - GeckoTerminal (api.geckoterminal.com)   — trending + new pools on Base
//   - DefiLlama     (api.llama.fi / yields)   — chain TVL + real yield pools
// All fetchers fail soft (null / []) so a handler can degrade instead of 500ing.

const T = 8000; // per-request timeout (ms)

function num(v: unknown): number | null {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T | null> {
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(T) });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

// ─── DexScreener: single token market ────────────────────────────────────────

export type TokenMarket = {
  address: string;
  name: string | null;
  symbol: string | null;
  priceUsd: number | null;
  change: { h1: number | null; h6: number | null; h24: number | null };
  volume24h: number | null;
  liquidityUsd: number | null;
  marketCap: number | null;
  fdv: number | null;
  dex: string | null;
  url: string | null;
  source: "dexscreener" | "geckoterminal";
};

type DsPair = {
  chainId: string;
  dexId?: string;
  url?: string;
  baseToken?: { name?: string; symbol?: string };
  priceUsd?: string;
  priceChange?: { h1?: number; h6?: number; h24?: number };
  volume?: { h24?: number };
  liquidity?: { usd?: number };
  marketCap?: number;
  fdv?: number;
};

// Returns the deepest-liquidity Base pair for a token address.
export async function getTokenMarket(address: string): Promise<TokenMarket | null> {
  const d = await getJson<{ pairs?: DsPair[] }>(
    `https://api.dexscreener.com/latest/dex/tokens/${address}`
  );
  const basePairs = (d?.pairs ?? []).filter((p) => p.chainId === "base");
  if (!basePairs.length) return null;
  basePairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
  const p = basePairs[0];
  return {
    address,
    name: p.baseToken?.name ?? null,
    symbol: p.baseToken?.symbol ?? null,
    priceUsd: num(p.priceUsd),
    change: { h1: num(p.priceChange?.h1), h6: num(p.priceChange?.h6), h24: num(p.priceChange?.h24) },
    volume24h: num(p.volume?.h24),
    liquidityUsd: num(p.liquidity?.usd),
    marketCap: num(p.marketCap),
    fdv: num(p.fdv),
    dex: p.dexId ?? null,
    url: p.url ?? null,
    source: "dexscreener",
  };
}

// ─── GeckoTerminal: trending / new pools on Base ─────────────────────────────

export type Pool = {
  name: string;
  baseSymbol: string;
  poolAddress: string;
  priceUsd: number | null;
  change: { h1: number | null; h6: number | null; h24: number | null };
  volume24h: number | null;
  liquidityUsd: number | null;
  marketCap: number | null;
  url: string;
};

type GtPool = {
  attributes?: {
    name?: string;
    address?: string;
    base_token_price_usd?: string;
    price_change_percentage?: Record<string, string>;
    volume_usd?: Record<string, string>;
    reserve_in_usd?: string;
    market_cap_usd?: string;
    fdv_usd?: string;
  };
};

// GeckoTerminal network id — "base" for Base, "robinhood" for Robinhood Chain.
// Confirmed live: api.geckoterminal.com/api/v2/networks/robinhood/trending_pools
// and /new_pools both return real Robinhood Chain pools (verified via curl),
// so this is a real second data source, not a guess.
export type GtChain = "base" | "robinhood";

function mapGtPool(p: GtPool, chain: GtChain): Pool {
  const a = p.attributes ?? {};
  const name = a.name ?? "";
  return {
    name,
    baseSymbol: name.split("/")[0]?.trim() || name,
    poolAddress: a.address ?? "",
    priceUsd: num(a.base_token_price_usd),
    change: {
      h1: num(a.price_change_percentage?.h1),
      h6: num(a.price_change_percentage?.h6),
      h24: num(a.price_change_percentage?.h24),
    },
    volume24h: num(a.volume_usd?.h24),
    liquidityUsd: num(a.reserve_in_usd),
    marketCap: num(a.market_cap_usd) ?? num(a.fdv_usd),
    url: a.address ? `https://www.geckoterminal.com/${chain}/pools/${a.address}` : "",
  };
}

async function gtPools(chain: GtChain, path: string, limit: number): Promise<Pool[]> {
  const d = await getJson<{ data?: GtPool[] }>(
    `https://api.geckoterminal.com/api/v2/networks/${chain}/${path}?page=1`
  );
  return (d?.data ?? []).slice(0, limit).map((p) => mapGtPool(p, chain));
}

export const getBaseTrending = (limit = 10) => gtPools("base", "trending_pools", limit);
export const getBaseNewPools = (limit = 10) => gtPools("base", "new_pools", limit);
export const getRobinhoodTrending = (limit = 10) => gtPools("robinhood", "trending_pools", limit);
export const getRobinhoodNewPools = (limit = 10) => gtPools("robinhood", "new_pools", limit);

// ─── GeckoTerminal: a single Base pool by address (for LP analysis) ───────────

export type PoolDetail = {
  name: string;
  poolAddress: string;
  baseSymbol: string;
  quoteSymbol: string;
  baseTokenPriceUsd: number | null;
  quoteTokenPriceUsd: number | null;
  poolPrice: number | null;        // base priced in quote (base/quote)
  change24hPct: number | null;     // base token 24h % change
  volume24h: number | null;
  reserveUsd: number | null;       // pool TVL
  feePct: number | null;           // pool fee tier % if exposed
  url: string;
};

type GtPoolDetail = {
  attributes?: {
    name?: string;
    address?: string;
    base_token_price_usd?: string;
    quote_token_price_usd?: string;
    base_token_price_quote_token?: string;
    price_change_percentage?: Record<string, string>;
    volume_usd?: Record<string, string>;
    reserve_in_usd?: string;
    pool_fee_percentage?: string;
  };
};

// Real pool snapshot for a Base pool address. null if not found.
export async function getBasePool(poolAddress: string): Promise<PoolDetail | null> {
  const addr = poolAddress.trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(addr)) return null;
  const d = await getJson<{ data?: GtPoolDetail }>(
    `https://api.geckoterminal.com/api/v2/networks/base/pools/${addr}`
  );
  const a = d?.data?.attributes;
  if (!a) return null;
  const name = a.name ?? "";
  const [base, quote] = name.split("/").map((s) => s.trim());
  return {
    name,
    poolAddress: a.address ?? addr,
    baseSymbol: base || "?",
    quoteSymbol: quote || "?",
    baseTokenPriceUsd: num(a.base_token_price_usd),
    quoteTokenPriceUsd: num(a.quote_token_price_usd),
    poolPrice: num(a.base_token_price_quote_token),
    change24hPct: num(a.price_change_percentage?.h24),
    volume24h: num(a.volume_usd?.h24),
    reserveUsd: num(a.reserve_in_usd),
    feePct: num(a.pool_fee_percentage),
    url: `https://www.geckoterminal.com/base/pools/${a.address ?? addr}`,
  };
}

// ─── GeckoTerminal: Robinhood Chain token market (deepest pool) ──────────────
// DexScreener does not index Robinhood Chain (chainId 4663), so GeckoTerminal
// is the substitute. We ask for all pools that hold this token and pick the
// deepest-liquidity pool as the canonical market read — same shape as
// getTokenMarket() so callers can treat both identically.
export async function getRobinhoodTokenMarket(address: string): Promise<TokenMarket | null> {
  const addr = address.trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(addr)) return null;
  type GtTokenPool = {
    attributes?: {
      name?: string;
      base_token_price_usd?: string;
      price_change_percentage?: Record<string, string>;
      volume_usd?: Record<string, string>;
      reserve_in_usd?: string;
      market_cap_usd?: string;
      fdv_usd?: string;
      dex_id?: string;
      address?: string;
    };
    relationships?: { dex?: { data?: { id?: string } } };
  };
  const d = await getJson<{ data?: GtTokenPool[] }>(
    `https://api.geckoterminal.com/api/v2/networks/robinhood/tokens/${addr}/pools?page=1`
  );
  const pools = d?.data ?? [];
  if (!pools.length) return null;
  pools.sort((a, b) => (num(b.attributes?.reserve_in_usd) ?? 0) - (num(a.attributes?.reserve_in_usd) ?? 0));
  const top = pools[0];
  const a = top.attributes ?? {};
  const name = a.name ?? "";
  const symbol = name.split("/")[0]?.trim() || null;
  return {
    address: addr,
    name: symbol,
    symbol,
    priceUsd: num(a.base_token_price_usd),
    change: {
      h1: num(a.price_change_percentage?.h1),
      h6: num(a.price_change_percentage?.h6),
      h24: num(a.price_change_percentage?.h24),
    },
    volume24h: num(a.volume_usd?.h24),
    liquidityUsd: num(a.reserve_in_usd),
    marketCap: num(a.market_cap_usd),
    fdv: num(a.fdv_usd),
    dex: top.relationships?.dex?.data?.id ?? null,
    url: a.address ? `https://www.geckoterminal.com/robinhood/pools/${a.address}` : null,
    source: "geckoterminal",
  };
}

// Deterministic impermanent loss for a 50/50 constant-product LP, given the
// price ratio change (current / entry). Returns IL as a NEGATIVE fraction
// (e.g. -0.0057 = -0.57%). Formula: 2*sqrt(r)/(1+r) - 1.
export function impermanentLoss(priceRatio: number): number | null {
  if (!Number.isFinite(priceRatio) || priceRatio <= 0) return null;
  return (2 * Math.sqrt(priceRatio)) / (1 + priceRatio) - 1;
}

// ─── DefiLlama: Base chain TVL ───────────────────────────────────────────────

export type BaseTvl = {
  tvlUsd: number | null;
  change1dPct: number | null;
  change7dPct: number | null;
  source: "defillama";
};

// DefiLlama chain-name slug (case-sensitive, matches their /historicalChainTvl
// path convention) — "Base" and "Robinhood" both confirmed live via curl
// (Robinhood's history is short, ~7 daily points, since it's a newer chain,
// but it's real DefiLlama-tracked TVL, not fabricated).
async function getChainTvl(chainSlug: "Base" | "Robinhood"): Promise<BaseTvl | null> {
  const hist = await getJson<{ date: number; tvl: number }[]>(
    `https://api.llama.fi/v2/historicalChainTvl/${chainSlug}`
  );
  if (!hist?.length) return null;
  const last = hist[hist.length - 1]?.tvl ?? null;
  const d1 = hist[hist.length - 2]?.tvl ?? null;
  const d7 = hist[hist.length - 8]?.tvl ?? null;
  const pct = (now: number | null, then: number | null) =>
    now != null && then ? +(((now - then) / then) * 100).toFixed(2) : null;
  return { tvlUsd: last, change1dPct: pct(last, d1), change7dPct: pct(last, d7), source: "defillama" };
}

export const getBaseTvl = () => getChainTvl("Base");
export const getRobinhoodTvl = () => getChainTvl("Robinhood");

// ─── DefiLlama: real yield pools on Base ─────────────────────────────────────

export type YieldPool = {
  project: string;
  symbol: string;
  tvlUsd: number;
  apy: number | null;
  apyBase: number | null;
  apyReward: number | null;
  ilRisk: string;
  stablecoin: boolean;
  url: string;
};

type LlamaPool = {
  chain?: string;
  project?: string;
  symbol?: string;
  tvlUsd?: number;
  apy?: number | null;
  apyBase?: number | null;
  apyReward?: number | null;
  ilRisk?: string;
  stablecoin?: boolean;
  pool?: string;
};

// Top Base yield pools by TVL. opts.stableOnly / opts.minTvl narrow the set.
export async function getBaseYields(
  limit = 15,
  opts: { stableOnly?: boolean; minTvl?: number } = {}
): Promise<YieldPool[]> {
  const d = await getJson<{ data?: LlamaPool[] }>("https://yields.llama.fi/pools");
  let pools = (d?.data ?? []).filter((p) => p.chain === "Base");
  if (opts.stableOnly) pools = pools.filter((p) => p.stablecoin);
  if (opts.minTvl) pools = pools.filter((p) => (p.tvlUsd ?? 0) >= opts.minTvl!);
  pools.sort((a, b) => (b.tvlUsd ?? 0) - (a.tvlUsd ?? 0));
  return pools.slice(0, limit).map((p) => ({
    project: p.project ?? "unknown",
    symbol: p.symbol ?? "?",
    tvlUsd: p.tvlUsd ?? 0,
    apy: p.apy ?? null,
    apyBase: p.apyBase ?? null,
    apyReward: p.apyReward ?? null,
    ilRisk: p.ilRisk ?? "unknown",
    stablecoin: !!p.stablecoin,
    url: p.pool ? `https://defillama.com/yields/pool/${p.pool}` : "https://defillama.com/yields?chain=Base",
  }));
}

// Top Robinhood Chain yield pools by TVL from DefiLlama (chain="Robinhood").
// Companion to getBaseYields — kept as its own function so Base callers stay
// untouched, and the two evolve independently (RH is thinner + newer, so the
// caller often wants a smaller minTvl floor and no dedup by project).
// opts.assetSymbol filters pool.symbol (case-insensitive, e.g. "USDG").
export async function getRobinhoodYields(
  limit = 15,
  opts: { assetSymbol?: string; minTvl?: number } = {}
): Promise<YieldPool[]> {
  const d = await getJson<{ data?: LlamaPool[] }>("https://yields.llama.fi/pools");
  let pools = (d?.data ?? []).filter((p) => p.chain === "Robinhood");
  if (opts.assetSymbol) {
    const q = opts.assetSymbol.toLowerCase();
    pools = pools.filter((p) => (p.symbol ?? "").toLowerCase().includes(q));
  }
  if (opts.minTvl) pools = pools.filter((p) => (p.tvlUsd ?? 0) >= opts.minTvl!);
  pools.sort((a, b) => (b.tvlUsd ?? 0) - (a.tvlUsd ?? 0));
  return pools.slice(0, limit).map((p) => ({
    project: p.project ?? "unknown",
    symbol: p.symbol ?? "?",
    tvlUsd: p.tvlUsd ?? 0,
    apy: p.apy ?? null,
    apyBase: p.apyBase ?? null,
    apyReward: p.apyReward ?? null,
    ilRisk: p.ilRisk ?? "unknown",
    stablecoin: !!p.stablecoin,
    url: p.pool ? `https://defillama.com/yields/pool/${p.pool}` : "https://defillama.com/yields?chain=Robinhood",
  }));
}

// ─── Prompt formatters — compact, real-number context for the LLM ────────────

const fmtUsd = (n: number | null) =>
  n == null ? "?" : n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(2)}`;
const fmtPct = (n: number | null) => (n == null ? "?" : `${n > 0 ? "+" : ""}${n.toFixed(1)}%`);

export function poolsToPrompt(pools: Pool[]): string {
  if (!pools.length) return "(no pool data available)";
  return pools
    .map(
      (p, i) =>
        `${i + 1}. ${p.baseSymbol} — price ${p.priceUsd != null ? "$" + p.priceUsd : "?"}, 24h ${fmtPct(p.change.h24)}, 1h ${fmtPct(p.change.h1)}, vol24h ${fmtUsd(p.volume24h)}, liq ${fmtUsd(p.liquidityUsd)}, mcap ${fmtUsd(p.marketCap)}`
    )
    .join("\n");
}

export function yieldsToPrompt(pools: YieldPool[]): string {
  if (!pools.length) return "(no yield data available)";
  return pools
    .map(
      (p, i) =>
        `${i + 1}. ${p.project} ${p.symbol} — APY ${fmtPct(p.apy)} (base ${fmtPct(p.apyBase)} + reward ${fmtPct(p.apyReward)}), TVL ${fmtUsd(p.tvlUsd)}, IL risk ${p.ilRisk}, ${p.stablecoin ? "stable" : "volatile"}`
    )
    .join("\n");
}

export function tvlToPrompt(t: BaseTvl | null): string {
  if (!t) return "Base TVL: (unavailable)";
  return `Base chain TVL: ${fmtUsd(t.tvlUsd)} (1d ${fmtPct(t.change1dPct)}, 7d ${fmtPct(t.change7dPct)})`;
}

// ─── DefiLlama: protocols on Base (TVL, change, category) ────────────────────

export type BaseProtocol = {
  name: string;
  slug: string;
  category: string | null;
  tvlUsd: number | null;
  change1dPct: number | null;
  change7dPct: number | null;
  chains: string[];
  url: string;
};

type LlamaProtocol = {
  name?: string;
  slug?: string;
  category?: string;
  tvl?: number;
  change_1d?: number | null;
  change_7d?: number | null;
  chains?: string[];
  chainTvls?: Record<string, number>;
};

function mapProtocol(p: LlamaProtocol): BaseProtocol {
  return {
    name: p.name ?? "unknown",
    slug: p.slug ?? "",
    category: p.category ?? null,
    tvlUsd: p.chainTvls?.Base ?? p.tvl ?? null, // prefer Base-specific TVL
    change1dPct: p.change_1d ?? null,
    change7dPct: p.change_7d ?? null,
    chains: p.chains ?? [],
    url: p.slug ? `https://defillama.com/protocol/${p.slug}` : "https://defillama.com/chain/Base",
  };
}

// All protocols present on Base, sorted by Base TVL desc.
export async function getBaseProtocols(limit = 50): Promise<BaseProtocol[]> {
  const all = await getJson<LlamaProtocol[]>("https://api.llama.fi/protocols");
  if (!all?.length) return [];
  return all
    .filter((p) => (p.chains ?? []).includes("Base"))
    .map(mapProtocol)
    .sort((a, b) => (b.tvlUsd ?? 0) - (a.tvlUsd ?? 0))
    .slice(0, limit);
}

// Fuzzy-match a Base protocol by name (case-insensitive).
export async function findBaseProtocol(name: string): Promise<BaseProtocol | null> {
  if (!name?.trim()) return null;
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "");
  const q = norm(name);
  const list = await getBaseProtocols(800);
  return (
    list.find((p) => norm(p.name) === q) ??
    list.find((p) => p.name.toLowerCase().includes(name.toLowerCase().trim())) ??
    list.find((p) => name.toLowerCase().includes(p.name.toLowerCase())) ??
    null
  );
}

export function protocolToPrompt(p: BaseProtocol | null, label = "Protocol"): string {
  if (!p) return `${label}: (not found on DefiLlama for Base — assess qualitatively)`;
  return `${label}: ${p.name} — Base TVL ${fmtUsd(p.tvlUsd)} (1d ${fmtPct(p.change1dPct)}, 7d ${fmtPct(p.change7dPct)}), category ${p.category ?? "?"}, chains ${p.chains.length}`;
}
