/**
 * Blue Hood — Base archive integrity watchdog (task #148).
 *
 * ## What this is for
 *
 * `/api/hood/base-series` already computes `contiguous` and `gaps`. Nothing
 * WATCHES them. They are fields on a response a human has to think to request,
 * so the archive can stop recording and the first anyone learns of it is when
 * the data is wanted — which for the Base window is 2026-09-11, task #152, the
 * day the chain question gets answered. An hour of Base history cannot be
 * backfilled: the DEX price at 03:00 is not recoverable at 04:00. Every hour
 * lost is lost permanently, so the alarm has to be prompt or it is decorative.
 *
 * Upstash has starved this engine THREE times (#148, #123). This is not a
 * hypothetical failure being pre-engineered against; it is the failure that has
 * already happened most often.
 *
 * ## Why the watchdog cannot live in the poller — the load-bearing decision
 *
 * The obvious cheap design is to check coverage inside `persistBaseSeriesPoint`,
 * which already holds the day's probe and could classify it for zero extra KV
 * reads. That design DOES NOT WORK, and the reason is worth stating plainly so
 * nobody re-proposes it as an optimisation:
 *
 *   `/api/cron/blue-hood/poll` takes a KV lock (`kvSetNX`) on entry. `kvSetNX`
 *   delegates to `kvTryLock`, which CATCHES a thrown KV command and returns
 *   `"error"` → `kvSetNX` returns `false` → the route logs `[poller] skipped`
 *   and returns 202 WITHOUT running the cycle. `persistBaseSeriesPoint` is
 *   never reached.
 *
 * That is not speculation. The poll route's own header documents it as the
 * mechanism of the 2026-07-27 outage: the Upstash plan cap made every command
 * throw, every tick skipped, and the engine went dark. So an alarm placed
 * inside the poll cycle is unreachable during precisely the outage it exists to
 * report — the classic mistake of putting the smoke detector inside the thing
 * that burns.
 *
 * Hence a SEPARATE cron with its own invocation, which shares no fate with the
 * poller's lock. See `/api/cron/blue-hood/archive-watch`.
 *
 * ## Why delivery must not touch KV
 *
 * An alert queued in KV cannot fire during a KV suspend. `lib/blue-hood/alerts.ts`
 * is queue-backed AND per-user-address (arrow-driven, opt-in watchlists) — wrong
 * on both counts: it dies in the outage, and no user subscribed to "the operator's
 * archive has holes". Delivery goes through `lib/telegram/bot.ts`, which imports
 * nothing from KV and is a bare `fetch` to api.telegram.org, to the operator's
 * own `TELEGRAM_CHAT_ID`.
 *
 * ## Three states, never two
 *
 * The one thing this file must not do is what #149/#150 kept finding elsewhere:
 * read a KV outage as an empty archive. "We could not look" and "we looked and
 * the hour is missing" are different claims with different remedies, and the
 * second is permanent while the first may resolve on its own. They stay apart
 * all the way to the Telegram message.
 */
import { archiveHoles, readBaseSeriesDays } from "./base-series";
// `BASE_SERIES_ARCHIVE_START` comes from kv-keys, NOT from base-series —
// base-series imports it without re-exporting, so `from "./base-series"`
// resolves to `undefined` at runtime. `day < undefined` is always false, which
// silently disabled the pre-archive skip and put twelve days that never existed
// into the window. tsx ran that without complaint; the guard's 5.1 caught it.
import { BASE_SERIES_ARCHIVE_START, yyyymmdd, yyyymmddhh } from "@/lib/blue-hood/kv-keys";

/** Days examined per run. The window #152 will read; also the KV cost cap. */
export const WATCH_WINDOW_DAYS = 14;

const DAY_MS = 86_400_000;

/**
 * How healthy the archive is. Four NON-OVERLAPPING states, because each one
 * sends you somewhere different:
 *
 *   • `blind`  — the reads threw. Contents UNKNOWN; the hours may be fine.
 *                → check the Upstash plan/usage.
 *   • `empty`  — the reads SUCCEEDED and the whole window holds nothing.
 *                → the writer is not writing; KV is fine.
 *   • `gap`    — readable, and holes are missing from it. Known and permanent.
 *   • `intact` — readable and whole.
 *
 * `blind` is NOT a worse `gap`, and `empty` is NOT a worse `gap` either. They
 * are different KINDS of statement, and ranking them on one severity axis is
 * the collapse this whole file exists to refuse.
 *
 * `empty` was added after the first runtime smoke test: against a KV holding no
 * Base data at all, the three-state version returned `intact` and sent nothing.
 * Every day was a `miss`, `missing_days` is interior-only so it was empty, and
 * with no hits there were no absent hours to count — so a totally dead archive
 * scored as healthy. That is the same empty-means-healthy bug (#149/#150) this
 * watchdog was built to catch, reproduced inside the watchdog itself.
 */
