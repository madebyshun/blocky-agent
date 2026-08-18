/**
 * Reconcile the COMMITTED RWA registry against ROBINHOOD CHAIN.
 *
 * Read-only. Writes nothing, promotes nothing, and exits non-zero when the
 * registry and the chain disagree — a check that always exits 0 is not a check.
 *
 * ─── Why this file exists ───────────────────────────────────────────────────
 * `rwa-registry.ts` is an address book maintained by humans and consumed by
 * ~30 rh-* tools. A hand-maintained list has exactly one failure mode and it is
 * silent: it stops matching the chain and nothing anywhere raises its hand. By
 * the time this script was written the registry held 26 tokens against 203 real
 * RHJ deployments, and two of the gaps were load-bearing:
 *
 *   • GME was filed under CHAINLINK_ONLY_FEEDS as "token contract not in our
 *     registry yet". The token had been deployed the whole time. Meanwhile the
 *     first GME-named contract a user finds by searching the explorer is an
 *     impersonator with thousands of holders.
 *   • USO was filed under the ticker "CUSO" with a note claiming it had no
 *     Chainlink feed. Both halves were wrong, and the ticker typo made
 *     rh-rwa-verify raise a *false scam alarm on a genuine canonical token*.
 *
 * Neither was a coding bug. Both were the list quietly drifting. So the fix is
 * not "be more careful", it is this script plus a habit of running it.
 *
 * ─── The five invariants ────────────────────────────────────────────────────
 *   1. SHAPE       (offline) unique tickers, unique contracts, every address
 *                  EIP-55 checksummed, no ticker claimed by both RWA_TOKENS and
 *                  CHAINLINK_ONLY_FEEDS. Free, so it runs first and always.
 *   2. PROVENANCE  every `issuer: "RHJ"` row was deployed by RH_RWA_DEPLOYER.
 *                  This is the one an attacker has to beat, and the only token
 *                  property that cannot be forged after deployment — name,
 *                  symbol and decimals are all free to copy. A registry row
 *                  that fails this is worse than a missing row: every rh-* tool
 *                  treats registry membership as a trust signal.
 *   3. METADATA    on-chain symbol() == ticker and decimals() == decimals.
 *                  The CUSO class of bug. Compared exactly, not by substring —
 *                  substring is what let "USO" fail to match "CUSO".
 *   4. COMPLETE    every `Deployed` event the RHJ factory has ever emitted has
 *                  a registry row. This is the drift check — the one that has
 *                  to actually be complete, because every other invariant only
 *                  inspects rows that are already present.
 *
 *                  It reads the factory's own logs rather than scanning the
 *                  token list, because the first version of this check did the
 *                  latter and printed a green "no unlisted RHJ deployments"
 *                  while 107 were missing: Blockscout `/tokens` is ranked by
 *                  market cap and serves a fixed 50-row page (it takes a
 *                  `limit` param and ignores it), so a token with no pool yet
 *                  sorts below the cutoff. A check whose failure mode is
 *                  silently certifying a false invariant is worse than no
 *                  check, and this one had already blessed a 96-row registry
 *                  against a 203-deployment chain.
 *   5. FEEDS       every equity feed Chainlink publishes for RH Chain resolves
 *                  to a registry row carrying that exact proxy address. Catches
 *                  a feed silently attached to the wrong ticker.
 *
 * Invariant 2 needs one Blockscout `/addresses/{hash}` call per token, measured
 * at 2.4–8.8s each, so calls run through a small concurrency pool. Expect
 * ~2–3 minutes. That is the price of checking the thing that actually matters.
 *
 * A null creator is reported as UNVERIFIED, never as a failure: "Blockscout did
 * not answer" and "deployed by someone else" are different claims, and
 * conflating them turns an explorer hiccup into a false accusation.
 *
 * Invariant 3 talks to the RH RPC rather than Blockscout, and the RPC has a much
 * lower ceiling: symbol()+decimals() over 205 rows is ~400 un-batched eth_calls
 * (no Multicall3 on this chain — task #88). It therefore has its own, smaller
 * pool. It also refuses to pass on rows it could not read, which is the reason
 * the two knobs are separate: an unread row is an unchecked row, and this script
 * had already shipped one green tick over 195 of them.
 *
 * Usage:  npm run rwa:verify
 *         RWA_VERIFY_CONCURRENCY=4 npm run rwa:verify       # gentler on Blockscout
 *         RWA_VERIFY_RPC_CONCURRENCY=2 npm run rwa:verify   # gentler on the RPC
 */
