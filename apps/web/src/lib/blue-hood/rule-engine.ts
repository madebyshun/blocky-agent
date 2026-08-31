/**
 * Blue Hood — arrow rule engine.
 *
 * Walks a fresh snapshot, decides which tickers deserve an arrow, and hands
 * them to the persistence layer to fire. Every rule matches the public
 * spec exactly (see docs/blue-hood/arrow-rules.md). The engine NEVER
 * generates numbers on its own — thresholds are literal constants, the
 * snapshot fields are the source of truth.
 *
 * A single-cycle guarantee: dedup keys live in KV under
 * `bh:arrow:open:{ticker}:{type}`. If an open arrow already exists for
 * that (ticker, type) we do NOT fire again; the previous arrow will grade
 * itself before we look at that pair again.
 *
 * MVP note: this file lands drift + arb only. Flow (D2) needs D2 in the
 * snapshot; whale (D1) is informational and heavy (1h/cadence) — both
 * land in a follow-up commit so the drift board can ship first.
 */
import { kvGet, kvSet, kvMutate } from "@/lib/kv";
import { onArrowFired } from "./arrow-cache";
import { warnIfArrowIndexLarge } from "./arrow-index";
import {
  KV_ARROW_SERIAL_COUNTER,
  kvArrow,
  kvArrowOpenIndex,
  kvArrowOpenByTicker,
  kvArrowTickerCooldown,
  KV_ARROW_FEED,
  KV_BRIEF_QUEUE,
  TTL_ARROW_INDEX,
} from "./kv-keys";
import { getTickerConfidence, confidenceForFire, type TickerConfidenceTable } from "./ticker-confidence";
import { chainOf, ARB_MIN_ABS_PCT, DRIFT_MIN_ABS_PCT } from "./types";
import type { Arrow, ArrowType, HoodSnapshot, TickerSnapshot } from "./types";

// ── Thresholds (from spec Block 1.2) ─────────────────────────────────────
// DRIFT_MIN_ABS_PCT (2%, closed) and ARB_MIN_ABS_PCT (1%, open) both live in
// ./types (a dependency-free module) rather than here, because the BOARD needs
// to print whichever one is currently in force — "watching N Base stocks, drift
// hasn't reached ±2%" (#308: a quiet desk must explain itself, not look
// broken). This file imports `@/lib/kv`, so a client component can't pull the
// numbers from here without dragging Upstash into the browser bundle, and
// re-typing "2.0" in the UI would let the printed threshold silently diverge
// from the one that actually fires. Both are imported above.
// Dust floor — same as M4/M5 already enforce. Reads TOTAL token
// liquidity (`row.total_tvl_usd`), NOT `row.tvl_usd` (which is only
// primary-pool depth). Old check on primary-pool-only was blackholing
// tokens like NVDA whose bankr-robinhood WETH pool ($21M) dwarfs the
// USDG pool ($850k) — the engine was blind to the deepest pools on
// chain. Fallback to `tvl_usd` for rows that predate `total_tvl_usd`
// (mid-deploy cycles) so we don't accidentally fire on stale rows.
const MIN_TVL_USD = 5_000;
function rowTotalTvl(row: TickerSnapshot): number {
  return row.total_tvl_usd ?? row.tvl_usd ?? 0;
}
// P0.2 (2026-07-24) — executable-pool floor. The dust gate above uses
// TOTAL liquidity across all pools, which is correct for "is the token
// alive on chain". BUT the swap path (`ReviewSignPanel` → `X2 prepare`
// → V3 router) hits the PRIMARY pool only (USDG-quoted or deepest V3).
// If total = $20k but primary = $978, the engine fires and the panel
// then refuses "Pool too thin" — copilot contradicts itself. Fix:
// require BOTH total ≥ MIN_TVL AND primary ≥ MIN_TVL before firing.
// Verdict on the drift board still renders; only the arrow is skipped.
function rowPrimaryPoolTvl(row: TickerSnapshot): number {
  return row.tvl_usd ?? 0;
}

