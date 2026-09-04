// Blue Chat v2 — localStorage helpers
import type { ChatTask, CronTask, CronSchedule } from "./types";
// The SAME schedule math the server tick runs on. Imported rather than
// reimplemented so the "next run" this file renders is the instant the cron
// actually fires — a scheduler whose display disagrees with its execution is
// worse than none, because the user has no way to notice it is wrong.
import { nextFireAt, formatNextRun } from "@/lib/cron-schedule";

// ── Key helpers ────────────────────────────────────────────────────────────────

const tasksKey  = (a?: string) => a ? `blue_tasks_v1_${a.toLowerCase()}`          : "blue_tasks_v1_guest";
const cronsKey  = (a?: string) => a ? `blue_crons_v1_${a.toLowerCase()}`          : "blue_crons_v1_guest";
const oldChatKey= (a?: string) => a ? `blue_chat_v1_${a}`                         : "blue_chat_v1_guest";

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

// ── Tasks ─────────────────────────────────────────────────────────────────────

export function loadTasks(addr?: string): ChatTask[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(tasksKey(addr));
    if (raw) return JSON.parse(raw) as ChatTask[];
  } catch { /* ignore */ }
  return [];
}

export function saveTasks(tasks: ChatTask[], addr?: string): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(tasksKey(addr), JSON.stringify(tasks));
}

export function migrateOldChat(addr?: string): ChatTask | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(oldChatKey(addr));
  if (!raw) return null;
  try {
    const messages = JSON.parse(raw);
    if (!Array.isArray(messages) || messages.length === 0) return null;
    const firstUser = messages.find((m: { role: string }) => m.role === "user");
    return {
      id:        uid(),
      title:     firstUser?.content?.slice(0, 50) ?? "Previous conversation",
      messages,
      createdAt: Date.now() - 86_400_000,
      updatedAt: Date.now() - 86_400_000,
      model:     "pro",
    };
  } catch { return null; }
}

export function createTask(model: string): ChatTask {
  return {
    id:        uid(),
    title:     "",
    messages:  [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    model,
  };
}

// Merge two task lists into one, de-duped by id with the newest `updatedAt`
// winning. Used on sign-in to fold guest-side history into the wallet key so a
// conversation typed before connecting is never stranded on the guest key
// (`blue_tasks_v1_guest`) while the app now reads `blue_tasks_v1_<address>`.
export function mergeTaskLists(a: ChatTask[], b: ChatTask[]): ChatTask[] {
  const byId = new Map<string, ChatTask>();
  for (const t of [...a, ...b]) {
    const prev = byId.get(t.id);
    if (!prev || t.updatedAt > prev.updatedAt) byId.set(t.id, t);
  }
  return [...byId.values()];
}

// Drain the guest bucket after its history has been merged into a wallet key.
// This keeps guest as transient staging: without it, an always-merge would
// resurrect ("zombie") a conversation the user later deletes from the wallet
// side, because the stale copy left on the guest key would merge back in on the
// next sign-in. A fresh guest session (disconnect → chat) just refills it.
export function clearGuestTasks(): void {
  if (typeof window === "undefined") return;
  try { localStorage.removeItem(tasksKey(undefined)); } catch { /* ignore */ }
}

// ── Crons ─────────────────────────────────────────────────────────────────────

const CRON_INTERVALS: Record<CronSchedule, number> = {
  daily:  24 * 60 * 60 * 1000,
  weekly: 7  * 24 * 60 * 60 * 1000,
};

/** A task the user has switched on for server-side firing. */
export function isBackground(cron: CronTask): boolean {
  return cron.background === true;
}

export function loadCrons(addr?: string): CronTask[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(cronsKey(addr));
    if (raw) return JSON.parse(raw) as CronTask[];
  } catch { /* ignore */ }
  return [];
}

export function saveCrons(crons: CronTask[], addr?: string): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(cronsKey(addr), JSON.stringify(crons));
}

/**
 * Should the BROWSER run this task on open?
 *
 * Two different questions live behind one name, and keeping them apart is the
 * point of the `background` branch:
 *
 *   • background OFF → interval-only, exactly as before. `cron.time` is not read,
 *     because nothing in the browser can promise a wall-clock instant while the
 *     tab is closed. The task fires when the user next opens Blue Chat and the
 *     interval has elapsed.
 *   • background ON  → the SERVER owns this task. The browser must never fire it,
 *     even if it looks overdue: the tick and the tab would both debit credits for
 *     the same window, and the user would be charged twice for one run.
 *
 * The wall-clock answer for a background task is `cron.nextAt`, computed once by
 * `lib/cron-schedule.ts` and used by both ends — see `nextRunLabel`.
 */
export function isDue(cron: CronTask): boolean {
  if (!cron.active) return false;
  if (isBackground(cron)) return false;   // the server owns it — see above
  const interval = CRON_INTERVALS[cron.schedule];
  if (!cron.lastRun) return true;
  return Date.now() - cron.lastRun >= interval;
}

/**
 * What the panel shows under a task.
 *
 * A background task gets a real time ("in 3h 12m", "tomorrow 09:00"), rendered
 * from the SAME `nextFireAt` the cron executes on, so the label cannot promise a
 * moment the scheduler will not honour. A foreground task keeps the deliberately
 * hedged wording from #169 — "earliest", "on next open" — because the app still
 * cannot keep a wall-clock promise for it.
 */
export function nextRunLabel(cron: CronTask): string {
  if (isBackground(cron)) {
    if (!cron.active) return cron.pausedReason ? "paused" : "off";
    const at = typeof cron.nextAt === "number" && Number.isFinite(cron.nextAt)
      ? cron.nextAt
      : nextFireAt({ schedule: cron.schedule, time: cron.time, tz: cron.tz, lastRun: cron.lastRun });
    return formatNextRun(at);
  }

  const interval = CRON_INTERVALS[cron.schedule];
  const last = cron.lastRun ?? 0;
  const next = last + interval;
  const diff = next - Date.now();
  if (diff <= 0) return "runs on next open";
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  if (h >= 24) return `earliest in ${Math.floor(h / 24)}d`;
  if (h > 0)   return `earliest in ${h}h ${m}m`;
  return `earliest in ${m}m`;
}
