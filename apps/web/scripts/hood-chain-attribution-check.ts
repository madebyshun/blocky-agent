/**
 * Guard for #162 — chain attribution on the Blue Hood board.
 *
 * WHAT IS BEING DEFENDED
 * ----------------------
 * `chainOf(x) => x.chain ?? "robinhood"` is CORRECT and must not be touched.
 * Production carries 24 live RH rows with no `chain` field and an arrow archive
 * whose every pre-Base entry has none either; a reader that stopped defaulting
 * would mis-attribute the entire historical record. Half of this file exists to
 * stop a future "fix" from removing the default in the name of strictness.
 *
 * The defect is narrower: because omission is LEGAL on the shared
 * `TickerSnapshot`, a Base row that forgets `chain: "base"` compiles, and
 * `chainOf` then reads it as Robinhood — silently, since absence is the norm on
 * the other desk. That row takes an RH badge, an RH explorer href, RH pools in
 * the detail panel (#161, re-opened from underneath its own fix) and an
 * RH-qualified arrow key.
 *
 * TWO LAYERS, TWO DIFFERENT THINGS
 * --------------------------------
 *   • tsc guards the WRITER — producers return `BaseTickerSnapshot`, so a
 *     forgotten marker is a compile error at the site that made it. THIS FILE
 *     CANNOT ASSERT THAT: tsx strips types without checking them, so a run of
 *     this script would stay green with every marker deleted. It is verified by
 *     mutation instead — deleting `chain: "base"` from each of the three
 *     producer sites is killed by `tsc --noEmit` and by nothing else. Run the
 *     type-check alongside this script or half the defence is untested.
 *   • `partitionBaseRows` guards the READER — `kvGet<BaseDeskLatest>` is an
 *     unchecked cast over JSON that an older deploy may have written, so at
 *     that boundary the type is a claim and this function is the check.
 *
 * WHY A SCRIPT AND NOT A UNIT TEST: same reason as
 * `archive-watch-check.ts` and `hood-detail-chain-check.ts` — the consumers are
 * `"use client"` React trees and Next route handlers that no plain tsx file can
 * import, so the rules live in dependency-free modules and are exercised here.
 *
 * Run: npx tsx scripts/archive-watch-check.ts && npx tsx scripts/hood-chain-attribution-check.ts
 */
import fs from "node:fs";
import path from "node:path";
import {
  chainOf,
  partitionBaseRows,
  type TickerSnapshot,
  type BaseTickerSnapshot,
} from "../src/lib/blue-hood/types";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean): void {
  if (ok) {
    passed++;
  } else {
    failed++;
    console.log(`FAIL  ${label}`);
  }
}

const WEB = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(WEB, rel), "utf8");

