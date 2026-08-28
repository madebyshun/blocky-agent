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
 *
 * ⚠️ BOTH TOOLS ARE ROBINHOOD-ONLY, AND THE `ticker` THEY TAKE IS A BARE
 * STRING. `chain` is therefore a REQUIRED parameter on both functions below,
 * not an optional one with an RH default: NVDA/META/GOOGL/AAPL exist on Base
 * too, and an omitted argument is exactly how a Base caller would silently get
 * RH pools back. Making it required means the compiler, not a reviewer, is what
 * stops the next caller. See `detail-support.ts` for the panel-side decision and
 * for what the production board was actually rendering before this.
 */
import { kvGet, kvSet } from "@/lib/kv";
import { detailCacheKey, detailPanelPlan } from "./detail-support";
import type { HoodChain } from "./types";
import { callTool } from "./tool-caller";

const TTL_S = 300; // 5 min — reviewer's spec

export interface CachedDetail {
  ticker: string;
  /** Which desk these numbers were measured on. Stored, not inferred: a
   *  payload that does not name its own chain is one copy-paste away from
   *  being read as the other desk's. */
  chain: HoodChain;
  fetched_at: string;
  liquidity: unknown; // shape matches M3 response or `{ error: string }`
  holders: unknown;   // shape matches D1 response or `{ error: string }`
}

/**
 * Read the KV cache. Returns `null` on miss OR when the entry is older
 * than `TTL_S` seconds — callers can treat both as "no fresh cache" and
 * decide whether to fetch.
 */
export async function readCachedDetail(
  chain: HoodChain,
  ticker: string,
): Promise<CachedDetail | null> {
  const c = await kvGet<CachedDetail>(detailCacheKey(chain, ticker));
  if (!c) return null;
  const ageMs = Date.now() - new Date(c.fetched_at).getTime();
  if (ageMs > TTL_S * 1000) return null;
  return c;
}

/**
 * Fetch M3 + D1 in parallel and write to KV. Never throws; per-tool
 * errors surface as `{ error: "..." }` blocks the UI renders inline.
 *
 * Throws — loudly, before any tool call — for a chain the two tools cannot
 * read. A silent empty payload would be indistinguishable from an upstream
 * outage, and a caller that reached here with a Base ticker has a bug that
 * should surface at the call site rather than as a blank panel.
 */
export async function fetchAndCacheDetail(
  chain: HoodChain,
  ticker: string,
): Promise<CachedDetail> {
  if (!detailPanelPlan(chain).fetch) {
    throw new Error(
      `ticker-detail: M3/D1 read Robinhood Chain only; refusing to fetch ${ticker} as chain="${chain}"`,
    );
  }
  const [m3, d1] = await Promise.all([
    callTool<Record<string, unknown>>("rh-stock-liquidity", { ticker }, { timeoutMs: 15_000 }),
    callTool<Record<string, unknown>>("rh-stock-holders", { ticker, limit: 10 }, { timeoutMs: 15_000 }),
  ]);
  const detail: CachedDetail = {
    ticker,
    chain,
    fetched_at: new Date().toISOString(),
    liquidity: m3.ok ? m3.data : { error: `${m3.status}: ${m3.error}` },
    holders:   d1.ok ? d1.data : { error: `${d1.status}: ${d1.error}` },
  };
  await kvSet(detailCacheKey(chain, ticker), detail, TTL_S);
  return detail;
}
