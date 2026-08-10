/**
 * Blue Hood — one poll cycle.
 *
 * Called by the 60s scheduler (/api/cron/blue-hood/poll). Fans out M5
 * (`rh-stock-arb`) across the watchlist and reshapes each response into a
 * `TickerSnapshot`. Writes:
 *   • `bh:snapshot:latest` — read path for /hood + the rule engine
 *   • `bh:snapshot:hour:YYYYMMDDHH` — ring buffer for the sparkline / history
 *
 * ── Rate-limit strategy (T1) ───────────────────────────────────────────────
 * GeckoTerminal's free tier caps at ~30 req/min. The earlier "batch 8×"
 * approach burst all 24 tokens in <2s and got rate-limited from position ~9
 * onwards ("alphabet cutoff" at INTC). This poller now runs SEQUENTIAL with
 * a stagger delay so 24 tokens land across ~60s, which sits under GT's
 * cap and gives the memo layer time to reuse.
 *
 * The exact stagger is `BH_POLL_STAGGER_MS` (default 2500ms → 60s cycle).
 * On a warm handler the 60s memo TTL in `rwa-market.ts` means a same-token
 * re-poll one cycle later still hits network (memo just expired) — that's
 * intentional; we want fresh prices, not stale ones.
 */
import { kvSet, kvGetProbe } from "@/lib/kv";
import { HOOD_WATCHLIST, HOOD_REGISTRY_STATS } from "./registry";
import { callTool } from "./tool-caller";
import {
  KV_SNAPSHOT_LATEST,
  TTL_SNAPSHOT_HOUR,
  kvSnapshotHour,
  kvSeriesDay,
  yyyymmdd,
  yyyymmddhh,
} from "./kv-keys";
import type {
  HoodSnapshot,
  M5Verdict,
  MarketSession,
  SeriesDay,
  SeriesPoint,
  SeriesRow,
  TickerSnapshot,
} from "./types";
import { cacheAgeS } from "@/lib/robinhood/rwa-market";
import { readSparkline } from "./sparkline";

// M5 response shape (subset we care about — kept in this file so a change in
// the tool trips a compile error here first).
interface M5Response {
  verdict: M5Verdict;
  ticker: string;
  name: string;
  contract: string;
  market: { is_open: boolean; session: MarketSession; ny_time_iso: string };
  delta: { pct: number };
  chainlink: { price_usd: number };
  dex: {
    price_usd: number;
    /** Deprecated alias for `primary_pool_tvl_usd`; kept for older M5 outputs. */
    tvl_usd: number;
    /** Primary pool TVL — the pool the swap path uses. */
    primary_pool_tvl_usd?: number;
    /** SUM across every RH-Chain pool for this token. Feeds the dust gate. */
    total_tvl_usd?: number;
    /** Number of pools discovered for this token. */
    pool_count?: number;
    volume_24h_usd: number;
    pool_ref: string;
    is_v4_pool_id: boolean;
  };
  warnings: string[];
}

const GT_TOKENS_URL_BASE = "https://api.geckoterminal.com/api/v2/networks/robinhood/tokens";
// 3s stagger → 24 tokens over ~72s per cycle. GT rate-limit on the RH
// network endpoint seems to sit around 20 req/min in practice (below the
// 30/min free-tier claim); 3s stagger stays safely under.
const DEFAULT_STAGGER_MS = 3000;
function staggerMs(): number {
  const raw = process.env.BH_POLL_STAGGER_MS;
  if (raw === undefined || raw === "") return DEFAULT_STAGGER_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_STAGGER_MS;
}

