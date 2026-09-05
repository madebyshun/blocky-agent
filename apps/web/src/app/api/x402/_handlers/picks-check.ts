/**
 * picks-check — Daily track record checker (NO LLM).
 *
 * Reads pending picks stored in KV (written by _shared.ts after base-token-scan).
 * Looks up current price 22h after the signal via GeckoTerminal.
 * Win = +3%, Loss = -3%, Neutral = between.
 *
 * KV keys:
 *  feed:picks:pending  — PendingPick[]  (7-day TTL, refreshed on each write)
 *  feed:picks:history  — PickOutcome[]  (30-day TTL, last 30 outcomes kept)
 *
 * Returns _noCard:true when there are no picks due this run.
 */
import { getBaseTrending }            from "@/lib/market-data";
import { kvSet, kvGetProbe, kvMutate } from "@/lib/kv";

// This used to import FEED_PAUSED from the feed cron so the wording could never
// drift from the flag. Blue Feed was RETIRED on 2026-09-02 — cron, pages and
// _shared.ts are deleted — so there is no flag left to drift from and no state
// this handler could be wrong about. "Paused" is now the wrong word: it promises
// a resume that will not happen.

const PENDING_KEY = "feed:picks:pending";
const HISTORY_KEY = "feed:picks:history";
const WIN_PCT     =  3;  // +3% → WIN
const LOSS_PCT    = -3;  // -3% → LOSS

export type PendingPick = {
  symbol:          string;
  price_at_signal: number | null;
  signal_ts:       number;
  check_after:     number;  // epoch ms — when to evaluate
  volume_24h:      number | null;
  liquidity_usd:   number | null;
};

export type PickOutcome = PendingPick & {
  price_at_check: number | null;
  outcome_pct:    number | null;
  outcome:        "WIN" | "LOSS" | "NEUTRAL" | "UNKNOWN";
  checked_ts:     number;
};

function buildTrackRecord(history: PickOutcome[]) {
  const wins    = history.filter((o) => o.outcome === "WIN");
  const losses  = history.filter((o) => o.outcome === "LOSS");
  const neutral = history.filter((o) => o.outcome === "NEUTRAL");
  const known   = wins.length + losses.length;
  const avg = (arr: PickOutcome[]) =>
    arr.length ? +(arr.reduce((s, o) => s + (o.outcome_pct ?? 0), 0) / arr.length).toFixed(2) : null;
  return {
    total:        history.length,
    wins:         wins.length,
    losses:       losses.length,
    neutral:      neutral.length,
    win_rate:     known > 0 ? +(wins.length / known * 100).toFixed(1) : null,
    avg_win_pct:  avg(wins),
    avg_loss_pct: avg(losses),
  };
}

/**
 * Persist one completed check.
 *
 * The two writes are ONE transaction in meaning: a due pick leaves PENDING only
 * because it landed in HISTORY. The old code ran them in `Promise.all`, so a
 * history failure still cleared the pending queue — the picks were dropped
 * without ever being graded, which biases the record by deleting exactly the
 * entries that were old enough to resolve.
 *
 * So: append history first, and only clear pending if it landed. If it didn't,
 * the picks stay due and get re-checked next run. That measures them slightly
 * later than 22h — a small, disclosed drift, and far better than losing them.
 *
 * Exported so scripts/kv-mutate-part2-test.ts can drive the REAL function
 * rather than a reimplementation of it. A test of a copy proves nothing about
 * what ships.
 */
export async function persistPickCheck(
  outcomes:     PickOutcome[],
  stillPending: PendingPick[],
): Promise<{ persisted: boolean; history: PickOutcome[] }> {
  let updatedHistory: PickOutcome[] = [];

  const histRes = await kvMutate<PickOutcome[]>(
    HISTORY_KEY,
    [],
    (history) => (updatedHistory = [...outcomes, ...history].slice(0, 30)),
    30 * 24 * 3600,
  );

  const persisted = histRes === "ok";
  if (persisted) {
    await kvSet(PENDING_KEY, stillPending, 7 * 24 * 3600);
  } else {
    console.error(`[picks-check] history NOT appended (${histRes}) — pending queue left intact; ${outcomes.length} picks will be re-checked next run`);
  }

  return { persisted, history: updatedHistory };
}

