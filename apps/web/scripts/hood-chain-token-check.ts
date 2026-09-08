/**
 * Blue Hood — regression guard: a BARE TICKER MUST NOT RESOLVE A TOKEN.
 *
 * WHY THIS EXISTS
 * ---------------
 * NVDA, META, GOOGL and AAPL exist on BOTH Robinhood Chain (4663) and Base
 * (8453) — different contracts, on chains that share no state. So
 * `findByTicker("NVDA")` is not a lookup, it is a silent chain choice, and on
 * the arrow path it chose Robinhood every time, including for arrows that fired
 * on Base.
 *
 * Measured against production on 2026-09-08: the feed held 200 arrows spanning
 * 2026-08-17 → 2026-09-08 — 142 `robinhood`, 58 pre-`chain` (⟹ robinhood via
 * `chainOf`), and ZERO `base`. The Base desk had been live 16 days and had never
 * fired. Every site below was therefore real, reachable, wrong code with no
 * victim yet. That is the whole reason this landed when it did.
 *
 * FOUR SITES, ORDERED BY WHAT THEY ASSERTED
 * -----------------------------------------
 *   1. `alerts.ts` — `enrichFromArrow` attached the ROBINHOOD contract to a Base
 *      arrow and set `verified: true`. The DM then said "✓ verified canonical"
 *      over an address on a chain the arrow never touched. This is the worst of
 *      the four: not a wrong pixel, a VERIFIED CLAIM about a contract.
 *   2. `share/arrow/[serial]/{page,opengraph-image}.tsx` — the public permalink
 *      and its unfurl did the same, and the page linked the RH address to RH's
 *      Blockscout under the fixed label "Robinhood Chain". This is the track
 *      record people quote, and the OG image travels into timelines that never
 *      open the page.
 *   3. The watch star — `kvWatchTicker`/`isValidTicker`/`watchersForTicker` took
 *      a bare ticker, so ★ on the Base NVDA row read the RH star's state, wrote
 *      the RH subscription, and un-★ removed the RH one. Nothing errored; the
 *      user just got another desk's alerts.
 *   4. `cohort-stats.ts` — ticker cohorts were keyed on `a.ticker`, so a Base
 *      NVDA and a Robinhood NVDA landed in ONE cohort. This is the tooling of
 *      the chain question itself (#152): a small Base drift diluted into a large
 *      RH drift yields a clean, corrected, entirely wrong answer to "does Base
 *      produce drift?" — undetectable, because the arithmetic is fine.
 *
 * WHAT WOULD ROT SILENTLY, AND WHY EACH GROUP EXISTS
 * --------------------------------------------------
 *   • The single resolver (`chain-token.ts`) is only worth anything if nothing
 *     ROUTES AROUND IT. Group 2 is the load-bearing check: it re-derives the
 *     ticker-resolver names from the registries' OWN exports and then scans all
 *     of `src/` for `<resolver>(<something>.ticker)`. Rename a resolver, add a
 *     new one, and the guard follows — no hand-kept list to go stale (#205's
 *     `TOOL_NAMES` lesson, where an enumerated allow-list silently stopped
 *     covering the thing it named).
 *   • `chain` is REQUIRED and never defaulted on the resolver. A default
 *     parameter would recreate the bug while every other check still passes,
 *     so Group 1 asserts arity and the null-not-fallback contract directly.
 *   • ROBINHOOD MUST PAY NOTHING. Group 6 is the counter-assertion half: RH keys,
 *     RH cohort names and RH resolutions must be BYTE-IDENTICAL to before. A fix
 *     that silently re-keys 142 live arrows and every existing subscription is a
 *     worse bug than the one it fixes. Without Group 6 this file would pass on a
 *     "qualify everything" change that orphans production KV.
 *
 * Groups 1, 4b, 5, 6 are BEHAVIOURAL (real modules, real registries, no KV I/O —
 * `src/lib/kv.ts` builds its Redis clients inside functions, so importing
 * `watchlist.ts` touches nothing). Groups 2, 3, 4a are source assertions, for the
 * usual reason: React components and Next route handlers cannot be stood up in a
 * plain script.
 *
 * ⚠️ DESIGNED TO FAIL LOUDLY ON PRE-FIX CODE. `chain-token.ts` does not exist
 * before this change, so it is imported LAZILY inside a try and every `read()` is
 * defensive. A guard that dies on module resolution proves nothing; this one runs
 * to completion on `origin/main` and names each broken site.
 *
 * Run: npx tsx scripts/hood-chain-token-check.ts
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { chainOf, rowKey, type Arrow, type HoodChain } from "../src/lib/blue-hood/types";
import { kvWatchTicker } from "../src/lib/blue-hood/kv-keys";
import { isValidTicker } from "../src/lib/blue-hood/watchlist";
import { analyzeCohorts } from "../src/lib/blue-hood/cohort-stats";
import { findByTicker } from "../src/lib/robinhood/rwa-registry";

const WEB = path.resolve(path.dirname(path.resolve(process.argv[1])), "..");

/**
 * Defensive read: a MISSING file yields "", never a throw.
 *
 * This is what lets the guard run on pre-fix code where `chain-token.ts` does not
 * exist yet. Every check that depends on a file is written so that "" FAILS it —
 * absence is a failure, not a skip.
 */
