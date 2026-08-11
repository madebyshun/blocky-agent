/**
 * Blue Hood — engine-health context + banner (task 1.3).
 *
 * WHY THIS EXISTS: before this, /hood had exactly one way to say "the engine
 * isn't fresh": a single amber `StaleBanner` plus a blind "Poller warming up"
 * error line. BOTH collapsed three very different causes into one message:
 *
 *   • KV throttle / plan-cap  → we're BLIND, engine may be fine.
 *   • poll has never run       → genuine cold start.
 *   • cron scheduler stopped   → the thing that fires the poll is dead.
 *
 * That collapse is exactly what hid the 2026-07-27 Upstash-cap outage for hours
 * (the board just said "warming up"). This provider reads `/api/hood/health`,
 * which runs the non-swallowing `computeEngineHealth` probe, and renders a
 * cause-specific banner so the board never again blames the poller for what is
 * actually a monitoring blackout — or vice-versa.
 *
 * It is deliberately self-contained (own palette, own poll loop) so the same
 * banner can be dropped onto any surface that wants the honest engine state
 * (a future ops page, the Telegram-status web view, etc.).
 */
"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { EngineHealth, EngineStatus } from "@/lib/blue-hood/health";

/** Health polls a touch slower than the board's 15s — engine state moves in minutes. */
const HEALTH_POLL_MS = 20_000;

// Self-contained palette (mirrors HoodClient's, kept local so this module has
// no import coupling to the board component).
const RED = "#ef4444";
const AMBER = "#f5b342";
const MUTED = "#6b7280";

type HealthState = {
  health: EngineHealth | null;
  /** true until the FIRST fetch resolves — banners stay silent during it. */
  loading: boolean;
  /**
   * The health fetch itself threw (offline / route 500). This is the BROWSER's
   * blindness, not the engine's — surfaced as its own state rather than letting
   * a failed fetch masquerade as a healthy engine.
   */
  unreachable: boolean;
};

const HealthContext = createContext<HealthState>({ health: null, loading: true, unreachable: false });

/** Subscribe to the live engine health. Any child under <HealthProvider> can call this. */
export function useEngineHealth(): HealthState {
  return useContext(HealthContext);
}

export function HealthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<HealthState>({ health: null, loading: true, unreachable: false });

  const poll = useCallback(async (signal?: AbortSignal) => {
    try {
      // IMPORTANT: a `kv_error` health answer comes back as HTTP 503 but with a
      // fully-valid body (observable:false). We must parse it REGARDLESS of
      // res.ok — the 503 means "blind", and showing WHY we're blind is the
      // entire point. Only a genuine parse/network throw is `unreachable`.
      const res = await fetch("/api/hood/health", { cache: "no-store", signal });
      const body = (await res.json()) as EngineHealth;
      setState({ health: body, loading: false, unreachable: false });
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setState((s) => ({ health: s.health, loading: false, unreachable: true }));
    }
  }, []);

  useEffect(() => {
    const ctl = new AbortController();
    poll(ctl.signal);
    const t = setInterval(() => poll(ctl.signal), HEALTH_POLL_MS);
    return () => {
      ctl.abort();
      clearInterval(t);
    };
  }, [poll]);

  return <HealthContext.Provider value={state}>{children}</HealthContext.Provider>;
}

// ── Banner ───────────────────────────────────────────────────────────────────

function fmtAge(sec: number | null | undefined): string {
  if (sec === null || sec === undefined) return "∞";
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

type Tone = "red" | "amber" | "grey";

const TONE_STYLE: Record<Tone, { border: string; bg: string; color: string }> = {
  // Red = we cannot trust what we're seeing (blind). Amber = confirmed-bad but
  // visible. Grey = benign (cold start / one cycle late) — informational.
  red: { border: "#4a1d1d", bg: "#1a0c0c", color: "#f6a6a6" },
  amber: { border: "#3b2a15", bg: "#1a1408", color: "#f6c88f" },
  grey: { border: "#22262e", bg: "#0d0f14", color: "#9aa1ac" },
};

const ICON: Record<Tone, string> = { red: "⛔", amber: "⚠", grey: "○" };

/**
 * The one banner. Returns null for a healthy engine (no chrome when all is
 * well). Every other state renders its OWN sentence naming the real cause —
 * never a blind "poller hasn't run".
 */
export function HealthBanner() {
  const { health, loading, unreachable } = useEngineHealth();

  // First load: say nothing. A flash of "warming up" before the first health
  // answer would itself be a (brief) lie.
  if (loading && !health && !unreachable) return null;

  // The browser couldn't even reach /api/hood/health. Distinct from kv_error:
  // there, the SERVER told us it's blind; here, WE can't hear the server.
  if (unreachable && !health) {
    return (
      <Banner tone="red">
        can&apos;t reach the health endpoint — this page may be offline or the route is erroring. Engine
        state is unverified; do not assume it&apos;s down.
      </Banner>
    );
  }

  if (!health) return null;

  const s: EngineStatus = health.status;
  if (s === "healthy") return null;

  const snapAge = fmtAge(health.snapshot_age_s);
  const beatAge = fmtAge(health.heartbeat_age_s);

  switch (s) {
    case "lagging":
      return (
        <Banner tone="grey">
          one cycle late · last poll {snapAge} ago (expected every {Math.round(health.expected_interval_s / 60)} min).
          Still within tolerance — watching.
        </Banner>
      );

    case "kv_error":
      return (
        <Banner tone="red">
          <strong>monitoring blind</strong> · KV is unreachable, so the engine&apos;s state is UNKNOWN — most
          likely an Upstash throttle / plan-cap, <em>not</em> a confirmed outage. The engine may be running
          fine; we simply can&apos;t read it. Check the Upstash request quota, not the poller.
        </Banner>
      );

    case "never_polled":
      return (
        <Banner tone="grey">
          warming up · no snapshot has been produced yet and no recent cron heartbeat — a cold start (or the
          schedule was never wired up). In dev, POST to{" "}
          <code className="font-mono text-white text-[11px]">/api/cron/blue-hood/poll</code> with your{" "}
          <code className="font-mono text-white text-[11px]">CRON_SECRET</code>.
        </Banner>
      );

    case "poll_failing":
      return (
        <Banner tone="amber">
          <strong>cycles failing</strong> · the cron IS firing (heartbeat {beatAge} ago) but the snapshot is{" "}
          {snapAge} old — every cycle runs yet fails to persist. This is a code/data bug in the poll path
          (runPollCycle / persistSnapshot), not the scheduler.
        </Banner>
      );

    case "cron_stalled":
      return (
        <Banner tone="amber">
          <strong>scheduler stopped</strong> · no snapshot for {snapAge} and no cron heartbeat for {beatAge} —
          the thing that fires the poll has itself died. Check vercel.json crons / the GitHub Action, not the
          poll code.
        </Banner>
      );

    default:
      return null;
  }
}

function Banner({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  const st = TONE_STYLE[tone];
  return (
    <div
      role="alert"
      className="mb-6 rounded border px-3 py-2 text-[12px] hood-prose leading-relaxed"
      style={{ borderColor: st.border, backgroundColor: st.bg, color: st.color }}
    >
      <span aria-hidden style={{ color: tone === "red" ? RED : tone === "amber" ? AMBER : MUTED }}>
        {ICON[tone]}
      </span>{" "}
      {children}
    </div>
  );
}
