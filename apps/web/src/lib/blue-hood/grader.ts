/**
 * Blue Hood — arrow grader.
 *
 * Iterates every currently-open arrow whose grading window has elapsed
 * and hands it a verdict against a FRESH snapshot / M5 read. The engine
 * NEVER decides the outcome from stale numbers — we always re-read the
 * tool that fired it (spec: "graded by the same tools that fired it").
 *
 * P0.1 (2026-07-24) — GRADING CLOCK is market-aware.
 *   The window is measured in REGULAR-SESSION hours, not wall-clock
 *   hours. Chainlink stock feeds freeze while the market is closed, so
 *   the DEX↔oracle "gap" cannot close during those hours — a wall-clock
 *   grader inside a closed window produces guaranteed MISSes. The old
 *   #0040-#0047 drift cluster (fired 16:04-17:49 ET, graded 22:09-23:54
 *   ET, all inside closed market) is the canonical bug.
 *
 * Grading rules (spec Block 1.4):
 *   • drift: HIT if the DEX↔oracle gap closes ≥ 50% within the first
 *     `grading_window_h` REGULAR-session hours after the arrow fired.
 *     Fired outside regular hours → clock starts at next open.
 *     Fired inside regular hours → clock pauses at close, resumes next
 *     open. Same math for arb.
 *   • arb:   HIT if the spread falls below 0.5% within 4 regular-hours.
 *   • flow:  HIT if DEX price moves ≥ 1% in the expected direction
 *            within 24 wall-clock hours (flow does NOT freeze at close
 *            — it's a market-microstructure signal, not oracle-relative).
 *
 * All outcomes are hard-mapped in code; the LLM never sees these.
 */
import { kvGet, kvSet } from "@/lib/kv";
import { callTool } from "./tool-caller";
import {
  kvArrow,
  kvArrowOpenIndex,
  kvArrowOpenByTicker,
  kvArrowTickerCooldown,
  KV_ARROW_FEED,
  TTL_TICKER_COOLDOWN,
} from "./kv-keys";
import type { Arrow, ArrowOutcome, M5Verdict, ArrowType } from "./types";

// Nullable everywhere — M5 can return a shape with `verdict: "ERROR"` or
// `INSUFFICIENT_DATA` where these nested objects are missing/undefined.
// gradeOne must not assume any field is present; the pre-merge blocker
// (grader crashed on #0008 PLTR "Cannot read properties of null") was
// caused by treating these as guaranteed.
interface M5Response {
  verdict?: M5Verdict;
  ticker?: string;
  market?: { is_open?: boolean; session?: string };
  delta?: { pct?: number };
  chainlink?: { price_usd?: number };
  dex?: { price_usd?: number };
}

const ARB_HIT_SPREAD_PCT = 0.5;
const DRIFT_HIT_GAP_CLOSE_PCT = 0.5;

// ── P0.1: NYSE regular-hours clock ─────────────────────────────────────
// Rough conversion via fixed UTC-4 offset — ignores DST edges + market
// holidays. Same approximation the rest of the codebase uses
// (nyseMarketStatus in rwa-market.ts) so grader + M5 stay consistent.
// Anyone tightening one should tighten the other.
const REGULAR_OPEN_MIN = 9 * 60 + 30;  // 09:30 ET
const REGULAR_CLOSE_MIN = 16 * 60;     // 16:00 ET

function nyseOpenAt(tMs: number): boolean {
  const ny = new Date(tMs - 4 * 3600 * 1000);
  const day = ny.getUTCDay(); // 0=Sun..6=Sat
  if (day === 0 || day === 6) return false;
  const minutes = ny.getUTCHours() * 60 + ny.getUTCMinutes();
  return minutes >= REGULAR_OPEN_MIN && minutes < REGULAR_CLOSE_MIN;
}

