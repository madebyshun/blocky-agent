/**
 * Blue Hood — shared type definitions.
 *
 * The poller writes normalized snapshots + arrows into KV; /hood + the
 * alert delivery layer read from KV. This file is the single source of
 * truth for those shapes so every reader/writer stays honest.
 */

// ── Snapshot ──────────────────────────────────────────────────────────────
// One row per registry ticker per poll cycle. The M5 arb tool already
// gives us most of what /hood needs — verdict, market clock, drift %,
// pool metadata. We only re-shape it (drop noisy nested fields), never
// re-derive numbers here.

export type M5Verdict =
  | "ALIGNED"
  | "LONG_DEX"
  | "SHORT_DEX"
  | "FROZEN_ALIGNED"
  | "PREMARKET_DRIFT"
  | "AFTERHOURS_DRIFT"
  | "INSUFFICIENT_DATA";

export type MarketSession = "regular" | "premarket" | "afterhours" | "weekend" | "holiday";

/**
 * |drift| ≥ this (in %) fires a drift arrow while the market is CLOSED.
 * Spec Block 1.2; enforced in `rule-engine.ts`.
 *
 * It lives in this dependency-free module, not next to the rule that uses it,
 * so the BOARD can print the same number the ENGINE fires on. `rule-engine.ts`
 * imports `@/lib/kv`; a client component importing the constant from there
 * would drag Upstash into the browser bundle. The alternative — typing "2%"
 * into the UI copy — is how a displayed threshold silently drifts away from
 * the real one. One constant, two readers.
 */
export const DRIFT_MIN_ABS_PCT = 2.0;

/**
 * |delta| ≥ this (in %) fires an arb arrow while the market is OPEN.
 * Spec Block 1.2; enforced in `rule-engine.ts`.
 *
 * Lives here for the same reason as `DRIFT_MIN_ABS_PCT` above: the board tells
 * the reader which threshold a quiet desk is waiting on, and that number swaps
 * with the session (2% closed → 1% open). Two constants, one place, so the
 * copy cannot say 2% while the engine fires at 1%.
 */
export const ARB_MIN_ABS_PCT = 1.0;

/**
 * Which desk a snapshot row / arrow belongs to. `"robinhood"` is Blue Hood's
 * origin chain (chainId 4663); `"base"` is the Coinbase B20 tokenized-stock desk
 * (chainId 8453) wired in Base P3.
 *
 * ⚠️ ABSENT ⟹ `"robinhood"`, ALWAYS. Every arrow written before the Base desk
 * landed carries no `chain` field, and NVDA/META/GOOGL/AAPL exist on BOTH chains — so
 * a reader that guesses instead of defaulting to robinhood would mis-attribute
 * the entire historical record and re-price a legacy RH arrow against Base. The
 * default is load-bearing, not cosmetic: `chainOf(x)` centralises it.
 */
export type HoodChain = "robinhood" | "base";

/** The one place the "absent ⟹ robinhood" default lives. Import this rather
 *  than writing `x.chain ?? "robinhood"` at each read site, so the back-compat
 *  rule can never be spelled inconsistently. */
export function chainOf(x: { chain?: HoodChain } | null | undefined): HoodChain {
  return x?.chain ?? "robinhood";
}

/**
 * Base P1 — the UI identity of a snapshot row. `chainSeg`'s idea (kv-keys.ts),
 * applied to React keys / refs / accordion state instead of KV keys.
 *
 * WHY THIS EXISTS: the board keyed everything by BARE TICKER — React `key`,
 * `rowRefs`, the one-row-open accordion, the open-arrow lookup. That was
 * correct while every row came from one chain. NVDA/META/GOOGL/AAPL exist on
 * BOTH Robinhood Chain and Base, so the moment Base rows join `snap.tickers`
 * a bare ticker stops identifying a row: two rows answer to "NVDA", React
 * warns on duplicate keys, expanding one expands both, and `rowRefs` scrolls
 * to whichever row mounted last.
 *
 * ⚠️ THE ROBINHOOD BRANCH MUST KEEP RETURNING THE BARE TICKER, byte-for-byte.
 * Every pre-existing caller hands a bare ticker to `rowRefs.current[...]`
 * (PositionsStrip's [Sell] jump, the sidebar's watchlist click, the inbox's
 * cross-page push). If RH rows changed key, all of those would silently stop
 * resolving. Same reasoning as `chainSeg` returning "" for robinhood, and the
 * same reasoning as #308 keeping RH hrefs byte-identical: the new chain pays
 * the migration cost, the incumbent pays nothing.
 */
export function rowKey(x: { ticker: string; chain?: HoodChain }): string {
  const c = chainOf(x);
  return c === "robinhood" ? x.ticker : `${c}:${x.ticker}`;
}

