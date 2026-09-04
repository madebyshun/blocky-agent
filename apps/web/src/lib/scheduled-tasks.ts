/**
 * Blue Chat — server-side store for background scheduled tasks.
 *
 * The Scheduled panel has always kept tasks in localStorage and fired them from
 * a mount-only effect, which means a "daily 09:00" task fires whenever you next
 * open the tab and never at 09:00. This module is the durable half of the fix:
 * the copy a cron can read while the browser is closed.
 *
 * ── Ownership is proved, never asserted ──────────────────────────────────────
 * Every function here takes an already-authenticated wallet. The route above it
 * reads that wallet from the SIWE session cookie (`lib/session.ts`) and NEVER
 * from a request body. This is not symmetry with the rest of the app — it is a
 * deliberate step up from it, and the reason is that a background task is a
 * standing instruction to spend. `/api/chat` accepts a client-supplied address
 * for a single message the user is watching; accepting one here would let anyone
 * install ten daily tasks against a stranger's wallet and drain their credits
 * every morning, unattended, until someone noticed. A signature is cheap; that
 * is not.
 *
 * ── Budget ───────────────────────────────────────────────────────────────────
 * Upstash has been suspended three times on this project for exceeding its
 * request budget (#148), so the read pattern is designed around it rather than
 * discovered afterwards:
 *
 *   crons:next        one integer — the earliest `nextAt` across every owner.
 *                     An idle tick reads THIS KEY AND NOTHING ELSE and returns.
 *                     288 ticks/day × 1 read = ~8.6k reads/month, flat, however
 *                     many users exist.
 *   crons:owners      a real Redis SET (SADD/SREM are atomic — no read-modify-
 *                     write, so two concurrent enrolments cannot lose one).
 *   crons:w:<wallet>  that wallet's task list.
 *
 * The watermark is CLAMPED on write to at most an hour out. A corrupted or
 * far-future value would otherwise be permanent: nothing would ever re-read the
 * owners set, so nothing would ever fix it. The clamp bounds the damage at one
 * hour of missed firing and costs one full pass per hour in the worst case.
 *
 * ── Why a separate key instead of `workspace:<wallet>.sections.crons` ────────
 * The workspace blob already mirrors crons for users who enabled sync, so
 * reusing it is tempting and wrong. The scheduler writes run results; the
 * browser writes the whole blob. Both would be read-modify-write against ONE
 * key, so a tick landing between a client's read and its PUT silently discards
 * whatever the user did in between — and that key also holds their entire
 * conversation history. That is the #147/#150 wipe, aimed at the most valuable
 * key we have. Separate keys mean the scheduler owns exactly what it writes.
 */

import {
  kvGetProbe, kvSetOrThrow, kvDel,
  kvSAdd, kvSRem, kvSMembers,
} from "@/lib/kv";
import { nextFireAt, normalizeTz, parseHHMM, type Cadence } from "@/lib/cron-schedule";

// ─── Keys ────────────────────────────────────────────────────────────────────

const OWNERS_KEY    = "crons:owners";
const WATERMARK_KEY = "crons:next";
const ownerKey = (wallet: string) => `crons:w:${wallet.toLowerCase()}`;

/** Never let the watermark push the next full pass further out than this. */
export const WATERMARK_CLAMP_MS = 60 * 60 * 1000;

// ─── Limits ──────────────────────────────────────────────────────────────────

/**
 * Caps, all of them about bounding UNATTENDED SPEND rather than storage. Ten
 * daily tasks on the Deep preset is already 2,000 credits a day; the ceiling
 * exists so a mistake costs a bounded amount before anybody looks at it.
 */
export const MAX_TASKS_PER_WALLET = 10;
export const MAX_PROMPT_CHARS     = 2_000;
export const MAX_LABEL_CHARS      = 80;
/** Result text kept per task. Enough to be useful, small enough to stay cheap. */
export const MAX_RESULT_CHARS     = 4_000;

// ─── Shape ───────────────────────────────────────────────────────────────────

/**
 * A task as the SERVER holds it. Deliberately not `CronTask`: the browser type
 * carries UI state, and this one carries the two fields only the scheduler may
 * write (`nextAt`, `pausedReason`). Keeping them distinct is what stops a client
 * from POSTing itself a new `nextAt` — see `sanitizeTasks`.
 */
