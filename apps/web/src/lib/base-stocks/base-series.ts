/**
 * Base desk — PERMANENT price history.
 *
 * ## Why this file exists
 *
 * Until now the Base desk wrote exactly one key, `bh:base:rows:latest`, with a
 * 15-minute TTL. Three poll cycles and the evidence was gone. That means the
 * Base desk could never answer the one question that decides whether it is a
 * product at all: **does Base drift ever reach the firing threshold?**
 *
 * Measured 2026-08-28 (premarket snapshot, one cycle): max |drift| across all
 * four B20 stocks was 0.31% against `DRIFT_MIN_ABS_PCT = 2.0` — 6.5x short. So
 * the current read is "Base pools are efficient, there is no bug". But that is
 * ONE cycle, in premarket, and a single observation is an anecdote. The honest
 * version of that claim needs a distribution, and a distribution needs history.
 *
 * The RH archive already taught this lesson the expensive way: 107 of 112
 * published RH drift arrows predate `SERIES_ARCHIVE_START` and are therefore
 * permanently unauditable. Base is at the start of that same curve right now.
 * Every hour not persisted today is an hour that cannot be recovered later —
 * history, unlike code, cannot be backfilled.
 *
 * ## The invariant this file must not break
 *
 * The RH archive `bh:series:day:*` is keyed by BARE TICKER, and
 * NVDA/META/GOOGL/AAPL trade on BOTH chains. A single Base row landing there
 * corrupts RH price history irreversibly. `poll/route.ts` documents this as a
 * load-bearing invariant and `BaseDeskLatest` is deliberately shaped so
 * `persistSeriesPoint(baseLatest)` does not compile.
 *
 * This file preserves that with two guards, one enforced and one structural:
 *
 *  1. TYPE (enforced by tsc). `BaseSeriesDay` carries `chain: "base"` and
 *     `SeriesDay` carries `chain?: "robinhood"`, so a Base record is not
 *     assignable where an RH one is expected, and the two persist functions
 *     take different arguments entirely. Verified by compiling the bad
 *     assignment and confirming TS2322 — not assumed. Note this guard did NOT
 *     exist until the discriminator was added: `{day, v, points}` is a subset
 *     of `BaseSeriesDay`, so before that, assigning one to the other compiled
 *     silently.
 *
 *  2. KEY (structural, NOT enforced). This file builds keys only via
 *     `kvBaseSeriesDay`; the RH key builder is not imported here at all. That
 *     is a real guarantee but tsc cannot check it, because `kvSet(key: string,
 *     value: unknown)` accepts any value at any key — the KV boundary is
 *     untyped by design. So "write the Base record to the RH key" stays
 *     expressible; what prevents it is that the RH builder is not in scope.
 *
 *     That guarantee is asserted mechanically by group 10 of
 *     `scripts/base-series-merge-check.ts`, which strips comments from this
 *     file and fails if the RH builder appears in the remaining code. It has
 *     to strip comments because this very paragraph names the builder — a
 *     naive grep reports a false positive on the prose above.
 *
 * ## Two resolutions, on purpose
 *
 * `points` is hourly, mirroring the RH archive so one reader can walk both.
 * `peaks` is per-CYCLE. The rule engine evaluates `detectCandidate` against
 * `DRIFT_MIN_ABS_PCT` every 5 minutes, so an hourly-only series would
 * under-sample exactly the tail that decides firing: a 40-minute excursion
 * above threshold would leave no trace, and we would "measure" that Base never
 * approaches 2% when in fact we never looked. Measuring at a coarser
 * resolution than the decision is how a sampling artifact becomes a finding.
 */
import { kvGetProbe, kvSet } from "@/lib/kv";
import {
  kvBaseSeriesDay,
  yyyymmdd,
  yyyymmddhh,
} from "@/lib/blue-hood/kv-keys";
import type {
  BaseSeriesDay,
  BaseSeriesPeak,
  SeriesPoint,
  SeriesRow,
  TickerSnapshot,
} from "@/lib/blue-hood/types";

/** Schema version for `BaseSeriesDay`. Independent of the RH `SERIES_VERSION`
 *  — the two records evolve separately. */
export const BASE_SERIES_VERSION = 1;

/**
 * Did this row observe a price at all?
 *
 * A row that failed to price is ABSENT from the record, never
 * present-with-nulls. A null row would read as "the market had no price here",
 * which is a claim; absence is the honest record of "we did not observe one".
 *
 * One definition, used both to build the record and to decide whether to open
 * the read-modify-write at all. If those two ever disagree, the cheap pre-check
 * starts skipping cycles the merge would have recorded — a silent data loss in
 * a permanent archive, which is the one failure here that cannot be repaired.
 */
const isPriced = (t: TickerSnapshot): boolean =>
  t.oracle_usd !== null || t.dex_usd !== null;

/**
 * Fold one poll cycle's Base rows into the day record.
 *
 * Pure and exported so it can be tested directly rather than through a
 * reimplementation — a test of a copy proves nothing about what ships.
 *
 * Returns `null` when there is nothing to write, which is the common case:
 * most cycles are neither a new hour nor a new high-water mark. That null is
 * what keeps the KV write budget near the hourly rate instead of the 5-minute
 * rate.
 */
