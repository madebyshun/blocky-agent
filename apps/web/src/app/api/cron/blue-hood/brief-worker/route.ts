/**
 * Blue Hood — async brief-attach worker (T-D refactor).
 *
 * The reviewer's pre-prod TODO: A4 brief fetch was blocking `fireArrow`
 * for 5-15s per arrow. This cron drains the `bh:brief:queue` written by
 * the (now-fast) fire path.
 *
 * Per invocation:
 *   1. Pop up to `BH_BRIEF_BATCH` (default 8) ids off the queue FIFO.
 *   2. For each id: load the arrow → fetch A4 brief → merge → persist.
 *   3. After brief attach (success OR failure), write the chat card and
 *      run the push fan-out — both wait so the notification body includes
 *      the final headline.
 *   4. Log a one-line `[brief-worker]` summary. Never throws — a bad row
 *      goes back into `errored[]` but the cron returns 200 so Vercel
 *      doesn't flag the schedule.
 *
 * ═══ WHAT "COULD NOT READ" MEANS HERE (#150) ═══
 *
 * A pop is destructive: once an id leaves `bh:brief:queue` this worker is the
 * only thing that can still attach that arrow's brief. So every read on this
 * path has to answer three questions, not two — present, absent, or unknown —
 * because the two ways of "not getting a value" have opposite correct actions:
 *
 *   • the arrow record read (`processOne`) — a genuine `miss` drops the id (an
 *     arrow really can outlive its 30d TTL); a KV `error` returns
 *     `deferred_kv_unavailable` and the id is put BACK on the queue.
 *   • the queue read itself (`handle`)     — a genuine empty returns the usual
 *     200 with `processed: 0`; a KV `error` returns **503 `kv_unavailable`**
 *     and processes nothing. This is the one deliberate exception to the 200
 *     rule above: that rule protects the schedule from ONE bad row, and this
 *     is the worker unable to see the queue at all.
 *
 * The rule in one line: never let a failed read be reported as an empty one.
 *
 * Cadence: every 1 min. The poller runs every 2 min and can fire 0-3
 * arrows/cycle in practice; 8-batch × 1-min gives 4-8× headroom.
 *
 * Auth: `Authorization: Bearer $CRON_SECRET` — same pattern as the
 * other Blue Hood crons.
 */
import { NextRequest, NextResponse } from "next/server";
import { kvGetProbe, kvSet, kvMutate } from "@/lib/kv";
import { KV_BRIEF_QUEUE, kvArrow } from "@/lib/blue-hood/kv-keys";
import { fetchArrowBrief, hasBriefPath } from "@/lib/blue-hood/brief";
import { pushArrowToAll } from "@/lib/blue-hood/push";
import { writeChatCard } from "@/lib/blue-hood/chat-card";
import { emitAlertsForArrow, type AlertHealthGate } from "@/lib/blue-hood/alerts";
import { computeEngineHealth } from "@/lib/blue-hood/health";
import { onArrowUpdated } from "@/lib/blue-hood/arrow-cache";
import { chainOf, type Arrow } from "@/lib/blue-hood/types";

export const runtime = "nodejs";
export const maxDuration = 120;

const CRON_SECRET = process.env.CRON_SECRET ?? "";
const BATCH = Math.max(1, Math.min(20, Number(process.env.BH_BRIEF_BATCH ?? "8")));

function isAuthorized(req: NextRequest): boolean {
  if (!CRON_SECRET) return process.env.NODE_ENV !== "production";
  const authHeader = req.headers.get("authorization") ?? "";
  const secretParam = new URL(req.url).searchParams.get("secret") ?? "";
  return authHeader === `Bearer ${CRON_SECRET}` || secretParam === CRON_SECRET;
}

