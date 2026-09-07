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
 *   THE FILE SET IS DERIVED, over ALL of `src/`. A "spender" is any file that
 *   both reads a balance and signs a transaction — `useSendTransaction`/
 *   `useWriteContract` together with a balance read. That is the SHAPE of the
 *   bug, not a name, so a fourth card cannot dodge the guard by being called
 *   something else.
 *
 *   The first version of this file scanned `src/app/chat/components` only. That
 *   directory bound was itself a hand-drawn boundary, and it was WRONG the day
 *   it shipped: widening to `src/` immediately turned up four more spenders
 *   carrying the same defect — the bank Convert card, both swap panels on
 *   /launches, and the Blue Hood sign panel, none of them chat cards. A guard
 *   that derives its predicate but hand-picks its haystack has only moved the
 *   hand-counting somewhere less visible.
 *
 *   THE DECIMALS ASSERTION IS DERIVED. It does not count occurrences of `18`
 *   and compare to a number someone tallied by hand — a tally goes stale on the
 *   first edit and its staleness looks like a pass. It asserts that the SCALE
 *   ARGUMENT of a units conversion contains no numeric literal at all, wherever
 *   that conversion appears. Every scale must come from `decimals()` on the
 *   token, from `useBalance`'s own response, or from the chain's
 *   `nativeCurrency`.
 *
 *   That is narrower than the blanket "no bare 18 anywhere" this file used to
 *   assert, and the narrowing is not a retreat — the blanket version was simply
 *   FALSE outside the three RH cards. `ToolCards.tsx` legitimately contains
 *   thirteen: a token-DEPLOY form whose `min={6} max={18}` and `variant ===
 *   "stablecoin" ? 6 : 18` are choosing the scale of a token that does not
 *   exist yet. Choosing a new token's decimals is not assuming an existing
 *   one's, and a guard that cannot tell those apart gets switched off. What is
 *   forbidden is a scale used to CONVERT — that is the operation the USDG bug
 *   was made of.
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
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");

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
 *
 * Currently EMPTY, and that is the intended resting state — an exclusion is a
 * debt, not a configuration slot. Keys are paths relative to `src/`, because
 * once the walk is repo-wide a bare basename is ambiguous.
 */
const EXCLUDED: Record<string, string> = {};

/** Every .ts/.tsx under `src/`, keyed by its path relative to `src/`. */
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e)) out.push(p);
  }
  return out;
}

const sources = new Map<string, View>();
for (const p of walk(SRC)) {
  sources.set(relative(SRC, p).split(sep).join("/"), view(readFileSync(p, "utf8")));
}

const allSpenders = [...sources.entries()]
  .filter(([, v]) => SIGNS.test(v.code) && READS_BALANCE.test(v.code))
  .map(([f]) => f)
  .sort();

const spenders = allSpenders.filter((f) => !(f in EXCLUDED));

// ── two derived predicates, written as parsers ──────────────────────────────

/**
 * Units conversions whose SCALE argument contains a numeric literal.
 *
 * Balances parens rather than pattern-matching them, because the real code
 * nests: `parseUnits(minOut.toFixed(dec), dec)` has a call inside its first
 * argument and a regex for "second arg" reads the inner `)` as the end of the
 * outer call. Returns the offending snippets so a failure names the line
 * instead of just asserting one exists.
 *
 * Bracket indices are stripped first: `rows[0].decimals` is a member access,
 * not a written-down scale, and its `0` would otherwise read as one.
 */
function literalScaleConversions(src: string): string[] {
  const out: string[] = [];
  const re = /\b(?:format|parse)Units\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const open = m.index + m[0].length - 1;
    let depth = 0, lastComma = -1, i = open;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === "(") depth++;
      else if (c === ")") { depth--; if (depth === 0) break; }
      else if (c === "," && depth === 1) lastComma = i;
    }
    if (depth !== 0 || lastComma < 0) continue; // unbalanced, or a single argument
    const scale = src.slice(lastComma + 1, i).replace(/\[\s*\d+\s*\]/g, "").trim();
    // A legitimate scale is an identifier or a member access and carries no
    // digits at all. This catches the bare `18`, and also `isStable ? 6 : 18`,
    // which a "second arg is exactly \d+" test would wave through.
    if (/(?:^|[^.\w])\d+(?![\w.])/.test(scale)) {
      out.push(`${m[0].trim()}…, ${scale})`);
    }
  }
  return out;
}

