/**
 * Blue Chat — regression guard: the prompt may not describe tools the request
 * does not carry, and nothing may tell the model to answer from knowledge.
 *
 * WHY THIS EXISTS
 * ---------------
 * Prod share a204b617 (2026-09-06): the model wrote
 *
 *     🔍 hub_token_price → Live prices fetched.
 *     | ETH | $3,428 | -1.2% |         ← ETH measured that day: $2,405.63
 *
 * with an EMPTY tool log, plus a Base block height at chain id `0x328` (Base is
 * `0x2105`) and a "Blue Hood Arrow #0017" carrying RSI/gamma/confidence — three
 * fields Blue Hood does not compute, on a chain that has never fired an arrow.
 * Three different presets returned byte-identical numbers, which is recall, not
 * fetching.
 *
 * It was NOT a Free-tier bug: `fast` and `search` (paid, Virtuals) fabricated
 * the same figures. The mechanism was that the prompt described the Hub tool
 * list unconditionally and taught the exact shape of a tool receipt, while FOUR
 * separate paths deliver a request with no tools attached — `freeNoTools`,
 * `isE2EE`, `knowledgeOnly`, and Phase 1 failing. The model had the format and
 * no tool, so it filled the format from training data.
 *
 * CLAUDE.md: "prompts do not prevent hallucination; data sources do." So none of
 * the assertions below check for a warning. They check that the CLAIM is absent.
 *
 * WHAT WOULD ROT SILENTLY, AND WHY EACH NEEDS A TEST
 * --------------------------------------------------
 *   1. `hasTools: false` is a BRANCH, and branches get flattened. One "simplify"
 *      pass that drops the ternary restores the unconditional tool list, and
 *      nothing fails to compile. Asserted both ways — the tool-carrying prompt
 *      MUST still name tools — so a test that passes by naming nothing at all is
 *      itself a failure.
 *   2. THE RECEIPT TEMPLATE. The old rule 7 asked the model to open with
 *      "🔍 [tool] → [key result]". A receipt the model TYPES is unfalsifiable;
 *      the UI already renders a chip from the execution log. Re-adding a
 *      "transparency" line would look like an improvement.
 *   3. "ANSWER FROM KNOWLEDGE" IN A FAILURE PATH. The tool-error string used to
 *      end "— answering from knowledge", three lines from a prompt rule
 *      forbidding exactly that. It is one well-meaning edit away at all times,
 *      and it is the strongest position in the context: the last thing read
 *      before generation.
 *   4. `blue_dca` OFFERED WITHOUT A KEEPER. The card takes a real
 *      `approve(keeper, totalAllowance)` on USDC; `/api/cron/dca-executor` has
 *      never appeared in `vercel.json` on any branch. Offer and schedule must
 *      come back together — this asserts the COUPLING, not the removal, so
 *      re-enabling is legitimate the moment the cron is real.
 *   5. A PROMPT SECTION THE GUARD CANNOT SEE. This is the one that actually got
 *      through (#205). The first version of this file asserted against
 *      `buildBaseSystem(...)` alone, and passed — while the shipped prompt still
 *      named twelve tools, because `B20_SECTION` was a separate `route.ts`
 *      constant appended unconditionally to the same array. Checking a PART of
 *      the prompt reads exactly like checking the prompt. So the assertions
 *      below run against the full assembled tool-free system prompt, and a
 *      structural check reads the assembly array itself and fails on any new
 *      unconditional module constant — the shape of the bug, not the instance.
 *
 * Source-reading, not network: these are properties of the text we ship.
 *
 * Run: npx tsx scripts/chat-tool-honesty-check.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  buildBaseSystem, buildAgentCapabilities, buildB20Section,
} from "../src/app/api/chat/system-prompt";
import { SOUL_MD } from "../src/lib/soul";

const WEB   = path.resolve(path.dirname(path.resolve(process.argv[1])), "..");
const ROUTE = readFileSync(path.join(WEB, "src/app/api/chat/route.ts"), "utf8");
const VERCEL = readFileSync(path.join(WEB, "vercel.json"), "utf8");

let failures = 0;
/** Counted, never hardcoded — a hand-maintained total goes stale the first time
 *  someone adds a check and forgets to bump it. */