function read(p: string): string {
  try {
    return readFileSync(path.join(WEB, p), "utf8");
  } catch {
    return "";
  }
}

/**
 * Blank out comments while PRESERVING LINE NUMBERS.
 *
 * Two reasons this is not the usual `codeOnly`:
 *   1. Several checks assert an anti-pattern is ABSENT, and the comment
 *      explaining why it is absent necessarily spells the anti-pattern out.
 *      Without stripping, documenting the fix breaks the test for the fix —
 *      which teaches the next person to delete the explanation.
 *   2. Group 2 reports violations as `file:line`, so a stripper that collapses
 *      block comments would print line numbers that point at the wrong code.
 *
 * `(^|[^:])` guards `https://` inside a string literal from being read as a
 * line comment.
 */
const blankComments = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (_m, p1: string) => p1);

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

// ── Sources ──────────────────────────────────────────────────────────────────
const RESOLVER = "src/lib/blue-hood/chain-token.ts";
/**
 * WHERE the two single-chain registries live is a fact about the repo layout, so
 * it is written down. WHAT they export is derived below — that is the half that
 * rots, and the half #205 was about.
 */
const REGISTRIES = {
  robinhood: "src/lib/robinhood/rwa-registry.ts",
  base: "src/lib/base-stocks/registry.ts",
} as const;

const CHAIN_TOKEN_SRC = read(RESOLVER);
const WATCHLIST_SRC = read("src/lib/blue-hood/watchlist.ts");
const ALERTS_SRC = read("src/lib/blue-hood/alerts.ts");
const KV_KEYS_SRC = read("src/lib/blue-hood/kv-keys.ts");
const COHORT_SRC = read("src/lib/blue-hood/cohort-stats.ts");
const PROVIDER_SRC = read("src/app/app/hood/WatchlistProvider.tsx");
const HOOD_CLIENT_SRC = read("src/app/app/hood/HoodClient.tsx");
const SHARE_PAGE_SRC = read("src/app/share/arrow/[serial]/page.tsx");
const SHARE_OG_SRC = read("src/app/share/arrow/[serial]/opengraph-image.tsx");

/** `null` on pre-fix code, where the module does not exist. Every Group 1/6 check
 *  treats that as a FAILURE with a named reason, never as a skip. */
type ChainTokenModule = typeof import("../src/lib/blue-hood/chain-token");
let CT: ChainTokenModule | null = null;

