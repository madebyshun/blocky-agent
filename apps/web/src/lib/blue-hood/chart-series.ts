/**
 * Blue Hood — turning the archive into something drawable, without lying.
 *
 * WHY THIS IS ITS OWN MODULE
 * --------------------------
 * Same reason as `detail-support.ts` and `oracle-age.ts`: the chart renders
 * inside a `"use client"` React tree that no plain tsx script can import, so a
 * rule living inline there is enforced only by whoever reads the diff. Split
 * out, this is dependency-free and `scripts/hood-chart-check.ts` exercises it
 * directly — including the case that matters most, which is a chart drawn over
 * a hole.
 *
 * WHAT THE CHART IS ALLOWED TO PLOT
 * ---------------------------------
 * The KV series archive, and nothing else. NOT GeckoTerminal OHLCV, not a
 * re-fetch of the current DEX price, not a candle feed. The desk grades its
 * signals against the archive, so a chart sourced anywhere else can disagree
 * with the receipt printed beside it — and a chart that contradicts its own
 * receipt is worse than no chart, because it discredits the receipt too.
 *
 * That constraint also happens to be what keeps the anchored-quote fix (#435)
 * applied here for free. The archive's `dex_usd` comes from
 * `readBaseStockQuote` → `dexPrice`, which since #435 refuses any pool whose
 * counter-asset is not USD-anchored. A chart that re-fetched its own prices
 * would be re-opening exactly that hole: the TSLAc/STC pool priced TSLAc at
 * $15,424 against a $354 oracle, and it was the DEEPER pool on the day before
 * admission, so "pick the deepest" is not a safe shortcut even once.
 *
 * MEASURED BEFORE BUILDING (production archive, 2026-09-09, 13 days):
 *   • 1,169 of 1,177 archived rows carry both an oracle and a DEX price, and
 *     EVERY ONE of them sits in dex/oracle ∈ [0.9940, 1.0121]. So the ~11 days
 *     written before #435 landed contain no unanchored-pool contamination, and
 *     this chart needs no "pre-fix" caveat band. TSLA was the 39.5× case, and
 *     it was not on the desk for any of those 13 days — so the pre-#435 code
 *     never wrote a TSLA row. It was admitted 2026-09-09 (#436), i.e. AFTER the
 *     anchored-quote fix, so every TSLA row in the archive is anchored from the
 *     first one. State it that way rather than "TSLA was never on the desk":
 *     that sentence was true when written and stopped being true the same day.
 *   • |drift| max = 0.81%, p50 = 0.17%, and 92.4% of all 1,026 graded rows are
 *     BELOW 0.5%. Nothing has ever crossed even the 1% open-market arb line.
 *     This is why {@link DEADBAND_ABS_PCT} is not decoration — see its header.
 *
 * THE FAILURE THIS MODULE EXISTS TO PREVENT
 * -----------------------------------------
 * `seriesCoverage` in `poller.ts` already wrote the warning, before any chart
 * existed: "A consumer that plots `points` without asking will connect 03:00
 * straight to 09:00 and draw a confident line through six hours." That is the
 * whole bug. An hour missing from `points` is any of several unrelated events,
 * and the archive deliberately does not pretend to know which — so the chart
 * may not either. Hence {@link ChartGapReason}: five kinds of nothing, kept
 * apart all the way to the pixels, and a renderer that draws one polyline PER
 * RUN instead of one polyline through everything.
 */
import type { HoodChain, SeriesPoint } from "./types";
import { oracleDating, type OracleDating } from "@/lib/base-stocks/base-series";

