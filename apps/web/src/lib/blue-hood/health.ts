/**
 * Blue Hood — engine health.
 *
 * WHY THIS FILE EXISTS: the 2026-07-27 outage (Upstash hit its 500K plan cap)
 * left the engine dark for hours because every surface read the snapshot via
 * `kvGet`, which swallows the KV error and returns null — indistinguishable
 * from "the poller never ran". The board said "warming up", the bot said
 * nothing, and nobody could tell it apart from a genuine cold start.
 *
 * This module refuses to collapse those causes. It probes KV WITHOUT swallowing
 * (via `kvGetProbe`) and cross-references TWO timestamps:
 *
 *   • snapshot.started_at  — last poll that SUCCEEDED end-to-end (persisted).
 *   • poll heartbeat.at     — last time the cron ROUTE fired at all.
 *
 * From those it produces exactly one of five non-overlapping states, each with
 * a cause string that names the REAL problem — never a blind "poller hasn't
 * run". The Telegram broadcaster (and the /hood banner) read this so that when
 * the engine is silent, they can say WHY instead of going silent too.
 */
import { kvGetProbe } from "@/lib/kv";
import { KV_SNAPSHOT_LATEST, KV_POLL_HEARTBEAT } from "./kv-keys";
import type { HoodSnapshot } from "./types";

/** The cron cadence (see vercel.json — poll runs once every 5 min). */
export const POLL_INTERVAL_S = 300;

/**
 * Freshness bands (seconds), measured against snapshot.started_at.
 *   • ≤ HEALTHY: fine. A cycle itself can take ~246s, so one interval of slack
 *     on top of the cadence is normal — hence ~2 intervals before we even warn.
 *   • ≤ LAGGING: one fully-missed cycle. Still `ok`, but surfaced as a warning.
 *   • >  LAGGING: not ok. Something stopped producing snapshots.
 * STALLED aligns with the board's existing 15-min StaleBanner so the UI's amber
 * and this module's "not ok" flip at the same moment.
 */
export const HEALTHY_MAX_AGE_S = 660; // ~2.2 intervals
export const LAGGING_MAX_AGE_S = 900; // 15 min — matches HoodClient StaleBanner
/** Heartbeat older than this ⇒ the cron route itself has stopped firing. */
export const HEARTBEAT_STALE_AGE_S = 660;

export type EngineStatus =
  | "healthy"       // fresh snapshot — all good
  | "lagging"       // one cycle late — still ok, worth a soft warning
  | "poll_failing"  // cron IS firing (heartbeat fresh) but snapshots have gone stale
  | "cron_stalled"  // no snapshot AND no recent heartbeat — the scheduler stopped
  | "never_polled"  // KV reachable, but nothing has ever been written (cold start)
  | "kv_error";     // KV unreachable (throttle / plan-cap / network) — state UNKNOWN

export interface EngineHealth {
  status: EngineStatus;
  /** true only for healthy | lagging. A consumer gating a broadcast checks this. */
  ok: boolean;
  /**
   * Whether we could actually observe engine state. false ⇒ `kv_error`: the
   * engine may be perfectly fine, we simply can't see it. This is the field
   * that stops "we can't read KV" from being reported as "the engine is down".
   */
  observable: boolean;
  /** Cause-specific one-liner. NEVER a blind "poller hasn't run". */
  cause: string;
  /** now − snapshot.started_at, or null when there is no snapshot / KV is unreadable. */
  snapshot_age_s: number | null;
  /** now − heartbeat.at, or null when absent / unreadable. */
  heartbeat_age_s: number | null;
  /** ISO of the last successful poll (snapshot.started_at), or null. */
  last_poll_at: string | null;
  /** ISO of the last time the cron route fired (heartbeat.at), or null. */
  last_cron_fire_at: string | null;
  expected_interval_s: number;
  thresholds: { healthy_max_age_s: number; lagging_max_age_s: number; heartbeat_stale_age_s: number };
  checked_at: string;
}

function ageSeconds(iso: string | undefined | null, now: number): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? Math.round((now - t) / 1000) : null;
}

/**
 * Compute engine health from KV. Never throws — a KV failure becomes the
 * `kv_error` state, which is itself a valid, honest answer ("we cannot see").
 */
