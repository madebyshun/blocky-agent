/**
 * Gap-closure decomposition — "does the ORACLE catch up, or does the DEX revert?"
 *
 * A drift arrow fires when the DEX disagrees with the Chainlink oracle. It is
 * graded HIT when that gap later closes by >= 50%. The grader measures only the
 * MAGNITUDE of the gap, so it is blind to WHICH SIDE moved — and the two answers
 * mean opposite things for the product:
 *
 *   (a) DEX reverts to oracle   → mean-reversion. "Fade the DEX" is right, and
 *                                 the current brief ("expect a snap toward the
 *                                 feed at 9:30") is right.
 *   (b) Oracle catches up to DEX → the DEX was LEADING price discovery. The gap
 *                                 was information, not error, and telling a user
 *                                 to fade it is telling them to trade against
 *                                 the side that turned out correct.
 *   (c) Both converge            → mixed; report the ratio.
 *
 * This script answers it by recovering the PRICE LEVELS on both sides at fire
 * and at grade, and splitting the closure into the two components:
 *
 *     s              = sign(dex_fire - oracle_fire)      // which side was high
 *     oracle_contrib = +s * (oracle_close - oracle_fire) // oracle moving TOWARD dex
 *     dex_contrib    = -s * (dex_close   - dex_fire)     // dex moving TOWARD oracle
 *     total          = oracle_contrib + dex_contrib      // == gap actually closed
 *
 * both expressed as % of the fire-time oracle so tickers are comparable.
 *
 * ── WHERE THE NUMBERS COME FROM ───────────────────────────────────────────────
 * FIRE side  — exact, from the arrow's own `snapshot_at_fire` (oracle + dex).
 * CLOSE side — from `bh:series:day:*` via GET /api/hood/series, the permanent
 *              hourly oracle+dex archive. This is the ONLY source of close-side
 *              LEVELS: `grading_math` stores `now_gap_pct` (a magnitude) but not
 *              the two prices, so the decomposition is not recoverable from the
 *              arrow record alone — one equation, two unknowns.
 *
 * That makes the archive start date a hard floor on the sample: arrows graded
 * before it CANNOT be decomposed, ever. The script reports that exclusion
 * explicitly rather than quietly analysing whatever happens to be left.
 *
 * ⚠️ CHANGED 2026-08-13 (P2) — the grader now writes `grading_math
 * .close_oracle_price_usd` + `.close_dex_price_usd` on every drift arrow it
 * grades. Arrows graded FROM THAT DATE ON are self-decomposable straight off
 * the arrow record: no archive join, no coverage floor, no join-validation
 * drops. This script still uses the archive path because that is the only way
 * to reach the historical rows — but when reruning, the right move is to
 * decompose new arrows directly from `grading_math` and use the archive only
 * for the pre-2026-08-13 tail. The `n` that made this analysis inconclusive
 * is a fixed-supply problem for old arrows and a solved one for new ones.
 *
 * ── THE JOIN IS VALIDATED, NOT ASSUMED ───────────────────────────────────────
 * The archive is hourly; `graded_at` is not. So the close-side read can be up to
 * ~30 min away from the instant the grader actually looked. Rather than hoping
 * that is harmless, every row is checked: the gap implied by the archive prices
 * is compared against `grading_math.now_gap_pct`, which the grader recorded at
 * the true instant. Rows that disagree beyond tolerance are DROPPED and counted.
 * A row that survives has had its close-side prices independently corroborated.
 *
 * ── AND THE INPUT SERIES IS AUDITED FIRST ────────────────────────────────────
 * A decomposition is meaningless if the DEX "price" is not a price. Part 2 scores
 * every ticker for two failure modes that are invisible in the arrow record:
 *   • FROZEN  — bit-identical dex price hour after hour = a pool with no trades.
 *               The quote is stale, not a market. Any gap is the oracle walking
 *               away from a dead number, and no one could have traded it.
 *   • NOISY   — dex volatility far above ORACLE volatility during the SAME open
 *               hours. Both price the same asset, so the oracle is the yardstick;
 *               a DEX moving multiples faster is quote noise (e.g. spot flipping
 *               between two pools), not price discovery.
 * Read-only. Touches no KV, fires nothing, writes nothing.
 *   npx tsx scripts/gap-closure-dryrun.ts
 */
import { wilsonInterval } from "../src/lib/blue-hood/cohort-stats";
import { regularHoursElapsed } from "../src/lib/blue-hood/grader";
import type { Arrow, SeriesPoint } from "../src/lib/blue-hood/types";

const BASE = process.env.HOOD_BASE_URL ?? "https://blueagent.dev";
const TRACK_URL = `${BASE}/api/acp/track-record?limit=200`;
const SERIES_URL = (days: number) => `${BASE}/api/hood/series?days=${days}`;

/** How many days of archive to pull. 31 is the route's per-request cap. */
const SERIES_DAYS = Number(process.env.SERIES_DAYS ?? 31);

/** Max distance between `graded_at` and the archive point used for the close
 *  read. The archive is hourly, so anything <= 60 min is "the adjacent point";
 *  beyond that we are guessing across a gap in coverage. */