/**
 * The Chainlink B20 deviation threshold, in absolute percent.
 *
 * The feed only republishes when the underlying moves 0.5% (or on its 24h
 * heartbeat). So every drift reading BELOW this number is the oracle not having
 * stepped yet — quantisation — and not the DEX disagreeing with the oracle. The
 * two are opposite findings and the number alone cannot tell them apart.
 *
 * THIS IS WHY THE CHART DRAWS IT. On the production archive 92.4% of all graded
 * rows (948 of 1,026) fall inside this band, and the largest drift ever recorded
 * on the Base desk is 0.81% — still inside a single deviation step. A drift
 * chart without this floor renders a wiggly, busy-looking line and invites the
 * reader to interpret nearly all of it as signal, when nearly all of it is the
 * feed's own resolution. The band is the difference between the chart telling
 * the truth and the chart flattering it.
 *
 * Deliberately NOT reused from `DRIFT_MIN_ABS_PCT` (2.0) or `ARB_MIN_ABS_PCT`
 * (1.0) in `types.ts`. Those are FIRING thresholds — what the engine acts on.
 * This is a MEASUREMENT floor — what the instrument can resolve. They answer
 * different questions and a future tuning of either must not silently drag the
 * other, which is exactly what sharing one constant would do.
 *
 * Documented in `base-series.ts`'s `oracle_updated_at` header since the archive
 * was built; this is the first place it becomes a number the code uses.
 */
export const DEADBAND_ABS_PCT = 0.5;

/**
 * Why the line stops.
 *
 * Five kinds of nothing, and collapsing any two of them would re-create the
 * unknown-vs-known-empty error the archive is built to avoid. In particular
 * `unreadable` is NOT `hour_absent`: one says the desk has no record, the other
 * says we could not find out. A chart that renders them identically tells the
 * reader that a KV outage and a quiet market look the same, which is the read
 * path's version of the bug `readSeriesDays` refuses in the fetch path.
 */
export type ChartGapReason =
  /** KV could not be read. The archive's contents here are UNKNOWN — this is
   *  emphatically not "nothing happened". */
  | "unreadable"
  /** The day is inside the archive window but holds no record at all. */
  | "missing_day"
  /** Earlier than the archive's first day. No backfill exists or ever will. */
  | "before_archive"
  /** The day is on record and this hour is not. `seriesCoverage` computes it
   *  against a real expected window, so this already excludes hours that were
   *  never expected (before the archive started, or later than now). */
  | "hour_absent"
  /** The hour IS on record, and this ticker is absent from it. A row that
   *  failed to price is omitted rather than written with nulls, so this is the
   *  archive saying "we observed no price for this one" — different again from
   *  never having looked. */
  | "not_priced"
  /**
   * The hour is on record, the ticker is absent — AND the ticker has no record
   * anywhere earlier in the window. It was not on the desk yet.
   *
   * Split out of `not_priced` after reading production, where it was the
   * difference between a true sentence and a false one. AMZN, MSFT and MSTR
   * were admitted on 20260908 (#433); a 14-day window therefore holds ~292
   * hours where the desk polled, priced six other tickers, and never asked
   * about these. Reported as `not_priced` that reads "we observed no price for
   * AMZN 292 times", which is a claim about AMZN. The true statement is "we
   * were not looking at AMZN yet", which is a claim about the desk.
   *
   * Derivable WITHOUT `admittedAt` — that field has one writer and zero readers
   * (#225) and is not in the archive at all. This is read off the series
   * itself: hours earlier than this ticker's first observation. So it says
   * exactly what the data supports ("no record before here") and does not
   * pretend to know the admission date.
   */
  | "before_first_seen";

/** One plotted observation. Every field is copied from the archive as stored;
 *  nothing here is recomputed, so the chart cannot drift from the receipt. */
export interface ChartPoint {
  /** `YYYYMMDDHH` UTC — the archive's own bucket key. */
  hour: string;
  /** ISO instant the cycle actually ran. `hour` is truncated; this is not. */
  at: string;
  /** Market clock AT CAPTURE, as recorded — never re-derived from `at`, which
   *  would get holidays and half-days wrong. */
  is_open: boolean;
  oracle_usd: number | null;
  dex_usd: number | null;
  /** Copied, never recomputed from the two prices above. The desk graded its
   *  arrows against THIS number; recomputing would let the chart and the
   *  receipt disagree in the last decimal and there would be no way to say
   *  which was right. */
  drift_pct: number | null;
  /** Whether `oracle_usd` can be dated, read PER ITEM via {@link oracleDating}.
   *  Never derived from the day's `v` — `v` dates the writer, and on 20260828
   *  the day is stamped 2 while ten of its fourteen items predate the field. */
  dating: OracleDating;
}

