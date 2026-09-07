/**
 * Every card that SPENDS reads its balance through one hook, gates on the
 * three-outcome verdict, and writes no token's scale down.
 *
 * ─── Why this guard, and why it derives its own inputs ───────────────────────
 *
 * MEASURED 2026-09-07. Three chat cards move real funds on Robinhood Chain
 * (4663) and Base (8453) — send, swap, bridge. All three had hand-rolled the
 * same balance read, and all three had it wrong the same two ways:
 *
 *   ① the amount guard was `balance != null && amt > balance`, which is FALSE
 *      when the read FAILED, so an unreadable balance ENABLED the confirm
 *      button and sent the user to pay gas for a transaction that cannot
 *      settle — fail-open, in the one place a gate exists to fail closed;
 *
 *   ② the token's decimals were written down as `18` rather than read. USDG is
 *      6 (`0x5fc5…d168`) and it is Robinhood Chain's cash token, so a wallet
 *      holding 1,000 USDG read as 0.000000000001: "swap all my USDG" resolved
 *      to dust, and any real amount tripped the over-balance guard so the
 *      button said "Insufficient balance" and was DISABLED on a wallet that
 *      held plenty.
 *
 * The swap card had ALREADY FOUND ② and fixed one copy — the one at prepare
 * time, whose own comment says "Hardcoding 18 was a real bug: USDG has 6
 * decimals". Ninety lines above it, the copy that decides whether the button is
 * even clickable kept the bug for months. That is the whole reason this file
 * exists: the fix has to have one address, and a second copy has to be
 * impossible to add quietly.
 *
 * ─── Two properties, both derived ────────────────────────────────────────────
 *
 * A guard written as "check these three files for these three strings" would
 * be obsolete the day a fourth card lands, and its author would never know.
 * So nothing here is hand-listed:
 *
 *   THE FILE SET IS DERIVED. A "spender" is any chat component that both reads
 *   a balance and signs a transaction — `useSendTransaction`/`useWriteContract`
 *   together with a balance read. That is the SHAPE of the bug, not a name, so
 *   a fourth card cannot dodge the guard by being called something else.
 *
 *   THE DECIMALS ASSERTION IS DERIVED. It does not count occurrences of `18`
 *   and compare to a number someone tallied by hand — a tally goes stale on the
 *   first edit and its staleness looks like a pass. It asserts the digit does
 *   not survive `code()` AT ALL. `18` is not a magic constant a money card is
 *   entitled to; every scale must come from `decimals()` on the token, from
 *   `useBalance`'s own response, or from the chain's `nativeCurrency`.
 *
 * ─── On the exclusion list ───────────────────────────────────────────────────
 *
 * One known-unfixed spender is excluded by name (see EXCLUDED). The exclusion
 * is SELF-RETIRING: the guard asserts an excluded file still FAILS the checks,
 * so the day someone fixes it the guard fails with "exclusion is stale". An
 * exclusion that outlives its reason is the thing this repo keeps getting
 * bitten by — see the header of scripts/run-tests.ts on opt-out discovery, and
 * CLAUDE.md's rule that a staleness timer would have protected Blue Sentinel
 * through the entire window it was leaking a secret.
 *
 * Hermetic: reads source off disk, no network, no KV. Auto-discovered by
 * `npm test` via the `-check.ts` suffix.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const DIR = "src/app/chat/components";

let pass = 0;
const failures: string[] = [];
function check(name: string, cond: boolean) {
  if (cond) pass++;
  else failures.push(name);
}

// ── strip(): source with comments and regexes removed ───────────────────────
/**
 * Return only the parts of `src` that EXECUTE.
 *
 * Mandatory before any "this token must NOT appear" assertion, for a reason
 * this repo has already paid for once: `archive-watch-check.ts` had a negative
 * check fail against a file that was clean, because the forbidden token
 * appeared in the comment explaining why it was absent. A negative source check
 * that sees comments is testing the documentation.
 *
 * Regex literals are tracked because of a specific false NEGATIVE: a regex like
 * /https?:\/\// ends in `/` `/`, which a naive scanner reads as the start of a
 * line comment and then eats the rest of the line — hiding anything after it.
 * The regex-position heuristic (a `/` following an operator or an opener starts
 * a regex, a `/` following a value is division) is the standard one and is
 * exact for the code in this directory.
 *
 * `dropStrings` produces the SECOND view, and the split is not a nicety — the
 * first draft of this guard had only the stripped-strings view and was wrong in
 * both directions at once:
 *
 *   - FALSE POSITIVE: `gate === "ok"` is a requirement whose whole payload is a
 *     string. With strings gone the file reads `gate ===` and the check failed
 *     on all three cards, which were correct.
 *   - FALSE NEGATIVE, and this is the one that mattered: a hand-rolled read
 *     writes `functionName: "balanceOf"` — a STRING. With strings gone,
 *     `!/balanceOf/` passed on precisely the code it exists to forbid.
 *
 * So: strings are KEPT by default, because the shape requirements are written
 * in them. They are dropped ONLY for the bare-number assertion, where the false
 * positives are cosmetic (`text-[18px]`, `p-18` and friends fill these cards)
 * and no scale is ever expressed as a string.
 */