// P1 (2026-08-13) — DEAD-POOL LIVENESS GATE, drift only.
//
// A pool with no trades cannot move. When the DEX print is frozen and the
// oracle keeps ticking, `drift_pct` grows purely because the ORACLE walked
// away from a stale print — nothing drifted, and there is no basis for the
// arrow's claim that the two prices converge. The gap-closure decomposition
// (`scripts/gap-closure-dryrun.ts`, 2026-08-12) measured 8/24 tickers
// dead-or-noisy, accounting for 51% of graded drift arrows; BABA's print was
// bit-identical across 100% of archive hours, SPCX 98%.
//
// THRESHOLD IS MEASURED, NOT GUESSED. Swept the already-persisted
// `snapshot_at_fire.dex_volume_24h_usd` over all 117 graded drift arrows:
//
//   thr      kept  hits  rate   cut  cut_hits cut_rate
//   0        117    69   59%      0     -        -
//   1        103    66   64%     14     3       21%
//   1000      97    62   63%     20     7       35%
//   10000     76    49   64%     41    20       48%
//   50000     49    31   63%     68    38       55%
//
// The ENTIRE effect sits at the `> 0` boundary: cutting the 14 zero-volume
// arrows (which hit only 3/14 = 21%) lifts 59% → 64%, and every higher floor
// cuts more arrows for no additional gain. Raising this is a dead lever
// exactly like `DRIFT_MIN_ABS_PCT` already is — do not "tighten" it without
// new data. The 14 cut arrows are exactly BABA (9) + SPCX (5): the same two
// tickers the independent frozen-print audit flagged, which is why BABA's
// 11% hit rate is a measurement artifact rather than a weak signal.
//
// ⚠️ THIS GATE IS NARROWER THAN THE "51% OF ARROWS" HEADLINE — do not conflate
// them. That 51% counts every ticker flagged dead OR noisy (8/24). This gate
// only catches pools with literally zero 24h volume, which is BABA + SPCX =
// 14/117 arrows (12%). AMD, COIN and SLV are frozen ≥50% of archive HOURS yet
// still report real 24h volume, so they keep firing; ORCL (4.1× oracle vol)
// and NVDA (3.4×) are noisy rather than dead and are not touched either — and
// they hit 42% and 64%, so there is no measured case for gating noise. The
// remaining dead/noisy exposure is a known, deliberate gap, not an oversight.
//
// FORWARD-ONLY. This changes which arrows FIRE; it rewrites nothing already
// published. The public rate does not jump 59% → 64% on merge — it drifts
// there as new arrows accumulate. Anyone quoting 64% before then is quoting a
// counterfactual, not the record.
//
// Coherence: `rh-stock-arb.ts` does `const dex = primary.pool` and reads both
// `price_usd` and `volume_24h_usd` off that SAME object, so gating the price
// on the volume is not comparing two different pools.
//
// Drift only, on purpose. Arb's zero-volume record is n=2 (0 hits) — real but
// far too small to gate on, and arb fires while the market is OPEN, where the
// frozen-oracle mechanic that motivates this gate does not apply.
const MIN_DEX_VOL_24H_USD = 0;   // strict `>`; see the sweep above

/** `null` = the poller carried no volume reading for this row. NOT "zero". */
function rowDexVolume24h(row: TickerSnapshot): number | null {
  return typeof row.volume_24h_usd === "number" ? row.volume_24h_usd : null;
}

/** Dead = we HAVE a volume reading and it is at/below the floor.
 *  Missing data FAILS OPEN by design (CLAUDE.md: never infer a negative from
 *  absent data). `runRuleEngine` tallies the fail-open cases separately so a
 *  poller regression that starts nulling the field shows up in the log
 *  instead of silently disabling this gate. Measured `vol_null = 0` across
 *  all 117 graded drift arrows, so fail-open costs nothing today. */
function isDeadPool(row: TickerSnapshot): boolean {
  const vol = rowDexVolume24h(row);
  return vol !== null && vol <= MIN_DEX_VOL_24H_USD;
}

const DRIFT_GRADING_WINDOW_H = 6;   // grade after next-open + 2h (see grader.ts)
const ARB_GRADING_WINDOW_H = 4;

// ── Detection ──────────────────────────────────────────────────────────────

interface Candidate {
  type: ArrowType;
  expected_direction: "up" | "down";
  grading_window_h: number;
  reference_price: number;
}

