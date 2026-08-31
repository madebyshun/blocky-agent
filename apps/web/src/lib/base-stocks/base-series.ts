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
 *
 * ## Why a drift number alone is not evidence (v2)
 *
 * A recorded `drift_pct` does not say whether the oracle was LIVE when it was
 * measured, and on Base that is not a detail — it decides what the number means:
 *
 *   • The Chainlink B20 feed only republishes on a **0.5% deviation** (or a 24h
 *     heartbeat). Every Base drift observed so far — 0.094%, 0.31%, 0.3782% —
 *     is BELOW that step. Those readings are indistinguishable from the feed
 *     simply not having moved yet. They are quantisation, not dislocation, and
 *     a distribution built from them would be a picture of the deadband.
 *   • During a corporate action the feed freezes while the token keeps trading:
 *     the B20 spec pauses mint/redeem OFF-chain and explicitly does not pause
 *     transfers. So `isPaused(TRANSFER)` stays false throughout, and `is_stale`
 *     only trips after 2 x 24h — a freeze shorter than that is invisible to
 *     both existing gates and shows up as pure drift.
 *   • The feed is **24/5**, not tied to the NYSE session. Measured 2026-08-28:
 *     the four B20 feeds last updated at 00:10, 05:55, 08:07 and 08:43 UTC —
 *     after-hours, overnight and premarket respectively, every one of them
 *     outside regular hours. This matters because `base-poller.ts` reuses the
 *     RH verdict map verbatim, including the names FROZEN_ALIGNED and
 *     PREMARKET_DRIFT, which encode "closed ⟹ the oracle is frozen". That
 *     premise holds on RH and does NOT hold here.
 *
 * `oracle_updated_at` is what separates those cases, and it can only be
 * recorded AT POLL TIME. There is no later query that recovers the round a past
 * cycle read — which is the same asymmetry that motivates this whole file.
 */
