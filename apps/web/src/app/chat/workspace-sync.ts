"use client";

/**
 * Blue Chat — workspace sync (client side)
 *
 * Opt-in mirror of this browser's Blue Chat state to `workspace:<wallet>` on the
 * server, so the same wallet sees the same conversations on a second device.
 *
 * ── localStorage stays the working copy ──────────────────────────────────────
 * Nothing here changes how Blue Chat reads or writes. The ~15 `saveTasks` call
 * sites in ChatContext are untouched; this module snapshots what they already
 * wrote and mirrors it on a debounce. That is deliberate: rewriting every call
 * site into an async server write would put the network on the path of "did my
 * message get saved", and an offline user would lose work. Here, an offline or
 * failing sync costs the user nothing — the local copy is already complete.
 *
 * ── This module NEVER deletes a localStorage key ─────────────────────────────
 * Not on hydrate, not on sign-out, not on "stop syncing". The server copy is a
 * mirror of the browser, never the other way around, so no server state and no
 * network failure can cost a user their history. Hydration MERGES; it does not
 * replace.
 *
 * ── Merge policy, and why it differs per section ─────────────────────────────
 *   • Lists that are DATA (tasks, crons, chunks, skills) → merged by id/name,
 *     newest wins. Never replaced. Losing one conversation is unacceptable, so
 *     the merge is union-biased even when that means keeping something stale.
 *   • Scalars that are PREFERENCES (integrations) →
 *     the server copy wins, once, at hydrate. "Local wins" sounds safer but
 *     silently breaks the feature: a fresh device sits on the defaults and
 *     would never receive the synced ones. The blast radius is a preference,
 *     not data.
 *
 * ── Budget ───────────────────────────────────────────────────────────────────
 * Upstash has been suspended three times on this project for exceeding its
 * request budget (#148). So: no polling of the server, ever. The only reads are
 * one hydrate per sign-in. Writes are local-change-triggered, debounced, and
 * rate-limited client-side as well as server-side.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatTask, CronTask } from "./types";
import {
  loadTasks, saveTasks, mergeTaskLists,
  loadCrons, saveCrons,
} from "./storage";
import {
  loadSkills, saveSkills,
  loadIntegrations, setIntegration,
  type InstalledSkill, type Integrations,
} from "./integrations";
import {
  getMemory, saveMemory, getChunks, saveChunks,
  type UserMemory, type MemoryChunk,
} from "@/lib/memory";

/** Fired after hydration so ChatContext can re-read localStorage into React state. */
export const WORKSPACE_HYDRATED_EVENT = "blueagent:workspace-hydrated";

const SYNC_PREF_KEY = (a?: string) => `blue_sync_v1_${a?.toLowerCase() ?? "anon"}`;

/** How often we look for local changes. No network unless something changed. */
const CHANGE_CHECK_MS = 8_000;
/** Floor between two uploads, however fast the user types. */
const MIN_UPLOAD_GAP_MS = 15_000;

// ─── Sync preference (per wallet, local) ─────────────────────────────────────

export function isSyncEnabled(addr?: string): boolean {
  if (typeof window === "undefined" || !addr) return false;
  try { return localStorage.getItem(SYNC_PREF_KEY(addr)) === "1"; } catch { return false; }
}

export function setSyncEnabled(on: boolean, addr?: string): void {
  if (typeof window === "undefined" || !addr) return;
  try { localStorage.setItem(SYNC_PREF_KEY(addr), on ? "1" : "0"); } catch { /* blocked */ }
}

// ─── Snapshot ────────────────────────────────────────────────────────────────

/**
 * Section names here MUST stay a subset of `WORKSPACE_SECTIONS` in
 * `lib/workspace.ts`. Anything else is dropped server-side and reported back in
 * `rejected` — notably `credits` (already has a server ledger, #42) and
 * `connectors` (rows carry raw bearer tokens; Phase 4's vault, not this).
 */
export interface WorkspaceSections {
  tasks?:        ChatTask[];
  crons?:        CronTask[];
  memory?:       UserMemory;
  chunks?:       MemoryChunk[];
  skills?:       InstalledSkill[];
  integrations?: Integrations;
}

export function snapshotWorkspace(addr?: string): WorkspaceSections {
  return {
    tasks:        loadTasks(addr),
    crons:        loadCrons(addr),
    memory:       getMemory(addr),
    chunks:       getChunks(addr),
    skills:       loadSkills(),
    integrations: loadIntegrations(),
  };
}