export interface TickerSnapshot {
  /** Ticker symbol, uppercase. */
  ticker: string;
  /** Which desk this row was polled from. Absent ⟹ "robinhood" (see `chainOf`).
   *  On Base the same ticker (NVDA/META/GOOGL/AAPL) is a DIFFERENT token + pool, so
   *  every downstream key + grader read MUST be chain-qualified. */
  chain?: HoodChain;
  /** Human-readable name from registry. */
  name: string;
  /** ERC-20 contract on Robinhood Chain (chain=robinhood) or the Coinbase B20
   *  token on Base (chain=base). Always the on-chain token for THIS row's chain. */
  contract: string;
  /** M5 verdict, or "ERROR" if the poll failed for this row. */
  verdict: M5Verdict | "ERROR";
  /** Chainlink oracle price, USD. Null on error. */
  oracle_usd: number | null;
  /** Deepest DEX pool spot price, USD. Null on error. */
  dex_usd: number | null;
  /** Primary pool TVL (USD) — the pool selected by `resolvePrimaryPool`
   *  (USDG-quoted preferred, then deepest). This is the pool the swap
   *  path uses, so it's the honest "how much liquidity is at the price
   *  frame you'll actually trade at" number. NOT for dust gating —
   *  bankr-robinhood WETH pools regularly dwarf this. See `total_tvl_usd`. */
  tvl_usd: number | null;
  /** Sum of `reserve_usd` across EVERY pool for this token on RH Chain.
   *  This is the number the dust gate must use — a token with a $21M
   *  WETH pool but a $850k USDG pool is objectively deep even if its
   *  primary pool is thin. The old dust check on `tvl_usd` would
   *  blackhole those tokens. See `rule-engine.ts` MIN_TVL_USD. */
  total_tvl_usd: number | null;
  /** 24h volume in the primary pool — same dust-floor gate. */
  volume_24h_usd: number | null;
  /** dex/oracle drift as a percentage. Positive = DEX above oracle. */
  drift_pct: number | null;
  /** Reference to the primary pool (address or v4 pool id). */
  pool_ref: string | null;
  /** Whether pool_ref is a Uniswap v4 poolId (bytes32) vs a v3 pool address. */
  is_v4_pool_id: boolean;
  /** Market clock at time of snapshot (open + session). */
  market: {
    is_open: boolean;
    session: MarketSession;
    ny_time_iso: string;
  };
  /** Warnings surfaced verbatim from M5 (feed_abnormally_stale, thin_dex_pool, etc.). */
  warnings: string[];
  /** Error message if `verdict === "ERROR"`. */
  error?: string;
  /** Wall-clock ms since cycle start when this row was polled. Used by the
   *  UI to compute per-row freshness (`age_s = now - snap.started_at - polled_at_ms`). */
  polled_at_ms: number;
  /** ⚠️ THIS FIELD MEANS DIFFERENT THINGS ON THE TWO CHAINS. Do not aggregate
   *  it across them.
   *    • RH  — how stale the GeckoTerminal **DEX** response was when reshaped
   *            (`poller.ts` → `cacheAgeS`). Null on cold fetch, a number when
   *            memo-served. Reviewer T1(d): "any token served from stale cache
   *            MUST be surfaced".
   *    • Base — the age of the **Chainlink oracle** round (`base-poller.ts` →
   *            `q.feed_age_seconds`). The opposite side of the trade.
   *  Averaging the two would mix DEX cache latency with oracle latency and call
   *  the result "freshness". Reach for `oracle_updated_at` below when you want
   *  the oracle specifically; it is unambiguous by construction. */
  data_age_s: number | null;
  /** Unix SECONDS of the Chainlink round this row priced against — the raw
   *  `latestRoundData().updatedAt`, not a derived age.
   *
   *  Absolute on purpose. An age is only meaningful against the instant it was
   *  measured, and a poll cycle currently runs ~280s, so `cycle_start - age`
   *  can be minutes off. More importantly, two cycles that read the SAME round
   *  are indistinguishable by age alone — and "did the oracle move between
   *  these two observations?" is exactly the question the Base archive exists
   *  to answer (see `base-series.ts`).
   *
   *  `undefined` on RH: that desk never had the value to record, which is a
   *  different fact from `null` (Base read it and the feed was unreadable). */
  oracle_updated_at?: number | null;
  /** T-B1 — hourly close prices (up to 24 points, oldest first) served
   *  from `bh:spark:{ticker}`. Populated by the `sparkline-refresh` cron;
   *  the main 72s poll only reads cache, never fetches. `null` on cold
   *  start; the UI hides the sparkline entirely when < 6 candles. */
  sparkline: number[] | null;
  /** T-B.1 #4 — when this row has no DEX data, WHY. `null` when we do
   *  have data (verdict is a real M5 verdict + dex_usd is populated).
   *  Otherwise:
   *    • `"no_pool"` — M5 reached GT, GT responded, but no valid RWA
   *      pool exists for this token. Persistent absence is expected.
   *    • `"fetch_failed"` — either the tool call itself errored or M5
   *      couldn't read GT (rate-limit, timeout, upstream error). If we
   *      see the same ticker `fetch_failed` many cycles in a row, that's
   *      a throttle-tail signal that needs looking at. */
  no_data_reason: "no_pool" | "fetch_failed" | null;
}