/** A maximal run of consecutive on-record hours, or a labelled hole. */
export type ChartSegment =
  | { kind: "run"; points: ChartPoint[] }
  | {
      kind: "gap";
      reason: ChartGapReason;
      /** Inclusive `YYYYMMDDHH` bounds of the hole. */
      from_hour: string;
      to_hour: string;
      hours: number;
    };

/** Per-day input, mirroring `SeriesDayRead` / `BaseSeriesDayRead` — the SAME
 *  four states, so a caller that already discriminates a read does not have to
 *  learn a second vocabulary to draw it. */
export type ChartDayInput =
  | {
      day: string;
      status: "hit";
      points: SeriesPoint[];
      /** From `seriesCoverage` / `baseSeriesCoverage`. Passed IN rather than
       *  re-derived here: those functions already know the archive's start day
       *  and the partial current day, and a second copy of that window logic is
       *  a second place for it to be wrong. */
      hours_absent: string[];
    }
  | { day: string; status: "miss" }
  | { day: string; status: "error"; message: string }
  | { day: string; status: "before_archive" };

export interface ChartSeries {
  ticker: string;
  /** Carried so the rendered chart can state its desk. A ticker string does not
   *  identify a token — NVDA, META, GOOGL and TSLA exist on both chains as
   *  different tokens with different pools, and the two chains share no state.
   *  A chart captioned only "NVDA" is the bare-ticker bug drawn in pixels. */
  chain: HoodChain;
  segments: ChartSegment[];
  /** Every plotted point, flattened, in order. Convenience for scaling axes —
   *  NOT for drawing, because drawing from this would bridge the gaps. */
  points: ChartPoint[];
  counts: {
    plotted: number;
    gaps: Record<ChartGapReason, number>;
    /**
     * Hours in gaps that sit BETWEEN two observations — a real break in the
     * line. Counted in hours, not segments: one 6-hour hole is 1 gap and 6
     * hours.
     *
     * Leading and trailing absence are deliberately NOT here. A 14-day window
     * over a 12-day archive is not "48 hours of missing data", and a ticker
     * admitted last Tuesday did not go dark for the eleven days before it
     * existed on the desk. Counting either as a hole is an alarm on the
     * expected — `archiveHoles` makes the same cut for the same reason, and the
     * series route documents why: raise it on days the recorder was never alive
     * for and the signal gets tuned out.
     */
    gap_hours: number;
    /** Hours before the first observation. Not a hole — the window simply
     *  starts earlier than the record does. */
    lead_in_hours: number;
    /**
     * Hours after the last observation. Not a break in the line either, but NOT
     * cosmetic: a chart whose newest point is two days old looks identical to a
     * live one, and this is the only field that says otherwise. Kept apart from
     * `lead_in_hours` because the two mean opposite things — one is history we
     * never had, the other is data we have stopped getting.
     */
    trailing_hours: number;
  };
  dating: {
    /** Whether this desk records oracle rounds AT ALL. False on Robinhood.
     *
     *  The tally below cannot say this for itself, and read alone it misleads
     *  in a specific direction: an RH series is 100% `predates_field` BY
     *  CONSTRUCTION — `SeriesRow.oracle_updated_at` is documented "Base only"
     *  and the RH poller never writes it — so a reader seeing "0 dated, 283
     *  predate the field" naturally infers the RH desk started recording
     *  rounds at some point and these are just the old ones. It did not and it
     *  will not. That is a capability of the desk, not a measurement of the
     *  window, and the flag travels WITH the counts for the same reason
     *  `datingCounts` ships beside `v` in the base-series route: a number whose
     *  caveat is one object away is a number that will be quoted without it. */
    supported: boolean;
    dated: number;
    undatable: number;
    predates_field: number;
  };
  /** Of the plotted points that have a drift reading, how many sit inside the
   *  deviation deadband. Shipped WITH the series so a caller cannot render the
   *  line and forget the caveat — the number travels with the number it
   *  qualifies, the same contract `datingCounts` has in `base-series.ts`. */
  deadband: {
    abs_pct: number;
    graded: number;
    inside: number;
  };
}

