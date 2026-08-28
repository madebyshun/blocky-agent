/**
 * Control test for the arrow list field trim (#148 ⑤ tier-1).
 *
 * Run: `npx tsx scripts/arrow-field-trim-test.ts` from `apps/web/`.
 * Hermetic — pure functions over a synthetic arrow, no KV and no network.
 *
 * THE POINT OF THIS FILE IS THE SECOND HALF OF EACH PAIR.
 *
 * "The list response no longer contains `grading_math`" is trivially satisfied
 * by deleting the field from the codebase, which is the one outcome this change
 * must NOT have — `grading_math` carries the close-side price levels that make
 * the "oracle catches up vs DEX reverts" decomposition answerable at all, and
 * the 2026-08-12 attempt already failed once for want of exactly those levels.
 * So every "is it gone from the list" assertion is paired with an "is it still
 * reachable at ?fields=full, with the identical value" assertion. Either half
 * alone passes for a broken implementation:
 *
 *   • trim-only assertions   → pass if the field was deleted outright
 *   • full-mode assertions   → pass if the trim silently does nothing
 *
 * Case D is the one that catches the subtlest failure: `projectArrowForList`
 * must not MUTATE its input. These records come out of the hydrated blob cache
 * (#148 ②), which is shared across requests in a warm lambda — an in-place
 * `delete` would strip the fields from the cache itself, so `?fields=full`
 * would return the full shape on a cold process and a trimmed one after any
 * list request had run. That is a deletion wearing a projection's clothes, and
 * it would not show up in any assertion that only inspects the return value.
 */

import {
  LIST_OMITTED_FIELDS,
  parseArrowFieldMode,
  projectArrowForList,
  projectArrows,
  omittedFieldsNote,
} from "../src/lib/blue-hood/arrow-fields";
import type { Arrow } from "../src/lib/blue-hood/types";

let failures = 0;
function check(label: string, pass: boolean, detail: string) {
  console.log(`${pass ? "  ✓" : "  ✗"} ${label} — ${detail}`);
  if (!pass) failures++;
}

/** `k in o` without casting `Arrow` to an index-signature type. */
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * A record carrying every field the trim touches, with distinguishable values.
 * Deliberately NOT `as Arrow` — the cast would hide a fixture that has drifted
 * from the real type, and a test fixture that no longer matches what ships is
 * the quietest way to make a green suite meaningless.
 */
function makeArrow(serial = "#0001"): Arrow {
  return {
    id: `arrow-${serial}`,
    serial,
    ticker: "NVDA",
    chain: "base",
    type: "drift",
    expected_direction: "up",
    grading_window_h: 2,
    reference_price: 100,
    snapshot_refs: [11, 22, 33],
    fired_at: new Date().toISOString(),
    status: "graded",
    outcome: "hit",
    graded_at: new Date().toISOString(),
    outcome_detail: "gap closed 62%",
    origin: "engine",
    brief_worker_at: "2026-08-28T00:00:00.000Z",
    grading_math: {
      basis: "fire_oracle",
      fire_oracle_price_usd: 101,
      fire_dex_price_usd: 100,
      fire_gap_pct: 0.99,
      now_gap_pct: 0.38,
      closed_by_pct: 62,
      close_oracle_price_usd: 100.5,
      close_dex_price_usd: 100.1,
    },
    ticker_confidence: {
      level: "normal",
      basis: "ticker_type",
      n: 17,
      hits: 11,
      wilson_high: 0.81,
      computed_at: "2026-08-28T00:00:00.000Z",
    },
  };
}

const sp = (q: string) => new URL(`https://x/api?${q}`).searchParams;

