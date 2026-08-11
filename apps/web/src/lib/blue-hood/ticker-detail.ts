/**
 * Blue Hood — shared per-ticker detail fetch (T-B.1 #3).
 *
 * One function, two callers: `/api/hood/ticker-detail` (on-demand from
 * the UI) and the sparkline-refresh cron (piggyback warm-up so most
 * clicks land on a cache hit).
 *
 * The two upstream tools — M3 (`rh-stock-liquidity`) + D1 (`rh-stock-holders`)
 * — hit different subsystems (GeckoTerminal + Blockscout respectively),
 * so we fire them in parallel. Previously they were sequential and a
 * cache-miss on the endpoint cost ~18s; parallel cuts that roughly in half.
 */
import { kvGet, kvSet } from "@/lib/kv";
import { callTool } from "./tool-caller";

const TTL_S = 300; // 5 min — reviewer's spec
const kvKey = (t: string) => `bh:detail:${t.toUpperCase()}`;

export interface CachedDetail {
  ticker: string;
  fetched_at: string;
  liquidity: unknown; // shape matches M3 response or `{ error: string }`
  holders: unknown;   // shape matches D1 response or `{ error: string }`
}

/**
 * Read the KV cache. Returns `null` on miss OR when the entry is older
 * than `TTL_S` seconds — callers can treat both as "no fresh cache" and
 * decide whether to fetch.
 */
export async function readCachedDetail(ticker: string): Promise<CachedDetail | null> {
  const c = await kvGet<CachedDetail>(kvKey(ticker));
  if (!c) return null;
  const ageMs = Date.now() - new Date(c.fetched_at).getTime();
  if (ageMs > TTL_S * 1000) return null;
  return c;
}

/**
 * Fetch M3 + D1 in parallel and write to KV. Never throws; per-tool
 * errors surface as `{ error: "..." }` blocks the UI renders inline.
 */
export async function fetchAndCacheDetail(ticker: string): Promise<CachedDetail> {
  const [m3, d1] = await Promise.all([
    callTool<Record<string, unknown>>("rh-stock-liquidity", { ticker }, { timeoutMs: 15_000 }),
    callTool<Record<string, unknown>>("rh-stock-holders", { ticker, limit: 10 }, { timeoutMs: 15_000 }),
  ]);
  const detail: CachedDetail = {
    ticker,
    fetched_at: new Date().toISOString(),
    liquidity: m3.ok ? m3.data : { error: `${m3.status}: ${m3.error}` },
    holders:   d1.ok ? d1.data : { error: `${d1.status}: ${d1.error}` },
  };
  await kvSet(kvKey(ticker), detail, TTL_S);
  return detail;
}