/**
 * `useBalance` calls that threw away the difference between "still reading" and
 * "could not read".
 *
 * Only `useBalance` — NOT `useReadContract`. `useBalance` is unambiguously a
 * read of a wallet's balance, so discarding its failure is always the defect.
 * `useReadContract` is not: in `ToolCards.tsx` it reads an Aave position, a
 * vault's share count, and a lending pool's APY, and that last one binds `{ data }`
 * ON PURPOSE with the reason written beside it — it gates nothing, so a failed
 * read honestly degrades to "—". A rule that forced an error signal onto every
 * read would be demanding ceremony there, and a guard that demands ceremony is
 * a guard someone eventually switches off.
 *
 * `isLoading` does NOT count as a failure signal. It is `isPending && isFetching`,
 * so it goes false the instant a query errors — binding it is how a caller ends
 * up treating a failed read as a finished one, which is the bug, not the fix.
 */
const FAILURE_SIGNAL = /\bis(?:Error|Pending|Success)\b|\berror\b|\bstatus\b/;

function discardingBalanceReads(src: string): string[] {
  const out: string[] = [];
  const re = /(?:const|let)\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*useBalance\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const binding = m[1];
    if (binding.startsWith("{")) {
      // Destructured: the signals it kept are right there in the pattern.
      if (!FAILURE_SIGNAL.test(binding)) out.push(`useBalance destructured as ${binding.replace(/\s+/g, " ")}`);
    } else if (!new RegExp(`\\b${binding}\\.(?:isError|isPending|isSuccess|status)\\b`).test(src)) {
      // Bound whole, which keeps the signals reachable — but reachable is not
      // read. Require the file to actually consult one.
      out.push(`\`${binding}\` is bound whole but nothing reads its .isError/.isPending/.status`);
    }
  }
  return out;
}

// ── the per-spender checks ──────────────────────────────────────────────────

/**
 * Every requirement a spending card must meet, as (label, predicate, detail?).
 *
 * `detail` exists because "converts at no written-down scale" is useless as a
 * bare boolean: seven files, some of them two thousand lines, and the failure
 * would say only that one of them contains a literal somewhere. The two parsers
 * already return the offending snippets, so a failure quotes them.
 */
