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
 *      is paired with a presence assertion on the surviving path (/app/b20 →
 *      /api/b20/* behind the activation read) and on the launch registry. Without
 *      that pairing this file would go green if chat lost all its cards, which is
 *      the failure mode of every "assert absence" test.
 *   5. THE EVIDENCE GETTING SWEPT UP. Tokens Bankr deployed are real and still
 *      on-chain. CLAUDE.md: deleting routes does not entitle you to delete the
 *      data behind them. `src/lib/launches.ts` and its writers must survive the
 *      cleanup that removed their third writer — and the cleanup that removed
 *      the page which used to display them (2026-09-07, point 8).
 *   6. A SECOND DOOR TO THE SAME DEPLOY. Until 2026-09-08 the chat card had a
 *      Deploy button of its own: it POSTed /api/b20/prepare and had the user
 *      sign `createB20`, while the card's own header comment still said "no API
 *      call, no funds moved". That made TWO deploy entrances, and chat's was the
 *      worse one — /app/b20 reads the ActivationRegistry before letting anyone
 *      sign, so an unactivated variant is refused up front instead of surfacing
 *      as "Unable to estimate fee" from a wallet aimed at a revert.
 *
 *      Removing only the BUTTON left half a product: a $0.25 tool and a card that
 *      still generated a Foundry deploy script. So the whole surface went — tool
 *      schema, marker, card, script generator, the `b20-launch` catalog entry and
 *      its x402 endpoint, and the MCP proxy. Chat now has NO token-deploy path.
 *      Checked in BOTH directions, because each rots on its own: chat must not
 *      regrow one, and /app/b20 must not lose the one it has — otherwise "we
 *      removed the entrance" turns into "there is no way to deploy".
 *   7. THE PROMPT OUTLIVING THE TOOL. This is #204/#205, and it is the failure
 *      this file is worst at catching by inspection: a rule that says "use X to
 *      deploy" after X is deleted does not break the build, it just teaches the
 *      model that a deploy capability exists, and the model then invents the
 *      procedure. So the prompt is checked against the REGISTERED TOOL LIST, both
 *      derived from source — never a hand-written array. #205's own fix shipped a
 *      `TOOL_NAMES` constant whose comment claimed it was "drawn from the real
 *      sections" while 8 names had actually been copied by hand; a list like that
 *      is stale the moment a tool is added, and it is stale in the silent
 *      direction.
 *   8. THE FEE PATH OUTLIVING THE PRODUCT. The 2026-09-06 commit retired the
 *      Bankr DEPLOY but left its money surfaces standing: /api/my-tokens,
 *      /api/claim-fees, and the /app/launches "My Tokens" tab that called both.
 *      ShunTr closed that on 2026-09-07 by deciding the claim happens in
 *      Bankr's own UI, so the whole apparatus came out. This is the exact shape
 *      CLAUDE.md warns about — "a payment path must never outlive the product
 *      it sells" — so it gets a test, not just a commit message.
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
const REGISTRY = read("src/lib/launches.ts");
const DOCS     = read("src/app/docs/blue-chat/page.tsx");
const LAUNCHPG = read("src/app/launch/page.tsx");
/** The deploy surface itself. Read here so the "chat no longer signs" assertion
 *  can be paired with "something still does" — see point 6 in the header. */
const B20PAGE  = read("src/app/app/b20/B20Client.tsx");
/** The /app/launches page is GONE (2026-09-07) — this file used to read it and
 *  assert things about its contents. Its middleware redirect is what stands in
 *  its place, so that is what we read now. */
const MIDDLEWARE = read("src/middleware.ts");

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
check("the /app/launches page that hosted the Bankr modal is gone entirely",
  !existsSync(path.join(WEB, "src/app/app/launches")));

// Nothing may POST to the dead endpoint from any surface.
for (const [label, src] of [["chat route", ROUTE], ["tool cards", CARDS]] as const) {
  check(`${label} makes no call to /api/launch-token`,
    !/["'`]\/api\/launch-token/.test(src));
}

// ── 2c. The MONEY surfaces went with it ──────────────────────────────────────
// The 2026-09-06 commit took the deploy but left the fee/claim apparatus live —
// two routes proxying Bankr, and a tab that built and sent claim calldata. That
// is a payment path outliving its product, which CLAUDE.md forbids outright.
// ShunTr decided 2026-09-07 that claiming happens in Bankr's own UI, so it came
// out. These assert it does not creep back.
console.log("\n2c. no creator-fee claim path proxying Bankr survives");

for (const dir of ["src/app/api/my-tokens", "src/app/api/claim-fees"] as const) {
  check(`${dir} is gone`, !existsSync(path.join(WEB, dir)));
}
// The upstream endpoints themselves, in case someone re-adds a caller anywhere.
const BANKR_FEE_UPSTREAM = /doppler\/creator-fees|doppler\/build-claim/;
for (const [label, src] of [["chat route", ROUTE], ["tool cards", CARDS]] as const) {
  check(`${label} does not call Bankr's creator-fee endpoints`,
    !BANKR_FEE_UPSTREAM.test(src));
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
                            ["tool cards", CARDS]] as const) {
  const offending = (src.match(BANKR_TERMS) ?? [])[0];
  check(`${label} does not quote launchpad terms as live`, !offending,
    offending ? `found "${offending}"` : "");
}
// Counter-assertion: the retirement is EXPLAINED somewhere a user lands, not
// merely scrubbed. Silent removal leaves anyone with a stale link guessing.
check("the docs explain what happened to the launchpad instead of hiding it",
  /Bankr/.test(DOCS) && /suspended/i.test(DOCS));

// ── 3. Chat has no token-deploy tool, and the prompt knows it ────────────────
// Header points 6 and 7. Everything here is DERIVED from the two source files:
// the registered-tool list comes out of route.ts, the prefixes come out of that
// list, and the prompt is scanned with a pattern built from those prefixes. No
// tool name is written down in this file except the one retired id, and that one
// only as a tombstone.
console.log("\n3. chat offers no way to deploy a token");

/** The tool schema list the model is actually handed. Same shape the orphan
 *  check above relies on (`name: "…"`), so if that pattern ever stops matching,
 *  BOTH checks go loud rather than one silently passing on an empty set. */
const REGISTERED = [...new Set([...ROUTE.matchAll(/name: "([a-z0-9_]+)"/g)].map(m => m[1]))];
check("the registered-tool list was derived, not empty", REGISTERED.length > 20,
  `${REGISTERED.length} tools`);

// Names, narrowed to TOKEN creation. The first draft of this pattern was just
// /launch|deploy/ and it flagged `blue_deploy` — which is a text tool about
// Basescan verify commands and gas, not a token launcher. That false positive is
// the useful one: a name is weak evidence, so it is the NET here, not the test.
// `hub_b20_manage` (mint/burn on an EXISTING token) must not match; creating one
// must.
const DEPLOY_SHAPED =
  /launch|(?:deploy|create|issue)[_a-z]*token|token[_a-z]*(?:deploy|create)|b20[_a-z]*create|create[_a-z]*b20/;
const deployTools = REGISTERED.filter(n => DEPLOY_SHAPED.test(n));
check("no registered chat tool is named like a token-deploy tool", deployTools.length === 0,
  deployTools.length ? `found: ${deployTools.join(", ")}` : `checked ${REGISTERED.length}`);

// The operation, which is what actually matters. A tool only becomes a deploy
// PATH when it can put a transaction in front of the user, and in this codebase
// that means a dispatcher case rendering an action card — text tools just return
// prose. So: any tool that TALKS about deploying (name or description) must have
// no card. That keeps `blue_deploy` and `hub_b20_analyze` honest as explainers
// and would catch a rename that dodges the pattern above, without either one
// being written down here.
const SCHEMAS = [...ROUTE.matchAll(/name: "([a-z0-9_]+)",\s*\n\s*description: "([^"]*)"/g)];
check("tool descriptions were parsed for the operation check", SCHEMAS.length > 20,
  `${SCHEMAS.length} schemas`);
const deployish = SCHEMAS
  .filter(([, n, d]) => /deploy|launch/i.test(n) || /\bdeploy(ing|ment)?\b|\blaunch(ing)?\b/i.test(d))
  .map(([, n]) => n);
check("tools that discuss deploying were found", deployish.length > 0, deployish.join(", "));
const deployishWithCard = deployish.filter(n => CARDS.includes(`case "${n}":`));
check("no deploy-related tool renders an action card", deployishWithCard.length === 0,
  deployishWithCard.length
    ? `these can put a tx in front of the user: ${deployishWithCard.join(", ")}`
    : `${deployish.length} explainers, all card-less`);

// The retired ids by name, as tombstones. `prepare_token_launch` (Bankr) and
// `hub_b20_launch` (self-hosted) died for different reasons four days apart;
// naming both means re-adding either one fails loudly instead of matching the
// generic pattern above and being argued about.
for (const dead of ["hub_b20_launch", "prepare_token_launch"]) {
  check(`"${dead}" is not registered again`, !ROUTE.includes(`name: "${dead}"`));
  check(`"${dead}" has no marker handler`, !ROUTE.includes(`toolName === "${dead}"`));
  check(`"${dead}" has no dispatcher case`, !CARDS.includes(`case "${dead}":`));
}
check("the B20 launch card and its script generator are gone",
  !/B20LaunchCard|CreateToken\.s\.sol/.test(CARDS));

// ── 3a. …and the prompt does not name a tool that isn't there ────────────────
// The #204/#205 mechanism: a template with no tool behind it gets filled in from
// training data. Derived on both sides — prefixes come from the registered names
// themselves, so a new tool family (`foo_*`) is scanned the day it ships without
// anyone editing this file.
console.log("\n3a. every tool the prompt names is a tool that exists");

const PREFIXES = [...new Set(REGISTERED.map(n => n.split("_")[0]))];
check("tool-name prefixes were derived from the registered list", PREFIXES.length >= 3,
  PREFIXES.join(", "));

const NAMED = [...new Set(
  PROMPT.match(new RegExp(String.raw`\b(?:${PREFIXES.join("|")})_[a-z0-9_]+\b`, "g")) ?? [],
)];
check("the prompt names tools at all", NAMED.length > 5, `${NAMED.length} names`);

const phantom = NAMED.filter(n => !REGISTERED.includes(n));
check("the prompt names no tool that is not registered", phantom.length === 0,
  phantom.length ? `phantom: ${phantom.join(", ")}` : `${NAMED.length} names all resolve`);

const promptDeploy = NAMED.filter(n => DEPLOY_SHAPED.test(n));
check("the prompt names no token-deploy tool", promptDeploy.length === 0,
  promptDeploy.length ? `found: ${promptDeploy.join(", ")}` : "");

// The counter-assertion, and the reason this whole section is not just deletion:
// removing the rules WITHOUT stating the missing capability is the #204 hole
// itself — full B20 knowledge (createB20, initCalls, Beryl) and no sentence
// saying it cannot be performed. The denial must exist…
check("the prompt states plainly that chat cannot deploy a token",
  /YOU CANNOT DEPLOY, LAUNCH OR CREATE A TOKEN/.test(PROMPT));
// …and must sit in the ALWAYS-ON half, which is the inverse of what this file
// asserted before 2026-09-08. Then the rule named a tool, so it belonged in the
// gated half or it would re-create #205. Now it names none, and a tool-free
// prompt carrying B20 knowledge is precisely the one most likely to invent a
// deploy flow — so it has to be ahead of the dispatch header, not after it.
check("the denial lives in the always-on knowledge block, not the gated one",
  PROMPT.indexOf("YOU CANNOT DEPLOY, LAUNCH OR CREATE A TOKEN")
    < PROMPT.indexOf("## B20 & chain actions — which tool to call"));
// Pointing at a page is allowed and wanted; describing a flow is not.
check("the prompt still points at /app/b20 as a place the user can go",
  /\/app\/b20/.test(PROMPT));

// The knowledge that must NOT have been deleted along with the dispatch: reading
// B20 state is a live capability and explaining the standard is allowed. If these
// go, "we removed deploy" quietly became "we removed B20".
check("the B20 read/explain tools survived the removal",
  ROUTE.includes(`name: "hub_b20_inspect"`) && ROUTE.includes(`name: "hub_b20_analyze"`));
check("the prompt kept the real B20 background",
  /PolicyRegistry/.test(PROMPT) && /Beryl/.test(PROMPT) && /createB20/.test(PROMPT));

// ── 3b. One deploy entrance, and it is not the chat bubble ───────────────────
// Both halves are asserted together on purpose (header point 6). Absence alone
// would pass if /app/b20 also lost its deploy; presence alone would pass if chat
// grew its button back. The pair says "exactly one door, and it is the gated
// one".
console.log("\n3b. deploying is /app/b20's job, and chat does not do it too");

// Quote-anchored: a retirement comment NAMES /api/b20/prepare while explaining
// why nothing calls it. A bare substring match would read that explanation as
// the offence it warns about.
//
// This is now whole-file rather than scoped to one component, and that is the
// upgrade the full removal bought. Before, the claim was "the B20 card does not
// sign" and it had to be checked against a slice of that one function — the rest
// of the file legitimately signs (robinhood_send, robinhood_swap, earn all
// broadcast from chat, by design). With no B20 card at all, the stronger claim
// holds: NOTHING in chat talks to the B20 deploy endpoints.
for (const ep of ["prepare", "receipt"]) {
  check(`no chat card calls /api/b20/${ep}`,
    !new RegExp(`["'\`]/api/b20/${ep}`).test(CARDS));
}

check("/app/b20 still holds the deploy that chat gave up",
  /["'`]\/api\/b20\/prepare/.test(B20PAGE) && /["'`]\/api\/b20\/receipt/.test(B20PAGE));
// The reason /app/b20 is the door we kept: it refuses an unactivated variant up
// front instead of sending the wallet at a transaction that reverts. If this
// read goes, the two doors are equally bad again and the removal loses its point.
// Anchored on the CALL and the derived gate, not on the word "activation" —
// a comment mentioning the registry must not be able to satisfy this.
check("/app/b20 still gates on the on-chain activation read before signing",
  /runB20Activation\(/.test(B20PAGE) && /const canDeploy = .*!notActivated/.test(B20PAGE));

// ── 4. The launch records are evidence and must outlive their writer ─────────
console.log("\n4. launch history survived the route that produced some of it");

check("src/lib/launches.ts still exists", existsSync(path.join(WEB, "src/lib/launches.ts")));
check("the writers still exist to record launches",
  existsSync(path.join(WEB, "src/app/api/robinhood/receipt/route.ts"))
  && existsSync(path.join(WEB, "src/app/api/b20hub/register/route.ts")));
check("recordLaunch is still exported for them", /export async function recordLaunch/.test(REGISTRY));
// MEASURED 2026-09-07: only /api/b20hub/register has a caller in src/ —
// /api/robinhood/receipt has none. The header must not call it "live", because
// "two live writers" is the sentence that would let the next reader conclude
// the data is fresher than it is.
check("the registry does not claim two LIVE writers it cannot show",
  !/TWO writers today, both self-hosted and both alive/.test(REGISTRY));
// The rows Bankr wrote carry no `source` field, so they cannot be told apart
// from the live ones. The header must keep saying so — a future reader that
// assumes every row has a live writer is the way this data gets "cleaned up".
check("the registry warns that legacy rows are unattributable",
  /NOT distinguishable/.test(REGISTRY) && /no `source`/.test(REGISTRY));
// The showcase that used to list them is GONE (it existed to sell the Bankr fee
// claim). Deleting a page must not delete the data, so the assertion flips:
// the page is absent AND a reader still exists. Without the second half this
// would go green if the registry were deleted outright.
check("the /app/launches showcase is gone",
  !existsSync(path.join(WEB, "src/app/app/launches")));
check("a reader still renders launch records after it",
  existsSync(path.join(WEB, "src/app/api/b20hub/tokens/route.ts"))
  && existsSync(path.join(WEB, "src/app/app/b20hub/FeedGrid.tsx")));
// …and B20HUB's OWN creator-fee claim is not Bankr's and must not be swept up
// with it: it is self-hosted, permissionless, and pays an on-chain 80/15/5.
check("B20HUB's self-hosted fee claim survived the Bankr fee removal",
  existsSync(path.join(WEB, "src/app/app/b20hub/claim/ClaimClient.tsx")));

// ── 5. Every published URL still resolves ────────────────────────────────────
console.log("\n5. the advertised URLs still go somewhere real");

// It used to redirect to chat, because chat carried the launch tool. It no
// longer does, so sending /launch there would land the user on a surface whose
// only honest answer is "I can't". The redirect follows the capability.
check("/launch is kept as a redirect, not deleted into a 404",
  existsSync(path.join(WEB, "src/app/launch/page.tsx")));
// Target is /app/b20, NOT /app/chat. This branch was cut before #430 removed
// chat's second deploy entrance, so its version of this assertion still named
// chat — a surface whose only honest answer is now "I can't". Keeping the
// branch's line would have re-pointed the check at the retired door.
check("/launch points at the surface that can actually deploy",
  /redirect\("\/app\/b20"\)/.test(LAUNCHPG));
// /app/launches was linked from the public docs page and the B20HUB runbook, so
// it is in the wild the way Blue Feed's share links were. Deleting the files is
// only half the retirement; the 301 is the other half.
check("/launches 301s instead of 404ing after the page was deleted",
  /pathname === "\/app\/launches"/.test(MIDDLEWARE));
check("the docs no longer link the deleted showcase",
  !/href="\/app\/launches"/.test(DOCS));

console.log(`\n${failures ? "FAIL" : "PASS"} — ${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