async function pollOne(ticker: string, cycleStart: number): Promise<TickerSnapshot> {
  const entry = HOOD_WATCHLIST.find((t) => t.ticker === ticker)!;
  const polled_at_ms = Date.now() - cycleStart;
  const r = await callTool<M5Response>("rh-stock-arb", { ticker });

  // Freshness attribution — inspect the memo for the URL M5 hit internally.
  const gtUrl = `${GT_TOKENS_URL_BASE}/${entry.contract.toLowerCase()}/pools?page=1`;
  const data_age_s = cacheAgeS(gtUrl);

  // T-B1 — read cached sparkline (no network here; the refresh cron owns
  // populating the cache). Null when cold; the UI hides the column when
  // it's null or below 6 candles.
  const sparkline = await readSparkline(ticker);

  if (!r.ok) {
    // T-B.1 #4 — tool call itself failed: fetch_failed. `no_pool` is
    // reserved for the case where the tool DID reach the upstream but
    // no pool exists.
    return {
      ticker,
      name: entry.name,
      contract: entry.contract,
      verdict: "ERROR",
      oracle_usd: null,
      dex_usd: null,
      tvl_usd: null,
      total_tvl_usd: null,
      volume_24h_usd: null,
      drift_pct: null,
      pool_ref: null,
      is_v4_pool_id: false,
      market: {
        is_open: false,
        session: "regular",
        ny_time_iso: new Date().toISOString(),
      },
      warnings: [],
      error: `${r.status}: ${r.error}`,
      polled_at_ms,
      data_age_s,
      sparkline,
      no_data_reason: "fetch_failed",
    };
  }

  const d = r.data;
  const hasDex = d.dex?.price_usd !== undefined && d.dex.price_usd !== null;
  // T-B.1 #4 — for successful responses with no DEX data, infer the
  // reason from the memo cache. GT hit succeeded (memo populated) but
  // no valid pool = no_pool. GT hit not memoized (data_age_s === null)
  // and we still have no DEX = the fetch inside M5 got null (rate-limit
  // or upstream error) → fetch_failed.
  const no_data_reason: "no_pool" | "fetch_failed" | null = hasDex
    ? null
    : (data_age_s !== null ? "no_pool" : "fetch_failed");

  return {
    ticker: d.ticker,
    name: d.name,
    contract: d.contract,
    verdict: d.verdict,
    oracle_usd: d.chainlink?.price_usd ?? null,
    dex_usd: d.dex?.price_usd ?? null,
    // `tvl_usd` = primary-pool TVL (unchanged shape). `total_tvl_usd`
    // (T-B fix — dust-gate correctness): SUM across all pools; falls
    // back to primary if M5 predates the field so mid-deploy cycles are
    // safe. Rule engine reads `total_tvl_usd ?? tvl_usd` for the gate.
    tvl_usd: d.dex?.primary_pool_tvl_usd ?? d.dex?.tvl_usd ?? null,
    total_tvl_usd: d.dex?.total_tvl_usd ?? d.dex?.tvl_usd ?? null,
    volume_24h_usd: d.dex?.volume_24h_usd ?? null,
    drift_pct: typeof d.delta?.pct === "number" ? d.delta.pct : null,
    pool_ref: d.dex?.pool_ref ?? null,
    is_v4_pool_id: Boolean(d.dex?.is_v4_pool_id),
    market: d.market,
    warnings: Array.isArray(d.warnings) ? d.warnings : [],
    polled_at_ms,
    data_age_s,
    sparkline,
    no_data_reason,
  };
}

/**
 * Sequential+staggered poll. Logs one `[poller]` line per token so a
 * NO_DATA row can be attributed to the exact position in the cycle.
 */
