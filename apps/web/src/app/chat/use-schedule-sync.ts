"use client";
/**
 * Blue Chat — keeping the browser's task list and the server's scheduler agreed.
 *
 * Two copies exist because they answer different questions. localStorage is what
 * the panel renders and works with no account at all; `crons:w:<wallet>` is what
 * a cron can read at 09:00 while the tab is closed. This hook is the seam.
 *
 * ── Who owns which field ─────────────────────────────────────────────────────
 * The split is not symmetric, and it can't be — both sides write, so "last write
 * wins" would mean a tick landing mid-edit either loses the user's rename or
 * resurrects a task they just switched off.
 *
 *   CLIENT owns  label · schedule · time · tz · prompt · tier · background
 *   SERVER owns  nextAt · lastRun · lastResult · lastError · pausedReason
 *   `active` is the client's — EXCEPT when the server paused it, which it
 *   reports by attaching a `pausedReason`. That is a fact about a run that
 *   already happened (usually an empty balance), so the client adopts it. Any
 *   other `active:false` from the server is stale and the local value wins.
 *
 * ── Only background tasks are uploaded ───────────────────────────────────────
 * A task with `background` off never leaves the browser. Nothing about a
 * foreground task needs to be on a server, and every row we upload is a row a
 * cron will read forever.
 *
 * ── A 503 is not an empty schedule ───────────────────────────────────────────
 * Same rule as `/api/workspace`: on "could not check", do nothing. Rendering
 * "no scheduled tasks" during a KV throttle is how a user re-creates tasks that
 * already exist and gets billed for both.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { CronTask } from "./types";
import { isBackground } from "./storage";

export type ScheduleState =
  | { phase: "off" }                     // nothing is scheduled server-side
  | { phase: "signed-out" }              // background tasks exist, no session
  | { phase: "syncing" }
  | { phase: "idle";  at: number }
  | { phase: "error"; message: string };

export interface UseScheduleSync {
  state: ScheduleState;
  /** How many tasks are set to run in the background. */
  count: number;
  /**
   * Turn background running on for one task. Prompts for a signature if there is
   * no session yet — that is the whole cost of the feature, and it is charged
   * once, at the moment the user asks for unattended spending.
   */
  enable:  (id: string) => Promise<void>;
  disable: (id: string) => Promise<void>;
}

/** The fields the server is allowed to decide, as sent back on a GET. */
interface ServerTask {
  id:            string;
  active?:       boolean;
  nextAt?:       number;
  lastRun?:      number;
  lastResult?:   string;
  lastError?:    string;
  pausedReason?: string;
}

/** Only what the server needs. Everything else stays in the browser. */
function toPayload(c: CronTask) {
  return {
    id: c.id, label: c.label, schedule: c.schedule,
    time: c.time, tz: c.tz, prompt: c.prompt,
    tier: c.tier ?? "pro", active: c.active,
  };
}

