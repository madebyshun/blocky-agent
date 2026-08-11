// x402/rh-stock-holders (D1) — top holders + concentration for an RH RWA.
// Price: $0.05
//
// Data: robinhoodchain.blockscout.com API v2 /tokens/{addr}/holders.
// Concentration: Gini-adjusted Herfindahl-Hirschman-inspired score based on
// top-N shares — surfaces whether a token's supply is broadly distributed
// or concentrated in a few wallets.

import { RH_CHAIN, findByTicker } from "@/lib/robinhood/rwa-registry";

const BS = "https://robinhoodchain.blockscout.com/api/v2";

type Holder = { address?: { hash?: string }; value?: string };
type Resp = { items?: Holder[]; next_page_params?: unknown };

export default async function handler(req: Request): Promise<Response> {
  try {
    let body: { ticker?: string; contract?: string; limit?: number } = {};
    try { const t = await req.text(); if (t?.trim().startsWith("{")) body = JSON.parse(t); } catch {}
    const url = new URL(req.url);
    const ticker = (body.ticker ?? url.searchParams.get("ticker") ?? "").trim();
    const contractRaw = (body.contract ?? url.searchParams.get("contract") ?? "").trim();
    const limit = Math.max(1, Math.min(50, Number(body.limit ?? url.searchParams.get("limit") ?? 10)));

    let contract = contractRaw;
    let name: string | null = null;
    if (ticker) {
      const t = findByTicker(ticker);
      if (!t) return Response.json({ tool: "rh-stock-holders", ticker, error: "Ticker not in registry." }, { status: 404 });
      contract = t.contract;
      name = t.name;
    }
    if (!/^0x[a-fA-F0-9]{40}$/.test(contract)) {
      return Response.json({ error: "Provide `ticker` or `contract` (0x address)." }, { status: 400 });
    }

    const timestamp = new Date().toISOString();

    let items: Holder[] = [];
    try {
      const r = await fetch(`${BS}/tokens/${contract}/holders`, {
        signal: AbortSignal.timeout(10000),
        headers: { accept: "application/json" },
      });
      if (r.ok) {
        const d = (await r.json()) as Resp;
        items = d.items ?? [];
      }
    } catch { /* swallow */ }

    if (!items.length) {
      return Response.json({
        tool: "rh-stock-holders",
        ticker: ticker || null,
        contract,
        holders: [],
        note: "No holder data available from Blockscout for this token.",
        data_sources: ["robinhoodchain.blockscout.com API v2"],
        network: RH_CHAIN, timestamp,
      });
    }

    const totalBn = items.reduce((s, h) => s + BigInt(h.value ?? "0"), 0n);
    const total = Number(totalBn);
    const holders = items.slice(0, limit).map((h) => {
      const v = Number(BigInt(h.value ?? "0"));
      return {
        address: h.address?.hash ?? "",
        balance_raw: h.value ?? "0",
        share_pct: total > 0 ? +(100 * v / total).toFixed(4) : null,
      };
    });

    // Concentration proxies (real math, no LLM):
    //   • top1_pct / top10_pct — the classic distribution snapshot
    //   • HHI over the returned page (sum of squared shares × 10_000) — 0 = flat, 10_000 = one holder
    const shares = items.map((h) => total > 0 ? Number(BigInt(h.value ?? "0")) / total : 0);
    const top1_pct = shares[0] ? shares[0] * 100 : null;
    const top10_pct = shares.slice(0, 10).reduce((s, x) => s + x, 0) * 100;
    const hhi = shares.reduce((s, x) => s + x * x, 0) * 10_000;

    return Response.json({
      tool: "rh-stock-holders",
      ticker: ticker || null,
      name,
      contract,
      holders,
      returned_count: holders.length,
      concentration: {
        top1_pct: top1_pct !== null ? +top1_pct.toFixed(4) : null,
        top10_pct: +top10_pct.toFixed(4),
        hhi: +hhi.toFixed(2),
        hhi_note: "Herfindahl-Hirschman index over returned holders. 0 = perfectly distributed; 10000 = single holder.",
      },
      note: "Blockscout holder listing may paginate. This response is the first page (up to Blockscout's default), truncated to `limit`.",
      data_sources: ["robinhoodchain.blockscout.com API v2"],
      network: RH_CHAIN, timestamp,
    });
  } catch (e) {
    return Response.json({ error: "rh-stock-holders failed", message: (e as Error).message }, { status: 500 });
  }
}
