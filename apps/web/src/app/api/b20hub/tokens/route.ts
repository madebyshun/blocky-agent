import { NextRequest, NextResponse } from "next/server";
import { getLaunches } from "@/lib/launches";
import { getTokenMarket } from "@/lib/market-data";
import { B20HUB_HOOK, B20HUB_LAUNCHER } from "@/lib/b20hub/constants";

// In-module cache mirroring the one in /api/b20hub/pool/[address]. Fine for
// dev + Vercel warm lambdas — a cold lambda just refetches.
let _ethCache: { at: number; usd: number | null } | null = null;
async function fetchEthPriceUsd(): Promise<number | null> {
  const now = Date.now();
  if (_ethCache && now - _ethCache.at < 5 * 60_000) return _ethCache.usd;
  try {
    const r = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
      { signal: AbortSignal.timeout(4000), headers: { Accept: "application/json" } },
    );
    if (!r.ok) throw new Error(`CG ${r.status}`);
    const j = (await r.json()) as { ethereum?: { usd?: number } };
    const usd = j?.ethereum?.usd;
    if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0) {
      throw new Error("bad payload");
    }
    _ethCache = { at: now, usd };
    return usd;
  } catch {
    _ethCache = { at: now, usd: 3000 };
    return 3000;
  }
}

export const runtime = "nodejs";
export const maxDuration = 15;

/**
 * GET /api/b20hub/tokens — B20HUB-only feed.
 *
 * B20HUB tokens are asset-variant B20s (address prefix 0xb200…) deployed on
 * Base through our launcher. We filter the shared launch registry by that
 * prefix rather than by launcherAddress because the registry predates the
 * launcher tag; once every record carries a launcherAddress we'll switch
 * to an exact-match filter (see follow-up ticket in the layout comment).
 *
 * Response shape mirrors /api/launches (with market enrichment) so the
 * feed grid can reuse the /app/launches Launch type.
 */
export interface B20HUBFeedResponse {
  ok: boolean;
  count: number;
  stats: {
    tracked: number;
    totalMarketCap: number;
    totalVolume24h: number;
  };
  hook: string;
  launcher: string;
  tokens: Array<{
    tokenAddress: string;
    tokenName: string;
    tokenSymbol: string;
    image?: string | null;
    feeRecipient?: { type: string; value: string };
    txHash?: string | null;
    launchedAt: number;
    market:
      | {
          priceUsd?: number | null;
          marketCap?: number | null;
          volume24h?: number | null;
          liquidityUsd?: number | null;
          change24h?: number | null;
        }
      | null;
  }>;
}

export async function GET(req: NextRequest) {
  const limitParam = Number(req.nextUrl.searchParams.get("limit") ?? "50");
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(1, limitParam), 200) : 50;

  const all = await getLaunches(500);

  // Filter: asset-variant B20 (0xb200… prefix) on Base.
  const b20hub = all
    .filter(
      (l) =>
        typeof l.tokenAddress === "string" &&
        l.tokenAddress.toLowerCase().startsWith("0xb200") &&
        (l.chain ?? "base") === "base",
    )
    .slice(0, limit);

  // v6 launcher's OPENING_SQRT_PRICE_X96 constant → 3.333 ETH per 100B.
  // Used as fallback opening mcap when DexScreener has no data yet
  // (typical for a token < 1h old). Tokens with real DEX data still use
  // DexScreener's live figures; tokens launched under v5 (1.333 ETH per
  // 100B) will read slightly high here until DexScreener catches up,
  // but that's a corner case since v5 tokens are all >24h old at this
  // point and DexScreener has them all indexed.
  //
  // Real per-token mcap for the token detail page comes from
  // /api/b20hub/pool/[address] which reads actual slot0 sqrtPrice — that
  // path is always correct regardless of which launcher deployed the token.
  const ethSpotUsd = await fetchEthPriceUsd();
  // 3.333 ETH in "milli-ETH × 1000" precision (3_333_333 × 1e6). Keeping
  // this here as a magic number is fine because it's tied 1:1 to the
  // launcher contract constant — shifting the launcher forces this too.
  const OPENING_ETH_PER_100B_X1e6 = 3_333_333n;
  const openingMcapUsd = ethSpotUsd != null
    ? ethSpotUsd * (Number(OPENING_ETH_PER_100B_X1e6) / 1e6)  // → USD
    : null;

  // Enrich the newest 40 with DexScreener market data. Fail-soft.
  const ENRICH = 40;
  const enriched = await Promise.all(
    b20hub.map(async (l, i) => {
      if (i >= ENRICH) return { ...l, market: null };
      const m = await getTokenMarket(l.tokenAddress).catch(() => null);
      if (m) {
        return {
          ...l,
          market: {
            priceUsd:     m.priceUsd,
            marketCap:    m.marketCap ?? m.fdv,
            volume24h:    m.volume24h,
            liquidityUsd: m.liquidityUsd,
            change24h:    m.change.h24,
          },
        };
      }
      // No DexScreener data → fall back to the opening constant so the card
      // shows something meaningful. Volume/change stay null until a trade
      // gets indexed.
      return {
        ...l,
        market: openingMcapUsd != null ? {
          priceUsd:     openingMcapUsd / 100_000_000_000,   // $ / whole token
          marketCap:    openingMcapUsd,
          volume24h:    null,
          liquidityUsd: null,
          change24h:    null,
        } : null,
      };
    }),
  );

  const withMarket = enriched.filter((l) => l.market);
  const totalMcap = withMarket.reduce((s, l) => s + (l.market?.marketCap ?? 0), 0);
  const totalVol  = withMarket.reduce((s, l) => s + (l.market?.volume24h ?? 0), 0);

  return NextResponse.json<B20HUBFeedResponse>({
    ok: true,
    count: b20hub.length,
    stats: {
      tracked:         withMarket.length,
      totalMarketCap:  totalMcap,
      totalVolume24h:  totalVol,
    },
    hook:     B20HUB_HOOK,
    launcher: B20HUB_LAUNCHER,
    tokens:   enriched,
  }, {
    headers: {
      "Cache-Control": "public, s-maxage=30, stale-while-revalidate=120",
    },
  });
}
