/**
 * CI guard on the holdings decision table — `src/lib/wallet/read-state.ts`.
 *
 * Run: `npx tsx scripts/read-state-test.ts` from `apps/web/`.
 * Hermetic: pure functions + reading three source files. No env, no network.
 *
 * WHAT THIS PROTECTS, in one line: the wallet must never tell a user they hold
 * nothing on the strength of a read that did not establish it.
 *
 * That sentence has been false in production. PR #421 measured it: a live
 * holdings call returned `{"holdings":[],"partial":true}` — Moralis was down so
 * only a curated majors list had been probed — and the table rendered "No
 * tokens on Base yet". The list was empty because the read was degraded, and
 * the screen reported it as a fact about the wallet.
 *
 * Fixing that one table would have left the same bug standing in the two beside
 * it, which is exactly what had already happened: three tables, three
 * hand-rolled answers to one question, drifting apart. So the derivation moved
 * into a module and this file is the thing that keeps it there. Two halves:
 *
 *   1. THE TABLE — every one of the 32 input combinations, with its expected
 *      verdict written out literally. Not generated: a generator shares its
 *      author's assumptions with the code under test, so a wrong rule would be
 *      wrong identically in both places and pass. Written out, a behaviour
 *      change is 32 visible lines in the diff that someone has to justify.
 *
 *   2. THE INVARIANTS — the same guarantees restated as properties over the raw
 *      INPUTS, so they hold even if `readState` itself regresses. The table
 *      says what the function returns; the invariants say what must be true no
 *      matter how it is rewritten.
 *
 * Plus a source check that the three tables actually CONSUME the module, since
 * a shared derivation nothing imports is just a fourth copy waiting to happen.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  readState,
  resolveRead,
  type ReadSignals,
  type ReadState,
  type ReadBody,
} from "../src/lib/wallet/read-state";

let failures = 0;
let checks = 0;

function ok(label: string, pass: boolean, detail = "") {
  checks++;
  if (pass) {
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? `: ${detail}` : ""}`);
  }
}

type Bit = 0 | 1;
type Case = {
  sig: ReadSignals;
  state: ReadState;
  body: ReadBody;
  footnote: boolean;
  floor: boolean;
  empty: boolean;
};

/** One row of the decision table, positional so the columns line up below. */
function c(
  loading: Bit, received: Bit, failed: Bit, partial: Bit, rowCount: number,
  state: ReadState, body: ReadBody, footnote: boolean, floor: boolean, empty: boolean,
): Case {
  return {
    sig: { loading: !!loading, received: !!received, failed: !!failed, partial: !!partial, rowCount },
    state, body, footnote, floor, empty,
  };
}

const sigLabel = (s: ReadSignals) =>
  `L${+s.loading} R${+s.received} F${+s.failed} P${+s.partial} rows=${s.rowCount}`;

// ── 1. THE DECISION TABLE ───────────────────────────────────────────────────
//
// All 2^4 signal combinations × {no rows, some rows}. Nothing is skipped as
// "impossible": `loading && received` is a refetch over stale rows, and
// `failed && partial` is a real production payload — TokenTable's fetch catch
// sets BOTH on purpose, so that a reader checking only `partial` cannot
// conclude completeness from a request that never returned.
//
//    loading ─┐  received ─┐  failed ─┐  partial ─┐  rows ─┐
const TABLE: Case[] = [
  // ── Nothing to show. This block is the bug: four different reasons for an
  //    empty list, and only ONE of them is about the wallet.
  //   L  R  F  P  rows      state        body        footnote  floor  empty
  c(0, 0, 0, 0,   0,        "pending",  "pending",   false,    true,  false),
  c(0, 0, 0, 1,   0,        "pending",  "pending",   false,    true,  false),
  c(0, 0, 1, 0,   0,        "pending",  "pending",   false,    true,  false),
  c(0, 0, 1, 1,   0,        "pending",  "pending",   false,    true,  false),
  c(0, 1, 0, 0,   0,        "complete", "empty",     false,    false, true ), // ← the ONLY empty
  c(0, 1, 0, 1,   0,        "partial",  "partial",   false,    true,  false), // ← the #421 case
  c(0, 1, 1, 0,   0,        "failed",   "failed",    false,    true,  false),
  c(0, 1, 1, 1,   0,        "failed",   "failed",    false,    true,  false), // failed outranks partial
  c(1, 0, 0, 0,   0,        "pending",  "pending",   false,    true,  false),
  c(1, 0, 0, 1,   0,        "pending",  "pending",   false,    true,  false),
  c(1, 0, 1, 0,   0,        "pending",  "pending",   false,    true,  false),
  c(1, 0, 1, 1,   0,        "pending",  "pending",   false,    true,  false),
  c(1, 1, 0, 0,   0,        "pending",  "pending",   false,    true,  false),
  c(1, 1, 0, 1,   0,        "pending",  "pending",   false,    true,  false),
  c(1, 1, 1, 0,   0,        "pending",  "pending",   false,    true,  false),
  c(1, 1, 1, 1,   0,        "pending",  "pending",   false,    true,  false),

  // ── Rows to show. A degraded read that still returned something shows it and
  //    qualifies it — the caveat becomes a footnote instead of a banner, and
  //    the header total becomes a floor ("≥") instead of a figure.
  //   L  R  F  P  rows      state        body        footnote  floor  empty
  c(0, 0, 0, 0,   2,        "pending",  "pending",   false,    true,  false),
  c(0, 0, 0, 1,   2,        "pending",  "pending",   false,    true,  false),
  c(0, 0, 1, 0,   2,        "pending",  "pending",   false,    true,  false),
  c(0, 0, 1, 1,   2,        "pending",  "pending",   false,    true,  false),
  c(0, 1, 0, 0,   2,        "complete", "rows",      false,    false, false), // ← the only bare total
  c(0, 1, 0, 1,   2,        "partial",  "rows",      true,     true,  false),
  c(0, 1, 1, 0,   2,        "failed",   "rows",      true,     true,  false),
  c(0, 1, 1, 1,   2,        "failed",   "rows",      true,     true,  false),
  c(1, 0, 0, 0,   2,        "pending",  "pending",   false,    true,  false),
  c(1, 0, 0, 1,   2,        "pending",  "pending",   false,    true,  false),
  c(1, 0, 1, 0,   2,        "pending",  "pending",   false,    true,  false),
  c(1, 0, 1, 1,   2,        "pending",  "pending",   false,    true,  false),
  c(1, 1, 0, 0,   2,        "pending",  "pending",   false,    true,  false), // refetch hides stale rows
  c(1, 1, 0, 1,   2,        "pending",  "pending",   false,    true,  false),
  c(1, 1, 1, 0,   2,        "pending",  "pending",   false,    true,  false),
  c(1, 1, 1, 1,   2,        "pending",  "pending",   false,    true,  false),
];

