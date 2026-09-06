/**
 * Blue Chat — regression guard: `hub_hood_arrow` must not answer a Base
 * question with a Robinhood arrow.
 *
 * WHY THIS EXISTS
 * ---------------
 * Prod, 2026-09-06. Asked "Drift hiện tại của NVDA trên Base?", Blue Chat made a
 * REAL tool call (so #204's fake-receipt fix held) and then answered:
 *
 *     Drift hiện tại: −2.36%      ← from arrow #0366
 *
 * #0366 is `chain:"robinhood"`, `status:"graded"`, fired 2026-09-03 and graded
 * the same day. Measured against prod that hour: `/api/hood/arrows?limit=200`
 * returned 126 robinhood + 74 chain-missing (= robinhood) + **0 base**. There
 * was no Base arrow to report, and the reply named no chain and used the
 * present tense for a three-day-old closed position.
 *
 * Three independent defects, one per group below:
 *   1. `hub_hood_arrow` had NO `chain` parameter, so "on Base" was unsayable.
 *   2. The ticker scan took the newest matching arrow from either desk.
 *   3. Nothing in the result told the model the arrow was graded or how old.
 *
 * This is the THIRD instance of the family — #162 (chainOf default read as
 * fact), #340/#342 (A4 brief resolved a Base ticker through the RH registry),
 * #161 (/hood detail panel, same shape). The shared cause is that NVDA / META /
 * GOOGL / AAPL exist on BOTH desks, so a bare ticker identifies nothing, and the
 * failure is silent: a wrong-chain answer is well-formed, plausible and
 * numerically precise.
 *
 * WHAT WOULD ROT SILENTLY, AND WHY EACH NEEDS A TEST
 * --------------------------------------------------
 *   1. `matchesChain(row, undefined) === true` is the whole fix in one line, and
 *      it looks redundant next to `chainOf`. Someone "simplifying" it to
 *      `chainOf(row) === chainOf(want)` reintroduces the exact bug — `want`
 *      undefined would default to robinhood — and nothing fails to compile.
 *      Tested as a truth table, both directions.
 *   2. THE `chain` PARAMETER. A schema property with no required flag is easy to
 *      drop in a "trim the tool surface" pass. Without it the model has no way
 *      to express the chain even when the user names one.
 *   3. THE EMPTY-DESK ANSWER. `reason: "no_arrow_on_chain"` is the `brief_status:
 *      "skipped"` idea from #340: a desk that has never fired is not a ticker
 *      that does not exist, and neither is an error. If this collapses back into
 *      the generic not_found, the card says "No arrow matching NVDA" while
 *      Robinhood holds 40 NVDA arrows — false, and it invites the model to
 *      "helpfully" reach for the one it can see.
 *   4. AGE + STATUS IN THE FACT STRIP. Prices alone read as live. The age is
 *      computed in CODE (CLAUDE.md: derived values are not the LLM's job) —
 *      #207 is the same repo, same week, where the model did a hex→decimal
 *      conversion in its head and was wrong by 20,000.
 *
 * Group 1 is behavioural. Groups 2-5 are source assertions, for the same reason
 * `base-brief-guard-check.ts` uses them: the handler is inline in a Next.js
 * `route.ts`, which may only export route handlers, so there is nothing to
 * import and this repo has no mock framework to stand up KV against.
 *
 * Run: npx tsx scripts/hood-arrow-chain-check.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { chainOf, matchesChain, type HoodChain } from "../src/lib/blue-hood/types";
import { buildB20Section } from "../src/app/api/chat/system-prompt";

const WEB = path.resolve(path.dirname(path.resolve(process.argv[1])), "..");
const read = (p: string) => readFileSync(path.join(WEB, p), "utf8");

/**
 * Source with comments removed.
 *
 * Needed because several checks below assert an anti-pattern is ABSENT, and the
 * comment explaining why it is absent necessarily spells the anti-pattern out.
 * Without this, documenting the fix breaks the test for the fix — which trains
 * the next person to delete the explanation rather than keep it.
 *
 * `(^|[^:])` guards the `https://` case so a URL in a string literal is not
 * mistaken for a line comment.
 */
const codeOnly = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const ROUTE = read("src/app/api/chat/route.ts");
const CARD = read("src/app/chat/components/HoodArrowCard.tsx");
const TYPES = read("src/lib/blue-hood/types.ts");
/**
 * Rules 10a–10c moved here in #205, which split the B20 block by speech act and
 * pushed the "Use <tool> when…" half into a gated builder. `PROMPT` is read
 * separately from `ROUTE` on purpose: the schema and the handler are still in
 * `route.ts` and the rules are not, and pretending otherwise by concatenating
 * the two would hide the next move.
 */