export interface HoodSnapshot {
  /** Monotonic snapshot id. Also used as ring-buffer key. */
  cycle_id: number;
  /** ISO timestamp the poll cycle started. */
  started_at: string;
  /** ISO timestamp the poll cycle finished. */
  finished_at: string;
  /** Wall-clock duration in ms. */
  duration_ms: number;
  /** One row per token watched this cycle. */
  tickers: TickerSnapshot[];
  /** Aggregated metrics for the /hood header strip. Denominators are HONEST:
   *  `registry_total` is the RWA candidate set (stocks + ETFs, not the whole
   *  registry — utility WETH/USDG are plumbing, not positions to watch). */
  metrics: {
    /** Every stock + ETF in the RWA registry. The UI shows "N/registry_total". */
    registry_total: number;
    /** Registry rows that have a Chainlink feed — the pool the poller draws
     *  from. `registry_total` counts rows that exist; this counts rows that
     *  are *watchable*, which is the denominator coverage should be read
     *  against.
     *
     *  Optional because snapshots are persisted: every cycle written before
     *  the registry sweep landed has no such field, and back-filling a number
     *  onto a historical snapshot would be inventing data. `undefined` here
     *  means "this cycle predates the field", not zero — render it as absent. */
    tokens_eligible?: number;
    /** Rows this cycle actually polled. */
    tokens_watched: number;
    /** Registry rows dropped this cycle because they lack a Chainlink feed. */
    tokens_no_feed: number;
    /** Feed-eligible rows deliberately left out of the poll budget. Explicit
     *  rather than silent: see `HOOD_ENABLED` in blue-hood/registry.ts.
     *  Optional for the same historical-snapshot reason as `tokens_eligible`. */
    tokens_not_enabled?: number;
    /** Rows polled but whose M5 call errored. Subset of tokens_watched. */
    tokens_errored: number;
    tvl_scanned_usd: number;
    market_is_open: boolean;
    market_session: MarketSession;
  };
}

/**
 * A row that SAID it is Base, as opposed to one we decided was Base.
 *
 * WHY THE WIDE TYPE IS NOT ENOUGH
 * ------------------------------
 * `TickerSnapshot.chain` is optional and must stay optional: the RH poller
 * omits it on every one of its 24 live rows, and every arrow written before the
 * Base desk landed omits it too. That is the `chainOf` contract and it is
 * correct.
 *
 * The cost is that omission is LEGAL for the shared type, so a Base construction
 * site that forgets `chain: "base"` type-checks cleanly and produces a row that
 * `chainOf` then reads as Robinhood — silently, because there is no such thing
 * as a suspicious absence when absence is the norm for the other desk. The row
 * would take an RH badge, an RH explorer href, RH pools in the detail panel
 * (the #161 defect, re-opened from underneath its own fix) and an RH-qualified
 * arrow key.
 *
 * Requiring the literal here moves that from "reviewer notices" to "tsc
 * refuses". Producers declare THIS type; the field stays optional on the shared
 * one; nothing about the legacy default changes.
 */
export type BaseTickerSnapshot = TickerSnapshot & { chain: "base" };

/**
 * Split rows by whether they carry the Base marker, for readers that took their
 * rows off the wire rather than from a typed producer.
 *
 * `BaseDeskLatest.rows` is typed `BaseTickerSnapshot[]`, which constrains
 * whoever WRITES the blob. It proves nothing about whoever READS it:
 * `kvGet<BaseDeskLatest>` is an unchecked cast over JSON that may have been
 * written by an older deploy, so at that boundary the type is a claim and not a
 * check. This function is the check.
 *
 * ⚠️ TESTS `r.chain === "base"` AND DELIBERATELY DOES NOT CALL `chainOf`.
 * The two are behaviourally identical today, which is the trap: `chainOf`
 * exists to APPLY the absent⟹robinhood default, and this function exists to
 * refuse to rely on it. Routing this through `chainOf` would couple the Base
 * desk's safety to the legacy back-compat rule, so that any later change to
 * that default would silently redefine what counts as a Base row. Pinned by the
 * source check in `scripts/hood-chain-attribution-check.ts`.
 */
export function partitionBaseRows(rows: readonly TickerSnapshot[]): {
  attributed: BaseTickerSnapshot[];
  unattributed: TickerSnapshot[];
} {
  const attributed: BaseTickerSnapshot[] = [];
  const unattributed: TickerSnapshot[] = [];
  for (const r of rows) {
    if (r.chain === "base") attributed.push(r as BaseTickerSnapshot);
    else unattributed.push(r);
  }
  return { attributed, unattributed };
}

