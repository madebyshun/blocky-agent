/**
 * Blue Chat — when does a scheduled task actually fire?
 *
 * ONE implementation, imported by both ends. The browser uses it to render
 * "next run", the cron tick uses it to decide what to execute. That is the
 * whole point: a scheduler whose display disagrees with its execution is worse
 * than no scheduler, because the user has no way to notice it is wrong. (Two
 * hand-maintained copies of the same number is exactly the shape of #192, where
 * the price the composer showed and the price the ledger took drifted apart for
 * four presets.)
 *
 * Zero dependencies and no `window` — it has to run in a Node cron and in a
 * browser render pass.
 *
 * ── Why a timezone field, and not just an offset ─────────────────────────────
 * A task says "09:00". 09:00 WHERE is a real question with a wrong answer: an
 * offset captured at creation time (UTC+7, UTC-5) is a snapshot, and half the
 * world's offsets change twice a year. Storing the IANA zone (`Asia/Ho_Chi_Minh`,
 * `Europe/London`) means a task created in January still fires at 09:00 local in
 * July. `Intl` carries the rules; we do not reimplement them.
 *
 * ── Missed windows are SKIPPED, never replayed ───────────────────────────────
 * `nextFireAt` always returns an instant strictly in the future. If the app was
 * down — or the user's balance was empty — for a week, a daily task does not owe
 * seven runs. It runs once, next window. Each run spends the owner's credits and
 * calls paid tools, so "catch up on everything you missed" is a way to empty a
 * wallet while nobody is watching. Skipping is the conservative default and the
 * only one that is safe to run unattended.
 */

/** The two cadences Blue Chat offers. Mirrors `CronSchedule` in chat/types.ts. */
export type Cadence = "daily" | "weekly";