/**
 * Does this desk record the Chainlink round behind its oracle price at all?
 *
 * Base does; Robinhood does not, and never has — `SeriesRow.oracle_updated_at`
 * is documented "Base only" and `poller.ts` contains no write of it. So an RH
 * series is `predates_field` for every point BY CONSTRUCTION, and that tally is
 * a fact about the desk rather than about the window. Answered here, in code a
 * script can pin, rather than by a chart component checking `chain === "base"`
 * inline — that check would be one `||` away from silently becoming true for a
 * third desk that also does not record rounds.
 *
 * Note the deliberate asymmetry with {@link DEADBAND_ABS_PCT}: the deadband is
 * a property of the Chainlink B20 feeds, so it is meaningful only where those
 * feeds are the oracle — the same place this returns true. A future RH chart
 * must not borrow either number.
 */
export function oracleDatingSupported(chain: HoodChain): boolean {
  return chain === "base";
}

/**
 * Build the drawable series for ONE ticker on ONE chain.
 *
 * Takes the day reads in the order they should be drawn (oldest first) and
 * returns segments that a renderer can walk without making any decision of its
 * own. All the judgement lives here, where a script can test it; the renderer
 * only maps numbers to pixels.
 *
 * `days` is not re-sorted. The caller builds the window and the archive routes
 * already emit it oldest-first; re-sorting here would silently repair a caller
 * that had its window backwards, and that caller would then be wrong somewhere
 * this function cannot see. Same reasoning `archiveHoles` documents for its own
 * ordering assumption.
 */