/**
 * Base P1 — the Base desk's latest rows, stored under its OWN key
 * (`KV_BASE_ROWS_LATEST`), read by `/api/hood/snapshot` and merged into the
 * board response at read time.
 *
 * ⚠️ THIS IS DELIBERATELY *NOT* A `HoodSnapshot`, and that is the whole point.
 *
 * `persistSnapshot(snap)` writes `bh:snapshot:latest`, the hour ring, AND the
 * PERMANENT series archive `bh:series:day:*` — which is keyed by BARE TICKER.
 * NVDA/META/GOOGL/AAPL exist on both Robinhood Chain and Base, so one Base row
 * reaching that archive corrupts the RH price history irreversibly (history,
 * unlike code, cannot be backfilled). The RH-only-ness of `persistSnapshot` is
 * therefore a load-bearing invariant, not a style choice.
 *
 * Making this shape structurally incompatible with `HoodSnapshot` (no
 * `cycle_id` / `finished_at` / `duration_ms` / `metrics`, and the rows live
 * under `rows` not `tickers`) means `persistSnapshot(baseLatest)` and
 * `persistSeriesPoint(baseLatest)` DO NOT COMPILE. The invariant is enforced by
 * `tsc`, not by whoever reads this comment. That is the difference between a
 * guard and a convention.
 */
export interface BaseDeskLatest {
  /** ISO cycle start, anchored to the SAME `snap.started_at` the RH poller
   *  used (see poll/route.ts) so both desks describe one instant. Read side
   *  uses it for the freshness check — see `BASE_ROWS_MAX_AGE_MS`. */
  started_at: string;
  /** One row per Base B20 stock polled this cycle. Every row carries
   *  `chain: "base"` (set in `baseQuoteToSnapshot`), which is what every
   *  downstream chain-qualified key and every board de-collision reads.
   *
   *  `BaseTickerSnapshot`, not `TickerSnapshot`, so the marker is required
   *  where the blob is BUILT. On the read side this annotation is only a claim
   *  about JSON — see `partitionBaseRows`, which is what actually checks it. */
  rows: BaseTickerSnapshot[];
}

// ── Permanent price series ────────────────────────────────────────────────
// A deliberately small, PERMANENT subset of the snapshot, written hourly to
// `bh:series:day:YYYYMMDD`. `HoodSnapshot` is the rich shape and expires
// after 25h; this is the thin shape that never expires.
//
// WHY IT IS SEPARATE rather than "just keep snapshots longer": a snapshot
// carries per-row sparklines, warnings, pool refs and freshness telemetry —
// all of it useful for 24h of debugging and none of it worth storing for a
// year. What IS worth storing forever is the answer to one question we
// cannot ask retroactively: where was the DEX trading while the oracle was
// frozen? That needs five numbers per ticker per hour, and it needs to
// survive a weekend (48–65h), which the 25h ring buffer cannot do.

/** One ticker's prices at one hour. Field names are spelled out rather than
 *  golfed to one letter: this record outlives the code that wrote it, so it
 *  has to be readable without a decoder ring. */
export interface SeriesRow {
  /** Ticker symbol, uppercase. */
  ticker: string;
  /** Chainlink oracle price, USD. Null when the feed didn't read this cycle. */
  oracle_usd: number | null;
  /** Deepest DEX pool spot price, USD. Null when no pool resolved. */
  dex_usd: number | null;
  /** dex/oracle drift %, positive = DEX above oracle. Copied from the
   *  snapshot, never recomputed here — one definition of drift, upstream. */
  drift_pct: number | null;
  /** Total TVL across every pool for this token, USD. Kept because "the DEX
   *  disagreed with the oracle" means nothing without knowing how much
   *  depth was standing behind the disagreement. */
  total_tvl_usd: number | null;
  /** Unix seconds of the Chainlink round behind `oracle_usd`. Base only.
   *
   *  Without it, a recorded `drift_pct` is three different findings wearing one
   *  number, and no later analysis can separate them:
   *    1. the DEX genuinely moved away from a live oracle — a real dislocation;
   *    2. the oracle simply had not crossed its 0.5% deviation deadband yet —
   *       quantisation, not signal (every Base drift observed so far, 0.094% /
   *       0.31% / 0.3782%, is BELOW that deadband);
   *    3. the oracle was frozen for a corporate action while the token kept
   *       trading on-chain — the B20 spec pauses mint/redeem off-chain but
   *       explicitly does NOT pause transfers, so `isPaused(TRANSFER)` reads
   *       false throughout, and `is_stale` only trips after 2 x 24h.
   *  Compare this across consecutive points and the three separate cleanly.
   *
   *  Three-valued on purpose:
   *    • a number  — the round the price came from;
   *    • `null`    — Base read the feed and could not date it;
   *    • `undefined` — this archive never recorded the field (every RH point,
   *      and every Base point written at `v: 1`).
   *  Collapsing `undefined` into `null` would turn "we never looked" into "we
   *  looked and found nothing", which is the unknown-vs-known-empty error this
   *  archive is built to avoid. */
  oracle_updated_at?: number | null;
}

/** One hour bucket within a day. */
export interface SeriesPoint {
  /** `YYYYMMDDHH` UTC — the dedup key within the day. */
  hour: string;
  /** ISO start time of the cycle that produced this point. The `hour` bucket
   *  is truncated; this is the real instant the prices were read. */
  at: string;
  /** Market clock at capture. The entire point of this series is comparing
   *  DEX behaviour across the open/closed boundary, so the boundary itself
   *  must be recorded — not re-derived later from the timestamp, which would
   *  silently get holidays and half-days wrong. */
  is_open: boolean;
  session: MarketSession;
  /** Only tickers that actually priced. A ticker that failed is absent
   *  rather than present-with-nulls: absence is honest, a null row would
   *  read as "the market had no price". */
  rows: SeriesRow[];
}

