// x402/rh-stock-flow (D2) — buy vs sell pressure 24h.
// Price: $0.10
//
// Uses GeckoTerminal's trades endpoint for the RWA's deepest pool. For each
// trade, side is inferred from GT's `kind` field (buy/sell). Computes
// aggregate volume + count per side over the last 24h.
//
// If GT trades feed is empty (thin pool, rate-limit), returns honest zeros
// with a note. Never fabricates flow.

import { RH_CHAIN, findByTicker } from "@/lib/robinhood/rwa-registry";
import { poolsForToken } from "@/lib/robinhood/rwa-market";

const GT = "https://api.geckoterminal.com/api/v2/networks/robinhood";

type Trade = {
  attributes?: {
    kind?: "buy" | "sell";
    volume_in_usd?: string;
    from_token_amount?: string;
    to_token_amount?: string;
    block_timestamp?: string;    // ISO
    tx_hash?: string;
  };
};

export default async function handler(req: Request): Promise<Response> {
  try {
    let body: { ticker?: string } = {};
    try { const t = await req.text(); if (t?.trim().startsWith("{")) body = JSON.parse(t); } catch {}
    const url = new URL(req.url);
    const ticker = (body.ticker ?? url.searchParams.get("ticker") ?? "").trim();
    if (!ticker) return Response.json({ error: "Provide `ticker`." }, { status: 400 });

    const token = findByTicker(ticker);
    if (!token) return Response.json({ tool: "rh-stock-flow", ticker, error: "Ticker not in registry." }, { status: 404 });

    const timestamp = new Date().toISOString();
    const pools = await poolsForToken(token.contract);
    if (!pools.length) {
      return Response.json({
        tool: "rh-stock-flow",
        ticker: token.ticker,
        pool_count: 0,
        note: "No DEX pool found for this token on Robinhood Chain.",
        network: RH_CHAIN, timestamp,
      });
    }

    const pool = pools[0];
    let trades: Trade[] = [];
    let gt_status: string | null = null;
    let gt_error: string | null = null;
    try {
      const r = await fetch(`${GT}/pools/${pool.pool_ref}/trades`, {
        signal: AbortSignal.timeout(8000),
        headers: { accept: "application/json;version=20230302" },
      });
      gt_status = `${r.status}`;
      if (r.ok) {
        const d = (await r.json()) as { data?: Trade[] };
        trades = d.data ?? [];
      } else {
        gt_error = `blockscout_status_${gt_status}`;
      }
    } catch (e) {
      gt_error = `network_error: ${(e as Error).message}`;
    }

    const cutoff = Date.now() / 1000 - 24 * 3600;
    let buyCount = 0, sellCount = 0;
    let buyVolUsd = 0, sellVolUsd = 0;
    let latestTs = 0;
    for (const t of trades) {
      const attr = t.attributes; if (!attr) continue;
      const ts = attr.block_timestamp ? Math.floor(new Date(attr.block_timestamp).getTime() / 1000) : 0;
      if (ts && ts < cutoff) continue;
      const v = attr.volume_in_usd ? parseFloat(attr.volume_in_usd) : 0;
      if (attr.kind === "buy") { buyCount++; buyVolUsd += v; }
      else if (attr.kind === "sell") { sellCount++; sellVolUsd += v; }
      if (ts > latestTs) latestTs = ts;
    }

    const totalVol = buyVolUsd + sellVolUsd;
    const netUsd = buyVolUsd - sellVolUsd;
    let pressure: "BUY_HEAVY" | "SELL_HEAVY" | "BALANCED" = "BALANCED";
    if (totalVol > 0) {
      const pct = Math.abs(netUsd) / totalVol;
      if (pct > 0.10 && netUsd > 0) pressure = "BUY_HEAVY";
      else if (pct > 0.10 && netUsd < 0) pressure = "SELL_HEAVY";
    }

    const warnings: string[] = [];
    if (gt_error) warnings.push(`gt_trades_fetch_failed: ${gt_error}`);
    // Cross-check: if pool has real 24h volume but trades feed came back
    // empty, that's an inconsistency worth surfacing (usually rate-limit).
    const poolVol = pool.volume_24h_usd ?? 0;
    if (trades.length === 0 && poolVol > 100) {
      warnings.push(`trades_feed_empty_but_pool_has_volume: pool reports $${poolVol.toFixed(2)} 24h volume; likely a GT rate-limit — retry`);
    }
    // If we HAVE trades but our total is way off pool.volume_24h, note it.
    if (totalVol > 0 && poolVol > 0 && Math.abs(totalVol - poolVol) / poolVol > 0.5) {
      warnings.push(`volume_mismatch: trades-feed total $${totalVol.toFixed(0)} vs pool.volume_24h $${poolVol.toFixed(0)} — feed is paginated, our 1-page snapshot doesn't cover full 24h`);
    }

    return Response.json({
      tool: "rh-stock-flow",
      ticker: token.ticker,
      name: token.name,
      contract: token.contract,
      pool: {
        pool_ref: pool.pool_ref,
        is_v4_pool_id: pool.is_v4_pool_id,
        address: pool.address,   // back-compat
        name: pool.name,
        dex: pool.dex,
        tvl_usd: pool.reserve_usd,
        volume_24h_usd_from_pool_meta: pool.volume_24h_usd,
      },
      window_hours: 24,
      trades_seen: trades.length,
      gt_trades_endpoint_status: gt_status,
      buy_count: buyCount,
      sell_count: sellCount,
      buy_volume_usd: +buyVolUsd.toFixed(4),
      sell_volume_usd: +sellVolUsd.toFixed(4),
      net_volume_usd: +netUsd.toFixed(4),
      total_volume_usd: +totalVol.toFixed(4),
      pressure,
      latest_trade_unix: latestTs || null,
      warnings,
      note: trades.length === 0
        ? "GT trades feed returned no data — see warnings for likely cause. Do not conclude 'no activity' if pool.volume_24h_usd_from_pool_meta is non-zero."
        : "Pressure verdict is hard-mapped from net/total ratio > 10% — not LLM-generated.",
      data_sources: ["api.geckoterminal.com (RH Chain)"],
      network: RH_CHAIN, timestamp,
    });
  } catch (e) {
    return Response.json({ error: "rh-stock-flow failed", message: (e as Error).message }, { status: 500 });
  }
}
