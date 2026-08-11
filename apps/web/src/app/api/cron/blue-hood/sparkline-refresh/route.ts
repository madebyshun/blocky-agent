/**
 * Blue Hood — sparkline refresh cron (T-B1).
 *
 * Refreshes the 24-hour hourly close series for every watched ticker.
 * Runs SEPARATELY from the main 72s poll cycle so the hot path stays
 * flat. Recommended cadence: 15 min. TTL on the KV cache is 20 min,
 * so a missed cycle degrades to "sparkline hidden" not "stale sparkline".
 *
 * Same rate-limit strategy as the poller: sequential + 3s stagger →
 * 24 × ~3.5s ≈ 84s wall time. Well under 15-min cadence.
 *
 * Auth: `Authorization: Bearer $CRON_SECRET` or `?secret=…`. Dev without
 * a secret set falls open so `npm run dev` just works.
 */
import { NextRequest, NextResponse } from "next/server";
import { kvGet } from "@/lib/kv";
import { HOOD_WATCHLIST } from "@/lib/blue-hood/registry";
import { refreshSparkline } from "@/lib/blue-hood/sparkline";
import { fetchAndCacheDetail } from "@/lib/blue-hood/ticker-detail";
import { KV_SNAPSHOT_LATEST } from "@/lib/blue-hood/kv-keys";
import type { HoodSnapshot } from "@/lib/blue-hood/types";

export const runtime = "nodejs";
export const maxDuration = 180;

const CRON_SECRET = process.env.CRON_SECRET ?? "";

function isAuthorized(req: NextRequest): boolean {
  if (!CRON_SECRET) return process.env.NODE_ENV !== "production";
  const authHeader = req.headers.get("authorization") ?? "";
  const secretParam = new URL(req.url).searchParams.get("secret") ?? "";
  return authHeader === `Bearer ${CRON_SECRET}` || secretParam === CRON_SECRET;
}

const STAGGER_MS = Number(process.env.BH_SPARKLINE_STAGGER_MS ?? "3000");

async function handle(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const started = Date.now();
  const results: Array<{ ticker: string; ok: boolean; candles?: number; error?: string }> = [];
  console.log(`[sparkline] refresh cycle start count=${HOOD_WATCHLIST.length} stagger_ms=${STAGGER_MS}`);
  for (let i = 0; i < HOOD_WATCHLIST.length; i++) {
    const t = HOOD_WATCHLIST[i];
    const r = await refreshSparkline(t.ticker);
    results.push({ ticker: t.ticker, ...r });
    console.log(`[sparkline] seq=${i + 1}/${HOOD_WATCHLIST.length} ticker=${t.ticker} ok=${r.ok} candles=${r.candles ?? 0}${r.error ? ` error="${r.error}"` : ""}`);
    if (STAGGER_MS > 0 && i < HOOD_WATCHLIST.length - 1) {
      await new Promise((res) => setTimeout(res, STAGGER_MS));
    }
  }
  const spark_ok = results.filter((r) => r.ok).length;

  // T-B.1 #3 — detail-warm piggyback. After the sparkline pass finishes,
  // read the latest snapshot, pick out Tradable tickers (has dex_usd +
  // TVL ≥ $5k dust floor), and pre-fill `bh:detail:{TICKER}` for each.
  // Same 3s stagger. Click-through from the drift board now lands on a
  // cache hit ~99% of the time.
  //
  // Dust check uses TOTAL token liquidity (matches rule-engine gate) so
  // tokens like NVDA — deep on the WETH pool but thin on the USDG
  // primary — still get warmed. Falls back to `tvl_usd` on snapshots
  // that predate `total_tvl_usd`.
  const snap = await kvGet<HoodSnapshot>(KV_SNAPSHOT_LATEST);
  const tradable = (snap?.tickers ?? []).filter(
    (r) => r.verdict !== "ERROR" && r.verdict !== "INSUFFICIENT_DATA"
      && r.dex_usd !== null && ((r.total_tvl_usd ?? r.tvl_usd ?? 0) >= 5_000),
  );
  const warm: Array<{ ticker: string; ok: boolean; error?: string }> = [];
  console.log(`[detail-warm] tradable=${tradable.length} stagger_ms=${STAGGER_MS}`);
  for (let i = 0; i < tradable.length; i++) {
    const t = tradable[i];
    const t0 = Date.now();
    try {
      await fetchAndCacheDetail(t.ticker);
      warm.push({ ticker: t.ticker, ok: true });
      console.log(`[detail-warm] seq=${i + 1}/${tradable.length} ticker=${t.ticker} ok elapsed_ms=${Date.now() - t0}`);
    } catch (e) {
      const msg = (e as Error).message;
      warm.push({ ticker: t.ticker, ok: false, error: msg });
      console.warn(`[detail-warm] seq=${i + 1}/${tradable.length} ticker=${t.ticker} error="${msg}"`);
    }
    if (STAGGER_MS > 0 && i < tradable.length - 1) {
      await new Promise((res) => setTimeout(res, STAGGER_MS));
    }
  }
  const warm_ok = warm.filter((w) => w.ok).length;

  return NextResponse.json({
    ok: true,
    duration_ms: Date.now() - started,
    watched: HOOD_WATCHLIST.length,
    refreshed: spark_ok,
    errored: results.length - spark_ok,
    detail_warm: { tradable: tradable.length, refreshed: warm_ok, errored: warm.length - warm_ok },
    per_ticker: results,
    per_detail: warm,
  });
}

export const POST = handle;
export const GET = handle;