function strip(src: string, dropStrings = false): string {
  let out = "";
  let i = 0;
  // The last character emitted that was not whitespace — decides `/` ambiguity.
  let prevSignificant = "";
  const VALUE_END = /[)\]}A-Za-z0-9_$]/; // a `/` after one of these is division

  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      const litStart = i;
      let interpolated = "";
      i++;
      while (i < src.length) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === quote) { i++; break; }
        // A template's ${...} holds real code — keep scanning it as code so a
        // violation cannot hide inside an interpolation.
        if (quote === "`" && src[i] === "$" && src[i + 1] === "{") {
          let depth = 1;
          i += 2;
          const start = i;
          while (i < src.length && depth > 0) {
            if (src[i] === "{") depth++;
            else if (src[i] === "}") depth--;
            if (depth > 0) i++;
          }
          interpolated += ` ${strip(src.slice(start, i), dropStrings)} `;
          i++; // past the closing }
          continue;
        }
        i++;
      }
      // Keeping strings: emit the literal verbatim — interpolations included, so
      // they are covered either way. Dropping: emit ONLY the interpolated code,
      // so a violation still cannot hide inside a `${...}`.
      out += dropStrings ? `${interpolated} ` : src.slice(litStart, i);
      prevSignificant = ")"; // a string is a value: a following `/` is division
      continue;
    }
    if (c === "/" && !VALUE_END.test(prevSignificant)) {
      // Regex literal. Skip to the unescaped closing slash, then its flags.
      i++;
      let inClass = false;
      while (i < src.length) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === "[") inClass = true;
        else if (src[i] === "]") inClass = false;
        else if (src[i] === "/" && !inClass) { i++; break; }
        else if (src[i] === "\n") break; // unterminated — bail rather than eat the file
        i++;
      }
      while (i < src.length && /[a-z]/.test(src[i])) i++;
      out += " ";
      prevSignificant = ")";
      continue;
    }

    out += c;
    if (!/\s/.test(c)) prevSignificant = c;
    i++;
  }
  return out;
}

/** Executing source with string literals INTACT — the shape checks live in them. */
const code = (src: string) => strip(src);
/** …and without them — read ONLY by the bare-number assertion. */
const codeNoStrings = (src: string) => strip(src, true);

/** The two views of one file. Every predicate below declares which it needs. */
interface View {
  /** Comments and regexes gone, strings kept. */
  code: string;
  /** Strings gone too. Only for "this number must not appear". */
  noStrings: string;
}
const view = (src: string): View => ({ code: code(src), noStrings: codeNoStrings(src) });

// ── the spender set, derived from the shape of the bug ──────────────────────

const SIGNS = /use(?:SendTransaction|WriteContract)\b/;
const READS_BALANCE = /useBalance\b|balanceOf|useSpendableBalance\b/;

/**
 * Known spenders that still carry the bug, each with the task that closes it.
 * The guard asserts each of these still FAILS, so the entry cannot outlive the
 * defect it documents.
 */
const EXCLUDED: Record<string, string> = {
  "ToolCards.tsx":
    "task #216 — the Base SendCard (~line 2337) has the same fail-open guard " +
    "plus a MAX button that silently no-ops on a failed read. Not a copy-paste " +
    "of the RH fix: it has an editable amount, so the MAX path needs its own " +
    "honest behaviour on `unverified`.",
};

const componentDir = join(ROOT, DIR);
const sources = new Map<string, View>();
for (const f of readdirSync(componentDir)) {
  if (!/\.tsx?$/.test(f)) continue;
  sources.set(f, view(readFileSync(join(componentDir, f), "utf8")));
}