interface WorkerRowResult {
  arrow_id: string;
  serial?: string;
  ticker?: string;
  /**
   * The WORKER's report on this queue entry — deliberately NOT the same
   * vocabulary as `Arrow["brief_status"]`, which is the state persisted on the
   * arrow. They overlap on "attached"/"failed" and diverge on the skips,
   * because the worker distinguishes WHY it skipped and the arrow record does
   * not care. Keep them separate: reusing `skipped_already_done` for a Base
   * arrow would put a false cause in the ops log — the same bug this PR fixes
   * one layer down, where "failed" was a false cause in the UI.
   */
  status:
    | "attached"
    | "failed"
    | "skipped_missing"
    | "skipped_already_done"
    | "skipped_no_brief_path"
    /**
     * #150 — the arrow could not be READ, so nothing at all is known about it.
     * Deliberately NOT a `skipped_*` value: every other skip means "we looked
     * and decided not to", and the `startsWith("skipped")` aggregate below
     * counts them as handled. This one means the opposite — we never looked,
     * and the id goes BACK on the queue. Naming it `skipped_*` would file a
     * retry under "done" in the same log line that exists to spot the outage.
     */
    | "deferred_kv_unavailable";
  llm_chain?: string;
  push_delivered?: number;
  push_gone?: number;
  /** 2.1 — watchlist alert fan-out outcome for this arrow. */
  alert_emitted?: number;
  alert_recipients?: number;
  alert_skipped?: boolean;
}