/**
 * Regular-session hours elapsed between `fireIso` and `nowMs`. Samples
 * every 5 min — 4h window → 48 samples per arrow, 200 arrows/pass →
 * ~10k ops, cheap. Accuracy ±5min per arrow, fine for hour-scale windows.
 * flow arrows use wall-clock (24h) — caller decides which to use.
 */
export function regularHoursElapsed(fireIso: string, nowMs: number): number {
  const fireMs = new Date(fireIso).getTime();
  if (!Number.isFinite(fireMs) || nowMs <= fireMs) return 0;
  const STEP = 5 * 60 * 1000; // 5 min
  let acc = 0;
  for (let t = fireMs; t < nowMs; t += STEP) {
    if (nyseOpenAt(t)) acc += STEP;
  }
  return acc / 3_600_000;
}

/**
 * How the effective clock behaves per arrow type. flow (and future
 * whale) don't freeze at close — they read pool flow / holder deltas
 * that keep ticking after hours. Drift + arb DO freeze because the
 * Chainlink oracle they compare against is frozen.
 */
function elapsedForType(type: ArrowType, fireIso: string, nowMs: number): number {
  if (type === "drift" || type === "arb") {
    return regularHoursElapsed(fireIso, nowMs);
  }
  // flow / whale: wall-clock
  const fireMs = new Date(fireIso).getTime();
  if (!Number.isFinite(fireMs) || nowMs <= fireMs) return 0;
  return (nowMs - fireMs) / 3_600_000;
}

// ── Public API ─────────────────────────────────────────────────────────────
export interface GraderReport {
  graded: Arrow[];
  still_open: number;
  errored: string[]; // arrow ids that failed to grade this pass
}

export async function runGrader(): Promise<GraderReport> {
  const feed = (await kvGet<string[]>(KV_ARROW_FEED)) ?? [];
  const graded: Arrow[] = [];
  const errored: string[] = [];
  let still_open = 0;
  let skipped_seeded = 0;

  // Cap this pass at 200 arrows — grading is fast but we don't want a
  // 60s cron cycle to time out on an unbounded backlog.
  //
  // Widen try/catch scope: covers KV reads + Date parsing + gradeOne
  // + KV writes. Reviewer's rule: "grader runs 24/7 — one bad record
  // must not break the whole pass." A single crashed arrow lands in
  // `errored[]`; the loop continues.
  for (const id of feed.slice(0, 200)) {
    try {
      const arrow = await kvGet<Arrow>(kvArrow(id));
      if (!arrow || arrow.status !== "open") continue;

      // Bug fix (2026-07-21, pre-merge task #2): the poller was grading
      // seeded arrows (dummy `reference_price=100`) as HIT because
      // `gap closed 99%` was computed against fake input — e.g. #0006 SPY
      // "gap closed 99% (86.62% → 0.57%)" was purely `|100 - real_spy_price|`.
      // Public feed already filters origin !== "engine" so no user saw the
      // fake HITs, but the KV was polluted. Skip at the top of the loop so
      // seeded arrows never touch grader math again.
      //
      // Back-compat: legacy arrows without `origin` field are treated as
      // engine (per T-A #1) — the guard only skips EXPLICIT non-engine.
      if (arrow.origin && arrow.origin !== "engine") { skipped_seeded++; continue; }

      // P0.1 — market-aware window. Elapsed hours are counted only
      // during NYSE regular session for drift + arb (see elapsedForType).
      const fireMs = new Date(arrow.fired_at).getTime();
      if (!Number.isFinite(fireMs)) {
        console.warn(`[grader] arrow ${id} has malformed fired_at="${arrow.fired_at}" — skipping`);
        continue;
      }
      const elapsed = elapsedForType(arrow.type, arrow.fired_at, Date.now());
      if (elapsed < arrow.grading_window_h) { still_open++; continue; }

      const outcome = await gradeOne(arrow);
      if (!outcome) { still_open++; continue; }
      const nowIso = new Date().toISOString();
      const closed: Arrow = { ...arrow, status: "graded", outcome: outcome.outcome, graded_at: nowIso, outcome_detail: outcome.detail };
      await kvSet(kvArrow(id), closed);
      // Clear both open indexes so a new arrow can fire on this ticker.
      await kvSet(kvArrowOpenIndex(arrow.ticker, arrow.type), null, 1);
      await kvSet(kvArrowOpenByTicker(arrow.ticker),         null, 1);
      // P3.1 — start the 4h cooldown on this ticker so we don't fire a
      // drift right after grading an arb (or vice versa) on the same
      // symbol. Downstream engine reads this key + refuses.
      await kvSet(
        kvArrowTickerCooldown(arrow.ticker),
        { arrow_id: id, closed_at: nowIso },
        TTL_TICKER_COOLDOWN,
      );
      graded.push(closed);
    } catch (e) {
      // Any unexpected exception per-arrow — record and move on. The
      // outer runPollCycle wrapper is the last safety net but we should
      // never reach it for grader work.
      errored.push(`${id}: ${(e as Error).message}`);
      console.warn(`[grader] crash on ${id}: ${(e as Error).message}`);
    }
  }

  console.log(`[grader] graded=${graded.length} still_open=${still_open} skipped_seeded=${skipped_seeded} errored=${errored.length}`);

  return { graded, still_open, errored };
}

