/**
 * Arb lane audit — what the ABSOLUTE 0.5% pass mark actually measures.
 *
 * ⚠️ THIS SCRIPT PROPOSES NOTHING. The arb grading rule stays the absolute test
 * (`|spread| < 0.5%`). Nothing published is rewritten. This is measurement only,
 * and it is deliberately structured so that the most tempting wrong conclusion
 * is the one it argues hardest against — see PART 3.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * Blue Hood publishes two lanes side by side, as if they were the same kind of
 * number. They are graded by rules of different SHAPE:
 *
 *   drift → RELATIVE. HIT when the gap closes >= 50% of the gap that existed at
 *           fire. The bar scales with the arrow.
 *   arb   → ABSOLUTE. HIT when the spread ends below 0.5%, full stop. The bar is
 *           the same number regardless of where the spread started.
 *
 * The absolute rule is the economically right shape for arb: a spread trade pays
 * when the spread drops under your fee + slippage cost, and that cost is an
 * absolute number, not a fraction of where the spread happened to open. So this
 * is not an argument to change it. It IS a reason to know exactly how much of
 * the arb lane's published shape comes from the rule rather than from the market
 * — because the two rates sit next to each other on a public page.
 *
 * ── THE CRUX (PART 2) ────────────────────────────────────────────────────────
 * An absolute pass mark is a MOVING relative target. To end under 0.5%:
 *
 *     a 1.0% spread must close  50%
 *     a 1.5% spread must close  67%
 *     a 2.0% spread must close  75%
 *     a 3.0% spread must close  83%
 *
 * Arb fires at |spread| >= 1.0%, so every arb arrow is asked for AT LEAST 50%
 * closure, and wider ones are asked for much more. Any decline in hit rate as
 * fire gap widens is therefore expected before a single price moves. PART 4
 * separates that artifact from real behaviour by re-running the same buckets
 * under the relative rule, where the bar does not move.
 *
 * ── THE TRAP THIS SCRIPT REFUSES TO FALL INTO (PART 3) ───────────────────────
 * Regrading arb under drift's relative rule raises the hit rate. That number is
 * worthless as evidence and the script says so in-line, because the increase is
 * a THEOREM, not a finding: for a fire gap g >= 1.0%, the relative rule needs
 * `now <= 0.5g` and the absolute rule needs `now < 0.5`, and `0.5g >= 0.5` for
 * all g >= 1.0. The relative bar is weakly looser on EVERY arb arrow that can
 * exist. So the rate can only go up or stay, and every flip must be miss->hit.
 * The script asserts exactly that and fails loudly if any flip runs the other
 * way — a hit->miss flip would mean the reconstruction below is broken, not that
 * the finding is interesting.
 *
 * What IS informative: the flip COUNT (how much of the record sits in the band
 * between the two rules) and the PART 4 gradient.
 *
 * ── WHERE THE NUMBERS COME FROM ──────────────────────────────────────────────
 * FIRE gap  — `snapshot_at_fire.oracle_price_usd` + `reference_price`, exact.
 * CLOSE gap — `grading_math.now_gap_pct` when present; otherwise parsed out of
 *             `outcome_detail` prose ("spread narrowed to X%" / "spread still
 *             X%"), which the grader wrote at the true grading instant.
 *
 * The prose path exists because arb carried NO `grading_math` at all until
 * 2026-08-14 (P2b). Prefer the structured field, fall back to prose, and report
 * the split so a later reader knows which rows came from where.
 *
 * ── WHAT THIS SCRIPT STILL CANNOT ANSWER ─────────────────────────────────────
 * Which LEG moved. `now_gap_pct` is a magnitude, so "the spread closed" cannot
 * be split into "the DEX came back" vs "the oracle came to meet it" without
 * close-side price LEVELS. P2b started storing those on arb; PART 5 reports how
 * many arrows are decomposable yet, which is the only honest way to say "not
 * yet" without pretending the question is unanswerable.
 *
 * Read-only. Touches no KV, fires nothing, writes nothing.
 *   npx tsx scripts/arb-convention-dryrun.ts
 */
import { wilsonInterval } from "../src/lib/blue-hood/cohort-stats";
import type { Arrow } from "../src/lib/blue-hood/types";

const BASE = process.env.HOOD_BASE_URL ?? "https://blueagent.dev";
const TRACK_URL = `${BASE}/api/acp/track-record?limit=200`;

