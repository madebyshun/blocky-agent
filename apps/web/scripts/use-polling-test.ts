/**
 * Tests for `src/hooks/usePolling.ts` (#148 ③).
 *
 * Run:  npx tsx scripts/use-polling-test.ts
 *
 * No renderer and no fake-timer library. The hook is a three-line wrapper over
 * `createPollLoop`, which is plain JS, so we test that directly with a stub
 * `document` and real timers at millisecond scale.
 *
 * ── Why these cases are PAIRED ─────────────────────────────────────────────
 * The interesting logic here is the catch-up guard, and it has TWO failure
 * modes that pull in opposite directions. A test suite that only checks one of
 * them is passed trivially by a broken implementation:
 *
 *   • Case D (long gap → catch up) is passed by "always catch up on regain".
 *   • Case E (short gap → do NOT catch up) is passed by "never catch up".
 *
 * Neither degenerate version passes BOTH. D without E is the dangerous one:
 * "always catch up" is the naive implementation, and on a user alt-tabbing
 * between two windows it fires a request per toggle — strictly worse than not
 * pausing at all. E is the case that makes this optimisation safe to ship, so
 * it is the case that must exist.
 *
 * Case G is the same idea for a different bug: pausing is only a win if the
 * loop actually STOPS. A no-op `stop()` still passes A, B, D and E.
 */

import { createPollLoop } from "../src/hooks/usePolling";

// ── stub document ───────────────────────────────────────────────────────────
type Listener = () => void;
const listeners = new Set<Listener>();
const fakeDoc = {
  hidden: false,
  addEventListener: (type: string, cb: Listener) => { if (type === "visibilitychange") listeners.add(cb); },
  removeEventListener: (type: string, cb: Listener) => { if (type === "visibilitychange") listeners.delete(cb); },
};
(globalThis as unknown as { document: typeof fakeDoc }).document = fakeDoc;