/** Cheap change detector, so an unchanged list never costs a request. */
function fingerprint(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

export function useScheduleSync(
  walletAddr: string | undefined,
  crons: CronTask[],
  patchCron: (id: string, patch: Partial<CronTask>) => void,
  signIn: () => Promise<string>,
): UseScheduleSync {
  const [state, setState] = useState<ScheduleState>({ phase: "off" });

  const lastSent = useRef<string>("");
  const pulled   = useRef<string | null>(null);   // wallet we have already pulled for

  const background = crons.filter(isBackground);
  const payload    = JSON.stringify(background.map(toPayload));

  // ── Pull: adopt whatever the scheduler did while we were away ──────────────
  //
  // Once per wallet, on open. Not on a timer: the tick writes at most once per
  // task per day, so polling would spend requests to learn nothing. Re-opening
  // the tab is the natural refresh.
  useEffect(() => {
    if (!walletAddr || background.length === 0) return;
    if (pulled.current === walletAddr) return;
    pulled.current = walletAddr;

    let cancelled = false;
    fetch("/api/chat/schedule", { cache: "no-store" })
      .then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))
      .then(({ status, body }) => {
        if (cancelled) return;
        if (status === 401) { setState({ phase: "signed-out" }); pulled.current = null; return; }
        if (status === 503) {
          // Explicitly leave the local list alone. See the header.
          setState({ phase: "error", message: "Couldn't reach the scheduler — showing your local tasks." });
          pulled.current = null;
          return;
        }
        const tasks = Array.isArray(body?.tasks) ? (body.tasks as ServerTask[]) : [];
        for (const t of tasks) {
          if (!t?.id) continue;
          const patch: Partial<CronTask> = {
            nextAt:     t.nextAt,
            lastRun:    t.lastRun,
            lastResult: t.lastResult,
            lastError:  t.lastError,
          };
          // A pause is a fact about a run that already happened, so it wins over
          // the local `active`. A bare `active:false` is not — it may simply be
          // an older copy of a task the user re-enabled on this device.
          if (t.pausedReason) {
            patch.pausedReason = t.pausedReason;
            patch.active = false;
          } else {
            patch.pausedReason = undefined;
          }
          patchCron(t.id, patch);
        }
        setState({ phase: "idle", at: Date.now() });
      })
      .catch(() => {
        if (cancelled) return;
        setState({ phase: "error", message: "Couldn't reach the scheduler." });
        pulled.current = null;
      });
    return () => { cancelled = true; };
  }, [walletAddr, background.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Push: mirror the background subset up whenever it changes ──────────────
  useEffect(() => {
    if (!walletAddr) return;
    const fp = fingerprint(payload);
    if (fp === lastSent.current) return;

    // An empty list still uploads once — it is how "I turned my last background
    // task off" reaches the scheduler. Without it the task keeps firing.
    if (background.length === 0 && lastSent.current === "") {
      lastSent.current = fp;
      setState({ phase: "off" });
      return;
    }

    let cancelled = false;
    setState({ phase: "syncing" });
    fetch("/api/chat/schedule", {
      method:  "PUT",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ tasks: JSON.parse(payload) }),
    })
      .then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))
      .then(({ status, body }) => {
        if (cancelled) return;
        if (status === 401) { setState({ phase: "signed-out" }); return; }
        if (!(status >= 200 && status < 300)) {
          // Do NOT record the fingerprint — the next change retries.
          setState({ phase: "error", message: body?.error ?? "Couldn't save your schedule." });
          return;
        }
        lastSent.current = fp;
        // Adopt the server's `nextAt`, so the panel shows the instant the cron
        // will actually use rather than one the browser computed separately.
        for (const t of (body?.tasks ?? []) as ServerTask[]) {
          if (t?.id && typeof t.nextAt === "number") patchCron(t.id, { nextAt: t.nextAt });
        }
        setState(background.length === 0 ? { phase: "off" } : { phase: "idle", at: Date.now() });
      })
      .catch(() => {
        if (!cancelled) setState({ phase: "error", message: "Couldn't reach the scheduler." });
      });
    return () => { cancelled = true; };
  }, [walletAddr, payload]); // eslint-disable-line react-hooks/exhaustive-deps

  const enable = useCallback(async (id: string) => {
    if (!walletAddr) {
      setState({ phase: "error", message: "Connect a wallet to run tasks in the background." });
      return;
    }
    // Sign in FIRST, then flip the flag. Flipping first would show the task as
    // scheduled while the PUT that makes it true is still 401-ing — a task the
    // UI says is running and nothing is running.
    if (state.phase === "signed-out" || state.phase === "off") {
      try {
        await signIn();
      } catch (e) {
        setState({ phase: "error", message: (e as Error).message || "Sign-in was cancelled." });
        return;
      }
    }
    pulled.current = null;   // let the next pull adopt this task's run history
    patchCron(id, { background: true });
  }, [walletAddr, state.phase, signIn, patchCron]);

  const disable = useCallback(async (id: string) => {
    // Clears the server-owned fields too: leaving a stale `nextAt` behind would
    // make the card claim a firing time nothing is going to honour.
    patchCron(id, { background: false, nextAt: undefined, pausedReason: undefined });
  }, [patchCron]);

  return { state, count: background.length, enable, disable };
}