export type ArchiveWatchLevel = "intact" | "gap" | "empty" | "blind";

export interface ArchiveWatchReport {
  level: ArchiveWatchLevel;
  /** Inclusive `YYYYMMDD` bounds actually examined. */
  window: { from: string; to: string; days: number };
  /** Days whose read THREW. Contents unknown — never counted as empty. */
  unreadable: string[];
  /**
   * Days holding no record that sit BETWEEN two days that do — interior only,
   * for the reason given on `ArchiveHoles.missing_days`, which is where this is
   * computed. Same array `/api/hood/base-series` publishes as `gaps.days`, from
   * the same call: what the operator is paged about and what the endpoint
   * reports cannot disagree.
   */
  missing_days: string[];
  /** Finished hours inside a readable day that hold no point, `YYYYMMDDHH`.
   *  Shared with `gaps.hours` on the endpoint — see `missing_days` above. */
  absent_hours: string[];
  days_with_data: number;
  points: number;
  /** Newest hour on record anywhere in the window; null when nothing readable. */
  last_hour: string | null;
  /**
   * Whole hours between `last_hour` and now. The crispest "is it still
   * advancing" number. `null` when unknown — i.e. when nothing was readable,
   * because 0 there would assert freshness we did not observe.
   */
  stale_hours: number | null;
}

/** The window a run examines: the archive's own start, never earlier. */
export function watchWindow(now: Date, days = WATCH_WINDOW_DAYS): string[] {
  const today = yyyymmdd(now);
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = yyyymmdd(new Date(now.getTime() - i * DAY_MS));
    // Days before recording began cost no KV request and are not gaps — the
    // answer is known without asking, and asking is what the Upstash cap
    // punishes.
    if (day < BASE_SERIES_ARCHIVE_START) continue;
    out.push(day);
  }
  if (out.length === 0) out.push(today);
  return out;
}

/**
 * Classify one window's reads. Pure — `reads` and `now` in, verdict out — so
 * the guard tests the function that ships rather than a reimplementation of it.
 */
export function classifyArchive(
  reads: Awaited<ReturnType<typeof readBaseSeriesDays>>,
  now: Date,
): ArchiveWatchReport {
  const considered = reads.filter((r) => r.status !== "before_archive");
  const unreadable = considered.filter((r) => r.status === "error").map((r) => r.day);
  const hits = considered.flatMap((r) => (r.status === "hit" ? [r] : []));

  // Shared with `/api/hood/base-series`, which publishes the same two arrays as
  // `gaps`. One definition on purpose: a watchdog that disagrees with the
  // endpoint it watches is worse than no watchdog, because both look right.
  const { missing_days, absent_hours } = archiveHoles(considered, now);

  const allHours = hits.flatMap((r) => r.value.points.map((p) => p.hour)).sort();
  const last_hour = allHours.length ? allHours[allHours.length - 1] : null;

  // Compare on the hour STRING, not a parsed Date — `yyyymmddhh` is what the
  // archive stores, and re-parsing it into a Date is where a timezone slips in.
  let stale_hours: number | null = null;
  if (last_hour !== null) {
    const nowHour = yyyymmddhh(now);
    stale_hours = Math.max(0, hourDiff(last_hour, nowHour));
  }

  // Ordering matters, and each rung is deliberately narrow.
  //
  // `blind` FIRST, and only when nothing at all was readable: a window where one
  // day errored and the rest are clean is a partial blindness that still permits
  // statements about the days we did read, so it reports as `gap` and names the
  // unreadable day. Every day erroring permits no statement whatsoever.
  //
  // `empty` SECOND, and only when nothing errored: reads that SUCCEEDED and
  // found an entirely bare window mean the writer is dead, not KV. If some days
  // also errored we cannot claim the window is empty — we did not see all of it
  // — so that falls through to `gap`, which names the unreadable days.
  //
  // The one false alarm `empty` can produce is the archive's own first hour,
  // before the first poll has written anything. That window closed on
  // 2026-08-28 and cannot reopen, so it is not worth a suppression rule that
  // would also mute a genuinely dead writer on day one of the next archive.
  const level: ArchiveWatchLevel =
    considered.length > 0 && unreadable.length === considered.length
      ? "blind"
      : considered.length > 0 && unreadable.length === 0 && hits.length === 0
        ? "empty"
        : unreadable.length > 0 || missing_days.length > 0 || absent_hours.length > 0
          ? "gap"
          : "intact";

  const days = considered.map((r) => r.day).sort();
  return {
    level,
    window: {
      from: days[0] ?? yyyymmdd(now),
      to: days[days.length - 1] ?? yyyymmdd(now),
      days: considered.length,
    },
    unreadable,
    missing_days,
    absent_hours,
    days_with_data: hits.length,
    points: hits.reduce((n, r) => n + r.value.points.length, 0),
    last_hour,
    stale_hours,
  };
}

