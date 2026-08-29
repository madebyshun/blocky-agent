/**
 * Blue Hood — Base archive integrity watchdog cron (task #148).
 *
 * Hourly. Reads the 14-day Base archive window, and if it is not intact, says
 * so in Telegram to the operator chat.
 *
 * ## Why this is its own cron and not a few lines in the poller
 *
 * Because the poller cannot report its own death. `/api/cron/blue-hood/poll`
 * takes a KV lock on entry; when Upstash is capped every command throws,
 * `kvSetNX` returns false, and the route returns 202 before reaching any Base
 * code. That is the documented mechanism of the 2026-07-27 outage, not a
 * hypothesis. A watchdog inside that route is unreachable during the exact
 * failure it watches for. A separate invocation shares none of that fate — see
 * the header of `lib/base-stocks/archive-watch.ts`.
 *
 * ## Deliberately stateless
 *
 * No dedupe key, no "already alerted" marker, no backoff counter. All of those
 * would have to live in KV, and KV is the thing that is broken in the primary
 * scenario — a dedupe read that fails would either suppress the outage alert
 * (catastrophic) or need a fail-open path that makes it fire every run anyway
 * (pointless). The HOURLY SCHEDULE IS THE RATE LIMIT: at most 24 messages a day
 * while a fault persists. Being nagged about a silent archive is the cheap
 * error; missing it until 2026-09-11 is the expensive one.
 *
 * ## Cost
 *
 * ≤14 KV reads per run, ≤336/day — about 2% of the daily budget at the plan cap
 * that has suspended this engine three times. Days before the archive start
 * cost nothing (`readBaseSeriesDays` answers them without a request), so today
 * the real cost is 2 reads/run and grows to 14 as the window fills.
 *
 * Always returns 200 with the report. Telegram failures degrade to a logged
 * `notified:false` — a watchdog that 500s is one more thing to watch.
 *
 * Auth: `Authorization: Bearer $CRON_SECRET` (or `?secret=`) — same pattern as
 * the other Blue Hood crons.
 */
import { NextRequest, NextResponse } from "next/server";
import { checkArchive, formatArchiveAlert, WATCH_WINDOW_DAYS } from "@/lib/base-stocks/archive-watch";
import { sendMessage } from "@/lib/telegram/bot";

export const runtime = "nodejs";
export const maxDuration = 60;

const CRON_SECRET = process.env.CRON_SECRET ?? "";
/** Operator chat. Not a user watchlist — nobody subscribed to archive health. */
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? "";

function isAuthorized(req: NextRequest): boolean {
  if (!CRON_SECRET) return process.env.NODE_ENV !== "production";
  const authHeader = req.headers.get("authorization") ?? "";
  const secretParam = new URL(req.url).searchParams.get("secret") ?? "";
  return authHeader === `Bearer ${CRON_SECRET}` || secretParam === CRON_SECRET;
}

async function handle(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const report = await checkArchive(new Date(), WATCH_WINDOW_DAYS);
  const message = formatArchiveAlert(report);

  // Log every run, alert or not. The log line is what makes a silent watchdog
  // distinguishable from a watchdog that is itself dead.
  console.log(
    `[archive-watch] level=${report.level} window=${report.window.from}..${report.window.to}` +
      ` days_with_data=${report.days_with_data} points=${report.points}` +
      ` unreadable=${report.unreadable.length} missing_days=${report.missing_days.length}` +
      ` absent_hours=${report.absent_hours.length} stale_h=${report.stale_hours ?? "?"}`,
  );

  if (message === null) {
    return NextResponse.json({ ok: true, notified: false, reason: "intact", report });
  }

  if (!TELEGRAM_CHAT_ID) {
    // Report the misconfiguration rather than silently doing nothing — an
    // unconfigured watchdog looks identical to a healthy one from the outside,
    // which is the failure this whole task is about.
    console.error(
      `[archive-watch] ${report.level} DETECTED but TELEGRAM_CHAT_ID is unset — no alert sent`,
    );
    return NextResponse.json({
      ok: true,
      notified: false,
      reason: "telegram_chat_id_unset",
      report,
    });
  }

  const sent = await sendMessage(TELEGRAM_CHAT_ID, message);
  if (!sent.ok) {
    console.error(`[archive-watch] telegram send failed: ${sent.description ?? "unknown"}`);
  }

  return NextResponse.json({
    ok: true,
    notified: sent.ok,
    delivery: sent.ok ? "sent" : (sent.description ?? "failed"),
    report,
  });
}

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}