/** One UTC day of hourly points — the value stored at `bh:series:day:YYYYMMDD`. */
export interface SeriesDay {
  /** `YYYYMMDD` UTC. Redundant with the key on purpose, so an exported blob
   *  can still identify itself once separated from the key. */
  day: string;
  /** Schema version. This record is permanent, so a future shape change has
   *  to be *distinguishable* from today's rather than silently reinterpreted. */
  v: number;
  /** Hourly points, oldest first. At most 24. */
  points: SeriesPoint[];
  /** Always RH. Absent ⟹ "robinhood", mirroring `TickerSnapshot.chain` — every
   *  record written before the Base desk existed lacks the field, so it must
   *  stay optional or the whole archive stops parsing.
   *
   *  This field is never WRITTEN (`persistSeriesPoint` omits it). It exists to
   *  make the chain split a type error: without it `BaseSeriesDay` satisfies
   *  `{day, v, points}` structurally and is therefore silently assignable to
   *  `SeriesDay`. With it, `chain: "base"` fails against `"robinhood" |
   *  undefined`. Verified by compiling the assignment both ways — the version
   *  of this comment that claimed the split was already enforced was wrong. */
  chain?: "robinhood";
}

// ── Base desk permanent series ────────────────────────────────────────────
// Stored at `bh:base:series:day:YYYYMMDD` (see `kvBaseSeriesDay`). Kept apart
// from `SeriesDay` because NVDA/META/GOOGL/AAPL exist on BOTH chains, and one
// Base row in the bare-ticker RH archive corrupts RH price history irreversibly.
//
// The split is enforced by the `chain` discriminator on BOTH interfaces, not by
// their field lists: `SeriesDay` requires only `{day, v, points}`, all of which
// `BaseSeriesDay` has, so without `chain` the two are silently interchangeable.
// That was true in the first draft of this file and was caught by compiling the
// assignment rather than by reading it.

/**
 * Per-ticker daily extreme of |drift|, sampled EVERY 5-min cycle.
 *
 * WHY THIS IS NOT REDUNDANT WITH THE HOURLY POINTS: the rule engine evaluates
 * `detectCandidate` against `DRIFT_MIN_ABS_PCT` on every cycle, not once an
 * hour. So an hourly sample under-measures precisely the quantity that decides
 * whether Base ever fires — a 40-minute excursion above threshold would leave
 * no trace in an hourly series, and we would conclude "Base never approaches
 * 2%" from a sampling artifact. Measuring at a coarser resolution than the
 * decision is the same class of error as the period-confounded null model
 * documented in the gap-closure notes.
 *
 * Cost stays near zero because the write is conditional: on a quiet series the
 * high-water mark stops moving after the first few cycles of the day.
 */
export interface BaseSeriesPeak {
  ticker: string;
  /** Largest |drift_pct| seen today. Signed value is kept in `drift_pct` so
   *  direction is not lost — `abs_drift_pct` exists only to make the
   *  comparison and the threshold question direct. */
  abs_drift_pct: number;
  drift_pct: number;
  /** ISO instant of the cycle that set this high-water mark. */
  at: string;
  /** Market clock AT THE PEAK, not at write time. The engine fires drift only
   *  while closed and arb only while open, so a peak's session is what decides
   *  which rule it could ever have triggered. */
  is_open: boolean;
  session: MarketSession;
  /** Unix seconds of the Chainlink round the peak was measured against. See
   *  `SeriesRow.oracle_updated_at` for the three cases this separates.
   *
   *  Recorded on the PEAK and not only on the hourly point because the peak is
   *  the record that answers "did Base ever approach the firing threshold?" —
   *  and a high-water mark set while the oracle was frozen is an artefact of
   *  the freeze, not evidence about Base. That is precisely the peak that would
   *  otherwise be quoted as the strongest case for the desk.
   *
   *  `undefined` for peaks written at `v: 1`, before this existed. */
  oracle_updated_at?: number | null;
}

/** One UTC day of Base-desk history — value at `bh:base:series:day:YYYYMMDD`. */
export interface BaseSeriesDay {
  /** `YYYYMMDD` UTC. Redundant with the key on purpose. */
  day: string;
  /** Schema version, independent of `SeriesDay.v` — the two records evolve
   *  separately and a shared number would imply a coupling that isn't there. */
  v: number;
  /** Marks this blob as the Base archive even after it is separated from its
   *  key. A `SeriesDay` has no such field, so a mis-filed blob is detectable
   *  by inspection and not only by which key it came from. */
  chain: "base";
  /** Hourly points, oldest first. At most 24. Same shape as the RH archive so
   *  one reader can walk both, but stored under a disjoint key prefix. */
  points: SeriesPoint[];
  /** Per-ticker daily |drift| extremes, sampled every cycle. See
   *  `BaseSeriesPeak` for why this is not redundant with `points`. */
  peaks: BaseSeriesPeak[];
  /** How many poll cycles contributed to `peaks` today. Without it, a day with
   *  a low peak is ambiguous between "the market was calm" and "we only sampled
   *  twice" — the unknown-vs-known-empty distinction, applied to a denominator. */
  cycles: number;
}