const REQUIREMENTS: Array<[string, (v: View) => boolean, ((v: View) => string[])?]> = [
  // ONE read. `useSpendableBalance` returns loading/received/failed separately,
  // which is what makes "still reading" distinguishable from "could not read".
  ["reads its balance through useSpendableBalance", (v) => /useSpendableBalance\s*\(/.test(v.code)],
  // ...and any read it still does by hand keeps its failure signal. This used
  // to be a flat ban on `useBalance(`/`balanceOf`, which was right for three
  // chat cards and wrong for the wider set: a spender legitimately reads an
  // ALLOWANCE, a GAS balance, and an Aave/Morpho POSITION by hand. The defect
  // was never "you read it yourself" — it was "you discarded the failure."
  [
    "keeps the failure signal on every hand-rolled useBalance",
    (v) => discardingBalanceReads(v.code).length === 0,
    (v) => discardingBalanceReads(v.code),
  ],
  // THREE outcomes, from the shared module — not a local ternary.
  ["derives its gate with resolveSpend", (v) => /resolveSpend\s*\(/.test(v.code)],
  // Fail-CLOSED: the confirm is licensed by the verdict being `ok`, never by
  // the absence of the bad ones. Either polarity satisfies this — `gate !== "ok"`
  // guarding a held-state branch is the same property, and in ReviewSignPanel it
  // is expressed more strongly still, as a `Record<Exclude<SpendGate,"ok">,…>`
  // that turns a new outcome into a compile error. What the check forbids is a
  // file that consults the gate WITHOUT ever naming `"ok"` — i.e. one that
  // enumerates the three bad verdicts and falls through to sign on a fourth.
  ['licenses its confirm on the literal "ok" verdict', (v) => /gate\s*[!=]==\s*"ok"/.test(v.code)],
  // The admission AND the way out. `UnverifiedBalance` types `onRetry` as
  // REQUIRED, so rendering it is TypeScript-proof that a retry exists — this
  // check only has to prove it is rendered at all.
  ["renders <UnverifiedBalance> when the read failed", (v) => /<UnverifiedBalance\b/.test(v.code)],
  // The decimals half. Not "contains no 18" — "converts at no written-down
  // scale". The ONE check that reads the stripped view, because a scale is
  // never a string but `text-[18px]` is everywhere in these files.
  [
    "converts at no written-down scale (every parse/formatUnits reads its decimals)",
    (v) => literalScaleConversions(v.noStrings).length === 0,
    (v) => literalScaleConversions(v.noStrings),
  ],
];

// ── group 1: the derivation itself is sound ─────────────────────────────────

// A floor, not a tally: if the shape-detector ever stops matching, the suite
// would otherwise pass with zero files checked and report "all green". The
// floor is the count measured when the walk went repo-wide (7). It is a floor
// and not an equality on purpose — a new spending card must be ALLOWED to land,
// it just may not land unchecked.
check(
  `1.1 the spender detector finds cards (found ${allSpenders.length}: ${allSpenders.join(", ") || "none"})`,
  allSpenders.length >= 7,
);
check(
  `1.2 every spender found is in scope (in scope ${spenders.length}/${allSpenders.length})`,
  spenders.length >= 7,
);
// The seven files money actually moves through, named so a rename or a deletion
// is visible rather than silently shrinking the set. Full paths relative to
// `src/`, not basenames: once the walk is repo-wide, `SwapCard.tsx` is
// ambiguous between the bank and the chat surfaces.
for (const f of [
  "app/chat/components/RobinhoodSendCard.tsx",
  "app/chat/components/RobinhoodSwapCard.tsx",
  "app/chat/components/RobinhoodBridgeCard.tsx",
  "app/chat/components/ToolCards.tsx",
  "app/app/bank/SwapCard.tsx",
  "app/app/launches/LaunchesClient.tsx",
  "components/blue-hood/ReviewSignPanel.tsx",
]) {
  check(`1.3 ${f} is detected as a spender`, spenders.includes(f));
}

// ── group 2: every in-scope spender meets every requirement ─────────────────

for (const f of spenders) {
  const v = sources.get(f)!;
  for (const [label, ok, detail] of REQUIREMENTS) {
    const passed = ok(v);
    const why = !passed && detail ? ` → ${detail(v).join(" · ")}` : "";
    check(`2 · ${f} — ${label}${why}`, passed);
  }
}

// ── group 3: the shared module keeps its shape ──────────────────────────────

const HOOK = "lib/wallet/useSpendableBalance.ts";
const UNVERIFIED = "components/wallet/UnverifiedBalance.tsx";

const hookView = sources.get(HOOK);
check(`3.0 ${HOOK} exists (it is what every requirement above points at)`, hookView != null);
if (hookView) {
const hookSrc = hookView.code;
// The hook keeps the BLANKET ban the wider set had to give up. That is not an
// inconsistency: this file is ~200 lines of nothing but balance reading. It has
// no deploy form choosing a new token's scale and no Tailwind class with a
// number in it, so here — and only here — every `18` really is a written-down
// decimals, and the strongest available assertion is also the correct one.
check("3.1 the hook writes no decimals literal at all", !/\b18\b/.test(hookView.noStrings));
// The hook must expose every signal plus the way out; a caller cannot fail
// closed on signals the hook does not give it. `applicable` and `raw` are load-
// bearing and easy to lose: `applicable` is how a DISABLED query — which sits at
// isPending forever — is told apart from one that is genuinely still reading,
// and `raw` is the un-rounded integer, without which a caller has to reconstruct
// base units from a float and re-introduces the rounding it just avoided.
for (const field of [
  "applicable", "balance", "raw", "decimals",
  "loading", "received", "failed", "refetch", "refetching",
]) {
  check(`3.2 the hook exposes \`${field}\``, new RegExp(`\\b${field}\\b`).test(hookSrc));
}
// `refetching` must be DERIVED from the queries, never a stored flag — a stored
// flag is the copy left true when a refetch throws.
check(
  "3.3 `refetching` is derived from the queries, not stored in state",
  /refetching:\s*qs\.some\(/.test(hookSrc) && !/useState[^\n]*refetch/i.test(hookSrc),
);
}

const partsView = sources.get(UNVERIFIED);
check(`3.4a ${UNVERIFIED} exists (requirement 5 renders it)`, partsView != null);
if (partsView) {
// A gate with no way out is a broken card, so the prop is required at the type
// level. If this ever becomes `onRetry?:` the compiler stops enforcing it.
check(
  "3.4 UnverifiedBalance requires onRetry (no `?`), so the way out cannot be dropped",
  /onRetry:\s*\(\)\s*=>\s*void/.test(partsView.code) && !/onRetry\?\s*:/.test(partsView.code),
);
}

// ── group 4: every exclusion still earns its place ──────────────────────────

for (const [f, reason] of Object.entries(EXCLUDED)) {
  const present = sources.has(f);
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

// ── group 6: the two parsers are tested in BOTH directions ──────────────────
//
// Requirements 2 and 6 are no longer regexes — they are small parsers, and a
// parser that silently returns `[]` is a check that passes on everything. These
// are the cases that actually appear in the seven spenders, plus the shapes
// that broke the regex versions this replaced.

// literalScaleConversions — must FIRE
check("6.1 a bare literal scale is caught", literalScaleConversions("parseUnits(a, 18)").length === 1);
check(
  "6.2 formatUnits is caught too, not just parseUnits",
  literalScaleConversions("formatUnits(bal, 6)").length === 1,
);
check(
  "6.3 a ternary of two literals is caught (this is the shape a `?? 18` fix leaves behind)",
  literalScaleConversions("parseUnits(a, isStable ? 6 : 18)").length === 1,
);
check(
  "6.4 a literal FALLBACK behind a real source is still caught",
  literalScaleConversions("formatUnits(bal, meta?.decimals ?? 18)").length === 1,
);
// The nesting that defeats a regex: the call in the FIRST argument closes a
// paren before the scale argument begins, so "match up to the first `)`" reads
// `minOut.toFixed(dec)` as the whole call and never sees the scale at all.
check(
  "6.5 a nested call in argument one does not hide the scale",
  literalScaleConversions("parseUnits(minOut.toFixed(18), 18)").length === 1,
);

// literalScaleConversions — must NOT fire
check("6.6 a scale read from the token passes", literalScaleConversions("parseUnits(a, tokenDecimals)").length === 0);
check(
  "6.7 a scale read from the chain definition passes",
  literalScaleConversions("parseUnits(a, chain.nativeCurrency.decimals)").length === 0,
);
check(
  "6.8 a nested call in argument one, with a derived scale, passes",
  literalScaleConversions("parseUnits(minOut.toFixed(outDecimals), outDecimals)").length === 0,
);
// `decimals[0]` is a member access, not a written-down eighteen. Without the
// bracket strip its index reads as a scale and the guard fires on correct code —
// which is how a guard gets switched off.
check(
  "6.9 an array index in the scale expression is not read as a literal",
  literalScaleConversions("formatUnits(raw, decs[0])").length === 0,
);
check(
  "6.10 a one-argument call is not treated as a scale-less violation",
  literalScaleConversions("formatUnits(raw)").length === 0,
);

// discardingBalanceReads — must FIRE
check(
  "6.11 useBalance destructured to data alone is caught",
  discardingBalanceReads("const { data } = useBalance({ address });").length === 1,
);
// The one that matters most: `isLoading` is `isPending && isFetching`, so it is
// FALSE while a query is in its error state. A caller that binds only isLoading
// treats a failed read as a finished one — the original bug, one layer up.
check(
  "6.12 useBalance destructured to data+isLoading is STILL caught (isLoading is not a failure signal)",
  discardingBalanceReads("const { data, isLoading } = useBalance({ address });").length === 1,
);
check(
  "6.13 a whole-bound query nothing ever interrogates is caught",
  discardingBalanceReads("const q = useBalance({ address });\nconst x = q.data?.value;").length === 1,
);

// discardingBalanceReads — must NOT fire
check(
  "6.14 destructuring isError passes",
  discardingBalanceReads("const { data, isError } = useBalance({ address });").length === 0,
);
check(
  "6.15 a whole-bound query whose isPending IS read passes",
  discardingBalanceReads("const q = useBalance({ address });\nconst reading = q.isPending;").length === 0,
);
// Scoped to useBalance on purpose. ToolCards reads an Aave APY with
// `const { data: reserve } = useReadContract(…)` and says beside it that the
// read gates nothing, so a failure honestly degrades to "—". Widening this rule
// to every hook would demand ceremony there for no safety.
check(
  "6.16 useReadContract is out of scope — the rule is about wallet balances",
  discardingBalanceReads("const { data } = useReadContract({ functionName: 'balanceOf' });").length === 0,
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