/** The live arb pass mark, mirrored from grader.ts (`ARB_HIT_SPREAD_PCT`). */
const ARB_HIT_SPREAD_PCT = 0.5;
/** The live drift pass mark, mirrored from grader.ts (`DRIFT_HIT_GAP_CLOSE_PCT`). */
const DRIFT_HIT_GAP_CLOSE_PCT = 0.5;
/** The engine's arb firing floor, mirrored from rule-engine.ts (`ARB_MIN_ABS_PCT`). */
const ARB_MIN_ABS_PCT = 1.0;

/** `spread narrowed to 0.399% (< 0.5%)` / `spread still 1.463% (>= 0.5%) after 4h` */
const ARB_DETAIL_RE = /spread (?:narrowed to|still)\s+([\d.]+)\s*%/;

/** How far `reference_price` may sit from `snapshot_at_fire.dex_price_usd`
 *  before the two are treated as disagreeing about the fire-time DEX price.
 *  They are written by the same code path, so anything above noise is a bug
 *  worth surfacing rather than silently averaging away. */
const FIRE_DEX_TOL_FRAC = 0.001;

interface Row {
  serial: string;
  ticker: string;
  outcome: string;
  fired_at: string;
  graded_at: string;
  fire_oracle: number;
  fire_dex: number;
  fire_gap_pct: number;
  now_gap_pct: number;
  /** Where `now_gap_pct` came from — structured field or parsed prose. */
  source: "grading_math" | "detail_prose";
  closed_by: number;
  /** Verdict as published, recomputed from the absolute rule for corroboration. */
  abs_hit: boolean;
  /** Counterfactual verdict under drift's relative rule. */
  rel_hit: boolean;
  /** Closure the absolute rule demanded of THIS arrow, given its fire gap. */
  demanded: number;
  /** Does the arrow carry close-side LEVELS (P2b) — i.e. is it decomposable? */
  decomposable: boolean;
}

function pct(n: number, d: number): string {
  return d === 0 ? "n/a" : `${Math.round((n / d) * 100)}%`;
}

function fmtCI(hits: number, n: number): string {
  if (n === 0) return "n=0";
  const { lo, hi } = wilsonInterval(hits, n);
  return `${hits}/${n} = ${pct(hits, n)}  95% CI [${(lo * 100).toFixed(0)}%, ${(hi * 100).toFixed(0)}%]`;
}

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return (await r.json()) as T;
}

/** Reconstruct one arb arrow's two gaps. Returns null (with a reason) when the
 *  arrow cannot be reconstructed — never a guessed value. */
function buildRow(a: Arrow): { row: Row } | { skip: string } {
  const fireOracle = a.snapshot_at_fire?.oracle_price_usd ?? null;
  const fireDex = a.reference_price;
  if (typeof fireOracle !== "number" || !(fireOracle > 0)) return { skip: "no fire-time oracle" };
  if (typeof fireDex !== "number" || !(fireDex > 0)) return { skip: "no fire-time dex" };

  // Prefer the structured field; it was recorded at the true grading instant.
  // The prose carries the same figure to 3dp and is the only source for every
  // arb arrow graded before P2b.
  let nowGap: number | null = null;
  let source: Row["source"] = "grading_math";
  const gm = a.grading_math;
  if (gm && typeof gm.now_gap_pct === "number" && Number.isFinite(gm.now_gap_pct)) {
    nowGap = gm.now_gap_pct;
  } else {
    const m = a.outcome_detail?.match(ARB_DETAIL_RE);
    const parsed = m ? Number(m[1]) : NaN;
    if (!Number.isFinite(parsed)) return { skip: "close gap not recoverable" };
    nowGap = parsed;
    source = "detail_prose";
  }

  const fireGap = Math.abs((fireDex - fireOracle) / fireOracle) * 100;
  if (!(fireGap > 0)) return { skip: "zero fire gap" };

  const closedBy = 1 - nowGap / fireGap;
  return {
    row: {
      serial: a.serial,
      ticker: a.ticker,
      outcome: a.outcome ?? "?",
      fired_at: a.fired_at,
      graded_at: a.graded_at ?? "",
      fire_oracle: fireOracle,
      fire_dex: fireDex,
      fire_gap_pct: fireGap,
      now_gap_pct: nowGap,
      source,
      closed_by: closedBy,
      abs_hit: nowGap < ARB_HIT_SPREAD_PCT,
      rel_hit: closedBy >= DRIFT_HIT_GAP_CLOSE_PCT,
      demanded: 1 - ARB_HIT_SPREAD_PCT / fireGap,
      decomposable:
        typeof gm?.close_oracle_price_usd === "number" && typeof gm?.close_dex_price_usd === "number",
    },
  };
}

