// x402/rh-stock-holdings (P1) — full RH RWA portfolio for a wallet.
// Price: $0.05
//
// For a given wallet on Robinhood Chain, reads balanceOf for all 26 tokens
// in the canonical RWA registry, prices non-zero balances via Chainlink
// (fallback DEX spot), and returns holdings sorted by USD value.
//
// Real on-chain reads — no LLM, no fabrication. If a token has no price
// source, value_usd is `null` (rather than a guess).

import { getAddress, isAddress } from "viem";
import { RH_CHAIN } from "@/lib/robinhood/rwa-registry";
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

    return Response.json({
      tool: "rh-stock-holdings",
      wallet,
      total_value_usd,
      holdings_count: holdings.length,
      priced_count,
      holdings,
      note: holdings.length === 0
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
