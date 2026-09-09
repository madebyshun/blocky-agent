/**
 * pool-anchor-check.ts — #227 / #223 guard.
 *
 * THE RULE IT ENFORCES
 * --------------------
 * A GeckoTerminal pool price is an EXCHANGE RATE, not a share price. `NVDA/USDG`
 * says what a share costs in dollars; `AI/NVDA` says what it costs in AI. So any
 * code that reaches into a `poolsForToken()` result and pulls out ONE pool to
 * represent the token is making a dollar claim, and it may only do that from a
 * pool quoted against a dollar-ish anchor (USDG / WETH on RH, USDC / WETH on Base).
 *
 * Depth is NOT a safety property. A deep pool against a memecoin is still a deep
 * pool. #223 measured RH TSLA reading 39.5× wrong for exactly this reason.
 *
 * WHY THIS GUARD IS STATIC, AND WHY THAT IS THE WHOLE POINT
 * --------------------------------------------------------
 * `scripts/dex-anchor-check.ts` already asks the live provider what pool
 * production picked TODAY. That guard is good and it stays — but it could never
 * have caught #227, and it is important to be precise about why:
 *
 *   MEASURED (2026-09-09, this session): `resolvePrimaryPool`'s unanchored
 *   fallback fired on 0 of the 24 curated HOOD_WATCHLIST tickers, because all 24
 *   happen to have a USDG pool. The defect was 100% latent on live data. A
 *   provider-driven guard would have returned a clean green while the bug sat in
 *   the signing path of two paid handlers.
 *
 * A live guard tests TODAY'S DATA. This one tests the CODE SHAPE, so it fails on
 * the day the bad code is written rather than on the day a token finally shows up
 * whose deepest pool is quoted in something that is not money. That distinction is
 * the difference between catching #227 in review and catching it in a user's
 * `amountOutMinimum`.
 *
 * It is also the first concrete answer to #222 ("missing gate is its own bug
 * family — every detector so far is blind to it"): the thing being detected here
 * is the ABSENCE of a filter, which no output-comparing test can see.
 *
 * WHAT COUNTS AS A VIOLATION
 * --------------------------
 * Selecting a single representative pool — `pools[0]`, `pools[i]`, `pools.find()`,
 * `pools.at()` — off an identifier bound to `poolsForToken(...)`, where that
 * identifier has not been passed through `anchoredPools()`.
 *
 * Iterating, summing, or LISTING all pools is fine and is not flagged: a liquidity
 * tool that enumerates every pool is doing its job. The claim only becomes a lie
 * when one pool is elected to speak for the token's price.
 *
 * TWO ANNOTATIONS, BECAUSE THERE ARE TWO DIFFERENT THINGS
 * -------------------------------------------------------
 * A single "exempt" bucket would file "this is correct" and "this is broken, we
 * just haven't fixed it" under the same word, which is how known-wrong code starts
 * reading as reviewed-and-approved. So:
 *
 *   // anchor-exempt(#NNN): reason   → CORRECT BY DESIGN. Either the site elects a
 *     pool by an explicit anchor predicate (`find(p => …=== WETH)`), or it
 *     legitimately needs unanchored pools: a token→token swap route is a real
 *     route, and USDG's own pools are all quoted against stocks, so anchoring them
 *     would return the empty set.
 *
 *   // anchor-debt(#NNN): reason     → KNOWN WRONG, TRACKED. Same defect as #227
 *     at a different entry point (these reach the provider through
 *     `poolsForToken` directly rather than through `resolvePrimaryPool`). Out of
 *     the filed scope of #227, which named `resolvePrimaryPool` and its five paid
 *     callers. Printed loudly on EVERY run so it cannot quietly become permanent.
 *
 * Both require a task number, so no carve-out is anonymous. This is the ratchet:
 * a NEW unanchored selection cannot be added without either fixing it or typing an
 * annotation someone will see in the diff.
 *
 * PRESENCE ASSERTIONS
 * -------------------
 * An absence-only guard passes trivially if you delete the thing it guards (the
 * lesson from action-card-inventory-check.ts). So this also asserts the anchor
 * machinery still EXISTS and is still wired: `anchoredPools` / `isUsdAnchored`
 * exported, `resolvePrimaryPool` actually calling the filter, and the RH anchor
 * addresses present in `rwa-price.ts`.
 *
 * Those addresses are re-declared HERE on purpose. Importing `ANCHOR_ASSETS` would
 * make the check assert production against production's own definition — a
 * tautology that can never fail. Same reasoning as dex-anchor-check.ts.
 *
 * Hermetic: reads source only. No network, no KV, no secrets.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const SCRIPTS_DIR = path.dirname(path.resolve(process.argv[1]));
const WEB = path.resolve(SCRIPTS_DIR, "..");
const SRC = path.join(WEB, "src");

/** The function whose result means "pools for THIS token" — electing one of these is a price claim. */
const POOL_SOURCE_FN = "poolsForToken";
/** The filter that makes such a selection legitimate. */
const ANCHOR_FN = "anchoredPools";
/** Selecting one element out of a pool list. */
const SELECTORS = new Set(["find", "at"]);
/** List ops that PRESERVE taint — a filtered raw list is still raw. */
const DERIVING = new Set(["filter", "sort", "slice", "map", "concat", "reverse", "toSorted"]);