export default async function handler(_req: Request): Promise<Response> {
  try {
    const now = Date.now();

    // #150 A-part2. This handler had two distinct failure modes, and the second
    // one is the reason the whole read is a probe now:
    //
    //  1. PENDING read fails → `?? []` → `due = []` → the early return below
    //     fires. No write, so no data was lost — but it answered "No picks are
    //     due for checking yet" when the truth was "I can't see the queue".
    //     Every due pick then silently ages past its 22h window.
    //
    //  2. PARTIAL failure — PENDING read succeeds, HISTORY read throws. `due`
    //     is non-empty so we proceed, and `[...outcomes, ...[]]` overwrites 30
    //     accumulated outcomes with just this batch. That IS the published
    //     track record (see the picks-check case in cron/feed/_shared.ts):
    //     silently resetting it to "n=3" is the empty-as-fact failure this
    //     whole sweep exists to kill.
    const pendingProbe = await kvGetProbe<PendingPick[]>(PENDING_KEY);
    if (pendingProbe.status === "error") {
      return Response.json({
        tool:          "picks-check",
        _noCard:       true,
        reason:        "Pick queue unavailable — cannot tell which picks are due. Nothing was checked or written.",
        code:          "kv_unavailable",
        pending_count: null,   // null = unknown. NOT 0 — 0 would read as "queue is empty".
        track_record:  null,
        timestamp:     new Date().toISOString(),
      });
    }

    const pending      = pendingProbe.status === "hit" ? pendingProbe.value : [];
    const due          = pending.filter((p) => now >= p.check_after);
    const stillPending = pending.filter((p) => now <  p.check_after);

    if (due.length === 0) {
      // Nothing to write, so history is needed for display only. An errored
      // read yields `track_record: null` (unknown), never a zeroed record —
      // the feed formatter drops null metrics but would happily publish "0".
      const histProbe = await kvGetProbe<PickOutcome[]>(HISTORY_KEY);
      return Response.json({
        tool:            "picks-check",
        _noCard:         true,
        // "No picks are due YET" would only be true if something were still
        // feeding the queue. Nothing has since 2026-06-27, and as of 2026-09-02
        // nothing ever will: the sole writer of PENDING was the hourly feed
        // cron, which is now deleted, not merely paused. Saying "yet" promises
        // a measurement that can never arrive — the same empty-as-fact lie this
        // sweep exists to kill, just wearing a friendlier word. `track_record`
        // stays a real zeroed record (not null) because the history read
        // SUCCEEDED and is genuinely empty; null is reserved for "couldn't
        // read", a different thing, handled below.
        reason: "Blue Feed was retired on 2026-09-02, so the pick queue is no longer written and nothing is being graded. This is an EMPTY record, not a measured one — win_rate is null (unknown), not zero. It will not resume.",
        code: "feed_retired",
        pending_count:   stillPending.length,
        track_record:    histProbe.status === "error"
          ? null
          : buildTrackRecord(histProbe.status === "hit" ? histProbe.value : []),
        timestamp:       new Date().toISOString(),
      });
    }

    // Price lookup via current GeckoTerminal trending
    const trending = await getBaseTrending(25).catch(() => []);
    const priceMap = new Map<string, number | null>(
      trending.map((p) => [p.baseSymbol.toUpperCase(), p.priceUsd])
    );

    const outcomes: PickOutcome[] = due.map((pick) => {
      const currentPrice = priceMap.get(pick.symbol.toUpperCase()) ?? null;
      let outcome_pct: number | null = null;
      let outcome: PickOutcome["outcome"] = "UNKNOWN";
      if (currentPrice != null && pick.price_at_signal != null && pick.price_at_signal > 0) {
        outcome_pct = +((currentPrice - pick.price_at_signal) / pick.price_at_signal * 100).toFixed(2);
        outcome     = outcome_pct >= WIN_PCT ? "WIN"
                    : outcome_pct <= LOSS_PCT ? "LOSS"
                    : "NEUTRAL";
      }
      return { ...pick, price_at_check: currentPrice, outcome_pct, outcome, checked_ts: now };
    });

    const { persisted, history: updatedHistory } = await persistPickCheck(outcomes, stillPending);

    // Only report a track record we actually wrote. On a skipped append the
    // in-memory `updatedHistory` is this batch alone — publishing it would
    // claim a 30-entry record had shrunk to 3.
    const track   = persisted ? buildTrackRecord(updatedHistory) : null;
    const sorted  = [...outcomes].sort((a, b) => (b.outcome_pct ?? 0) - (a.outcome_pct ?? 0));
    const best    = sorted[0]    ?? null;
    const worst   = sorted[sorted.length - 1] ?? null;

    return Response.json({
      tool:      "picks-check",
      checked:   outcomes.length,
      track_record: track,
      best_pick: best  ? { symbol: best.symbol,  outcome_pct: best.outcome_pct,  outcome: best.outcome  } : null,
      worst_pick: worst ? { symbol: worst.symbol, outcome_pct: worst.outcome_pct, outcome: worst.outcome } : null,
      recent_picks: outcomes.map((o) => ({
        symbol:      o.symbol,
        outcome:     o.outcome,
        outcome_pct: o.outcome_pct,
        signal_ts:   o.signal_ts,
      })),
      // On a skipped append the due picks were NOT cleared, so they are still
      // pending. Reporting stillPending.length here would under-count them.
      pending_remaining: persisted ? stillPending.length : pending.length,
      persisted,
      ...(persisted ? {} : { code: "kv_unavailable", note: "Outcomes were computed but NOT saved — these picks stay queued and will be re-checked." }),
      dataSource:    "GeckoTerminal (current price lookup)",
      disclaimer:    "Tracks signal filter accuracy, not investment returns. Price changes measured after detection. Not financial advice.",
      framing_note:  "WIN/LOSS measures whether the filter's signal direction was correct after 22h, not trading profit.",
      timestamp:     new Date().toISOString(),
    });
  } catch (e) {
    return Response.json(
      { error: "picks-check failed", message: (e as Error).message },
      { status: 500 }
    );
  }
}
