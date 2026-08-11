// x402/rh-stock-correlations (D5) — on-chain price correlation matrix.
// Price: $0.10
//
// Reads GeckoTerminal OHLC (daily) for each ticker's deepest pool, computes
// pairwise Pearson correlations. Real math — no LLM.
//
// Caveat: OHLC availability on RH Chain is nascent (some pools have < 7
// candles). If a ticker has < 3 overlapping candles with another, correlation
// is returned as null with an honest "insufficient overlap" note.

import { RH_CHAIN, findByTicker } from "@/lib/robinhood/rwa-registry";
import { poolsForToken, poolOhlc, type Candle } from "@/lib/robinhood/rwa-market";

export default async function handler(req: Request): Promise<Response> {
  try {
    let body: { tickers?: string[]; days?: number } = {};
    try { const t = await req.text(); if (t?.trim().startsWith("{")) body = JSON.parse(t); } catch {}
    const url = new URL(req.url);
    const tickersRaw = body.tickers ?? (url.searchParams.get("tickers") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const days = Math.max(3, Math.min(90, Number(body.days ?? url.searchParams.get("days") ?? 30)));

    if (!tickersRaw.length || tickersRaw.length > 10) {
      return Response.json({ error: "Provide `tickers` — 2 to 10 tickers." }, { status: 400 });
    }
    const tokens = tickersRaw.map((t) => findByTicker(t)).filter((t): t is NonNullable<typeof t> => !!t);
    if (tokens.length < 2) {
      return Response.json({ error: "Fewer than 2 valid tickers resolved." }, { status: 400 });
    }

    const timestamp = new Date().toISOString();

    // Fetch daily candles for each token's deepest pool. Prefer base-side pools
    // (already-USD candles). If all pools are quote-side, we skip (correlation
    // is invariant to constant scaling, so USDG-quoted OHLC pairs are OK too).
    const series = await Promise.all(
      tokens.map(async (t) => {
        const pools = await poolsForToken(t.contract);
        if (!pools.length) return { token: t, closes: [] as { t: number; c: number }[] };
        const basePool = pools.find((p) => p.token_is_base) ?? pools[0];
        const invert = !basePool.token_is_base;
        const mul = invert ? (basePool.counterparty_usd ?? 1) : 1;
        const candles = await poolOhlc(basePool.address, "day", days, { invert, usd_multiplier: mul });
        return {
          token: t,
          closes: (candles ?? []).map((c: Candle) => ({ t: c.t, c: c.c })).filter((x) => Number.isFinite(x.c)),
        };
      }),
    );

    // Build a keyed timeline: map ticker → { ts → close }
    const byTicker: Record<string, Record<number, number>> = {};
    for (const s of series) byTicker[s.token.ticker] = Object.fromEntries(s.closes.map((x) => [x.t, x.c]));

    // Pairwise correlation using overlapping timestamps only.
    type Corr = { a: string; b: string; overlap: number; corr: number | null };
    const rows: Corr[] = [];
    for (let i = 0; i < tokens.length; i++) {
      for (let j = i + 1; j < tokens.length; j++) {
        const A = tokens[i].ticker, B = tokens[j].ticker;
        const aMap = byTicker[A], bMap = byTicker[B];
        const common = Object.keys(aMap).filter((k) => bMap[+k] !== undefined).map(Number).sort();
        if (common.length < 3) { rows.push({ a: A, b: B, overlap: common.length, corr: null }); continue; }
        const xs = common.map((k) => aMap[k]);
        const ys = common.map((k) => bMap[k]);
        const corr = pearson(xs, ys);
        rows.push({ a: A, b: B, overlap: common.length, corr });
      }
    }

    return Response.json({
      tool: "rh-stock-correlations",
      window_days: days,
      tickers: tokens.map((t) => t.ticker),
      series_lengths: Object.fromEntries(tokens.map((t) => [t.ticker, (byTicker[t.ticker] && Object.keys(byTicker[t.ticker]).length) || 0])),
      correlations: rows,
      note: "Pearson r over overlapping daily closes from GeckoTerminal pool OHLC. Correlation null when overlap < 3 candles — RH RWA OHLC history is still shallow.",
      data_sources: ["api.geckoterminal.com (RH Chain)"],
      network: RH_CHAIN,
      timestamp,
    });
  } catch (e) {
    return Response.json({ error: "rh-stock-correlations failed", message: (e as Error).message }, { status: 500 });
  }
}

function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 2 || n !== ys.length) return null;
  const mx = xs.reduce((s, x) => s + x, 0) / n;
  const my = ys.reduce((s, y) => s + y, 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    num += dx * dy; dx2 += dx * dx; dy2 += dy * dy;
  }
  if (dx2 === 0 || dy2 === 0) return null;
  return +(num / Math.sqrt(dx2 * dy2)).toFixed(6);
}