const MAX_JOIN_MINUTES = 60;

/** Join tolerance: |archive gap - grader gap|, in percentage POINTS, or as a
 *  fraction of the grader's own figure — whichever is looser. Absolute alone
 *  is unfair to a 19% gap; relative alone is unfair to a 0.1% gap. */
const JOIN_TOL_ABS_PP = 0.5;
const JOIN_TOL_REL = 0.25;

/** Share of the closure attributable to the oracle, above/below which a row is
 *  called led by one side. 0.65/0.35 leaves a genuine "mixed" band instead of
 *  forcing every row to one pole at 0.5. */
const ORACLE_LED_AT = 0.65;
const DEX_LED_AT = 0.35;

/** A ticker whose dex print is bit-identical this often across consecutive
 *  archive hours is quoted, not traded. */
const FROZEN_FRAC_DEAD = 0.5;
/** DEX hourly vol this many times the ORACLE's, during the same open hours,
 *  is quote noise rather than price discovery. */
const NOISE_RATIO_BAD = 3;

type Klass = "oracle_led" | "dex_led" | "mixed" | "widened";

interface Decomp {
  serial: string;
  ticker: string;
  type: string;
  outcome: string;
  session: string;
  fired_at: string;
  graded_at: string;
  join_minutes: number;
  fire_oracle: number;
  fire_dex: number;
  close_oracle: number;
  close_dex: number;
  fire_gap_pct: number;
  /** Gap at close implied by the archive prices. */
  close_gap_pct: number;
  /** Gap at close as the GRADER measured it — the corroborating figure. */
  grader_gap_pct: number;
  oracle_contrib_pct: number;
  dex_contrib_pct: number;
  total_pct: number;
  share_oracle: number | null;
  klass: Klass;
}

function pct(n: number, d: number): string {
  return d === 0 ? "n/a" : `${Math.round((n / d) * 100)}%`;
}

function fmtCI(hits: number, n: number): string {
  if (n === 0) return "n=0";
  const { lo, hi } = wilsonInterval(hits, n);
  return `${hits}/${n} = ${pct(hits, n)}  95% CI [${(lo * 100).toFixed(0)}%, ${(hi * 100).toFixed(0)}%]`;
}

/** Standard deviation of a sample. */
function sd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return (await r.json()) as T;
}

// ── Part 2: is the DEX series a price at all? ────────────────────────────────

interface TickerHealth {
  ticker: string;
  hours: number;
  frozen_steps: number;
  total_steps: number;
  frozen_frac: number;
  /** Hourly % move stdev, market-open hours only. */
  dex_vol_open: number;
  oracle_vol_open: number;
  /** dex_vol / oracle_vol over the same open hours. */
  noise_ratio: number | null;
  open_steps: number;
  verdict: "dead" | "noisy" | "ok" | "insufficient";
}

function auditTickers(points: SeriesPoint[]): Map<string, TickerHealth> {
  const byTicker = new Map<string, { at: number; open: boolean; oracle: number | null; dex: number | null }[]>();
  for (const p of points) {
    const at = new Date(p.at).getTime();
    for (const r of p.rows) {
      if (!byTicker.has(r.ticker)) byTicker.set(r.ticker, []);
      byTicker.get(r.ticker)!.push({ at, open: p.is_open, oracle: r.oracle_usd, dex: r.dex_usd });
    }
  }

  const out = new Map<string, TickerHealth>();
  for (const [ticker, rowsRaw] of byTicker) {
    const rows = rowsRaw.sort((a, b) => a.at - b.at);
    let frozen = 0;
    let steps = 0;
    const dexOpen: number[] = [];
    const oraOpen: number[] = [];

    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1];
      const b = rows[i];
      if (a.dex !== null && b.dex !== null && a.dex > 0) {
        steps++;
        // Bit-identical, not "close": a real pool essentially never reprints the
        // same 15-significant-digit spot an hour later.
        if (a.dex === b.dex) frozen++;
        // Both endpoints inside the regular session — the only window where the
        // oracle is live and the two are measuring the same thing.
        if (a.open && b.open) dexOpen.push(((b.dex - a.dex) / a.dex) * 100);
      }
      if (a.open && b.open && a.oracle !== null && b.oracle !== null && a.oracle > 0) {
        oraOpen.push(((b.oracle - a.oracle) / a.oracle) * 100);
      }
    }

    const dexVol = sd(dexOpen);
    const oraVol = sd(oraOpen);
    const noise = oraVol > 0 && dexOpen.length >= 4 ? dexVol / oraVol : null;
    const frozenFrac = steps > 0 ? frozen / steps : 0;

    let verdict: TickerHealth["verdict"];
    if (steps < 4) verdict = "insufficient";
    else if (frozenFrac >= FROZEN_FRAC_DEAD) verdict = "dead";
    else if (noise !== null && noise >= NOISE_RATIO_BAD) verdict = "noisy";
    else verdict = "ok";

    out.set(ticker, {
      ticker,
      hours: rows.length,
      frozen_steps: frozen,
      total_steps: steps,
      frozen_frac: frozenFrac,
      dex_vol_open: dexVol,
      oracle_vol_open: oraVol,
      noise_ratio: noise,
      open_steps: Math.min(dexOpen.length, oraOpen.length),
      verdict,
    });
  }
  return out;
}