export interface ScheduledTask {
  id:            string;
  label:         string;
  schedule:      Cadence;
  time:          string;   // "HH:MM" in `tz`
  tz:            string;   // IANA zone id
  prompt:        string;
  /** Model preset to run with. Priced and resolved by /api/chat, not here. */
  tier:          string;
  active:        boolean;
  /** Server-computed. Never accepted from a client. */
  nextAt:        number;
  lastRun?:      number;
  lastResult?:   string;
  lastError?:    string;
  /** Set when the scheduler itself disabled the task. Explains why, in the UI. */
  pausedReason?: string;
}

export interface OwnerRecord {
  v:         number;
  updatedAt: number;
  tasks:     ScheduledTask[];
}

export const SCHEDULE_VERSION = 1;

// ─── Validation ──────────────────────────────────────────────────────────────

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

/**
 * Accept a client's task list, and accept ONLY what a client is allowed to
 * decide. `nextAt`, `lastRun`, `lastResult` and `pausedReason` are recomputed or
 * carried over from what the server already holds — never taken from the body.
 *
 * A client that could set `nextAt` could set it to `0` and make its tasks
 * permanently due, turning a 5-minute tick into an unbounded spend loop against
 * its own ledger. Recomputing is one line and removes the question.
 */
export function sanitizeTasks(raw: unknown, previous: ScheduledTask[] = []): ScheduledTask[] {
  if (!Array.isArray(raw)) return [];
  const prevById = new Map(previous.map((t) => [t.id, t]));
  const seen = new Set<string>();
  const out: ScheduledTask[] = [];

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;

    const id = str(r.id, 40).trim();
    if (!id || seen.has(id)) continue;

    const prompt = str(r.prompt, MAX_PROMPT_CHARS).trim();
    if (!prompt) continue;               // a task with no prompt cannot run

    const schedule: Cadence = r.schedule === "weekly" ? "weekly" : "daily";
    const { hh, mm } = parseHHMM(str(r.time, 5));
    const prev = prevById.get(id);

    const task: ScheduledTask = {
      id,
      label:    str(r.label, MAX_LABEL_CHARS).trim() || "Scheduled task",
      schedule,
      time:     `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`,
      tz:       normalizeTz(str(r.tz, 64)),
      prompt,
      tier:     str(r.tier, 40).trim() || "pro",
      active:   r.active !== false,
      // Carried from the server's own record, never from the request.
      nextAt:      0,
      lastRun:     prev?.lastRun,
      lastResult:  prev?.lastResult,
      lastError:   prev?.lastError,
      pausedReason: prev?.pausedReason,
    };

    // Re-enabling clears the scheduler's own pause note — the user has seen it
    // and acted. A pause the user cannot clear is a task that is silently dead.
    if (task.active && task.pausedReason) task.pausedReason = undefined;

    task.nextAt = nextFireAt(task);
    out.push(task);
    seen.add(id);
    if (out.length >= MAX_TASKS_PER_WALLET) break;
  }
  return out;
}

// ─── Owner record ────────────────────────────────────────────────────────────

export type OwnerRead =
  | { status: "found"; record: OwnerRecord }
  | { status: "empty" }
  | { status: "unavailable"; message: string };

/**
 * Three-way, for the usual reason: `kvGet` turns a throttled read into `null`,
 * and "this wallet has no tasks" must not be the same answer as "we could not
 * check". The tick treats `unavailable` as "skip this owner, try next cycle" —
 * writing an empty list on an outage would delete their schedule.
 */
export async function readOwnerTasks(wallet: string): Promise<OwnerRead> {
  const probe = await kvGetProbe<OwnerRecord>(ownerKey(wallet));
  if (probe.status === "error") return { status: "unavailable", message: probe.message };
  if (probe.status === "miss")  return { status: "empty" };

  const rec = probe.value;
  if (!rec || typeof rec !== "object" || !Array.isArray(rec.tasks)) return { status: "empty" };
  return {
    status: "found",
    record: { v: rec.v ?? SCHEDULE_VERSION, updatedAt: rec.updatedAt ?? 0, tasks: rec.tasks },
  };
}

