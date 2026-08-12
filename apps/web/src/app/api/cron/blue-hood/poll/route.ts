/**
 * Blue Hood — Poll cycle endpoint.
 *
 * Called by the 60s scheduler (GitHub Actions in prod, manual POST in dev).
 * Auth: `Authorization: Bearer $CRON_SECRET` or `?secret=$CRON_SECRET`.
 *
 * Response is intentionally minimal — the useful state lives in KV. The
 * caller only needs to know: did the cycle finish, how long did it take,
 * how many tickers errored.
 */
import { NextRequest, NextResponse } from "next/server";
import { persistSnapshot, runPollCycle } from "@/lib/blue-hood/poller";
import { runRuleEngine } from "@/lib/blue-hood/rule-engine";
import { runGrader, backfillVoidGrades, backfillDriftRegrade } from "@/lib/blue-hood/grader";
import { TOOL_CALLER_MODE } from "@/lib/blue-hood/tool-caller";
import { kvDel, kvGet, kvSet, kvSetNX } from "@/lib/kv";
import {
  KV_POLL_LOCK,
  TTL_POLL_LOCK,
  KV_POLL_HEARTBEAT,
  TTL_POLL_HEARTBEAT,
} from "@/lib/blue-hood/kv-keys";

export const runtime = "nodejs";
// Prod cycle observation (2026-07-21): with market open + 24 tokens ×
// (M5 read + Chainlink + DEX), real duration is ~246s — higher than the
// naive `24 × 3s stagger = 72s` estimate because per-token M5 work
// itself is 5-8s when the market is open (Chainlink round + GT fetch).
// vercel.json now runs poll every 5 min (not */2) AND we take a KV
// lock on entry — if a cycle is still running when the next tick
// fires, we no-op with a `[poller] skipped` log. Two-layer defence
// against overlap → GT burst → cascade of fetch_failed.
export const maxDuration = 300;

const CRON_SECRET = process.env.CRON_SECRET ?? "";

function isAuthorized(req: NextRequest): boolean {
  // Allow-list dev without a secret set (so `npm run dev` "just works").
  if (!CRON_SECRET) return process.env.NODE_ENV !== "production";
  const authHeader = req.headers.get("authorization") ?? "";
  const secretParam = new URL(req.url).searchParams.get("secret") ?? "";
  return authHeader === `Bearer ${CRON_SECRET}` || secretParam === CRON_SECRET;
}