// ── Part 2b: is the GAP itself a stable quantity? ────────────────────────────
//
// The decomposition can only use arrows whose grading window the archive
// covers, which is a handful. This test needs no arrows at all: it runs on the
// raw hourly series, so its sample is (tickers x hours), two orders of magnitude
// larger. It asks the question the grader implicitly assumes the answer to —
// once a >= 2% gap exists, is it a dislocation that persists until something
// resolves it, or does it flicker on the hourly timescale?
//
// If a gap that just fired is already half-gone an hour later at a rate close to
// the published hit rate, then "the gap closed" is not measuring convergence. It
// is measuring where in the flicker the grader happened to look.

/** The engine's own firing threshold — the level this test interrogates. */
const DRIFT_FIRE_PCT = 2.0;

// `DRIFT_GRADING_WINDOW_H` in rule-engine.ts. Verified against live data rather
// than assumed: all 117 drift arrows carry `grading_window_h: 6`, so the null
// model and the live engine are graded on the same clock with no split cohort.
const DRIFT_WINDOW_H = 6;

interface GapDynamics {
  ticker: string;
  pairs: number;
  /** Lag-1 autocorrelation of signed drift %. ~1 = persistent, ~0 = memoryless. */
  autocorr: number | null;
  would_fire: number;
  /** Of the would-fire hours, how many are >=50% closed just ONE hour later. */
  closed_half_1h: number;
  /** ...and how many flipped sign entirely within the hour. */
  sign_flips: number;
  median_abs_delta: number;
}

function gapDynamics(points: SeriesPoint[]): { per: GapDynamics[]; all: GapDynamics } {
  const byTicker = new Map<string, { at: number; drift: number }[]>();
  for (const p of points) {
    const at = new Date(p.at).getTime();
    for (const r of p.rows) {
      if (r.drift_pct === null || r.oracle_usd === null || r.dex_usd === null) continue;
      if (!byTicker.has(r.ticker)) byTicker.set(r.ticker, []);
      byTicker.get(r.ticker)!.push({ at, drift: r.drift_pct });
    }
  }

  const per: GapDynamics[] = [];
  let aFire = 0;
  let aClosed = 0;
  let aFlip = 0;
  let aPairs = 0;
  const aDeltas: number[] = [];
  const aX: number[] = [];
  const aY: number[] = [];

  for (const [ticker, rowsRaw] of byTicker) {
    const rows = rowsRaw.sort((a, b) => a.at - b.at);
    const x: number[] = [];
    const y: number[] = [];
    const deltas: number[] = [];
    let fire = 0;
    let closed = 0;
    let flips = 0;

    for (let i = 1; i < rows.length; i++) {
      // Only treat as consecutive if the reads really are ~1h apart; a gap in
      // coverage must not be silently spanned as though it were one hour.
      const dtH = (rows[i].at - rows[i - 1].at) / 3_600_000;
      if (dtH < 0.5 || dtH > 1.5) continue;
      const a = rows[i - 1].drift;
      const b = rows[i].drift;
      x.push(a);
      y.push(b);
      deltas.push(Math.abs(b - a));
      if (Math.abs(a) >= DRIFT_FIRE_PCT) {
        fire++;
        if (Math.abs(b) <= 0.5 * Math.abs(a)) closed++;
        if (Math.sign(b) !== Math.sign(a)) flips++;
      }
    }

    aX.push(...x);
    aY.push(...y);
    aDeltas.push(...deltas);
    aFire += fire;
    aClosed += closed;
    aFlip += flips;
    aPairs += x.length;

    per.push({
      ticker,
      pairs: x.length,
      autocorr: pearson(x, y),
      would_fire: fire,
      closed_half_1h: closed,
      sign_flips: flips,
      median_abs_delta: median(deltas),
    });
  }

  return {
    per: per.sort((a, b) => b.would_fire - a.would_fire),
    all: {
      ticker: "ALL",
      pairs: aPairs,
      autocorr: pearson(aX, aY),
      would_fire: aFire,
      closed_half_1h: aClosed,
      sign_flips: aFlip,
      median_abs_delta: median(aDeltas),
    },
  };
}

/**
 * The null model: apply the grader's EXACT rule to every eligible hour in the
 * archive, not just the hours an arrow happened to fire on.
 *
 * The engine fires drift when the market is closed and |drift| >= 2%, then
 * grades HIT if the gap is >= 50% closed once 2 REGULAR-session hours have
 * elapsed. Every one of those conditions can be evaluated directly on the hourly
 * archive. Doing so answers the question the hit rate cannot answer about
 * itself: what would "fire on EVERY qualifying hour" have scored?
 *
 * If the null scores the same as the live engine, then the cooldowns, the
 * one-open-arrow-per-ticker rule and the ticker selection are adding nothing —
 * the hit rate is a property of the price series, not of the strategy. Reuses
 * `regularHoursElapsed` from the grader itself so the clock cannot drift apart
 * from production's.
 */