import { kvGetProbe, kvSet } from "@/lib/kv";
import {
  BASE_SERIES_ARCHIVE_START,
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

/**
 * Schema version for `BaseSeriesDay`. Independent of the RH `SERIES_VERSION` —
 * the two records evolve separately.
 *
 *   v1 (2026-08-28, ~09:00–14:00Z) — points + peaks, no oracle timestamp.
 *   v2 (2026-08-28, ~14:00–15:00Z) — adds `oracle_updated_at` to both.
 *
 * ⚠️ `v` DATES THE WRITER, NOT THE ITEMS, and the difference is not academic.
 * `mergeBaseSeriesPoint` re-stamps the whole day on every write while carrying
 * already-written points and peaks forward untouched, so a `v: 2` day can — and
 * on the archive's first day does — hold v1-vintage items. Measured on prod for
 * 20260828: the day is stamped `v: 2`, its hour-15 and hour-16 points carry
 * `oracle_updated_at` 4/4, and its hours 09–14 points plus ALL FOUR peaks carry
 * no such key at all.
 *
 * An earlier revision of this comment claimed the bump was what made a missing
 * field readable — "a v1 point is one we could not date, a v2 point with `null`
 * is one we tried to date and failed". That distinction is real and it is the
 * whole point; `v` is simply not what carries it, because `v` is per-day and
 * vintage is per-item. A reader who trusts that claim gets 20260828 exactly
 * backwards: it would conclude every item there was date-attempted, when ten of
 * the fourteen predate the field entirely.
 *
 * What actually carries it is the FIELD'S OWN THREE STATES, read per item —
 * absent ⟹ predates the field, `null` ⟹ read the feed and could not date it,
 * number ⟹ dated. {@link oracleDating} is the single place that reads them.
 * Derive vintage from the item, never from `v`.
 *
 * Peaks are what make this durable rather than transient. A peak is a
 * strict-greater high-water mark (see the `<=` continue below), so one set
 * under v1 is rewritten only if it is EXCEEDED; on a calm day it keeps its v1
 * shape until the day rolls over. The blast radius is bounded — `kvBaseSeriesDay`
 * is per-day and `prevPeaks` never crosses midnight, so every item of every
 * later day is written by the current writer — but inside the crossover day it
 * is permanent, and no backfill can repair it without inventing the timestamps.
 */
export const BASE_SERIES_VERSION = 2;

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
      // `?? null`, never omitted. The Base desk records this field, so a row
      // that reaches here without one is "the feed could not be dated", which
      // must not be written as `undefined` — that is reserved for archives that
      // never had the field at all.
      oracle_updated_at: t.oracle_updated_at ?? null,
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
      // Taken from the cycle that SET the mark, like every other field here. A
      // peak carrying a later cycle's oracle timestamp would date the drift to
      // an oracle it was never measured against.
      oracle_updated_at: t.oracle_updated_at ?? null,
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

// ─────────────────────────────────────────────────────────────────────────────
// READ SIDE
//
// Lives here, not in the route, so the route never builds a KV key. That keeps
// the structural guard from the header intact by construction: `kvBaseSeriesDay`
// stays confined to this one file, and adding a Base read path did not widen the
// blast radius for the RH archive.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Which of `oracle_updated_at`'s three states one archived item is in.
 *
 * `SeriesRow.oracle_updated_at` documents the three; this is the one place that
 * READS them, so no consumer re-derives the rule and none can get it subtly
 * wrong. Exported because the distinction is the archive's, not the route's: a
 * peak of 0.56% measured against a live feed and the same 0.56% measured
 * against a feed frozen for a corporate action are opposite findings wearing
 * one number, and `abs_drift_pct` alone cannot tell them apart.
 *
 * ⚠️ Do NOT derive this from the day's `v` — see {@link BASE_SERIES_VERSION}.
 * `v` is per-day, vintage is per-item, and on 20260828 the two disagree.
 */
export type OracleDating =
  /** `oracle_updated_at` holds the Chainlink round the price was measured against. */
  | "dated"
  /** Base read the feed this cycle and could not date it. A recorded failure — we looked. */
  | "undatable"
  /** Written before the field existed. We never looked, which is NOT "looked and found nothing". */
  | "predates_field";

/**
 * Read one item's dating state.
 *
 * Note the argument is structural, not `BaseSeriesPeak | SeriesRow`: both carry
 * `oracle_updated_at?: number | null` and nothing else here is needed, so this
 * also accepts a future record that adds the field without this function having
 * to learn about it.
 */
export function oracleDating(item: { oracle_updated_at?: number | null }): OracleDating {
  // `undefined` FIRST and separately. Folding it in with `null` — the tempting
  // `?? null` one-liner — is precisely the "we never looked" ⟹ "we looked and
  // found nothing" collapse that `SeriesRow.oracle_updated_at`'s doc forbids,
  // and it would silently relabel every v1 item as a dating failure.
  if (item.oracle_updated_at === undefined) return "predates_field";
  return item.oracle_updated_at === null ? "undatable" : "dated";
}

/** Tally of {@link oracleDating} across a set of items. */
export interface OracleDatingCounts {
  dated: number;
  undatable: number;
  predates_field: number;
}

/**
 * Count dating states over peaks or point-rows.
 *
 * Ships alongside every drift figure this archive publishes. A max peak is only
 * evidence about Base if the oracle behind it was live, and the caller cannot
 * establish that from the number — so the number does not travel alone.
 */
export function datingCounts(
  items: Array<{ oracle_updated_at?: number | null }>,
): OracleDatingCounts {
  const counts: OracleDatingCounts = { dated: 0, undatable: 0, predates_field: 0 };
  for (const item of items) counts[oracleDating(item)]++;
  return counts;
}

// ─────────────────────────────────────────────────────────────────────────────
// ORACLE AGE — and why subtracting two timestamps is not safe here (#160)
//
// A round in this archive can be dated AFTER the cycle that recorded it.
// Measured on production 2026-08-28, two independent samples:
//
//   archive, hour-15 point (at=15:00:44.687Z)
//     GOOGL round 15:04:19Z  →  215s AFTER the point that recorded it
//   live snapshot (base_desk.started_at=15:55:27.454Z)
//     NVDA  round 15:57:35Z  →  -128s   FUTURE-DATED
//     GOOGL round 15:59:21Z  →  -234s   FUTURE-DATED
//     META  round 15:51:43Z  →   224s   past
//     AAPL  round 15:30:51Z  →  1476s   past
//
// Two of four rows at one instant, and GOOGL ahead on both samples. Systematic.
//
// The likely cause is benign and is NOT a bad feed: `cron/blue-hood/poll` anchors
// the Base `polled_at_ms` to the same cycle start the RH poller used, so that
// "freshness maths line up across both desks". Base is polled at step 1b, after
// the entire RH desk. A round printed while the cycle was still working through
// RH is legitimately newer than the anchor. It is an artifact of WHICH instant we
// chose to call "now", not evidence about Chainlink.
//
// That makes it harmless to the board — `oracleRoundAgeText` measures against
// `Date.now()` at RENDER time, always later than the cycle start — and dangerous
// to the archive, where `at` IS the cycle start. A naive `at - oracle_updated_at`
// gives NEGATIVE ages on a meaningful fraction of rows, and any distribution
// built from them grows a left tail that is pure bookkeeping.
//
// So: clamp. But a bare `Math.max(0, …)` is its own small lie — it turns "this
// round is 234s in the FUTURE" into "this round is 0s old", which reads as a
// freshness claim, and it destroys the count that says whether the anchor
// artifact is getting worse. The clamp therefore reports that it clamped.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One item's oracle age relative to the cycle anchor that recorded it.
 *
 * Three outcomes, kept apart for the usual reason: an absent number has more
 * than one cause and they are not interchangeable.
 *   • `measured`   — we have both an anchor and a round.
 *   • `not_dated`  — no round to age. Carries {@link OracleDating} so the caller
 *                    still knows whether we looked and failed (`undatable`) or
 *                    never looked (`predates_field`).
 *   • `no_anchor`  — the ARCHIVE record is unparseable. Our bookkeeping is
 *                    broken; this says nothing about the feed, and folding it in
 *                    with `not_dated` would blame the oracle for our own bug.
 */
export type OracleAgeReading =
  | {
      state: "measured";
      /**
       * Seconds from the round to the anchor, clamped to `>= 0`. Safe to
       * histogram. When `future_dated`, this is a FLOOR, not a measurement.
       */
      age_s: number;
      /** The round was dated after the anchor — the clamp did work here. */
      future_dated: boolean;
      /** How far past the anchor the round was. `0` unless `future_dated`. */
      ahead_s: number;
    }
  | { state: "not_dated"; dating: Exclude<OracleDating, "dated"> }
  | { state: "no_anchor"; anchor: string };

/**
 * Age one archived item against its own cycle anchor.
 *
 * `anchorIso` is the archive's own `at` — pass `point.at` for a point row and
 * `peak.at` for a peak. Taking the ISO string rather than a number is deliberate:
 * `oracle_updated_at` is unix SECONDS and `at` is an ISO instant, so any numeric
 * parameter here invites a seconds/milliseconds mixup that would scale every age
 * by 1000 and still look plausible in a histogram. Passing the field verbatim
 * removes the conversion from the call site entirely.
 *
 * ⚠️ Never build an "older than N ⟹ the feed is frozen" rule on this number. The
 * B20 feeds sit behind a 0.5% deviation deadband, so a live-but-quiet feed looks
 * arbitrarily stale: on 2026-08-28 AAPL's round was 1476s old — and 1942s on a
 * later sample — during an OPEN regular session, with nothing wrong. See the
 * note in `blue-hood/oracle-age.ts` for the same argument stated before there
 * was production data to back it; this is that data.
 */
export function oracleAgeAtAnchor(
  item: { oracle_updated_at?: number | null },
  anchorIso: string,
): OracleAgeReading {
  const dating = oracleDating(item);
  if (dating !== "dated") return { state: "not_dated", dating };

  const anchorMs = Date.parse(anchorIso);
  if (!Number.isFinite(anchorMs)) return { state: "no_anchor", anchor: anchorIso };

  // `as number` is safe: "dated" is exactly the case where the field is a
  // number, and `oracleDating` is the single place that decides that.
  const round = item.oracle_updated_at as number;
  const delta = Math.round(anchorMs / 1000 - round);
  return delta >= 0
    ? { state: "measured", age_s: delta, future_dated: false, ahead_s: 0 }
    : { state: "measured", age_s: 0, future_dated: true, ahead_s: -delta };
}

/**
 * Tally of {@link oracleAgeAtAnchor} over a set of readings.
 *
 * Ships with any age distribution the way {@link datingCounts} ships with any
 * drift figure: the histogram alone cannot tell you how much of itself is real.
 */
export interface OracleAgeSpread {
  /** Readings that produced a number. The denominator for `ages_s`. */
  measured: number;
  /** How many of those needed the clamp — i.e. how big the artifact is. */
  future_dated: number;
  /**
   * Worst future-dating seen, in seconds. `0` when none. This is the number to
   * watch: ~200s is the polling-order artifact described above, but a value in
   * the hours would be a different and non-benign finding.
   */
  max_ahead_s: number;
  /** Items with no round to age. */
  not_dated: number;
  /** Items whose archive anchor would not parse — our bug, not the feed's. */
  no_anchor: number;
  /**
   * Clamped ages, ascending. Future-dated rows ARE included, as zeros, because
   * dropping them would bias the distribution toward stale just as surely as
   * keeping them negative biased it toward fresh. A spike at exactly `0` is
   * therefore the clamp, not the feed — read it against `future_dated`.
   */
  ages_s: number[];
}

/** Fold readings into an {@link OracleAgeSpread}. */
export function oracleAgeSpread(readings: OracleAgeReading[]): OracleAgeSpread {
  const spread: OracleAgeSpread = {
    measured: 0, future_dated: 0, max_ahead_s: 0,
    not_dated: 0, no_anchor: 0, ages_s: [],
  };
  for (const r of readings) {
    switch (r.state) {
      case "not_dated": spread.not_dated++; break;
      case "no_anchor": spread.no_anchor++; break;
      case "measured":
        spread.measured++;
        spread.ages_s.push(r.age_s);
        if (r.future_dated) {
          spread.future_dated++;
          spread.max_ahead_s = Math.max(spread.max_ahead_s, r.ahead_s);
        }
        break;
    }
  }
  spread.ages_s.sort((a, b) => a - b);
  return spread;
}

/** One day's read outcome, kept distinct all the way to the caller. Mirrors the
 *  RH `SeriesDayRead` on purpose — same four states, so a reader that already
 *  understands the RH archive needs no new vocabulary for this one. */
export type BaseSeriesDayRead =
  | { day: string; status: "hit"; value: BaseSeriesDay }
  | { day: string; status: "miss" }
  | { day: string; status: "error"; message: string }
  | { day: string; status: "before_archive" };

/**
 * Read a set of days, reporting each outcome separately.
 *
 * `kvGetProbe`, not `kvGet`, for the same reason the writer uses it: `kvGet`
 * turns a KV outage into `null`, and this route would then publish "that day
 * holds nothing" about a day it simply could not read. In an archive whose only
 * job is to be evidence, serving a blackout as an empty market is the worst
 * available failure.
 *
 * Days before the archive began cost no KV request — the answer is known
 * without asking, and the Upstash request cap has starved this engine three
 * times (#148, #123).
 */
export async function readBaseSeriesDays(days: string[]): Promise<BaseSeriesDayRead[]> {
  return Promise.all(
    days.map(async (day): Promise<BaseSeriesDayRead> => {
      if (day < BASE_SERIES_ARCHIVE_START) return { day, status: "before_archive" };
      const probe = await kvGetProbe<BaseSeriesDay>(kvBaseSeriesDay(day));
      if (probe.status === "error") return { day, status: "error", message: probe.message };
      if (probe.status === "miss") return { day, status: "miss" };
      return { day, status: "hit", value: probe.value };
    }),
  );
}

/** How much of a day is on record, and against what window that was judged. */
export interface BaseSeriesCoverage {
  hours_present: number;
  /** Hours inside the expected window holding no point, as `YYYYMMDDHH`. */
  hours_absent: string[];
  first_hour: string | null;
  last_hour: string | null;
  expected_from: string | null;
  expected_to: string | null;
}

/**
 * Which hours of a Base day were missed.
 *
 * ## Why this is not `seriesCoverage` from poller.ts
 *
 * That function is the RH twin and computes the identical thing — but it reads
 * `SERIES_ARCHIVE_START` ("20260810") from its own module scope. Handed a Base
 * day it would use the RH start date to decide the lower bound, and on the Base
 * archive's FIRST day that is not a cosmetic difference: recording began mid-
 * morning on 2026-08-28, so the RH-anchored version would compute `from = 0`
 * and report hours 00–08 as absent — nine hours of gap that never existed,
 * published as fact on the archive's first and most-scrutinised day.
 *
 * Reuse would have been the tidier-looking choice and a wrong one. The shared
 * shape is a coincidence of both archives being hourly; the anchor is genuinely
 * per-archive. Two dates, two functions.
 *
 * Everything else matches the RH semantics deliberately: the future (including
 * the hour now running) is never a hole, because the poll appends partway
 * through an hour and calling the current hour overdue would manufacture a gap
 * for part of every hour and train readers to ignore the field.
 *
 * `now` is a parameter, not `new Date()`, so this is testable at any wall clock.
 */
export function baseSeriesCoverage(
  day: string,
  points: SeriesPoint[],
  now: Date,
): BaseSeriesCoverage {
  const hours = points.map((p) => p.hour).sort();
  const first = hours[0] ?? null;
  const last  = hours[hours.length - 1] ?? null;

  // Upper bound: the last hour that has finished. A past day is owed all 24.
  const to = day === yyyymmdd(now) ? now.getUTCHours() - 1 : 23;
  // Lower bound: 0 for any day the archive covered in full; on its first day,
  // the earliest hour actually held — nothing before that was ever promised.
  // `24` when that first day holds nothing, which crosses the bounds below and
  // correctly claims no window at all.
  const from =
    day === BASE_SERIES_ARCHIVE_START ? (first === null ? 24 : +first.slice(8, 10)) : 0;

  if (from > to || to < 0) {
    return {
      hours_present: points.length,
      hours_absent: [],
      first_hour: first,
      last_hour: last,
      expected_from: null,
      expected_to: null,
    };
  }

  const present = new Set(hours);
  const absent: string[] = [];
  for (let h = from; h <= to; h++) {
    const key = `${day}${String(h).padStart(2, "0")}`;
    if (!present.has(key)) absent.push(key);
  }

  return {
    hours_present: points.length,
    hours_absent: absent,
    first_hour: first,
    last_hour: last,
    expected_from: `${day}${String(from).padStart(2, "0")}`,
    expected_to: `${day}${String(to).padStart(2, "0")}`,
  };
}

/** The two kinds of hole a window of days can hold. Both ascending. */
export interface ArchiveHoles {
  /**
   * Days holding no record that sit BETWEEN two days that do.
   *
   * Leading and trailing misses are excluded DELIBERATELY. A 14-day window over
   * a 2-day-old archive would otherwise report twelve days of "gap" for days
   * nothing was alive to record, and an alarm on the expected is how a real one
   * gets ignored.
   */
  missing_days: string[];
  /** Finished hours inside a readable day that hold no point, `YYYYMMDDHH`. */
  absent_hours: string[];
}

/**
 * Where a window of archive reads has holes.
 *
 * ## Why this is one function and not two copies
 *
 * It WAS two. `/api/hood/base-series` derived `contiguous` and
 * `gaps:{days,hours}` inline; `classifyArchive` in `archive-watch.ts` decided
 * whether to page the operator from its own copy. Same rule, two texts — and
 * they had already drifted in the way that is invisible until it is not:
 *
 *   the route's copy indexed `hitDays[0]` and `hitDays[len-1]` on an UNSORTED
 *   array. That was correct only because `readBaseSeriesDays` is
 *   `Promise.all(days.map(…))`, `Promise.all` resolves IN INPUT ORDER, and the
 *   route happens to build `requested` ascending. Three facts, three files, none
 *   of them stated where the indexing happened.
 *
 * Break any one of the three — resolve in completion order, accept a `from`
 * later than `to`, feed it a `Set` — and the interior window becomes the wrong
 * window: `hitDays[0]` is then whichever day answered first, interior misses
 * fall outside the bounds, and the route publishes a holed archive as
 * `contiguous: true`. On THIS dataset that is the worst available failure and
 * the one the route refuses everywhere else — #152 reads these fields as
 * evidence for the chain question, and a false "complete" biases its answer
 * toward "Base is quiet" when the truth is "we stopped looking".
 *
 * Sorting inside removes the dependency on all three: the bounds are ascending
 * BY CONSTRUCTION rather than by luck, in the one place the rule is written.
 *
 * `before_archive` days need no filtering here — that status is never `hit` and
 * never `miss`, so it cannot reach either branch.
 */
export function archiveHoles(reads: BaseSeriesDayRead[], now: Date): ArchiveHoles {
  const hits = reads.flatMap((r) => (r.status === "hit" ? [r] : []));
  const hitDays = hits.map((r) => r.day).sort();

  const absent_hours = hits
    .flatMap((r) => baseSeriesCoverage(r.day, r.value.points, now).hours_absent)
    .sort();

  // No hit anywhere means no interior to be inside of. Not "no gaps" as a
  // finding — there is simply no pair of dated ends to bracket anything, and
  // inventing one from the requested range would report every unrecorded day of
  // a dead archive as a gap.
  const missing_days =
    hitDays.length === 0
      ? []
      : reads
          .filter(
            (r) => r.status === "miss" && r.day > hitDays[0] && r.day < hitDays[hitDays.length - 1],
          )
          .map((r) => r.day)
          .sort();

  return { missing_days, absent_hours };
}