/** Comments describe intent; only code enforces it. A negative check run
 *  against raw source passes on a doc-block that merely MENTIONS the thing.
 *  Same stripper as `archive-watch-check.ts`, same reason. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const typesSrc = read("src/lib/blue-hood/types.ts");
const typesCode = stripComments(typesSrc);
const pollerSrc = read("src/lib/base-stocks/base-poller.ts");
const pollerCode = stripComments(pollerSrc);
const snapSrc = read("src/app/api/hood/snapshot/route.ts");
const snapCode = stripComments(snapSrc);

// ── fixtures ────────────────────────────────────────────────────────────────
const row = (ticker: string, chain?: "base" | "robinhood"): TickerSnapshot =>
  ({ ticker, ...(chain ? { chain } : {}), name: ticker, contract: "0x00" } as unknown as TickerSnapshot);

const baseRow = (t: string) => row(t, "base");
const rhRow = (t: string) => row(t, "robinhood");
const bareRow = (t: string) => row(t);

// ── 1. the legacy default MUST survive ──────────────────────────────────────
// If these ever fail, the "fix" under review is worse than the bug: production
// has 24 chain-less RH rows right now and an arrow archive full of them.
check("1.1 chainOf: absent ⟹ robinhood", chainOf({}) === "robinhood");
check("1.2 chainOf: undefined ⟹ robinhood", chainOf(undefined) === "robinhood");
check("1.3 chainOf: null ⟹ robinhood", chainOf(null) === "robinhood");
check("1.4 chainOf: explicit robinhood is preserved", chainOf({ chain: "robinhood" }) === "robinhood");
check("1.5 chainOf: explicit base is preserved", chainOf({ chain: "base" }) === "base");
check(
  "1.6 chainOf still spells the default `?? \"robinhood\"` (not thrown, not null)",
  /return\s+x\?\.chain\s*\?\?\s*"robinhood";/.test(typesCode),
);

// ── 2. partitionBaseRows: the marker must be SAID, not inferred ──────────────
{
  const { attributed, unattributed } = partitionBaseRows([baseRow("NVDA"), baseRow("META")]);
  check("2.1 all-marked rows are all attributed", attributed.length === 2);
  check("2.2 all-marked rows leave nothing unattributed", unattributed.length === 0);
}
{
  const { attributed, unattributed } = partitionBaseRows([bareRow("NVDA")]);
  check("2.3 a row with NO chain is NOT attributed to Base", attributed.length === 0);
  check("2.4 the chain-less row is reported, not dropped on the floor", unattributed.length === 1);
  check("2.5 the report names the ticker", unattributed[0].ticker === "NVDA");
}
{
  const { attributed, unattributed } = partitionBaseRows([rhRow("NVDA")]);
  check("2.6 an explicit RH row is not attributed to Base", attributed.length === 0);
  check("2.7 an explicit RH row is reported as unattributed-for-Base", unattributed.length === 1);
}
{
  const rows = [baseRow("NVDA"), bareRow("META"), rhRow("GOOGL"), baseRow("AAPL")];
  const { attributed, unattributed } = partitionBaseRows(rows);
  check("2.8 mixed: only the marked rows are attributed", attributed.map((r) => r.ticker).join(",") === "NVDA,AAPL");
  check("2.9 mixed: everything else lands in unattributed", unattributed.map((r) => r.ticker).join(",") === "META,GOOGL");
  check("2.10 conservation: nothing is invented or lost", attributed.length + unattributed.length === rows.length);
}
{
  const { attributed, unattributed } = partitionBaseRows([]);
  check("2.11 empty input is empty output, not an error", attributed.length === 0 && unattributed.length === 0);
}

// ── 3. the trap: partition must not route through the default ───────────────
// `chainOf(r) === "base"` behaves identically TODAY, which is exactly why a
// behavioural check cannot catch the substitution. It is caught here, at the
// source, because the coupling is the defect: it would make what counts as a
// Base row depend on the legacy back-compat rule, so any later change to that
// default would silently redefine Base membership.
{
  const body = typesCode.slice(
    typesCode.indexOf("export function partitionBaseRows"),
    typesCode.indexOf("export interface BaseDeskLatest"),
  );
  check("3.1 partitionBaseRows body was located", body.length > 0);
  check("3.2 partitionBaseRows does NOT call chainOf", !/chainOf\s*\(/.test(body));
  check('3.3 partitionBaseRows tests the literal `=== "base"`', /r\.chain\s*===\s*"base"/.test(body));
}

// ── 4. the producers are typed narrowly (this is what lets tsc catch it) ─────
check(
  "4.1 baseQuoteToSnapshot returns BaseTickerSnapshot",
  /export function baseQuoteToSnapshot\([\s\S]*?\):\s*BaseTickerSnapshot\s*\{/.test(pollerCode),
);
check(
  "4.2 baseErrorRow returns BaseTickerSnapshot",
  /function baseErrorRow\([\s\S]*?\):\s*BaseTickerSnapshot\s*\{/.test(pollerCode),
);
check(
  "4.3 pollBaseStocks returns Promise<BaseTickerSnapshot[]>",
  /export async function pollBaseStocks\([^)]*\):\s*Promise<BaseTickerSnapshot\[\]>/.test(pollerCode),
);
check(
  "4.4 no Base producer is still declared with the WIDE TickerSnapshot",
  !/\):\s*TickerSnapshot\s*\{/.test(pollerCode) &&
    !/:\s*Promise<TickerSnapshot\[\]>/.test(pollerCode),
);
check(
  "4.5 the accumulator inside pollBaseStocks is narrow too",
  /const rows:\s*BaseTickerSnapshot\[\]\s*=/.test(pollerCode),
);
check(
  "4.6 BaseTickerSnapshot requires the literal, not the union",
  /export type BaseTickerSnapshot\s*=\s*TickerSnapshot\s*&\s*\{\s*chain:\s*"base"\s*\}/.test(typesCode),
);
check(
  "4.7 BaseDeskLatest.rows is the narrow type (binds the writer)",
  /rows:\s*BaseTickerSnapshot\[\];/.test(typesCode),
);
check(
  "4.8 TickerSnapshot.chain stays OPTIONAL — the RH desk depends on it",
  /\n\s*chain\?:\s*HoodChain;/.test(typesCode),
);

// ── 5. the read boundary actually uses the check ────────────────────────────
check("5.1 snapshot route imports partitionBaseRows", /import\s*\{\s*partitionBaseRows\s*\}/.test(snapCode));
check("5.2 snapshot route calls it on the KV blob", /partitionBaseRows\(baseLatest\.rows\)/.test(snapCode));
check(
  "5.3 the board renders the ATTRIBUTED rows, not the raw blob",
  /baseRows\s*=\s*split\.attributed;/.test(snapCode) && !/baseRows\s*=\s*baseLatest\.rows;/.test(snapCode),
);
check(
  "5.4 a drop is logged — a silent shortfall is the failure mode being prevented",
  /console\.error\(/.test(snapCode) && /unattributed/.test(snapCode),
);
check(
  "5.5 the drop count is surfaced on the response, not only in logs",
  /unattributed:\s*baseUnattributed,/.test(snapCode),
);
// 5.6/5.7 — the first draft of this pair was ONE check comparing the index of
// `BASE_ROWS_MAX_AGE_MS` against the partition call. That is a tautology: the
// first occurrence of that string is its own `const` declaration at the top of
// the file, which is above everything, so the check stayed green with the gate
// replaced by `if (true)`. Mutation found it; it was not found by reading.
// What is load-bearing is the COMPARISON and its position, so test those.
{
  const gate = snapCode.indexOf("ageMs <= BASE_ROWS_MAX_AGE_MS");
  const part = snapCode.indexOf("partitionBaseRows(baseLatest.rows)");
  check("5.6 the age COMPARISON is present (not merely the constant)", gate > 0);
  check(
    "5.7 the freshness gate is in front of the partition (stale rows never reach it)",
    gate > 0 && part > 0 && gate < part,
  );
}

// ── 6. type-level: the narrow type is genuinely narrower ────────────────────
// A compile-time claim needs a compile-time witness. These assignments are the
// witness: the file would not typecheck if `BaseTickerSnapshot` accepted a row
// without the marker, so `npx tsc --noEmit` failing here IS the assertion.
{
  const ok: BaseTickerSnapshot = { ...baseRow("NVDA"), chain: "base" };
  check("6.1 a marked row satisfies BaseTickerSnapshot", ok.chain === "base");
  // @ts-expect-error — a row without `chain` must NOT satisfy BaseTickerSnapshot.
  // If this stops erroring, the narrowing is gone and tsc removes the `@ts-expect-error`
  // as unused, which fails the build. That is the check.
  const bad: BaseTickerSnapshot = bareRow("NVDA");
  check("6.2 an unmarked row is rejected by BaseTickerSnapshot (see @ts-expect-error)", bad !== null);
  // @ts-expect-error — an RH row must not satisfy it either.
  const rh: BaseTickerSnapshot = rhRow("NVDA");
  check("6.3 an RH row is rejected by BaseTickerSnapshot (see @ts-expect-error)", rh !== null);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
