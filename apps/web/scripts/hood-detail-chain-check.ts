/**
 * Blue Hood — regression guard: the detail panel never shows one chain's
 * numbers under another chain's badge.
 *
 * WHY THIS EXISTS
 * ---------------
 * The row-expand panel resolved BOTH of its data blocks by BARE TICKER:
 *
 *     callTool("rh-stock-liquidity", { ticker })   // M3
 *     callTool("rh-stock-holders",   { ticker })   // D1
 *
 * Both tools read Robinhood Chain (4663) and nothing else. NVDA, META, GOOGL
 * and AAPL exist on Base too as DIFFERENT tokens in DIFFERENT pools, so every
 * Base row on the board rendered RH pools, RH TVL, RH holders and — worst — an
 * RH slippage table, all under a BASE badge. Measured on production
 * 2026-08-28: NVDA panel $109.52M vs $1.71M in its own row (64× over), GOOGL
 * 17× over, AAPL 1.4× over, META 0.6× UNDER. The error is not directionally
 * consistent, so a reader could not mentally correct for it.
 *
 * AND THE OVERCORRECTION, WHICH WAS ITS OWN BUG
 * ---------------------------------------------
 * The first fix skipped BOTH blocks on every non-RH chain, so a Base row read
 * "Liquidity is not wired for this desk" an inch under its own TVL $1.90M /
 * VOL 24H $10.43M. What is Robinhood-only is the M3 TOOL, not the data: the Base
 * desk measures depth every cycle (`base-poller.ts` → `total_tvl_usd`,
 * `volume_24h_usd`), `registry.ts` will not admit a Base token until its
 * Aerodrome pool prints both, and `rule-engine.ts` gates every arrow on that
 * same figure. So the panel was denying a number the product elsewhere trades on.
 *
 * That is why the plan has three SOURCES (`tool` | `row` | `none`) and not a
 * boolean, and why group 1 now asserts a FLOOR as well as a ceiling — base must
 * render fewer blocks than RH AND more than none. Suppressing a true number is a
 * smaller error than printing a false one, but an unearned "not wired" makes
 * every honest "skipped" note on this board cheaper, which is the actual cost.
 *
 * WHAT THIS CHECKS, AND WHY IT IS SHAPED THIS WAY
 * ----------------------------------------------
 * Groups 1-4 are DIFFERENTIAL. They do not ask "is there a gate in the code" —
 * a gate can be present and inert. They ask whether robinhood and base actually
 * produce DIFFERENT output from the same ticker/contract, which is the only
 * property that distinguishes a fix from a comment. This is the shape the
 * PositionsStrip P1 guard used: "not re-keyed" is proven by "not present", not
 * by finding the re-key call.
 *
 * That is possible only because the decision was split out of the panel into
 * `blue-hood/detail-support.ts`. `TickerDetailPanel.tsx` and `HoodClient.tsx`
 * are `"use client"` React trees (wagmi, Privy) that no plain tsx script can
 * import — same reason `oracle-age.ts` exists.
 *
 * Group 5 is behavioural on the fetch layer: it proves the refusal fires BEFORE
 * any KV read or tool call (so this script touches no network and no KV — see
 * #155, the local .env.local points at a stale database).
 *
 * Group 6 is SOURCE assertions, for the wiring no return value can show, plus
 * the grep that proves no bare-ticker key survives anywhere in the detail path.
 *
 * Group 7 covers the correction's own risk surface: once the panel may draw a
 * number it did not fetch, every way that number can be ABSENT has to stay
 * distinguishable — "we weren't handed it" vs "the poll came back empty" vs a
 * real reading of $0 — or all three collapse into one em-dash.
 *
 * Run: npx tsx scripts/hood-detail-chain-check.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { HoodChain } from "../src/lib/blue-hood/types";
import {
  detailCacheKey,
  detailPanelPlan,
  detailUnavailableReason,
  explorerAddressUrl,
  explorerTokenUrl,
  rowLiquidityView,
} from "../src/lib/blue-hood/detail-support";
import { fetchAndCacheDetail } from "../src/lib/blue-hood/ticker-detail";

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

// Exhaustive over the union: if someone adds a third HoodChain, this array stops
// type-checking and the new desk cannot slip past the sweeps below undecided.
const ALL_CHAINS = ["robinhood", "base"] as const satisfies readonly HoodChain[];
type Covered = (typeof ALL_CHAINS)[number];
// Compile-time proof the list is COMPLETE, not merely well-typed.
const _exhaustive: Exclude<HoodChain, Covered> extends never ? true : never = true;
void _exhaustive;

// The same ticker on both desks — the whole point. If these were different
// strings the differential below would prove nothing.
const T = "NVDA";
// The two real NVDA contracts, so the explorer checks run on the addresses the
// board actually renders rather than on placeholders.
const NVDA_BASE = "0xb2000000000000000000000000000000000000e2";
const NVDA_RH = "0x1234567890abcdef1234567890abcdef12345678";

// ── 1. the plan differs by chain (this is the fix, stated as behaviour) ───
console.log("\n1. detailPanelPlan — base and robinhood do NOT plan the same way");
const rh = detailPanelPlan("robinhood");
const base = detailPanelPlan("base");
check(
  "robinhood fetches, base does not",
  rh.fetch === true && base.fetch === false,
  `rh.fetch=${rh.fetch} base.fetch=${base.fetch}`,
);
check(
  "liquidity: TOOL-sourced on RH, ROW-sourced on base",
  rh.liquidity === "tool" && base.liquidity === "row",
  "the $109.52M-vs-$1.71M block — RH's number must not reach a Base panel, but "
    + "Base's own $1.71M must still be shown",
);
check(
  "holders: TOOL-sourced on RH, absent on base",
  rh.holders === "tool" && base.holders === "none",
  "D1 reads the RH explorer only and no other desk has a holder index",
);
check(
  "no field of the two plans is accidentally identical where it matters",
  rh.fetch !== base.fetch && rh.liquidity !== base.liquidity && rh.holders !== base.holders,
  "a gate that is present but inert would pass a source grep and fail here",
);
// ── THE OVERCORRECTION, checked as its own property ───────────────────────
// The first fix for this bug set BOTH base blocks to nothing, which put
// "Liquidity is not wired for this desk" an inch under the same row's
// TVL $1.90M / VOL 24H $10.43M. Suppressing a true number is a smaller error
// than printing a false one, but it is still an error, and an unearned
// "not wired" devalues every honest note beside it. Assert the FLOOR as well
// as the ceiling: base must show fewer blocks than RH AND more than none.
check(
  "base does NOT render an empty liquidity block — the desk measures its own depth",
  base.liquidity !== "none",
  "base-poller.ts sets total_tvl_usd + volume_24h_usd every cycle; registry.ts "
    + "will not even ADMIT a Base token until its Aerodrome pool prints both",
);
check(
  "…and base still does not FETCH — the numbers come off the row, not off M3",
  base.fetch === false && base.liquidity === "row",
  "a 'row' source that fetched would be the original bug with extra steps",
);
// The set of blocks that show NUMBERS (as against a note). Base's must be a
// strict subset of RH's — and must still contain liquidity and the open arrow,
// both of which are chain-correct (the parent matches on chainOf, not ticker).
const blocksOf = (p: ReturnType<typeof detailPanelPlan>) =>
  new Set([
    ...(p.liquidity !== "none" ? ["liquidity"] : []),
    ...(p.holders !== "none" ? ["holders"] : []),
    "open_arrow", // rendered on every chain, by design
  ]);
const rhBlocks = blocksOf(rh);
const baseBlocks = blocksOf(base);
check(
  "base renders a STRICT SUBSET of RH's blocks",
  [...baseBlocks].every((b) => rhBlocks.has(b)) && baseBlocks.size < rhBlocks.size,
  `base={${[...baseBlocks].join(",")}} rh={${[...rhBlocks].join(",")}}`,
);
check(
  "…and the ONE block missing is holders, not liquidity",
  [...rhBlocks].filter((b) => !baseBlocks.has(b)).sort().join(",") === "holders",
  "if liquidity appears in this list again, the overcorrection is back",
);
check(
  "the open arrow survives on base — it is measured, not inherited",
  baseBlocks.has("open_arrow"),
  "dropping it would trade a wrong block for a missing right one",
);

// ── 2. the notes name the real cause ──────────────────────────────────────
console.log("\n2. the notes state WHY, and do not invent a failure OR deny a fact");
for (const c of ALL_CHAINS) {
  const p = detailPanelPlan(c);
  check(
    `chain "${c}": a note exists iff the block is NOT tool-backed`,
    (p.liquidity !== "tool") === (p.liquidityNote !== null)
      && (p.holders !== "tool") === (p.holdersNote !== null),
    "a full render needs no caveat; anything less than one has to say so",
  );
}
const notes = [base.liquidityNote ?? "", base.holdersNote ?? ""];
check(
  "the notes name the real cause (Robinhood-only upstream)",
  notes.every((n) => /robinhood/i.test(n)),
  `→ "${base.liquidityNote}"`,
);
check(
  "the notes do NOT claim a failure or an outage",
  !notes.some((n) => /unavailable|failed|error|timed out|down/i.test(n)),
  "nothing was tried and nothing broke — same lesson as ArrowBriefBlock's skipped arm",
);
check(
  "the notes do NOT claim the ticker is unknown or has no data",
  !notes.some((n) => /not found|unknown ticker|no data|does not exist/i.test(n)),
  "the token exists and is liquid; it is the SOURCE that is missing",
);
check(
  "liquidity and holders get DISTINCT notes naming their own tool",
  base.liquidityNote !== base.holdersNote
    && /M3/.test(base.liquidityNote ?? "")
    && /D1/.test(base.holdersNote ?? ""),
);
// ── the retracted sentence, pinned so it cannot come back ─────────────────
check(
  'base\'s LIQUIDITY note no longer says "not wired"',
  !/not wired/i.test(base.liquidityNote ?? ""),
  "it was wired all along — this exact sentence sat under TVL $1.90M on production",
);
check(
  "…and it makes the POSITIVE claim instead: this desk measured it",
  /measured/i.test(base.liquidityNote ?? "") && /base/i.test(base.liquidityNote ?? ""),
  `→ "${base.liquidityNote}"`,
);
check(
  "…and it says why the block is still NARROWER than RH's (no slippage curve)",
  /slippage/i.test(base.liquidityNote ?? "") && /reserves/i.test(base.liquidityNote ?? ""),
  "a shorter block with no explanation reads as a failure",
);
check(
  'base\'s HOLDERS note still DOES say "not wired" — there it is true',
  /not wired/i.test(base.holdersNote ?? ""),
  "the correction was to one block, not a blanket softening of both",
);
check(
  "an unknown future chain shows NOTHING rather than inheriting either desk",
  (() => {
    const p = detailPanelPlan("solana" as HoodChain);
    return p.fetch === false && p.liquidity === "none" && p.holders === "none";
  })(),
  '"row" is a property of Base\'s poller populating the fields, not of being non-RH',
);
check(
  'the unknown chain KEEPS the "not wired" wording — it has earned it',
  /not wired/i.test(detailPanelPlan("solana" as HoodChain).liquidityNote ?? ""),
  "the default arm must not inherit Base's positive claim about its own poll",
);

// ── 3. explorer links land on the chain that indexes the contract ─────────
console.log("\n3. explorer URLs — same contract string, different host per chain");
check(
  "token URL differs by chain for the SAME contract",
  explorerTokenUrl("base", NVDA_BASE) !== explorerTokenUrl("robinhood", NVDA_BASE),
);
check(
  "base token → basescan, never the RH blockscout",
  explorerTokenUrl("base", NVDA_BASE) === `https://basescan.org/token/${NVDA_BASE}`
    && !/robinhoodchain/.test(explorerTokenUrl("base", NVDA_BASE)),
);
check(
  "robinhood token URL is byte-identical to the retired literal",
  explorerTokenUrl("robinhood", NVDA_RH)
    === `https://robinhoodchain.blockscout.com/token/${NVDA_RH}`,
  "the incumbent pays nothing — #308's rule",
);
check(
  "address URL differs by chain for the SAME address",
  explorerAddressUrl("base", NVDA_BASE) !== explorerAddressUrl("robinhood", NVDA_BASE),
);
check(
  "robinhood address URL is byte-identical to the retired literal",
  explorerAddressUrl("robinhood", NVDA_RH)
    === `https://robinhoodchain.blockscout.com/address/${NVDA_RH}`,
);
check(
  "no chain's URL ever names the other chain's host",
  !/basescan/.test(explorerTokenUrl("robinhood", NVDA_RH))
    && !/robinhoodchain/.test(explorerAddressUrl("base", NVDA_BASE)),
);

// ── 4. the cache key cannot collide across desks ──────────────────────────
console.log("\n4. detailCacheKey — one ticker, two desks, two keys");
check(
  "the SAME ticker yields DIFFERENT keys on the two chains",
  detailCacheKey("base", T) !== detailCacheKey("robinhood", T),
  `${detailCacheKey("base", T)} ≠ ${detailCacheKey("robinhood", T)}`,
);
check(
  "every chain's key names its chain",
  ALL_CHAINS.every((c) => detailCacheKey(c, T).includes(`:${c}:`)),
  "a raw KV scan must never leave the reader guessing which desk a payload is from",
);
check(
  "no key is the bare-ticker form this change retired",
  ALL_CHAINS.every((c) => detailCacheKey(c, T) !== `bh:detail:${T}`),
  "`bh:detail:NVDA` was one Base write away from poisoning the RH entry",
);
check(
  "keys stay under the bh:detail: namespace (prefix scans keep working)",
  ALL_CHAINS.every((c) => detailCacheKey(c, T).startsWith("bh:detail:")),
);
check(
  "the ticker is still normalised to uppercase",
  detailCacheKey("base", "nvda") === detailCacheKey("base", "NVDA"),
  "lowercase input used to fold into the same key; that must not regress",
);
check(
  "keys are distinct across the full chain × ticker grid",
  (() => {
    const grid = ALL_CHAINS.flatMap((c) => ["NVDA", "META", "GOOGL", "AAPL"].map((t) => detailCacheKey(c, t)));
    return new Set(grid).size === grid.length;
  })(),
  "all four tickers are dual-listed — a collision anywhere is the whole bug",
);

// ── 5. the fetch layer refuses, before it can spend anything ──────────────
// Wrapped in a function rather than a top-level await: tsx transforms this file
// to CJS, where top-level await is a build error.
async function group5(): Promise<void> {
  console.log("\n5. fetchAndCacheDetail — refuses a chain its tools cannot read");
  let threw: Error | null = null;
  const t0 = Date.now();
  try {
    await fetchAndCacheDetail("base", T);
  } catch (e) {
    threw = e as Error;
  }
  const elapsed = Date.now() - t0;
  check("it throws for chain=base rather than returning RH data", threw !== null);
  check(
    "the message names the real constraint",
    !!threw && /robinhood/i.test(threw.message),
    `→ "${threw?.message ?? ""}"`,
  );
  // The refusal must precede the two 15s tool calls AND the KV read. If it
  // returned instantly it cannot have touched either — which is also why this
  // whole script needs no network and no KV credentials.
  check(
    "it refuses BEFORE any tool call or KV read",
    elapsed < 1000,
    `${elapsed}ms — a post-fetch filter would cost ~15s and still bill the calls`,
  );
}

// ── 6. the wiring, which no return value can show ─────────────────────────
function group6(): void {
console.log("\n6. wiring + the grep that proves no bare-ticker key survives");
// Assert against CODE, not prose: the comments in these files deliberately
// quote the retired literals to explain what was removed, and a bare substring
// test would read the explanation as the bug itself. Line-level stripping is
// enough for this repo's `//` and `/** … */` styles — it is a guard, not a
// parser, and a false PASS here still needs groups 1-5 to also be defeated.
const stripComments = (src: string) =>
  src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    })
    .join("\n");

const clientSrc = read("src/app/app/hood/HoodClient.tsx");
const client = stripComments(clientSrc);
const panelSrc = read("src/app/app/hood/TickerDetailPanel.tsx");
const panel = stripComments(panelSrc);
const routeSrc = read("src/app/api/hood/ticker-detail/route.ts");
const route = stripComments(routeSrc);
const fetchSrc = read("src/lib/blue-hood/ticker-detail.ts");
const fetchLayer = stripComments(fetchSrc);
const cronSrc = read("src/app/api/cron/blue-hood/sparkline-refresh/route.ts");
const cron = stripComments(cronSrc);

// Pinned to the ELEMENT, not to the file. `chain={chainOf(r)}` also appears
// twice on <ChainTag> in this file, so a file-wide substring test passes even
// with the panel hardcoded to "robinhood" — which is precisely the bug. Found
// by mutation testing: the first version of this check survived that exact
// mutation. Extract the one element and assert inside it.
const panelEl = /<TickerDetailPanel\b[\s\S]*?\/>/.exec(client)?.[0] ?? "";
check(
  "the <TickerDetailPanel> element exists and is passed a chain",
  panelEl !== "" && /\bchain=/.test(panelEl),
  panelEl === "" ? "element not found — did it move or get renamed?" : "",
);
check(
  "…and that chain is the ROW's, not a hardcoded constant",
  /chain=\{chainOf\(r\)\}/.test(panelEl) && !/chain="/.test(panelEl),
  "the same chainOf(r) the open-arrow lookup already used one block above",
);
check(
  "the panel's chain prop is REQUIRED (no `?`, no default)",
  /\bchain: HoodChain;/.test(panel) && !/chain\?:\s*HoodChain/.test(panel),
  "optional would let the next call site omit it and silently get RH again",
);
check(
  "the panel gates its fetch on the shared plan",
  /if \(!detailPanelPlan\(chain\)\.fetch\) return;/.test(panel),
  "so the provenance line never says 'fresh · updated 5s ago' about an unmeasured desk",
);
check(
  "the panel no longer hardcodes either explorer host",
  !/robinhoodchain\.blockscout\.com/.test(panel) && !/basescan\.org/.test(panel),
  "both links go through the shared chain-routed helpers",
);
check(
  "the panel renders the shared notes, not a local re-derivation",
  /plan\.liquidityNote/.test(panel) && /plan\.holdersNote/.test(panel),
  "a second copy would drift out from under this guard",
);
// ── the row-sourced block is actually WIRED, not merely typed ─────────────
// `detailPanelPlan("base").liquidity === "row"` is a decision; these are the
// three places it has to land or the decision changes nothing on screen.
check(
  "the no-fetch branch branches on the SOURCE, not just on fetch",
  /plan\.liquidity === "row"/.test(panel),
  "without this the plan says 'row' and the panel still prints the note alone",
);
check(
  "…and it renders the row block through the shared view function",
  /<RowLiquidityBlock/.test(panel) && /rowLiquidityView\(chain, row\)/.test(panel),
  "the three-nothings decision must not be re-derived in JSX",
);
check(
  "the panel's rowLiquidity prop is REQUIRED (no `?`)",
  /\browLiquidity: RowLiquidity \| null;/.test(panel) && !/rowLiquidity\?:/.test(panel),
  "optional would let a call site omit it and silently claim 'no reading this cycle'",
);
check(
  "the call site passes rowLiquidity off the ROW",
  /rowLiquidity=\{\{/.test(panelEl) && /r\.total_tvl_usd/.test(panelEl),
  "a fetch here would be the original bug with extra steps",
);
check(
  "…using the SAME fallback the dust gate uses (total ?? tvl), and `??` not `||`",
  /totalTvlUsd: r\.total_tvl_usd \?\? r\.tvl_usd \?\? null/.test(panelEl),
  "`||` would turn a real $0 reading into 'no reading' — rule-engine.ts:53 is the twin",
);
check(
  "the panel does not hardcode a DEX name for the pool link",
  !/Aerodrome/.test(panel),
  "a fact about today's Base registry, in a file with no way to notice it changed",
);
check(
  "the open-arrow block is ONE component, shared by both branches",
  (panel.match(/<OpenArrowSection openArrow=\{openArrow\} \/>/g) ?? []).length === 2
    && (panel.match(/function OpenArrowSection/g) ?? []).length === 1,
  "duplicated JSX could drift; a shared component cannot",
);
check(
  "the client fetch threads &chain=",
  /chain=\$\{encodeURIComponent\(chain\)\}/.test(panel),
);
check(
  "the route refuses an unknown chain instead of falling through to RH",
  /KNOWN_CHAINS as readonly string\[\]\)\.includes\(rawChain\)/.test(route)
    && /status: 400/.test(route),
);
check(
  "the route consults the same shared plan the panel does",
  /detailPanelPlan\(chain\)/.test(route),
  "two independent policies would be two policies",
);
check(
  "the 501 body no longer hardcodes the retired blanket claim",
  !/No liquidity\/holders source is wired/.test(route),
  "the same false sentence, on the surface where the reader has no TVL figure to doubt it with",
);
check(
  "…it composes the reason from the plan instead",
  /error: detailUnavailableReason\(chain\)/.test(route),
);
check(
  "…and ships the per-block SOURCE as an enum, not only as prose",
  /liquidity_source: plan\.liquidity/.test(route) && /holders_source: plan\.holders/.test(route),
  "a machine caller must be able to branch on `row` without parsing English",
);
check(
  "fetchAndCacheDetail takes chain FIRST and required",
  /export async function fetchAndCacheDetail\(\s*chain: HoodChain,\s*ticker: string,\s*\)/.test(fetchLayer),
  "chain-first makes a one-arg legacy call a compile error, not a silent RH read",
);
check(
  "readCachedDetail is chain-qualified too",
  /export async function readCachedDetail\(\s*chain: HoodChain,\s*ticker: string,\s*\)/.test(fetchLayer),
  "a chain-less READ would serve the other desk's cached payload",
);
check(
  "the cached payload records its own chain",
  /chain: HoodChain;/.test(fetchLayer) && /\bchain,\n/.test(fetchLayer),
);
check(
  "the warm cron states its chain explicitly",
  /fetchAndCacheDetail\("robinhood", t\.ticker\)/.test(cron),
  "it reads KV_SNAPSHOT_LATEST, which is the RH desk's key — read off the source, not assumed",
);

// THE GREP the reviewer asked for, run as an assertion so it cannot rot: no
// file may build a `bh:detail:` key from anything but the shared constructor.
//
// It WALKS src/ rather than consulting a hand-listed set of "detail path"
// files. A hardcoded list is exactly the thing that goes stale — the next
// caller lands in a file nobody added, and a guard that only looks where the
// bug already was is not a guard. Comments are stripped first: the modules
// above deliberately quote the retired `bh:detail:${ticker}` form to explain
// what was removed, and a raw grep would read the explanation as the bug.
console.log("\n   grep — every bh:detail: literal under src/ (comments stripped):");
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}
const literals: string[] = [];
for (const abs of walk(join(ROOT, "src"))) {
  for (const line of stripComments(readFileSync(abs, "utf8")).split("\n")) {
    if (line.includes("bh:detail:")) {
      literals.push(`${abs.slice(ROOT.length + 1)}: ${line.trim()}`);
    }
  }
}
for (const l of literals) console.log(`     ${l}`);
check(
  "exactly ONE bh:detail: key literal exists anywhere under src/",
  literals.length === 1,
  `found ${literals.length}`,
);
check(
  "…and it is the chain-qualified constructor in detail-support.ts",
  literals.length === 1
    && literals[0].startsWith("src/lib/blue-hood/detail-support.ts:")
    && literals[0].includes("`bh:detail:${chain}:${ticker.toUpperCase()}`"),
  literals[0] ?? "(none)",
);
// Stated positively, on purpose. The first draft of this check stripped
// `${chain}:` out and then looked for a bare-ticker form — which turns the
// CORRECT key into the incorrect one by construction and fails always. Assert
// what must be true (chain segment present, and ahead of the ticker) rather
// than mutating the input and asserting what must not.
check(
  "the chain segment sits BEFORE the ticker in every key",
  literals.length > 0 && literals.every((l) => /`bh:detail:\$\{chain\}:/.test(l)),
  "chain-absent or chain-last is the storage-layer form of the same bug",
);
}