/** Correct by design. */
const EXEMPT_RE = /anchor-exempt\(#\d+\)/;
/** Known wrong, tracked, out of #227's filed scope. Reported loudly, never silent. */
const DEBT_RE = /anchor-debt\(#\d+\)/;

type Violation = { file: string; line: number; col: number; text: string; kind: string };
type Annotated = { file: string; line: number; note: string };

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === ".next-verify") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** Unwrap `await X`, `(X)`, `X.catch(...)`, `X.then(...)` down to the underlying call. */
function unwrap(node: ts.Expression): ts.Expression {
  let cur = node;
  for (;;) {
    if (ts.isAwaitExpression(cur)) { cur = cur.expression; continue; }
    if (ts.isParenthesizedExpression(cur)) { cur = cur.expression; continue; }
    if (
      ts.isCallExpression(cur) &&
      ts.isPropertyAccessExpression(cur.expression) &&
      (cur.expression.name.text === "catch" || cur.expression.name.text === "then")
    ) { cur = cur.expression.expression; continue; }
    return cur;
  }
}

function callName(node: ts.Expression): string | null {
  const u = unwrap(node);
  if (!ts.isCallExpression(u)) return null;
  if (ts.isIdentifier(u.expression)) return u.expression.text;
  if (ts.isPropertyAccessExpression(u.expression)) return u.expression.name.text;
  return null;
}

/** Accumulated across files — known-wrong sites, printed on every run. */
const debts: Annotated[] = [];

function analyze(file: string): Violation[] {
  const text = readFileSync(file, "utf8");
  if (!text.includes(POOL_SOURCE_FN)) return [];

  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const lines = text.split("\n");
  const raw = new Set<string>();   // bound to poolsForToken(...) — unanchored
  const safe = new Set<string>();  // bound to anchoredPools(...) or derived from it
  const violations: Violation[] = [];

  /** Classify an initializer expression: "raw" | "safe" | null. */
  function classify(init: ts.Expression): "raw" | "safe" | null {
    const name = callName(init);
    if (name === POOL_SOURCE_FN) return "raw";
    if (name === ANCHOR_FN) return "safe";
    // Derived: `X.filter(...)` / `X.sort(...)` inherits X's taint.
    const u = unwrap(init);
    if (ts.isCallExpression(u) && ts.isPropertyAccessExpression(u.expression) && DERIVING.has(u.expression.name.text)) {
      const base = u.expression.expression;
      if (ts.isIdentifier(base)) {
        if (safe.has(base.text)) return "safe";
        if (raw.has(base.text)) return "raw";
      }
    }
    return null;
  }

  // ── pass 1: build taint sets ────────────────────────────────────────────────
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const init = node.initializer;

      // `const [a, pools] = await Promise.all([ f(), poolsForToken(x) ])`
      const u = unwrap(init);
      if (
        ts.isArrayBindingPattern(node.name) &&
        ts.isCallExpression(u) &&
        ts.isPropertyAccessExpression(u.expression) &&
        u.expression.name.text === "all" &&
        u.arguments.length === 1 &&
        ts.isArrayLiteralExpression(u.arguments[0])
      ) {
        const elems = (u.arguments[0] as ts.ArrayLiteralExpression).elements;
        node.name.elements.forEach((bind, i) => {
          if (ts.isBindingElement(bind) && ts.isIdentifier(bind.name) && elems[i]) {
            const cls = classify(elems[i] as ts.Expression);
            if (cls === "raw") raw.add(bind.name.text);
            if (cls === "safe") safe.add(bind.name.text);
          }
        });
      } else if (ts.isIdentifier(node.name)) {
        const cls = classify(init);
        if (cls === "raw") raw.add(node.name.text);
        if (cls === "safe") safe.add(node.name.text);
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);

  // ── pass 2: find single-pool selections on tainted identifiers ──────────────
  /**
   * An annotation counts if it is on the offending line itself, or anywhere in
   * the CONTIGUOUS comment block directly above it.
   *
   * Deliberately not a fixed N-line window. The first version of this used
   * `line - 3` and it silently failed on every real annotation: an honest
   * "why is this wrong" note runs six to nine lines, so the marker sits at the
   * TOP of the block and a short lookback never reaches it. The guard then
   * reported the annotated sites as unannotated — a false positive that would
   * have trained the next reader to distrust the output and pass `--force`.
   *
   * Walking the comment block instead ties the window to what a human reading
   * the diff would consider "the comment on this line", at any length, and
   * stops at the first non-comment line so an annotation cannot leak downward
   * past unrelated code onto a site nobody reviewed.
   */
  const isCommentLine = (l: string | undefined): boolean => {
    if (l === undefined) return false;
    const t = l.trim();
    return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
  };
  const annotation = (line: number): "exempt" | "debt" | null => {
    let start = line;
    while (start > 0 && isCommentLine(lines[start - 1])) start--;
    for (let i = start; i <= line; i++) {
      const l = lines[i];
      if (l === undefined) continue;
      if (EXEMPT_RE.test(l)) return "exempt";
      if (DEBT_RE.test(l)) return "debt";
    }
    return null;
  };

  const record = (node: ts.Node, kind: string) => {
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    const ann = annotation(line);
    if (ann === "exempt") return;
    if (ann === "debt") {
      debts.push({ file: path.relative(WEB, file), line: line + 1, note: (lines[line] ?? "").trim() });
      return;
    }
    violations.push({
      file: path.relative(WEB, file),
      line: line + 1,
      col: character + 1,
      text: (lines[line] ?? "").trim(),
      kind,
    });
  };

  const scan = (node: ts.Node): void => {
    // `pools[0]` / `pools[i]`
    if (ts.isElementAccessExpression(node)) {
      const base = node.expression;
      if (ts.isIdentifier(base) && raw.has(base.text)) {
        record(node, `${base.text}[…] — elects one pool from an unanchored list`);
      } else if (callName(base) === POOL_SOURCE_FN) {
        record(node, `(await ${POOL_SOURCE_FN}(…))[…] — elects one pool inline`);
      }
    }
    // `pools.find(...)` / `pools.at(...)`
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      SELECTORS.has(node.expression.name.text)
    ) {
      const base = node.expression.expression;
      if (ts.isIdentifier(base) && raw.has(base.text)) {
        record(node, `${base.text}.${node.expression.name.text}(…) — elects one pool from an unanchored list`);
      }
    }
    ts.forEachChild(node, scan);
  };
  scan(sf);

  return violations;
}