import { getAddress } from "viem";
import {
  RWA_TOKENS,
  CHAINLINK_ONLY_FEEDS,
  RH_RWA_DEPLOYER,
  RH_CHAIN,
} from "../src/lib/robinhood/rwa-registry";
import { readErc20Meta } from "../src/lib/robinhood/rwa-price";

const BS = `${RH_CHAIN.explorer}/api/v2`;
const FEEDS_URL =
  "https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json";

const CONCURRENCY = Math.max(1, Math.min(16, Number(process.env.RWA_VERIFY_CONCURRENCY ?? 10)));

let failures = 0;
const fail = (msg: string) => {
  failures++;
  console.log(`  ❌ ${msg}`);
};
const warn = (msg: string) => console.log(`  ⚠️  ${msg}`);
const ok = (msg: string) => console.log(`  ✓  ${msg}`);

/** Run `fn` over `items` with a bounded number of in-flight requests. */
async function pool<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

/**
 * One Blockscout GET, retried once on failure.
 *
 * The retry is not politeness, it is signal quality: at concurrency 10 the
 * explorer rate-limits a handful of calls per run, which surfaced 6 tokens as
 * "creator unknown". Those are reported as UNVERIFIED rather than failures — so
 * the cost of transient 429s isn't a false alarm, it's a quieter check, which
 * over time is the same thing as a check nobody reads. Retrying converts most
 * of them back into real answers. Anything still null after the retry is
 * genuinely unknown and gets said out loud.
 */
async function bs<T>(path: string, timeoutMs = 20_000): Promise<T | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1_500));
    try {
      const res = await fetch(`${BS}${path}`, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: "application/json" },
      });
      if (!res.ok) continue;
      return (await res.json()) as T;
    } catch {
      /* retry */
    }
  }
  return null;
}

const creator = (addr: string) =>
  bs<{ creator_address_hash?: string | null }>(`/addresses/${addr}`).then(
    (d) => d?.creator_address_hash ?? null,
  );

// ── 1. SHAPE ────────────────────────────────────────────────────────────────
function checkShape() {
  console.log("1. SHAPE — offline invariants");

  const seenTicker = new Map<string, string>();
  const seenContract = new Map<string, string>();
  for (const t of RWA_TOKENS) {
    const tk = t.ticker.toUpperCase();
    const prev = seenTicker.get(tk);
    if (prev) fail(`duplicate ticker ${tk}: ${prev} and ${t.contract}`);
    seenTicker.set(tk, t.contract);

    const c = t.contract.toLowerCase();
    const prevC = seenContract.get(c);
    if (prevC) fail(`duplicate contract ${t.contract}: ${prevC} and ${tk}`);
    seenContract.set(c, tk);

    // A non-checksummed address is not wrong on chain, but it defeats every
    // string comparison downstream that forgets to lowercase first.
    let checksummed: string;
    try {
      checksummed = getAddress(t.contract);
    } catch {
      fail(`${tk}: ${t.contract} is not a valid address`);
      continue;
    }
    if (checksummed !== t.contract) {
      fail(`${tk}: contract not EIP-55 checksummed — expected ${checksummed}`);
    }
  }

  for (const f of CHAINLINK_ONLY_FEEDS) {
    if (seenTicker.has(f.ticker.toUpperCase())) {
      fail(
        `${f.ticker} is in BOTH RWA_TOKENS and CHAINLINK_ONLY_FEEDS — ` +
          `the fallback shadows the real row; delete the CHAINLINK_ONLY_FEEDS entry`,
      );
    }
  }

  if (failures === 0) {
    ok(
      `${RWA_TOKENS.length} rows, unique + checksummed; ` +
        `${CHAINLINK_ONLY_FEEDS.length} chainlink-only fallback(s)`,
    );
  }
  console.log();
}