interface NullModel {
  ticker: string;
  eligible: number;
  gradable: number;
  hits: number;
}

function nullModelHitRate(points: SeriesPoint[]): { per: NullModel[]; all: NullModel } {
  const byTicker = new Map<string, { at: number; drift: number; open: boolean }[]>();
  for (const p of points) {
    const at = new Date(p.at).getTime();
    for (const r of p.rows) {
      if (r.drift_pct === null || r.oracle_usd === null || r.dex_usd === null) continue;
      if (!byTicker.has(r.ticker)) byTicker.set(r.ticker, []);
      byTicker.get(r.ticker)!.push({ at, drift: r.drift_pct, open: p.is_open });
    }
  }

  const per: NullModel[] = [];
  let aE = 0;
  let aG = 0;
  let aH = 0;

  for (const [ticker, rowsRaw] of byTicker) {
    const rows = rowsRaw.sort((a, b) => a.at - b.at);
    let eligible = 0;
    let gradable = 0;
    let hits = 0;

    for (let i = 0; i < rows.length; i++) {
      // The engine's firing condition, verbatim: market closed AND |drift| >= 2%.
      if (rows[i].open) continue;
      if (Math.abs(rows[i].drift) < DRIFT_FIRE_PCT) continue;
      eligible++;
      const fireIso = new Date(rows[i].at).toISOString();
      // The grader's condition, verbatim: first read at which >= 2 regular hours
      // have elapsed. If the archive ends first, this one is simply not gradable
      // — exactly as an arrow still inside its window is not gradable.
      for (let j = i + 1; j < rows.length; j++) {
        if (regularHoursElapsed(fireIso, rows[j].at) < DRIFT_WINDOW_H) continue;
        gradable++;
        if (Math.abs(rows[j].drift) <= 0.5 * Math.abs(rows[i].drift)) hits++;
        break;
      }
    }

    aE += eligible;
    aG += gradable;
    aH += hits;
    per.push({ ticker, eligible, gradable, hits });
  }

  return {
    per: per.sort((a, b) => b.gradable - a.gradable),
    all: { ticker: "ALL", eligible: aE, gradable: aG, hits: aH },
  };
}

