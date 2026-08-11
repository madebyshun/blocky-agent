/**
 * Blue Hood — per-ticker detail (T-B2).
 *
 * Returns M3 (liquidity) + D1 (holders) for one ticker, cache-first.
 * Cache logic + parallel-fetch live in `lib/blue-hood/ticker-detail.ts`
 * so the sparkline-refresh cron can warm the same entries (T-B.1 #3).
 */
import { NextRequest, NextResponse } from "next/server";
import { findByTicker } from "@/lib/robinhood/rwa-registry";
import { fetchAndCacheDetail, readCachedDetail } from "@/lib/blue-hood/ticker-detail";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const rawTicker = url.searchParams.get("ticker") ?? "";
  const ticker = rawTicker.trim().toUpperCase();
  if (!ticker) {
    return NextResponse.json({ error: "Missing ?ticker=" }, { status: 400 });
  }
  const token = findByTicker(ticker);
  if (!token) {
    return NextResponse.json({ error: `Ticker ${ticker} not in registry.` }, { status: 404 });
  }

  const cached = await readCachedDetail(ticker);
  if (cached) {
    return NextResponse.json(
      { ok: true, cache: true, detail: cached },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  }
  const detail = await fetchAndCacheDetail(ticker);
  return NextResponse.json(
    { ok: true, cache: false, detail },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}