export function buildChartSeries(
  ticker: string,
  chain: HoodChain,
  days: ChartDayInput[],
): ChartSeries {
  const segments: ChartSegment[] = [];
  const flat: ChartPoint[] = [];
  const gaps: Record<ChartGapReason, number> = {
    unreadable: 0,
    missing_day: 0,
    before_archive: 0,
    hour_absent: 0,
    not_priced: 0,
    before_first_seen: 0,
  };

  // A hole is emitted as ONE segment per contiguous same-reason stretch, so a
  // 6-hour outage draws one band rather than six. Accumulated here and flushed
  // whenever the reason changes or a run begins.
  let pendingReason: ChartGapReason | null = null;
  let pendingFrom = "";
  let pendingTo = "";
  let pendingHours = 0;
  let run: ChartPoint[] = [];

  const flushRun = () => {
    if (run.length) {
      segments.push({ kind: "run", points: run });
      run = [];
    }
  };
  const flushGap = () => {
    if (pendingReason) {
      segments.push({
        kind: "gap",
        reason: pendingReason,
        from_hour: pendingFrom,
        to_hour: pendingTo,
        hours: pendingHours,
      });
      pendingReason = null;
      pendingHours = 0;
    }
  };
  const addGap = (reason: ChartGapReason, hour: string, hours: number) => {
    flushRun();
    if (pendingReason !== reason) {
      flushGap();
      pendingReason = reason;
      pendingFrom = hour;
    }
    pendingTo = hour;
    pendingHours += hours;
  };
  const addPoint = (p: ChartPoint) => {
    flushGap();
    run.push(p);
    flat.push(p);
  };

  for (const d of days) {
    if (d.status === "error") {
      // A whole day of UNKNOWN. Counted as 24 hours because that is the size of
      // what we cannot see; reporting it as 1 would understate the hole in the
      // one direction that flatters the chart.
      addGap("unreadable", `${d.day}00`, 24);
      continue;
    }
    if (d.status === "miss") {
      addGap("missing_day", `${d.day}00`, 24);
      continue;
    }
    if (d.status === "before_archive") {
      addGap("before_archive", `${d.day}00`, 24);
      continue;
    }

    // Walk the day's real hours in order, interleaved with the absent ones, so
    // a hole in the middle of a day breaks the line exactly where it happened.
    const absent = new Set(d.hours_absent);
    const byHour = new Map<string, SeriesPoint>();
    for (const p of d.points) byHour.set(p.hour, p);
    const hours = [...new Set([...byHour.keys(), ...absent])].sort();

    for (const h of hours) {
      if (absent.has(h)) {
        addGap("hour_absent", h, 1);
        continue;
      }
      const point = byHour.get(h)!;
      // Resolve the ticker WITHIN this chain's archive only. The two desks are
      // stored under disjoint key prefixes and the caller picked one; there is
      // no cross-chain fallback here and there must never be one, because a
      // fallback is how a Base row ends up drawn from RH history (#161).
      const row = point.rows.find((r) => r.ticker === ticker);
      if (!row) {
        addGap("not_priced", h, 1);
        continue;
      }
      addPoint({
        hour: point.hour,
        at: point.at,
        is_open: point.is_open,
        oracle_usd: row.oracle_usd,
        dex_usd: row.dex_usd,
        drift_pct: row.drift_pct,
        dating: oracleDating(row),
      });
    }
  }
  flushRun();
  flushGap();

  // ── Second pass: classify each gap by WHERE it sits ──────────────────────
  //
  // Only now is this knowable. "Leading" means no run precedes it, and while
  // walking forward the first time we cannot yet tell a leading gap from an
  // interior one — the run that would settle it has not been reached. Doing it
  // here rather than guessing during the walk is why the pass exists.
  const firstRun = segments.findIndex((s) => s.kind === "run");
  const lastRun = segments.map((s) => s.kind).lastIndexOf("run");
  let gapHours = 0;
  let leadInHours = 0;
  let trailingHours = 0;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.kind !== "gap") continue;
    // A gap before the first observation, where the ticker IS absent from an
    // hour the desk did record, is "not on the desk yet" — not "priced nothing".
    // Re-labelled here because the distinction is positional, and position is
    // what this pass knows. See `before_first_seen`.
    if (seg.reason === "not_priced" && (firstRun === -1 || i < firstRun)) {
      seg.reason = "before_first_seen";
    }
    gaps[seg.reason]++;
    if (firstRun === -1 || i < firstRun) leadInHours += seg.hours;
    else if (i > lastRun) trailingHours += seg.hours;
    else gapHours += seg.hours;
  }

  const dating = {
    supported: oracleDatingSupported(chain),
    dated: 0,
    undatable: 0,
    predates_field: 0,
  };
  for (const p of flat) dating[p.dating]++;

  const graded = flat.filter((p) => p.drift_pct !== null);
  return {
    ticker,
    chain,
    segments,
    points: flat,
    counts: {
      plotted: flat.length,
      gaps,
      gap_hours: gapHours,
      lead_in_hours: leadInHours,
      trailing_hours: trailingHours,
    },
    dating,
    deadband: {
      abs_pct: DEADBAND_ABS_PCT,
      graded: graded.length,
      inside: graded.filter((p) => Math.abs(p.drift_pct as number) < DEADBAND_ABS_PCT).length,
    },
  };
}

/** `YYYYMMDDHH` → UTC ms. Via `Date.UTC` so no local zone can leak into an
 *  axis: the archive's buckets are UTC and an axis built in local time would
 *  silently shift every point by the viewer's offset. */
export function hourToMs(h: string): number {
  return Date.UTC(+h.slice(0, 4), +h.slice(4, 6) - 1, +h.slice(6, 8), +h.slice(8, 10));
}