async function handle(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Route heartbeat — written FIRST, before the lock, so a skipped tick still
  // records "the scheduler fired". This is the signal health.ts uses to tell
  // "cron dead" (this key stale) from "cron alive but every cycle failing"
  // (this fresh while the snapshot goes stale). Fire-and-forget: if KV is
  // throttled the write silently no-ops, but the read side (kvGetProbe) will
  // surface that same throttle as `kv_error`, so nothing is masked.
  await kvSet(KV_POLL_HEARTBEAT, { at: new Date().toISOString() }, TTL_POLL_HEARTBEAT);

  // Overlap guard. `kvSetNX(..., TTL_POLL_LOCK)` is atomic: only the first
  // caller in a window takes the lock; later ticks short-circuit with a 202.
  // The lock carries a TTL_POLL_LOCK (300s) expiry == the function's
  // maxDuration cap, so even a cycle hard-killed BEFORE its `finally kvDel`
  // runs cannot wedge the schedule — Redis drops the key within one cycle.
  // That TTL is the sole stale-lock defense and is sufficient by construction
  // (a lock can never outlive its own 300s expiry). We deliberately do NOT
  // force-reclaim on a failed SETNX: a failed KV *read* returns null exactly
  // like an empty lock, so "reclaim when unreadable" would nuke a live
  // cycle's lock whenever KV briefly errors.
  //
  // Historical note: the 2026-07-27 prod poll outage was NOT a stale/zombie
  // lock. The Upstash instance hit its 500K-request plan cap, so every KV
  // command threw → kvSetNX always returned false → every tick skipped and
  // the engine went dark. No code path can poll through a capped KV; the fix
  // was upgrading the Upstash plan, not lock logic.
  const lockStart = Date.now();
  const gotLock = await kvSetNX(KV_POLL_LOCK, { started_at: new Date().toISOString() }, TTL_POLL_LOCK);
  if (!gotLock) {
    const held = await kvGet<{ started_at?: string }>(KV_POLL_LOCK);
    const heldStart = held?.started_at ? new Date(held.started_at).getTime() : 0;
    const heldFor = heldStart ? Math.round((Date.now() - heldStart) / 1000) : -1;
    console.log(`[poller] skipped, previous cycle still running (${heldFor}s)`);
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: "cycle_in_progress",
      previous_cycle_started_at: held?.started_at ?? null,
      previous_cycle_age_s: heldFor,
    }, { status: 202 });
  }

  try {
    // 1. Fresh snapshot (M5 for the whole watchlist).
    const snap = await runPollCycle();
    await persistSnapshot(snap);

    // 2. Rule engine — fires arrows for any row that matches drift/arb rules.
    //    Deduped against open arrows via `bh:arrow:open:{ticker}:{type}`.
    const engine = await runRuleEngine(snap);

    // 3. Grader — closes any arrow whose grading window has elapsed.
    //    Runs after the engine so a just-fired arrow can't be graded in the
    //    same cycle (its window hasn't elapsed yet — guaranteed by construction).
    const grader = await runGrader();

    // 3b. P0.1 (2026-07-24) — one-shot idempotent backfill: any drift/arb
    //     graded MISS during a closed market becomes VOID (Chainlink was
    //     frozen so the gap literally could not close). Cheap KV pass;
    //     skips arrows already at outcome != "miss". Safe to run every cycle.
    const backfill = await backfillVoidGrades();

    // 3c. (2026-08-12) — idempotent regrade of drift arrows whose gap was
    //     measured against the grade-time oracle instead of the fire-time
    //     one. Guarded on `grading_math.basis`, so it converges after the
    //     first tick and is a no-op forever after.
    const regrade = await backfillDriftRegrade();

    return NextResponse.json({
      ok: true,
      mode: TOOL_CALLER_MODE,
      cycle_id: snap.cycle_id,
      duration_ms: snap.duration_ms,
      registry_total: snap.metrics.registry_total,
      tokens_watched: snap.metrics.tokens_watched,
      tokens_no_feed: snap.metrics.tokens_no_feed,
      tokens_errored: snap.metrics.tokens_errored,
      market_is_open: snap.metrics.market_is_open,
      market_session: snap.metrics.market_session,
      tvl_scanned_usd: Math.round(snap.metrics.tvl_scanned_usd),
      engine: {
        // Matches the structured `[engine]` log line one-to-one so responses
        // and logs can never disagree.
        candidates_over_threshold: engine.candidates_over_threshold,
        skipped_dust: engine.skipped_dust,
        skipped_no_executable_pool: engine.skipped_no_executable_pool,
        skipped_feed_stale: engine.skipped_feed_stale,
        below_threshold: engine.below_threshold,
        deduped: engine.deduped,
        fired: engine.fired,
        arrows: engine.arrows_fired.map((a) => ({ serial: a.serial, ticker: a.ticker, type: a.type, expected: a.expected_direction })),
      },
      grader: {
        graded: grader.graded.map((a) => ({ serial: a.serial, ticker: a.ticker, type: a.type, outcome: a.outcome, detail: a.outcome_detail })),
        still_open: grader.still_open,
        errored: grader.errored,
      },
      backfill: {
        scanned: backfill.scanned,
        voided: backfill.voided,
        voided_ids: backfill.voided_ids,
      },
      drift_regrade: {
        scanned: regrade.scanned,
        regraded: regrade.regraded,
        flipped: regrade.flipped,
        flipped_ids: regrade.flipped_ids,
        unmeasurable: regrade.unmeasurable,
      },
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message, stack: (e as Error).stack?.slice(0, 400) },
      { status: 500 },
    );
  } finally {
    // Always release the lock — even on crash — so a broken cycle
    // never wedges the schedule for TTL_POLL_LOCK minutes.
    await kvDel(KV_POLL_LOCK).catch(() => { /* swallow; TTL will expire it */ });
    const held = Math.round((Date.now() - lockStart) / 1000);
    console.log(`[poller] lock released after ${held}s`);
  }
}

// POST is the primary path (CI + Vercel Cron). GET is allowed for the same
// bearer so a human can hit it in a browser tab during local dev — same
// pattern as the other cron routes.
export const POST = handle;
export const GET = handle;