async function processOne(id: string, health: AlertHealthGate): Promise<WorkerRowResult> {
  // #150 A-part2 — THE destructive read in this file, and it is not the one the
  // triage flagged. `kvGet` collapses "key absent" and "the KV command threw"
  // into the same `null`, and the branch below turned that null into the
  // sentence `arrow ${id} vanished from KV — dropping`. By the time we get here
  // `handle()` has ALREADY popped this id off `bh:brief:queue`, so "dropping"
  // was literal and permanent: one throttled read cost a live arrow its A4
  // brief forever, and the log asserted a falsehood about the record to explain
  // it. Note the asymmetry that makes this obviously wrong — `rule-engine.ts`
  // already guards the APPEND to this same queue with `kvMutate`; only the
  // drain was unprotected, so the queue was safe to fill and unsafe to empty.
  //
  // `kvGetProbe` is what lets the two answers be different answers. A genuine
  // `miss` still drops (an arrow really can outlive its 30d TTL); an `error`
  // defers and `handle()` puts the id back.
  const probe = await kvGetProbe<Arrow>(kvArrow(id));
  if (probe.status === "error") {
    console.error(
      `[brief-worker] arrow ${id} NOT read — KV error: ${probe.message}; re-queueing, no brief attempted`,
    );
    return { arrow_id: id, status: "deferred_kv_unavailable" };
  }
  if (probe.status === "miss") {
    console.warn(`[brief-worker] arrow ${id} vanished from KV — dropping`);
    return { arrow_id: id, status: "skipped_missing" };
  }
  const arrow = probe.value;
  // Idempotency: if a previous invocation already attached, skip.
  if (arrow.brief_status === "attached" || arrow.brief_status === "skipped") {
    return {
      arrow_id: id,
      serial: arrow.serial,
      ticker: arrow.ticker,
      status: "skipped_already_done",
    };
  }
  const workerAt = new Date().toISOString();

  // The arrow's own chain, not a literal. `chainOf` supplies the documented
  // absent⟹"robinhood" default that keeps every pre-Base arrow behaving
  // byte-identically.
  const arrowChain = chainOf(arrow);
  // Whether a wrong-chain brief is even possible for this arrow. Split out
  // from `brief === null` because the two mean different things downstream:
  // "A4 was asked and could not answer" vs "A4 was never the right thing to
  // ask". Conflating them is how a Base arrow ends up telling a reader that
  // the LLM chain failed, when in truth we deliberately declined.
  const briefable = hasBriefPath(arrowChain);

  // Attempt brief. `fetchArrowBrief` never throws by contract — it
  // returns null on failure — but wrap in try just in case.
  let brief: Awaited<ReturnType<typeof fetchArrowBrief>> = null;
  try {
    brief = await fetchArrowBrief(arrow.ticker, arrowChain);
  } catch (e) {
    console.warn(`[brief-worker] fetch crashed for ${arrow.serial} ${arrow.ticker}: ${(e as Error).message}`);
  }

  // Pre-merge task #8 — reconcile A4's attach-time reads with the arrow's
  // FIRE-time snapshot. Two moves:
  //
  // 1. `facts_at_fire`: swap A4's `facts.dex/oracle/tvl/vol` (read at
  //    attach time, ~1-2 min after fire → possibly stale) for the
  //    arrow's `snapshot_at_fire` captured verbatim from the poll row
  //    that fired the arrow. This is what the UI's facts strip renders.
  //
  // 2. `one_line_context` contradiction detection: if A4's context talks
  //    about "market closed" / "premarket" / "afterhours" / "NOT arb"
  //    but the arrow was fired during regular session with type=arb,
  //    that context is DEMONSTRABLY wrong (attach-time market != fire-
  //    time market). Null the context out and mark
  //    `brief.warnings += ["context_stale_at_attach: A4 read attach-
  //     time market, arrow fired at <fire-time>"]` so the reader sees
  //    exactly what happened. The verdict_note (deterministic hard-map)
  //    stays — it was built from the arrow's own signal, not from A4's
  //    attach read.
  if (brief) {
    // Null-guard every field on `snapshot_at_fire`. Legacy arrows fired
    // before commit 7774f44 don't have this object; new arrows always
    // do but the sub-fields can still be null on partial-data rows.
    // `??` falls through to A4's attach-time value when the fire-time
    // value isn't available.
    const snap = arrow.snapshot_at_fire;
    if (snap) {
      brief = { ...brief, facts_at_fire: {
        dex_price_usd: snap.dex_price_usd ?? brief.facts_at_fire.dex_price_usd,
        oracle_price_usd: snap.oracle_price_usd ?? brief.facts_at_fire.oracle_price_usd,
        dex_tvl_usd: snap.dex_tvl_usd ?? brief.facts_at_fire.dex_tvl_usd,
        dex_volume_24h_usd: snap.dex_volume_24h_usd ?? brief.facts_at_fire.dex_volume_24h_usd,
        // Poll row doesn't currently carry these two; A4's attach-time
        // read is the best available signal. `??` in case A4 also
        // omitted them.
        dex_change_24h_pct: brief.facts_at_fire.dex_change_24h_pct ?? snap.dex_change_24h_pct ?? null,
        chainlink_age_seconds: brief.facts_at_fire.chainlink_age_seconds ?? snap.chainlink_age_seconds ?? null,
      }};
    }
    if (arrow.market_at_fire && brief.one_line_context) {
      const contradicted = detectMarketContradiction(brief.one_line_context, arrow);
      if (contradicted) {
        const warn = `context_stale_at_attach: ${contradicted} — arrow fired at ${arrow.fired_at} during session=${arrow.market_at_fire.session} (is_open=${arrow.market_at_fire.is_open})`;
        brief = {
          ...brief,
          one_line_context: null,
          warnings: [...brief.warnings, warn],
        };
        console.warn(`[brief-worker] contradiction on ${arrow.serial} ${arrow.ticker}: ${contradicted}`);
      }
    }
  }

  // Three outcomes, not two. `"failed"` is a claim — the UI renders it as "A4
  // chain failed for this arrow" — and that claim is false for a desk we never
  // asked. A Base arrow lands `"skipped"`: no brief, and no invented reason for
  // why. (Everything BELOW this line still runs for it — chat card, push
  // fan-out, watchlist alerts. Declining the brief must not mute the desk.)
  // `Extract` rather than the full `Arrow["brief_status"]`: it still fails the
  // build if any of these three stops being a legal arrow status (catching a
  // typo or a renamed enum member), but it excludes "pending", which this line
  // provably never produces. The narrower type is what lets the worker-report
  // mapping below be exhaustive instead of needing a dead default arm.
  const finalStatus: Extract<Arrow["brief_status"], "attached" | "failed" | "skipped"> =
    brief ? "attached" : briefable ? "failed" : "skipped";
  const enriched: Arrow = {
    ...arrow,
    brief: brief ?? null,
    brief_status: finalStatus,
    brief_worker_at: workerAt,
  };
  await kvSet(kvArrow(id), enriched);
  // #148 ② — THE most important patch site in the set. `onArrowFired` put this
  // arrow into the hydrated blob seconds ago with `brief: null,
  // brief_status: "pending"`; this line is where the brief actually arrives.
  // Skip the patch and the blob keeps serving a permanently briefless arrow for
  // the full 6h TTL — the arrow would render, but the analysis that makes it
  // worth reading never would. Must run BEFORE the push fan-out below, so a
  // user who taps the notification within a second lands on the enriched copy.
  await onArrowUpdated(enriched);

  const chainStr = brief
    ? (brief.llm_attempts.map((a) => `${a.provider}:${a.status}`).join("→") || "n/a")
    : "n/a";
  console.log(
    `[brief-worker] arrow=${enriched.serial} ticker=${enriched.ticker}` +
      ` status=${finalStatus} llm=${brief?.llm_provider ?? "null"}` +
      ` chain=${chainStr} note_len=${brief?.verdict_note.length ?? 0}`,
  );

  // Chat card ALWAYS written (even on brief failure) — the card carries
  // an empty headline and the chat renderer will fall through to the
  // ticker/signal tag. Best-effort; swallow errors internally.
  await writeChatCard(enriched);

  // Push fan-out — only engine origin. Guarded twice: skipAsync arrows
  // never get here, and engine-vs-seeded is re-checked inside
  // `pushArrowToAll` for defense-in-depth.
  let deliveryStats: { delivered: number; gone: number } = { delivered: 0, gone: 0 };
  if (enriched.origin === "engine") {
    try {
      const stats = await pushArrowToAll(enriched);
      deliveryStats = { delivered: stats.delivered, gone: stats.gone };
    } catch (e) {
      console.warn(`[brief-worker] push fan-out crashed for ${enriched.serial}: ${(e as Error).message}`);
    }
  }

  // 2.1 — watchlist-targeted alert fan-out. Rides the SAME async rails as push
  // (never on the poll cycle) and is FIRE-AND-FORGET: `emitAlertsForArrow` never
  // throws, and this try/catch is defense in depth so an alert failure can NEVER
  // break the arrow-fire path. `health` is computed once per invocation and gates
  // emission — a blind/stale engine logs a traceable skip instead of alerting off
  // bad data. Guarded on engine origin like push (emit self-checks too).
  let alertOut: { emitted: number; recipients: number; skipped: boolean } = { emitted: 0, recipients: 0, skipped: false };
  if (enriched.origin === "engine") {
    try {
      const r = await emitAlertsForArrow(enriched, health);
      alertOut = { emitted: r.emitted, recipients: r.recipients, skipped: r.skipped };
    } catch (e) {
      console.warn(`[alert] failed arrow=${enriched.serial} arrow_id=${enriched.id}: ${(e as Error).message}`);
    }
  }

  return {
    arrow_id: id,
    serial: enriched.serial,
    ticker: enriched.ticker,
    // Translate arrow-state → worker-report. Not an alias: `finalStatus`
    // "skipped" collapses every no-brief-on-purpose case, while the worker log
    // wants the specific reason. `skipped_no_brief_path` is counted by the
    // `startsWith("skipped")` aggregate below with no further wiring.
    status: finalStatus === "skipped" ? "skipped_no_brief_path" : finalStatus,
    llm_chain: chainStr,
    push_delivered: deliveryStats.delivered,
    push_gone: deliveryStats.gone,
    alert_emitted: alertOut.emitted,
    alert_recipients: alertOut.recipients,
    alert_skipped: alertOut.skipped,
  };
}

