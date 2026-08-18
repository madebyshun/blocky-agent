/**
 * Blue Hood — EXECUTION PLAN (ACP Offering #1 compute skill).
 *
 * The paid deliverable other agents/protocols hire Blue Hood for: given a
 * tokenized-stock ticker + a USD size, return an EXECUTION plan —
 *   • the pool the recommended route fills + all pools (real RH-Chain depth),
 *   • estimated price impact (constant-product / xy=k, first-order),
 *   • whether to split the order across pools + the per-leg allocation,
 *   • the suggested route (direct-USDG vs WETH-hop) + which router executes it,
 *   • a severe-impact warning when the order is large vs available liquidity.
 *
 * The customer is a MACHINE — The Index / Robindex / IndexPad / RIF style
 * rebalancers that push hundreds of thousands of USD into the SAME 26 pools
 * Blue Hood scans, every ~15 min. They need slippage/route intelligence before
 * they fire. This is intelligence, NOT a venue: we return a plan, we never
 * execute a trade or move funds.
 *
 * ── Data & honesty (CLAUDE.md rules) ─────────────────────────────────────────
 * Every number is DERIVED IN CODE from ONE real source — GeckoTerminal's
 * Robinhood-Chain pool data via `poolsForToken` (`rwa-market.ts`), the same feed
 * the drift board and X3 route inspector read. NO LLM touches these numbers.
 * Missing data → an honest `decline` / `reject`, never a fabricated zero or a
 * guessed price.
 *
 * ── Route correctness (why we group by counterparty) ─────────────────────────
 * You can only SPLIT an order across pools that share the SAME counterparty
 * (same input asset). A USD-denominated buyer's viable entries are the USDG
 * frame (direct, single-hop) and the WETH frame (adds a USDG→WETH leg). Pools
 * where the token pairs with ANOTHER stock are not a sensible USD entry, so
 * they're excluded from routing (still counted in total TVL for context). We
 * recommend the frame with the lower real impact, preferring USDG within a tie
 * band to avoid the extra WETH leg.
 *
 * ── Why NOT reuse M3 / call X3 ───────────────────────────────────────────────
 * M3 (`liquidity-depth`) reads DexScreener **Base**, not RH Chain — wrong
 * market. X3 (`rh-stock-swap-route`) does ~8+ sequential on-chain V3 RPC reads
 * and, by its own note, RWA liquidity lives in V4 pools its V3 router can't even
 * execute against — slow (bad under an ACP SLA) and mostly "no V3 route". Both
 * ultimately read the SAME GeckoTerminal pool set we read directly here, so we
 * compose the *capability* (depth + route) from the RH-correct source in one
 * memoised call. The frozen M3/X3/P4 handlers are untouched.
 *
 * ── Slippage model caveat ────────────────────────────────────────────────────
 * xy=k treats each pool as full-range with one-side depth ≈ reserve_usd/2. RH
 * RWA pools are Uniswap V4 with CONCENTRATED liquidity near mid, so for the same
 * TVL the true impact near price is usually LOWER than this estimate — i.e. the
 * number here is CONSERVATIVE (over-states impact). Labelled an estimate; a plan
 * is not a guaranteed fill.
 *
 * ── Anti-ungraduation ────────────────────────────────────────────────────────
 * This module is PURE + fast + total: it validates input and returns a typed
 * result (`reject` for bad input, `decline` when the live market is unreadable),
 * never throwing and never hanging. The ACP job wrapper adds escrow/idempotency/
 * log; the internal deadline is enforced by the route (Promise.race).
 */
import { poolsForToken, type PoolMeta } from "@/lib/robinhood/rwa-market";
import { findByTicker, findByContract, RWA_TOKENS } from "@/lib/robinhood/rwa-registry";

// USDG / WETH addresses are DERIVED from the verified registry — never
// hardcoded here (hard rule: no hallucinated/duplicated addresses).
const USDG_LOWER = (findByTicker("USDG")?.contract ?? "").toLowerCase();
const WETH_LOWER = (findByTicker("WETH")?.contract ?? "").toLowerCase();