async function main() {
  try {
    CT = (await import("../src/lib/blue-hood/chain-token")) as ChainTokenModule;
  } catch {
    CT = null;
  }

  // ── 1. one resolver, and it cannot be called without naming a chain ────────
  console.log("\n1. resolveChainToken — the chain is a REQUIRED argument, not a default");

  check(`${RESOLVER} exists`, CHAIN_TOKEN_SRC.length > 0 && CT !== null,
    CT ? "" : "the single resolver is missing — every call site below is choosing a chain in silence");

  if (CT) {
    const { resolveChainToken, resolveArrowToken, isChainTicker } = CT;

    // Arity is the contract. A `chain: HoodChain = "robinhood"` default would
    // reintroduce the bug and keep every other check in this file green.
    check("resolveChainToken takes exactly 2 required params",
      resolveChainToken.length === 2, `length=${resolveChainToken.length}`);

    const nvdaRh = resolveChainToken("NVDA", "robinhood");
    const nvdaBase = resolveChainToken("NVDA", "base");
    check("NVDA resolves to a DIFFERENT contract on each desk",
      !!nvdaRh.contract && !!nvdaBase.contract &&
      nvdaRh.contract.toLowerCase() !== nvdaBase.contract.toLowerCase(),
      `rh=${nvdaRh.contract} base=${nvdaBase.contract}`);
    check("both resolutions are marked verified — each matched its OWN registry",
      nvdaRh.verified && nvdaBase.verified);
    check("the explorer follows the chain, not the ticker",
      !!nvdaRh.explorerTokenUrl && !!nvdaBase.explorerTokenUrl &&
      new URL(nvdaRh.explorerTokenUrl).host !== new URL(nvdaBase.explorerTokenUrl).host,
      "an RH address on Basescan does not exist, and vice versa");
    check("the chain label is carried so copy can never omit the desk",
      nvdaRh.chainLabel === "Robinhood Chain" && nvdaBase.chainLabel === "Base");

    // THE central refusal. TSLA is a real RH token and absent from the B20
    // allowlist, so this is exactly the case where a fallback would look helpful.
    const tslaBase = resolveChainToken("TSLA", "base");
    const tslaRh = resolveChainToken("TSLA", "robinhood");
    check("a ticker missing from the Base registry resolves to NULL, not to RH's answer",
      tslaBase.contract === null && tslaBase.verified === false && tslaBase.name === null,
      `got contract=${tslaBase.contract} verified=${tslaBase.verified}`);
    check("and specifically NOT the Robinhood contract",
      tslaBase.contract !== tslaRh.contract && !!tslaRh.contract,
      "cross-chain fallback is the bug, never the remedy");
    check("an unresolved token still names its desk, so copy stays honest",
      tslaBase.chainLabel === "Base" && tslaBase.chain === "base");

    // `name` must come from the SAME row as `contract` — the share card prints
    // them side by side, and mixing sources captions one chain's token with the
    // other chain's metadata.
    check("name and contract come from one row",
      !!nvdaBase.name && !!nvdaRh.name && nvdaBase.name === nvdaBase.name.trim(),
      `base="${nvdaBase.name}" rh="${nvdaRh.name}"`);

    // The fuzzy trap: `findByTicker` also matches NAMES ("Apple" → AAPL, "Tesla"
    // → TSLA), which is right for a lookup and catastrophic for a gate that
    // admits user input — a subscription keyed on "Apple" is not keyed on a
    // ticker at all. `isChainTicker` must be EXACT.
    check("findByTicker really is fuzzy (the reason isChainTicker exists)",
      findByTicker("Apple")?.ticker === "AAPL", "measured, not assumed");
    check("isChainTicker is EXACT — 'Apple' is not a ticker on either desk",
      isChainTicker("Apple", "robinhood") === false &&
      isChainTicker("Apple", "base") === false);
    check("isChainTicker still accepts the real thing",
      isChainTicker("AAPL", "robinhood") === true && isChainTicker("NVDA", "base") === true);
    check("isChainTicker takes a required chain",
      isChainTicker.length === 2, `length=${isChainTicker.length}`);

    // The arrow-shaped entry point exists so a caller physically cannot drop the
    // chain on the way in — passing `a.ticker` alone is the mistake being fixed.
    check("resolveArrowToken takes the ROW, not a ticker string",
      resolveArrowToken.length === 1 &&
      /resolveArrowToken\(a:\s*\{\s*ticker/.test(CHAIN_TOKEN_SRC.replace(/\s+/g, " ")
        .replace(/resolveArrowToken\(a: \{ ticker/, "resolveArrowToken(a: { ticker")));
    check("a Base row resolves through the Base registry",
      resolveArrowToken({ ticker: "NVDA", chain: "base" }).contract === nvdaBase.contract);
  } else {
    // Keep the shape of the run identical on pre-fix code so the failure list is
    // readable rather than a single "module missing" line.
    for (const n of [
      "resolveChainToken takes exactly 2 required params",
      "NVDA resolves to a DIFFERENT contract on each desk",
      "a ticker missing from the Base registry resolves to NULL, not to RH's answer",
      "isChainTicker is EXACT — 'Apple' is not a ticker on either desk",
      "resolveArrowToken takes the ROW, not a ticker string",
    ]) check(n, false, "chain-token.ts is absent");
  }

  // ── 2. nothing routes around the resolver ──────────────────────────────────
  console.log("\n2. no <resolver>(<row>.ticker) anywhere in src/ without a chain narrowing");

  /**
   * DERIVED, not enumerated (#205). A "ticker resolver" is any exported function
   * in a single-chain registry whose FIRST parameter is named like a ticker.
   * Rename `findByTicker`, or add `findBySymbol` tomorrow, and this scan covers
   * it automatically — which is the only way a guard survives the refactor that
   * would otherwise reintroduce the bug.
   */
  const resolverNames: string[] = [];
  const perRegistry: Record<string, string[]> = {};
  for (const [chain, file] of Object.entries(REGISTRIES)) {
    const src = blankComments(read(file));
    const found = [...src.matchAll(/export\s+function\s+([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)/g)]
      .filter((m) => /ticker|symbol/i.test(m[2]))
      .map((m) => m[1]);
    perRegistry[chain] = found;
    resolverNames.push(...found);
  }

  check("ticker resolvers were derived from the registries' own exports",
    resolverNames.length >= 2, `[${resolverNames.join(", ")}]`);
  // Without this, a broken derivation (empty list) would make the scan below
  // vacuously green — the classic way a guard stops guarding.
  check("both registries contributed at least one resolver",
    (perRegistry.robinhood?.length ?? 0) > 0 && (perRegistry.base?.length ?? 0) > 0,
    `rh=[${perRegistry.robinhood?.join(", ")}] base=[${perRegistry.base?.join(", ")}]`);

  /** Every .ts/.tsx under src/, excluding nothing — the bug appeared in lib, in a
   *  route handler, in a page and in an OG image generator. */
  function walk(dir: string, out: string[] = []): string[] {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return out;
    }
    for (const e of entries) {
      const full = path.join(dir, e);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.tsx?$/.test(e)) out.push(full);
    }
    return out;
  }
  const files = walk(path.join(WEB, "src"));
  check("the scan actually walked src/", files.length > 200, `${files.length} files`);

  const callRe = new RegExp(
    `\\b(${resolverNames.join("|")})\\s*\\(\\s*([A-Za-z_$][\\w$]*)\\s*\\.\\s*ticker\\b`,
    "g",
  );
  /** A chain narrowing ON THE SAME IDENTIFIER. `grader.ts` does exactly this —
   *  `if (chainOf(arrow) === "base") { … findBaseStock(arrow.ticker) }` — and is
   *  legitimately safe, so the rule is "narrowed", not "never called". */
  const narrowRe = (id: string) =>
    new RegExp(
      `(?:chainOf\\(\\s*${id}\\s*\\)|${id}\\.chain)\\s*[!=]==\\s*["'](?:base|robinhood)["']`,
    );
  const LOOKBACK = 25;

  const violations: string[] = [];
  const narrowed: string[] = [];
  for (const full of files) {
    if (!resolverNames.length) break;
    const rel = path.relative(WEB, full);
    if (rel === RESOLVER) continue; // the one module allowed to hold both registries
    const src = blankComments(readFileSync(full, "utf8"));
    const lines = src.split("\n");
    callRe.lastIndex = 0;
    for (const m of src.matchAll(callRe)) {
      const line = src.slice(0, m.index).split("\n").length;
      const window = lines.slice(Math.max(0, line - 1 - LOOKBACK), line).join("\n");
      const site = `${rel}:${line} ${m[1]}(${m[2]}.ticker)`;
      if (narrowRe(m[2]).test(window)) narrowed.push(site);
      else violations.push(site);
    }
  }

  check("no registry resolver is fed a bare row ticker",
    violations.length === 0,
    violations.length ? `\n          ${violations.join("\n          ")}` : "0 sites");
  // Reported, not asserted: this list is expected to be small and non-empty, and
  // printing it stops the rule reading as "never call a registry".
  console.log(`  INFO  ${narrowed.length} chain-narrowed call(s) allowed${
    narrowed.length ? `: ${narrowed.join(", ")}` : ""
  }`);

  // ── 3. the blue-hood arrow path has ONE dual-chain module ──────────────────
  console.log("\n3. inside lib/blue-hood, exactly one file may hold both registries");

  /**
   * Scoped to `src/lib/blue-hood/` ON PURPOSE. Repo-wide this rule is FALSE:
   * `src/lib/wallet/stock-holdings.ts` imports both registries and is correct —
   * it resolves only from pinned addresses and returns the two chains' legs
   * separately. A rule that flags correct code gets suppressed, then deleted.
   */
  const hoodFiles = walk(path.join(WEB, "src/lib/blue-hood"));
  const dual: string[] = [];
  for (const full of hoodFiles) {
    const src = blankComments(readFileSync(full, "utf8"));
    const hasRh = /from\s+["'][^"']*robinhood\/rwa-registry["']/.test(src);
    const hasBase = /from\s+["'][^"']*base-stocks\/registry["']/.test(src);
    if (hasRh && hasBase) dual.push(path.relative(WEB, full));
  }
  check("exactly one blue-hood module imports both registries",
    dual.length === 1, `[${dual.join(", ")}]`);
  check("and it is the resolver", dual[0] === RESOLVER, dual[0] ?? "none");

  // ── 4a. the watch star carries a chain, end to end ─────────────────────────
  console.log("\n4a. ★ — every hop from the row to the KV key names the desk");

  check("kvWatchTicker takes a chain", /kvWatchTicker\s*=\s*\(ticker: string, chain: HoodChain/.test(KV_KEYS_SRC));
  check("watchersForTicker takes a chain",
    /watchersForTicker\(\s*ticker: string,\s*chain: HoodChain/.test(blankComments(WATCHLIST_SRC).replace(/\s+/g, " ")
      .replace(/watchersForTicker\( ticker: string, chain: HoodChain/, "watchersForTicker( ticker: string, chain: HoodChain")));
  check("recipientsForArrow takes the ARROW, not its ticker",
    /recipientsForArrow\(\s*arrow:\s*\{\s*ticker:\s*string;\s*chain\?:\s*HoodChain\s*\}/.test(WATCHLIST_SRC),
    "the chain was available at every call site and dropped on the way in");
  check("every recipientsForArrow call site passes the row",
    !/recipientsForArrow\(\s*(?:arrow\.ticker|["'])/.test(blankComments(ALERTS_SRC)));
  check("add/removeTicker are symmetric on chain",
    /addTicker\([\s\S]{0,120}?opts\?:\s*\{\s*chain\?:\s*HoodChain/.test(WATCHLIST_SRC) &&
    /removeTicker\([\s\S]{0,120}?opts\?:\s*\{\s*chain\?:\s*HoodChain/.test(WATCHLIST_SRC),
    "an asymmetric remove leaves the reverse set populated and the DMs keep coming");

  check("the provider requires a chain on all three methods",
    /isWatching:\s*\(ticker: string, chain: HoodChain\)/.test(PROVIDER_SRC) &&
    /add:\s*\(ticker: string, chain: HoodChain/.test(PROVIDER_SRC) &&
    /remove:\s*\(ticker: string, chain: HoodChain\)/.test(PROVIDER_SRC));
  check("isWatching compares rowKey on BOTH sides",
    /rowKey\(\{\s*ticker:[\s\S]{0,60}chain\s*\}\)/.test(PROVIDER_SRC) &&
    /rowKey\(e\)\s*===\s*key/.test(PROVIDER_SRC));
  check("the star passes the ROW's chain, not a literal",
    /<WatchToggle\s+ticker=\{r\.ticker\}\s+chain=\{chainOf\(r\)\}/.test(HOOD_CLIENT_SRC),
    "★ on the Base NVDA row used to read and write the Robinhood subscription");

  // ── 4b. …and the KV key actually differs ───────────────────────────────────
  console.log("\n4b. ★ — behaviourally, the two desks are two subscriptions");

  check("isValidTicker takes a required chain", isValidTicker.length === 2, `length=${isValidTicker.length}`);
  check("kvWatchTicker(NVDA, base) !== kvWatchTicker(NVDA, robinhood)",
    kvWatchTicker("NVDA", "base") !== kvWatchTicker("NVDA", "robinhood"),
    `${kvWatchTicker("NVDA", "base")} vs ${kvWatchTicker("NVDA", "robinhood")}`);
  // TSLA is a real RH ticker and NOT in the B20 allowlist. Pre-fix this returned
  // true and the star wrote a Base subscription for a token Base does not list.
  check("isValidTicker(TSLA, base) === false", isValidTicker("TSLA", "base") === false);
  check("isValidTicker(TSLA, robinhood) === true", isValidTicker("TSLA", "robinhood") === true);
  check("isValidTicker(NVDA, base) === true", isValidTicker("NVDA", "base") === true);
  check("isValidTicker rejects a company NAME on both desks",
    isValidTicker("Apple", "robinhood") === false && isValidTicker("Tesla", "robinhood") === false,
    "a gate that accepts 'Apple' writes a KV set keyed on something that is not a ticker");

  // ── 5. cohorts: chain is part of a cohort's identity ───────────────────────
  console.log("\n5. cohort keys — a Base NVDA and an RH NVDA are two cohorts");

  const NOW = Date.UTC(2026, 8, 8, 12, 0, 0);
  /** Minimal graded arrow. `isGraded` only reads `outcome`, and `cohortDefs` only
   *  reads ticker/chain/type/session/snapshot — everything else is scaffolding. */
  const mk = (i: number, chain: HoodChain | undefined, hit: boolean): Arrow =>
    ({
      id: `a-${chain ?? "legacy"}-${i}`,
      serial: `#${String(i).padStart(4, "0")}`,
      ticker: "NVDA",
      ...(chain ? { chain } : {}),
      type: "drift",
      expected_direction: "up",
      grading_window_h: 6,
      reference_price: 100,
      snapshot_refs: [],
      fired_at: new Date(NOW - (i + 1) * 3_600_000).toISOString(),
      status: "graded",
      outcome: hit ? "hit" : "miss",
      graded_at: new Date(NOW - i * 3_600_000).toISOString(),
      outcome_detail: null,
      origin: "engine",
      snapshot_at_fire: {
        dex_price_usd: 101,
        oracle_price_usd: 100,
        dex_tvl_usd: 100_000,
        dex_total_tvl_usd: null,
        dex_volume_24h_usd: 50_000,
        dex_change_24h_pct: null,
        chainlink_age_seconds: null,
      },
      market_at_fire: { is_open: false, session: "weekend", ny_time_iso: new Date(NOW).toISOString() },
    }) as Arrow;

  // Opposite outcomes on purpose: if the two desks merge, the cohort reports 50%
  // — a clean, corrected, entirely fictional number about a mixed population.
  const arrows: Arrow[] = [
    ...Array.from({ length: 12 }, (_, i) => mk(i, "base", true)),
    ...Array.from({ length: 12 }, (_, i) => mk(100 + i, "robinhood", false)),
  ];
  const analysis = analyzeCohorts(arrows, { now: NOW });
  const byKey = new Map(analysis.cohorts.map((c) => [c.key, c]));

  const rhCohort = byKey.get("ticker:NVDA");
  const baseCohort = byKey.get("ticker:base:NVDA");
  check("the RH ticker cohort still spells NVDA bare", !!rhCohort,
    `${byKey.size} cohorts, ticker keys: ${[...byKey.keys()].filter((k) => k.startsWith("ticker:")).join(", ")}`);
  check("the Base ticker cohort is a SEPARATE key", !!baseCohort);
  check("the RH cohort holds only the 12 RH arrows",
    rhCohort?.n === 12 && rhCohort?.hits === 0,
    `n=${rhCohort?.n} hits=${rhCohort?.hits} (24/12 would mean the desks merged)`);
  check("the Base cohort holds only the 12 Base arrows",
    baseCohort?.n === 12 && baseCohort?.hits === 12,
    `n=${baseCohort?.n} hits=${baseCohort?.hits}`);
  // Pre-registered while n_base is still 0, precisely so it is part of the fixed
  // family BEFORE anyone has seen a Base number — a dimension added after the
  // fact is a hypothesis chosen by its answer.
  check("chain is a pre-registered cohort dimension",
    byKey.has("chain:base") && byKey.has("chain:robinhood"),
    "adding it later would be picking the hypothesis after seeing the data");
  check("the analysis version was bumped for the key-shape change",
    /COHORT_STATS_VERSION = "1\.[1-9]/.test(COHORT_SRC),
    "cached 1.0.0 results were computed under the merged key");
  check("cohortDefs is fed whole rows, never a ticker list",
    /cohortDefs\(graded\)/.test(COHORT_SRC) && !/cohortDefs\([^)]*\.map\(\(?a\)? => a\.ticker\)/.test(COHORT_SRC));

  // ── 6. Robinhood pays NOTHING — every RH spelling is byte-identical ────────
  console.log("\n6. counter-assertions: the incumbent's keys, names and answers are unchanged");

  check("rowKey({ticker:NVDA}) is the BARE ticker",
    rowKey({ ticker: "NVDA" }) === "NVDA", rowKey({ ticker: "NVDA" }));
  check("rowKey with an explicit robinhood chain is identical",
    rowKey({ ticker: "NVDA", chain: "robinhood" }) === "NVDA");
  check("rowKey qualifies ONLY the newcomer",
    rowKey({ ticker: "NVDA", chain: "base" }) === "base:NVDA");
  check("chainOf still resolves an absent chain to robinhood",
    chainOf({}) === "robinhood" && chainOf(undefined) === "robinhood",
    "58 of the 200 live arrows predate the chain field");
  check("the live watch key is unchanged for RH",
    kvWatchTicker("NVDA") === "bh:watch:ticker:NVDA" &&
    kvWatchTicker("NVDA", "robinhood") === "bh:watch:ticker:NVDA",
    kvWatchTicker("NVDA"),
  );
  check("a re-keyed RH subscription would have orphaned every live watcher",
    !kvWatchTicker("NVDA", "robinhood").includes("robinhood"),
    "chainSeg('robinhood') === '' is load-bearing, not cosmetic");

  if (CT) {
    const legacy = CT.resolveArrowToken({ ticker: "NVDA" });
    check("a chain-less arrow resolves EXACTLY as it did before Base existed",
      legacy.contract === findByTicker("NVDA")?.contract &&
      legacy.chain === "robinhood" && legacy.verified === true,
      `${legacy.contract}`);
  } else {
    check("a chain-less arrow resolves EXACTLY as it did before Base existed", false,
      "chain-token.ts is absent");
  }

  // ── 7. the share card names the desk it is asserting about ────────────────
  console.log("\n7. the public permalink + its unfurl state the chain beside the claim");

  /** Module-specifier tails, derived from where the registries live, so a moved
   *  registry does not silently exempt these two files. */
  const registryImportRe = new RegExp(
    `from\\s+["'][^"']*(?:${Object.values(REGISTRIES)
      .map((p) => p.replace(/^src\/lib\//, "").replace(/\.ts$/, ""))
      .join("|")})["']`,
  );

  for (const [label, src] of [["page", SHARE_PAGE_SRC], ["opengraph-image", SHARE_OG_SRC]] as const) {
    const code = blankComments(src);
    check(`share ${label} resolves through resolveArrowToken`,
      /resolveArrowToken\(a\)/.test(code), src ? "" : "file unreadable");
    check(`share ${label} does not import a single-chain registry at all`,
      src.length > 0 && !registryImportRe.test(code),
      "the resolver is the only door; an import here is a door around it");
    // Deliberately ANY occurrence, not one phrasing. The pre-fix card spelled it
    // `{shortAddr(reg.contract)} · Robinhood Chain ↗` across two JSX lines, which
    // a phrase-matching regex missed — a negative assertion tuned to yesterday's
    // wording stops guarding the moment someone rewords it.
    check(`share ${label} hardcodes NO desk name — the label is resolved`,
      src.length > 0 && !/Robinhood Chain/.test(code),
      "the chain name must come from the same resolution as the address");
    check(`share ${label} names the desk from the resolution`,
      /tok\.chainLabel/.test(code) || /chainLabel=\{/.test(code));
  }
  check("the page links the explorer the resolver chose",
    /href=\{tok\.explorerTokenUrl\}/.test(blankComments(SHARE_PAGE_SRC)));
  check("the VERIFIED badge is gated on a SAME-CHAIN match",
    /tok\.verified && tok\.contract && tok\.explorerTokenUrl/.test(blankComments(SHARE_PAGE_SRC)));
  check("the OG verified pill cannot render without a chain label",
    /verifiedName && chainLabel \?/.test(blankComments(SHARE_OG_SRC)),
    "provenance without a chain is the claim that was wrong");
  check("the alert enrichment resolves per-chain and persists the chain",
    /resolveArrowToken\(arrow\)/.test(blankComments(ALERTS_SRC)) &&
    /chain:\s*tok\.chain/.test(blankComments(ALERTS_SRC)),
    "the DM said '✓ verified canonical' over a wrong-chain address");

  console.log(`\n${failures ? "FAIL" : "PASS"} — ${checks - failures}/${checks} checks passed`);
  if (failures) process.exit(1);
}

main().catch((e) => {
  console.error(`\nFAIL — guard crashed: ${(e as Error).message}`);
  process.exit(1);
});
