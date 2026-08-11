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

// ── DM formatting helpers ────────────────────────────────────────────────────
// All tolerate null/undefined and NEVER fabricate a number — a missing fact
// renders as an omitted line, not a zero.

/** Price in USD. 2 dp for ≥$1, 4 dp sub-dollar, 0 dp for ≥$1k. Null when absent. */
function usd(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  const abs = Math.abs(n);
  const dp = abs >= 1000 ? 0 : abs >= 1 ? 2 : 4;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
}

/** Compact USD for TVL — $5.3M, $1.2B, $980. Null when absent. */
function usdCompact(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

/** Signed percent, one decimal — "+2.1%" / "-0.8%". Null when absent. */
function pctSigned(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}

/** Direction glyphs from the signal label (fallback: drift sign). */
function trendGlyphs(a: HoodAlert): { dot: string; arrow: string } {
  const s = a.signal.toLowerCase();
  let up: boolean | null = null;
  if (s.includes("↑") || s.includes("long") || s.includes("buy")) up = true;
  else if (s.includes("↓") || s.includes("short") || s.includes("sell")) up = false;
  else if (a.drift_pct != null && Number.isFinite(a.drift_pct)) up = a.drift_pct >= 0;
  if (up === true) return { dot: "🟢", arrow: "📈" };
  if (up === false) return { dot: "🔴", arrow: "📉" };
  return { dot: "🔵", arrow: "" };
}

/**
 * Compose the DM body for one alert (Telegram HTML parse mode). Mirrors the
 * 2.2b spec card:
 *
 *   🟢 $NVDA · 📈 DRIFT ↑ +2.1% · DEX
 *   Oracle $197.78 → DEX $201.90 · TVL $5.3M
 *
 *   `0x322f…3b2d`          ← canonical CA in a <code> block (tap-to-copy)
 *   ✓ verified canonical   ← ONLY when the ticker is a registry token
 *
 *   Open in Blue Hood →    ← deep-link into the inbox, NEVER a trade venue
 *
 * Every numeric line is omitted (not zeroed) when its fact is null. The
 * "verified" line is gated on `a.verified` — the CA comes from the hand-curated,
 * Blockscout-verified RWA registry, so a match legitimately IS canonical; we
 * NEVER print "verified" without one.
 */
function renderAlert(a: HoodAlert): string {
  const url = a.url || absoluteUrl("/hood/inbox");
  // Public share permalink (no wallet, no app) — the arrow's own OG receipt.
  // `serial` is copied onto every alert record at emit time; strip the leading
  // '#' so `#0067` → `/share/arrow/0067` (serialKey tolerates either, but the
  // bare number keeps the URL clean and avoids '#' being read as a fragment).
  // Guarded: an older record without a serial simply omits the line.
  const serialParam = (a.serial ?? "").replace(/^#/, "").trim();
  const shareUrl = serialParam ? absoluteUrl(`/share/arrow/${serialParam}`) : null;
  const { dot, arrow } = trendGlyphs(a);
  const drift = pctSigned(a.drift_pct);

  // Header — 🟢 $NVDA · 📈 DRIFT ↑ +2.1% · DEX
  const signalBit = `${arrow ? arrow + " " : ""}${esc(a.signal)}${drift ? " " + drift : ""}`;
  const lines = [[`${dot} <b>$${esc(a.ticker)}</b>`, signalBit, "DEX"].join(" · ")];

  // Body — Oracle … → DEX … · TVL … (only the legs we actually have)
  const oracle = usd(a.oracle_price_usd);
  const dex = usd(a.dex_price_usd);
  const facts: string[] = [];
  if (oracle && dex) facts.push(`Oracle ${oracle} → DEX ${dex}`);
  else if (dex) facts.push(`DEX ${dex}`);
  else if (oracle) facts.push(`Oracle ${oracle}`);
  const tvl = usdCompact(a.tvl_usd);
  if (tvl) facts.push(`TVL ${tvl}`);
  if (facts.length) lines.push(facts.join(" · "));

  // Optional one-line brief (verdict note).
  if (a.brief) lines.push("", esc(a.brief));

  // Canonical contract — tap-to-copy. Never a DEX-pool / user address.
  if (a.contract) {
    lines.push("", `<code>${esc(a.contract)}</code>`);
    lines.push(a.verified ? "✓ verified canonical" : "· contract from registry (verify pending)");
  }

  // CTA — Blue Hood is the intelligence layer, not a venue. The share permalink
  // is a PUBLIC receipt (no wallet / no app) so a recipient can post the signal
  // straight to X/Telegram — the OG card renders the real fire-time numbers.
  lines.push("", `<a href="${url}">Open in Blue Hood →</a>`);
  if (shareUrl) lines.push(`<a href="${shareUrl}">Share this signal ↗</a>`);
  return lines.join("\n");
}

type RowOutcome = "delivered" | "skipped_no_tg" | "retry_kept" | "error_kept";

async function drainOne(a: HoodAlert): Promise<RowOutcome> {
  // Resolve the recipient's Telegram id. A BROADCAST copy carries tg_user_id
  // directly (address is ""); a WATCHER copy resolves it via the 1.7 reverse link.
  const tgId = a.tg_user_id ?? (await tgUserForAddress(a.address));
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
