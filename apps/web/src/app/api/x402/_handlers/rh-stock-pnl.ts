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

/**
 * Blockscout **v2** token-transfer shape.
 *
 * This type used to describe the v1 shape — `from`/`to` as plain address
 * strings and a flat `value`. v2 returns neither: the parties are AddressParam
 * objects (`{ hash, name, is_contract, … }`) and the amount lives under
 * `total.value` alongside its own `decimals`. Nothing type-checked the gap
 * because the response is cast, so the handler compiled fine and then threw
 * `t.to.toLowerCase is not a function` at runtime for any wallet that had
 * actually traded — i.e. every wallet this tool exists to serve. Verified
 * against a live response before rewriting.
 */
type BlockscoutTransfer = {
  from?: { hash?: string };
  to?: { hash?: string };
  total?: { value?: string; decimals?: string };  // raw amount, base units
  timestamp?: string;  // ISO 8601
  block_number?: number | string;
  transaction_hash?: string;
};

type BlockscoutResponse = {
  items?: BlockscoutTransfer[];
  next_page_params?: unknown;
};

/**
 * One page (≤50) of transfer events for a single RWA token to/from `wallet`.
 *
 * Deliberately one page — but the caller is told so. The counts derived from
 * this are labelled a window, not a lifetime, because "first_activity" computed
 * from a truncated page is not the first activity, it is the oldest row that
 * fit. `complete` distinguishes "this is all of it" from "there is more", and
 * `reachable` distinguishes both from "the explorer didn't answer", so a
 * zero-transfer result can't quietly mean an outage.
 */
async function fetchTransfers(
  token: string,
  wallet: string,
): Promise<{ items: BlockscoutTransfer[]; complete: boolean; reachable: boolean }> {
  try {
    const r = await fetch(
      `${BLOCKSCOUT}/v2/addresses/${wallet}/token-transfers?type=ERC-20&token=${token}`,
      { signal: AbortSignal.timeout(10000), headers: { accept: "application/json" } },
    );
    if (!r.ok) return { items: [], complete: false, reachable: false };
    const d = (await r.json()) as BlockscoutResponse;
    const items = d.items ?? [];
    return { items, complete: !d.next_page_params, reachable: true };
  } catch {
    return { items: [], complete: false, reachable: false };
  }
}

type TokenActivity = {
  ticker: string;
  name: string;
  contract: string;
  /** False when Blockscout has more pages — every count below is a window. */
  activity_complete: boolean;
  /** False when the explorer did not answer — 0 means "unknown", not "none". */
  explorer_reachable: boolean;
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
    // A balanceOf that threw is not a zero balance. Carry the distinction into
    // the response rather than letting a throttled read masquerade as "you
    // don't hold this" — every count and total below is short by this much.
    const unread = rawBalances.filter((b) => b.failed);

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
        tokens_scanned: RWA_TOKENS.length,
        unread_count: unread.length,
        unread_tickers: unread.map((b) => b.token.ticker),
        // "Nothing to summarize" is only true if we actually managed to look at
        // every token. With failed reads it becomes "nothing we could see".
        note: unread.length > 0
          ? `No holdings surfaced, but ${unread.length} of ${RWA_TOKENS.length} balance reads failed — this is "we couldn't check those", not "the wallet is empty". Retry before concluding anything.`
          : "Wallet holds no canonical RH RWA tokens and no `ticker` focus was supplied — nothing to summarize.",
        holdings, activity: [],
        data_sources: ["on-chain RH RPC (balanceOf)"],
        network: RH_CHAIN, timestamp,
      });
    }

    const activity: TokenActivity[] = await Promise.all(
      contractList.map(async (contract) => {
        const rwa = RWA_TOKENS.find((t) => t.contract.toLowerCase() === contract);
        const { items: transfers, complete, reachable } = await fetchTransfers(contract, wallet);
        let inCount = 0, outCount = 0;
        let inSum = 0n, outSum = 0n;
        let first: number | null = null, last: number | null = null;
        const walletLower = wallet.toLowerCase();
        for (const t of transfers) {
          // BigInt() throws on a malformed string; one bad row must not 500 the
          // whole tool, so it counts as a transfer with an unknown amount.
          let v = 0n;
          try { if (t.total?.value) v = BigInt(t.total.value); } catch { /* unknown amount */ }
          const to = (t.to?.hash ?? "").toLowerCase();
          const from = (t.from?.hash ?? "").toLowerCase();
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
          activity_complete: complete,
          explorer_reachable: reachable,
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
      tokens_scanned: RWA_TOKENS.length,
      /** balanceOf reverted or timed out for these — positions below are
       *  missing by exactly this many tokens, not confirmed absent. */
      unread_count: unread.length,
      unread_tickers: unread.map((b) => b.token.ticker),
      holdings,
      activity,
      /** Tokens whose transfer history ran past one Blockscout page. Their
       *  counts/sums/first_activity describe the most recent 50 transfers only. */
      activity_truncated_tickers: activity.filter((a) => a.explorer_reachable && !a.activity_complete).map((a) => a.ticker),
      activity_unreachable_tickers: activity.filter((a) => !a.explorer_reachable).map((a) => a.ticker),
      warnings: [
        unread.length > 0
          ? `${unread.length} of ${RWA_TOKENS.length} balanceOf reads failed — total_value_usd is a floor and a held position may be missing entirely. Retry before treating this as complete.`
          : null,
        activity.some((a) => a.explorer_reachable && !a.activity_complete)
          ? "some tokens have more transfer history than one Blockscout page holds — their transfer counts, in/out sums and first_activity_unix are a recent-50 window, not a lifetime"
          : null,
        activity.some((a) => !a.explorer_reachable)
          ? "Blockscout did not answer for some tokens — their zero transfer counts mean 'unknown', not 'never traded'"
          : null,
      ].filter((x): x is string => !!x),
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