// ── presence assertions ───────────────────────────────────────────────────────
// Independent copies. See header: importing the production constant would make
// this assert production against itself.
const RH_USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const RH_WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";

function presenceFailures(): string[] {
  const fail: string[] = [];
  const marketPath = path.join(SRC, "lib/robinhood/rwa-market.ts");
  const pricePath = path.join(SRC, "lib/robinhood/rwa-price.ts");

  const market = readFileSync(marketPath, "utf8");
  const price = readFileSync(pricePath, "utf8");

  if (!/export function anchoredPools\b/.test(market)) {
    fail.push("rwa-market.ts no longer exports `anchoredPools` — the anchor filter this guard enforces is gone.");
  }
  if (!/export function isUsdAnchored\b/.test(market)) {
    fail.push("rwa-market.ts no longer exports `isUsdAnchored`.");
  }
  if (!/counterparty_token/.test(market)) {
    fail.push("rwa-market.ts lost `counterparty_token` — the anchor rule must be applied to the COUNTERPARTY side, not `quote_token` (checking `quote_token` alone silently skips every pool where our token is the quote).");
  }

  // resolvePrimaryPool must actually call the filter, not merely have it available.
  const rpp = market.slice(market.indexOf("export async function resolvePrimaryPool"));
  const rppBody = rpp.slice(0, rpp.indexOf("\n}\n") + 1);
  if (rppBody && !rppBody.includes(ANCHOR_FN)) {
    fail.push("`resolvePrimaryPool` no longer calls `anchoredPools` — its unanchored fallback (#227) is back.");
  }
  if (!/RH_PRICE_SOURCE\.anchors/.test(market)) {
    fail.push("rwa-market.ts no longer sources its anchor set from `RH_PRICE_SOURCE.anchors` — the desk reader and the paid handlers can drift apart again (that drift is exactly how #227 survived #435).");
  }

  for (const [label, addr] of [["USDG", RH_USDG], ["WETH", RH_WETH]] as const) {
    if (!price.toLowerCase().includes(addr)) {
      fail.push(`rwa-price.ts no longer lists the RH ${label} anchor ${addr} — the anchor set shrank without this guard's copy being updated.`);
    }
  }
  return fail;
}

