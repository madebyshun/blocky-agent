/**
 * Blue Hood — regression guard: a Base arrow must never receive an RH brief.
 *
 * WHY THIS EXISTS
 * ---------------
 * A4 (`rh-stock-agent-brief`) takes a bare ticker and resolves it against the
 * **Robinhood Chain** RWA registry. NVDA / META / GOOGL / AAPL exist on BOTH
 * chains, so asking it about a Base B20 arrow does not degrade — it silently
 * answers about a different token on a different chain, and that answer is
 * persisted onto a permanent arrow record and handed to chat as quotable fact.
 *
 * The pre-existing `detectMarketContradiction` guard cannot catch it: both
 * chains trade the same NYSE session, so a wrong-chain brief agrees on market
 * hours perfectly.
 *
 * WHAT IT CHECKS
 * --------------
 * Group 1 is a real behavioural test of the pure predicate.
 * Groups 2-4 are SOURCE assertions. They are here because the interesting
 * property is "the guard runs BEFORE the network call" and "the enqueue was
 * deliberately left alone" — neither is observable from a return value
 * (`fetchArrowBrief` returns null on a failed call too, so a missing guard and
 * a working guard look identical from outside without a mock framework, which
 * this repo does not have).
 *
 * Run: npx tsx scripts/base-brief-guard-check.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hasBriefPath } from "../src/lib/blue-hood/brief";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

let failures = 0;
/** Counted, never hardcoded — a hand-maintained total goes stale the first
 *  time someone adds a check and forgets to bump it. */
let checks = 0;

function check(name: string, cond: boolean, detail = "") {
  checks++;
  if (cond) {
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── 1. the predicate itself ───────────────────────────────────────────────
console.log("\n1. hasBriefPath truth table");
check("robinhood has a brief path", hasBriefPath("robinhood") === true);
check("base does NOT", hasBriefPath("base") === false);

// ── 2. the gate precedes the network call ─────────────────────────────────
console.log("\n2. brief.ts — chain gate runs before callTool");
const brief = read("src/lib/blue-hood/brief.ts");
const gateAt = brief.indexOf("if (!hasBriefPath(chain))");
const callAt = brief.indexOf('callTool<A4Response>("rh-stock-agent-brief"');
check("the gate exists", gateAt !== -1);
check("the A4 call exists", callAt !== -1);
check(
  "gate is BEFORE the call (no wrong-chain request is ever sent)",
  gateAt !== -1 && callAt !== -1 && gateAt < callAt,
  `gate@${gateAt} call@${callAt}`,
);
check(
  "chain is a required param, not defaulted",
  /fetchArrowBrief\(ticker: string, chain: HoodChain\)/.test(brief),
  "a default would make the forgot-to-thread-it case the silent one",
);
check(
  "only ONE place decides which chains are briefable",
  (brief.match(/chain === "robinhood"/g) ?? []).length === 1,
);

// ── 3. the worker threads the arrow's own chain ───────────────────────────
console.log("\n3. brief-worker — passes the arrow's chain, distinguishes skipped");
const worker = read("src/app/api/cron/blue-hood/brief-worker/route.ts");
check(
  "fetchArrowBrief gets the arrow's chain",
  /fetchArrowBrief\(arrow\.ticker,\s*arrowChain\)/.test(worker),
);
check(
  "chain comes from chainOf(arrow), not a literal",
  /const arrowChain = chainOf\(arrow\)/.test(worker),
);
check(
  'a non-briefable chain lands "skipped", not "failed"',
  /brief \? "attached" : briefable \? "failed" : "skipped"/.test(worker),
  '"failed" renders as "A4 chain failed" — false for a desk we never asked',
);
// The ops log is a second place a false cause can be asserted. `finalStatus`
// (arrow state) and `WorkerRowResult.status` (worker report) are separate
// vocabularies; the report must not reuse `skipped_already_done` for a Base
// arrow, which would read as "a previous run handled it" — untrue.
check(
  "the worker report has its OWN value for the no-brief-path skip",
  /skipped_no_brief_path/.test(worker)
    && /finalStatus === "skipped" \? "skipped_no_brief_path" : finalStatus/.test(worker),
  "reusing skipped_already_done would claim a previous run handled it",
);
check(
  "the skipped aggregate counts by prefix, so a new skipped_* is not dropped",
  /\.status\.startsWith\("skipped"\)/.test(worker),
  "an explicit two-value list here would silently undercount the summary",
);

// The whole point of NOT touching the enqueue: these must still run for Base.
for (const fn of ["writeChatCard", "pushArrowToAll", "emitAlertsForArrow"]) {
  const at = worker.indexOf(`${fn}(`);
  check(
    `${fn} still runs (not gated on the brief)`,
    at !== -1 && !new RegExp(`if\\s*\\(\\s*briefable\\s*\\)[^\\n]*\\n[^\\n]*${fn}`).test(worker),
  );
}

// ── 4. the enqueue was deliberately left alone ────────────────────────────
console.log("\n4. rule-engine — Base arrows are STILL enqueued");
const engine = read("src/lib/blue-hood/rule-engine.ts");
check(
  "skipAsync does not branch on chain",
  /const skipAsync = \(opts\.test \|\| origin === "seeded"\) && !opts\.forceBrief;/.test(engine)
    && !/skipAsync[^\n]*chain/.test(engine),
  "folding chain in here would mute Base push + alerts + chat card",
);
check(
  "the reason is written down where the mistake would be made",
  /DO NOT add `\|\| chain !== "robinhood"` here/.test(engine),
);

console.log(
  failures === 0
    ? `\nALL ${checks} CHECKS PASSED\n`
    : `\n${failures} of ${checks} CHECK(S) FAILED\n`,
);
process.exit(failures === 0 ? 0 : 1);