export async function runPollCycle(): Promise<HoodSnapshot> {
  const started_at = new Date();
  const rows: TickerSnapshot[] = [];
  const gap = staggerMs();

  console.log(`[poller] cycle=${Math.floor(started_at.getTime() / 1000)} strategy=sequential stagger_ms=${gap} count=${HOOD_WATCHLIST.length}`);

  for (let i = 0; i < HOOD_WATCHLIST.length; i++) {
    const token = HOOD_WATCHLIST[i];
    const t0 = Date.now();
    const row = await pollOne(token.ticker, started_at.getTime());
    const elapsed_ms = Date.now() - t0;
    const ageStr = row.data_age_s === null ? "cold" : `age=${row.data_age_s.toFixed(1)}s`;
    console.log(`[poller] seq=${i + 1}/${HOOD_WATCHLIST.length} ticker=${row.ticker} verdict=${row.verdict} elapsed_ms=${elapsed_ms} ${ageStr}`);
    rows.push(row);
    if (gap > 0 && i < HOOD_WATCHLIST.length - 1) {
      await new Promise((res) => setTimeout(res, gap));
    }
  }

  const finished_at = new Date();
  const tokens_errored = rows.filter((r) => r.verdict === "ERROR").length;
  // `tvl_scanned_usd` used to sum only primary-pool TVL (missed the
  // bankr-robinhood WETH depth). Now sums TOTAL liquidity per token —
  // matches what the dust gate sees and what a user would call "total
  // depth we're watching". Falls back to primary if `total_tvl_usd` is
  // null (M5 predates the field).
  const tvl_scanned_usd = rows.reduce((sum, r) => sum + (r.total_tvl_usd ?? r.tvl_usd ?? 0), 0);
  // T-B.1 #4 — count no-data rows by reason. A `fetch_failed` streak
  // across cycles is a throttle-tail signal that needs looking at.
  const no_data_no_pool = rows.filter((r) => r.no_data_reason === "no_pool").length;
  const no_data_fetch_failed = rows.filter((r) => r.no_data_reason === "fetch_failed").length;
  console.log(`[poller] cycle-end no_data_by_reason no_pool=${no_data_no_pool} fetch_failed=${no_data_fetch_failed} errored=${tokens_errored}`);
  const first_ok = rows.find((r) => r.verdict !== "ERROR");
  const market = first_ok?.market ?? {
    is_open: false,
    session: "regular" as MarketSession,
    ny_time_iso: started_at.toISOString(),
  };

  return {
    cycle_id: Math.floor(started_at.getTime() / 1000),
    started_at: started_at.toISOString(),
    finished_at: finished_at.toISOString(),
    duration_ms: finished_at.getTime() - started_at.getTime(),
    tickers: rows,
    metrics: {
      registry_total: HOOD_REGISTRY_STATS.rwa_candidates,
      tokens_watched: HOOD_WATCHLIST.length,
      tokens_no_feed: HOOD_REGISTRY_STATS.no_chainlink_feed,
      tokens_errored,
      tvl_scanned_usd,
      market_is_open: market.is_open,
      market_session: market.session,
    },
  };
}

/** Schema version stamped into every `SeriesDay`. Bump ONLY on a breaking
 *  shape change, and never rewrite old days to match — the version exists so
 *  two shapes can coexist in the archive. */
const SERIES_VERSION = 1;

/** Read one day of the permanent series. Exported so a future reader never
 *  has to re-derive the key format or the version handling. */
export async function readSeriesDay(day: string): Promise<SeriesDay | null> {
  const probe = await kvGetProbe<SeriesDay>(kvSeriesDay(day));
  return probe.status === "hit" ? probe.value : null;
}

/**
 * The first UTC day this archive can possibly contain — the day the writer
 * shipped (PR #263, merged 2026-08-10 03:01 UTC), so 20260810 itself is a
 * PARTIAL day that starts mid-morning UTC.
 *
 * WHY THIS IS A CONSTANT AND NOT A LOOKUP: absence has two completely
 * different meanings in this dataset and a reader cannot tell them apart from
 * the data alone. Before this date the answer is "nobody was recording"; after
 * it, "nothing priced that hour" — one is a gap in our coverage, the other is
 * a fact about the market. A chart that renders both as the same empty space
 * invents a flat market that never happened. Every read path must be able to
 * say which one it is, so it is stated here once.
 *
 * There is NO backfill: the 25h ring buffer these points are derived from has
 * long since dropped everything older, and no upstream sells the history back.
 */
export const SERIES_ARCHIVE_START = "20260810";

/** One day's read outcome, kept distinct all the way to the caller. */
export type SeriesDayRead =
  | { day: string; status: "hit"; value: SeriesDay }
  | { day: string; status: "miss" }
  | { day: string; status: "error"; message: string }
  | { day: string; status: "before_archive" };

/**
 * Read a set of days, reporting each one's outcome separately.
 *
 * Deliberately NOT `readSeriesDay` in a loop: that collapses `error` into
 * `null`, and a KV blip would then be served as "this day has no points" —
 * the same lie in the read path that `persistSeriesPoint`'s probe guard
 * prevents in the write path. A day we could not read must never be
 * indistinguishable from a day where nothing happened.
 *
 * Days before `SERIES_ARCHIVE_START` cost no KV request at all: the answer is
 * known without asking, and the engine has been starved by the Upstash request
 * cap once already (task #123).
 */