let checks = 0;

function check(name: string, cond: boolean, detail = "") {
  checks++;
  if (cond) console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}

// Every tool name the prompt is allowed to mention ONLY when tools are attached.
// DERIVED from the schema list in route.ts, not hand-copied: the previous
// hand-written array carried the comment "drawn from the real sections… so a
// newly added tool is covered without touching this file", which was simply not
// true — it listed 8 of 49, and the 12 it omitted were the ones that leaked.
// A comment claiming a property the code does not have is worse than no comment,
// because it stops the next reader from checking.
const TOOL_NAMES = [...ROUTE.matchAll(/^\s{4}name:\s*"([a-z0-9_]+)",$/gm)]
  .map((m) => m[1]);

// Guard the guard: this regex depends on the formatting of the schema objects.
// If a prettier pass reindents them, the list silently empties and every
// absence assertion below starts passing vacuously.
check("tool names are derived from route.ts, not hand-listed",
  TOOL_NAMES.length >= 40, `${TOOL_NAMES.length} schemas found`);

const withTools = buildBaseSystem({ hasWebSearch: false, hasTools: true });
const noTools   = buildBaseSystem({ hasWebSearch: false, hasTools: false });
const unreach   = buildBaseSystem({ hasWebSearch: false, hasTools: false, toolsUnreachable: true });

// THE WHOLE PROMPT, not one section of it. Checking `buildBaseSystem` alone is
// what let #205 through: the B20 dispatch table rode in on a different array
// element. Everything unconditional in `buildSystem`'s array is concatenated
// here; the structural check in §1b proves nothing else has been added to it.
const assembledNoTools = [
  SOUL_MD,
  noTools,
  buildAgentCapabilities(false),
  buildB20Section(false),
].join("\n\n");
const assembledWithTools = [
  SOUL_MD,
  withTools,
  buildAgentCapabilities(true),
  buildB20Section(true),
].join("\n\n");

// ── 1. The tool-free prompt names no tool ────────────────────────────────────
console.log("\n1. hasTools:false describes no capability the request lacks");

const named = TOOL_NAMES.filter((t) => assembledNoTools.includes(t));
check("no hub tool is named ANYWHERE in the assembled tool-free prompt",
  named.length === 0,
  named.length ? `leaked: ${named.join(", ")}` : `0 of ${TOOL_NAMES.length}`);

check("the tool-free prompt says so explicitly, not by omission",
  /YOU HAVE NONE ON THIS REQUEST/.test(noTools));

// The counter-assertion. Without it this file passes on an empty string, which
// is the failure mode of every "assert absence" test ever written.
const kept = TOOL_NAMES.filter((t) => assembledWithTools.includes(t));
check("the tool-CARRYING prompt still names tools — the test can fail both ways",
  kept.length >= 8, `${kept.length}/${TOOL_NAMES.length} named in prose`);

check("agent-capabilities section branches too, and drops hub_token_price",
  !buildAgentCapabilities(false).includes("hub_token_price")
  && buildAgentCapabilities(true).includes("hub_token_price"));

// ── 1b. Nothing new can be appended to the prompt behind the guard's back ────
// `assembledNoTools` above is a hand-written copy of the assembly array, so it
// is only honest while the two agree. This reads the real array out of route.ts
// and fails on any element the copy doesn't know about.
console.log("\n1b. the assembly array holds no unreviewed unconditional section");

const arr = ROUTE.match(
  /const buildSystem = [\s\S]*?=> \[([\s\S]*?)\]\.filter\(Boolean\)/,
)?.[1] ?? "";
check("the buildSystem array is still findable — this check is not vacuous",
  arr.length > 200, `${arr.length} chars`);

// A bare SCREAMING_CASE identifier on its own line is an unconditional module
// constant: no ternary, no `hasTools`, nothing to gate it. That is precisely
// the shape `B20_SECTION` had. SOUL_MD is the one legitimate case — it is the
// identity layer and (asserted below) names no tool.
const bareConsts = [...arr.matchAll(/^\s*([A-Z][A-Z0-9_]{2,}),\s*$/gm)].map((m) => m[1]);
const unreviewed = bareConsts.filter((c) => c !== "SOUL_MD");
check("no unconditional SCREAMING_CASE prompt constant besides SOUL_MD",
  unreviewed.length === 0,
  unreviewed.length
    ? `ungated: ${unreviewed.join(", ")} — gate it on hasTools or add it to assembledNoTools`
    : `only SOUL_MD (${bareConsts.length} bare)`);
