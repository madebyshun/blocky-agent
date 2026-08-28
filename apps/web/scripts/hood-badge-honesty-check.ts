/**
 * Blue Hood — regression guard: the board never claims a frozen oracle.
 *
 * WHY THIS EXISTS
 * ---------------
 * `FROZEN_ALIGNED` is a MARKET-CLOCK verdict — market closed, |drift| inside
 * the closed-session aligned band. The board used to render it as the literal
 * word "FROZEN" whenever the session was not the weekend, which converts a
 * clock reading into an assertion about the Chainlink feed. On a weekday
 * off-hours the feed may well have printed since the close, so the badge was
 * stating as fact something it had never measured.
 *
 * The pre-existing staleness flag cannot catch it: `feed_is_stale` fires at 2×
 * the 86400s heartbeat (>48h) and forces `can_fire=false` → INSUFFICIENT_DATA
 * in `base-poller.ts`. Every row that still carries FROZEN_ALIGNED therefore
 * has a round younger than 48h *by construction*. That gate detects an outage;
 * it cannot separate "frozen since the 16:00 close" from "printing normally".
 *
 * WHAT IT CHECKS
 * --------------
 * Groups 1-3 are REAL behavioural tests. Both functions were deliberately
 * split out of `HoodClient.tsx` into `blue-hood/oracle-age.ts` so that they
 * could be — the badge itself lives in a `"use client"` React tree that no
 * plain tsx script can import, which is why the old inline version was only
 * ever enforced by reading the diff.
 *
 * Group 4 is SOURCE assertions, for the two properties that are not observable
 * from a return value: that the call site actually threads the row's oracle
 * timestamp, and that the retired literal did not come back.
 *
 * Run: npx tsx scripts/hood-badge-honesty-check.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MarketSession } from "../src/lib/blue-hood/types";
import { closedAlignedLabel, oracleRoundAgeText } from "../src/lib/blue-hood/oracle-age";

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

// Exhaustive over the union: if someone adds a sixth MarketSession, this array
// stops type-checking and the new value cannot slip past the sweep below
// unlabelled. `satisfies` keeps the literal types for that check.
const ALL_SESSIONS = [
  "regular",
  "premarket",
  "afterhours",
  "weekend",
  "holiday",
] as const satisfies readonly MarketSession[];
type Covered = (typeof ALL_SESSIONS)[number];
// Compile-time proof the list is COMPLETE, not merely well-typed: if a union
// member is missing, `never` is not assignable and the build fails.
const _exhaustive: Exclude<MarketSession, Covered> extends never ? true : never = true;
void _exhaustive;

// ── 1. the label never asserts a frozen feed ──────────────────────────────
console.log("\n1. closedAlignedLabel — no session produces a claim about the oracle");
for (const s of ALL_SESSIONS) {
  const label = closedAlignedLabel(s);
  check(
    `session "${s}" does not say FROZEN`,
    !/FROZEN/i.test(label),
    `→ "${label}"`,
  );
}
// The two absences and an unknown string must also stay humble — this is the
// arm a future MarketSession value would land in before anyone labels it.
for (const s of [undefined, "", "some_new_session"]) {
  check(
    `session ${JSON.stringify(s)} falls back without claiming FROZEN`,
    !/FROZEN/i.test(closedAlignedLabel(s)),
    `→ "${closedAlignedLabel(s)}"`,
  );
}
check(
  "every label still names what it IS (non-empty, mentions alignment)",
  [...ALL_SESSIONS, undefined].every((s) => /ALIGN/.test(closedAlignedLabel(s))),
  "a blank badge would trade a false claim for no claim",
);
check(
  "holiday is labelled explicitly, not collapsed into the generic fallback",
  closedAlignedLabel("holiday") !== closedAlignedLabel(undefined),
  "it used to fall through `isWeekend === false` and read FROZEN by accident",
);
check(
  "weekend keeps its existing label (this change was scoped to weekdays)",
  closedAlignedLabel("weekend") === "WKND ALIGN",
);

// ── 2. the three states of oracle_updated_at stay three states ────────────
console.log("\n2. oracleRoundAgeText — undefined ≠ null ≠ number");
const NOW = 1_700_000_000_000; // fixed clock; the function takes `now` for this
const tUndef = oracleRoundAgeText(undefined, NOW);
const tNull = oracleRoundAgeText(null, NOW);
const tNum = oracleRoundAgeText(NOW / 1000 - 3600, NOW);
check("all three render differently", new Set([tUndef, tNull, tNum]).size === 3);
check(
  "undefined says NOT RECORDED, not unreadable",
  /not recorded/i.test(tUndef) && !/unreadable/i.test(tUndef),
  `→ "${tUndef}" — RH never records it; claiming a failed read invents an event`,
);
check(
  "null says UNREADABLE, not unrecorded",
  /unreadable|could not be dated/i.test(tNull) && !/not recorded/i.test(tNull),
  `→ "${tNull}" — Base did read the feed; the round just would not date`,
);
check(
  "a real timestamp yields a measured age",
  /1h 0m old/.test(tNum),
  `→ "${tNum}"`,
);
check(
  "no branch smuggles the word 'frozen' back in",
  ![tUndef, tNull, tNum].some((t) => /frozen/i.test(t)),
);
check(
  "NaN/Infinity are treated as unreadable, not rendered as an age",
  oracleRoundAgeText(Number.NaN, NOW) === tNull
    && oracleRoundAgeText(Number.POSITIVE_INFINITY, NOW) === tNull,
  "Number.isFinite guard — an arithmetic age off a NaN prints 'NaNs old'",
);
check(
  "a future round clamps to 0 rather than printing a negative age",
  /^Chainlink round 0s old$/.test(oracleRoundAgeText(NOW / 1000 + 500, NOW)),
);

// ── 3. the age buckets are actually distinct ──────────────────────────────
console.log("\n3. oracleRoundAgeText — the magnitude is readable at every scale");
const buckets: [string, number, RegExp][] = [
  ["seconds", 30, /^Chainlink round 30s old$/],
  ["minutes", 45 * 60, /^Chainlink round 45m old$/],
  ["hours", 6 * 3600 + 12 * 60, /^Chainlink round 6h 12m old$/],
  ["days", 3 * 86400 + 4 * 3600, /^Chainlink round 3d 4h old$/],
];
for (const [name, ageS, re] of buckets) {
  const out = oracleRoundAgeText(NOW / 1000 - ageS, NOW);
  check(`${name} bucket`, re.test(out), `→ "${out}"`);
}

// ── 4. the wiring, which no return value can show ─────────────────────────
console.log("\n4. HoodClient — the row's own timestamp reaches the badge");
const client = read("src/app/app/hood/HoodClient.tsx");
// Assert against CODE, not prose. The comment above the badge deliberately
// quotes the retired literal to explain what was removed and why; a bare
// substring test would read that explanation as the bug itself. Line-level
// stripping is enough for this file's `//` and `/** … */` styles — it is a
// guard, not a parser, and a false PASS here still needs the behavioural
// groups above to also be defeated.
const clientCode = client
  .split("\n")
  .filter((l) => {
    const t = l.trim();
    return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
  })
  .join("\n");
check(
  "the retired literal is gone from the code",
  !/label:\s*isWeekend\s*\?\s*"WKND ALIGN"\s*:\s*"FROZEN"/.test(clientCode)
    && !/"FROZEN"/.test(clientCode),
  "the exact string this guard exists to prevent",
);
check(
  "…and the comment explaining the removal is still there",
  /It used to read literally "FROZEN"/.test(client),
  "the next reader needs to know which claim was retired, and why",
);
check(
  "the badge renders the shared label helper, not a local re-derivation",
  /label:\s*closedAlignedLabel\(session\)/.test(clientCode),
  "a second copy would drift out from under this guard",
);
check(
  "the call site threads the row's oracle timestamp",
  /oracleUpdatedAt=\{r\.oracle_updated_at\}/.test(clientCode),
  "without it every row reads as 'not recorded' and the fix is cosmetic",
);
check(
  "both helpers are imported from the dependency-free module",
  /import \{ closedAlignedLabel, oracleRoundAgeText \} from "@\/lib\/blue-hood\/oracle-age"/.test(clientCode),
);
check(
  "the tooltip is scoped to the FROZEN_ALIGNED arm",
  /verdict === "FROZEN_ALIGNED"\s*\?/.test(clientCode),
  "an unscoped title would put unreviewed wording on every badge",
);
// The prop must stay OPTIONAL and NULLABLE. Narrowing it to `number | null`
// would force the RH call site to invent a `null`, which asserts a failed read
// that never happened — the exact collapse group 2 exists to prevent.
check(
  "the prop keeps both absences representable",
  /oracleUpdatedAt\?:\s*number \| null;/.test(clientCode),
);

console.log(
  failures === 0
    ? `\nALL ${checks} CHECKS PASSED\n`
    : `\n${failures} of ${checks} CHECK(S) FAILED\n`,
);
process.exit(failures === 0 ? 0 : 1);