console.log("\ndecision table (32 combinations)");
ok("table covers every combination exactly once",
   TABLE.length === 32 && new Set(TABLE.map(t => sigLabel(t.sig))).size === 32,
   `${TABLE.length} rows, ${new Set(TABLE.map(t => sigLabel(t.sig))).size} distinct`);

let tableMismatches = 0;
for (const t of TABLE) {
  const v = resolveRead(t.sig);
  const got  = `${v.state}/${v.body}/${+v.footnote}${+v.totalIsFloor}${+v.canAssertEmpty}`;
  const want = `${t.state}/${t.body}/${+t.footnote}${+t.floor}${+t.empty}`;
  if (got !== want) {
    tableMismatches++;
    console.log(`  FAIL  ${sigLabel(t.sig)} → ${got}, table says ${want}`);
  }
  // `readState` is exported separately and must agree with what `resolveRead`
  // reports, or two callers reading the two exports would disagree.
  if (readState(t.sig) !== v.state) {
    tableMismatches++;
    console.log(`  FAIL  ${sigLabel(t.sig)} → readState()=${readState(t.sig)} but resolveRead().state=${v.state}`);
  }
}
ok("every row matches the module", tableMismatches === 0, `${tableMismatches} mismatch(es)`);

// ── 2. THE INVARIANTS ───────────────────────────────────────────────────────
//
// Restated over the raw inputs, so they survive a rewrite of the module. The
// table above says what the function returns today; these say what it is not
// allowed to return however it is written tomorrow.
console.log("\ninvariants (over all 32 combinations)");

const all = TABLE.map(t => ({ sig: t.sig, v: resolveRead(t.sig) }));
const every = (label: string, pred: (x: { sig: ReadSignals; v: ReturnType<typeof resolveRead> }) => boolean) => {
  const bad = all.filter(x => !pred(x));
  ok(label, bad.length === 0, bad.length ? `${bad.length} case(s), first: ${sigLabel(bad[0]!.sig)}` : "");
};

// THE headline guarantee. Keyed on the raw signals, not on `state`, so a
// regression inside `readState` cannot satisfy it vacuously.
every("'you hold nothing' is impossible unless the read resolved, succeeded and was complete",
      ({ sig, v }) => !v.canAssertEmpty || (!sig.loading && sig.received && !sig.failed && !sig.partial));
every("'you hold nothing' is impossible when there are rows",
      ({ sig, v }) => !v.canAssertEmpty || sig.rowCount === 0);
every("a bare total (not a floor) requires the same four conditions",
      ({ sig, v }) => v.totalIsFloor || (!sig.loading && sig.received && !sig.failed && !sig.partial));
every("rows render only when there are rows",
      ({ sig, v }) => v.body !== "rows" || sig.rowCount > 0);
every("an unresolved read renders nothing but the spinner",
      ({ sig, v }) => !(sig.loading || !sig.received) || v.body === "pending");
every("the caveat is a footnote ONLY under rows — never a banner and a footnote at once",
      ({ v }) => !v.footnote || v.body === "rows");
every("an incomplete read with rows always carries the footnote",
      ({ v }) => !(v.body === "rows" && v.state !== "complete") || v.footnote);
every("body is one of the five known branches",
      ({ v }) => ["pending", "failed", "partial", "empty", "rows"].includes(v.body));