const PROMPT = read("src/app/api/chat/system-prompt.ts");

let failures = 0;
/** Counted, never hardcoded — a hand-maintained total goes stale the first time
 *  someone adds a check and forgets to bump it. */
let checks = 0;

function check(name: string, cond: boolean, detail = "") {
  checks++;
  if (cond) console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ── 1. matchesChain: the query default and the row default are different ─────
console.log("\n1. matchesChain truth table — an unasked chain is BOTH desks, not RH");

const baseRow = { chain: "base" as HoodChain };
const rhRow = { chain: "robinhood" as HoodChain };
/** The ~74 arrows written before the Base desk existed. Genuinely Robinhood. */
const legacyRow = {} as { chain?: HoodChain };

// The bug, stated as a test: this returned FALSE in prod, because the missing
// query chain became "robinhood" and no Base row could ever match it.
check("chainArg=undefined matches a BASE row", matchesChain(baseRow, undefined) === true);
check("chainArg=undefined matches an RH row", matchesChain(rhRow, undefined) === true);
check("chainArg=undefined matches a LEGACY (chain-less) row", matchesChain(legacyRow, undefined) === true);

// The counter-assertion. Without it this file passes on `() => true`, which is
// the failure mode of every "assert permissive" test ever written.
check("chainArg=base REJECTS an RH row", matchesChain(rhRow, "base") === false);
check("chainArg=base REJECTS a legacy row — absent means RH, not wildcard",
  matchesChain(legacyRow, "base") === false,
  "a legacy row rendered as Base is #162 all over again");
check("chainArg=base ACCEPTS a Base row", matchesChain(baseRow, "base") === true);
check("chainArg=robinhood ACCEPTS a legacy row via chainOf",
  matchesChain(legacyRow, "robinhood") === true && chainOf(legacyRow) === "robinhood");
check("chainArg=robinhood REJECTS a Base row", matchesChain(baseRow, "robinhood") === false);

check("the row default still lives in exactly one place",
  (codeOnly(TYPES).match(/\?\?\s*"robinhood"/g) ?? []).length === 1,
  "a second spelling is how the two defaults drift apart again");

// ── 2. the tool can be ASKED about a chain ───────────────────────────────────
console.log("\n2. hub_hood_arrow exposes chain — the user's words are expressible");

const schemaAt = ROUTE.indexOf('name: "hub_hood_arrow"');
check("the tool still exists", schemaAt !== -1);
// Scoped to this tool's own schema block so a `chain:` belonging to some other
// tool cannot satisfy it.
const schemaBlock = ROUTE.slice(schemaAt, schemaAt + 6000);
check("`chain` is a declared property",
  /chain:\s*\{\s*type:\s*"string",\s*enum:\s*\["robinhood",\s*"base"\]/.test(schemaBlock));
check("the enum is exactly the two live desks",
  !/enum:\s*\[[^\]]*"ethereum"/.test(schemaBlock), "no third chain has a Hood desk");
check("the description tells the model a bare ticker is ambiguous",
  /CHAIN IS PART OF THE QUESTION/.test(schemaBlock)
  && /exist on BOTH/i.test(schemaBlock));
check("omitting chain is documented as 'either desk', never as Robinhood",
  /leave it out and report whichever chain the returned arrow says it is/.test(schemaBlock));

// The prompt rule is a SECOND place the model is taught this, and it is the one
// that was silent in the prod failure. Asserted separately so deleting either
// one fails.
check("prompt rule 10a teaches the same thing as the schema",
  /10a\. CHAIN IS PART OF THE QUESTION/.test(PROMPT));
check("prompt rule 10b makes an empty desk an ANSWER, not a fallback",
  /10b\. AN EMPTY DESK IS AN ANSWER/.test(PROMPT)
  && /Never fall back to the other desk's arrow/.test(PROMPT));
check("prompt rule 10c forbids the present tense for a graded arrow",
  /10c\. A GRADED ARROW IS HISTORY/.test(PROMPT)
  && /PAST tense/.test(PROMPT));
// These three rules only reach the model when a tool is attached, which is
// correct — they are instructions about how to call and read `hub_hood_arrow`.
// But that makes them reachable ONLY through the gated half, so assert they
// actually ride it rather than sitting in a dead branch of the file.
check("and they ship in the tool-carrying prompt, not merely in the source",
  /10a\. CHAIN IS PART OF THE QUESTION/.test(buildB20Section(true))
  && /10c\. A GRADED ARROW IS HISTORY/.test(buildB20Section(true)));

// ── 3. chain is resolved from the ARROW, never from a ticker registry ────────
console.log("\n3. the chain comes off the stored row — not a ticker→chain lookup");

const handlerAt = ROUTE.indexOf('if (toolName === "hub_hood_arrow")');
const handler = ROUTE.slice(handlerAt, ROUTE.indexOf('if (toolName === "robinhood_swap")', handlerAt));
check("the handler was found", handlerAt !== -1 && handler.length > 500);

check("the scan filters with matchesChain(a, chainArg)",
  /if \(!matchesChain\(a, chainArg\)\)/.test(handler));
check("no site compares .chain directly — a legacy row would match neither desk",
  !/\ba\.chain\b/.test(codeOnly(handler)) && !/\barrow\.chain\b/.test(codeOnly(handler)));
// This is the #342 constraint, stated as code rather than as a comment: the RWA
// registry and the Base B20 registry both answer "which chain COULD this ticker
// be on", and that is not the question.
for (const reg of ["rwa-registry", "RWA_TOKENS", "base-stocks", "B20_TOKENS"]) {
  check(`the handler does not consult ${reg} to decide a chain`,
    !handler.includes(reg),
    "a ticker→chain table answers 'could', the question is 'did'");
}
check("chainArg is undefined when unparsed, not defaulted",
  /args\.chain === "base" \|\| args\.chain === "robinhood" \? args\.chain : undefined/.test(handler));

// ── 4. an empty desk is reported as an empty desk ────────────────────────────
console.log("\n4. no-arrow-on-chain is its own outcome (the brief_status:skipped shape)");

check("the chain-scoped miss has its own reason code",
  /reason:\s*"no_arrow_on_chain"/.test(handler));
// Ordering matters: the specific branch must be reachable, i.e. sit BEFORE the
// generic not_found return. If a refactor hoists the generic one, every check
// above still passes and the specific branch becomes dead code.
const specificAt = handler.indexOf('reason: "no_arrow_on_chain"');
const genericAt = handler.indexOf('kind: "hood_arrow", not_found: true, query:');
check("the chain-scoped branch precedes the generic not_found (it is reachable)",
  specificAt !== -1 && genericAt !== -1 && specificAt < genericAt,
  `specific@${specificAt} generic@${genericAt}`);
check("the other desk's hit is OFFERED, never substituted",
  /do NOT present it as the \$\{chainArg\} answer and do NOT quote its numbers/.test(handler));
check("the model is told not to invent an arrow to fill the gap",
  /Do NOT invent an arrow and do NOT answer with the other chain's data/.test(handler));

// ── 5. the answer carries chain + age + status ───────────────────────────────
console.log("\n5. the fact strip qualifies every number it hands over");

check("chain leads the fact strip",
  /const answerHints = \[\s*`chain=\$\{arrowChain\}/.test(handler));
check("arrowChain comes from chainOf(arrow)", /const arrowChain = chainOf\(arrow\)/.test(handler));
check("status + fired_at + age_hours travel together",
  /status=\$\{arrow\.status\}/.test(handler) && /age_hours=\$\{ageH\}/.test(handler));
// CLAUDE.md: compute derived values in code, not by LLM. #207 is the same week's
// evidence for why — a model asked to convert a number got it wrong by 20,000.
check("age is computed in CODE, not left to the model to subtract",
  /Date\.now\(\) - firedMs\) \/ 3_600_000/.test(handler));
check("a graded arrow carries an explicit past-tense instruction",
  /GRADED = CLOSED/.test(handler) && /arrow\.status === "graded"/.test(handler));
check("chain + age are on the RESULT too, so the card can state them",
  /chain: arrowChain,/.test(handler) && /age_hours: ageH,/.test(handler));

// ── 6. the card says the same thing the prose does ───────────────────────────
console.log("\n6. the card renders the desk — silence next to prose is how #206 read as true");

check("the card shows a chain badge", /CHAIN_LABEL\[chain\]/.test(CARD));
check("the badge names both chain ids", /ROBINHOOD 4663/.test(CARD) && /BASE 8453/.test(CARD));
check("the card resolves chain through chainOf, never the bare field",
  /result\.chain \?\? chainOf\(a\)/.test(CARD) && !/\ba\.chain\b/.test(codeOnly(CARD)));
check("the card shows the arrow's age", /formatAge\(/.test(CARD));
check("an unreadable timestamp yields NO age rather than a wrong one",
  /if \(h === null \|\| h === undefined \|\| !Number\.isFinite\(h\) \|\| h < 0\) return null;/.test(CARD));
check("the empty-desk state names the desk it searched",
  /no_arrow_on_chain/.test(CARD) && /No <span[^>]*>\{result\.query\?\.tickerArg\}<\/span> arrow on/.test(CARD));
check("the other desk is labelled as a different question",
  /a different question, not this answer/.test(CARD));

console.log(`\n${failures ? "FAIL" : "PASS"} — ${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
