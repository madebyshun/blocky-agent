/**
 * Blue Hood — sparkline cache (T-B1).
 *
 * Reads the 24-hour hourly close series for each tradable ticker from
 * a KV cache. The cache is populated by a SEPARATE cron
 * (`/api/cron/blue-hood/sparkline-refresh`) so the hot 72s poll cycle
 * stays flat — no extra M2 calls per cycle.
 *
 * Cache layout (per ticker):
 *   bh:spark:{TICKER} → { candles: number[], refreshed_at: string }
 *
 * `refreshed_at` is informational; expiry is enforced by KV TTL
 * (`TTL_SPARKLINE`). A stale cache is fine — the UI hides the sparkline
 * when it's absent or too short, not when it's stale.
 */
import { kvGet, kvSet } from "@/lib/kv";
import { callTool } from "./tool-caller";
import { TTL_SPARKLINE, kvSparkline } from "./kv-keys";

export interface SparklineCacheEntry {
  candles: number[];
  refreshed_at: string;
}

// M2 (`rh-stock-ohlc`) subset we care about.
interface M2Response {
  candles?: { c?: number }[];
  candles_returned?: number;
}

/**
 * Read a sparkline series from KV. Returns null if the entry is missing
 * (cold start). Never fetches — the refresh cron does that job.
 */
export async function readSparkline(ticker: string): Promise<number[] | null> {
  const entry = await kvGet<SparklineCacheEntry>(kvSparkline(ticker));
  if (!entry || !Array.isArray(entry.candles)) return null;
  return entry.candles;
}

/**
 * Refresh one ticker's sparkline. Called by the refresh cron sequentially
 * with the same 3s stagger as the M5 poll — GT's rate-limit doesn't care
 * which endpoint you hit.
 */
export async function refreshSparkline(ticker: string): Promise<{
  ok: boolean;
  candles?: number;
  error?: string;
}> {
  const r = await callTool<M2Response>("rh-stock-ohlc", {
    ticker,
    timeframe: "hour",
    limit: 24,
  });
  if (!r.ok) {
    return { ok: false, error: `${r.status}: ${r.error}` };
  }
  const closes = (r.data.candles ?? [])
    .map((c) => (typeof c?.c === "number" ? c.c : null))
    .filter((n): n is number => n !== null && Number.isFinite(n) && n > 0);
  const entry: SparklineCacheEntry = {
    candles: closes,
    refreshed_at: new Date().toISOString(),
  };
  await kvSet(kvSparkline(ticker), entry, TTL_SPARKLINE);
  return { ok: true, candles: closes.length };
}
