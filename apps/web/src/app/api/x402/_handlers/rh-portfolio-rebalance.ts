// x402/rh-portfolio-rebalance (P3) — target allocation → swap plan.
// Price: $0.20
//
// Given a wallet's current RH RWA positions + a desired target allocation
// (map of ticker → target weight), computes the diff and produces an
// ordered swap plan to move from current to target. Non-custodial — plan
// is a list of {sell_ticker, buy_ticker, amount_usd} entries that the
// caller feeds to rh-stock-swap-prepare (X2) to execute.
//
// Real math, not LLM-generated. Uses current USD values from P1 + user's
// target weights. Never produces a plan that includes tickers outside the
// canonical registry.

import { getAddress, isAddress } from "viem";
import { RH_CHAIN, RWA_TOKENS } from "@/lib/robinhood/rwa-registry";
import { readAllBalances, priceHoldings } from "@/lib/robinhood/rwa-portfolio";

type TargetWeights = Record<string, number>;

export default async function handler(req: Request): Promise<Response> {
  try {
    let body: { wallet?: string; targets?: TargetWeights; min_swap_usd?: number } = {};
    try { const t = await req.text(); if (t?.trim().startsWith("{")) body = JSON.parse(t); } catch {}
    const url = new URL(req.url);
    const walletRaw = (body.wallet ?? url.searchParams.get("wallet") ?? "").trim();
    const targets = body.targets ?? {};
    const minSwapUsd = Math.max(0, Number(body.min_swap_usd ?? url.searchParams.get("min_swap_usd") ?? 1));

    if (!isAddress(walletRaw)) {
      return Response.json({ error: "Provide `wallet` — a valid 0x address." }, { status: 400 });
    }
    if (!targets || Object.keys(targets).length === 0) {
      return Response.json({ error: "Provide `targets` — a map of ticker → weight (e.g. {\"AAPL\": 0.5, \"TSLA\": 0.5})." }, { status: 400 });
    }

    const wallet = getAddress(walletRaw);
    const timestamp = new Date().toISOString();

    // ── Validate targets: sum ≈ 1.0, tickers in registry ────────────────
    const registry = new Map(RWA_TOKENS.map((t) => [t.ticker.toUpperCase(), t]));
    const normalized: Record<string, number> = {};
    let sum = 0;
    for (const [ticker, weight] of Object.entries(targets)) {
      const upper = ticker.toUpperCase();
      if (!registry.has(upper)) {
        return Response.json({ error: `Ticker ${ticker} is not in the canonical RH RWA registry.` }, { status: 400 });
      }
      if (!Number.isFinite(weight) || weight < 0) {
        return Response.json({ error: `Weight for ${ticker} must be a non-negative number.` }, { status: 400 });
      }
      normalized[upper] = weight;
      sum += weight;
    }
    if (sum <= 0) {
      return Response.json({ error: "Sum of target weights must be > 0." }, { status: 400 });
    }
    // Normalize to 1.0 so partial targets are meaningful.
    for (const k of Object.keys(normalized)) normalized[k] /= sum;

    // ── Read current portfolio ──────────────────────────────────────────
    const rawBalances = await readAllBalances(wallet);

    // A rebalance plan is an instruction to move real money, and it is derived
    // entirely from the *difference* between current and target weights. A
    // balanceOf that failed enters that math as a zero, which is not a neutral
    // error: a position we couldn't read looks maximally underweight, so the
    // plan confidently tells you to buy more of something you already hold —
    // and funds it by selling something you do hold. Degrading gracefully here
    // would mean emitting a plausible, well-formed, wrong plan. So we refuse.
    // The x402 route only settles on a 200 with no `error`, so this path costs
    // the caller nothing and asks them to retry.
    const unread = rawBalances.filter((b) => b.failed);
    if (unread.length > 0) {
      return Response.json({
        error: `Refusing to plan: ${unread.length} of ${RWA_TOKENS.length} balance reads failed, so the current allocation is unknown, not empty. A rebalance computed from partial balances would sell real positions to buy into ones that only appear underweight. Retry.`,
        tool: "rh-portfolio-rebalance",
        wallet,
        tokens_scanned: RWA_TOKENS.length,
        unread_count: unread.length,
        unread_tickers: unread.map((b) => b.token.ticker),
        network: RH_CHAIN, timestamp,
      }, { status: 503 });
    }

    const holdings = await priceHoldings(rawBalances);
    const total_value_usd = holdings.reduce((s, h) => s + (h.value_usd ?? 0), 0);

    if (total_value_usd <= 0) {
      return Response.json({
        tool: "rh-portfolio-rebalance",
        wallet, total_value_usd,
        holdings_count: holdings.length,
        plan: [],
        // "Add funds" is the wrong advice when the wallet is funded but every
        // position is unpriceable — most RH stock tokens have neither a
        // Chainlink feed nor a pool, so a real portfolio can total $0 here.
        note: holdings.length > 0
          ? `Wallet holds ${holdings.length} RWA token(s) but none of them resolve to a USD price (no Chainlink feed, no DEX pool), so there is no value to redistribute. This is a pricing gap, not an empty wallet — a rebalance cannot be sized without prices.`
          : "Wallet holds no RH RWA tokens from the canonical registry. Rebalance requires an existing portfolio to redistribute — add funds first, then run.",
        network: RH_CHAIN, timestamp,
      });
    }

    // Map current allocation.
    const current: Record<string, number> = {};
    for (const h of holdings) {
      if (h.value_usd) current[h.ticker.toUpperCase()] = h.value_usd;
    }

    // ── Diff: delta_usd per ticker = target − current ───────────────────
    const universe = new Set<string>([...Object.keys(current), ...Object.keys(normalized)]);
    const deltas: Array<{ ticker: string; current_usd: number; target_usd: number; delta_usd: number }> = [];
    for (const ticker of universe) {
      const target_usd = (normalized[ticker] ?? 0) * total_value_usd;
      const current_usd = current[ticker] ?? 0;
      const delta_usd = target_usd - current_usd;
      deltas.push({ ticker, current_usd, target_usd, delta_usd });
    }
    // Above-min-swap deltas only.
    const sells = deltas.filter((d) => d.delta_usd < -minSwapUsd).sort((a, b) => a.delta_usd - b.delta_usd);
    const buys  = deltas.filter((d) => d.delta_usd >  minSwapUsd).sort((a, b) => b.delta_usd - a.delta_usd);

    // ── Greedy pairing: match largest sell with largest buy, until one empties ──
    type Leg = {
      sell_ticker: string; buy_ticker: string;
      amount_usd: number;
      hint: { via_denom: "USDG"; next_tool: "rh-stock-swap-prepare" };
    };
    const plan: Leg[] = [];
    let si = 0, bi = 0;
    const sellsCopy = sells.map((d) => ({ ...d }));
    const buysCopy  = buys.map((d) => ({ ...d }));
    while (si < sellsCopy.length && bi < buysCopy.length) {
      const s = sellsCopy[si], b = buysCopy[bi];
      const move = Math.min(-s.delta_usd, b.delta_usd);
      plan.push({
        sell_ticker: s.ticker,
        buy_ticker: b.ticker,
        amount_usd: +move.toFixed(4),
        hint: { via_denom: "USDG", next_tool: "rh-stock-swap-prepare" },
      });
      s.delta_usd += move;
      b.delta_usd -= move;
      if (Math.abs(s.delta_usd) < 0.0001) si++;
      if (Math.abs(b.delta_usd) < 0.0001) bi++;
    }

    return Response.json({
      tool: "rh-portfolio-rebalance",
      wallet, total_value_usd,
      target_weights: normalized,
      current_allocation: current,
      deltas,
      plan,
      plan_count: plan.length,
      note: "Plan is a set of USD-denominated pair swaps. For each leg, call rh-stock-swap-prepare twice — first sell → USDG, then USDG → buy. Route V4 pools (USDG-native) may require the Universal Router path (see Task #98).",
      min_swap_usd: minSwapUsd,
      data_sources: ["on-chain RH RPC (balanceOf)", "Chainlink AggregatorV3"],
      network: RH_CHAIN,
      timestamp,
    });
  } catch (e) {
    return Response.json({ error: "rh-portfolio-rebalance failed", message: (e as Error).message }, { status: 500 });
  }
}
