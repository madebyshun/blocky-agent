/**
 * P0.1 dry-run — proves the void criterion tightening (2026-07-24 follow-up).
 *
 * Original PR #220 criterion (voided): reg_hrs < 0.5h AND graded during
 * closed market. Miss-only. This catches ~16 arrows but leaves plenty of
 * "chấm non" (undercooked) grades — e.g. #0039 INTC (arb, fired 15:34 ET,
 * graded 19:34 ET) had 0.43h regular of the 4h window and got a HIT verdict.
 *
 * New criterion: reg_hrs < arrow.grading_window_h. Applies to BOTH hit
 * AND miss. Drop the "graded during closed" gate — the window-elapsed
 * check subsumes it.
 *
 * 1. VOID backfill preview: fetches prod arrows and applies the NEW
 *    logic. Prints hit rate before + after, plus the breakdown of
 *    HITs-becoming-void vs MISSes-becoming-void.
 * 2. OPEN arrows preview: unchanged — shows wall-clock vs regular-session
 *    hours for currently-open drift/arb.
 *
 * Read-only. Does NOT hit KV. Uses public /api/hood/arrows on prod.
 *
 * Run: cd apps/web && npx tsx scripts/p0-dry-run.ts
 */

// Force this file to be treated as a module (not a global script), so its
// top-level `main()` doesn't collide with other scripts under `apps/web/scripts/`
// when Next's typecheck scans the tree. Without this, the build fails with
// "Duplicate function implementation" against semantic-smoke.ts.
export {};

// ── COPY of PR #220 helpers, verbatim, so the script IS the code ─────────
const REGULAR_OPEN_MIN = 9 * 60 + 30;
const REGULAR_CLOSE_MIN = 16 * 60;

function nyseOpenAt(tMs: number): boolean {
  const ny = new Date(tMs - 4 * 3600 * 1000);
  const day = ny.getUTCDay();
  if (day === 0 || day === 6) return false;
  const minutes = ny.getUTCHours() * 60 + ny.getUTCMinutes();
  return minutes >= REGULAR_OPEN_MIN && minutes < REGULAR_CLOSE_MIN;
}

function regularHoursElapsed(fireIso: string, nowMs: number): number {
  const fireMs = new Date(fireIso).getTime();
  if (!Number.isFinite(fireMs) || nowMs <= fireMs) return 0;
  const STEP = 5 * 60 * 1000;
  let acc = 0;
  for (let t = fireMs; t < nowMs; t += STEP) {
    if (nyseOpenAt(t)) acc += STEP;
  }
  return acc / 3_600_000;
}

// ── Fetch prod arrows ────────────────────────────────────────────────────

interface Arrow {
  id: string;
  serial: string;
  ticker: string;
  type: "drift" | "arb" | "flow" | "whale";
  status: "open" | "graded" | "informational";
  outcome: "hit" | "miss" | "void" | "informational" | null;
  grading_window_h: number;
  fired_at: string;
  graded_at: string | null;
}