// ── 2. PROVENANCE ───────────────────────────────────────────────────────────
async function checkProvenance(): Promise<Map<string, string | null>> {
  console.log(`2. PROVENANCE — creator == ${RH_RWA_DEPLOYER}`);
  const expect = RH_RWA_DEPLOYER.toLowerCase();

  const creators = await pool(RWA_TOKENS, CONCURRENCY, (t) => creator(t.contract));
  const byContract = new Map<string, string | null>();
  let matched = 0;
  let unverified = 0;

  RWA_TOKENS.forEach((t, i) => {
    const c = creators[i];
    byContract.set(t.contract.toLowerCase(), c);
    const isRhj = t.issuer === "RHJ";

    if (c === null) {
      unverified++;
      // Not a failure. Unknown is not the same as forged.
      warn(`${t.ticker}: creator unknown (Blockscout did not answer) — unverified, not rejected`);
      return;
    }
    if (isRhj && c.toLowerCase() !== expect) {
      fail(
        `${t.ticker} (${t.contract}) claims issuer "RHJ" but was deployed by ${c} — ` +
          `IMPERSONATOR IN THE REGISTRY, remove it`,
      );
      return;
    }
    if (!isRhj && c.toLowerCase() === expect) {
      fail(`${t.ticker} is marked issuer "${t.issuer}" but RHJ deployed it — fix the issuer field`);
      return;
    }
    matched++;
  });

  ok(
    `${matched}/${RWA_TOKENS.length} rows provenance-consistent` +
      (unverified ? ` · ${unverified} unverified` : ""),
  );
  console.log();
  return byContract;
}

// ── 3. METADATA ─────────────────────────────────────────────────────────────
/**
 * RPC concurrency, deliberately lower than `CONCURRENCY`.
 *
 * Blockscout (used by checks 2 and 4) tolerates 10 in flight. The RH RPC does
 * not: this check issues symbol() + decimals() for every row, and once the
 * registry grew from 26 rows to 205 that became ~400 eth_calls with no
 * Multicall3 to batch them (task #88). At concurrency 10 the node throttled 195
 * of 205 rows — and the check reported `✓ 10/205 rows match on chain · 195
 * unread` and let the whole script exit PASS. That is the same defect this
 * script exists to catch, committed by the script itself: a green tick standing
 * on data nobody managed to read.
 */
const RPC_CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.RWA_VERIFY_RPC_CONCURRENCY ?? 4)));

/** Throttled reads are transient; genuinely-dead contracts are not. Retry with
 *  backoff so the two stop looking alike. */
async function readMetaRetry(addr: `0x${string}`, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 400 * 2 ** i));
    try {
      const m = await readErc20Meta(addr);
      if (m) return m;
    } catch { /* retry */ }
  }
  return null;
}

async function checkMetadata() {
  console.log("3. METADATA — on-chain symbol()/decimals() vs the row");
  const metas = await pool(RWA_TOKENS, RPC_CONCURRENCY, (t) => readMetaRetry(t.contract));

  let matched = 0;
  let unread = 0;
  const unreadTickers: string[] = [];
  RWA_TOKENS.forEach((t, i) => {
    const m = metas[i];
    if (!m) {
      unread++;
      unreadTickers.push(t.ticker);
      return;
    }
    let rowOk = true;
    const sym = (m.symbol ?? "").trim().toUpperCase();
    // Exact, not `includes`. Substring matching is precisely how "USO" was
    // judged not to match "CUSO" and got flagged as a scam.
    if (sym && sym !== t.ticker.toUpperCase()) {
      fail(`${t.ticker}: on-chain symbol() is "${m.symbol}" — the registry ticker is wrong`);
      rowOk = false;
    }
    if (m.decimals !== null && m.decimals !== t.decimals) {
      fail(`${t.ticker}: on-chain decimals() is ${m.decimals}, registry says ${t.decimals}`);
      rowOk = false;
    }
    if (rowOk) matched++;
  });

  if (unread > 0) {
    // Not `warn`. An unread row is an unchecked row, and this check's whole
    // claim is "the registry matches the chain" — a run that couldn't read 195
    // of 205 contracts has not established that, so it must not exit 0 while
    // saying so. The message names the cause because the fix is different for
    // each: throttling wants a re-run, a permanently-unreadable contract wants
    // the row investigated.
    const shown = unreadTickers.slice(0, 12).join(", ");
    fail(
      `${matched}/${RWA_TOKENS.length} rows verified · ${unread} UNREAD after ${RPC_CONCURRENCY}-way reads with retry ` +
        `(${shown}${unread > 12 ? `, +${unread - 12} more` : ""}). ` +
        `These rows were not checked against the chain — this is "unknown", not "matching". ` +
        `Usually RPC throttling: re-run, or RWA_VERIFY_RPC_CONCURRENCY=2 npm run rwa:verify. ` +
        `If a row stays unread across runs, the contract itself needs investigating.`,
    );
  } else {
    ok(`${matched}/${RWA_TOKENS.length} rows match on chain`);
  }
  console.log();
}

