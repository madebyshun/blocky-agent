// x402/rh-stock-holdings (P1) — full RH RWA portfolio for a wallet.
// Price: $0.05
//
// For a given wallet on Robinhood Chain, reads balanceOf for every token in
// the canonical RWA registry, prices non-zero balances via Chainlink (fallback
// DEX spot), and returns holdings sorted by USD value.
//
// Real on-chain reads — no LLM, no fabrication. If a token has no price
// source, value_usd is `null` (rather than a guess). If a balanceOf read
// itself fails, the token is reported in `unread_count` instead of being
// folded in as a zero — "we couldn't look" and "you own none" are different
// answers, and only one of them is safe to total up.

import { getAddress, isAddress } from "viem";
import { RH_CHAIN, RWA_TOKENS } from "@/lib/robinhood/rwa-registry";
import { readAllBalances, priceHoldings } from "@/lib/robinhood/rwa-portfolio";

export default async function handler(req: Request): Promise<Response> {
  try {
    let body: { wallet?: string; address?: string } = {};
    try { const t = await req.text(); if (t?.trim().startsWith("{")) body = JSON.parse(t); } catch {}
    const url = new URL(req.url);
    const walletRaw = (body.wallet ?? body.address ?? url.searchParams.get("wallet") ?? url.searchParams.get("address") ?? "").trim();

    if (!isAddress(walletRaw)) {
      return Response.json({ error: "Provide `wallet` — a valid 0x address." }, { status: 400 });
    }

    const wallet = getAddress(walletRaw);
    const timestamp = new Date().toISOString();

    const rawBalances = await readAllBalances(wallet);
    const holdings = await priceHoldings(rawBalances);

    const total_value_usd = holdings.reduce((s, h) => s + (h.value_usd ?? 0), 0);
    const priced_count = holdings.filter((h) => h.value_usd !== null).length;
    const unread = rawBalances.filter((b) => b.failed);

    return Response.json({
      tool: "rh-stock-holdings",
      wallet,
      total_value_usd,
      holdings_count: holdings.length,
      priced_count,
      tokens_scanned: RWA_TOKENS.length,
      /** balanceOf reverted or timed out for these — the portfolio below is
       *  incomplete by exactly this many tokens, not confirmed empty. */
      unread_count: unread.length,
      unread_tickers: unread.map((b) => b.token.ticker),
      holdings,
      note: unread.length > 0
        ? `${unread.length} of ${RWA_TOKENS.length} balance reads failed — this portfolio is incomplete, not empty, for those tokens. Retry before treating the total as final.`
        : holdings.length === 0
          ? "Wallet holds no tokens from the canonical Robinhood Chain RWA registry."
          : priced_count < holdings.length
            ? `${holdings.length - priced_count} holding(s) lack a live price source — value_usd is null for those.`
            : null,
      data_sources: [
        "on-chain RH RPC (ERC-20 balanceOf)",
        "Chainlink AggregatorV3 on-chain",
        "api.geckoterminal.com (RH Chain) — fallback",
      ],
      network: RH_CHAIN,
      timestamp,
    });
  } catch (e) {
    return Response.json({ error: "rh-stock-holdings failed", message: (e as Error).message }, { status: 500 });
  }
}