/**
 * Given a snapshot row, decide if it's a candidate for firing an arrow
 * (before dust/dedup gates). Returns null if no rule TYPE matches for this
 * row. The distinction between "no candidate" and "candidate but dropped"
 * is what powers the structured `[engine]` log — see `runRuleEngine`.
 */
export function detectCandidate(row: TickerSnapshot): Candidate | null {
  if (row.verdict === "ERROR" || row.verdict === "INSUFFICIENT_DATA") return null;
  const drift = row.drift_pct ?? 0;
  const price = row.dex_usd ?? 0;
  if (price <= 0) return null;

  // ── drift: market CLOSED with a significant drift ─────────────────────
  if (!row.market.is_open && Math.abs(drift) >= DRIFT_MIN_ABS_PCT) {
    return {
      type: "drift",
      expected_direction: drift > 0 ? "down" : "up",
      grading_window_h: DRIFT_GRADING_WINDOW_H,
      reference_price: price,
    };
  }

  // ── arb: market OPEN with a LONG_DEX / SHORT_DEX verdict + threshold ──
  if (row.market.is_open && (row.verdict === "LONG_DEX" || row.verdict === "SHORT_DEX")) {
    if (Math.abs(drift) < ARB_MIN_ABS_PCT) return null;
    return {
      type: "arb",
      expected_direction: row.verdict === "LONG_DEX" ? "up" : "down",
      grading_window_h: ARB_GRADING_WINDOW_H,
      reference_price: price,
    };
  }

  return null;
}

/** Back-compat shim for callers that only want the "should fire?" answer
 *  after all gates. Prefer `detectCandidate` + explicit gate checks in
 *  new code so the engine can log the reason. */
export function detectArrow(row: TickerSnapshot): Candidate | null {
  const c = detectCandidate(row);
  if (!c) return null;
  if (rowTotalTvl(row) < MIN_TVL_USD) return null;
  // P0.2 — mirror the runRuleEngine executable-floor gate here so callers
  // of this shim get the same behavior.
  if (rowPrimaryPoolTvl(row) < MIN_TVL_USD) return null;
  // P1 — mirror the runRuleEngine dead-pool liveness gate. Drift only.
  if (c.type === "drift" && isDeadPool(row)) return null;
  if (c.type === "arb" && row.warnings.some((w) => w.startsWith("feed_abnormally_stale"))) return null;
  return c;
}

// ── Fire path ──────────────────────────────────────────────────────────────

/**
 * Mint the next public arrow serial (#0001, #0002, …).
 *
 * Returns null when the counter could not be read. That is deliberate and the
 * caller MUST abort the fire: this number is the arrow's public identity — it
 * lands in permalinks, share cards and the Telegram alert — and the old
 * `(await kvGet(...)) ?? 0` shape reset it to 1 on any KV read error, minting a
 * second #0001 that collides with a real, already-published arrow. A missing
 * arrow is a gap; two different arrows answering to the same serial is a
 * corrupted public record, and only one of those is recoverable.
 */
async function nextSerial(): Promise<string | null> {
  let next = 0;
  const res = await kvMutate<number>(KV_ARROW_SERIAL_COUNTER, 0, (cur) => (next = cur + 1));
  return res === "ok" ? `#${String(next).padStart(4, "0")}` : null;
}

interface OpenIndex {
  arrow_id: string;
  fired_at: string;
}

/**
 * Idempotency: skip if (ticker, type) already has an open arrow. Otherwise
 * mint a serial, persist the arrow record, update the open-index + feed
 * list, and return the fresh arrow. Returns null on skip.
 *
 * `opts.test` marks the arrow as a synthetic UI smoke — the public feed
 * + hit-rate reader filter these out so a seeded HIT never lands in the
 * "first arrow in Blue Hood history" slot.
 */
/**
 * Async-brief refactor (reviewer's T-A #3 pre-prod TODO):
 *
 *   fireArrow now returns after ~50ms KV writes. It persists a barebones
 *   arrow record with `brief_status: "pending"`, appends the id to
 *   `bh:brief:queue`, and returns. All expensive work — A4 brief fetch
 *   (5-15s), Web Push fan-out, Blue Chat card write — runs later in the
 *   `/api/cron/blue-hood/brief-worker` cron. This keeps poll-cycle wall
 *   time flat even when 5+ arrows fire in a cycle.
 *
 *   Test/seeded arrows short-circuit the queue entirely and land with
 *   `brief_status: "skipped"` — nothing async happens for them. The chat
 *   card is written inline for seeded arrows only, so dev QA can still
 *   validate the chat rendering without waiting on the worker.
 *
 *   `opts.test` is the legacy back-compat flag; new seeded arrows carry
 *   `origin: "seeded"` as the primary signal. Either one skips async work.
 */