// Registry shape, COUNTED not typed out. The user-facing "unknown ticker" hint
// below used to read "26 tokens: 20 stocks, 5 ETFs, WETH, USDG", which was a
// literal transcription of the registry on the day it was written. When the
// registry was completed from the RHJ factory log it became 205 rows, and the
// hint kept telling users the universe was 26 — i.e. the error message for
// "that ticker doesn't exist" was itself the least accurate string in the file.
// Derived, it cannot drift again.
const REGISTRY_SHAPE = (() => {
  const n = (k: string) => RWA_TOKENS.filter((t) => t.kind === k).length;
  return { total: RWA_TOKENS.length, stocks: n("stock"), etfs: n("etf") };
})();

// ── Heuristic thresholds (advisory, NOT measured facts) ─────────────────────
/** Single-pool impact above this is worth considering a split … */
const SPLIT_TRIGGER_PCT = 1.0;
/** … but only if a split improves blended impact by at least this much. */
const MIN_IMPROVEMENT_PCT = 0.25;
/** Drop split legs shallower than this fraction of the frame's deepest pool. */
const DUST_FRAC = 0.05;
/** Never propose more legs than this — more hops = more gas for little gain. */
const MAX_LEGS = 6;
/** Prefer the USDG route unless the WETH route cuts impact by more than this. */
const ROUTE_TIE_BAND_PCT = 1.0;
/** Effective impact above this earns a loud "size is too big" warning. */
const SEVERE_PCT = 10.0;

export type ExecSide = "buy" | "sell";
export type CounterpartyKind = "USDG" | "WETH" | "other";
export type RouteType = "direct_usdg" | "via_weth" | "unsupported";

export interface ExecPlanInput {
  ticker: string;
  size_usd: number;
  side?: ExecSide;
}

export interface ExecLeg {
  pool_ref: string;
  is_v4_pool_id: boolean;
  dex: string;
  alloc_usd: number;
  alloc_pct: number;
  est_impact_pct: number;
  tvl_usd: number;
  url: string;
}

export interface ExecPlan {
  ok: true;
  ticker: string;
  name: string;
  contract: string;
  side: ExecSide;
  size_usd: number;
  as_of: string;
  mid_price_usd: number;
  pool_count: number;
  total_tvl_usd: number;
  /** The pool the recommended route fills (deepest in the chosen frame). */
  primary_pool: {
    pool_ref: string;
    is_v4_pool_id: boolean;
    is_deepest_overall: boolean;
    dex: string;
    counterparty: string;
    counterparty_symbol: string | null;
    counterparty_kind: CounterpartyKind;
    tvl_usd: number;
    one_side_usd: number;
    fee_bps: number | null;
    url: string;
  };
  route: {
    type: RouteType;
    requires_weth_hop: boolean;
    executable_via: "v3_router" | "v4_universal_router";
    frame_one_side_usd: number;
    note: string;
  };
  /** The other USD-viable frame, if one exists — so the caller can compare. */
  alt_route: {
    type: RouteType;
    aggregate_one_side_usd: number;
    est_impact_pct: number;
    note: string;
  } | null;
  single_pool: { est_impact_pct: number; est_slippage_cost_usd: number };
  should_split: boolean;
  split: {
    leg_count: number;
    est_blended_impact_pct: number;
    est_slippage_cost_usd: number;
    legs: ExecLeg[];
  } | null;
  /** Non-null when the effective impact is severe regardless of routing. */
  warning: string | null;
  recommendation: string;
  model: string;
  data_sources: string[];
}

export interface ExecPlanReject {
  ok: false;
  kind: "reject";
  error: "missing_input" | "unknown_ticker" | "invalid_size";
  reason: string;
  hint: string;
}

export interface ExecPlanDecline {
  ok: false;
  kind: "decline";
  error: "no_market_data";
  reason: string;
}

export type ExecPlanResult = ExecPlan | ExecPlanReject | ExecPlanDecline;