/**
 * The time span the chart actually draws: first observation to last.
 *
 * NOT the requested window. Those differ whenever the window reaches back past
 * the record, and drawing the requested window would give AMZN — 15 points
 * inside a 14-day request — a chart that is 95% empty canvas with a stub of
 * line in the corner. The reader's eye reads that emptiness as "the price was
 * flat/absent", which is a claim the archive never made.
 *
 * The counterpart rule is that INTERIOR gaps stay on the axis and stay to
 * scale. Those are real breaks between two things we did observe, and squeezing
 * them out would put a six-hour hole and a one-hour hole at the same width —
 * the exact flattening this module exists to prevent. So: edges are excluded
 * and reported as text (`lead_in_hours` / `trailing_hours`), interiors are
 * drawn. Null when there is nothing to draw.
 */
export function chartDomain(s: ChartSeries): { from_ms: number; to_ms: number } | null {
  if (s.points.length === 0) return null;
  const first = hourToMs(s.points[0].hour);
  const last = hourToMs(s.points[s.points.length - 1].hour);
  // A single point has no span. Give it one hour so the caller divides by a
  // real number instead of zero — `isPlottable` already refuses to draw a line
  // through it, so this only keeps the arithmetic total.
  return { from_ms: first, to_ms: last === first ? first + 3_600_000 : last };
}

/**
 * Can this series be drawn as a price line at all?
 *
 * Two plotted points is the floor: one point is a dot, and a "chart" of one dot
 * with an axis implies a trend that was never measured. Below the floor the
 * caller must render the reason, not an empty frame — an empty frame reads as
 * "flat", which is a claim.
 */
export function isPlottable(s: ChartSeries): boolean {
  return s.points.filter((p) => p.oracle_usd !== null || p.dex_usd !== null).length >= 2;
}

/**
 * The single sentence explaining why a chart is missing or partial, or null
 * when nothing needs saying.
 *
 * One writer for this text, so the panel cannot invent a cheerier phrasing.
 * Note what it never says: "unavailable" or "failed" for a hole that is simply
 * outside the archive — nothing was tried and nothing broke there. Same
 * discipline `detailPanelPlan`'s notes follow.
 */
export function chartNote(s: ChartSeries): string | null {
  if (!isPlottable(s)) {
    if (s.counts.gaps.unreadable > 0) {
      return "The archive could not be read for this window — its contents here are unknown, which is not the same as empty.";
    }
    if (s.counts.plotted === 0 && s.counts.gaps.before_archive > 0) {
      return "This window predates the archive. No backfill exists, and none can be reconstructed.";
    }
    return "Not enough recorded points to draw a line. A single reading is a dot, not a trend.";
  }
  // Leading absence first, and never as a "break". A window wider than the
  // archive, or a ticker admitted mid-window, is the expected shape of a young
  // desk — production has FOUR tickers in exactly that state right now (AMZN,
  // MSFT, MSTR admitted 20260908, TSLA 20260909). That count is a reading, not
  // a property: it goes up on every admission, so re-derive it from the archive
  // rather than trusting this comment. Phrasing it as missing data would put a
  // warning on every one of their charts for something nobody did wrong, and a
  // warning that is always on is a warning nobody reads.
  if (s.counts.gap_hours === 0 && s.counts.lead_in_hours > 0) {
    return s.counts.gaps.before_first_seen > 0
      ? "The line starts where this ticker's record does — it was not on the desk earlier in this window."
      : "The line starts where the archive does. Earlier hours were never recorded and cannot be backfilled.";
  }

  const holes = s.counts.gap_hours;
  if (holes > 0) {
    // Built from the reasons, and only emitted if there is something to say —
    // the first version of this line could print "Line breaks at 24 hours ()"
    // when the only gap was a lead-in, which is both malformed and a claim
    // about missing data that was never missing.
    const parts: string[] = [];
    if (s.counts.gaps.unreadable) parts.push("unreadable");
    if (s.counts.gaps.missing_day || s.counts.gaps.hour_absent) parts.push("not recorded");
    if (s.counts.gaps.not_priced) parts.push("no price observed");
    const why = parts.length ? ` (${parts.join(", ")})` : "";
    return `Line breaks at ${holes} hour${holes === 1 ? "" : "s"}${why}. The gaps are drawn, not bridged.`;
  }
  return null;
}
