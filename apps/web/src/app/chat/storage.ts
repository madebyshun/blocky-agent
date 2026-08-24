// Blue Chat v2 — localStorage helpers
import type { ChatTask, CronTask, PersonaId, CronSchedule } from "./types";

// ── Key helpers ────────────────────────────────────────────────────────────────

const tasksKey  = (a?: string) => a ? `blue_tasks_v1_${a.toLowerCase()}`          : "blue_tasks_v1_guest";
const cronsKey  = (a?: string) => a ? `blue_crons_v1_${a.toLowerCase()}`          : "blue_crons_v1_guest";
const personaKey= (a?: string) => a ? `blue_persona_v1_${a.toLowerCase()}`        : "blue_persona_v1_guest";
const customKey = (a?: string) => a ? `blue_persona_custom_v1_${a.toLowerCase()}` : "blue_persona_custom_v1_guest";
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
      persona:   "blue-agent",
    };
  } catch { return null; }
}

export function createTask(model: string, persona: PersonaId): ChatTask {
  return {
    id:        uid(),
    title:     "",
    messages:  [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    model,
    persona,
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

export function isDue(cron: CronTask): boolean {
  if (!cron.active) return false;
  const interval = CRON_INTERVALS[cron.schedule];
  if (!cron.lastRun) return true;
  return Date.now() - cron.lastRun >= interval;
}

export function nextRunLabel(cron: CronTask): string {
  const interval = CRON_INTERVALS[cron.schedule];
  const last = cron.lastRun ?? 0;
  const next = last + interval;
  const diff = next - Date.now();
  if (diff <= 0) return "Due now";
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  if (h >= 24) return `in ${Math.floor(h / 24)}d`;
  if (h > 0)   return `in ${h}h ${m}m`;
  return `in ${m}m`;
}

// ── Persona ───────────────────────────────────────────────────────────────────

export function loadPersona(addr?: string): PersonaId {
  if (typeof window === "undefined") return "blue-agent";
  return (localStorage.getItem(personaKey(addr)) ?? "blue-agent") as PersonaId;
}

export function savePersona(id: PersonaId, addr?: string): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(personaKey(addr), id);
}

export function loadCustomPrompt(addr?: string): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(customKey(addr)) ?? "";
}

export function saveCustomPrompt(text: string, addr?: string): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(customKey(addr), text);
}
