/**
 * Blue Hood — per-ticker detail (T-B2).
 *
 * Returns M3 (liquidity) + D1 (holders) for one ticker, cache-first.
 * Cache logic + parallel-fetch live in `lib/blue-hood/ticker-detail.ts`
 * so the sparkline-refresh cron can warm the same entries (T-B.1 #3).
 *
 * ⚠️ THIS ENDPOINT IS ROBINHOOD-ONLY, AND NOW SAYS SO.
 * It always was: it resolves `?ticker=` against the RH `rwa-registry` and both
 * upstream tools read chain 4663. That contract was IMPLICIT, which is how the
 * board came to render RH pools under a BASE badge — the caller had no way to
 * state a chain and the route had no way to refuse one. `?chain=` now makes the
 * contract explicit. It defaults to `robinhood` because that is what every
 * pre-existing caller meant, not because a chain-less request is assumed to be
 * RH; an unknown or unsupported chain is REFUSED rather than served RH numbers.
 */
import { NextRequest, NextResponse } from "next/server";
import { findByTicker } from "@/lib/robinhood/rwa-registry";
import { fetchAndCacheDetail, readCachedDetail } from "@/lib/blue-hood/ticker-detail";
import { detailPanelPlan } from "@/lib/blue-hood/detail-support";
import type { HoodChain } from "@/lib/blue-hood/types";

export const runtime = "nodejs";

const KNOWN_CHAINS: readonly HoodChain[] = ["robinhood", "base"];

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const rawTicker = url.searchParams.get("ticker") ?? "";
  const ticker = rawTicker.trim().toUpperCase();
  if (!ticker) {
    return NextResponse.json({ error: "Missing ?ticker=" }, { status: 400 });
  }

  // Absent ⟹ robinhood, matching `chainOf` and every caller that predates the
  // Base desk. An unrecognised value is a 400, never a fallthrough: guessing is
  // the failure mode this whole change exists to remove.
  const rawChain = (url.searchParams.get("chain") ?? "robinhood").trim().toLowerCase();
  if (!(KNOWN_CHAINS as readonly string[]).includes(rawChain)) {
    return NextResponse.json(
      { error: `Unknown chain "${rawChain}". Expected one of: ${KNOWN_CHAINS.join(", ")}.` },
      { status: 400 },
    );
  }
  const chain = rawChain as HoodChain;

  const plan = detailPanelPlan(chain);
  if (!plan.fetch) {
    // Not a 404 (the ticker may well exist on that desk) and not a 500
    // (nothing broke). The capability does not exist yet, and the response says
    // which blocks are missing and why rather than substituting another chain's.
    return NextResponse.json(
      {
        ok: false,
        chain,
        ticker,
        error: `No liquidity/holders source is wired for chain "${chain}".`,
        liquidity_note: plan.liquidityNote,
        holders_note: plan.holdersNote,
      },
      { status: 501, headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  }

  const token = findByTicker(ticker);
  if (!token) {
    return NextResponse.json({ error: `Ticker ${ticker} not in registry.` }, { status: 404 });
  }

  const cached = await readCachedDetail(chain, ticker);
  if (cached) {
    return NextResponse.json(
      { ok: true, cache: true, chain, detail: cached },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  }
  const detail = await fetchAndCacheDetail(chain, ticker);
  return NextResponse.json(
    { ok: true, cache: false, chain, detail },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}