// ── Arrow ──────────────────────────────────────────────────────────────────
// An arrow is a graded signal fired by the rule engine (Block 1.2). This
// file only declares the type; the engine + grader land in a follow-up
// commit so /hood can still render "no arrows yet" without them.

export type ArrowType = "drift" | "arb" | "flow" | "whale";

export type ArrowStatus = "open" | "graded" | "informational";

/**
 * P0.1 (2026-07-24) — added `"void"`. Arrows graded during a closed
 * market cycle produce fake MISSes because the DEX↔oracle gap CANNOT
 * close while Chainlink is frozen. Those arrows are marked VOID and
 * excluded from hit rate. See grader.ts backfillVoidGrades().
 */
export type ArrowOutcome = "hit" | "miss" | "void" | "informational" | null;

export interface Arrow {
  /** UUID or ULID for uniqueness. */
  id: string;
  /** Aesthetic serial: `#0001`, `#0002` — monotonic per-project. */
  serial: string;
  /** Ticker this arrow is about. */
  ticker: string;
  /** Which desk fired this arrow. Absent ⟹ "robinhood" (see `chainOf`) — every
   *  arrow persisted before the Base desk landed is RH. The grader routes its
   *  fresh re-price on THIS field (a Base NVDA arrow must never grade against
   *  the RH NVDA price), and the dedup / cooldown KV keys are qualified by it so
   *  an RH and a Base arrow on the same ticker don't block each other. */
  chain?: HoodChain;
  /** Arrow type — determines grading rule. */
  type: ArrowType;
  /** Which direction the arrow expects the DEX price to move. */
  expected_direction: "up" | "down" | null;
  /** How many hours we wait before grading. */
  grading_window_h: number;
  /** DEX price at fire time (used as the grading baseline). */
  reference_price: number;
  /** Free-form snapshot ids we can cross-reference at grade time. */
  snapshot_refs: number[];
  /** ISO timestamp fired. */
  fired_at: string;
  /** Current lifecycle status. */
  status: ArrowStatus;
  /** Outcome once graded. Null until then. */
  outcome: ArrowOutcome;
  /** ISO timestamp graded, null until then. */
  graded_at: string | null;
  /** Free-form detail — e.g. "gap closed 62%", "price moved +1.7% opposite in 3h". */
  outcome_detail: string | null;
  /** Where the arrow was born. Only `"engine"` arrows are eligible for the
   *  public feed + hit-rate + arrows_today counters — a `"seeded"` arrow
   *  is a hand-crafted dev/QA fixture and can never taint the track
   *  record. Older records without this field are back-compat treated as
   *  `"engine"` (see `/api/hood/arrows`), but every arrow written going
   *  forward carries an explicit tag.
   *
   *  Reviewer T-A #1: "seed-test-arrow MUST set origin='seeded' every
   *  time, even when real=1". Guaranteed by construction — the seed
   *  route hard-codes it. */
  origin: "engine" | "seeded";
  /** DEPRECATED. Kept for legacy read of arrows persisted before `origin`
   *  landed. New writers use `origin: "seeded"` instead. Filter treats
   *  `test === true` as "hide" identically. */
  test?: boolean;
  /** Human-language "why" attached by A4 (`rh-stock-agent-brief`) at fire
   *  time. Populated once, cached forever on the arrow record. Null when
   *  the A4 call failed or was skipped — the arrow still fires either way. */
  brief?: ArrowBrief | null;
  /** T-E — user actions taken against this arrow. Every time a user
   *  signs a swap from the Review & Sign panel, we append an entry
   *  here. Purely a display / receipt-tracking field; DELIBERATELY
   *  excluded from hit-rate math (hit-rate is the SIGNAL's track
   *  record, not "did anyone trade this"). Multiple users can trade
   *  the same arrow — every action appends. */
  user_actions?: UserAction[];
  /** Pre-merge task #8 — snapshot of the exact numeric facts at fire
   *  time. In the old sync flow A4 was called AT fire time so its
   *  `facts_at_fire` block genuinely captured fire-time state. In the
   *  new async flow the brief attaches ~1-2 minutes later, and A4
   *  re-reads M5 at THAT time — so the persisted `brief.facts_at_fire`
   *  was really `facts_at_attach`. Bug caught with arrow #0008 PLTR
   *  (fired session=regular but brief claimed "Market CLOSED
   *  premarket"). Fix: capture the row's numeric fields on the arrow
   *  itself when fireArrow runs. brief-worker overrides the persisted
   *  brief's facts_at_fire with this so the UI's facts strip is
   *  always accurate to fire time. */
  snapshot_at_fire?: {
    dex_price_usd: number | null;
    oracle_price_usd: number | null;
    /** Primary pool TVL at fire time — this is the pool the swap route
     *  uses. Kept because the brief writer references "pool depth"
     *  meaning the swap-side pool. See `dex_total_tvl_usd` for the honest
     *  cross-pool number. */
    dex_tvl_usd: number | null;
    /** SUM across every pool for this token at fire time. Populated
     *  alongside `dex_tvl_usd` so the brief can say "token has $X in
     *  aggregate across N pools" without re-hitting M5. Null on rows
     *  that predate this field (safe to omit — brief falls back to
     *  `dex_tvl_usd`). */
    dex_total_tvl_usd?: number | null;
    dex_volume_24h_usd: number | null;
    /** Reserved — poll rows don't currently carry 24h change; kept null
     *  for schema parity with `ArrowBrief.facts_at_fire`. */
    dex_change_24h_pct: number | null;
    /** Chainlink oracle age in seconds at fire time. Reserved — poll
     *  rows don't currently expose this cleanly. Null for now; brief
     *  worker falls back to A4's read if this is null. */
    chainlink_age_seconds: number | null;
  } | null;
  /** Pre-merge task #8 — market clock captured at fire time. Same
   *  motive as `snapshot_at_fire`: brief-worker uses this to detect
   *  when A4's one_line_context contradicts the fire-time state (e.g.
   *  "market closed" said for an arrow that fired during regular
   *  session). Populated verbatim from the poll cycle's row. */
  market_at_fire?: {
    is_open: boolean;
    session: MarketSession;
    ny_time_iso: string;
  } | null;
  /** Async-brief lifecycle (T-D refactor). Older records without this
   *  field are back-compat treated as `"attached"` when `brief != null`
   *  or `"skipped"` when both `brief == null` and `origin == "seeded"`.
   *   - `pending`  — arrow persisted, brief worker hasn't run yet
   *   - `attached` — brief.verdict_note populated
   *   - `failed`   — worker gave up (A4 returned null or crashed)
   *   - `skipped`  — brief intentionally not fetched (test / seeded)
   *
   *  Chat card + push fan-out fire from the worker AFTER status flips to
   *  `attached`/`failed`, never from `fireArrow` directly, so the chat
   *  headline + notification body always reflect the final state. */
  brief_status?: "pending" | "attached" | "failed" | "skipped";
  /** When the worker last touched this arrow (queue attempt or attach).
   *  Kept so the worker can skip records it just processed if the queue
   *  is re-enqueued by a bug. */
  brief_worker_at?: string | null;
  /** The numbers the drift verdict was computed from, stored structurally.
   *  Before 2026-08-12 the only record of them was the display string in
   *  `outcome_detail` ("gap closed 62% (2.10% → 0.79%)"), so correcting the
   *  math meant parsing prose. `basis` names which oracle built
   *  `fire_gap_pct`: `fire_oracle` is correct, `grade_oracle` marks a row
   *  still carrying the pre-fix denominator. Absent on arb/flow. */
  grading_math?: {
    basis: "fire_oracle" | "grade_oracle";
    fire_oracle_price_usd: number | null;
    fire_dex_price_usd: number | null;
    fire_gap_pct: number | null;
    now_gap_pct: number | null;
    closed_by_pct: number | null;
    /** P2 (2026-08-13) — CLOSE-SIDE PRICE LEVELS.
     *
     *  `now_gap_pct` is a MAGNITUDE: |dex − oracle| / oracle. It says how big
     *  the gap was at grade time but not WHICH SIDE MOVED, so the grader
     *  scores a HIT identically whether the oracle came to the DEX or the DEX
     *  reverted to the oracle. The decomposition that would separate those two
     *  ("oracle catches up" vs "DEX reverts") has one equation and two
     *  unknowns without these levels — which is exactly why the 2026-08-12
     *  attempt could only decompose 9 of 112 graded drift arrows, and only by
     *  joining against the hourly archive that starts 20260810.
     *
     *  With these two fields every arrow graded from here on decomposes on its
     *  own, no archive join and no coverage window. This is the field that
     *  makes the (a)/(b) question answerable once n accumulates — and the only
     *  way to ever measure whether the brief's "snap toward the feed" claim is
     *  true, since the hit rate alone is blind to it.
     *
     *  `null` = no level available for that side (a pre-2026-08-13 row the
     *  regrade backfill touched; the backfill reads prose and cannot recover
     *  levels). Absent entirely = graded before 2026-08-13 and never
     *  regraded. Operationally identical — both mean "not decomposable" while
     *  the gap % stays valid. Readers MUST handle both and must never treat
     *  either as zero: zero is a price, missing is not. */
    close_oracle_price_usd?: number | null;
    close_dex_price_usd?: number | null;
  } | null;
  /** Drift Statistics v0 — what the per-ticker rolling record said about this
   *  ticker AT FIRE TIME. A fire-time fact, never recomputed: the whole point
   *  is to be able to ask later "what did we know when we chose to alert (or
   *  not)", and a value that drifts with the table can't answer that.
   *
   *  Shape is inlined rather than imported from `ticker-confidence.ts` because
   *  that module imports `Arrow` from here — the type would be circular.
   *  `ArrowTickerConfidence` there is the same shape and is the one to use in
   *  code; this declaration exists so `Arrow` stays self-contained. */
  ticker_confidence?: {
    level: "normal" | "low" | "insufficient";
    basis: "ticker_type" | "ticker" | "none";
    n: number;
    hits: number;
    wilson_high: number | null;
    computed_at: string | null;
  } | null;
}