/** Fields `nextFireAt` needs. A superset of this is fine — `CronTask` qualifies. */
export interface Schedulable {
  schedule: Cadence;
  /** "HH:MM" in `tz`. Malformed values fall back to 09:00 rather than throwing. */
  time?:    string;
  /** IANA zone id. Absent/invalid → UTC, which is at least deterministic. */
  tz?:      string;
  /** Epoch ms of the last completed run. Absent → the task has never fired. */
  lastRun?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// ─── Timezone primitives ─────────────────────────────────────────────────────

/**
 * Wall-clock parts of `utcMs` as an observer in `tz` would read them.
 *
 * `hourCycle: "h23"` rather than `hour12: false` on purpose — the latter emits
 * hour "24" for midnight in several ICU versions, which silently rolls a 00:00
 * task into the next day. h23 is the only spelling that yields 0–23 everywhere.
 */
function partsIn(utcMs: number, tz: string): {
  year: number; month: number; day: number; hour: number; minute: number; second: number;
} {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const out: Record<string, number> = {};
  for (const { type, value } of dtf.formatToParts(new Date(utcMs))) {
    if (type !== "literal") out[type] = Number(value);
  }
  return {
    year:   out.year   ?? 1970,
    month:  out.month  ?? 1,
    day:    out.day    ?? 1,
    hour:   out.hour   ?? 0,
    minute: out.minute ?? 0,
    second: out.second ?? 0,
  };
}

/** How far `tz` is ahead of UTC at the instant `utcMs`, in ms. */
function offsetAt(utcMs: number, tz: string): number {
  const p = partsIn(utcMs, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - utcMs;
}

/**
 * The UTC instant at which the clock in `tz` reads Y-M-D HH:MM.
 *
 * Two passes, because the offset we need is the offset AT THE ANSWER, not at
 * the guess — and across a DST boundary those differ by an hour. Pass 1 guesses
 * using the offset at the naive instant; pass 2 re-reads the offset at that
 * guess and corrects. Converges for every real zone; the pathological cases
 * (times inside a spring-forward gap, which do not exist locally) land on the
 * hour after the gap, which is the standard and least-surprising choice.
 */
function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  const pass1 = naive - offsetAt(naive, tz);
  return naive - offsetAt(pass1, tz);
}

// ─── Input hygiene ───────────────────────────────────────────────────────────

/**
 * A zone string only counts if `Intl` accepts it. A task carrying junk (an old
 * record, a hand-edited sync payload) must not throw inside a cron tick and
 * take every other user's task down with it — it degrades to UTC.
 */
export function normalizeTz(tz?: string): string {
  if (!tz || typeof tz !== "string") return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

/** "09:00" → {hh:9, mm:0}. Anything unparseable → 09:00, never NaN. */
export function parseHHMM(time?: string): { hh: number; mm: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec((time ?? "").trim());
  if (!m) return { hh: 9, mm: 0 };
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isInteger(hh) || !Number.isInteger(mm) || hh > 23 || mm > 59) {
    return { hh: 9, mm: 0 };
  }
  return { hh, mm };
}

/** The browser's own zone, for stamping a task at creation. "UTC" server-side. */
export function localTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

// ─── The answer ──────────────────────────────────────────────────────────────

/**
 * The next instant this task should run — always strictly after `from`.
 *
 * Anchoring:
 *   • never run  → the next occurrence of HH:MM local, today or tomorrow.
 *   • run before → HH:MM local on the day `stepDays` after the last run's LOCAL
 *     date, rolled forward in whole steps until it is in the future.
 *
 * Rolling forward in whole steps (rather than "now + interval") is what keeps a
 * weekly task on its weekday and a daily task at its hour after a missed window
 * — a task that slipped by six hours must not permanently drift six hours later.
 */
export function nextFireAt(task: Schedulable, from: number = Date.now()): number {
  const tz  = normalizeTz(task.tz);
  const { hh, mm } = parseHHMM(task.time);
  const step = task.schedule === "weekly" ? 7 : 1;

  const anchorMs = typeof task.lastRun === "number" && Number.isFinite(task.lastRun)
    ? task.lastRun
    : from;
  const a = partsIn(anchorMs, tz);
  const anchorLocalMidnightUtc = Date.UTC(a.year, a.month - 1, a.day);

  // Candidate for "anchor local date + n days, at HH:MM local".
  const candidate = (n: number): number => {
    const d = new Date(anchorLocalMidnightUtc + n * DAY_MS);
    return zonedToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), hh, mm, tz);
  };

  let n = task.lastRun ? step : 0;

  // Jump the gap arithmetically instead of looping it. A task whose owner was
  // away for a year would otherwise need 365 iterations, and a bounded loop
  // would quietly return a stale answer once it hit the bound.
  const first = candidate(n);
  if (first <= from) {
    const missed = Math.ceil((from - first) / (step * DAY_MS));
    n += missed * step;
  }

  // Settle: the arithmetic jump assumes uniform days, which DST breaks by up to
  // an hour. A couple of steps is always enough to land past `from`.
  for (let i = 0; i < 4; i++) {
    const c = candidate(n);
    if (c > from) return c;
    n += step;
  }
  // Unreachable for any real input; returning a future instant is still the
  // safest possible failure — it delays a run, it never double-charges one.
  return from + step * DAY_MS;
}

/** True when this task's window has arrived. Inactive tasks are never due. */
export function isDueNow(
  task: Schedulable & { active?: boolean; nextAt?: number },
  now: number = Date.now(),
): boolean {
  if (task.active === false) return false;
  const at = typeof task.nextAt === "number" && Number.isFinite(task.nextAt)
    ? task.nextAt
    : nextFireAt({ ...task, lastRun: undefined }, (task.lastRun ?? now) - 1);
  return at <= now;
}

// ─── Display ─────────────────────────────────────────────────────────────────

/**
 * "in 3h 12m", "tomorrow 09:00", "Sep 11, 09:00" — a human answer, not a
 * timestamp. Rendered from the SAME `nextFireAt` the tick executes on, so the
 * label cannot promise a time the scheduler will not honour.
 */
export function formatNextRun(at: number, now: number = Date.now()): string {
  const diff = at - now;
  if (diff <= 0) return "due now";

  const mins  = Math.round(diff / 60_000);
  if (mins < 60)   return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24)  return `in ${hours}h ${mins % 60}m`;

  const days = Math.round(hours / 24);
  const clock = new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (days === 1) return `tomorrow ${clock}`;
  const date = new Date(at).toLocaleDateString([], { month: "short", day: "numeric" });
  return `${date}, ${clock}`;
}