// ── 4. COMPLETE ─────────────────────────────────────────────────────────────
/** Pagination ceiling for the factory log crawl — ~7× the current count. */
const MAX_LOG_PAGES = 30;

async function checkComplete() {
  console.log("4. COMPLETE — every RHJ factory deployment is in the registry");

  // Walk the factory's own `Deployed(bytes32 uid, address stock, string name,
  // string symbol)` events. Unlike a token-list scan this cannot silently
  // return a prefix: pagination ends when the explorer says there is no next
  // page, and a partial crawl is reported as UNKNOWN instead of passing.
  const deployed = new Map<string, string>(); // address → symbol
  let cursor: Record<string, unknown> | null = null;
  let pages = 0;
  let truncated = false;

  for (let p = 0; p < MAX_LOG_PAGES; p++) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(cursor ?? {})) if (v != null) qs.set(k, String(v));
    const d = await bs<{
      items?: { decoded?: { method_call?: string; parameters?: { name: string; value: string }[] } }[];
      next_page_params?: Record<string, unknown> | null;
    }>(`/addresses/${RH_RWA_DEPLOYER}/logs?${qs}`);
    if (!d?.items) {
      fail(
        `Blockscout stopped answering on factory-log page ${p} — completeness UNKNOWN ` +
          `this run. This is not a pass; re-run before trusting the registry.`,
      );
      console.log();
      return;
    }
    pages++;
    for (const l of d.items) {
      if (!l.decoded?.method_call?.startsWith("Deployed(")) continue;
      const get = (n: string) => l.decoded?.parameters?.find((x) => x.name === n)?.value;
      const stock = get("stock");
      if (stock) deployed.set(stock.toLowerCase(), get("symbol") ?? "?");
    }
    cursor = (d.next_page_params as Record<string, unknown> | null) ?? null;
    if (!cursor || d.items.length === 0) break;
    if (p === MAX_LOG_PAGES - 1) truncated = true;
  }

  if (truncated) {
    fail(`factory log crawl hit MAX_LOG_PAGES (${MAX_LOG_PAGES}) — raise it, this run was truncated`);
    console.log();
    return;
  }

  const known = new Set(RWA_TOKENS.map((t) => t.contract.toLowerCase()));
  const missing = [...deployed].filter(([addr]) => !known.has(addr));
  for (const [addr, sym] of missing) {
    fail(`${sym} (${addr}) was deployed by the RHJ factory and is NOT in the registry — run \`npx tsx scripts/rwa-generate.ts --write\``);
  }

  // Registry rows the factory never emitted. WETH/USDG are expected here (they
  // are not RHJ issues); an `issuer: "RHJ"` row that isn't factory output is a
  // real problem — it claims a provenance the chain does not back.
  const unbacked = RWA_TOKENS.filter(
    (t) => t.issuer === "RHJ" && !deployed.has(t.contract.toLowerCase()),
  );
  for (const u of unbacked) {
    fail(`${u.ticker} (${u.contract}) is marked issuer "RHJ" but the factory never deployed it`);
  }

  if (missing.length === 0 && unbacked.length === 0) {
    const utility = RWA_TOKENS.length - deployed.size;
    ok(
      `${deployed.size} factory deployments across ${pages} log page(s) · ` +
        `${RWA_TOKENS.length} registry rows (${deployed.size} RHJ + ${utility} utility) · ` +
        `exact match, both directions`,
    );
  }
  console.log();
}