// ── 7. the row-sourced block: three nothings, told apart ──────────────────
// This group exists because the CORRECTION had its own failure mode. Once the
// panel is allowed to draw a number it did not fetch, every way that number can
// be absent has to stay distinguishable — otherwise "we weren't handed it",
// "the poll came back empty" and "$0 of depth" all collapse into one em-dash and
// the reader picks whichever they find most comforting.
function group7(): void {
console.log("\n7. rowLiquidityView — an absent number must say WHICH absence it is");

const measured = rowLiquidityView("base", {
  totalTvlUsd: 1_900_000,
  volume24hUsd: 10_430_000,
  poolRef: "0xaaaabbbbccccddddeeeeffff0000111122223333",
});
check(
  "a measured row is reported measured, with its figures untouched",
  measured.measured === true
    && measured.tvlUsd === 1_900_000
    && measured.volume24hUsd === 10_430_000,
  "these are the real production figures the old note was denying",
);
check(
  "a measured row carries NO empty note",
  measured.emptyNote === null,
  "a caveat beside a real number teaches the reader to ignore caveats",
);
check(
  "the pool link is routed by chain, not hardcoded",
  measured.poolUrl?.startsWith("https://basescan.org/address/") === true
    && rowLiquidityView("robinhood", {
      totalTvlUsd: 1, volume24hUsd: 1, poolRef: "0xdead",
    }).poolUrl?.startsWith("https://robinhoodchain.blockscout.com/") === true,
  `→ ${measured.poolUrl}`,
);
check(
  "a missing pool_ref yields a null link rather than a broken href",
  rowLiquidityView("base", { totalTvlUsd: 1, volume24hUsd: 1, poolRef: null }).poolUrl === null,
);

// The three nothings.
const notHanded = rowLiquidityView("base", null);
const notMeasured = rowLiquidityView("base", {
  totalTvlUsd: null, volume24hUsd: null, poolRef: "0xabc",
});
const zero = rowLiquidityView("base", { totalTvlUsd: 0, volume24hUsd: null, poolRef: "0xabc" });
check(
  "nothing #1 — a null row is NOT measured",
  notHanded.measured === false && notHanded.emptyNote !== null,
);
check(
  "…and its note blames OUR wiring, not the pool",
  /wiring/i.test(notHanded.emptyNote ?? "") && !/dust|\$0/.test(notHanded.emptyNote ?? ""),
  `→ "${notHanded.emptyNote}"`,
);
check(
  "nothing #2 — an empty poll is NOT measured",
  notMeasured.measured === false && notMeasured.emptyNote !== null,
);
check(
  "…and its note blames the POLL, and explicitly denies being $0",
  /poll/i.test(notMeasured.emptyNote ?? "")
    && /not \$0/i.test(notMeasured.emptyNote ?? ""),
  `→ "${notMeasured.emptyNote}"`,
);
check(
  "nothing #3 — a reading of ZERO is a MEASUREMENT, not an absence",
  zero.measured === true && zero.emptyNote === null && zero.tvlUsd === 0,
  "`??`-not-`||` at the call site is the other half of this; both are needed",
);
check(
  "the three cases do not share a sentence",
  notHanded.emptyNote !== notMeasured.emptyNote,
  "one string for two causes is the collapse this group exists to prevent",
);
check(
  "an empty note exists iff the reading is absent",
  [measured, notHanded, notMeasured, zero].every(
    (v) => v.measured === (v.emptyNote === null),
  ),
);
check(
  "neither empty note claims a failure or an outage",
  ![notHanded, notMeasured].some((v) => /unavailable|failed|error|down/i.test(v.emptyNote ?? "")),
  "nothing broke — same lesson as the plan notes in group 2",
);
check(
  "rowLiquidityView takes (chain, row) and NO ticker",
  rowLiquidityView.length === 2,
  "the defect this module exists to prevent is resolving a token by ticker string; "
    + "a function never handed one cannot commit it",
);

console.log("\n   detailUnavailableReason — the 501 body, composed from the plan");
check(
  "robinhood returns null — this endpoint CAN serve it",
  detailUnavailableReason("robinhood") === null,
  "null, not \"\" — an empty error message reads like success",
);
const baseReason = detailUnavailableReason("base") ?? "";
check("base returns a reason", baseReason !== "");
check(
  "the base reason names the real constraint (Robinhood-only tools)",
  /robinhood/i.test(baseReason) && /M3/.test(baseReason) && /D1/.test(baseReason),
);
check(
  "the base reason does NOT tell a machine that liquidity has no source",
  !/no liquidity/i.test(baseReason) && !/not wired/i.test(baseReason),
  "a human had the row's TVL an inch above to doubt this with; a machine has only the string",
);
check(
  "…it points at where the number actually lives",
  /snapshot/i.test(baseReason) && /total_tvl_usd/.test(baseReason),
  `→ "${baseReason}"`,
);
check(
  "…and still says holders have none",
  /holders has no source/i.test(baseReason),
  "the correction was to one block, not to both",
);
const unknownReason = detailUnavailableReason("solana" as HoodChain) ?? "";
check(
  "an unknown chain reports BOTH blocks sourceless",
  /Liquidity has no source/i.test(unknownReason) && /holders has no source/i.test(unknownReason),
);
check(
  "the reason DIFFERS by chain — it is composed, not a constant",
  baseReason !== unknownReason,
  "a fixed string would pass every check above and still be the old bug",
);
}

function finish(): void {
  console.log(
    failures === 0
      ? `\nALL ${checks} CHECKS PASSED\n`
      : `\n${failures} of ${checks} CHECK(S) FAILED\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

// Sequenced so the console output stays in group order — groups 6-7 are sync and
// would otherwise print before group 5's await resolves.
void group5().then(group6).then(group7).then(finish);