// ── run ───────────────────────────────────────────────────────────────────────
const files = walk(SRC);
const violations = files.flatMap(analyze);
const presence = presenceFailures();

const exemptCount = files
  .map((f) => readFileSync(f, "utf8").split("\n").filter((l) => EXEMPT_RE.test(l)).length)
  .reduce((a, b) => a + b, 0);

console.log(`pool-anchor-check — scanned ${files.length} source files`);
console.log(`  unannotated violations:        ${violations.length}`);
console.log(`  correct-by-design exemptions:  ${exemptCount}`);
console.log(`  KNOWN-WRONG (anchor-debt):     ${debts.length}`);

if (debts.length) {
  // Printed on EVERY run, including green ones. A debt that only shows up when
  // something else breaks is a debt that becomes permanent.
  console.log("\n⚠️  KNOWN-WRONG SITES — same defect as #227, different entry point.");
  console.log("   These reach the provider via `poolsForToken` directly, so they never");
  console.log("   passed through `resolvePrimaryPool` and were outside #227's filed scope.");
  console.log("   Each still elects one pool to speak for a token's dollar price.\n");
  for (const d of debts) console.log(`   ${d.file}:${d.line}\n      | ${d.note}`);
}

if (presence.length) {
  console.log("\n🔴 PRESENCE ASSERTION FAILED — the anchor machinery itself is missing:");
  for (const f of presence) console.log(`   - ${f}`);
}

if (violations.length) {
  console.log("\n🔴 UNANCHORED POOL SELECTION — a pool price is an exchange rate, not a share price:");
  for (const v of violations) {
    console.log(`   ${v.file}:${v.line}:${v.col}`);
    console.log(`      ${v.kind}`);
    console.log(`      | ${v.text}`);
  }
  console.log(
    "\n   Fix: pass the list through `anchoredPools()` before electing a pool.\n" +
    "   Or, if this site legitimately needs unanchored pools (token→token routing,\n" +
    "   USDG's own pools), annotate the line:  // anchor-exempt(#NNN): <reason>",
  );
}

if (presence.length || violations.length) process.exit(1);
console.log("\n✅ every single-pool selection is anchored, and the anchor machinery is wired.");