every("canAssertEmpty and body agree — one flag, one branch",
      ({ v }) => v.canAssertEmpty === (v.body === "empty"));

// ── CONTROLS ────────────────────────────────────────────────────────────────
//
// Every invariant above is satisfied by a module that returns "failed" for
// everything and never says anything. These prove it still speaks when it is
// entitled to — without them the suite would pass on a resolver that had been
// silently reduced to a constant.
console.log("\ncontrols");
const complete0 = resolveRead({ loading: false, received: true, failed: false, partial: false, rowCount: 0 });
const complete3 = resolveRead({ loading: false, received: true, failed: false, partial: false, rowCount: 3 });
ok("CONTROL a complete read of an empty wallet DOES say it is empty",
   complete0.body === "empty" && complete0.canAssertEmpty, complete0.body);
ok("CONTROL a complete read with rows shows a bare total, no caveat",
   complete3.body === "rows" && !complete3.totalIsFloor && !complete3.footnote,
   `${complete3.body} floor=${complete3.totalIsFloor} footnote=${complete3.footnote}`);
ok("CONTROL the four states are all reachable",
   new Set(TABLE.map(t => resolveRead(t.sig).state)).size === 4);
ok("CONTROL all five bodies are reachable",
   new Set(TABLE.map(t => resolveRead(t.sig).body)).size === 5);

// ── 3. THE SCREENS CONSUME IT ───────────────────────────────────────────────
//
// A shared derivation that nothing imports is a fifth copy waiting to happen —
// the module would sit there being correct while the screens went on being
// wrong, which is the state this whole change exists to end.
//
// FOUR files, not three. `BankClient.tsx` was found immediately after the three
// tables landed: same question, a fourth hand-rolled answer, and the only one
// gating a SCORE. It read `const balancesKnown = walletUsdc != null` — one
// boolean for four outcomes — so an errored USDC read rendered "Reading…"
// forever and a partial read was graded as if complete. It is in this loop so
// that "the tables were fixed" can never again be mistaken for "the page was".
//
// Limits, stated so nobody trusts this further than it goes: matching source
// text catches a copy that is written the way the old ones were, and misses one
// written differently. The unit table above is the real guard on the logic;
// this is the guard on the wiring.
console.log("\nthe four screens consume the module");
const BANK = path.resolve(path.dirname(path.resolve(process.argv[1])), "../src/app/app/bank");
for (const file of ["TokenTable.tsx", "RhTokenTable.tsx", "StockTable.tsx", "BankClient.tsx"]) {
  const src = readFileSync(path.join(BANK, file), "utf8");
  ok(`${file} imports the shared derivation`,
     /from\s+"@\/lib\/wallet\/read-state"/.test(src) || /from\s+".*\/read-state"/.test(src));
  ok(`${file} routes its body through the verdict`, /\bbody\s*===\s*"/.test(src));
  // The exact ternary shape all three tables used to route the body with. Its
  // return would mean the question is being answered locally again.
  const inlined = /(holdings|legs)\.length === 0 \?/.exec(src);
  ok(`${file} has no inline empty-branch`, inlined === null, inlined ? inlined[0] : "");
}

// BankClient's own defect had a different shape from the tables', so it needs
// its own assertions. `balancesKnown` is named literally: it is the identifier
// the bug shipped under, and re-declaring it is the most likely way the
// collapse comes back.
//
// COMMENTS ARE STRIPPED FIRST, and that is load-bearing rather than tidiness:
// this repo's convention is to quote the deleted line in the comment that
// replaces it, so BankClient contains both `const balancesKnown = walletUsdc
// != null;` and `ethBal == null ? 50` as PROSE. Matching raw source failed on
// its own explanation — a guard that punishes a file for documenting its fix
// teaches the next author to delete the documentation. The strip is naive
// (it would also blank a `//` inside a string literal); harmless here, since
// neither pattern below can be manufactured by truncating a URL.
console.log("\nBankClient does not re-collapse the four states");
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
const bank = stripComments(readFileSync(path.join(BANK, "BankClient.tsx"), "utf8"));
const redeclared = /\b(?:const|let|var)\s+balancesKnown\b/.exec(bank);
ok("BankClient has no `balancesKnown` boolean", redeclared === null, redeclared ? redeclared[0] : "");
// The score is a claim about the user's WHOLE position, so it requires a read
// that covered all of it. `state === "complete"` is the only signal that says
// so; `body === "rows"` is true of a partial read too.
ok("BankClient gates its score on a COMPLETE read",
   /balanceRead\.state\s*===\s*"complete"/.test(bank));
// The measurement it used to fabricate: `ethBal == null ? 50 : …` invented a
// middling grade from an absent balance and gave it 35% of the weight.
const fabricated = /ethBal\s*==\s*null\s*\?\s*\d/.exec(bank);
ok("BankClient does not substitute a number for an unread ETH balance",
   fabricated === null, fabricated ? fabricated[0] : "");

console.log(`\n${failures === 0 ? "ALL GREEN" : "FAILURES"} — ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
