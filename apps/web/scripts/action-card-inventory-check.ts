/**
 * Blue Chat — regression guard: every action card the chat can render is backed
 * by a tool the model can actually call, and the retired Bankr launch path stays
 * retired.
 *
 * WHY THIS EXISTS
 * ---------------
 * An action card is a `case` in the ToolCards dispatcher keyed by a tool name.
 * The card and the tool that triggers it live in two different files with NO
 * compiler link between them — the dispatcher switches on a `string`. So a card
 * can outlive its tool (dead UI nothing can reach) or a tool can outlive its
 * card (the model calls it and the user sees a raw blob), and both compile.
 *
 * MEASURED 2026-09-06, in production, before writing this:
 *
 *     GET https://app.blueagent.dev/api/launch-token
 *     → {"bankrStatus":403,"bankrBody":{"error":"Account suspended",
 *        "banned":true,"banType":"restricted","reasonCode":"fraud"}}
 *
 * with `BANKR_API_KEY` present, on both `?chain=base` and `?chain=robinhood`.
 * The suspension is on the ACCOUNT, not on one hostname. `prepare_token_launch`
 * had been offering that launchpad in chat the whole time: the model described a
 * 100B fixed supply, gas "sponsored by Bankr", and a 57% creator-fee split, the
 * user filled in a form, hit Launch — and got a 403 at the last step. The card
 * was selling a deploy nobody could perform.
 *
 * CLAUDE.md: "A payment path must never outlive the product it sells", and
 * retiring is ONE commit — route, offer, card, and every surface that advertises
 * it. This file is what keeps that true after the commit.
 *
 * WHAT WOULD ROT SILENTLY, AND WHY EACH NEEDS A TEST
 * --------------------------------------------------
 *   1. A CARD WITH NO TOOL. The dispatcher is a string switch, so an orphaned
 *      case is invisible to tsc forever. Checked by derivation, not by a list:
 *      every `case` must have a matching `name:` in route.ts. `blue_dca` is the
 *      ONE allowed exception and is named explicitly, so a SECOND orphan fails
 *      even though the first is tolerated.
 *   2. THE EXCEPTION BECOMING A LOOPHOLE. `blue_dca` is exempt because its card
 *      shows and revokes a real USDC allowance users may already have granted
 *      (#92) — deleting it is the unsafe direction. So the exemption is asserted
 *      to still be NEEDED: if someone re-registers the tool, this fails and the
 *      exception gets deleted rather than quietly protecting nothing.
 *   3. THE BANKR PATH COMING BACK. Not just "route deleted" — the offer, the
 *      marker, the card, the modal, and the ADVERTISING each rot independently.
 *      A doc page that still promises sponsored gas is the same lie as a live
 *      button; the user reads the doc first.
 *   4. A TEST THAT PASSES BY DELETING EVERYTHING. Every absence assertion below
 *      is paired with a presence assertion on the surviving self-hosted path
 *      (`hub_b20_launch` → B20LaunchCard → /api/b20/*) and on the launch
 *      registry. Without that pairing this file would go green if chat lost all
 *      its cards, which is the failure mode of every "assert absence" test.
 *   5. THE EVIDENCE GETTING SWEPT UP. Tokens Bankr deployed are real and still
 *      on-chain. CLAUDE.md: deleting routes does not entitle you to delete the
 *      data behind them. `src/lib/launches.ts` and its two live writers must
 *      survive the cleanup that removed their third writer.
 *
 * Source-reading, not network: these are properties of the text we ship.
 *
 * Run: npx tsx scripts/action-card-inventory-check.ts
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const WEB = path.resolve(path.dirname(path.resolve(process.argv[1])), "..");
const read = (p: string) => readFileSync(path.join(WEB, p), "utf8");

const ROUTE    = read("src/app/api/chat/route.ts");
/** The B20 prompt text moved OUT of route.ts on 2026-09-06 (#205): a `route.ts`
 *  may only export route handlers, so the prompt could not be unit-tested while
 *  it lived there. Tool REGISTRATIONS (`name:`/`toolName ===`) stayed in
 *  route.ts; only the prose moved. Two files, two questions — "can the model
 *  call it" is answered by ROUTE, "what are we telling the model" by PROMPT. */