/** Whole hours from one `YYYYMMDDHH` to another. Negative if `b` precedes `a`. */
function hourDiff(a: string, b: string): number {
  return Math.round((hourMs(b) - hourMs(a)) / 3_600_000);
}

function hourMs(h: string): number {
  return Date.UTC(
    +h.slice(0, 4),
    +h.slice(4, 6) - 1,
    +h.slice(6, 8),
    +h.slice(8, 10),
  );
}

/** Read the window and classify it. The only function that touches KV. */
export async function checkArchive(
  now: Date,
  days = WATCH_WINDOW_DAYS,
): Promise<ArchiveWatchReport> {
  return classifyArchive(await readBaseSeriesDays(watchWindow(now, days)), now);
}

/**
 * The operator-facing message. HTML, for `parse_mode:"HTML"`.
 *
 * Returns `null` for `intact` — the watchdog is silent when there is nothing to
 * say. A watchdog that also reports success trains its reader to skim, and the
 * one message that matters then looks like the other twenty-three.
 */
export function formatArchiveAlert(r: ArchiveWatchReport): string | null {
  if (r.level === "intact") return null;

  const win = `${r.window.from}→${r.window.to}`;

  if (r.level === "blind") {
    return (
      `🔴 <b>Base archive UNREADABLE</b>\n` +
      `Window ${win} — all ${r.window.days} day(s) threw on read.\n\n` +
      `Contents are <b>UNKNOWN, not empty</b>. Recording may also be stopped: ` +
      `the poll cycle takes a KV lock on entry, so a capped/suspended Upstash ` +
      `makes every tick skip and the archive silently stops advancing.\n\n` +
      `Check the Upstash plan/usage first — that was the cause all three ` +
      `previous times (#148, #123, 2026-07-27).`
    );
  }

  // `empty` is not a louder `blind`. It is the OPPOSITE diagnosis: there KV
  // refused to answer, here KV answered perfectly and the answer was "nothing".
  // The remedy differs accordingly — Upstash is exonerated, the writer is the
  // suspect — so the two messages must not be able to be mistaken for each
  // other by a half-awake reader at 03:00.
  if (r.level === "empty") {
    return (
      `🔴 <b>Base archive EMPTY</b>\n` +
      `Window ${win} — all ${r.window.days} day(s) read CLEANLY and hold ` +
      `<b>nothing</b>. 0 points recorded.\n\n` +
      `This is <b>not</b> a read failure and the contents are not unknown: KV ` +
      `answered every request. The <b>writer</b> is what stopped. Nothing is ` +
      `being persisted, so every hour that passes is lost <b>permanently</b> — ` +
      `a past DEX price cannot be re-read.\n\n` +
      `Check the poll cron first (<code>/api/cron/blue-hood/poll</code>) — it is ` +
      `what calls persistBaseSeriesPoint. This window is what #152 reads on ` +
      `2026-09-11.`
    );
  }

  const lines = [`🟠 <b>Base archive has holes</b>`, `Window ${win}.`];
  if (r.unreadable.length) {
    lines.push(
      `• <b>${r.unreadable.length} day(s) unreadable</b> (contents unknown, not empty): ` +
        r.unreadable.join(", "),
    );
  }
  if (r.missing_days.length) {
    lines.push(`• <b>${r.missing_days.length} day(s) missing</b>: ${r.missing_days.join(", ")}`);
  }
  if (r.absent_hours.length) {
    lines.push(
      `• <b>${r.absent_hours.length} hour(s) absent</b>: ${summariseHours(r.absent_hours)}`,
    );
  }
  if (r.stale_hours !== null && r.stale_hours >= 2) {
    lines.push(`• Newest point is <b>${r.stale_hours}h old</b> (${r.last_hour}).`);
  }
  lines.push(
    ``,
    `Missing hours are <b>permanent</b> — a past DEX price cannot be re-read. ` +
      `This window is what #152 reads on 2026-09-11.`,
  );
  return lines.join("\n");
}

/** First few hours, then a count. A 40-hour list is not read by anyone. */
function summariseHours(hours: string[]): string {
  const head = hours.slice(0, 6).join(", ");
  return hours.length > 6 ? `${head} … +${hours.length - 6} more` : head;
}