export async function fireArrow(
  ticker: string,
  detected: Candidate,
  snapshot_ref: number,
  opts: {
    test?: boolean;
    origin?: "engine" | "seeded";
    forceBrief?: boolean;
    /** Pre-merge task #8 — the poll row that triggered this arrow. When
     *  present, its numeric fields + market clock are captured on the
     *  persisted arrow so the (later) brief-worker can build a brief
     *  from FIRE-time state instead of re-reading M5 at attach time. */
    row?: TickerSnapshot;
    /** Drift Statistics v0 — the confidence table for THIS cycle, read once
     *  by `runRuleEngine` and threaded down. Passed in rather than fetched
     *  here on purpose: a KV read inside fireArrow would run once per
     *  candidate instead of once per cycle. Absent (seed/test callers) is
     *  fine — the arrow lands stamped `insufficient/none`. */
    confidence?: TickerConfidenceTable | null;
  } = {},
): Promise<{ arrow: Arrow | null; skipReason?: "dedup_ticker" | "dedup_type" | "cooldown" | "serial_unavailable" }> {
  // Base-stocks P3: every dedup/cooldown/open-index key is chain-qualified
  // so the Base NVDA/META/GOOGL/AAPL arrows do NOT collide with the RH tickers of
  // the same name. `chainOf` defaults absent⟹"robinhood", so RH keys stay
  // byte-identical (no migration of live keys). The triggering poll row is
  // the source of truth for the chain; seed/test callers pass no row ⟹ RH.
  const chain = chainOf(opts.row);

  // P3.1 (v3, 2026-07-24): dedup escalated from (ticker, type) to
  // (ticker) — one arrow per ticker at a time, regardless of type.
  // The 15-minute drift→arb cascade on COIN (#0061→#0062) and the
  // single-cycle burst #0062–#0065 were the exact patterns to kill.
  const tickerIdxKey = kvArrowOpenByTicker(ticker, chain);
  const existingByTicker = await kvGet<OpenIndex>(tickerIdxKey);
  if (existingByTicker) return { arrow: null, skipReason: "dedup_ticker" };

  // Cooldown check — set by the grader when an arrow closes (any
  // outcome). 4h TTL. Prevents a fresh signal immediately after a
  // close on the same ticker.
  const cooldownKey = kvArrowTickerCooldown(ticker, chain);
  const cooldownActive = await kvGet<{ ts: string }>(cooldownKey);
  if (cooldownActive) return { arrow: null, skipReason: "cooldown" };

  // Legacy (ticker, type) index stays for back-compat + as a defensive
  // second guard — grader.ts still writes to this key when arrows close.
  const idxKey = kvArrowOpenIndex(ticker, detected.type, chain);
  const existing = await kvGet<OpenIndex>(idxKey);
  if (existing) return { arrow: null, skipReason: "dedup_type" };

  // No serial ⟹ no arrow. See `nextSerial` — firing without a trustworthy
  // serial publishes a duplicate public identity, which is worse than a miss.
  const serial = await nextSerial();
  if (serial === null) return { arrow: null, skipReason: "serial_unavailable" };

  const id = cryptoUuid();
  const now = new Date().toISOString();
  // Reviewer T-A #1: `origin` is the primary "public feed eligibility"
  // flag. Default is "engine" — the only path that ever writes public
  // arrows. Legacy `test: true` is preserved during the migration window
  // for A4-skip purposes; new seeded arrows always carry both.
  const origin: "engine" | "seeded" = opts.origin ?? "engine";
  // `forceBrief` (dev-only, set by seed-test-arrow?with_brief=1) overrides
  // the seeded/test skip so a seeded arrow can exercise the A4 brief
  // pipeline end-to-end. The arrow STILL carries origin="seeded" — every
  // downstream filter (public feed, hit-rate, sidebar, push fan-out,
  // grader) treats it exactly like a normal seeded arrow. Only the
  // async-brief guard is lifted. Push stays hard-gated on origin==="engine"
  // inside `pushArrowToAll` + brief-worker; forceBrief cannot cross that.
  const skipAsync = (opts.test || origin === "seeded") && !opts.forceBrief;
  // ⚠️ DO NOT add `|| chain !== "robinhood"` here. A Base arrow must NOT get an
  // RH brief (A4 is Robinhood-only and takes a bare ticker — see
  // `brief.ts::hasBriefPath`), but this flag is the wrong lever: the brief
  // QUEUE is also the delivery rail for the chat card, the Web Push fan-out and
  // the watchlist alerts (`brief-worker` lines ~169/177/onward). Skipping the
  // enqueue would decline the brief AND silently mute the entire Base desk —
  // arrows firing that nobody is ever told about, which is a far worse failure
  // than a missing paragraph. The chain gate lives inside `fetchArrowBrief`
  // instead, so Base arrows ride these rails and simply land `brief: null`.
  const row = opts.row;
  const arrow: Arrow = {
    id,
    serial,
    ticker,
    chain,
    type: detected.type,
    expected_direction: detected.expected_direction,
    grading_window_h: detected.grading_window_h,
    reference_price: detected.reference_price,
    snapshot_refs: [snapshot_ref],
    fired_at: now,
    status: "open",
    outcome: null,
    graded_at: null,
    outcome_detail: null,
    brief: null,
    brief_status: skipAsync ? "skipped" : "pending",
    brief_worker_at: null,
    // Pre-merge task #8 — capture fire-time facts + market clock so
    // brief-worker has an authoritative snapshot instead of re-reading
    // M5 at attach time (which lied for arrow #0008 PLTR — said
    // "market closed" for an arrow that fired during regular session).
    snapshot_at_fire: row ? {
      dex_price_usd: row.dex_usd,
      oracle_price_usd: row.oracle_usd,
      dex_tvl_usd: row.tvl_usd,
      dex_total_tvl_usd: row.total_tvl_usd,
      dex_volume_24h_usd: row.volume_24h_usd,
      dex_change_24h_pct: null, // not carried on poll row today
      chainlink_age_seconds: null, // not carried on poll row today
    } : null,
    market_at_fire: row ? {
      is_open: row.market.is_open,
      session: row.market.session,
      ny_time_iso: row.market.ny_time_iso,
    } : null,
    origin,
    // Drift Statistics v0 — stamped at fire time and never recomputed, so
    // "what did the record say when we chose to alert?" stays answerable.
    ticker_confidence: confidenceForFire(opts.confidence ?? null, ticker, detected.type),
    ...(opts.test ? { test: true } : {}),
  };

  await kvSet(kvArrow(id), arrow);
  await kvSet(idxKey,       { arrow_id: id, fired_at: now } satisfies OpenIndex, TTL_ARROW_INDEX);
  // P3.1: also write the ticker-level open index so a follow-up firing of
  // a different type on the same ticker within the same cycle sees it.
  await kvSet(tickerIdxKey, { arrow_id: id, fired_at: now } satisfies OpenIndex, TTL_ARROW_INDEX);

  // Push id onto the feed list (newest-first). The feed is unbounded BY DESIGN
  // and stays that way — see `arrow-index.ts` for why trimming it is not an
  // optimisation but the loss of the track record. #154 adds a size WARNING
  // here instead, because this is the one line in the codebase that makes the
  // index longer.
  //
  // `kvMutate`, not `kvGet ?? []` — this key is the ONLY index of the public
  // arrow feed, it carries no TTL and has no backup. Under the old shape a
  // single throttled read rewrote it as `[thisArrowId]`, orphaning every
  // arrow ever fired: the records themselves survive under their own keys,
  // but nothing points at them, so /hood and the track record both go blank
  // and only a `kvScan` sweep gets them back. Skipping one append costs one
  // arrow its feed slot. See `kvMutate` in lib/kv.ts.
  //
  // `feedLen` is read out of the callback (same pattern as `queueLen` below)
  // because `kvMutate` returns an outcome, not the new value.
  let feedLen = 0;
  const feedRes = await kvMutate<string[]>(KV_ARROW_FEED, [], (feed) => {
    feedLen = feed.length + 1;
    return [id, ...feed];
  });
  if (feedRes === "skipped") {
    console.error(`[fire] ${serial} ${ticker} persisted but NOT indexed — KV read failed; arrow is orphaned until re-indexed`);
  } else {
    // Only meaningful when the read landed: on "skipped" the callback never
    // ran and `feedLen` is still 0, which would read as an empty index rather
    // than as "we did not find out". Silence is the honest answer there.
    warnIfArrowIndexLarge(feedLen, "fire");
  }

  // #148 ② — keep the hydrated read-cache in step with the index we just wrote.
  // This is a CACHE update, so it is deliberately best-effort and deliberately
  // AFTER the authoritative write above: if it fails, `onArrowFired` drops the
  // blob and the next reader rebuilds from the index. The cache can never be
  // the reason an arrow fails to persist.
  await onArrowFired(arrow);

  if (skipAsync) {
    // Seeded/test path — write a chat card inline so QA has one, but
    // never touch A4 (would burn LLM $) or the push fan-out (would
    // notify real subscribers with a fake arrow).
    if (!opts.test) {
      // A seeded (non-test) arrow — chat card for local dev only.
      const { writeChatCard } = await import("./chat-card");
      await writeChatCard(arrow);
    }
    console.log(`[fire] ${serial} ${ticker} type=${detected.type} origin=${origin} async=skipped`);
    return { arrow };
  }

  // Engine path — enqueue for the async worker. Queue is FIFO (append,
  // shift at worker time) so the OLDEST pending brief attaches first.
  // Same reasoning as the feed above: a failed read used to replace the whole
  // pending-brief queue with `[id]`, silently dropping every other arrow
  // waiting for a brief. `null` from the callback is the old `includes` guard.
  let queueLen = 0;
  const queueRes = await kvMutate<string[]>(KV_BRIEF_QUEUE, [], (queue) => {
    queueLen = queue.length;
    if (queue.includes(id)) return null;
    queueLen = queue.length + 1;
    return [...queue, id];
  });
  console.log(
    `[fire] ${serial} ${ticker} type=${detected.type} origin=${origin}` +
    (queueRes === "skipped"
      ? " enqueue=SKIPPED (KV read failed — no brief will attach)"
      : ` enqueued queue_len=${queueLen}`),
  );
  return { arrow };
}