/** FNV-1a. Only ever compared to itself — this is change detection, not a checksum. */
function fingerprint(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

// ─── Merge helpers ───────────────────────────────────────────────────────────

function mergeCrons(local: CronTask[], remote: CronTask[]): CronTask[] {
  const byId = new Map<string, CronTask>();
  for (const c of [...remote, ...local]) {
    const prev = byId.get(c.id);
    // No `updatedAt` on CronTask, so `lastRun` is the only recency signal we
    // have. Local is applied second so it wins an exact tie — the device the
    // user is actually on is the better guess.
    if (!prev || (c.lastRun ?? 0) >= (prev.lastRun ?? 0)) byId.set(c.id, c);
  }
  return [...byId.values()];
}

function mergeChunks(local: MemoryChunk[], remote: MemoryChunk[]): MemoryChunk[] {
  const byId = new Map<string, MemoryChunk>();
  for (const c of [...remote, ...local]) if (c?.id) byId.set(c.id, c);
  return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 50);
}

function mergeSkills(local: InstalledSkill[], remote: InstalledSkill[]): InstalledSkill[] {
  const byName = new Map<string, InstalledSkill>();
  for (const s of [...remote, ...local]) {
    const prev = byName.get(s.name);
    if (!prev || (s.installedAt ?? 0) >= (prev.installedAt ?? 0)) byName.set(s.name, s);
  }
  return [...byName.values()].slice(0, 50);
}

/** UserMemory carries its own `updatedAt`, so this one is a clean comparison. */
function mergeMemory(local: UserMemory, remote: UserMemory): UserMemory {
  return (remote?.updatedAt ?? 0) > (local?.updatedAt ?? 0) ? remote : local;
}

/**
 * Write the merged result back to localStorage. Every branch is guarded by a
 * type check: a malformed section from the server must be ignored, not written.
 * Skipping a section leaves the local copy intact, which is always the safe
 * direction here.
 */
export function hydrateWorkspace(remote: Partial<WorkspaceSections>, addr?: string): void {
  if (typeof window === "undefined") return;

  if (Array.isArray(remote.tasks)) {
    saveTasks(mergeTaskLists(loadTasks(addr), remote.tasks), addr);
  }
  if (Array.isArray(remote.crons)) {
    saveCrons(mergeCrons(loadCrons(addr), remote.crons), addr);
  }
  if (Array.isArray(remote.chunks)) {
    saveChunks(mergeChunks(getChunks(addr), remote.chunks), addr);
  }
  if (Array.isArray(remote.skills)) {
    saveSkills(mergeSkills(loadSkills(), remote.skills));
  }
  if (remote.memory && typeof remote.memory === "object") {
    saveMemory(mergeMemory(getMemory(addr), remote.memory as UserMemory));
  }
  // Preferences: server wins at hydrate. See the merge-policy note in the header.
  if (remote.integrations && typeof remote.integrations === "object") {
    setIntegration("baseMcp",  !!remote.integrations.baseMcp);
    setIntegration("coinbase", !!remote.integrations.coinbase);
  }

  window.dispatchEvent(new Event(WORKSPACE_HYDRATED_EVENT));
}

// ─── Sync status ─────────────────────────────────────────────────────────────

export type SyncState =
  | { phase: "off" }
  | { phase: "signed-out" }          // sync on, but no server session yet
  | { phase: "hydrating" }
  | { phase: "idle";    at: number }
  | { phase: "syncing" }
  | { phase: "error";   message: string };

// ─── The hook ────────────────────────────────────────────────────────────────

export interface UseWorkspaceSync {
  state:     SyncState;
  enabled:   boolean;
  /** Server-confirmed wallet from the session cookie — NOT the connected wallet. */
  sessionWallet: string | null;
  enable:    () => Promise<void>;
  disable:   () => Promise<void>;
  /** Delete the server copy. Local data is untouched. */
  forget:    () => Promise<void>;
}

/**
 * `signIn` is injected rather than imported so this module never pulls in wagmi
 * — it stays testable and does not drag a wallet stack into anything that only
 * wants the snapshot/merge helpers.
 */