const PROMPT   = read("src/app/api/chat/system-prompt.ts");
const CARDS    = read("src/app/chat/components/ToolCards.tsx");
const LAUNCHES = read("src/app/app/launches/LaunchesClient.tsx");
const REGISTRY = read("src/lib/launches.ts");
const DOCS     = read("src/app/docs/blue-chat/page.tsx");
const LAUNCHPG = read("src/app/launch/page.tsx");

let failures = 0;
/** Counted, never hardcoded — a hand-maintained total goes stale the first time
 *  someone adds a check and forgets to bump it. */
let checks = 0;

function check(name: string, cond: boolean, detail = "") {
  checks++;
  if (cond) console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ── 1. Every action card is reachable ────────────────────────────────────────
console.log("\n1. every dispatcher case maps to a tool the model can call");

const cases = [...new Set([...CARDS.matchAll(/case "([a-z0-9_]+)":/g)].map(m => m[1]))];

/** Cards deliberately kept without a registered tool. Each needs a reason and a
 *  reference — an unexplained entry here is how this guard would be defeated. */
const ALLOWED_ORPHANS: Record<string, string> = {
  // #92: the card requests a real approve(keeper, totalAllowance) on USDC for
  // /api/cron/dca-executor, a cron that has never existed in vercel.json. The
  // OFFER was withdrawn 2026-09-06; the CARD stays so anyone holding an
  // outstanding allowance can still see and revoke it.
  blue_dca: "#92 — offer withdrawn, card kept so live allowances stay revocable",
};

check("the dispatcher still renders cards at all", cases.length > 10,
  `${cases.length} cases`);

const orphans = cases.filter(c => !ROUTE.includes(`name: "${c}"`));
const unexpected = orphans.filter(c => !(c in ALLOWED_ORPHANS));
check("no card is orphaned by a tool that no longer exists", unexpected.length === 0,
  unexpected.length ? `unreachable: ${unexpected.join(", ")}` : `${orphans.length} documented exception(s)`);

// The exemption must still be load-bearing. If blue_dca is re-registered the
// tool is live again, the exception is dead weight, and this fails so it gets
// removed instead of silently covering a future orphan.
for (const [tool, why] of Object.entries(ALLOWED_ORPHANS)) {
  check(`the "${tool}" exception is still needed, not a stale loophole`,
    orphans.includes(tool), why);
}

// ── 2. The Bankr launch path is gone, everywhere ─────────────────────────────
console.log("\n2. the retired Bankr launchpad has no surviving surface");

check("no /api/launch-token route file",
  !existsSync(path.join(WEB, "src/app/api/launch-token/route.ts")));
check("chat offers no prepare_token_launch tool",
  !/name:\s*"prepare_token_launch"/.test(ROUTE));
check("chat has no prepare_token_launch marker handler",
  !/toolName === "prepare_token_launch"/.test(ROUTE));
check("no dispatcher case renders a TokenLaunchCard",
  !/case "prepare_token_launch"/.test(CARDS) && !/TokenLaunchCard/.test(CARDS));
check("the /app/launches Bankr modal is gone",
  !/LaunchModal/.test(LAUNCHES));

// Nothing may POST to the dead endpoint from any surface.
for (const [label, src] of [["chat route", ROUTE], ["tool cards", CARDS],
                            ["launches page", LAUNCHES]] as const) {
  check(`${label} makes no call to /api/launch-token`,
    !/["'`]\/api\/launch-token/.test(src));
}

// ── 2b. …including the surfaces that only ADVERTISE it ───────────────────────
// A doc promising sponsored gas is the same false claim as a live button, and
// it is read BEFORE the button. This is the clause of the retirement law that
// gets skipped, because copy compiles no matter what it says.
console.log("\n2b. no surface still advertises the launchpad's terms");

// Anchored on the SALES TERMS, not on the word "Bankr". Naming the launchpad in
// a retirement note is correct and wanted — a reader who hits a stale link needs
// to know what happened. What may never come back is the OFFER: a concrete
// supply, pool, gas or fee promise stated as something we still do.
const BANKR_TERMS = /gas sponsored by bankr|sponsored by bankr|100B fixed supply|57% creator fee/i;
for (const [label, src] of [["blue-chat docs", DOCS], ["/launch page", LAUNCHPG],
                            ["tool cards", CARDS], ["launches page", LAUNCHES]] as const) {
  const offending = (src.match(BANKR_TERMS) ?? [])[0];
  check(`${label} does not quote launchpad terms as live`, !offending,
    offending ? `found "${offending}"` : "");
}
// Counter-assertion: the retirement is EXPLAINED somewhere a user lands, not
// merely scrubbed. Silent removal leaves anyone with a stale link guessing.
check("the docs explain what happened to the launchpad instead of hiding it",
  /Bankr/.test(DOCS) && /suspended/i.test(DOCS));

// ── 3. Counter-assertions: the surviving path is intact ──────────────────────
// Without these, deleting every card and every doc would turn this file green.
console.log("\n3. the self-hosted B20 path survived the removal");

check("hub_b20_launch is still a registered tool",
  /name:\s*"hub_b20_launch"/.test(ROUTE));
check("hub_b20_launch still has a marker handler",
  /toolName === "hub_b20_launch"/.test(ROUTE));
check("B20LaunchCard is still rendered by the dispatcher",
  /case "hub_b20_launch":/.test(CARDS) && /function B20LaunchCard/.test(CARDS));
// The card signs against the Factory from the user's own wallet — the property
// that makes it survivable when a third party bans an account.
check("the B20 card still deploys through our own /api/b20 endpoints",
  /["'`]\/api\/b20\/prepare/.test(CARDS) && /["'`]\/api\/b20\/receipt/.test(CARDS));
check("the prompt names hub_b20_launch as the only deploy path",
  /hub_b20_launch is the ONLY token-deploy tool/.test(PROMPT));
// …and it must sit in the GATED half. `b20Dispatch()` is only injected when the
// request carries tools; `b20Knowledge()` always is. Rule 6g names a tool, so in
// the ungated half it would re-create #205 — a tool-free prompt advertising a
// tool — which is the bug the file split was made to fix. Checked positionally:
// 6g must fall after the dispatch header, not before it.
check("rule 6g lives in the tool-gated half, not the always-on knowledge block",
  PROMPT.indexOf("hub_b20_launch is the ONLY token-deploy tool")
    > PROMPT.indexOf("## B20 & chain actions — which tool to call"));

// ── 4. The launch records are evidence and must outlive their writer ─────────
console.log("\n4. launch history survived the route that produced some of it");

check("src/lib/launches.ts still exists", existsSync(path.join(WEB, "src/lib/launches.ts")));
check("both surviving writers still record launches",
  existsSync(path.join(WEB, "src/app/api/robinhood/receipt/route.ts"))
  && existsSync(path.join(WEB, "src/app/api/b20hub/register/route.ts")));
check("recordLaunch is still exported for them", /export async function recordLaunch/.test(REGISTRY));
// The rows Bankr wrote carry no `source` field, so they cannot be told apart
// from the live ones. The header must keep saying so — a future reader that
// assumes every row has a live writer is the way this data gets "cleaned up".
check("the registry warns that legacy rows are unattributable",
  /NOT distinguishable/.test(REGISTRY) && /no `source`/.test(REGISTRY));
check("the /app/launches showcase still lists them",
  existsSync(path.join(WEB, "src/app/app/launches/LaunchesClient.tsx")));

// ── 5. Every published URL still resolves ────────────────────────────────────
console.log("\n5. the advertised /launch URL still goes somewhere real");

check("/launch is kept as a redirect, not deleted into a 404",
  existsSync(path.join(WEB, "src/app/launch/page.tsx")) && /redirect\("\/app\/chat"\)/.test(LAUNCHPG));

console.log(`\n${failures ? "FAIL" : "PASS"} — ${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