const allSpenders = [...sources.entries()]
  .filter(([, v]) => SIGNS.test(v.code) && READS_BALANCE.test(v.code))
  .map(([f]) => f)
  .sort();

const spenders = allSpenders.filter((f) => !(f in EXCLUDED));

// ── the per-spender checks ──────────────────────────────────────────────────

/** Every requirement a spending card must meet, as (label, predicate). */
const REQUIREMENTS: Array<[string, (v: View) => boolean]> = [
  // ONE read. `useSpendableBalance` returns loading/received/failed separately,
  // which is what makes "still reading" distinguishable from "could not read".
  ["reads its balance through useSpendableBalance", (v) => /useSpendableBalance\s*\(/.test(v.code)],
  // ...and therefore does NOT hand-roll one beside it. Reads `v.code`, WITH
  // strings: a hand-rolled read spells the method `functionName: "balanceOf"`,
  // so on the stripped view this check passed on the very code it forbids.
  ["does not hand-roll a balance read", (v) => !/useBalance\s*\(/.test(v.code) && !/balanceOf/.test(v.code)],
  // THREE outcomes, from the shared module — not a local ternary.
  ["derives its gate with resolveSpend", (v) => /resolveSpend\s*\(/.test(v.code)],
  // Fail-CLOSED: the confirm requires a verdict of ok, not merely "not over".
  ['gates its confirm on gate === "ok"', (v) => /gate\s*===\s*"ok"/.test(v.code)],
  // The admission AND the way out. `UnverifiedBalance` types `onRetry` as
  // REQUIRED, so rendering it is TypeScript-proof that a retry exists — this
  // check only has to prove it is rendered at all.
  ["renders <UnverifiedBalance> when the read failed", (v) => /<UnverifiedBalance\b/.test(v.code)],
  // The whole point of the decimals half: no scale is written down anywhere.
  // The ONE check that reads the stripped view — `text-[18px]` is everywhere.
  ["writes no decimals literal (no bare 18 in code)", (v) => !/\b18\b/.test(v.noStrings)],
];

// ── group 1: the derivation itself is sound ─────────────────────────────────

// A floor, not a tally: if the shape-detector ever stops matching, the suite
// would otherwise pass with zero files checked and report "all green".
check(
  `1.1 the spender detector finds cards (found ${allSpenders.length}: ${allSpenders.join(", ") || "none"})`,
  allSpenders.length >= 4,
);
check(
  `1.2 at least three spenders are in scope (in scope: ${spenders.join(", ") || "none"})`,
  spenders.length >= 3,
);
// The three cards the money actually moves through, named so a rename or a
// deletion is visible rather than silently shrinking the set.
for (const f of ["RobinhoodSendCard.tsx", "RobinhoodSwapCard.tsx", "RobinhoodBridgeCard.tsx"]) {
  check(`1.3 ${f} is detected as a spender`, spenders.includes(f));
}

// ── group 2: every in-scope spender meets every requirement ─────────────────

for (const f of spenders) {
  const v = sources.get(f)!;
  for (const [label, ok] of REQUIREMENTS) check(`2 · ${f} — ${label}`, ok(v));
}

// ── group 3: the shared module keeps its shape ──────────────────────────────

const hookView = view(readFileSync(join(componentDir, "useSpendableBalance.ts"), "utf8"));
const hookSrc = hookView.code;
check("3.1 the hook writes no decimals literal either", !/\b18\b/.test(hookView.noStrings));
// The hook must expose all four signals plus the way out; a caller cannot fail
// closed on signals the hook does not give it.
for (const field of ["balance", "decimals", "loading", "received", "failed", "refetch", "refetching"]) {
  check(`3.2 the hook exposes \`${field}\``, new RegExp(`\\b${field}\\b`).test(hookSrc));
}
// `refetching` must be DERIVED from the queries, never a stored flag — a stored
// flag is the copy left true when a refetch throws.
check(
  "3.3 `refetching` is derived from the queries, not stored in state",
  /refetching:\s*qs\.some\(/.test(hookSrc) && !/useState[^\n]*refetch/i.test(hookSrc),
);

const partsSrc = code(readFileSync(join(componentDir, "ConfirmCardParts.tsx"), "utf8"));
// A gate with no way out is a broken card, so the prop is required at the type
// level. If this ever becomes `onRetry?:` the compiler stops enforcing it.
check(
  "3.4 UnverifiedBalance requires onRetry (no `?`), so the way out cannot be dropped",
  /onRetry:\s*\(\)\s*=>\s*void/.test(partsSrc) && !/onRetry\?\s*:/.test(partsSrc),
);

// ── group 4: every exclusion still earns its place ──────────────────────────

for (const [f, reason] of Object.entries(EXCLUDED)) {
  const present = existsSync(join(componentDir, f));
  check(`4.1 excluded file ${f} still exists (else delete the entry)`, present);
  if (!present) continue;
  check(`4.2 ${f} is still detected as a spender`, allSpenders.includes(f));
  const v = sources.get(f)!;
  const stillBroken = REQUIREMENTS.some(([, ok]) => !ok(v));
  check(
    `4.3 exclusion for ${f} is NOT stale — it still fails at least one requirement (${reason.slice(0, 60)}…)`,
    stillBroken,
  );
}

// ── group 5: the stripper is not silently vacuous ───────────────────────────
//
// Every negative check above is only as strong as the stripper. If it ever
// over-strips, the "no 18" assertions pass on a file full of eighteens — and if
// it over-strips the OTHER view, the shape checks fail on correct code (5.12)
// or, far worse, pass on broken code (5.13). Both directions are tested.
check("5.1 line comments are stripped", !/18/.test(codeNoStrings("// 18\nconst a = 1;")));
check("5.2 trailing line comments are stripped", !/18/.test(codeNoStrings("const a = 1; // 18")));
check("5.3 block comments are stripped", !/18/.test(codeNoStrings("/* 18 */ const a = 1;")));
check("5.4 string literals are stripped", !/18/.test(codeNoStrings('const a = "text-[18px]";')));
check("5.5 template literals are stripped", !/18/.test(codeNoStrings("const a = `p-18`;")));
check("5.6 code SURVIVES", /formatUnits\(x, d\)/.test(codeNoStrings("const a = formatUnits(x, d);")));
check("5.7 a real violation survives", /\b18\b/.test(codeNoStrings("const a = formatUnits(x, 18);")));
check(
  "5.8 a violation inside a template interpolation survives",
  /\b18\b/.test(codeNoStrings("const a = `bal ${formatUnits(x, 18)}`;")),
);
check(
  "5.9 a regex ending in an escaped slash does not eat the line",
  /\b18\b/.test(codeNoStrings("const re = /https?:\\/\\//; const a = formatUnits(x, 18);")),
);
check(
  "5.10 division is not mistaken for a regex",
  /\b18\b/.test(codeNoStrings("const a = b / c; const d = formatUnits(x, 18);")),
);
check("5.11 an apostrophe inside a comment does not swallow code",
  /\b18\b/.test(codeNoStrings("// don't\nconst a = formatUnits(x, 18);")));

// 5.12 and 5.13 are regressions. The first version of this guard had ONE view,
// with strings stripped, and it was wrong in both directions at once — 5.12
// failed three correct cards, and 5.13 is the one that would have shipped: the
// no-hand-rolled-read check passing on a hand-rolled read.
check(
  "5.12 a requirement written as a string literal survives `code()`",
  /gate\s*===\s*"ok"/.test(code('const canSend = gate === "ok" && !busy;')),
);
check(
  "5.13 a hand-rolled balanceOf spelled as a STRING is still caught",
  /balanceOf/.test(code('useReadContract({ functionName: "balanceOf" })')),
);
// …and the comment holding it is still not evidence, in either view.
check(
  "5.14 `balanceOf` named in a comment is NOT counted as a hand-rolled read",
  !/balanceOf/.test(code("// we no longer call balanceOf here\nconst a = 1;")),
);

// ── report ──────────────────────────────────────────────────────────────────

for (const f of failures) console.log(`  FAIL  ${f}`);
console.log(`\nspend-gate-check: ${pass}/${pass + failures.length} passed`);
if (failures.length > 0) {
  console.log(
    `\n${failures.length} FAILED.\n` +
      "A card that spends must read its balance through useSpendableBalance, derive\n" +
      "its gate with resolveSpend, block on `gate === \"ok\"`, render <UnverifiedBalance>\n" +
      "with a retry, and contain no decimals literal. See useSpendableBalance.ts and\n" +
      "resolveSpend in src/lib/wallet/read-state.ts for what each of those means.",
  );
  process.exit(1);
}