export function useWorkspaceSync(
  walletAddr: string | undefined,
  signIn: () => Promise<string>,   // resolves to the signed-in wallet
): UseWorkspaceSync {
  const [enabled, setEnabledState] = useState(false);
  const [state, setState]          = useState<SyncState>({ phase: "off" });
  const [sessionWallet, setSessionWallet] = useState<string | null>(null);

  const lastSent   = useRef<string>("");   // fingerprint of the last accepted upload
  const lastSentAt = useRef<number>(0);
  const hydrated   = useRef<string | null>(null); // wallet we have already hydrated

  // Read the stored preference whenever the connected wallet changes.
  useEffect(() => {
    setEnabledState(isSyncEnabled(walletAddr));
  }, [walletAddr]);

  // Ask the server who it thinks we are. A 503 here is NOT "signed out" — it
  // means we could not check, and we must not act on it.
  useEffect(() => {
    if (!enabled || !walletAddr) { setSessionWallet(null); return; }
    let cancelled = false;
    fetch("/api/auth/session", { cache: "no-store" })
      .then(async r => ({ ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) }))
      .then(({ status, body }) => {
        if (cancelled) return;
        if (status === 503) { setState({ phase: "error", message: "Sync is unavailable right now." }); return; }
        setSessionWallet(body?.status === "active" ? String(body.wallet).toLowerCase() : null);
      })
      .catch(() => { if (!cancelled) setSessionWallet(null); });
    return () => { cancelled = true; };
  }, [enabled, walletAddr]);

  // Hydrate exactly once per (wallet, session) — never on a timer.
  useEffect(() => {
    if (!enabled || !walletAddr || !sessionWallet) return;
    if (sessionWallet !== walletAddr.toLowerCase()) {
      // The connected wallet changed under an old session. Do not sync someone
      // else's workspace into this browser; make the user sign in again.
      setState({ phase: "signed-out" });
      return;
    }
    if (hydrated.current === sessionWallet) return;
    hydrated.current = sessionWallet;

    let cancelled = false;
    setState({ phase: "hydrating" });
    fetch("/api/workspace", { cache: "no-store" })
      .then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))
      .then(({ status, body }) => {
        if (cancelled) return;
        if (status === 503) {
          // Explicitly do nothing to localStorage. See the route's header.
          setState({ phase: "error", message: "Could not read your synced workspace — local data left as-is." });
          hydrated.current = null; // let a later attempt retry
          return;
        }
        if (status === 401) { setState({ phase: "signed-out" }); hydrated.current = null; return; }
        if (body?.status === "found" && body.sections) {
          hydrateWorkspace(body.sections as Partial<WorkspaceSections>, walletAddr);
        }
        // `empty` is a real answer: nothing synced yet. Our local copy uploads
        // on the next change check, which seeds the server.
        setState({ phase: "idle", at: Date.now() });
      })
      .catch(() => {
        if (cancelled) return;
        setState({ phase: "error", message: "Could not reach the sync service." });
        hydrated.current = null;
      });
    return () => { cancelled = true; };
  }, [enabled, walletAddr, sessionWallet]);

  // Mirror local → server. Polls localStorage (cheap, no network) and only
  // uploads when the fingerprint actually moved.
  useEffect(() => {
    if (!enabled || !walletAddr || !sessionWallet) return;
    if (sessionWallet !== walletAddr.toLowerCase()) return;

    let cancelled = false;

    async function push() {
      if (cancelled) return;
      const sections = snapshotWorkspace(walletAddr);
      const body     = JSON.stringify({ sections });
      const fp       = fingerprint(body);

      if (fp === lastSent.current) return;
      if (Date.now() - lastSentAt.current < MIN_UPLOAD_GAP_MS) return;

      setState({ phase: "syncing" });
      try {
        const r = await fetch("/api/workspace", {
          method:  "PUT",
          headers: { "Content-Type": "application/json" },
          body,
        });
        if (cancelled) return;
        if (r.ok) {
          lastSent.current   = fp;
          lastSentAt.current = Date.now();
          setState({ phase: "idle", at: Date.now() });
          return;
        }
        const err = await r.json().catch(() => ({}));
        if (r.status === 401) { setState({ phase: "signed-out" }); return; }
        // 413 / 429 / 503 all mean "nothing was saved" — say so rather than
        // showing a checkmark. Do NOT advance lastSent, so we retry.
        setState({ phase: "error", message: String(err?.error ?? "Sync failed — nothing was saved.") });
      } catch {
        if (!cancelled) setState({ phase: "error", message: "Offline — changes are saved locally and will sync later." });
      }
    }

    const id = setInterval(push, CHANGE_CHECK_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [enabled, walletAddr, sessionWallet]);

  const enable = useCallback(async () => {
    if (!walletAddr) return;
    setState({ phase: "hydrating" });
    try {
      const signed = await signIn();
      setSyncEnabled(true, walletAddr);
      setEnabledState(true);
      setSessionWallet(signed.toLowerCase());
      hydrated.current = null;
    } catch (e) {
      setState({ phase: "error", message: (e as Error).message || "Sign-in was cancelled." });
    }
  }, [walletAddr, signIn]);

  const disable = useCallback(async () => {
    setSyncEnabled(false, walletAddr);
    setEnabledState(false);
    setSessionWallet(null);
    hydrated.current = null;
    lastSent.current = "";
    setState({ phase: "off" });
    // End the server session. The workspace record is left alone — see `forget`.
    await fetch("/api/auth/session", { method: "DELETE" }).catch(() => null);
  }, [walletAddr]);

  const forget = useCallback(async () => {
    await fetch("/api/workspace", { method: "DELETE" }).catch(() => null);
    lastSent.current = "";
    setState({ phase: "idle", at: Date.now() });
  }, []);

  return { state, enabled, sessionWallet, enable, disable, forget };
}