/** Fire-gap buckets. Edges chosen so the first bucket sits right on the engine's
 *  own firing floor — that is where the absolute and relative rules coincide. */
const BUCKETS: { label: string; lo: number; hi: number }[] = [
  { label: "1.00-1.25%", lo: 1.0, hi: 1.25 },
  { label: "1.25-1.50%", lo: 1.25, hi: 1.5 },
  { label: "1.50-2.00%", lo: 1.5, hi: 2.0 },
  { label: ">= 2.00%", lo: 2.0, hi: Infinity },
];

async function main() {
  console.log("=".repeat(78));
  console.log("ARB CONVENTION AUDIT — what the absolute 0.5% pass mark measures");
  console.log("=".repeat(78));
  console.log("read-only · proposes no rule change · rewrites nothing\n");

  const track = await getJson<{ receipts?: { arrows?: Arrow[] } }>(TRACK_URL);
  const arrows = track?.receipts?.arrows ?? [];
  const arb = arrows.filter((a) => a.type === "arb");
  const gradedArb = arb.filter((a) => a.status === "graded" && (a.outcome === "hit" || a.outcome === "miss"));

  console.log(
    `arrows fetched ${arrows.length}   arb ${arb.length}   arb graded hit/miss ${gradedArb.length}` +
      `   (window: ${TRACK_URL})`,
  );

  // ── Part 1: can these arrows even be reconstructed? ───────────────────────
  console.log(`\n${"─".repeat(78)}\nPART 1 — RECONSTRUCTION COVERAGE\n${"─".repeat(78)}`);
  const rows: Row[] = [];
  const skips = new Map<string, number>();
  for (const a of gradedArb) {
    const r = buildRow(a);
    if ("skip" in r) {
      skips.set(r.skip, (skips.get(r.skip) ?? 0) + 1);
      continue;
    }
    rows.push(r.row);
  }
  console.log(`reconstructed ${rows.length}/${gradedArb.length}`);
  for (const [reason, n] of skips) console.log(`  dropped ${String(n).padStart(3)}  ${reason}`);

  const bySource = rows.reduce<Record<string, number>>((m, r) => ((m[r.source] = (m[r.source] ?? 0) + 1), m), {});
  console.log(
    `close-gap source: grading_math ${bySource.grading_math ?? 0}` +
      `   detail_prose ${bySource.detail_prose ?? 0}`,
  );
  if ((bySource.grading_math ?? 0) === 0) {
    console.log(
      `  ↳ every row came from PROSE. Expected for arb graded before P2b (2026-08-14),\n` +
        `    which is when the grader started writing grading_math on this lane at all.`,
    );
  }

  // Corroborate the published verdict against a recomputation of the same rule.
  // If these ever disagree, the parse is wrong and nothing below can be trusted.
  const verdictMismatch = rows.filter((r) => r.abs_hit !== (r.outcome === "hit"));
  console.log(
    `\npublished verdict vs recomputed absolute rule: ${rows.length - verdictMismatch.length}/${rows.length} agree`,
  );
  if (verdictMismatch.length > 0) {
    console.log(`  ⚠️ ${verdictMismatch.length} DISAGREE — the reconstruction is unsound, stop reading here:`);
    for (const r of verdictMismatch.slice(0, 10)) {
      console.log(`     ${r.serial} ${r.ticker} published=${r.outcome} recomputed=${r.abs_hit ? "hit" : "miss"} now=${r.now_gap_pct}%`);
    }
  }

  // `reference_price` and `snapshot_at_fire.dex_price_usd` are written by the
  // same fire path and should be the same number. Check rather than assume.
  let fireDexDisagree = 0;
  for (const a of gradedArb) {
    const snapDex = a.snapshot_at_fire?.dex_price_usd;
    if (typeof snapDex === "number" && snapDex > 0 && a.reference_price > 0) {
      if (Math.abs(snapDex - a.reference_price) / a.reference_price > FIRE_DEX_TOL_FRAC) fireDexDisagree++;
    }
  }
  console.log(
    `reference_price vs snapshot_at_fire.dex_price_usd: ${fireDexDisagree}/${gradedArb.length} disagree by >${FIRE_DEX_TOL_FRAC * 100}%`,
  );

  if (rows.length === 0) {
    console.log("\nnothing reconstructable — stopping.");
    return;
  }

  // ── Part 2: the absolute bar restated as a relative one ───────────────────
  console.log(`\n${"─".repeat(78)}\nPART 2 — AN ABSOLUTE BAR IS A MOVING RELATIVE BAR\n${"─".repeat(78)}`);
  console.log(`to finish under ${ARB_HIT_SPREAD_PCT}%, an arrow that fired at gap g must close:\n`);
  for (const g of [1.0, 1.25, 1.5, 2.0, 3.0, 5.0]) {
    console.log(`  fire gap ${g.toFixed(2).padStart(5)}%   ->  must close ${((1 - ARB_HIT_SPREAD_PCT / g) * 100).toFixed(0).padStart(3)}%`);
  }
  const demanded = rows.map((r) => r.demanded).sort((a, b) => a - b);
  const med = demanded[Math.floor(demanded.length / 2)];
  console.log(
    `\nacross the ${rows.length} reconstructed arrows the absolute rule demanded a median of` +
      ` ${(med * 100).toFixed(0)}% closure\n` +
      `(min ${(demanded[0] * 100).toFixed(0)}%, max ${(demanded[demanded.length - 1] * 100).toFixed(0)}%),` +
      ` versus drift's flat ${DRIFT_HIT_GAP_CLOSE_PCT * 100}%.\n` +
      `The engine fires arb only at >= ${ARB_MIN_ABS_PCT}%, so the demand never drops below 50%.`,
  );

  // ── Part 3: the counterfactual, and why its headline is worthless ─────────
  console.log(`\n${"─".repeat(78)}\nPART 3 — COUNTERFACTUAL REGRADE (and why the rate is NOT the finding)\n${"─".repeat(78)}`);
  const absHits = rows.filter((r) => r.abs_hit).length;
  const relHits = rows.filter((r) => r.rel_hit).length;
  const upFlips = rows.filter((r) => !r.abs_hit && r.rel_hit);
  const downFlips = rows.filter((r) => r.abs_hit && !r.rel_hit);

  console.log(`absolute rule (LIVE, published) : ${fmtCI(absHits, rows.length)}`);
  console.log(`relative rule (counterfactual)  : ${fmtCI(relHits, rows.length)}`);
  console.log(`flips: ${upFlips.length} miss->hit, ${downFlips.length} hit->miss`);

  console.log(
    `\n⚠️ DO NOT READ THE SECOND LINE AS "arb is really better than published".\n` +
      `   For any fire gap g >= ${ARB_MIN_ABS_PCT}%, passing relatively needs now <= ${DRIFT_HIT_GAP_CLOSE_PCT}g\n` +
      `   and passing absolutely needs now < ${ARB_HIT_SPREAD_PCT}. Since ${DRIFT_HIT_GAP_CLOSE_PCT}g >= ${ARB_HIT_SPREAD_PCT}\n` +
      `   whenever g >= ${ARB_MIN_ABS_PCT}, the relative bar is weakly looser on EVERY arb arrow that can\n` +
      `   exist. The rate can only rise. The rise is arithmetic, not evidence.`,
  );
  if (downFlips.length > 0) {
    console.log(
      `\n   ⚠️⚠️ ${downFlips.length} hit->miss flip(s) found. That is IMPOSSIBLE under the argument above,\n` +
        `   so the reconstruction has a bug — investigate before using any number here:`,
    );
    for (const r of downFlips.slice(0, 10)) {
      console.log(`      ${r.serial} ${r.ticker} fire=${r.fire_gap_pct.toFixed(3)}% now=${r.now_gap_pct.toFixed(3)}%`);
    }
  } else {
    console.log(`\n   ✅ 0 hit->miss flips, exactly as the argument requires — reconstruction is consistent.`);
  }
  console.log(
    `\nThe informative figure is the FLIP COUNT: ${upFlips.length}/${rows.length} (${pct(upFlips.length, rows.length)})` +
      ` of graded arb sits in the\nband between the two rules — closed a majority of its gap, but not to under` +
      ` ${ARB_HIT_SPREAD_PCT}%.\nThose are the arrows where "did it work?" genuinely depends on which question you asked.`,
  );
  if (upFlips.length > 0) {
    console.log(`\n  serial  ticker  fire%   now%    closed`);
    for (const r of upFlips.sort((a, b) => b.fire_gap_pct - a.fire_gap_pct).slice(0, 15)) {
      console.log(
        `  ${r.serial.padEnd(7)} ${r.ticker.padEnd(7)} ${r.fire_gap_pct.toFixed(2).padStart(5)}` +
          `   ${r.now_gap_pct.toFixed(2).padStart(5)}   ${(r.closed_by * 100).toFixed(0).padStart(3)}%`,
      );
    }
  }

  // ── Part 4: gradient — artifact or real? ──────────────────────────────────
  console.log(`\n${"─".repeat(78)}\nPART 4 — FIRE-GAP GRADIENT: ARTIFACT OR REAL?\n${"─".repeat(78)}`);
  console.log(
    `Under the absolute rule a wider gap must close more, so a declining hit rate is\n` +
      `expected before any price moves. The relative rule holds the bar flat across all\n` +
      `buckets, so it is the column that can carry real information.\n`,
  );
  console.log("fire gap      n   demanded   absolute rule        relative rule");
  for (const b of BUCKETS) {
    const inB = rows.filter((r) => r.fire_gap_pct >= b.lo && r.fire_gap_pct < b.hi);
    if (inB.length === 0) {
      console.log(`${b.label.padEnd(12)} ${String(0).padStart(3)}   —          —                    —`);
      continue;
    }
    const dem = inB.reduce((s, r) => s + r.demanded, 0) / inB.length;
    const aH = inB.filter((r) => r.abs_hit).length;
    const rH = inB.filter((r) => r.rel_hit).length;
    console.log(
      `${b.label.padEnd(12)} ${String(inB.length).padStart(3)}   ${`${(dem * 100).toFixed(0)}%`.padStart(8)}` +
        `   ${`${aH}/${inB.length} = ${pct(aH, inB.length)}`.padEnd(20)} ${rH}/${inB.length} = ${pct(rH, inB.length)}`,
    );
  }
  console.log(
    `\nRead the two rate columns against the "demanded" column, not against each other.\n` +
      `If the absolute column falls while the relative column stays flat, the gradient is\n` +
      `the rule. If BOTH fall, wider spreads genuinely converge less and that is a real\n` +
      `property of the signal worth acting on.\n` +
      `\nCheck n before reading any bucket: the widest bucket is chronically small because the\n` +
      `engine fires arb at >= ${ARB_MIN_ABS_PCT}% and most spreads sit just above it. A single arrow can\n` +
      `swing that row 50 points, which is why no verdict is printed here — only the counts.`,
  );

  // ── Part 5: what is still unanswerable, and when it stops being ───────────
  console.log(`\n${"─".repeat(78)}\nPART 5 — DIRECTION: NOT YET ANSWERABLE\n${"─".repeat(78)}`);
  const decomposable = rows.filter((r) => r.decomposable).length;
  console.log(
    `arb arrows carrying close-side price LEVELS: ${decomposable}/${rows.length}\n`,
  );
  console.log(
    `Every number above is built on gap MAGNITUDES, so none of them can say whether the\n` +
      `spread closed because the DEX came back or because the oracle came to meet it. That\n` +
      `distinction is the whole question for a user who took a side: ReviewSignPanel\n` +
      `pre-selects a direction from \`expected_direction\`, and a spread that closes from the\n` +
      `wrong leg pays them nothing while still printing HIT.\n`,
  );
  if (decomposable === 0) {
    console.log(
      `0 decomposable today is correct, not a failure: P2b (2026-08-14) is when arb started\n` +
        `storing close_oracle_price_usd + close_dex_price_usd. It is forward-only by nature —\n` +
        `the levels for already-graded arrows were never written and cannot be recovered.\n` +
        `Re-run this script once the count is non-trivial; PART 5 answers itself then.`,
    );
  } else {
    const s = rows.filter((r) => r.decomposable);
    console.log(`${s.length} decomposable arrow(s) available — see scripts/gap-closure-dryrun.ts for the split.`);
  }

  console.log(`\n${"=".repeat(78)}\ndone — nothing was written.\n${"=".repeat(78)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