// ── P0.1 backfill ──────────────────────────────────────────────────────
export interface BackfillReport {
  scanned: number;
  voided: number;
  voided_ids: string[];
}

/**
 * Backfill for drift/arb arrows graded before their FULL regular-session
 * window elapsed. The narrow criterion (`reg_hrs < 0.5`) only caught
 * arrows graded entirely during closed market, but plenty of arrows fire
 * near the close, accumulate 0.5–3.5h regular hours before the grader's
 * wall-clock window pops, and get MISS/HIT verdicts that are still
 * artifacts of an under-elapsed clock. Example: #0039 INTC (arb, fired
 * 15:34 ET, graded 19:34 ET) had 0.43h regular vs 4h required — HIT
 * verdict was a coin-flip, not a signal.
 *
 * New rule (2026-07-24): void every drift/arb arrow where
 *   reg_hrs_at_grade < arrow.grading_window_h
 * regardless of outcome (both HIT and MISS become VOID). We accept the
 * hit-rate may drop — a small number measuring one standard is better
 * than a bigger one that mixes two.
 *
 * Idempotent — safe to run every cron tick; only touches arrows that are:
 *   - status: "graded"
 *   - outcome: "hit" or "miss" (already-void arrows are left alone)
 *   - type: "drift" or "arb" (flow/whale use wall-clock — not affected)
 *   - graded_at with reg_hrs elapsed < grading_window_h
 */
export async function backfillVoidGrades(): Promise<BackfillReport> {
  const feed = (await kvGet<string[]>(KV_ARROW_FEED)) ?? [];
  const voided_ids: string[] = [];
  let scanned = 0;
  for (const id of feed) {
    try {
      const arrow = await kvGet<Arrow>(kvArrow(id));
      if (!arrow) continue;
      scanned++;
      if (arrow.status !== "graded") continue;
      if (arrow.outcome !== "miss" && arrow.outcome !== "hit") continue;
      if (arrow.type !== "drift" && arrow.type !== "arb") continue;
      if (!arrow.graded_at) continue;
      const gradedMs = new Date(arrow.graded_at).getTime();
      if (!Number.isFinite(gradedMs)) continue;
      const regularHrs = regularHoursElapsed(arrow.fired_at, gradedMs);
      // Under-cooked: the arrow was graded before its regular-session
      // window fully elapsed. Verdict is an artifact, void it.
      if (regularHrs < arrow.grading_window_h) {
        const priorOutcome = arrow.outcome;
        const voided: Arrow = {
          ...arrow,
          outcome: "void",
          outcome_detail: `graded_before_window_elapsed · prior_outcome=${priorOutcome} · regular_hours=${regularHrs.toFixed(2)}h < ${arrow.grading_window_h}h (P0.1 backfill 2026-07-24)`,
        };
        await kvSet(kvArrow(id), voided);
        voided_ids.push(id);
      }
    } catch (e) {
      console.warn(`[grader-backfill] crash on ${id}: ${(e as Error).message}`);
    }
  }
  console.log(`[grader-backfill] scanned=${scanned} voided=${voided_ids.length}`);
  return { scanned, voided: voided_ids.length, voided_ids };
}