function cryptoUuid(): string {
  try {
    const g = globalThis as { crypto?: { randomUUID?: () => string } };
    if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  } catch { /* fall through */ }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ── Engine driver ──────────────────────────────────────────────────────────
//
// Report shape mirrors the reviewer-mandated log line so the two never
// drift apart. Sanity property (guaranteed by construction, asserted in
// tests):
//   candidates_over_threshold = skipped_dust + skipped_no_executable_pool
//                             + skipped_dead_pool + skipped_feed_stale
//                             + deduped + fired
//   candidates_over_threshold + below_threshold = tokens_watched
//                                                 - tokens_errored
//   fired = fired_normal + fired_low_confidence + fired_insufficient
//
// (`skipped_no_executable_pool` was missing from the first identity until
//  2026-08-13 — the comment had gone stale against the P0.2 gate. Any new
//  gate MUST be added here and to `blue-hood-smoke.ts`'s conservation check,
//  or the two silently disagree.)

export interface RuleEngineReport {
  cycle_id: number;
  tokens_watched: number;
  tokens_errored: number;
  candidates_over_threshold: number;
  skipped_dust: number;
  /** P0.2 — dust check passed (total ≥ $5k) but the primary swap pool
   *  is below $5k, so the panel would refuse "Pool too thin". Engine
   *  skips to prevent the self-contradiction. */
  skipped_no_executable_pool: number;
  /** P1 — drift candidate on a pool with no 24h volume. The DEX print
   *  cannot move, so the "drift" is the oracle walking away from a stale
   *  quote, not a real dislocation. Measured: these arrows hit 3/14 = 21%
   *  against a 59% baseline. */
  skipped_dead_pool: number;
  /** P1 observability, NOT a skip — drift candidates that passed the
   *  liveness gate only because `volume_24h_usd` was absent (fail-open).
   *  Does not appear in the conservation identity; it double-counts rows
   *  that went on to fire or be deduped. Expected 0; a non-zero value
   *  means the poller stopped carrying volume and the gate is inert. */
  dead_pool_vol_unknown: number;
  skipped_feed_stale: number;
  below_threshold: number;
  deduped: number;
  /** P3.1 — dedup broken out by cause so the impact of the ticker rule
   *  vs the cooldown rule is measurable in logs + response. */
  skipped_dedup_ticker: number;
  skipped_cooldown: number;
  skipped_dedup_type: number;
  fired: number;
  /** Drift Statistics v0 — how `fired` splits by the per-ticker record.
   *  These PARTITION `fired` (they never subtract from it): a low-confidence
   *  arrow still fires and still grades, it just loses the alert fan-out.
   *  `fired_low_confidence` is expected to be 0 until some ticker reaches
   *  n=15 with a Wilson upper bound under 50% — watching it leave 0 is how
   *  we learn the gate woke up. */
  fired_normal: number;
  fired_low_confidence: number;
  fired_insufficient: number;
  arrows_fired: Arrow[];
}

export async function runRuleEngine(snap: HoodSnapshot): Promise<RuleEngineReport> {
  let candidates_over_threshold = 0;
  let skipped_dust = 0;
  let skipped_no_executable_pool = 0;
  let skipped_dead_pool = 0;
  let dead_pool_vol_unknown = 0;
  let skipped_feed_stale = 0;
  let below_threshold = 0;
  let deduped = 0;
  let skipped_dedup_ticker = 0;
  let skipped_cooldown = 0;
  let skipped_dedup_type = 0;
  let fired_normal = 0;
  let fired_low_confidence = 0;
  let fired_insufficient = 0;
  const fired: Arrow[] = [];

  // ONE KV read per cycle, hoisted above the loop. Inside it this would be
  // ~20 reads/cycle × 288 cycles/day against the Upstash cap that already
  // killed this engine once (task #123). Null (key never written) is a
  // legitimate state — every arrow then stamps `insufficient/none`.
  const confidence = await getTickerConfidence();

  for (const row of snap.tickers) {
    if (row.verdict === "ERROR") continue; // errored rows are tracked separately in metrics
    const candidate = detectCandidate(row);
    if (!candidate) { below_threshold++; continue; }
    candidates_over_threshold++;

    // Gates, in the order they short-circuit:
    // Dust gate uses TOTAL token liquidity — see `rowTotalTvl` note.
    if (rowTotalTvl(row) < MIN_TVL_USD) { skipped_dust++; continue; }
    // P0.2 — primary pool executable floor. Total passes but primary
    // sub-dust means the swap panel would refuse "Pool too thin".
    const primaryTvl = rowPrimaryPoolTvl(row);
    if (primaryTvl < MIN_TVL_USD) {
      console.log(
        `[engine] skipped_no_executable_pool ticker=${row.ticker}` +
        ` primary_tvl=${primaryTvl.toFixed(0)}` +
        ` total_tvl=${rowTotalTvl(row).toFixed(0)}`,
      );
      skipped_no_executable_pool++;
      continue;
    }
    // P1 — dead-pool liveness. Drift only; see MIN_DEX_VOL_24H_USD note.
    if (candidate.type === "drift") {
      const vol = rowDexVolume24h(row);
      if (vol === null) {
        // Fail-open, but never silently: this is the line that tells us the
        // gate went inert because the poller stopped carrying volume.
        dead_pool_vol_unknown++;
        console.log(
          `[engine] dead_pool_vol_unknown ticker=${row.ticker}` +
          ` drift=${(row.drift_pct ?? 0).toFixed(2)}%` +
          ` (volume_24h_usd absent — liveness gate FAILED OPEN, arrow allowed)`,
        );
      } else if (vol <= MIN_DEX_VOL_24H_USD) {
        console.log(
          `[engine] skipped_dead_pool ticker=${row.ticker}` +
          ` vol_24h=${vol.toFixed(0)} drift=${(row.drift_pct ?? 0).toFixed(2)}%` +
          ` primary_tvl=${primaryTvl.toFixed(0)}` +
          ` (no trades — the oracle moved, the pool did not)`,
        );
        skipped_dead_pool++;
        continue;
      }
    }
    if (candidate.type === "arb" && row.warnings.some((w) => w.startsWith("feed_abnormally_stale"))) {
      skipped_feed_stale++; continue;
    }

    // Pass `row` so fire-time facts + market clock get captured on the
    // persisted arrow (task #8). brief-worker uses these to author a
    // brief from FIRE-time state, not attach-time state.
    const result = await fireArrow(row.ticker, candidate, snap.cycle_id, { row, confidence });
    if (result.arrow) {
      fired.push(result.arrow);
      const conf = result.arrow.ticker_confidence;
      if (conf?.level === "low") {
        fired_low_confidence++;
        // Logged per-arrow, not just counted: this is the line that has to
        // justify a suppressed alert months later, so it carries the whole
        // basis rather than a bare verdict.
        console.log(
          `[engine] fired_low_confidence ticker=${row.ticker} type=${candidate.type}` +
            ` serial=${result.arrow.serial} basis=${conf.basis}` +
            ` record=${conf.hits}/${conf.n} wilson_high=${conf.wilson_high}` +
            ` table_at=${conf.computed_at} (arrow fires + grades; alerts suppressed)`,
        );
      } else if (conf?.level === "normal") {
        fired_normal++;
      } else {
        fired_insufficient++;
      }
    } else {
      deduped++;
      // P3.1 — attribute the skip so we can see WHICH rule kept arrow
      // volume down. `[engine] skipped_dedup / skipped_cooldown` lines
      // are what the DoD (<20 arrows/day) will be measured against.
      switch (result.skipReason) {
        case "dedup_ticker":
          skipped_dedup_ticker++;
          console.log(`[engine] skipped_dedup_ticker ticker=${row.ticker} type=${candidate.type}`);
          break;
        case "cooldown":
          skipped_cooldown++;
          console.log(`[engine] skipped_cooldown ticker=${row.ticker} type=${candidate.type}`);
          break;
        case "dedup_type":
          skipped_dedup_type++;
          console.log(`[engine] skipped_dedup_type ticker=${row.ticker} type=${candidate.type}`);
          break;
        case "serial_unavailable":
          // NOT a dedup — an infrastructure skip. Logged at error level and
          // left out of the dedup counters on purpose: rolling it into
          // `skipped_dedup_*` would make a KV outage read as "the dedup rules
          // are working", which is the exact class of blindness #150 closes.
          console.error(`[engine] skipped_serial_unavailable ticker=${row.ticker} type=${candidate.type} — KV read failed, refusing to mint a duplicate serial`);
          break;
      }
    }
  }

  // Structured log — one line, machine-greppable. `firstError` is soft-off
  // in prod so a bad row doesn't kill the poll cycle.
  console.log(
    `[engine] cycle=${snap.cycle_id}` +
      ` candidates_over_threshold=${candidates_over_threshold}` +
      ` skipped_dust=${skipped_dust}` +
      ` skipped_no_executable_pool=${skipped_no_executable_pool}` +
      ` skipped_dead_pool=${skipped_dead_pool}` +
      ` dead_pool_vol_unknown=${dead_pool_vol_unknown}` +
      ` skipped_feed_stale=${skipped_feed_stale}` +
      ` below_threshold=${below_threshold}` +
      ` fired=${fired.length}` +
      ` deduped=${deduped}` +
      ` skipped_dedup_ticker=${skipped_dedup_ticker}` +
      ` skipped_cooldown=${skipped_cooldown}` +
      ` skipped_dedup_type=${skipped_dedup_type}` +
      ` fired_normal=${fired_normal}` +
      ` fired_low_confidence=${fired_low_confidence}` +
      ` fired_insufficient=${fired_insufficient}`,
  );

  return {
    cycle_id: snap.cycle_id,
    tokens_watched: snap.metrics.tokens_watched,
    tokens_errored: snap.metrics.tokens_errored,
    candidates_over_threshold,
    skipped_dust,
    skipped_no_executable_pool,
    skipped_dead_pool,
    dead_pool_vol_unknown,
    skipped_feed_stale,
    below_threshold,
    deduped,
    skipped_dedup_ticker,
    skipped_cooldown,
    skipped_dedup_type,
    fired: fired.length,
    fired_normal,
    fired_low_confidence,
    fired_insufficient,
    arrows_fired: fired,
  };
}
