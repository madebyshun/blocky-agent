"use client";

/**
 * usePolling — the one poll loop for the whole app (#148 ③).
 *
 * Six components ran their own byte-identical copy of this effect:
 *
 *   useEffect(() => {
 *     const ctl = new AbortController();
 *     load(ctl.signal);
 *     const t = setInterval(() => load(ctl.signal), REFRESH_MS);
 *     return () => { ctl.abort(); clearInterval(t); };
 *   }, [load]);
 *
 * Every one of them polled forever, whether or not anyone was looking. A tab
 * left open on /app/hood/arrows in a background window fetched a ~51 KB payload
 * four times a minute, indefinitely, to update pixels nobody could see.
 *
 * This hook is that effect plus one rule: WHEN THE TAB IS HIDDEN, STOP.
 *
 * ── Why a hook and not six inline `document.hidden` checks ──────────────────
 * The catch-up rule below is the kind of thing that is correct in the first
 * copy and wrong by the fourth. Six hand-written copies of a visibility state
 * machine is how you get five that pause and one that doesn't, and the one that
 * doesn't is invisible until a bill arrives. There is exactly one copy.
 *
 * ── The trap this hook exists to avoid ─────────────────────────────────────
 * The naive version — "refetch on visibilitychange" — makes things WORSE, not
 * better. Alt-tabbing between two windows fires a request per toggle, with no
 * lower bound on the gap. A user cycling tabs for ten seconds can trivially
 * out-request the 15s interval they replaced. So the catch-up is gated on
 * `minCatchUpGapMs`: on regain we only fetch immediately if we have actually
 * been away longer than one poll period. Below that, we let the next scheduled
 * tick handle it. Pausing must never be able to cost more than not pausing.
 *
 * ── What this does NOT claim ───────────────────────────────────────────────
 * Browsers already throttle timers in hidden tabs (Chrome clamps background
 * `setInterval` to roughly 1/minute, and harder still after a few minutes).
 * So the saving here is NOT `interval → 0`; against Chrome it is more like
 * "1/min → 0" for a hidden tab. That is a real saving and it is smaller than
 * the naive `86400/interval` arithmetic suggests. The reason to do it anyway
 * is that the throttle is a browser-version-dependent courtesy, differs across
 * Safari/Firefox, and does not apply to a tab that is merely occluded rather
 * than hidden — whereas this does, everywhere, deterministically.
 */

import { useEffect } from "react";

export type PollOptions = {
  /**
   * Minimum time since the last fetch before a visibility-regain triggers an
   * immediate catch-up. Defaults to one full `intervalMs`, which is the value
   * that makes "pause" provably never cost more than "don't pause".
   */
  minCatchUpGapMs?: number;
  /**
   * Set false to hold the loop off entirely (e.g. a gate that hasn't resolved).
   * Mirrors the `if (!ready) return;` guard callers would otherwise write
   * around the effect. Defaults true.
   */
  enabled?: boolean;
};

/**
 * The whole loop, as a plain function — no React. Returns its own teardown.
 *
 * This is split out from the hook so the behaviour can be tested directly
 * (`scripts/use-polling-test.ts`) without a renderer. The hook below is a
 * three-line wrapper over THIS function, so the tested unit is the shipped
 * unit rather than a second implementation that agrees with it today.
 */
export function createPollLoop(
  fn: (signal: AbortSignal) => void | Promise<void>,
  intervalMs: number,
  options: PollOptions = {},
): () => void {
  const { minCatchUpGapMs, enabled = true } = options;
  const catchUpGap = minCatchUpGapMs ?? intervalMs;

  if (!enabled) return () => {};
  // Effects don't run during SSR, so `document` is defined by the time the hook
  // calls this. The guard is for non-DOM environments importing the module.
  if (typeof document === "undefined") return () => {};

  const ctl = new AbortController();
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastRunAt = 0;

  const run = () => {
    lastRunAt = Date.now();
    // `fn` owns its own error handling (all six callers already swallow
    // AbortError). Float the promise rather than let a rejection escape into
    // an unhandled-rejection on an interval tick.
    void Promise.resolve(fn(ctl.signal)).catch(() => {});
  };

  const start = () => {
    if (timer !== null) return; // already ticking — never stack intervals
    timer = setInterval(run, intervalMs);
  };

  const stop = () => {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  };

  const onVisibilityChange = () => {
    if (document.hidden) {
      stop();
      return;
    }
    // See the header: unconditional catch-up here is the bug, not the feature.
    if (Date.now() - lastRunAt >= catchUpGap) run();
    start();
  };

  // Always fetch once on mount, even if the tab mounts hidden (opening a link
  // in a background tab). One fetch gives the component something to paint
  // the moment it's revealed; what we refuse to do is keep ticking.
  run();
  if (!document.hidden) start();

  document.addEventListener("visibilitychange", onVisibilityChange);
  return () => {
    document.removeEventListener("visibilitychange", onVisibilityChange);
    stop();
    ctl.abort();
  };
}

/**
 * Runs `fn` immediately, then every `intervalMs` — but only while the document
 * is visible. `fn` receives an `AbortSignal` that is aborted on unmount, so
 * in-flight requests are cancelled exactly as the hand-rolled version did.
 *
 * `fn` should be wrapped in `useCallback` by the caller. It is a dependency of
 * the internal effect, so an unstable identity restarts the loop — the same
 * contract the six inline copies already had.
 */
export function usePolling(
  fn: (signal: AbortSignal) => void | Promise<void>,
  intervalMs: number,
  options: PollOptions = {},
): void {
  const { minCatchUpGapMs, enabled = true } = options;
  const catchUpGap = minCatchUpGapMs ?? intervalMs;

  useEffect(
    () => createPollLoop(fn, intervalMs, { minCatchUpGapMs: catchUpGap, enabled }),
    [fn, intervalMs, catchUpGap, enabled],
  );
}