/** Constant-product first-order price impact (%), bounded 0–100. */
function impactPct(size: number, oneSide: number): number {
  const denom = oneSide + size;
  if (!(denom > 0)) return 100;
  return round2((100 * size) / denom);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** The pool's counterparty (the non-target side) as a lowercased address. */
function counterpartyAddr(p: PoolMeta): string {
  return p.token_is_base ? p.quote_token : p.base_token;
}

function counterpartyKind(addr: string): CounterpartyKind {
  if (USDG_LOWER && addr === USDG_LOWER) return "USDG";
  if (WETH_LOWER && addr === WETH_LOWER) return "WETH";
  return "other";
}

interface Frame {
  kind: Exclude<CounterpartyKind, "other">;
  deepest: PoolMeta;
  legPools: PoolMeta[]; // material pools only (dust dropped, capped)
  aggOneSide: number; // sum of legPools one-side depth
  singleImpact: number; // filling entirely in `deepest`
  blendedImpact: number; // splitting across legPools
}

/**
 * Build a route frame from the pools sharing one counterparty. `pools` arrives
 * pre-sorted deepest-first (poolsForToken sorts by reserve desc), so `filter`
 * preserves that order and `[0]` is the deepest in-frame pool.
 */
function buildFrame(kind: Frame["kind"], framePools: PoolMeta[], size: number): Frame | null {
  if (!framePools.length) return null;
  const deepest = framePools[0];
  const floor = (deepest.one_side_usd || 0) * DUST_FRAC;
  const legPools = framePools.filter((p) => (p.one_side_usd || 0) >= floor).slice(0, MAX_LEGS);
  const aggOneSide = legPools.reduce((s, p) => s + (p.one_side_usd || 0), 0);
  return {
    kind,
    deepest,
    legPools,
    aggOneSide,
    singleImpact: impactPct(size, deepest.one_side_usd || 0),
    blendedImpact: impactPct(size, aggOneSide),
  };
}

/**
 * Compute an execution plan. Pure + total: real data in, typed result out.
 * `reject` = the caller's fault (fix the input); `decline` = we can't see a
 * live market right now (retry later, no charge).
 */
export async function computeExecutionPlan(input: ExecPlanInput): Promise<ExecPlanResult> {
  const rawTicker = (input.ticker ?? "").trim();
  if (!rawTicker) {
    return {
      ok: false,
      kind: "reject",
      error: "missing_input",
      reason: "`ticker` is required.",
      hint: "Pass a canonical RWA ticker, e.g. TSLA, NVDA, SPY.",
    };
  }

  const size = Number(input.size_usd);
  if (!Number.isFinite(size) || size <= 0) {
    return {
      ok: false,
      kind: "reject",
      error: "invalid_size",
      reason: "`size_usd` must be a positive number of US dollars.",
      hint: "e.g. size_usd=100000 for a $100k order.",
    };
  }

  const token = findByTicker(rawTicker);
  if (!token) {
    return {
      ok: false,
      kind: "reject",
      error: "unknown_ticker",
      reason: `"${rawTicker}" is not a canonical Robinhood-Chain RWA token.`,
      hint: `Use a ticker from the RH RWA registry (${REGISTRY_SHAPE.total} tokens: ${REGISTRY_SHAPE.stocks} stocks, ${REGISTRY_SHAPE.etfs} ETFs, WETH, USDG). Note that registry membership proves the token was issued by RHJ — it does NOT imply the token is tradable; most have no pool.`,
    };
  }

  const side: ExecSide = input.side === "sell" ? "sell" : "buy";

  // ── Live market read (the ONLY data source) ──────────────────────────────
  let pools: PoolMeta[] = [];
  try {
    pools = await poolsForToken(token.contract);
  } catch {
    pools = []; // poolsForToken already returns [] on error; be defensive
  }
  const totalTvl = pools.reduce((s, p) => s + (p.reserve_usd || 0), 0);
  if (pools.length === 0 || totalTvl <= 0) {
    // Honest decline — no readable liquidity RIGHT NOW. Not a reject (input is
    // valid), not a fabricated zero-depth plan. The wrapper returns this as
    // "temporarily unavailable" with NO charge.
    return {
      ok: false,
      kind: "decline",
      error: "no_market_data",
      reason: `No readable RH-Chain liquidity for ${token.ticker} right now (0 pools or 0 depth). Retry shortly.`,
    };
  }

  const overallDeepest = pools[0];

  // ── Group into USD-viable route frames + pick the recommended one ─────────
  const usdgFrame = buildFrame("USDG", pools.filter((p) => counterpartyAddr(p) === USDG_LOWER), size);
  const wethFrame = buildFrame("WETH", pools.filter((p) => counterpartyAddr(p) === WETH_LOWER), size);

  let chosen: Frame | null;
  if (usdgFrame && wethFrame) {
    // Prefer USDG (no extra leg) unless WETH is meaningfully cheaper.
    chosen =
      usdgFrame.blendedImpact - wethFrame.blendedImpact > ROUTE_TIE_BAND_PCT ? wethFrame : usdgFrame;
  } else {
    chosen = usdgFrame ?? wethFrame;
  }

  const data_sources = [
    "api.geckoterminal.com (Robinhood Chain pools)",
    `RH RWA registry (${REGISTRY_SHAPE.total} tokens)`,
  ];
  const modelStr =
    "constant-product (xy=k) first-order impact = size/(one_side+size); one_side ≈ reserve_usd/2. " +
    "xy=k assumes full-range depth; RH V4 pools concentrate liquidity near mid, so this OVER-states impact (conservative). ESTIMATE — not a guaranteed fill.";

  // ── Edge case: no USDG and no WETH pair — token only pairs with other RWAs ─
  if (!chosen) {
    const dcp = counterpartyAddr(overallDeepest);
    const singleImpact = impactPct(size, overallDeepest.one_side_usd || 0);
    return {
      ok: true,
      ticker: token.ticker,
      name: token.name,
      contract: token.contract,
      side,
      size_usd: size,
      as_of: new Date().toISOString(),
      mid_price_usd: overallDeepest.price_usd,
      pool_count: pools.length,
      total_tvl_usd: Math.round(totalTvl),
      primary_pool: {
        pool_ref: overallDeepest.pool_ref,
        is_v4_pool_id: overallDeepest.is_v4_pool_id,
        is_deepest_overall: true,
        dex: overallDeepest.dex,
        counterparty: dcp,
        counterparty_symbol: findByContract(dcp)?.ticker ?? null,
        counterparty_kind: counterpartyKind(dcp),
        tvl_usd: Math.round(overallDeepest.reserve_usd || 0),
        one_side_usd: Math.round(overallDeepest.one_side_usd || 0),
        fee_bps: overallDeepest.fee_bps,
        url: overallDeepest.url,
      },
      route: {
        type: "unsupported",
        requires_weth_hop: false,
        executable_via: overallDeepest.is_v4_pool_id ? "v4_universal_router" : "v3_router",
        frame_one_side_usd: Math.round(overallDeepest.one_side_usd || 0),
        note: `No direct USDG or WETH pool for ${token.ticker} — it only pairs with other RWAs. A USD entry needs a multi-hop this tool does not model; route manually with care.`,
      },
      alt_route: null,
      single_pool: {
        est_impact_pct: singleImpact,
        est_slippage_cost_usd: round2(size * (singleImpact / 100)),
      },
      should_split: false,
      split: null,
      warning:
        "No USD-native entry route. Impact shown is for the deepest available (non-USD) pair only and does not include the hop(s) needed to enter from USD.",
      recommendation: `No direct USD route for ${token.ticker}. Acquire an intermediate asset first, or route through a V4-native aggregator.`,
      model: modelStr,
      data_sources,
    };
  }

  // ── Recommended frame chosen — build the plan ─────────────────────────────
  const shouldSplit =
    chosen.legPools.length > 1 &&
    chosen.singleImpact > SPLIT_TRIGGER_PCT &&
    chosen.singleImpact - chosen.blendedImpact > MIN_IMPROVEMENT_PCT;

  const effectiveImpact = shouldSplit ? chosen.blendedImpact : chosen.singleImpact;

  const legs: ExecLeg[] = shouldSplit
    ? chosen.legPools.map((p) => {
        const alloc = round2((size * (p.one_side_usd || 0)) / chosen!.aggOneSide);
        return {
          pool_ref: p.pool_ref,
          is_v4_pool_id: p.is_v4_pool_id,
          dex: p.dex,
          alloc_usd: alloc,
          alloc_pct: round2((100 * (p.one_side_usd || 0)) / chosen!.aggOneSide),
          est_impact_pct: impactPct(alloc, p.one_side_usd || 0),
          tvl_usd: Math.round(p.reserve_usd || 0),
          url: p.url,
        };
      })
    : [];

  const routeType: RouteType = chosen.kind === "USDG" ? "direct_usdg" : "via_weth";
  const routeNote =
    chosen.kind === "USDG"
      ? "Direct USDG pair — single-hop, executed in the USD frame."
      : "Deepest USD-viable liquidity is a WETH pair — enter USDG→WETH→token, adding a WETH leg (its slippage is NOT included in these estimates).";

  const altFrame = chosen.kind === "USDG" ? wethFrame : usdgFrame;
  const alt_route = altFrame
    ? {
        type: (altFrame.kind === "USDG" ? "direct_usdg" : "via_weth") as RouteType,
        aggregate_one_side_usd: Math.round(altFrame.aggOneSide),
        est_impact_pct: altFrame.blendedImpact,
        note:
          altFrame.kind === "USDG"
            ? "A direct-USDG alternative exists (no WETH leg) but is shallower — compare est_impact_pct."
            : "A WETH-route alternative exists with different depth (adds a hop) — compare est_impact_pct.",
      }
    : null;

  const dcp = counterpartyAddr(chosen.deepest);
  const warning =
    effectiveImpact > SEVERE_PCT
      ? `Severe impact (~${effectiveImpact}%) — this order is large relative to ${token.ticker}'s RH-Chain liquidity. Size down or execute gradually; a single fill will move the price hard.`
      : null;

  const recommendation = shouldSplit
    ? `Split across ${legs.length} ${chosen.kind} pool${legs.length > 1 ? "s" : ""} to cut impact from ~${chosen.singleImpact}% to ~${chosen.blendedImpact}%.`
    : chosen.legPools.length > 1
      ? `Fill in the deepest ${chosen.kind} pool (~${chosen.singleImpact}% impact); splitting doesn't improve it enough to justify extra hops.`
      : `Only one material ${chosen.kind} pool — fill there (~${chosen.singleImpact}% estimated impact).`;

  return {
    ok: true,
    ticker: token.ticker,
    name: token.name,
    contract: token.contract,
    side,
    size_usd: size,
    as_of: new Date().toISOString(),
    mid_price_usd: chosen.deepest.price_usd,
    pool_count: pools.length,
    total_tvl_usd: Math.round(totalTvl),
    primary_pool: {
      pool_ref: chosen.deepest.pool_ref,
      is_v4_pool_id: chosen.deepest.is_v4_pool_id,
      is_deepest_overall: chosen.deepest.pool_ref === overallDeepest.pool_ref,
      dex: chosen.deepest.dex,
      counterparty: dcp,
      counterparty_symbol: findByContract(dcp)?.ticker ?? null,
      counterparty_kind: chosen.kind,
      tvl_usd: Math.round(chosen.deepest.reserve_usd || 0),
      one_side_usd: Math.round(chosen.deepest.one_side_usd || 0),
      fee_bps: chosen.deepest.fee_bps,
      url: chosen.deepest.url,
    },
    route: {
      type: routeType,
      requires_weth_hop: chosen.kind === "WETH",
      executable_via: chosen.deepest.is_v4_pool_id ? "v4_universal_router" : "v3_router",
      frame_one_side_usd: Math.round(chosen.aggOneSide),
      note: routeNote,
    },
    alt_route,
    single_pool: {
      est_impact_pct: chosen.singleImpact,
      est_slippage_cost_usd: round2(size * (chosen.singleImpact / 100)),
    },
    should_split: shouldSplit,
    split: shouldSplit
      ? {
          leg_count: legs.length,
          est_blended_impact_pct: chosen.blendedImpact,
          est_slippage_cost_usd: round2(size * (chosen.blendedImpact / 100)),
          legs,
        }
      : null,
    warning,
    recommendation,
    model: modelStr,
    data_sources,
  };
}