async function main() {
  const r = await fetch("https://blueagent.dev/api/hood/arrows?limit=500");
  const j = (await r.json()) as { ok: boolean; arrows: Arrow[] };
  if (!j.ok) { console.error("prod fetch failed"); process.exit(1); }
  const arrows = j.arrows;
  const now = Date.now();

  // ── 1. VOID BACKFILL PREVIEW (new criterion) ───────────────────────────
  const graded = arrows.filter((a) => a.status === "graded");
  const oldMisses = graded.filter((a) => a.outcome === "miss");
  const oldHits = graded.filter((a) => a.outcome === "hit");
  const oldInfo = graded.filter((a) => a.outcome === "informational");
  const alreadyVoid = graded.filter((a) => a.outcome === "void");
  const wouldVoidHit: Arrow[] = [];
  const wouldVoidMiss: Arrow[] = [];

  for (const a of graded) {
    if (a.outcome !== "miss" && a.outcome !== "hit") continue;
    if (a.type !== "drift" && a.type !== "arb") continue;
    if (!a.graded_at) continue;
    const gradedMs = new Date(a.graded_at).getTime();
    if (!Number.isFinite(gradedMs)) continue;
    const regHrs = regularHoursElapsed(a.fired_at, gradedMs);
    if (regHrs < a.grading_window_h) {
      if (a.outcome === "hit") wouldVoidHit.push(a);
      else wouldVoidMiss.push(a);
    }
  }

  const newHitCount = oldHits.length - wouldVoidHit.length;
  const newMissCount = oldMisses.length - wouldVoidMiss.length;
  const oldDenom = oldHits.length + oldMisses.length;
  const newDenom = newHitCount + newMissCount;
  const oldHitPct = oldDenom > 0 ? Math.round((oldHits.length / oldDenom) * 100) : 0;
  const newHitPct = newDenom > 0 ? Math.round((newHitCount / newDenom) * 100) : 0;

  console.log("═══ VOID BACKFILL PREVIEW (reg_hrs < required_window) ═══");
  console.log(`total arrows fetched:        ${arrows.length}`);
  console.log(`graded arrows:               ${graded.length}`);
  console.log(`  hits:                      ${oldHits.length}`);
  console.log(`  misses:                    ${oldMisses.length}`);
  console.log(`  informational:             ${oldInfo.length}`);
  console.log(`  already void (prior PR):   ${alreadyVoid.length}`);
  console.log();
  console.log(`WOULD be VOIDED (new PR):    ${wouldVoidHit.length + wouldVoidMiss.length}`);
  console.log(`  from HIT → void:           ${wouldVoidHit.length}`);
  console.log(`  from MISS → void:          ${wouldVoidMiss.length}`);
  console.log();
  console.log(`Hit rate BEFORE:   ${oldHits.length}/${oldDenom} = ${oldHitPct}%`);
  console.log(`Hit rate AFTER:    ${newHitCount}/${newDenom} = ${newHitPct}%`);
  console.log();

  const printVoidRow = (label: string, list: Arrow[]) => {
    if (list.length === 0) return;
    console.log(`\n${label} (up to 25):`);
    console.log(`${"serial".padEnd(8)} ${"ticker".padEnd(7)} ${"type".padEnd(6)} ${"win".padEnd(4)} ${"fired (ET-ish)".padEnd(20)} ${"graded (ET-ish)".padEnd(20)} reg_hrs`);
    for (const a of list.slice(0, 25)) {
      const fireLocal = new Date(new Date(a.fired_at).getTime() - 4 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ");
      const gradeLocal = a.graded_at ? new Date(new Date(a.graded_at).getTime() - 4 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ") : "—";
      const regHrs = a.graded_at ? regularHoursElapsed(a.fired_at, new Date(a.graded_at).getTime()).toFixed(2) : "?";
      console.log(`${a.serial.padEnd(8)} ${a.ticker.padEnd(7)} ${a.type.padEnd(6)} ${(a.grading_window_h + "h").padEnd(4)} ${fireLocal.padEnd(20)} ${gradeLocal.padEnd(20)} ${regHrs}`);
    }
    if (list.length > 25) console.log(`  … and ${list.length - 25} more`);
  };
  printVoidRow("Prior HIT → VOID", wouldVoidHit);
  printVoidRow("Prior MISS → VOID", wouldVoidMiss);

  // ── 2. OPEN ARROWS UNDER NEW CLOCK ─────────────────────────────────────
  const openArrows = arrows.filter((a) => a.status === "open");
  const openDriftArb = openArrows.filter((a) => a.type === "drift" || a.type === "arb");

  console.log("\n═══ OPEN ARROWS UNDER NEW MARKET-AWARE CLOCK ═══");
  console.log(`open arrows total:              ${openArrows.length}`);
  console.log(`  drift/arb (affected):         ${openDriftArb.length}`);
  console.log(`  flow/whale (wall-clock kept): ${openArrows.length - openDriftArb.length}`);
  console.log();

  if (openDriftArb.length > 0) {
    console.log(`Effect on drift/arb open arrows (wall-clock vs new regular-session clock):`);
    console.log(`${"serial".padEnd(8)} ${"ticker".padEnd(7)} ${"type".padEnd(6)} ${"window".padEnd(7)} ${"wall_hrs".padEnd(10)} ${"reg_hrs".padEnd(9)} ${"ready?".padEnd(8)} status`);
    let readyNow = 0, willWait = 0;
    for (const a of openDriftArb) {
      const fireMs = new Date(a.fired_at).getTime();
      const wallHrs = (now - fireMs) / 3_600_000;
      const regHrs = regularHoursElapsed(a.fired_at, now);
      const readyOld = wallHrs >= a.grading_window_h;
      const readyNew = regHrs >= a.grading_window_h;
      let status = "";
      if (readyOld && readyNew) { status = "grade both"; readyNow++; }
      else if (readyOld && !readyNew) { status = "OLD graded ↦ WAITS under new"; willWait++; }
      else if (!readyOld && readyNew) { status = "impossible?"; }
      else { status = "stays open (both clocks agree)"; }
      console.log(`${a.serial.padEnd(8)} ${a.ticker.padEnd(7)} ${a.type.padEnd(6)} ${(a.grading_window_h + "h").padEnd(7)} ${wallHrs.toFixed(2).padEnd(10)} ${regHrs.toFixed(2).padEnd(9)} ${(readyNew ? "yes" : "no").padEnd(8)} ${status}`);
    }
    console.log();
    console.log(`Ready to grade under new clock:      ${readyNow}`);
    console.log(`Would have been graded (old clock)`);
    console.log(`   but now WAITS for regular hours:  ${willWait}`);
  }

  console.log("\n═══ END OF DRY RUN ═══");
}

main().catch((e) => { console.error(e); process.exit(1); });
