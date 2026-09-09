/**
 * A logo is an identity claim, so it must be resolved per chain — and never
 * borrowed, guessed, or hotlinked.
 *
 * ─── Why this guard exists ───────────────────────────────────────────────────
 *
 * Five bugs in this repo have had one shape: a bare ticker used as if it
 * identified a token (#161, #206, #219, #340, and the counterfeit-TSLAc family
 * in #280). A ticker does not identify a token — chain + address does. NVDA is a
 * different token, pool and price on Base 8453 than on Robinhood Chain 4663.
 *
 * A logo is the sixth instance, and the most persuasive one, because a rendered
 * company mark *looks* like the output of a lookup. MEASURED against the live
 * registries: `RWA_TOKENS` lists 181 stocks, `BASE_STOCKS` lists 7, and all 7 of
 * those are dual-listed. So a resolver keyed by bare ticker would paint a real
 * company's mark onto **174 tickers** the Base desk has never verified — the
 * exact posture that let a counterfeit TSLAc (identical `symbol`, identical
 * `name`, `isB20() == false`) look legitimate.
 *
 * ─── Everything here is DERIVED ──────────────────────────────────────────────
 *
 * No ticker is written down. `hood-chain-token-check` rotted precisely because
 * it hardcoded the literal "TSLA", so its fixtures went stale the moment the
 * registry moved. Every fixture below is computed from the two registries at
 * run time:
 *
 *   • the dual-listed set          — tickers both chains list
 *   • the RH-only set              — the 174-ticker blast radius
 *   • the divergent-name set       — dual-listed tickers whose registries
 *                                    SPELL THE NAME DIFFERENTLY (today: META is
 *                                    "Meta Platforms Inc." on Base and "Meta
 *                                    Platforms" on RH; AMZN is "Amazon.com,
 *                                    Inc." vs "Amazon.com Inc.")
 *
 * That last set is the sharpest instrument in the file. It is the only way to
 * prove a label came from the row's OWN chain rather than from whichever
 * registry happened to be consulted first: for META and AMZN the two answers
 * are different strings, so "resolved against the wrong chain" is observable
 * rather than merely possible. If the registries ever converge on identical
 * names the set empties, and the liveness check below FAILS rather than passing
 * vacuously — an absence check with no liveness guard is decoration (#370).
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { BASE_STOCKS } from "../src/lib/base-stocks/registry";
import { RWA_TOKENS } from "../src/lib/robinhood/rwa-registry";
import {
  resolveStockLogo,
  logoKey,
  STOCK_MARK_SLUGS,
  STOCK_MARK_KEYS,
} from "../src/lib/blue-hood/stock-logo";
import type { HoodChain } from "../src/lib/blue-hood/types";

// ── Harness ──────────────────────────────────────────────────────────────────

let failures = 0;
/** Counted, never hardcoded — a hand-maintained total goes stale the first time
 *  someone adds a check and forgets to bump it. */
let checks = 0;

function check(name: string, cond: boolean, detail = "") {
  checks++;
  if (cond) console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Blank out comments so a scan never matches prose that merely DESCRIBES the
 *  defect — this file's own header names every pattern it forbids. */
const blankComments = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (_m, p1: string) => p1);

const ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

// ── Sources ──────────────────────────────────────────────────────────────────

const LOGO_MODULE = "src/lib/blue-hood/stock-logo.ts";
const MARK_COMPONENT = "src/components/blue-hood/StockMark.tsx";
const HOOD_CLIENT = "src/app/app/hood/HoodClient.tsx";
const MARK_DIR = "public/stocks";

// ── Derived fixtures ─────────────────────────────────────────────────────────

const BASE_BY_TICKER = new Map(BASE_STOCKS.map((s) => [s.ticker, s.name]));
const RH_BY_TICKER = new Map(RWA_TOKENS.map((t) => [t.ticker, t.name]));
const RH_STOCK_TICKERS = RWA_TOKENS.filter((t) => t.kind === "stock").map((t) => t.ticker);