export interface ArrowBrief {
  /** Deterministic 1-sentence "why" hard-mapped from A4's verdict (never
   *  LLM-picked). Always populated when the A4 call succeeded. */
  verdict_note: string;
  /** LLM-generated 1-liner context. Null if the LLM chain failed;
   *  `verdict_note` still carries the deterministic why. */
  one_line_context: string | null;
  /** Warnings from A4 verbatim — feed_abnormally_stale, thin_dex_pool,
   *  llm_context_unavailable, etc. Never edited. */
  warnings: string[];
  /** Which LLM served the context (virtuals / venice / bankr / null). */
  llm_provider: string | null;
  /** Full attempts trace — verifiable proof the Virtuals→Venice→Bankr
   *  chain played correctly. Reviewer T-A #2: on prod attempts[0] must
   *  show `provider: virtuals status: success`; local it's fine to see
   *  attempts[0]={virtuals, error, "VIRTUALS_API_KEY not set"} because
   *  the key is intentionally absent in .env.local. Stored on the arrow
   *  so a track-record reader can audit the chain later. */
  llm_attempts: Array<{
    provider: string;
    status: "success" | "error";
    duration_ms: number;
    error?: string;
  }>;
  /** Snapshot of the numeric facts A4 was given at fire time. Reviewer
   *  T-A verify concern: brief claimed "1.57% 24h decline" but the
   *  current snapshot showed -1.42% — was it legit drift or an LLM
   *  fabrication? With `facts_at_fire` a reader can settle it in one
   *  glance. Populated verbatim from A4's `facts` block. */
  facts_at_fire: {
    dex_price_usd: number | null;
    oracle_price_usd: number | null;
    dex_tvl_usd: number | null;
    dex_volume_24h_usd: number | null;
    dex_change_24h_pct: number | null;
    chainlink_age_seconds: number | null;
  };
  /** ISO timestamp when the brief was fetched. */
  fetched_at: string;
}

