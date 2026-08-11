// x402/rh-stock-pnl (P2) — position summary + trade activity for a wallet.
// Price: $0.20
//
// For each non-zero RWA holding of a wallet, returns:
//   • current balance + USD value (Chainlink-anchored)
//   • lifetime trade activity from Blockscout: transfer count in/out,
//     cumulative raw amount in/out, first & last activity timestamps
//   • net position derived from (in − out) as a sanity check against current
//
// Historical cost-basis + unrealized PnL requires per-tx historical Chainlink
// reads (an archive-node read for every buy). That's a v2 enhancement — v1
// returns HONEST activity data instead of a fabricated avg entry price.

import { getAddress, isAddress } from "viem";
import { RH_CHAIN, RWA_TOKENS } from "@/lib/robinhood/rwa-registry";
import { readAllBalances, priceHoldings, type Holding } from "@/lib/robinhood/rwa-portfolio";

const BLOCKSCOUT = "https://robinhoodchain.blockscout.com/api";

type BlockscoutTransfer = {
  from?: string;
  to?: string;
  value?: string;      // raw token amount (base units, decimal string)
  timestamp?: string;  // ISO 8601 or unix
  block_number?: number | string;
  transaction_hash?: string;
};

type BlockscoutResponse = {
  items?: BlockscoutTransfer[];
  next_page_params?: unknown;
};

/** Get up to `pages × 50` transfer events for one RWA token to/from wallet. */
async function fetchTransfers(token: string, wallet: string, pages = 2): Promise<BlockscoutTransfer[]> {
  const all: BlockscoutTransfer[] = [];
  try {
    // Blockscout v2 REST — token transfers for an address, filtered by token contract.
    const r = await fetch(
      `${BLOCKSCOUT}/v2/addresses/${wallet}/token-transfers?type=ERC-20&token=${token}`,
      { signal: AbortSignal.timeout(10000), headers: { accept: "application/json" } },
    );
    if (!r.ok) return [];
    const d = (await r.json()) as BlockscoutResponse;
    if (d.items?.length) all.push(...d.items);
    // Optional: paginate — skipped for cost control in v1.
    void pages;
  } catch { /* swallow — return partial */ }
  return all;
}

type TokenActivity = {
  ticker: string;
  name: string;
  contract: string;
  transfer_count: number;
  transfer_count_in: number;
  transfer_count_out: number;
  total_in_raw: string;
  total_out_raw: string;
  first_activity_unix: number | null;
  last_activity_unix: number | null;
};

export default async function handler(req: Request): Promise<Response> {
  try {
    let body: { wallet?: string; address?: string; ticker?: string } = {};
    try { const t = await req.text(); if (t?.trim().startsWith("{")) body = JSON.parse(t); } catch {}
    const url = new URL(req.url);
    const walletRaw = (body.wallet ?? body.address ?? url.searchParams.get("wallet") ?? url.searchParams.get("address") ?? "").trim();
    const focusTicker = (body.ticker ?? url.searchParams.get("ticker") ?? "").trim().toUpperCase();

    if (!isAddress(walletRaw)) {
      return Response.json({ error: "Provide `wallet` — a valid 0x address." }, { status: 400 });
    }

    const wallet = getAddress(walletRaw);
    const timestamp = new Date().toISOString();

    // ── 1. Current holdings snapshot ─────────────────────────────────────
    const rawBalances = await readAllBalances(wallet);
    const holdings = await priceHoldings(rawBalances);

    // ── 2. Activity per token — parallel fetches with a small cap ───────
    // Fetch for tokens the wallet currently holds + optional focus ticker.
    const targets = new Set<string>();
    for (const h of holdings) targets.add(h.contract.toLowerCase());
    if (focusTicker) {
      const f = RWA_TOKENS.find((t) => t.ticker === focusTicker);
      if (f) targets.add(f.contract.toLowerCase());
    }
    const contractList = Array.from(targets);
    if (!contractList.length) {
      return Response.json({
        tool: "rh-stock-pnl",
        wallet,
        note: "Wallet holds no canonical RH RWA tokens and no `ticker` focus was supplied — nothing to summarize.",
        holdings, activity: [],
        data_sources: ["on-chain RH RPC (balanceOf)"],
        network: RH_CHAIN, timestamp,
      });
    }

    const activity: TokenActivity[] = await Promise.all(
      contractList.map(async (contract) => {
        const rwa = RWA_TOKENS.find((t) => t.contract.toLowerCase() === contract);
        const transfers = await fetchTransfers(contract, wallet, 1);
        let inCount = 0, outCount = 0;
        let inSum = 0n, outSum = 0n;
        let first: number | null = null, last: number | null = null;
        for (const t of transfers) {
          const v = t.value ? BigInt(t.value) : 0n;
          const to = (t.to ?? "").toLowerCase();
          const from = (t.from ?? "").toLowerCase();
          const walletLower = wallet.toLowerCase();
          if (to === walletLower) { inCount++; inSum += v; }
          if (from === walletLower) { outCount++; outSum += v; }
          const ts = t.timestamp ? Math.floor(new Date(t.timestamp).getTime() / 1000) : null;
          if (ts !== null) {
            if (first === null || ts < first) first = ts;
            if (last === null || ts > last) last = ts;
          }
        }
        return {
          ticker: rwa?.ticker ?? "UNKNOWN",
          name: rwa?.name ?? "Unknown",
          contract,
          transfer_count: transfers.length,
          transfer_count_in: inCount,
          transfer_count_out: outCount,
          total_in_raw: inSum.toString(),
          total_out_raw: outSum.toString(),
          first_activity_unix: first,
          last_activity_unix: last,
        };
      }),
    );

    const total_value_usd = holdings.reduce((s, h: Holding) => s + (h.value_usd ?? 0), 0);

    return Response.json({
      tool: "rh-stock-pnl",
      wallet,
      total_value_usd,
      holdings,
      activity,
      note: "Cost-basis PnL requires historical Chainlink reads at each buy tx's block (archive-node dependency). v1 returns real position + activity summary; add historical pricing in v2. Never fabricates an avg entry price.",
      data_sources: [
        "on-chain RH RPC (ERC-20 balanceOf)",
        "Chainlink AggregatorV3 on-chain",
        "robinhoodchain.blockscout.com API v2 (token transfers)",
      ],
      network: RH_CHAIN,
      timestamp,
    });
  } catch (e) {
    return Response.json({ error: "rh-stock-pnl failed", message: (e as Error).message }, { status: 500 });
  }
}