export async function readSeriesDays(days: string[]): Promise<SeriesDayRead[]> {
  return Promise.all(
    days.map(async (day): Promise<SeriesDayRead> => {
      if (day < SERIES_ARCHIVE_START) return { day, status: "before_archive" };
      const probe = await kvGetProbe<SeriesDay>(kvSeriesDay(day));
      if (probe.status === "error") return { day, status: "error", message: probe.message };
      if (probe.status === "miss") return { day, status: "miss" };
      return { day, status: "hit", value: probe.value };
    }),
  );
}

/** How much of a day is actually on record, and against what we judged it. */
export interface SeriesCoverage {
  hours_present: number;
  /** Hours inside the expected window holding no point, as `YYYYMMDDHH` — the
   *  same shape as `SeriesPoint.hour`, so the two lists compare directly. */
  hours_absent: string[];
  first_hour: string | null;
  last_hour: string | null;
  /** The window `hours_absent` was measured against. Published so a consumer
   *  reads what "absent" meant here instead of assuming it meant all 24. */
  expected_from: string | null;
  expected_to: string | null;
}

/**
 * Which hours of a day were missed.
 *
 * WHY THIS EXISTS: `readSeriesDays` keeps the three kinds of nothing distinct
 * at the DAY level, and then hands back a `points` array where the same
 * ambiguity is alive again one level down. An hour absent from that array is
 * any of three unrelated events — the cron never ran, it ran and nothing
 * priced (`mergeSeriesPoint` returns null on zero rows), or it ran and a KV
 * error made the writer refuse to write rather than clobber the day. Nothing
 * in the stored data tells them apart, and this function does not pretend
 * otherwise. It answers only the question that IS answerable: which hours we
 * expected and did not get. A consumer that plots `points` without asking will
 * connect 03:00 straight to 09:00 and draw a confident line through six hours
 * that were never observed.
 *
 * WHAT IS DELIBERATELY NOT A HOLE — an absent hour is evidence of loss only
 * where recording was both already running and already finished:
 *
 *  • Before the archive existed. On `SERIES_ARCHIVE_START` recording began
 *    whenever the deploy landed; the earliest point we hold is the only record
 *    of when, so nothing before it was ever promised. Counting those hours
 *    would put a permanent, unfixable gap on the archive's first day.
 *  • The future — including the hour running right now. The poll appends at
 *    ~:05, so calling the current hour overdue would manufacture a gap for
 *    five minutes out of every sixty and teach every consumer to ignore the
 *    field. Conservative by design: a genuinely dead writer surfaces one hour
 *    later than it could, which is the cheaper of the two errors.
 *
 * `now` is a parameter, not `new Date()`, so the window is testable at any
 * wall-clock time instead of only between 03:00 and 23:00 UTC.
 */