function setHidden(v: boolean) {
  fakeDoc.hidden = v;
  for (const cb of [...listeners]) cb();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

/** A counting poll fn plus the signals it was handed. */
function spy() {
  const signals: AbortSignal[] = [];
  const fn = (s: AbortSignal) => { signals.push(s); };
  return { fn, signals, get calls() { return signals.length; } };
}

const IV = 60; // poll interval used throughout

async function main() {
  console.log("\nusePolling / createPollLoop\n");

  // ── A. baseline: runs immediately, then on the interval ───────────────────
  {
    fakeDoc.hidden = false;
    const s = spy();
    const stop = createPollLoop(s.fn, IV);
    check("A1 fires immediately on mount", s.calls === 1, `got ${s.calls}`);
    await sleep(IV * 3.5);
    check("A2 keeps ticking while visible", s.calls >= 4, `got ${s.calls} after ~3.5 intervals`);
    stop();
  }

  // ── B. teardown stops the loop and aborts in-flight work ─────────────────
  {
    fakeDoc.hidden = false;
    const s = spy();
    const stop = createPollLoop(s.fn, IV);
    await sleep(IV * 1.5);
    const atStop = s.calls;
    stop();
    check("B1 signal aborted on teardown", s.signals[0].aborted);
    await sleep(IV * 3);
    check("B2 no ticks after teardown", s.calls === atStop, `${atStop} → ${s.calls}`);
    check("B3 listener removed on teardown", listeners.size === 0, `${listeners.size} left`);
  }

  // ── C. hidden tab stops polling ──────────────────────────────────────────
  {
    fakeDoc.hidden = false;
    const s = spy();
    const stop = createPollLoop(s.fn, IV);
    await sleep(IV * 1.5);
    const atHide = s.calls;
    setHidden(true);
    await sleep(IV * 4);
    check("C1 no polling while hidden", s.calls === atHide, `${atHide} → ${s.calls} over ~4 intervals`);
    stop();
    fakeDoc.hidden = false;
  }

  // ── D. regain after a LONG gap → immediate catch-up ──────────────────────
  //     Pair with E. "Always catch up" passes D and fails E.
  {
    fakeDoc.hidden = false;
    const s = spy();
    const stop = createPollLoop(s.fn, IV);
    setHidden(true);
    await sleep(IV * 2.5); // away longer than one interval
    const before = s.calls;
    setHidden(false);
    check("D1 catches up immediately after a long absence", s.calls === before + 1, `${before} → ${s.calls}`);
    stop();
  }

  // ── E. CONTROL — regain after a SHORT gap → NO catch-up ──────────────────
  //     This is the case that makes pausing safe. Without it, rapid alt-tabbing
  //     costs more than never pausing at all.
  {
    fakeDoc.hidden = false;
    const s = spy();
    const stop = createPollLoop(s.fn, IV);
    const before = s.calls; // 1, from mount
    for (let i = 0; i < 5; i++) { setHidden(true); setHidden(false); } // 5 fast toggles
    check("E1 rapid alt-tab does NOT fire a request per toggle", s.calls === before, `${before} → ${s.calls} after 5 toggles`);
    stop();
  }

  // ── F. no stacked intervals after repeated "visible" events ──────────────
  //     A missing `if (timer !== null) return` guard in start() creates a
  //     SECOND interval, permanently doubling the poll rate — an optimisation
  //     that silently becomes an amplifier.
  //
  //     ⚠ This case originally toggled hidden→visible and did NOT catch the
  //     bug: every toggle passes through stop(), which nulls the timer, so the
  //     guard was never reached. Mutation testing exposed that; the fix is to
  //     fire consecutive VISIBLE events with no intervening hide, which is the
  //     only shape that actually reaches start() twice in a row.
  {
    fakeDoc.hidden = false;
    const s = spy();
    const stop = createPollLoop(s.fn, IV);
    for (let i = 0; i < 4; i++) setHidden(false); // 4 visible events, never hidden
    const before = s.calls;
    await sleep(IV * 2.2);
    const ticks = s.calls - before;
    check("F1 repeated show events do not stack intervals", ticks <= 3, `${ticks} ticks in ~2.2 intervals`);
    stop();
    // Teardown must kill EVERY interval it created, not just the newest.
    const afterStop = s.calls;
    await sleep(IV * 2);
    check("F2 teardown clears all intervals", s.calls === afterStop, `${afterStop} → ${s.calls}`);
  }

  // ── G. CONTROL — the pause must be a real saving, not a relabel ──────────
  //     Directly compares hidden vs visible over the same wall-clock window.
  {
    fakeDoc.hidden = false;
    const vis = spy();
    const stopVis = createPollLoop(vis.fn, IV);
    await sleep(IV * 4);
    stopVis();

    fakeDoc.hidden = true;
    const hid = spy();
    const stopHid = createPollLoop(hid.fn, IV);
    await sleep(IV * 4);
    stopHid();
    fakeDoc.hidden = false;

    check("G1 visible tab polled repeatedly", vis.calls >= 4, `got ${vis.calls}`);
    check("G2 hidden tab polled once (mount only)", hid.calls === 1, `got ${hid.calls}`);
    check("G3 hidden strictly cheaper than visible", hid.calls < vis.calls, `${hid.calls} vs ${vis.calls}`);
  }

  // ── H. mounting hidden still fetches once (so it can paint on reveal) ────
  {
    fakeDoc.hidden = true;
    const s = spy();
    const stop = createPollLoop(s.fn, IV);
    check("H1 one fetch even when mounted hidden", s.calls === 1, `got ${s.calls}`);
    await sleep(IV * 3);
    check("H2 but no ticking while still hidden", s.calls === 1, `got ${s.calls}`);
    stop();
    fakeDoc.hidden = false;
  }

  // ── I. enabled:false is a true no-op ─────────────────────────────────────
  {
    fakeDoc.hidden = false;
    const s = spy();
    const stop = createPollLoop(s.fn, IV, { enabled: false });
    await sleep(IV * 2);
    check("I1 enabled:false never fetches", s.calls === 0, `got ${s.calls}`);
    stop();
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