check("SOUL_MD earns its exemption: the identity layer names no tool",
  TOOL_NAMES.every((t) => !SOUL_MD.includes(t)));

// The B20 section must arrive through the gated builder, not as a constant.
check("B20 rides the hasTools flag like every other section",
  /buildB20Section\(hasTools\)/.test(arr));

// ── 2. No receipt template, in EITHER branch ─────────────────────────────────
console.log("\n2. the receipt format is not taught anywhere");

// The old rule 7 verbatim shape: an emoji-led line with a tool name and an arrow.
const RECEIPT_TEMPLATE = /🔍\s*\[?tool/i;
check("tool-free prompt teaches no 🔍 receipt format", !RECEIPT_TEMPLATE.test(noTools));
check("tool-CARRYING prompt teaches none either — a real run renders a chip",
  !RECEIPT_TEMPLATE.test(withTools));
check("the prohibition is stated, not merely the format omitted",
  /NEVER write a tool receipt/i.test(withTools) && /resembles a tool result/i.test(noTools));

// ── 3. Nothing invites substitution from training data ───────────────────────
console.log("\n3. no path tells the model to answer from knowledge");

for (const [label, text] of [["tool-free", noTools], ["with tools", withTools],
                             ["unreachable", unreach]] as const) {
  check(`${label} prompt never says "answer from your own knowledge"`,
    !/answer from your own knowledge/i.test(text));
}

// The route's own failure strings — the ones the model reads LAST, immediately
// before generating. This is a source grep because the strings are built inside
// a route handler that cannot be imported.
check("route.ts contains no '— answering from knowledge' failure text",
  !/answering from knowledge/.test(ROUTE));
check("the tool-failure helper forbids substitution in the failure text itself",
  /NO DATA was returned/.test(ROUTE) && /Do NOT supply the value from/.test(ROUTE));

// ── 4. "Detector broke" is distinguishable from "no tool needed" ─────────────
console.log("\n4. a failed Phase 1 rebuilds the prompt instead of falling through");

check("Phase 1 has a three-way outcome, not a nullable response",
  /status:\s*"unreachable"/.test(ROUTE) && /status:\s*"none"/.test(ROUTE));
// Both provider branches must rebuild. One of them was the paid-tier path in the
// prod report, so covering only Venice would miss the reported bug entirely.
// Anchored on `content:` so the doc comment that NAMES the call is not counted as
// one — a comment mentioning the fix would otherwise let a deleted branch pass.
const rebuilds = (ROUTE.match(/content:\s*buildSystem\(false,\s*true\)/g) ?? []).length;
check("BOTH provider branches rebuild the prompt on an unreachable detector",
  rebuilds === 2, `${rebuilds} rebuild site(s) — expect 2 (venice + virtuals)`);
check("no call site still collapses phase1 with ?.choices?.[0]",
  !/callVenicePhase1\([\s\S]{0,400}?\)\)\?\.choices/.test(ROUTE));

check("the unreachable prompt calls it an outage, not a model limitation",
  /temporary outage/.test(unreach) && !/temporary outage/.test(noTools));

// ── 4b. The two branch gates agree about the free tier ───────────────────────
// `hasHubTools` is ONE boolean feeding the prompt, but the tools it describes
// are attached by TWO gates, one per provider. They disagreed: Venice carried
// `!freeNoTools`, Virtuals did not. Nothing was firing, because `presets.ts`
// routes `free` to a Venice model — an invariant held by a fact in a different
// file with no compiler link. Repoint the free preset at any of the six
// Virtuals models sitting next to it and the Virtuals branch attaches the full
// paid Hub schema to a 0-credit message, while the prompt correctly says it has
// none. Asserted per-branch rather than by counting, so deleting one still fails.
console.log("\n4b. both provider gates exclude the free tier");
const venGate = /if \(!isE2EE && !knowledgeOnly && !freeNoTools\)/.test(ROUTE);
const virGate = /if \(!knowledgeOnly && !freeNoTools\)/.test(ROUTE);
check("Venice branch gates on !freeNoTools", venGate);
check("Virtuals branch gates on !freeNoTools too — a 0-credit message cannot "
  + "reach a paid Hub tool whichever provider the free preset points at", virGate);