export function seriesCoverage(day: string, points: SeriesPoint[], now: Date): SeriesCoverage {
  const hours = points.map((p) => p.hour).sort();
  const first = hours[0] ?? null;
  const last = hours[hours.length - 1] ?? null;

  // Upper bound: the last hour that has finished. A past day is owed all 24.
  const to = day === yyyymmdd(now) ? now.getUTCHours() - 1 : 23;
  // Lower bound: 0 for every day the archive covered in full; on its first day,
  // the earliest hour we actually hold. `24` when that day holds nothing at
  // all, which crosses the bounds below and correctly claims no window.
  const from = day === SERIES_ARCHIVE_START ? (first === null ? 24 : +first.slice(8, 10)) : 0;

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

/**
 * PURE merge step: given the day as it currently exists in KV (`null` when
 * absent) and this cycle's snapshot, return the day to write — or `null` when
 * there is nothing to write.
 *
 * Split out from the I/O on purpose. Overwriting a day key is the only
 * operation in this subsystem that can destroy history, so it should be
 * provable by a test rather than by reading the code. Everything that decides
 * WHAT gets written lives here; `persistSeriesPoint` only decides whether it
 * is safe to write at all.
 *
 * Two rules encoded here:
 *
 *  • One point per hour bucket. The poll runs every 5 minutes, so 11 of every
 *    12 calls return `null`. Rewriting a growing day key 288×/day would spend
 *    KV request budget on nothing — and the Upstash cap has starved this
 *    engine once already.
 *
 *  • An hour where nothing priced is left ABSENT, not written as an empty
 *    point. A hole meaning "we failed to read" must not be recorded as "the
 *    market had no prices", and leaving it out lets a later cycle in the same
 *    hour still fill it.
 */
export function mergeSeriesPoint(
  existing: SeriesDay | null,
  snap: HoodSnapshot,
): SeriesDay | null {
  const at = new Date(snap.started_at);
  const day = yyyymmdd(at);
  const hour = yyyymmddhh(at);

  const points = existing?.points ?? [];
  if (points.some((p) => p.hour === hour)) return null; // this hour is already on record

  const rows: SeriesRow[] = snap.tickers
    .filter((t) => t.oracle_usd !== null || t.dex_usd !== null)
    .map((t) => ({
      ticker: t.ticker,
      oracle_usd: t.oracle_usd,
      dex_usd: t.dex_usd,
      drift_pct: t.drift_pct,
      total_tvl_usd: t.total_tvl_usd ?? t.tvl_usd,
    }));
  if (rows.length === 0) return null;

  const point: SeriesPoint = {
    hour,
    at: snap.started_at,
    is_open: snap.metrics.market_is_open,
    session: snap.metrics.market_session,
    rows,
  };
  return {
    day,
    v: SERIES_VERSION,
    // Sorted rather than pushed, so a late or retried cycle can't leave the
    // day out of chronological order for whoever reads it a year from now.
    points: [...points, point].sort((a, b) => a.hour.localeCompare(b.hour)),
  };
}

/**
 * Append this cycle's prices to the PERMANENT hourly series.
 *
 * The one load-bearing decision here is `kvGetProbe`, not `kvGet`. `kvGet`
 * swallows the error and returns null, which is indistinguishable from "no
 * data yet" — so a single KV blip at 23:00 would have us merge onto an empty
 * day and write ONE point over twenty-three real ones. That is the single
 * failure mode this feature cannot tolerate: unlike code, an overwritten hour
 * cannot be recreated later. On `error` we write nothing and lose one hour,
 * which the next cycle inside the same hour will fill.
 */
export async function persistSeriesPoint(snap: HoodSnapshot): Promise<void> {
  const day = yyyymmdd(new Date(snap.started_at));

  const probe = await kvGetProbe<SeriesDay>(kvSeriesDay(day));
  if (probe.status === "error") {
    console.error(
      `[series] read failed day=${day}: ${probe.message} — skipping write so a live day is never clobbered`,
    );
    return;
  }

  const next = mergeSeriesPoint(probe.status === "hit" ? probe.value : null, snap);
  if (next === null) return;

  // NO TTL, deliberately — see `kvSeriesDay` in kv-keys.ts.
  await kvSet(kvSeriesDay(day), next);
  // Log the hour we just added, not the last element — the array is sorted, so
  // a late-arriving cycle's point is not necessarily at the end.
  const hour = yyyymmddhh(new Date(snap.started_at));
  const added = next.points.find((p) => p.hour === hour);
  console.log(
    `[series] day=${day} hour=${hour} rows=${added?.rows.length ?? 0} points=${next.points.length}`,
  );
}

/**
 * Persist a snapshot to KV. Three keys:
 *   • latest — always overwritten
 *   • ring-buffer bucket — one write per hour bucket; downstream sparkline
 *     read walks 24 keys backwards from now.
 *   • permanent series — thin hourly price row, no TTL.
 *
 * The series write goes LAST and is wrapped, because the first two writes are
 * the engine's heartbeat: /hood, the rule engine and the health check all read
 * them. A new, non-critical archive write must never be able to take those
 * down (the poll cron has been starved once already; it doesn't get to happen
 * because of a nice-to-have).
 */
export async function persistSnapshot(snap: HoodSnapshot): Promise<void> {
  await kvSet(KV_SNAPSHOT_LATEST, snap);
  const bucket = yyyymmddhh(new Date(snap.started_at));
  await kvSet(kvSnapshotHour(bucket), snap, TTL_SNAPSHOT_HOUR);

  try {
    await persistSeriesPoint(snap);
  } catch (e) {
    console.error(`[series] persist failed: ${(e as Error).message}`);
  }
}
