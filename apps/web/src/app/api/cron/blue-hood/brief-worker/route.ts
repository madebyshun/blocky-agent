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
 *      goes back into `errored[]` but the cron always returns 200 so
 *      Vercel doesn't flag the schedule.
 *
 * Cadence: every 1 min. The poller runs every 2 min and can fire 0-3
 * arrows/cycle in practice; 8-batch × 1-min gives 4-8× headroom.
 *
 * Auth: `Authorization: Bearer $CRON_SECRET` — same pattern as the
 * other Blue Hood crons.
 */
import { NextRequest, NextResponse } from "next/server";
import { kvGet, kvSet } from "@/lib/kv";
import { KV_BRIEF_QUEUE, kvArrow } from "@/lib/blue-hood/kv-keys";
import { fetchArrowBrief } from "@/lib/blue-hood/brief";
import { pushArrowToAll } from "@/lib/blue-hood/push";
import { writeChatCard } from "@/lib/blue-hood/chat-card";
import { emitAlertsForArrow, type AlertHealthGate } from "@/lib/blue-hood/alerts";
import { computeEngineHealth } from "@/lib/blue-hood/health";
import { onArrowUpdated } from "@/lib/blue-hood/arrow-cache";
import type { Arrow } from "@/lib/blue-hood/types";

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
  status: "attached" | "failed" | "skipped_missing" | "skipped_already_done";
  llm_chain?: string;
  push_delivered?: number;
  push_gone?: number;
  /** 2.1 — watchlist alert fan-out outcome for this arrow. */
  alert_emitted?: number;
  alert_recipients?: number;
  alert_skipped?: boolean;
}

async function processOne(id: string, health: AlertHealthGate): Promise<WorkerRowResult> {
  const arrow = await kvGet<Arrow>(kvArrow(id));
  if (!arrow) {
    console.warn(`[brief-worker] arrow ${id} vanished from KV — dropping`);
    return { arrow_id: id, status: "skipped_missing" };
  }
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

  // Attempt brief. `fetchArrowBrief` never throws by contract — it
  // returns null on failure — but wrap in try just in case.
  let brief: Awaited<ReturnType<typeof fetchArrowBrief>> = null;
  try {
    brief = await fetchArrowBrief(arrow.ticker);
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

  const finalStatus: Arrow["brief_status"] = brief ? "attached" : "failed";
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
    status: finalStatus,
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

  // 2.1 health-gate — computed ONCE per invocation (2 KV reads), shared by every
  // arrow in the batch so we never re-probe per arrow. This is the same
  // computation behind /api/hood/health (1.3); calling the lib avoids a self-HTTP
  // hop. `health.ok` is false when the engine is blind (KV throttle) or stale —
  // `emitAlertsForArrow` then logs a traceable skip instead of alerting off bad
  // data. Never gates the brief attach or push; only the new alert fan-out.
  const health = await computeEngineHealth();
  if (!health.ok) {
    console.warn(`[alert] gate closed for this batch: health=${health.status} observable=${health.observable} — alerts will be skipped + logged per arrow`);
  }

  // Atomically pop the head of the queue: read → slice → write remainder.
  // Under Vercel serverless we don't have true CAS, but with 1-min
  // cadence + 1 cron instance this races only under manual concurrent
  // POSTs; a re-processed id short-circuits at the idempotency check.
  const queue = (await kvGet<string[]>(KV_BRIEF_QUEUE)) ?? [];
  if (queue.length === 0) {
    return NextResponse.json({
      ok: true,
      duration_ms: Date.now() - started,
      queue_len_before: 0,
      queue_len_after: 0,
      processed: 0,
      per_arrow: [],
    });
  }
  const batchIds = queue.slice(0, BATCH);
  const remainder = queue.slice(BATCH);
  await kvSet(KV_BRIEF_QUEUE, remainder);

  console.log(`[brief-worker] pop batch=${batchIds.length} queue_after=${remainder.length}`);

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

  const attached = per_arrow.filter((r) => r.status === "attached").length;
  const failed = per_arrow.filter((r) => r.status === "failed").length;
  const skipped = per_arrow.filter((r) => r.status.startsWith("skipped")).length;
  const alerts_emitted = per_arrow.reduce((n, r) => n + (r.alert_emitted ?? 0), 0);
  const alerts_gated = per_arrow.filter((r) => r.alert_skipped).length;
  console.log(
    `[brief-worker] done duration_ms=${Date.now() - started}` +
      ` attached=${attached} failed=${failed} skipped=${skipped}` +
      ` alerts_emitted=${alerts_emitted} alerts_gated=${alerts_gated}` +
      ` health=${health.status} queue_after=${remainder.length}`,
  );

  return NextResponse.json({
    ok: true,
    duration_ms: Date.now() - started,
    queue_len_before: queue.length,
    queue_len_after: remainder.length,
    processed: per_arrow.length,
    attached,
    failed,
    skipped,
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