/**
 * T-E — a single user's trade against an arrow, recorded for display
 * only. This is a RECEIPT, not an audit: `wallet` is what the client
 * self-reported at the moment of the successful sign, and we ONLY
 * accept it after the tx hash lands on-chain. Kept anonymous — no
 * balances, no strategy signal.
 *
 * DELIBERATELY excluded from hit-rate: the signal is the arrow, not
 * "did anyone trade this". `/api/hood/arrows` reports these fields
 * verbatim so a viewer sees "you traded this arrow · 0x1234…↗" but
 * the hit_rate math never touches user_actions.
 */
export interface UserAction {
  /** ISO timestamp we accepted the action. */
  ts: string;
  /** 0x-prefixed connected wallet at sign time. Lowercased. */
  wallet: string;
  /** 0x-prefixed swap tx hash (approve is not recorded — only the
   *  final swap). Lowercased. */
  tx_hash: string;
  /** Side chosen — matches the arrow's expected direction most of the
   *  time; recorded verbatim so contrarian trades ("this signal is
   *  wrong, going the other way") stay honest. */
  side: "buy" | "sell";
  /** Human amount the user typed in. */
  amount: number;
  /** Quote denom at sign time (USDG or WETH). */
  denom: "USDG" | "WETH";
  /** min_out shown at sign time — snapshotted so the receipt stays
   *  honest even if the pool moves. */
  min_out: number | null;
  /**
   * v3 (2026-07-24): decoupled from broadcast — status ONLY becomes
   * `success` when a receipt with `status: "success"` (blockchain status
   * = 1) is observed. Otherwise:
   *   - `broadcast` — tx submitted, receipt not yet observed
   *   - `success`   — receipt confirmed with success bit
   *   - `reverted`  — receipt confirmed with revert bit (0)
   *   - `unknown`   — waited past timeout, receipt never observed
   *
   * Prior code used `pending` for the pre-receipt phase and let it
   * decay into `success` by omission, which meant "revert rate" was
   * structurally always 0. Renamed + new `unknown` bucket so the
   * indicator is honest. Legacy `pending` still accepted on the API
   * for backwards compat with in-flight client sessions.
   */
  status: "broadcast" | "success" | "reverted" | "unknown" | "pending";
  /** Revert reason if `status === "reverted"` and we could decode it.
   *  Free-form string (e.g. "STF" for Uniswap slippage). Nullable. */
  revert_reason?: string | null;
  /** Block number of the confirmed receipt if we have one. */
  block_number?: number | null;
}