export function mergeBaseSeriesPoint(
  existing: BaseSeriesDay | null,
  rows: TickerSnapshot[],
  startedAt: string,
): BaseSeriesDay | null {
  const at   = new Date(startedAt);
  const day  = yyyymmdd(at);
  const hour = yyyymmddhh(at);

  const priced = rows.filter(isPriced);
  if (priced.length === 0) return null;

  const prevPoints = existing?.points ?? [];
  const prevPeaks  = existing?.peaks  ?? [];
  const isNewHour  = !prevPoints.some((p) => p.hour === hour);

  // ── Hourly point (only on the first cycle that lands in a fresh hour) ────
  let points = prevPoints;
  if (isNewHour) {
    const seriesRows: SeriesRow[] = priced.map((t) => ({
      ticker:        t.ticker,
      oracle_usd:    t.oracle_usd,
      dex_usd:       t.dex_usd,
      drift_pct:     t.drift_pct,
      total_tvl_usd: t.total_tvl_usd ?? t.tvl_usd,
    }));
    const point: SeriesPoint = {
      hour,
      at:      startedAt,
      // Market clock is read off the rows rather than re-derived from the
      // timestamp: re-deriving silently gets holidays and half-days wrong, and
      // this record outlives the calendar logic that would do the deriving.
      is_open: priced[0].market.is_open,
      session: priced[0].market.session,
      rows:    seriesRows,
    };
    // Sorted, not pushed: a retried or late cycle must not leave the day out of
    // chronological order for whoever reads it a year from now.
    points = [...prevPoints, point].sort((a, b) => a.hour.localeCompare(b.hour));
  }

  // ── Per-cycle |drift| high-water marks ──────────────────────────────────
  const peakByTicker = new Map<string, BaseSeriesPeak>(
    prevPeaks.map((p) => [p.ticker, p]),
  );
  let peaksMoved = false;
  for (const t of priced) {
    if (t.drift_pct === null) continue;
    const abs  = Math.abs(t.drift_pct);
    const prev = peakByTicker.get(t.ticker);
    // Strictly greater: an equal value is not new information, and writing on
    // ties would turn a flat series into a write on every single cycle.
    if (prev && abs <= prev.abs_drift_pct) continue;
    peakByTicker.set(t.ticker, {
      ticker:        t.ticker,
      abs_drift_pct: +abs.toFixed(4),
      drift_pct:     t.drift_pct,
      at:            startedAt,
      is_open:       t.market.is_open,
      session:       t.market.session,
    });
    peaksMoved = true;
  }

  // Nothing new to record. Returning null here is the whole cost story: on a
  // quiet day this is ~283 of 288 cycles.
  if (!isNewHour && !peaksMoved) return null;

  return {
    day,
    v:      BASE_SERIES_VERSION,
    chain:  "base",
    points,
    peaks:  [...peakByTicker.values()].sort((a, b) => a.ticker.localeCompare(b.ticker)),
    // Counts cycles that CONTRIBUTED, i.e. cycles we actually wrote for. It is
    // a floor on observation count, not the true cycle count, because a cycle
    // that moved nothing is not recorded. Named `cycles` and documented here so
    // nobody later divides by it thinking it is the denominator of all polls.
    cycles: (existing?.cycles ?? 0) + 1,
  };
}

/**
 * Append this cycle to the permanent Base series.
 *
 * The load-bearing choice is `kvGetProbe`, not `kvGet`. `kvGet` swallows the
 * error and returns null, which is indistinguishable from "no data yet" — so a
 * single KV blip at 23:00 would merge onto an empty day and write ONE point
 * over twenty-three real ones. That is the one failure this feature cannot
 * tolerate, because an overwritten hour cannot be recreated. On `error` we
 * write nothing and lose at most one cycle, which the next cycle refills.
 *
 * This is the same `kvGet` → `kvGetProbe` correction being applied repo-wide in
 * task #150; new code should not reintroduce the bug it is closing.
 *
 * Never throws. The caller runs inside the Base try/catch whose contract is
 * "a Base-side failure degrades to RH-only" — the RH board is the heartbeat and
 * must not depend on anything Base does.
 */
export async function persistBaseSeriesPoint(
  rows: TickerSnapshot[],
  startedAt: string,
): Promise<void> {
  // Nothing priced ⟹ the merge would return null anyway, so skip the read
  // rather than spend a KV request to confirm it. This is not hypothetical: in
  // task #140 the whole Base desk went dark (dexPrice silently nulling), which
  // is precisely the state that would otherwise burn 288 reads/day producing
  // nothing — against the Upstash cap that has now suspended this engine three
  // times (#148, #123).
  if (!rows.some(isPriced)) return;

  const day = yyyymmdd(new Date(startedAt));

  const probe = await kvGetProbe<BaseSeriesDay>(kvBaseSeriesDay(day));
  if (probe.status === "error") {
    console.error(
      `[base-series] read failed day=${day}: ${probe.message} — skipping write so a live day is never clobbered`,
    );
    return;
  }

  const next = mergeBaseSeriesPoint(
    probe.status === "hit" ? probe.value : null,
    rows,
    startedAt,
  );
  if (next === null) return; // nothing new this cycle

  // NO TTL, deliberately — see `kvBaseSeriesDay` in kv-keys.ts.
  await kvSet(kvBaseSeriesDay(day), next);

  const hour   = yyyymmddhh(new Date(startedAt));
  const added  = next.points.find((p) => p.hour === hour);
  const topPk  = [...next.peaks].sort((a, b) => b.abs_drift_pct - a.abs_drift_pct)[0];
  console.log(
    `[base-series] day=${day} hour=${hour} rows=${added?.rows.length ?? 0}` +
      ` points=${next.points.length} cycles=${next.cycles}` +
      ` peak=${topPk ? `${topPk.ticker} ${topPk.abs_drift_pct}%` : "—"}`,
  );
}