/**
 * `kvSetOrThrow`, not `kvSet`: the caller decides what a failed write means, and
 * for the tick it means "do not advance the watermark". A swallowed write would
 * look like success and the run result would vanish.
 */
export async function writeOwnerTasks(wallet: string, tasks: ScheduledTask[]): Promise<void> {
  const record: OwnerRecord = {
    v:         SCHEDULE_VERSION,
    updatedAt: Date.now(),
    tasks:     tasks.slice(0, MAX_TASKS_PER_WALLET),
  };
  await kvSetOrThrow(ownerKey(wallet), record);
}

// ─── Enrolment ───────────────────────────────────────────────────────────────

export async function listOwners(): Promise<string[]> {
  return (await kvSMembers(OWNERS_KEY)).map((w) => w.toLowerCase());
}

/**
 * Persist a wallet's schedule and make sure the tick knows to look at it.
 *
 * Order matters: write the tasks, THEN enrol. Enrolling first would put a wallet
 * in the owners set whose record does not exist yet, and a tick landing in that
 * window would read `empty` for a wallet that is mid-save.
 *
 * An empty list is a real instruction — "stop running my tasks in the
 * background" — so it un-enrols rather than being ignored.
 */
export async function putSchedule(wallet: string, tasks: ScheduledTask[]): Promise<void> {
  if (tasks.length === 0) {
    await unenroll(wallet);
    return;
  }
  await writeOwnerTasks(wallet, tasks);
  await kvSAdd(OWNERS_KEY, wallet.toLowerCase());
  await bumpWatermark(tasks);
}

/**
 * Leave the background scheduler. Deletes the SERVER copy only — the browser
 * keeps its tasks, exactly as turning off workspace sync keeps conversations.
 * Nothing a user turns off should cost them data.
 */
export async function unenroll(wallet: string): Promise<void> {
  await kvSRem(OWNERS_KEY, wallet.toLowerCase());
  await kvDel(ownerKey(wallet));
}

// ─── Watermark ───────────────────────────────────────────────────────────────

export type WatermarkRead =
  | { status: "at"; at: number }
  | { status: "unset" }
  | { status: "unavailable"; message: string };

export async function readWatermark(): Promise<WatermarkRead> {
  const probe = await kvGetProbe<unknown>(WATERMARK_KEY);
  if (probe.status === "error") return { status: "unavailable", message: probe.message };
  if (probe.status === "miss")  return { status: "unset" };
  const n = Number(probe.value);
  return Number.isFinite(n) ? { status: "at", at: n } : { status: "unset" };
}

/**
 * Store the next instant worth waking up for, clamped so it can never be more
 * than an hour away. See the header: an unclamped watermark is a single integer
 * that can permanently switch the scheduler off, and nothing would re-read the
 * data that would have corrected it.
 */
export async function writeWatermark(at: number, now: number = Date.now()): Promise<void> {
  const clamped = Math.min(at, now + WATERMARK_CLAMP_MS);
  await kvSetOrThrow(WATERMARK_KEY, Math.max(now, clamped));
}

/**
 * Pull the watermark EARLIER if this wallet's soonest task beats it.
 *
 * Only ever earlier — a single wallet does not know when everyone else's tasks
 * are due, so it must never push the wake-up out on their behalf. Moving it in
 * is always safe: the worst case is one extra pass that finds nothing.
 */
export async function bumpWatermark(tasks: ScheduledTask[], now: number = Date.now()): Promise<void> {
  const soonest = earliestNextAt(tasks);
  if (soonest === null) return;

  const current = await readWatermark();
  if (current.status === "unavailable") return;              // don't guess
  if (current.status === "at" && current.at <= soonest) return;
  await writeWatermark(soonest, now);
}

/** Earliest `nextAt` among ACTIVE tasks, or null when nothing is scheduled. */
export function earliestNextAt(tasks: ScheduledTask[]): number | null {
  let min: number | null = null;
  for (const t of tasks) {
    if (!t.active) continue;
    if (!Number.isFinite(t.nextAt)) continue;
    if (min === null || t.nextAt < min) min = t.nextAt;
  }
  return min;
}