// ── 5. FEEDS ────────────────────────────────────────────────────────────────
async function checkFeeds() {
  console.log("5. FEEDS — every RH equity feed maps to a registry row");
  type Feed = {
    name?: string;
    proxyAddress?: string;
    docs?: { marketHours?: string };
  };
  let feeds: Feed[] | null = null;
  try {
    const res = await fetch(FEEDS_URL, { signal: AbortSignal.timeout(20_000) });
    if (res.ok) feeds = (await res.json()) as Feed[];
  } catch {
    /* handled below */
  }
  if (!feeds) {
    warn("could not fetch the Chainlink reference JSON — feed coverage UNKNOWN this run");
    console.log();
    return;
  }

  const equities = feeds.filter((f) => f.docs?.marketHours === "us_equities_24/5");
  const byTicker = new Map(RWA_TOKENS.map((t) => [t.ticker.toUpperCase(), t]));
  const byFallback = new Map(CHAINLINK_ONLY_FEEDS.map((f) => [f.ticker.toUpperCase(), f]));

  let mapped = 0;
  for (const f of equities) {
    // Chainlink uses two spellings in the same file: "Robinhood SGOV-USD" and
    // "Robinhood EWY / USD". Handle both. The first cut of this script only
    // handled the hyphen and duly accused 32 correct rows of missing a feed —
    // so the parse is now asserted rather than trusted: anything that still
    // looks unparsed is reported as a PARSE failure against this script, not
    // as a registry failure. A verifier that cries wolf gets muted, and a
    // muted verifier is worse than none.
    const ticker = (f.name ?? "")
      .replace(/^Robinhood\s+/i, "")
      .replace(/\s*[/-]\s*USD$/i, "")
      .trim()
      .toUpperCase();
    const proxy = f.proxyAddress ?? "";
    if (!ticker || !/^[A-Z0-9.]+$/.test(ticker)) {
      fail(`PARSE: cannot derive a ticker from Chainlink feed name "${f.name}" — fix rwa-verify.ts`);
      continue;
    }
    const row = byTicker.get(ticker);
    if (!row) {
      if (byFallback.get(ticker)) {
        warn(`${ticker}: feed present, token only in CHAINLINK_ONLY_FEEDS — promote when deployed`);
      } else {
        fail(`${ticker}: Chainlink publishes a feed (${proxy}) but no registry row claims it`);
      }
      continue;
    }
    if (!row.chainlinkFeed) {
      fail(`${ticker}: a live feed exists (${proxy}) but the registry row has none`);
      continue;
    }
    if (row.chainlinkFeed.toLowerCase() !== proxy.toLowerCase()) {
      fail(`${ticker}: registry feed ${row.chainlinkFeed} != Chainlink proxy ${proxy}`);
      continue;
    }
    mapped++;
  }

  // The inverse: a row pointing at a feed Chainlink does not publish.
  const proxies = new Set(feeds.map((f) => (f.proxyAddress ?? "").toLowerCase()));
  for (const t of RWA_TOKENS) {
    if (t.chainlinkFeed && !proxies.has(t.chainlinkFeed.toLowerCase())) {
      fail(`${t.ticker}: registry feed ${t.chainlinkFeed} is not in Chainlink's RH directory`);
    }
  }

  ok(`${mapped}/${equities.length} equity feeds resolve to a registry row`);
  console.log();
}

async function main() {
  console.log("=".repeat(78));
  console.log(`RWA registry vs ${RH_CHAIN.name} (chainId ${RH_CHAIN.chainId})`);
  console.log(`read-only · concurrency ${CONCURRENCY} · nothing is written`);
  console.log("=".repeat(78));
  console.log();

  checkShape();
  await checkProvenance();
  await checkMetadata();
  await checkComplete();
  await checkFeeds();

  console.log("=".repeat(78));
  if (failures === 0) {
    console.log("PASS — the registry matches the chain. Nothing was written.");
    console.log("=".repeat(78));
    return;
  }
  console.log(`FAIL — ${failures} problem(s) above. Nothing was written.`);
  console.log("=".repeat(78));
  process.exitCode = 1;
}

main().catch((e) => {
  console.error("rwa:verify crashed:", e);
  process.exit(1);
});
