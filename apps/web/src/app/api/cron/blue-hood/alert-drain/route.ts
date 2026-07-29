/**
 * Blue Hood — Telegram alert-drain cron (task 2.2).
 *
 * The "heart of the bot": drains 2.1's `bh:alert:pending` queue and DMs each
 * recipient. SEPARATE from the brief-worker on purpose:
 *   • alert delivery must NEVER slow or break the engine/worker — a different
 *     invocation guarantees that structurally;
 *   • it must retry temporarily-failed sends even on cycles where no arrow
 *     fired — the brief-worker early-returns on an empty brief queue, so
 *     piggybacking there would stall those retries.
 *
 * Per invocation:
 *   1. HEALTH GATE (before the batch): if the engine is BLIND (observable:false
 *      — a KV throttle) we do NOT drain. A half-readable KV can't be trusted to
 *      stamp delivery cursors, and a skipped drain simply retries next cycle;
 *      pending is left intact, nothing is lost. (Stale-but-readable is fine to
 *      drain: a pending record is a historical fact already health-gated at 2.1
 *      emit time, not a live read.)
 *   2. peekPendingAlerts(BATCH) — peek, not pop. An id leaves the queue only
 *      after a DEFINITE outcome.
 *   3. Per alert, resolve the recipient's Telegram id (1.7):
 *        • no link → PERMANENT skip: stamp delivered.telegram="skipped_no_tg"
 *          + removeFromPending (an unlinked wallet's alert can't wedge the queue).
 *        • linked → send the DM:
 *            – ok   → markAlertDelivered("telegram") + removeFromPending.
 *            – fail → KEEP in pending (temporary), log, retry next cycle.
 *
 * FIRE-AND-FORGET: every send is wrapped; a Telegram outage degrades delivery
 * only — it never throws out of this route, which always returns 200.
 *
 * Auth: `Authorization: Bearer $CRON_SECRET` (or `?secret=`) — same pattern as
 * the other Blue Hood crons.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  peekPendingAlerts,
  markAlertDelivered,
  markAlertSkipped,
  removeFromPending,
  type HoodAlert,
} from "@/lib/blue-hood/alerts";
import { tgUserForAddress } from "@/lib/blue-hood/watchlist";
import { computeEngineHealth } from "@/lib/blue-hood/health";
import { sendMessage, esc } from "@/lib/telegram/bot";
import { absoluteUrl } from "@/lib/site-url";

export const runtime = "nodejs";
export const maxDuration = 60;

const CRON_SECRET = process.env.CRON_SECRET ?? "";
const BATCH = Math.max(1, Math.min(25, Number(process.env.BH_ALERT_DRAIN_BATCH ?? "10")));

function isAuthorized(req: NextRequest): boolean {
  if (!CRON_SECRET) return process.env.NODE_ENV !== "production";
  const authHeader = req.headers.get("authorization") ?? "";
  const secretParam = new URL(req.url).searchParams.get("secret") ?? "";
  return authHeader === `Bearer ${CRON_SECRET}` || secretParam === CRON_SECRET;
}

/** Compose the DM body for one alert. Deep-links into the app — never a trade action. */
function renderAlert(a: HoodAlert): string {
  const url = a.url || absoluteUrl("/hood/inbox");
  const lines = [
    `🎯 <b>${esc(a.ticker)}</b> · <b>${esc(a.signal)}</b> <i>(${esc(a.kind)})</i>`,
    `Serial ${esc(a.serial)}`,
  ];
  if (a.brief) lines.push(``, esc(a.brief));
  lines.push(``, `<a href="${url}">Open in Blue Hood →</a>`);
  return lines.join("\n");
}

type RowOutcome = "delivered" | "skipped_no_tg" | "retry_kept" | "error_kept";

async function drainOne(a: HoodAlert): Promise<RowOutcome> {
  // Resolve the recipient's Telegram id (reverse link written by 1.7).
  const tgId = await tgUserForAddress(a.address);
  if (!tgId) {
    // Permanent skip — no Telegram link. Stamp + remove so it can't wedge forever.
    await markAlertSkipped(a.id, "telegram", "skipped_no_tg");
    await removeFromPending(a.id);
    return "skipped_no_tg";
  }
  const sent = await sendMessage(tgId, renderAlert(a));
  if (sent.ok) {
    await markAlertDelivered(a.id, "telegram");
    await removeFromPending(a.id);
    return "delivered";
  }
  // Temporary failure — KEEP in pending, retry next cycle (distinct from no_tg).
  console.warn(
    `[alert-drain] send failed id=${a.id} tg=${tgId} status=${sent.status ?? "-"} reason=${sent.description}`,
  );
  return "retry_kept";
}

async function handle(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const started = Date.now();

  // ── Health gate BEFORE the batch — don't drain when the engine is blind ──
  const health = await computeEngineHealth();
  if (!health.observable) {
    console.warn(`[alert-drain] skipped: engine blind (health=${health.status}) — pending left intact`);
    return NextResponse.json({
      ok: true,
      skipped: "engine_blind",
      health: { status: health.status, observable: false },
      duration_ms: Date.now() - started,
    });
  }

  let pending: HoodAlert[] = [];
  try {
    pending = await peekPendingAlerts(BATCH);
  } catch (e) {
    console.warn(`[alert-drain] peek failed: ${(e as Error).message}`);
  }
  if (pending.length === 0) {
    return NextResponse.json({ ok: true, processed: 0, duration_ms: Date.now() - started });
  }

  const tally: Record<RowOutcome, number> = {
    delivered: 0,
    skipped_no_tg: 0,
    retry_kept: 0,
    error_kept: 0,
  };
  for (const a of pending) {
    try {
      tally[await drainOne(a)]++;
    } catch (e) {
      // Absolute backstop — a per-row bug must not stop the batch or throw out.
      console.warn(`[alert-drain] drainOne crashed id=${a.id}: ${(e as Error).message}`);
      tally.error_kept++;
    }
  }

  console.log(
    `[alert-drain] done duration_ms=${Date.now() - started} peeked=${pending.length} ` +
      `delivered=${tally.delivered} skipped_no_tg=${tally.skipped_no_tg} ` +
      `retry_kept=${tally.retry_kept} error_kept=${tally.error_kept} health=${health.status}`,
  );

  return NextResponse.json({
    ok: true,
    processed: pending.length,
    ...tally,
    engine_health: { status: health.status, ok: health.ok, observable: health.observable },
    duration_ms: Date.now() - started,
  });
}

export const POST = handle;
export const GET = handle;