/** Tickers BOTH chains list. */
const DUAL = [...BASE_BY_TICKER.keys()].filter((t) => RH_BY_TICKER.has(t)).sort();
/** Stock tickers RH lists and Base does not — the blast radius. */
const RH_ONLY = RH_STOCK_TICKERS.filter((t) => !BASE_BY_TICKER.has(t)).sort();
/** Dual-listed tickers the two registries name DIFFERENTLY. */
const DIVERGENT = DUAL.filter((t) => BASE_BY_TICKER.get(t) !== RH_BY_TICKER.get(t));

function main() {
  console.log("hood-logo-check — a logo is an identity claim, resolved per chain\n");

  // ── 0. Fixture liveness ────────────────────────────────────────────────────
  // Every group below is a "never happens" assertion. Each one passes trivially
  // if its fixture set is empty, so the sets are proven non-empty FIRST.
  console.log("0. fixture liveness (an empty fixture makes every check below vacuous)");
  check("BASE_STOCKS is non-empty", BASE_BY_TICKER.size > 0, `${BASE_BY_TICKER.size} tickers`);
  check("RWA_TOKENS lists stocks", RH_STOCK_TICKERS.length > 0, `${RH_STOCK_TICKERS.length} stocks`);
  check("there is a dual-listed set", DUAL.length > 0, `${DUAL.length}: ${DUAL.join(", ")}`);
  check(
    "there is an RH-only set — the blast radius a bare-ticker resolver would mark",
    RH_ONLY.length > 0,
    `${RH_ONLY.length} tickers`,
  );
  check(
    "there is a DIVERGENT-NAME set — the only way to observe a cross-chain label",
    DIVERGENT.length > 0,
    DIVERGENT.length
      ? DIVERGENT.map((t) => `${t}: base="${BASE_BY_TICKER.get(t)}" vs rh="${RH_BY_TICKER.get(t)}"`).join(" | ")
      : "registries now agree on every name — this guard can no longer prove chain isolation from labels, ADD ANOTHER DISCRIMINATOR",
  );

  // ── 1. The resolver refuses to guess ───────────────────────────────────────
  console.log("\n1. the resolver refuses to guess");
  const logoSrc = read(LOGO_MODULE);
  const logoCode = blankComments(logoSrc);
  check("the logo module exists and is non-trivial", logoSrc.length > 500, `${logoSrc.length} bytes`);

  check(
    "`resolveStockLogo` takes `chain` as its FIRST parameter",
    /export function resolveStockLogo\(\s*chain:\s*HoodChain\s*,/.test(logoCode),
    "a ticker-only overload is a call site that cannot say which desk it is on",
  );
  check(
    "the module never calls `findByTicker`",
    !/findByTicker/.test(logoCode),
    "it falls back to substring name matching: findByTicker(\"Micro\") returns AMD, not Micron",
  );
  check(
    "the module never calls `rowKey`",
    !/\browKey\b/.test(logoCode),
    "rowKey is BARE for robinhood by design — reusing it would bare-ticker half the mark table",
  );
  check(
    "the module imports NEITHER registry — it goes through `chain-token`",
    !/from\s+["'][^"']*robinhood\/rwa-registry["']/.test(logoCode) &&
      !/from\s+["'][^"']*base-stocks\/registry["']/.test(logoCode),
    "`hood-chain-token-check` allows exactly ONE dual-registry module inside lib/blue-hood; " +
      "a second one is a second place a cross-chain fallback can be written",
  );
  check(
    "`listed` is gated on `isChainTicker`, NOT on `resolveChainToken(...).verified`",
    /isChainTicker\(/.test(logoCode) && !/\.verified\b/.test(logoCode),
    "`verified` runs findByTicker on RH, which also matches NAMES — that is the fuzzy door this gate closes",
  );
  check(
    "no `http` URL anywhere in the module — marks are local files, never a CDN",
    !/https?:\/\//.test(logoCode),
    "a third-party CDN that changes or dies turns a logo into nothing, or into something else",
  );

  // The static checks above say the fuzzy door is shut. These prove it, by
  // feeding the resolver the exact inputs that open it.
  //
  // DERIVED, not hardcoded: `findByTicker` resolves a company NAME on its second
  // branch (exact name) and a name PREFIX on its third (≥3-char substring). So
  // the fixtures are the registry's own names and their first words. Anything
  // that is itself a real ticker is excluded — "Meta" IS META, and resolving it
  // is correct behaviour, not a leak.
  const RH_TICKER_SET = new Set(RWA_TOKENS.map((t) => t.ticker.toUpperCase()));
  const notATicker = (s: string) => !RH_TICKER_SET.has(s.trim().toUpperCase());
  const FUZZY_NAMES = RWA_TOKENS.map((t) => t.name).filter(notATicker);
  const FUZZY_PREFIXES = Array.from(
    new Set(RWA_TOKENS.map((t) => t.name.split(/[\s,]+/)[0]).filter((w) => w.length >= 3)),
  ).filter(notATicker);

  const nameLeaks = FUZZY_NAMES.filter((n) => resolveStockLogo("robinhood", n).listed);
  check(
    `${FUZZY_NAMES.length} company NAMES all resolve UNLISTED on robinhood`,
    nameLeaks.length === 0,
    nameLeaks.length
      ? `LEAKED: ${nameLeaks.slice(0, 5).map((n) => `"${n}"→${resolveStockLogo("robinhood", n).label}`).join(", ")} — the isChainTicker gate is gone, findByTicker's name branch is answering`
      : "findByTicker would resolve every one of these; the exact allow-list does not",
  );

  const prefixLeaks = FUZZY_PREFIXES.filter((w) => resolveStockLogo("robinhood", w).listed);
  check(
    `${FUZZY_PREFIXES.length} name PREFIXES all resolve UNLISTED on robinhood`,
    prefixLeaks.length === 0,
    prefixLeaks.length
      ? `LEAKED: ${prefixLeaks.slice(0, 5).map((w) => `"${w}"→${resolveStockLogo("robinhood", w).label}`).join(", ")}`
      : "the ≥3-char substring pass is unreachable from here",
  );

  const markedFromName = [...FUZZY_NAMES, ...FUZZY_PREFIXES].filter(
    (s) => resolveStockLogo("robinhood", s).mark,
  );
  check(
    "and none of them renders a real company MARK",
    markedFromName.length === 0,
    markedFromName.length
      ? `MARKED FROM A NAME: ${markedFromName.slice(0, 5).join(", ")}`
      : "a logo can never be reached by a name match",
  );

  // ── 2. Chain isolation, measured over the whole registry ───────────────────
  console.log("\n2. chain isolation (every ticker, both directions)");

  const leakedToBase = RH_ONLY.filter((t) => resolveStockLogo("base", t).listed);
  check(
    `all ${RH_ONLY.length} RH-only tickers resolve UNLISTED on base`,
    leakedToBase.length === 0,
    leakedToBase.length ? `LEAKED: ${leakedToBase.slice(0, 8).join(", ")}` : "no ticker borrows the other chain's registry",
  );

  const markedOnBase = RH_ONLY.filter((t) => resolveStockLogo("base", t).mark);
  check(
    `none of the ${RH_ONLY.length} RH-only tickers gets a MARK on base`,
    markedOnBase.length === 0,
    markedOnBase.length ? `MARKED: ${markedOnBase.slice(0, 8).join(", ")}` : "the 174-ticker blast radius is closed",
  );

  const wrongGlyph = RH_ONLY.filter((t) => resolveStockLogo("base", t).monogram !== "?");
  check(
    "an unlisted ticker renders `?`, not its own letters",
    wrongGlyph.length === 0,
    "`?` says \"this chain does not list this\"; the ticker would say \"we know this one\"",
  );

  const notListedBoth = DUAL.filter(
    (t) => !resolveStockLogo("base", t).listed || !resolveStockLogo("robinhood", t).listed,
  );
  check(
    `all ${DUAL.length} dual-listed tickers resolve LISTED on both chains`,
    notListedBoth.length === 0,
    notListedBoth.join(", "),
  );

  // The sharp instrument: for a divergent-name ticker the two chains give
  // DIFFERENT strings, so a label sourced from the wrong registry is visible.
  for (const t of DIVERGENT) {
    check(
      `${t} label on base is Base's spelling, not RH's`,
      resolveStockLogo("base", t).label === BASE_BY_TICKER.get(t),
      `got "${resolveStockLogo("base", t).label}", RH would have said "${RH_BY_TICKER.get(t)}"`,
    );
    check(
      `${t} label on robinhood is RH's spelling, not Base's`,
      resolveStockLogo("robinhood", t).label === RH_BY_TICKER.get(t),
      `got "${resolveStockLogo("robinhood", t).label}", Base would have said "${BASE_BY_TICKER.get(t)}"`,
    );
  }

  // ── 3. Keys are chain-qualified on BOTH chains ─────────────────────────────
  console.log("\n3. keys are chain-qualified on both chains");
  const CHAINS: HoodChain[] = ["robinhood", "base"];
  for (const c of CHAINS) {
    const sample = DUAL[0];
    check(
      `logoKey("${c}", <ticker>) is qualified, unlike rowKey`,
      logoKey(c, sample) === `${c}:${sample}` && logoKey(c, sample) !== sample,
      logoKey(c, sample),
    );
    check(
      `resolveStockLogo("${c}", …).key is qualified`,
      resolveStockLogo(c, sample).key === `${c}:${sample}`,
    );
  }
  const unqualified = STOCK_MARK_KEYS.filter((k) => !CHAINS.some((c) => k.startsWith(`${c}:`)));
  check(
    "every mark-table key names a known chain",
    unqualified.length === 0,
    unqualified.length ? `UNQUALIFIED: ${unqualified.join(", ")}` : `${STOCK_MARK_KEYS.length} keys`,
  );

  // Case + whitespace normalisation must not become a second way to miss.
  const messy = DUAL[0];
  check(
    "lookup normalises case and whitespace",
    resolveStockLogo("base", ` ${messy.toLowerCase()} `).key === `base:${messy}`,
  );

  // ── 4. The mark table asserts nothing the registries do not ────────────────
  console.log("\n4. the mark table asserts nothing the registries do not");
  const stale = STOCK_MARK_KEYS.filter((k) => {
    const [c, t] = k.split(":");
    return c === "base" ? !BASE_BY_TICKER.has(t) : !RH_BY_TICKER.has(t);
  });
  check(
    "every marked ticker is LISTED on the chain it is marked for",
    stale.length === 0,
    stale.length ? `NOT IN REGISTRY: ${stale.join(", ")}` : `${STOCK_MARK_KEYS.length} keys all resolve`,
  );

  // The tripwire. TSLA is marked on RH; when PR #436 admits it to BASE_STOCKS
  // this FAILS and names the missing key, rather than silently showing one
  // company two different ways on two desks.
  const halfMarked = DUAL.filter(
    (t) => resolveStockLogo("base", t).mark !== resolveStockLogo("robinhood", t).mark,
  );
  check(
    "a dual-listed ticker is marked on BOTH chains or NEITHER",
    halfMarked.length === 0,
    halfMarked.length
      ? `HALF-MARKED: ${halfMarked.join(", ")} — same company, two desks, one mark. Add the missing key to MARKS.`
      : `${DUAL.length} dual-listed tickers agree`,
  );

  // ── 5. Every mark is a real local file ─────────────────────────────────────
  console.log("\n5. every mark is a real local file");
  const markDir = join(ROOT, MARK_DIR);
  check(`${MARK_DIR}/ exists`, existsSync(markDir));
  const onDisk = existsSync(markDir)
    ? readdirSync(markDir).filter((f) => f.endsWith(".svg")).map((f) => f.replace(/\.svg$/, "")).sort()
    : [];
  check("there are mark files on disk", onDisk.length > 0, `${onDisk.length} svg`);
  check("the mark table references at least one slug", STOCK_MARK_SLUGS.length > 0, STOCK_MARK_SLUGS.join(", "));

  const missingFile = STOCK_MARK_SLUGS.filter((s) => !onDisk.includes(s));
  check(
    "every slug in the mark table has a file",
    missingFile.length === 0,
    missingFile.length ? `MISSING: ${missingFile.map((s) => `${MARK_DIR}/${s}.svg`).join(", ")}` : "",
  );
  const orphan = onDisk.filter((s) => !STOCK_MARK_SLUGS.includes(s));
  check(
    "no orphan file on disk",
    orphan.length === 0,
    orphan.length ? `ORPHANED: ${orphan.join(", ")} — a mark nothing renders is a mark nobody reviews` : "",
  );

  for (const slug of STOCK_MARK_SLUGS) {
    const p = join(markDir, `${slug}.svg`);
    if (!existsSync(p)) continue;
    const svg = readFileSync(p, "utf8");
    check(`${slug}.svg is a 24×24 single-path mark with a baked fill`,
      /viewBox="0 0 24 24"/.test(svg) &&
        /<path fill="#[0-9A-Fa-f]{6}"/.test(svg) &&
        !/currentColor/.test(svg),
      "baked fill, not currentColor — these render through <img>, which carries no colour",
    );
  }

  // ── 6. The component cannot render a borrowed mark ─────────────────────────
  console.log("\n6. the component cannot render a borrowed mark");
  const markSrc = read(MARK_COMPONENT);
  const markCode = blankComments(markSrc);
  check("the mark component exists and is non-trivial", markSrc.length > 400, `${markSrc.length} bytes`);

  check(
    "`chain` is a REQUIRED prop — no `?`, no default",
    /\bchain:\s*HoodChain;/.test(markCode) && !/\bchain\?\s*:/.test(markCode) && !/chain\s*=\s*"/.test(markCode),
    "chainOf's absent-means-robinhood default is right for legacy KV and wrong here",
  );
  check(
    "the component resolves through `resolveStockLogo(chain, ticker)`",
    /resolveStockLogo\(\s*chain\s*,\s*ticker\s*\)/.test(markCode),
  );
  check(
    "the <img> src is built from the RESOLVED slug, never from a ticker",
    /src=\{`\/stocks\/\$\{logo\.slug\}\.svg`\}/.test(markCode) &&
      !/\/stocks\/\$\{[^}]*ticker/.test(markCode),
    "`/stocks/${ticker}.svg` would be a bare-ticker path — the bug wearing a URL",
  );
  check(
    "the <img> renders only when a mark was actually resolved",
    /logo\.mark && logo\.slug \?/.test(markCode),
    "gate on the resolution, not on truthiness of a string",
  );
  check(
    "the component hotlinks nothing",
    !/https?:\/\//.test(markCode),
  );

  // ── 7. Every use site says which chain ─────────────────────────────────────
  console.log("\n7. every use site says which chain");
  const clientSrc = read(HOOD_CLIENT);
  const clientCode = blankComments(clientSrc);
  const uses = clientCode.match(/<StockMark\b[^>]*>/g) ?? [];
  check("the desk renders StockMark", uses.length > 0, `${uses.length} use site(s)`);
  const chainless = uses.filter((u) => !/\bchain=\{/.test(u));
  check(
    "every StockMark on the desk is passed a chain",
    chainless.length === 0,
    chainless.length ? `CHAINLESS: ${chainless.join(" ")}` : "",
  );
  const notFromRow = uses.filter((u) => !/chain=\{chainOf\(/.test(u));
  check(
    "the chain comes from the ROW via chainOf, not from a constant",
    notFromRow.length === 0,
    notFromRow.length ? `HARDCODED CHAIN: ${notFromRow.join(" ")}` : "",
  );

  console.log(`\n${failures ? "FAIL" : "PASS"} — ${checks - failures}/${checks} checks passed`);
  if (failures) process.exit(1);
}

main();