async function handle(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const started = Date.now();

  // Pop the head of the queue: read → slice → write remainder.
  // Under Vercel serverless we don't have true CAS, but with 1-min
  // cadence + 1 cron instance this races only under manual concurrent
  // POSTs; a re-processed id short-circuits at the idempotency check.
  //
  // #150 A-part2 — this was `kvGet ?? []` → early-return-if-empty → `kvSet`.
  // It is NOT the destructive member of the family: the `length === 0` return
  // fired before the write, so a throttled read never wiped the queue. It was
  // the HONESTY half, and that is not a lesser bug. A KV error answered
  // `{ok:true, queue_len_before:0, processed:0}` — a worker that never managed
  // to look, publishing "there was nothing to do" as fact, in the exact
  // sentence shape #148 spent an outage on. `kvMutate` gives the read three
  // answers instead of one, and `unchanged` below is the only honest empty.
  let batchIds: string[] = [];
  let queueLenBefore = 0;
  let remainderLen = 0;
  const popRes = await kvMutate<string[]>(KV_BRIEF_QUEUE, [], (queue) => {
    queueLenBefore = queue.length;
    if (queue.length === 0) return null; // genuinely empty — write nothing
    batchIds = queue.slice(0, BATCH);
    const remainder = queue.slice(BATCH);
    remainderLen = remainder.length;
    return remainder;
  });

  if (popRes === "skipped" || popRes === "failed") {
    // Two different failures, one correct response: do not process anything.
    //   • "skipped" — the READ failed. We do not know what is in the queue, and
    //     the ids we would invent are `[]`.
    //   • "failed"  — the read landed but the remainder never persisted, so
    //     every id is STILL queued. Processing them now would attach briefs the
    //     next tick re-attaches, against a KV that just proved it cannot write.
    // Bailing costs one minute of latency. The alternative costs the briefs.
    console.error(`[brief-worker] queue NOT drained (${popRes}) — KV unavailable; nothing processed`);
    // 503, not the module header's usual 200. That rule is about a bad ROW —
    // one arrow must not flag the schedule. This is the worker unable to read
    // its own queue, which is precisely the condition a cron failure surface
    // exists to show, and #148 is what a silent version of it costs.
    // `hood-kick-crons.ts` already treats a non-200 here as a warning, not a
    // fatal, so nothing downstream breaks on it.
    return NextResponse.json({
      ok: false,
      code: "kv_unavailable",
      reason: popRes === "skipped" ? "queue read failed" : "queue write failed",
      duration_ms: Date.now() - started,
      processed: 0,
      per_arrow: [],
    }, { status: 503 });
  }

  if (popRes === "unchanged") {
    // The one honest empty: the read LANDED and the queue really is empty.
    return NextResponse.json({
      ok: true,
      duration_ms: Date.now() - started,
      queue_len_before: 0,
      queue_len_after: 0,
      processed: 0,
      per_arrow: [],
    });
  }

  console.log(`[brief-worker] pop batch=${batchIds.length} queue_after=${remainderLen}`);

  // 2.1 health-gate — computed ONCE per invocation (2 KV reads), shared by every
  // arrow in the batch so we never re-probe per arrow. This is the same
  // computation behind /api/hood/health (1.3); calling the lib avoids a self-HTTP
  // hop. `health.ok` is false when the engine is blind (KV throttle) or stale —
  // `emitAlertsForArrow` then logs a traceable skip instead of alerting off bad
  // data. Never gates the brief attach or push; only the new alert fan-out.
  //
  // Moved BELOW the pop (#150): this cron ticks every 60s and the queue is empty
  // on most of them, so probing health first spent 3 KV commands on a tick that
  // needs 1 — ~2,880 wasted commands/day against the budget that has suspended
  // this engine three times. It also logged "alerts will be skipped per arrow"
  // for batches with no arrows. Nothing below reads `health` before this line.
  const health = await computeEngineHealth();
  if (!health.ok) {
    console.warn(`[alert] gate closed for this batch: health=${health.status} observable=${health.observable} — alerts will be skipped + logged per arrow`);
  }

  // Sequential — A4 upstreams (Virtuals/Venice/Bankr) are rate-limited
  // per-key; parallel would just serialize on their side and cost more
  // in retries. 8 × ~4s ≈ 32s wall time, well under maxDuration=120.
  const per_arrow: WorkerRowResult[] = [];
  for (const id of batchIds) {
    try {
      per_arrow.push(await processOne(id, health));
    } catch (e) {
      console.warn(`[brief-worker] processOne crashed for ${id}: ${(e as Error).message}`);
      per_arrow.push({ arrow_id: id, status: "failed" });
    }
  }

  // #150 — a deferred row was never read, so it was never processed. It was
  // already popped, so unless it goes back it is gone. Re-append here rather
  // than inside `processOne` for two reasons:
  //   • ONE kvMutate for the whole batch. The condition that produces deferrals
  //     IS a KV budget failure; answering it with N more commands per batch is
  //     the wrong direction.
  //   • TAIL, not head. A permanently unreadable id parked at the head would
  //     starve every arrow behind it on every tick, which converts one bad row
  //     into a stalled queue — the FIFO note in `kv-keys.ts` is about fairness
  //     among healthy ids, and this is what keeps it true when one is not.
  const deferred = per_arrow.filter((r) => r.status === "deferred_kv_unavailable").map((r) => r.arrow_id);
  let requeued = 0;
  if (deferred.length > 0) {
    const reRes = await kvMutate<string[]>(KV_BRIEF_QUEUE, [], (queue) => {
      // A concurrent fire may already have re-added one; `rule-engine.ts`
      // guards its own append the same way. Nothing to add ⇒ nothing to write.
      const missing = deferred.filter((did) => !queue.includes(did));
      if (missing.length === 0) return null;
      requeued = missing.length;
      return [...queue, ...missing];
    });
    if (reRes === "skipped" || reRes === "failed") {
      requeued = 0;
      console.error(
        `[brief-worker] ${deferred.length} deferred arrow(s) NOT re-queued (${reRes}) — ` +
          `their briefs are lost unless re-enqueued by hand: ${deferred.join(",")}`,
      );
    }
  }

  const attached = per_arrow.filter((r) => r.status === "attached").length;
  const failed = per_arrow.filter((r) => r.status === "failed").length;
  const skipped = per_arrow.filter((r) => r.status.startsWith("skipped")).length;
  const alerts_emitted = per_arrow.reduce((n, r) => n + (r.alert_emitted ?? 0), 0);
  const alerts_gated = per_arrow.filter((r) => r.alert_skipped).length;
  const queueLenAfter = remainderLen + requeued;
  console.log(
    `[brief-worker] done duration_ms=${Date.now() - started}` +
      ` attached=${attached} failed=${failed} skipped=${skipped}` +
      ` deferred=${deferred.length} requeued=${requeued}` +
      ` alerts_emitted=${alerts_emitted} alerts_gated=${alerts_gated}` +
      ` health=${health.status} queue_after=${queueLenAfter}`,
  );

  return NextResponse.json({
    // A batch where every row deferred processed nothing — say so in the field
    // callers actually branch on, rather than letting `processed: N` imply work.
    ok: deferred.length < per_arrow.length || per_arrow.length === 0,
    ...(deferred.length > 0 ? { code: "kv_unavailable" } : {}),
    duration_ms: Date.now() - started,
    queue_len_before: queueLenBefore,
    queue_len_after: queueLenAfter,
    processed: per_arrow.length,
    attached,
    failed,
    skipped,
    /** #150 — popped but never read. Re-queued; NOT counted as skipped/failed. */
    deferred: deferred.length,
    requeued,
    alerts_emitted,
    alerts_gated,
    engine_health: { status: health.status, ok: health.ok, observable: health.observable },
    per_arrow,
  });
}

