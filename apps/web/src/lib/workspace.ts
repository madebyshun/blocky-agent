/**
 * Blue Agent — Blue Chat workspace (server side)
 *
 * `workspace:<wallet>` is the durable mirror of the Blue Chat state that today
 * lives only in one browser's localStorage. Opt-in, and only for a wallet that
 * has proved key control via `lib/session.ts` — the wallet ALWAYS comes from
 * the session cookie, never from a query param or request body.
 *
 * ── The server does not understand the contents, on purpose ──────────────────
 * The payload is an opaque per-section blob. This module enforces four things
 * and nothing else: ownership, version, size, and WHICH SECTIONS may exist.
 * It deliberately does not validate the inside of a section, so that changing a
 * `ChatTask` field never requires a server migration.
 *
 * ── What is excluded, and why it is excluded rather than "not yet" ───────────
 *   • credits (`blue_cr_*`) — credits already have a server ledger (#42). A
 *     second writable copy of a balance is a second source of truth for money;
 *     the one time we had that (localStorage debit + ledger debit) it produced
 *     a double-debit. Not syncing them is the fix, not an omission.
 *   • connectors (`blueagent:connectors`) — rows carry `authValue`, e.g. a raw
 *     `Bearer ghp_…` GitHub token. Mirroring them would move users' third-party
 *     credentials into our KV with no vault, no rotation and no encryption at
 *     rest. That is Phase 4's job (OAuth + secrets vault); doing half of it here
 *     would be strictly worse than leaving them in the browser.
 *
 * The allowlist below is the enforcement point for both. A future client bug
 * that tries to POST either section gets it dropped and reported, rather than
 * quietly persisted.
 */

import { kvGetProbe, kvSetOrThrow, kvDel } from "@/lib/kv";

export const WORKSPACE_VERSION = 1;

/** Sections a client may sync. Anything else is dropped — see the header. */
export const WORKSPACE_SECTIONS = [
  "tasks",         // ChatTask[]        — conversations
  "crons",         // CronTask[]        — scheduled prompts
  "persona",       // PersonaId
  "customPrompt",  // string
  "memory",        // UserMemory
  "chunks",        // MemoryChunk[]
  "skills",        // Skill[]           — prompt text only, no secrets
  "integrations",  // { baseMcp, coinbase } — two booleans
] as const;

export type WorkspaceSection = (typeof WORKSPACE_SECTIONS)[number];

export interface Workspace {
  v:         number;
  updatedAt: number;
  sections:  Partial<Record<WorkspaceSection, unknown>>;
}

/**
 * Upstash rejects requests over 1 MB. We cap the serialized workspace well under
 * that so a sync fails on OUR side with a clear message, rather than as an
 * opaque upstream error — and so the cap is visible in code review instead of
 * being discovered in production.
 */
export const MAX_WORKSPACE_BYTES = 400_000;

const wsKey = (wallet: string) => `workspace:${wallet.toLowerCase()}`;

// ─── Validation ──────────────────────────────────────────────────────────────

export interface SanitizedPayload {
  sections: Partial<Record<WorkspaceSection, unknown>>;
  /** Section names the client sent that are not allowed. Reported, not persisted. */
  rejected: string[];
}

/**
 * Keep only allowlisted sections. Returns what was dropped so the route can
 * tell the client — a silent drop is how "sync is on" turns into "sync has been
 * lying about one section for months".
 */
export function sanitizeSections(raw: unknown): SanitizedPayload | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const allowed = new Set<string>(WORKSPACE_SECTIONS);
  const sections: Partial<Record<WorkspaceSection, unknown>> = {};
  const rejected: string[] = [];

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === undefined) continue;
    if (allowed.has(key)) sections[key as WorkspaceSection] = value;
    else rejected.push(key);
  }
  return { sections, rejected };
}

// ─── Read ────────────────────────────────────────────────────────────────────

export type WorkspaceRead =
  | { status: "found"; workspace: Workspace }
  | { status: "empty" }
  | { status: "unavailable"; message: string };

/**
 * Three-way read, and the three-way-ness is the whole point.
 *
 * `kvGet` collapses "this wallet has never synced" and "KV is throttled" into
 * the same `null`. On this key that collapse is destructive rather than merely
 * confusing: the client hydrates from what it reads, so an outage rendered as
 * "empty workspace" would replace a user's conversation list with nothing, and
 * the next mirror would write that nothing back. `unavailable` must reach the
 * client so it can leave localStorage alone.
 */
export async function readWorkspace(wallet: string): Promise<WorkspaceRead> {
  const probe = await kvGetProbe<Workspace>(wsKey(wallet));
  if (probe.status === "error") return { status: "unavailable", message: probe.message };
  if (probe.status === "miss")  return { status: "empty" };

  const ws = probe.value;
  if (!ws || typeof ws !== "object" || typeof ws.updatedAt !== "number") {
    return { status: "empty" };
  }
  return { status: "found", workspace: { v: ws.v ?? WORKSPACE_VERSION, updatedAt: ws.updatedAt, sections: ws.sections ?? {} } };
}

// ─── Write ───────────────────────────────────────────────────────────────────

export type WorkspaceWrite =
  | { status: "ok"; updatedAt: number }
  | { status: "too-large"; bytes: number }
  | { status: "failed"; message: string };

/**
 * Durable write via `kvSetOrThrow`, not `kvSet`. `kvSet` catches and returns
 * normally, so a throttled write is indistinguishable from a successful one —
 * and the client uses the success of this call to decide the mirror is safe.
 * It has to be able to fail.
 *
 * No TTL: a workspace is user data, not a cache. It expires when the user
 * deletes it (`deleteWorkspace`), not on a timer.
 */
export async function writeWorkspace(
  wallet: string,
  sections: Partial<Record<WorkspaceSection, unknown>>,
): Promise<WorkspaceWrite> {
  const workspace: Workspace = { v: WORKSPACE_VERSION, updatedAt: Date.now(), sections };

  const bytes = JSON.stringify(workspace).length;
  if (bytes > MAX_WORKSPACE_BYTES) return { status: "too-large", bytes };

  try {
    await kvSetOrThrow(wsKey(wallet), workspace);
    return { status: "ok", updatedAt: workspace.updatedAt };
  } catch (e) {
    return { status: "failed", message: (e as Error).message };
  }
}

/**
 * Turning sync off deletes the server copy. The browser keeps its own — the
 * client never removes a localStorage key as part of syncing, so "stop syncing"
 * can never mean "lose your history".
 */
export async function deleteWorkspace(wallet: string): Promise<void> {
  await kvDel(wsKey(wallet));
}