// ── 5. blue_dca: the offer and the keeper travel together ────────────────────
console.log("\n5. blue_dca is not offered while its keeper is unscheduled");

const dcaScheduled = /dca-executor/.test(VERCEL);
// `blue_dca` still appears in route.ts as the marker handler + the removal note;
// what must be absent is the OFFER — a tool schema and a prompt rule telling the
// model to call it.
const dcaOffered =
  /name:\s*"blue_dca"/.test(ROUTE) || /Use blue_dca when/.test(ROUTE);
check("offer ⇒ scheduled: chat never solicits an allowance for a dead keeper",
  !dcaOffered || dcaScheduled,
  `offered=${dcaOffered}, cron in vercel.json=${dcaScheduled}`);
// Kept deliberately: users with an outstanding approve still need the card that
// shows and revokes it. Deleting it would be the unsafe direction.
check("the card + handler stay, so an existing allowance is still visible",
  /toolName === "blue_dca"/.test(ROUTE));

// ── 6. No section claims a capability with no registered tool ────────────────
console.log("\n6. no prompt section claims an unregistered integration");

check("the Coinbase spot-trading claim is gone (no schema ever backed it)",
  !/You have access to Coinbase spot trading/.test(ROUTE));

// ── 7. B20 splits by SPEECH ACT — facts stay, dispatch goes ──────────────────
// The tempting simplification is "B20 is one topic, ship it or don't". Both
// halves of that are wrong: dropping it makes the model worse at "what is B20?"
// on the free tier, and shipping it whole is the bug. What decides is what a
// sentence DOES — state a fact, forbid something, or ask for a call.
console.log("\n7. B20 keeps its facts and prohibitions with no tools attached");

const b20Free = buildB20Section(false);
const b20Full = buildB20Section(true);

check("the standard's facts survive: a tool-free model still answers 'what is B20?'",
  /Rust PRECOMPILE/.test(b20Free) && /VERIFIED B20 FACTS/.test(b20Free)
  && /0xB20f000000000000000000000000000000000000/.test(b20Free));

// A prohibition is MORE load-bearing without tools, not less: with no card to
// point at, "just use cast send --private-key" is the model's nearest exit.
check("the private-key prohibition survives — it is not a capability claim",
  /PRIVATE KEY NEVER GOES IN CHAT/.test(b20Free) && /--private-key/.test(b20Free));
check("the no-DCA rule survives in both branches",
  /NO DCA/.test(b20Free) && /DCA/.test(b20Full));

// `simulateContract` was in the old text as an instruction — "ALWAYS simulate
// the transaction first using simulateContract" — and it is not a registered
// chat tool in either branch. Same family as #196/#166: a named capability with
// nothing behind it. Replaced by the prohibition, which must hold everywhere.
check("no branch instructs the model to call simulateContract",
  !/simulateContract/.test(b20Free) && !/simulateContract/.test(b20Full)
  && !/simulateContract/.test(ROUTE));
check("and it says so outright, in both branches",
  /YOU DO NOT SIMULATE TRANSACTIONS/.test(b20Free)
  && /YOU DO NOT SIMULATE TRANSACTIONS/.test(b20Full));
// The revert modes are a FACT about B20 the user needs before sending, and they
// used to be reachable only through the simulate instructions that just left.
check("policy/pause reverts are still explained without a simulate step",
  /PolicyForbids/.test(b20Free) && /paused by the issuer/.test(b20Free));

check("the dispatch table ships ONLY with tools",
  !/Use hub_b20_inspect/.test(b20Free) && /Use hub_b20_inspect/.test(b20Full));
check("the Hood chain + age rules (#206) ride with the dispatch table",
  /CHAIN IS PART OF THE QUESTION/.test(b20Full)
  && /A GRADED ARROW IS HISTORY/.test(b20Full)
  && !/CHAIN IS PART OF THE QUESTION/.test(b20Free));

console.log(`\n${failures ? "FAIL" : "PASS"} — ${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