function main() {
  console.log("\n#148 ⑤ tier-1 — arrow list field trim, control test\n");

  // ── A. mode parsing ──────────────────────────────────────────────────────
  console.log("A. MODE — only the exact string `full` opts out of the trim:");
  check("no query → list",            parseArrowFieldMode(sp("limit=200")) === "list", parseArrowFieldMode(sp("limit=200")));
  check("fields=full → full",         parseArrowFieldMode(sp("fields=full")) === "full", parseArrowFieldMode(sp("fields=full")));
  check("fields=list → list",         parseArrowFieldMode(sp("fields=list")) === "list", parseArrowFieldMode(sp("fields=list")));
  // Fails toward the SMALLER payload: a typo must not quietly restore 26%.
  check("fields=FULL (wrong case) → list", parseArrowFieldMode(sp("fields=FULL")) === "list", parseArrowFieldMode(sp("fields=FULL")));
  check("fields= (empty) → list",     parseArrowFieldMode(sp("fields=")) === "list", parseArrowFieldMode(sp("fields=")));

  // ── B. the trim actually trims ───────────────────────────────────────────
  console.log("\nB. TRIM — list mode omits all four, and nothing else:");
  const arrow = makeArrow();
  const listed = projectArrowForList(arrow);
  for (const f of LIST_OMITTED_FIELDS) {
    check(`omits ${f}`, !has(listed, f), `${f} in response = ${has(listed, f)}`);
  }
  // Guards against an over-broad trim quietly eating a rendered field.
  const kept = Object.keys(arrow).filter((k) => !(LIST_OMITTED_FIELDS as readonly string[]).includes(k));
  const missing = kept.filter((k) => !has(listed, k));
  check("keeps every other field", missing.length === 0, missing.length ? `dropped: ${missing.join(",")}` : `${kept.length} fields kept`);
  check("serial/ticker/outcome survive",
    listed.serial === "#0001" && listed.ticker === "NVDA" && listed.outcome === "hit",
    `serial=${listed.serial} ticker=${listed.ticker} outcome=${listed.outcome}`);

  // ── C. CONTROL — the data is still THERE, not deleted ───────────────────
  // Without this block, "delete the four fields from types.ts and every writer"
  // passes section B perfectly.
  console.log("\nC. CONTROL — ?fields=full still returns all four, byte-identical:");
  const [full] = projectArrows([arrow], "full") as Arrow[];
  for (const f of LIST_OMITTED_FIELDS) {
    check(`full mode returns ${f}`, has(full, f), `present=${has(full, f)}`);
  }
  check("full mode is value-identical to the source arrow",
    JSON.stringify(full) === JSON.stringify(arrow),
    JSON.stringify(full) === JSON.stringify(arrow) ? "deep-equal" : "DIVERGED");
  // The specific field the decomposition depends on — named explicitly so a
  // future trim that swallows it fails with the right words on screen.
  check("grading_math close-side levels survive full mode",
    full.grading_math?.close_oracle_price_usd === 100.5 && full.grading_math?.close_dex_price_usd === 100.1,
    `oracle=${full.grading_math?.close_oracle_price_usd} dex=${full.grading_math?.close_dex_price_usd}`);

  // ── D. CONTROL — the projection must not mutate the shared cache record ──
  console.log("\nD. NO MUTATION — the source record is untouched after a list projection:");
  const source = makeArrow("#0002");
  const before = JSON.stringify(source);
  projectArrowForList(source);
  projectArrows([source], "list");
  check("source arrow unchanged after projecting", JSON.stringify(source) === before,
    JSON.stringify(source) === before ? "identical" : "SOURCE WAS MUTATED");
  // The failure this actually guards: list-then-full inside one warm process.
  const [afterFull] = projectArrows([source], "full") as Arrow[];
  check("full mode still complete after a list projection ran first",
    LIST_OMITTED_FIELDS.every((f) => has(afterFull, f)),
    LIST_OMITTED_FIELDS.filter((f) => !has(afterFull, f)).join(",") || "all four present");

  // ── E. the response admits what it withheld ─────────────────────────────
  console.log("\nE. SELF-DESCRIBING — the payload names the omission and the way out:");
  const listNote = omittedFieldsNote("list");
  const fullNote = omittedFieldsNote("full");
  check("list mode reports fields=list", listNote.fields === "list", listNote.fields);
  check("list mode lists exactly the four omitted",
    JSON.stringify([...listNote.omitted_fields].sort()) === JSON.stringify([...LIST_OMITTED_FIELDS].sort()),
    listNote.omitted_fields.join(","));
  check("list mode tells the caller how to get them", /fields=full/.test(String(listNote.omitted_hint ?? "")), String(listNote.omitted_hint ?? "").slice(0, 48) + "…");
  check("full mode reports an empty omission list",
    fullNote.fields === "full" && fullNote.omitted_fields.length === 0,
    `${fullNote.fields}, ${fullNote.omitted_fields.length} omitted`);

  console.log(failures === 0 ? "\n✓ all field-trim control assertions passed\n" : `\n✗ ${failures} assertion(s) failed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
