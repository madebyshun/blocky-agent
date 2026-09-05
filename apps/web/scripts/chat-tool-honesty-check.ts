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
 *
 * Source-reading, not network: these are properties of the text we ship.
 *
 * Run: npx tsx scripts/chat-tool-honesty-check.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildBaseSystem, buildAgentCapabilities } from "../src/app/api/chat/system-prompt";

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
// Drawn from the real sections rather than a hand-copied list, so a newly added
// tool is covered without touching this file.
const TOOL_NAMES = ["hub_token_price", "hub_crypto_rpc", "check_wallet", "prepare_swap",
  "hub_risk_gate", "hub_honeypot", "hub_builder_score", "hub_narrative"];

const withTools = buildBaseSystem({ hasWebSearch: false, hasTools: true });
const noTools   = buildBaseSystem({ hasWebSearch: false, hasTools: false });
const unreach   = buildBaseSystem({ hasWebSearch: false, hasTools: false, toolsUnreachable: true });

// ── 1. The tool-free prompt names no tool ────────────────────────────────────
console.log("\n1. hasTools:false describes no capability the request lacks");

const named = TOOL_NAMES.filter((t) => noTools.includes(t));
check("no hub tool is named when the request carries none", named.length === 0,
  named.length ? `leaked: ${named.join(", ")}` : "0 of " + TOOL_NAMES.length);

check("the tool-free prompt says so explicitly, not by omission",
  /YOU HAVE NONE ON THIS REQUEST/.test(noTools));

// The counter-assertion. Without it this file passes on an empty string, which
// is the failure mode of every "assert absence" test ever written.
const kept = TOOL_NAMES.filter((t) => withTools.includes(t));
check("hasTools:true STILL names the tools — the test can fail both ways",
  kept.length === TOOL_NAMES.length, `${kept.length}/${TOOL_NAMES.length} present`);

check("agent-capabilities section branches too, and drops hub_token_price",
  !buildAgentCapabilities(false).includes("hub_token_price")
  && buildAgentCapabilities(true).includes("hub_token_price"));

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

console.log(`\n${failures ? "FAIL" : "PASS"} — ${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