export async function computeEngineHealth(now: number = Date.now()): Promise<EngineHealth> {
  const base = {
    observable: true,
    snapshot_age_s: null as number | null,
    heartbeat_age_s: null as number | null,
    last_poll_at: null as string | null,
    last_cron_fire_at: null as string | null,
    expected_interval_s: POLL_INTERVAL_S,
    thresholds: {
      healthy_max_age_s: HEALTHY_MAX_AGE_S,
      lagging_max_age_s: LAGGING_MAX_AGE_S,
      heartbeat_stale_age_s: HEARTBEAT_STALE_AGE_S,
    },
    checked_at: new Date(now).toISOString(),
  };

  // Probe the snapshot WITHOUT swallowing. A thrown KV command (throttle / cap)
  // is the single most important thing to surface distinctly — it means we are
  // BLIND, not that the engine is down.
  const snapProbe = await kvGetProbe<HoodSnapshot>(KV_SNAPSHOT_LATEST);
  if (snapProbe.status === "error") {
    return {
      ...base,
      status: "kv_error",
      ok: false,
      observable: false,
      cause: `KV unreachable (${snapProbe.message}). Engine state UNKNOWN — likely an Upstash throttle/plan-cap, NOT a confirmed engine failure. Do not report the engine as down; report that monitoring is blind.`,
    };
  }

  // Heartbeat probe only matters once we know KV itself is answering. If IT
  // throws while the snapshot didn't, treat the same as blind — we can't trust
  // a half-readable KV to reason about cron liveness.
  const beatProbe = await kvGetProbe<{ at?: string }>(KV_POLL_HEARTBEAT);
  if (beatProbe.status === "error") {
    return {
      ...base,
      status: "kv_error",
      ok: false,
      observable: false,
      cause: `KV partially unreachable (${beatProbe.message}). Engine state UNKNOWN — monitoring is blind, not confirmed down.`,
    };
  }

  const heartbeatAt = beatProbe.status === "hit" ? beatProbe.value?.at ?? null : null;
  const heartbeatAge = ageSeconds(heartbeatAt, now);
  const heartbeatFresh = heartbeatAge !== null && heartbeatAge <= HEARTBEAT_STALE_AGE_S;

  // No snapshot at all: is the cron even firing?
  if (snapProbe.status === "miss") {
    if (heartbeatFresh) {
      // The route fires but has never produced a snapshot — a persistent
      // failure INSIDE the cycle (e.g. runPollCycle throwing every time).
      return {
        ...base,
        status: "poll_failing",
        ok: false,
        heartbeat_age_s: heartbeatAge,
        last_cron_fire_at: heartbeatAt,
        cause: "Cron is firing (recent heartbeat) but no snapshot has ever persisted — every cycle is failing before it writes. Check the poll route's runPollCycle/persist path, not the scheduler.",
      };
    }
    return {
      ...base,
      status: "never_polled",
      ok: false,
      heartbeat_age_s: heartbeatAge,
      last_cron_fire_at: heartbeatAt,
      cause: "No snapshot and no recent cron heartbeat — the poller has never run (cold start, or the schedule was never wired up).",
    };
  }

  // We have a snapshot. Age it.
  const snap = snapProbe.value;
  const snapAge = ageSeconds(snap.started_at, now);
  const withData = {
    ...base,
    snapshot_age_s: snapAge,
    heartbeat_age_s: heartbeatAge,
    last_poll_at: snap.started_at ?? null,
    last_cron_fire_at: heartbeatAt,
  };

  if (snapAge === null) {
    // Snapshot present but its timestamp is unparseable — treat as failing
    // rather than pretend it's fresh.
    return {
      ...withData,
      status: "poll_failing",
      ok: false,
      cause: "Latest snapshot has an unparseable started_at — the poll is writing malformed data. Investigate persistSnapshot.",
    };
  }

  if (snapAge <= HEALTHY_MAX_AGE_S) {
    return { ...withData, status: "healthy", ok: true, cause: `Fresh snapshot ${snapAge}s ago.` };
  }

  if (snapAge <= LAGGING_MAX_AGE_S) {
    return {
      ...withData,
      status: "lagging",
      ok: true,
      cause: `Snapshot is ${snapAge}s old (expected every ${POLL_INTERVAL_S}s) — one cycle late. Watching.`,
    };
  }

  // Snapshot is stale. Heartbeat decides WHY.
  if (heartbeatFresh) {
    return {
      ...withData,
      status: "poll_failing",
      ok: false,
      cause: `Cron is firing (heartbeat ${heartbeatAge}s ago) but the snapshot is ${snapAge}s old — cycles are running yet failing to persist. Code/data bug in the poll path, not the scheduler.`,
    };
  }

  return {
    ...withData,
    status: "cron_stalled",
    ok: false,
    cause: `No snapshot for ${snapAge}s and no cron heartbeat for ${heartbeatAge ?? "∞"}s — the scheduler itself has stopped firing (check vercel.json crons / GitHub Action).`,
  };
}