function pearson(x: number[], y: number[]): number | null {
  const n = Math.min(x.length, y.length);
  if (n < 5) return null;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
    syy += (y[i] - my) ** 2;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// ── Part 3: the decomposition ────────────────────────────────────────────────

function classify(shareOracle: number | null, total: number): Klass {
  if (total <= 0) return "widened";
  if (shareOracle === null) return "mixed";
  if (shareOracle >= ORACLE_LED_AT) return "oracle_led";
  if (shareOracle <= DEX_LED_AT) return "dex_led";
  return "mixed";
}

interface Dropped {
  serial: string;
  ticker: string;
  reason: string;
}

function decompose(
  arrows: Arrow[],
  points: SeriesPoint[],
): { rows: Decomp[]; dropped: Dropped[] } {
  // ticker → chronological archive reads
  const idx = new Map<string, { at: number; oracle: number | null; dex: number | null }[]>();
  for (const p of points) {
    const at = new Date(p.at).getTime();
    for (const r of p.rows) {
      if (!idx.has(r.ticker)) idx.set(r.ticker, []);
      idx.get(r.ticker)!.push({ at, oracle: r.oracle_usd, dex: r.dex_usd });
    }
  }
  for (const v of idx.values()) v.sort((a, b) => a.at - b.at);

  const rows: Decomp[] = [];
  const dropped: Dropped[] = [];

  for (const a of arrows) {
    if (a.type !== "drift" || a.status !== "graded") continue;
    if (a.outcome !== "hit" && a.outcome !== "miss") continue;
    const gm = a.grading_math;
    const fireOracle = a.snapshot_at_fire?.oracle_price_usd ?? null;
    const fireDex = a.snapshot_at_fire?.dex_price_usd ?? a.reference_price;
    if (!gm || typeof gm.now_gap_pct !== "number") {
      dropped.push({ serial: a.serial, ticker: a.ticker, reason: "no grading_math" });
      continue;
    }
    if (typeof fireOracle !== "number" || !(fireOracle > 0) || !(fireDex > 0)) {
      dropped.push({ serial: a.serial, ticker: a.ticker, reason: "no fire-time snapshot" });
      continue;
    }
    if (!a.graded_at) {
      dropped.push({ serial: a.serial, ticker: a.ticker, reason: "no graded_at" });
      continue;
    }

    const series = idx.get(a.ticker);
    if (!series?.length) {
      dropped.push({ serial: a.serial, ticker: a.ticker, reason: "ticker absent from archive" });
      continue;
    }
    const gradedMs = new Date(a.graded_at).getTime();
    // Nearest archive read with BOTH sides priced.
    let best: { at: number; oracle: number | null; dex: number | null } | null = null;
    for (const p of series) {
      if (p.oracle === null || p.dex === null) continue;
      if (best === null || Math.abs(p.at - gradedMs) < Math.abs(best.at - gradedMs)) best = p;
    }
    if (!best) {
      dropped.push({ serial: a.serial, ticker: a.ticker, reason: "no priced archive point" });
      continue;
    }
    const joinMin = Math.abs(best.at - gradedMs) / 60000;
    if (joinMin > MAX_JOIN_MINUTES) {
      dropped.push({
        serial: a.serial,
        ticker: a.ticker,
        // The dominant exclusion: graded before the archive existed.
        reason: `graded ${(joinMin / 60).toFixed(1)}h from nearest archive point (archive starts later)`,
      });
      continue;
    }

    const closeOracle = best.oracle!;
    const closeDex = best.dex!;
    const closeGapPct = Math.abs((closeDex - closeOracle) / closeOracle) * 100;
    const graderGapPct = gm.now_gap_pct;

    // Corroboration. The archive and the grader looked at slightly different
    // instants; if they disagree about the gap, the archive prices are not a
    // usable stand-in for what the grader saw, and this row is not evidence.
    const tol = Math.max(JOIN_TOL_ABS_PP, JOIN_TOL_REL * graderGapPct);
    if (Math.abs(closeGapPct - graderGapPct) > tol) {
      dropped.push({
        serial: a.serial,
        ticker: a.ticker,
        reason: `join failed: archive gap ${closeGapPct.toFixed(2)}% vs grader ${graderGapPct.toFixed(2)}% (tol ${tol.toFixed(2)})`,
      });
      continue;
    }

    const s = Math.sign(fireDex - fireOracle) || 1;
    const oracleContrib = ((s * (closeOracle - fireOracle)) / fireOracle) * 100;
    const dexContrib = ((-s * (closeDex - fireDex)) / fireOracle) * 100;
    const total = oracleContrib + dexContrib;
    const share = total > 0 ? oracleContrib / total : null;

    rows.push({
      serial: a.serial,
      ticker: a.ticker,
      type: a.type,
      outcome: a.outcome,
      session: a.market_at_fire?.session ?? "unknown",
      fired_at: a.fired_at,
      graded_at: a.graded_at,
      join_minutes: joinMin,
      fire_oracle: fireOracle,
      fire_dex: fireDex,
      close_oracle: closeOracle,
      close_dex: closeDex,
      fire_gap_pct: gm.fire_gap_pct ?? Math.abs((fireDex - fireOracle) / fireOracle) * 100,
      close_gap_pct: closeGapPct,
      grader_gap_pct: graderGapPct,
      oracle_contrib_pct: oracleContrib,
      dex_contrib_pct: dexContrib,
      total_pct: total,
      share_oracle: share,
      klass: classify(share, total),
    });
  }

  return { rows, dropped };
}

function tally(rows: Decomp[]): Record<Klass, number> {
  const t: Record<Klass, number> = { oracle_led: 0, dex_led: 0, mixed: 0, widened: 0 };
  for (const r of rows) t[r.klass]++;
  return t;
}

function printSlice(label: string, rows: Decomp[], minN = 5) {
  const t = tally(rows);
  const n = rows.length;
  const head = `${label.padEnd(28)} n=${String(n).padStart(3)}`;
  if (n === 0) {
    console.log(`${head}  — no rows`);
    return;
  }
  console.log(
    `${head}  oracle_led=${t.oracle_led} dex_led=${t.dex_led} mixed=${t.mixed} widened=${t.widened}` +
      (n < minN ? "   ⚠️ TOO FEW TO CONCLUDE" : ""),
  );
  const closed = rows.filter((r) => r.klass !== "widened");
  if (closed.length >= minN) {
    console.log(
      `${" ".repeat(30)}of the ${closed.length} that closed: oracle-led ${fmtCI(t.oracle_led, closed.length)}`,
    );
  }
}

async function main() {
  console.log("=".repeat(78));
  console.log("GAP-CLOSURE DECOMPOSITION — oracle catches up vs DEX reverts");
  console.log("=".repeat(78));

  const track = await getJson<{ receipts?: { arrows?: Arrow[] } }>(TRACK_URL);
  const arrows = track?.receipts?.arrows ?? [];
  const series = await getJson<{
    archive_start: string;
    complete: boolean;
    contiguous: boolean;
    totals: { days_with_data: number; points: number; rows: number };
    days: { day: string; status: string; points?: SeriesPoint[] }[];
  }>(SERIES_URL(SERIES_DAYS));

  const points: SeriesPoint[] = series.days.flatMap((d) => d.points ?? []);
  const graded = arrows.filter((a) => a.status === "graded");
  const gradedDrift = graded.filter((a) => a.type === "drift");

  console.log(`\narrows fetched      ${arrows.length}   graded ${graded.length}   graded drift ${gradedDrift.length}`);
  console.log(
    `archive             start=${series.archive_start} days_with_data=${series.totals.days_with_data}` +
      ` hourly_points=${series.totals.points} complete=${series.complete} contiguous=${series.contiguous}`,
  );

  // ── Part 1: structural facts, from the arrows themselves ──────────────────
  console.log(`\n${"─".repeat(78)}\nPART 1 — WHAT THE ENGINE CAN EVEN PRODUCE\n${"─".repeat(78)}`);
  const openAtFire = gradedDrift.filter((a) => a.market_at_fire?.is_open).length;
  const arbOpen = graded.filter((a) => a.type === "arb" && a.market_at_fire?.is_open).length;
  const arbTotal = graded.filter((a) => a.type === "arb").length;
  console.log(`graded drift fired while market OPEN : ${openAtFire}/${gradedDrift.length}`);
  console.log(`graded arb   fired while market OPEN : ${arbOpen}/${arbTotal}`);
  console.log(
    `\n  drift fires only when the market is CLOSED (rule-engine.ts: \`!row.market.is_open\`),\n` +
      `  so the oracle is FROZEN at fire by construction and the open-vs-closed slice for\n` +
      `  drift is empty by design, not by accident. arb is the market-open counterpart.`,
  );

  // ── Part 2: audit the input series ────────────────────────────────────────
  console.log(`\n${"─".repeat(78)}\nPART 2 — IS THE DEX SERIES A PRICE?\n${"─".repeat(78)}`);
  const health = auditTickers(points);
  const driftCount = new Map<string, { n: number; hits: number }>();
  for (const a of gradedDrift) {
    const c = driftCount.get(a.ticker) ?? { n: 0, hits: 0 };
    c.n++;
    if (a.outcome === "hit") c.hits++;
    driftCount.set(a.ticker, c);
  }

  console.log("ticker   hrs  frozen   dexvol%  oravol%  ratio  verdict   drift arrows");
  const healthRows = [...health.values()].sort(
    (a, b) => (driftCount.get(b.ticker)?.n ?? 0) - (driftCount.get(a.ticker)?.n ?? 0),
  );
  for (const h of healthRows) {
    const d = driftCount.get(h.ticker);
    console.log(
      `${h.ticker.padEnd(7)} ${String(h.hours).padStart(3)}  ${`${Math.round(h.frozen_frac * 100)}%`.padStart(5)}` +
        `   ${h.dex_vol_open.toFixed(2).padStart(6)}   ${h.oracle_vol_open.toFixed(2).padStart(6)}` +
        `  ${(h.noise_ratio === null ? "  n/a" : h.noise_ratio.toFixed(1) + "x").padStart(5)}` +
        `  ${h.verdict.padEnd(8)}  ${d ? `${d.hits}/${d.n} = ${pct(d.hits, d.n)}` : "—"}`,
    );
  }

  const bad = healthRows.filter((h) => h.verdict === "dead" || h.verdict === "noisy");
  const badArrows = bad.reduce((n, h) => n + (driftCount.get(h.ticker)?.n ?? 0), 0);
  console.log(
    `\ntickers flagged dead/noisy: ${bad.length}/${healthRows.length}` +
      ` — they account for ${badArrows}/${gradedDrift.length} graded drift arrows` +
      ` (${pct(badArrows, gradedDrift.length)})`,
  );
  console.log(
    `  dead  = dex print bit-identical across >= ${FROZEN_FRAC_DEAD * 100}% of consecutive archive hours (no trades)\n` +
      `  noisy = dex hourly vol >= ${NOISE_RATIO_BAD}x the ORACLE's over the same open hours (quote noise)`,
  );

  // ── Part 2b: is the gap stable enough to be "closed"? ─────────────────────
  console.log(`\n${"─".repeat(78)}\nPART 2b — IS THE GAP A STABLE QUANTITY?\n${"─".repeat(78)}`);
  const dyn = gapDynamics(points);
  console.log(
    `Sample: ${dyn.all.pairs} consecutive hour-pairs across ${dyn.per.length} tickers` +
      ` — independent of the arrow feed, so far better powered than Part 3.\n`,
  );
  console.log("ticker   pairs  lag1_autocorr  would_fire(>=2%)  >=50% closed 1h later  sign_flips  med|Δgap|");
  for (const g of dyn.per) {
    if (g.would_fire === 0 && g.ticker !== "ALL") continue;
    console.log(
      `${g.ticker.padEnd(7)} ${String(g.pairs).padStart(5)}  ` +
        `${(g.autocorr === null ? "n/a" : g.autocorr.toFixed(2)).padStart(13)}  ` +
        `${String(g.would_fire).padStart(16)}  ` +
        `${`${g.closed_half_1h} (${pct(g.closed_half_1h, g.would_fire)})`.padStart(21)}  ` +
        `${String(g.sign_flips).padStart(10)}  ${g.median_abs_delta.toFixed(2).padStart(8)}%`,
    );
  }
  const A = dyn.all;
  console.log(
    `\nALL     ${String(A.pairs).padStart(5)}  ${(A.autocorr ?? 0).toFixed(2).padStart(13)}  ` +
      `${String(A.would_fire).padStart(16)}  ` +
      `${`${A.closed_half_1h} (${pct(A.closed_half_1h, A.would_fire)})`.padStart(21)}  ` +
      `${String(A.sign_flips).padStart(10)}  ${A.median_abs_delta.toFixed(2).padStart(8)}%`,
  );
  console.log(
    `\nA gap of >= ${DRIFT_FIRE_PCT}% is >= 50% gone ONE HOUR LATER in ${fmtCI(A.closed_half_1h, A.would_fire)}\n` +
      `of cases, with no convergence process required — that is the flicker rate.\n` +
      `The published drift hit rate is the same event measured over a ${DRIFT_WINDOW_H}-REGULAR-HOUR\n` +
      `window. Compare the two before reading the hit rate as evidence of anything.`,
  );
  console.log(
    `\n⚠ The ALL-row autocorr (${(A.autocorr ?? 0).toFixed(2)}) is an ARTIFACT — pooling tickers whose\n` +
      `  gaps sit at different means makes the pooled series look persistent even when\n` +
      `  every individual ticker is memoryless. Read the per-ticker column only.`,
  );

  // ── Part 2c: what would firing on EVERY qualifying hour have scored? ───────
  console.log(`\n${"─".repeat(78)}\nPART 2c — NULL MODEL (fire on every qualifying hour)\n${"─".repeat(78)}`);
  const nm = nullModelHitRate(points);
  console.log(
    `Applies the engine's fire rule (closed AND |drift| >= ${DRIFT_FIRE_PCT}%) and the grader's\n` +
      `own clock (${DRIFT_WINDOW_H} regular hours, via the imported regularHoursElapsed) to every hour\n` +
      `in the archive — no cooldown, no one-arrow-per-ticker cap, no ticker selection.\n`,
  );
  console.log("ticker   eligible  gradable  hits  null hit rate [95% CI]");
  for (const n of nm.per) {
    if (n.gradable === 0) continue;
    console.log(
      `${n.ticker.padEnd(7)} ${String(n.eligible).padStart(9)} ${String(n.gradable).padStart(9)} ` +
        `${String(n.hits).padStart(5)}  ${fmtCI(n.hits, n.gradable)}`,
    );
  }
  const N = nm.all;
  console.log(
    `\nALL     ${String(N.eligible).padStart(9)} ${String(N.gradable).padStart(9)} ` +
      `${String(N.hits).padStart(5)}  ${fmtCI(N.hits, N.gradable)}`,
  );
  // The null model must NOT be compared against the all-time live rate: they
  // cover different weeks. Split the live arrows on the archive boundary so the
  // period-matched comparison is the one on screen, and its n is visible.
  const archIso = `${series.archive_start.slice(0, 4)}-${series.archive_start.slice(4, 6)}-${series.archive_start.slice(6, 8)}`;
  const inArch = gradedDrift.filter((a) => a.fired_at >= archIso);
  const preArch = gradedDrift.filter((a) => a.fired_at < archIso);
  const hits = (xs: Arrow[]) => xs.filter((a) => a.outcome === "hit").length;
  console.log(
    `\nlive engine, all time            ${fmtCI(hits(gradedDrift), gradedDrift.length)}\n` +
      `live engine, INSIDE archive      ${fmtCI(hits(inArch), inArch.length)}   ← the only period-matched cell\n` +
      `live engine, BEFORE archive      ${fmtCI(hits(preArch), preArch.length)}\n` +
      `null model,  INSIDE archive      ${fmtCI(N.hits, N.gradable)}`,
  );
  console.log(
    `\n⚠ Do NOT read "null ${pct(N.hits, N.gradable)} vs live ${pct(hits(gradedDrift), gradedDrift.length)}" as engine skill. Those are different\n` +
      `  weeks. The period-matched live cell is n=${inArch.length}, which decides nothing.\n` +
      `  The load-bearing fact here is the denominator: ${preArch.length}/${gradedDrift.length} published drift arrows\n` +
      `  fired BEFORE the archive existed, so no price history survives to audit them.\n` +
      `  The public hit rate is, today, almost entirely unverifiable after the fact.`,
  );

  // ── Part 3: decomposition ─────────────────────────────────────────────────
  console.log(`\n${"─".repeat(78)}\nPART 3 — DECOMPOSITION\n${"─".repeat(78)}`);
  const { rows, dropped } = decompose(arrows, points);
  console.log(`decomposable: ${rows.length}/${gradedDrift.length} graded drift arrows`);
  const byReason = new Map<string, number>();
  for (const d of dropped) {
    const k = d.reason.startsWith("graded ") ? "graded outside archive coverage" : d.reason.split(":")[0];
    byReason.set(k, (byReason.get(k) ?? 0) + 1);
  }
  console.log("excluded:");
  for (const [k, v] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(v).padStart(3)}  ${k}`);
  }
  const joinFails = dropped.filter((d) => d.reason.startsWith("join failed"));
  if (joinFails.length) {
    console.log(`\n  join-validation failures (archive vs grader disagree on the close gap):`);
    for (const d of joinFails) console.log(`    ${d.serial} ${d.ticker} — ${d.reason}`);
  }

  if (rows.length === 0) {
    console.log("\nNo decomposable rows. Nothing can be concluded about (a) vs (b) yet.");
    return;
  }

  console.log(
    `\nserial  ticker  out   sess        fire_gap  close_gap  Δoracle  Δdex   share_o  class`,
  );
  for (const r of rows.sort((a, b) => a.fired_at.localeCompare(b.fired_at))) {
    console.log(
      `${r.serial}  ${r.ticker.padEnd(6)}  ${r.outcome.padEnd(4)}  ${r.session.padEnd(10)}` +
        ` ${r.fire_gap_pct.toFixed(2).padStart(7)}%  ${r.close_gap_pct.toFixed(2).padStart(8)}%` +
        ` ${r.oracle_contrib_pct >= 0 ? "+" : ""}${r.oracle_contrib_pct.toFixed(2).padStart(6)}` +
        ` ${r.dex_contrib_pct >= 0 ? "+" : ""}${r.dex_contrib_pct.toFixed(2).padStart(6)}` +
        `  ${(r.share_oracle === null ? "  n/a" : r.share_oracle.toFixed(2)).padStart(6)}   ${r.klass}`,
    );
  }

  console.log(`\n${"─".repeat(78)}\nSLICES (each reports its own n; small n is stated, not smoothed)\n${"─".repeat(78)}`);
  printSlice("ALL", rows);
  printSlice("  outcome=hit", rows.filter((r) => r.outcome === "hit"));
  printSlice("  outcome=miss", rows.filter((r) => r.outcome === "miss"));
  for (const sess of [...new Set(rows.map((r) => r.session))].sort()) {
    printSlice(`  session=${sess}`, rows.filter((r) => r.session === sess));
  }
  const okTickers = new Set([...health.values()].filter((h) => h.verdict === "ok").map((h) => h.ticker));
  printSlice("  dex series OK only", rows.filter((r) => okTickers.has(r.ticker)));
  printSlice("  dex series dead/noisy", rows.filter((r) => !okTickers.has(r.ticker)));
  for (const t of [...new Set(rows.map((r) => r.ticker))].sort()) {
    printSlice(`  ticker=${t}`, rows.filter((r) => r.ticker === t));
  }

  // ── Verdict ───────────────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(78)}\nREADING\n${"─".repeat(78)}`);
  const closed = rows.filter((r) => r.klass !== "widened");
  const t = tally(rows);
  if (closed.length < 10) {
    console.log(
      `Only ${closed.length} arrows have a decomposable CLOSURE. That is below any\n` +
        `threshold at which (a)/(b)/(c) can be separated — the Wilson interval on a\n` +
        `proportion this small spans most of the unit interval. INSUFFICIENT DATA is\n` +
        `the honest answer; re-run once the archive has covered more grading windows.`,
    );
  }
  console.log(`\noracle-led ${fmtCI(t.oracle_led, closed.length)}`);
  console.log(`dex-led    ${fmtCI(t.dex_led, closed.length)}`);
  console.log(`mixed      ${fmtCI(t.mixed, closed.length)}`);
  console.log(`widened (gap grew, no closure to attribute): ${t.widened}`);
  const medShare = closed
    .map((r) => r.share_oracle!)
    .filter((x) => x !== null)
    .sort((a, b) => a - b);
  if (medShare.length) {
    console.log(
      `\nmedian share of closure done by the ORACLE: ${medShare[Math.floor(medShare.length / 2)].toFixed(2)}` +
        `   (1.00 = oracle did all of it, 0.00 = dex did all of it)`,
    );
  }

  // ── The tautology guard ───────────────────────────────────────────────────
  // A pool with no trades cannot move, so EVERY closure on it is "oracle-led"
  // by arithmetic rather than by price discovery. Counting those rows as
  // evidence for (b) would be circular. Strip them and re-report.
  const FROZEN_EPS = 0.01; // % of fire oracle — below this the dex simply did not move
  const tauto = closed.filter((r) => Math.abs(r.dex_contrib_pct) < FROZEN_EPS);
  const live = closed.filter((r) => Math.abs(r.dex_contrib_pct) >= FROZEN_EPS);
  if (tauto.length) {
    console.log(
      `\n⚠ TAUTOLOGY GUARD — ${tauto.length}/${closed.length} closures happened on a DEX print that did not\n` +
        `  move at all (|Δdex| < ${FROZEN_EPS}%): ${tauto.map((r) => `${r.serial} ${r.ticker}`).join(", ")}.\n` +
        `  On a pool with no trades, "oracle-led" is arithmetic, not price discovery —\n` +
        `  the oracle is the only thing that CAN move. Excluding them:`,
    );
    const lt = tally(live);
    console.log(`    oracle-led ${fmtCI(lt.oracle_led, live.length)}`);
    console.log(`    dex-led    ${fmtCI(lt.dex_led, live.length)}`);
    console.log(`    mixed      ${fmtCI(lt.mixed, live.length)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