// ── Per-arrow grading ──────────────────────────────────────────────────────
async function gradeOne(arrow: Arrow): Promise<{ outcome: ArrowOutcome; detail: string } | null> {
  const r = await callTool<M5Response>("rh-stock-arb", { ticker: arrow.ticker });
  // Downgraded to a soft skip: throwing here dumped the arrow into
  // `errored[]` every cycle forever, and one bad ticker's rate-limit
  // could parade through the log endlessly. Return null → try again on
  // the next grader pass. `errored[]` is reserved for true crashes.
  if (!r.ok) return null;
  const now = r.data;

  // Pre-merge blocker fix — M5 sometimes returns partial data (missing
  // chainlink or dex object, or missing delta). The grader crashed on
  // #0008 PLTR with "Cannot read properties of null (reading
  // 'price_usd')" — one bad row must NEVER throw and break the whole
  // grader pass. Every M5 field is optional-chained; when we can't get
  // a usable read we return null (skip = try again next cycle) instead
  // of throwing.
  if (!now || typeof now !== "object") return null;
  const dex = now.dex?.price_usd ?? null;
  const oracle = now.chainlink?.price_usd ?? null;
  const deltaPct = typeof now.delta?.pct === "number" ? now.delta.pct : null;
  if (typeof dex !== "number" || dex <= 0) return null;
  if (typeof oracle !== "number" || oracle <= 0) return null;
  if (deltaPct === null) return null;

  if (arrow.type === "arb") {
    const spreadPct = Math.abs(deltaPct);
    if (spreadPct < ARB_HIT_SPREAD_PCT) {
      return { outcome: "hit", detail: `spread narrowed to ${spreadPct.toFixed(3)}% (< ${ARB_HIT_SPREAD_PCT}%)` };
    }
    return { outcome: "miss", detail: `spread still ${spreadPct.toFixed(3)}% (≥ ${ARB_HIT_SPREAD_PCT}%) after ${arrow.grading_window_h}h` };
  }

  if (arrow.type === "drift") {
    // Gap DEX↔oracle at fire time vs now. Positive gap on fire (DEX > oracle
    // by X%) closes ≥ 50% means |now_pct| ≤ 0.5 * |fire_pct|.
    // We don't store fire_pct explicitly (spec says "reference_price" is the
    // DEX price at fire), so approximate: we treat the current M5 spread as
    // the residual and compare to the reference_price / oracle ratio.
    const nowGapPct = Math.abs(deltaPct);
    const refPrice = arrow.reference_price;
    const fireGapPct = refPrice > 0 ? Math.abs((refPrice - oracle) / oracle) * 100 : 0;
    if (fireGapPct <= 0) return { outcome: "miss", detail: "no measurable fire-time gap" };
    const closedBy = 1 - nowGapPct / fireGapPct;
    if (closedBy >= DRIFT_HIT_GAP_CLOSE_PCT) {
      return { outcome: "hit", detail: `gap closed ${(closedBy * 100).toFixed(0)}% (${fireGapPct.toFixed(2)}% → ${nowGapPct.toFixed(2)}%)` };
    }
    return { outcome: "miss", detail: `gap only closed ${(closedBy * 100).toFixed(0)}% (${fireGapPct.toFixed(2)}% → ${nowGapPct.toFixed(2)}%)` };
  }

  // flow / whale — not yet in this commit; leave open.
  return null;
}
