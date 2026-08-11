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
import { kvGet, kvSet } from "@/lib/kv";
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
import type { Arrow, ArrowType, HoodSnapshot, TickerSnapshot } from "./types";

// ── Thresholds (from spec Block 1.2) ─────────────────────────────────────
const DRIFT_MIN_ABS_PCT = 2.0;   // |drift| ≥ 2% during premarket/afterhours
const ARB_MIN_ABS_PCT = 1.0;     // |delta| ≥ 1% during regular hours
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
  if (c.type === "arb" && row.warnings.some((w) => w.startsWith("feed_abnormally_stale"))) return null;
  return c;
}

// ── Fire path ──────────────────────────────────────────────────────────────

async function nextSerial(): Promise<string> {
  const cur = (await kvGet<number>(KV_ARROW_SERIAL_COUNTER)) ?? 0;
  const next = cur + 1;
  await kvSet(KV_ARROW_SERIAL_COUNTER, next);
  return `#${String(next).padStart(4, "0")}`;
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
  } = {},
): Promise<{ arrow: Arrow | null; skipReason?: "dedup_ticker" | "dedup_type" | "cooldown" }> {
  // P3.1 (v3, 2026-07-24): dedup escalated from (ticker, type) to
  // (ticker) — one arrow per ticker at a time, regardless of type.
  // The 15-minute drift→arb cascade on COIN (#0061→#0062) and the
  // single-cycle burst #0062–#0065 were the exact patterns to kill.
  const tickerIdxKey = kvArrowOpenByTicker(ticker);
  const existingByTicker = await kvGet<OpenIndex>(tickerIdxKey);
  if (existingByTicker) return { arrow: null, skipReason: "dedup_ticker" };

  // Cooldown check — set by the grader when an arrow closes (any
  // outcome). 4h TTL. Prevents a fresh signal immediately after a
  // close on the same ticker.
  const cooldownKey = kvArrowTickerCooldown(ticker);
  const cooldownActive = await kvGet<{ ts: string }>(cooldownKey);
  if (cooldownActive) return { arrow: null, skipReason: "cooldown" };

  // Legacy (ticker, type) index stays for back-compat + as a defensive
  // second guard — grader.ts still writes to this key when arrows close.
  const idxKey = kvArrowOpenIndex(ticker, detected.type);
  const existing = await kvGet<OpenIndex>(idxKey);
  if (existing) return { arrow: null, skipReason: "dedup_type" };

  const serial = await nextSerial();
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
  const row = opts.row;
  const arrow: Arrow = {
    id,
    serial,
    ticker,
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
    ...(opts.test ? { test: true } : {}),
  };

  await kvSet(kvArrow(id), arrow);
  await kvSet(idxKey,       { arrow_id: id, fired_at: now } satisfies OpenIndex, TTL_ARROW_INDEX);
  // P3.1: also write the ticker-level open index so a follow-up firing of
  // a different type on the same ticker within the same cycle sees it.
  await kvSet(tickerIdxKey, { arrow_id: id, fired_at: now } satisfies OpenIndex, TTL_ARROW_INDEX);

  // Push id onto the feed list (newest-first). We keep the feed unbounded
  // for now; when it grows past ~500 we can trim in a follow-up.
  const feed = (await kvGet<string[]>(KV_ARROW_FEED)) ?? [];
  feed.unshift(id);
  await kvSet(KV_ARROW_FEED, feed);

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
  const queue = (await kvGet<string[]>(KV_BRIEF_QUEUE)) ?? [];
  if (!queue.includes(id)) {
    queue.push(id);
    await kvSet(KV_BRIEF_QUEUE, queue);
  }
  console.log(`[fire] ${serial} ${ticker} type=${detected.type} origin=${origin} enqueued queue_len=${queue.length}`);
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
//   candidates_over_threshold = skipped_dust + skipped_feed_stale + deduped + fired
//   candidates_over_threshold + below_threshold = tokens_watched
//                                                 - tokens_errored

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
  skipped_feed_stale: number;
  below_threshold: number;
  deduped: number;
  /** P3.1 — dedup broken out by cause so the impact of the ticker rule
   *  vs the cooldown rule is measurable in logs + response. */
  skipped_dedup_ticker: number;
  skipped_cooldown: number;
  skipped_dedup_type: number;
  fired: number;
  arrows_fired: Arrow[];
}

export async function runRuleEngine(snap: HoodSnapshot): Promise<RuleEngineReport> {
  let candidates_over_threshold = 0;
  let skipped_dust = 0;
  let skipped_no_executable_pool = 0;
  let skipped_feed_stale = 0;
  let below_threshold = 0;
  let deduped = 0;
  let skipped_dedup_ticker = 0;
  let skipped_cooldown = 0;
  let skipped_dedup_type = 0;
  const fired: Arrow[] = [];

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
    if (candidate.type === "arb" && row.warnings.some((w) => w.startsWith("feed_abnormally_stale"))) {
      skipped_feed_stale++; continue;
    }

    // Pass `row` so fire-time facts + market clock get captured on the
    // persisted arrow (task #8). brief-worker uses these to author a
    // brief from FIRE-time state, not attach-time state.
    const result = await fireArrow(row.ticker, candidate, snap.cycle_id, { row });
    if (result.arrow) {
      fired.push(result.arrow);
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
      ` skipped_feed_stale=${skipped_feed_stale}` +
      ` below_threshold=${below_threshold}` +
      ` fired=${fired.length}` +
      ` deduped=${deduped}` +
      ` skipped_dedup_ticker=${skipped_dedup_ticker}` +
      ` skipped_cooldown=${skipped_cooldown}` +
      ` skipped_dedup_type=${skipped_dedup_type}`,
  );

  return {
    cycle_id: snap.cycle_id,
    tokens_watched: snap.metrics.tokens_watched,
    tokens_errored: snap.metrics.tokens_errored,
    candidates_over_threshold,
    skipped_dust,
    skipped_no_executable_pool,
    skipped_feed_stale,
    below_threshold,
    deduped,
    skipped_dedup_ticker,
    skipped_cooldown,
    skipped_dedup_type,
    fired: fired.length,
    arrows_fired: fired,
  };
}