export const POST = handle;
export const GET = handle;

/**
 * Return the specific contradiction string when A4's `one_line_context`
 * describes a market state that disagrees with the arrow's fire-time
 * `market_at_fire` — or null when the text is compatible with fire-time
 * state. Deliberately narrow: only flags phrases we KNOW map to a
 * specific market state, so a benign mention of "closed" (e.g. "closed
 * gap") doesn't false-fire.
 *
 * Cases handled:
 *   - "market closed" / "market is closed"     → contradicts is_open=true
 *   - "premarket" / "pre-market"                → contradicts session=regular/afterhours
 *   - "afterhours" / "after-hours" / "after hours" → contradicts session=regular/premarket
 *   - "NOT arb" / "not arb"                    → contradicts arrow.type="arb"
 */
function detectMarketContradiction(context: string, arrow: Arrow): string | null {
  if (!arrow.market_at_fire) return null;
  const lower = context.toLowerCase();
  const { is_open, session } = arrow.market_at_fire;

  if (/(market\s+(is\s+)?closed|market\s+closed)/i.test(lower) && is_open) {
    return `context says "market closed" but arrow fired with market open`;
  }
  if (/pre[-\s]?market/.test(lower) && session !== "premarket") {
    return `context says "premarket" but arrow fired in session=${session}`;
  }
  if (/after[-\s]?hours/.test(lower) && session !== "afterhours") {
    return `context says "afterhours" but arrow fired in session=${session}`;
  }
  if (/\bnot\s+arb\b/i.test(lower) && arrow.type === "arb") {
    return `context says "NOT arb" but arrow type is arb`;
  }
  return null;
}
