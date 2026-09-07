/**
 * Blue Hood — Base B20 ADMISSION GATE probe.
 *
 * The one command that decides whether a ticker may enter `BASE_STOCKS`. It
 * exists because the admission decision is a CORRECTNESS decision, not a
 * convenience one, and it must be reproducible by whoever asks next — not
 * re-derived by hand each time.
 *
 * ── Why a pool gate and not a feed gate ──────────────────────────────────────
 * Measured 2026-08-24: Chainlink publishes **13** "Coinbase <TICKER>" equity
 * feeds on Base, but only **4** of those tickers have a real market. TSLAc's
 * deepest pool held $1 and AMZNc's held $7, both with $0 24h volume; SNDK ·
 * INTC · COIN · CRCL · MSTR · MSFT · SPCX had no pool at all. Admitting on
 * feed-existence would have added 9 tickers whose "drift" is pure noise — the
 * same disease that forced the RH dead-pool liveness gate, where BABA was
 * frozen 100% of hours and SPCX 98%, and where 51% of graded drift arrows had
 * fired on a DEX series that was dead or noisier than the oracle.
 *
 * The public track record IS the product. A thin-pool ticker poisons it, and
 * published arrows are never rewritten. So: **the pool decides.**
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *   # Health check — re-run the gate against every ticker already admitted:
 *   npx tsx scripts/base-stock-admission-probe.ts
 *
 *   # Evaluate a CANDIDATE (addresses from base.org/stocks + Chainlink's Base
 *   # feed directory — NEVER ticker-matched, see the impostor note below):
 *   npx tsx scripts/base-stock-admission-probe.ts \
 *     --ticker TSLA --name "Tesla, Inc." \
 *     --token 0x… --feed 0x… [--skip-candles]
 *
 * ── ⚠️ RUN THIS DURING US MARKET HOURS ───────────────────────────────────────
 * Coinbase's Chainlink equity feeds stop ticking when the market closes, so
 * roughly 48h after Friday's last print EVERY Base ticker reads `is_stale` and
 * every oracle-side gate goes dark — admitted tickers included. The probe now
 * detects this (`marketIsClosed`) and downgrades staleness to INCONCLUSIVE
 * rather than FAIL, but INCONCLUSIVE still blocks admission, so a weekend run
 * can confirm the POOL gates and nothing else. Settle the oracle gates on a
 * weekday. See `marketIsClosed` for the measurement that established this.
 *
 * Exits 0 only if every evaluated ticker PASSES. Prints the exact
 * `ticker · token · feed · pool · liquidity · volume 24h · PASS/FAIL` table the
 * checkpoint asks for before anything is written to the registry.
 *
 * ⚠️ NEVER resolve a Base stock by ticker string. Base carries live counterfeits
 * using the exact `<TICKER>c` symbol — "TSLAc" at
 * `0xb5be29124d8a97eb2df434444dd68c00b6c43fd7` and
 * `0x8b012624874c556dadfa5c2b2de0b4eee4c3c1ef`, "AMZNc" at
 * `0xd6aace315732c354a2c89e222699f2a467b7abf7` — all `isB20() == false`, all
 * `decimals == 18`, with padded names like "Tesla Inc. ". The `isB20()` factory
 * also answers `true` for EMPTY addresses carrying the `0xb200…` vanity prefix,
 * so neither the prefix nor the symbol proves anything on its own (lesson #280).
 * This probe asserts `isB20 ∧ decimals == 8 ∧ symbol == "<TICKER>c"` together.
 */
import { readBaseStockQuote } from "@/lib/base-stocks/b20-quote";
import { BASE_STOCKS, type BaseStock } from "@/lib/base-stocks/registry";
import { clientForSource, BASE_PRICE_SOURCE } from "@/lib/robinhood/rwa-price";
import type { Address } from "viem";

/** Minimal AggregatorV3 read — only `updatedAt` is needed, for `marketIsClosed`. */
const AGGREGATOR_MINI_ABI = [
  {
    name: "latestRoundData", type: "function", stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
] as const;

// ── Admission floors ─────────────────────────────────────────────────────────
// ⚠️ These are a HUMAN ADMISSION BAR, deliberately distinct from the engine's
// runtime liveness gate (`rule-engine.ts::MIN_DEX_VOL_24H_USD`, which is `> 0`).
// Do NOT copy these numbers into the engine: raising the runtime floor is a
// MEASURED DEAD LEVER (1k → 63%, 10k → 64%, 50k → 63% against a 64% baseline —
// every higher floor cuts arrows for no gain).
//
// They sit in the wide empty gap between the two observed populations: the live
// four print $650k+ liquidity and $1.1M+ volume, the rejects printed $1/$7 and
// $0. Any threshold in between separates them; these are round numbers well
// below the good population so a genuine-but-smaller market still qualifies.
const MIN_LIQUIDITY_USD = 100_000;
const MIN_VOLUME_24H_USD = 50_000;
/** Hourly candles to scan for the BABA test (frozen / zero-volume pool). */
const CANDLE_HOURS = 72;
/** Max share of hours allowed to be zero-volume or flat-close before FAIL. */
const MAX_DEAD_HOUR_FRAC = 0.1;
/** Pause between tickers. GeckoTerminal's free tier is ~30 req/min and each
 *  ticker costs 2 calls; bursting all of them 429s and produced a spurious
 *  "no pool found" for AAPL + "candles unavailable" for GOOGL on the first run
 *  of this probe. Slow is correct here — a false FAIL is worse than a slow pass. */
const TICKER_STAGGER_MS = 2500;

/**
 * ⚠️ THREE-VALUED ON PURPOSE. "We could not measure it" is NOT "it failed the
 * gate", and collapsing the two produces false statements about real markets
 * (the first run of this probe reported GOOGL — the 3rd-deepest pool on the
 * desk — as a pool-gate FAIL, when the truth was an HTTP 429 from the indexer).
 * Both block admission; only one is a fact about the ticker.
 */
type Verdict = "PASS" | "FAIL" | "INCONCLUSIVE";

interface GateResult {
  ticker: string;
  token: string;
  feed: string;
  pool: string | null;
  liquidity: number | null;
  volume24h: number | null;
  sharePrice: number | null;
  driftPct: number | null;
  deadHours: number | null;
  flatHours: number | null;
  candles: number | null;
  verdict: Verdict;
  /** Measured shortfalls — facts about the ticker. */
  reasons: string[];
  /** Things we could not measure — facts about our own read. */
  unknowns: string[];
}

function usd(n: number | null, dp = 0): string {
  return n === null ? "—" : "$" + n.toLocaleString("en-US", { maximumFractionDigits: dp });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * GeckoTerminal GET with backoff. Returns `null` ONLY when the indexer could not
 * be reached after retries — callers must treat that as INCONCLUSIVE, never as
 * evidence about the pool.
 */
async function gtFetch(url: string, tries = 4): Promise<unknown | null> {
  for (let i = 0; i < tries; i++) {
    if (i > 0) await sleep(2000 * 2 ** (i - 1)); // 2s → 4s → 8s
    try {
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (res.status === 429 || res.status >= 500) continue; // transient — retry
      if (!res.ok) return null;
      return await res.json();
    } catch {
      /* network blip — retry */
    }
  }
  return null;
}

/**
 * Is the US equity market closed right now, judged from the feeds themselves?
 *
 * ⚠️ THIS EXISTS BECAUSE THE STALENESS GATE OTHERWISE MEASURES THE CLOCK, NOT
 * THE TICKER. Coinbase's Chainlink equity feeds do NOT tick while the market is
 * closed, so ~48h after Friday's last print every Base ticker reads `is_stale`
 * — including ones that have been live on the desk for weeks.
 *
 * MEASURED 2026-09-06 (Sunday, 18:55 UTC): all ten admitted + candidate feeds
 * last ticked on Friday 2026-09-04. The only thing separating "stale" from
 * "fresh" was what time that Friday each one happened to stop — GOOGL at 14:24
 * (52.5h, STALE), MSTR at 21:29 (45.4h, fresh), with the whole desk inside a
 * 3-hour window of also flipping. On that run the probe reported NVDA and GOOGL
 * — two tickers admitted weeks earlier — as FAILures, which is exactly the
 * false statement the three-valued verdict was introduced to prevent.
 *
 * So: read the peer set. If even the FRESHEST admitted feed has not ticked
 * within one heartbeat, nothing is publishing and staleness carries no
 * ticker-specific information → INCONCLUSIVE. If peers are fresh and this one
 * is stale, that IS a fact about the ticker → FAIL. Returns null if the peer
 * set can't be read, which is itself INCONCLUSIVE.
 */
async function marketIsClosed(): Promise<{ closed: boolean; freshestAgeS: number } | null> {
  const client = clientForSource(BASE_PRICE_SOURCE);
  const now = Math.floor(Date.now() / 1000);
  const ages: number[] = [];
  for (const s of BASE_STOCKS) {
    try {
      const r = (await client.readContract({
        address: s.chainlinkFeed,
        abi: AGGREGATOR_MINI_ABI,
        functionName: "latestRoundData",
      })) as readonly [bigint, bigint, bigint, bigint, bigint];
      ages.push(now - Number(r[3]));
    } catch {
      /* one unreadable peer is fine — we only need the freshest */
    }
  }
  if (ages.length === 0) return null;
  const freshestAgeS = Math.min(...ages);
  // Heartbeat is 86400s on every Coinbase equity feed; take the max in the set
  // so a future feed with a slower cadence widens the window rather than
  // producing a spurious "market open".
  const heartbeat = Math.max(...BASE_STOCKS.map((s) => s.chainlinkHeartbeat));
  return { closed: freshestAgeS > heartbeat, freshestAgeS };
}

/**
 * Does the indexer know of ANY pool for this token? Used only to tell a genuine
 * "no market exists" (a FAIL — the TSLAc/AMZNc case) apart from "the quote read
 * happened to be rate-limited" (INCONCLUSIVE). Returns null if unreachable.
 */
async function poolCount(token: string): Promise<number | null> {
  const json = await gtFetch(
    `https://api.geckoterminal.com/api/v2/networks/base/tokens/${token.toLowerCase()}/pools?page=1`,
  );
  if (json === null) return null;
  const data = (json as { data?: unknown[] }).data;
  return Array.isArray(data) ? data.length : null;
}

/**
 * The BABA test — a single snapshot CANNOT detect a frozen pool, because a pool
 * that never trades still reports a price. Only the hourly series can: BABA was
 * bit-identical across 100% of consecutive archive hours while still quoting.
 * We scan `CANDLE_HOURS` of hourly OHLCV and count hours with zero volume and
 * hours whose close is identical to the previous hour's.
 */
async function candleCheck(
  pool: string,
): Promise<{ candles: number; dead: number; flat: number } | null> {
  const json = await gtFetch(
    `https://api.geckoterminal.com/api/v2/networks/base/pools/${pool.toLowerCase()}` +
      `/ohlcv/hour?aggregate=1&limit=${CANDLE_HOURS}`,
  );
  if (json === null) return null;
  const list = (json as { data?: { attributes?: { ohlcv_list?: number[][] } } })
    .data?.attributes?.ohlcv_list;
  if (!Array.isArray(list) || list.length === 0) return null;

  // GeckoTerminal returns newest-first: [ts, open, high, low, close, volume].
  const rows = [...list].sort((a, b) => a[0] - b[0]);
  let dead = 0;
  let flat = 0;
  let prevClose: number | null = null;
  for (const r of rows) {
    const close = Number(r[4]);
    const vol = Number(r[5]);
    if (!Number.isFinite(vol) || vol <= 0) dead++;
    if (prevClose !== null && Number.isFinite(close) && close === prevClose) flat++;
    if (Number.isFinite(close)) prevClose = close;
  }
  return { candles: rows.length, dead, flat };
}

async function runGate(
  stock: BaseStock,
  opts: { candles: boolean; marketClosed: { closed: boolean; freshestAgeS: number } | null },
): Promise<GateResult> {
  const reasons: string[] = []; // measured shortfalls  → FAIL
  const unknowns: string[] = []; // unmeasurable        → INCONCLUSIVE
  const q = await readBaseStockQuote(stock);

  // 1–3. Identity + hazard gates, straight off the production read path. These
  //      are the impostor / multiplier / pause / sequencer / staleness checks —
  //      `can_fire` is the single field the poller and grader both key on, so
  //      asserting it here means we are testing the REAL path, not a replica.
  if (!q.impostor_ok) reasons.push("impostor gate FAILED (isB20 ∧ decimals==8 ∧ symbol match)");
  if (!q.multiplier_ok) reasons.push("multiplier() unreadable or <= 0");
  if (q.paused) reasons.push("token reports isPaused(TRANSFER) == true");
  if (!q.sequencer_ok) reasons.push("Base sequencer down or inside grace window");

  // Staleness — attribute it before scoring it (see `marketIsClosed`). A stale
  // feed while the whole desk is stale is the calendar, not the ticker.
  const marketClosed = opts.marketClosed;
  if (q.feed_is_stale) {
    const age = `age ${q.feed_age_seconds}s`;
    if (marketClosed === null) {
      unknowns.push(`Chainlink feed stale (${age}) but peer feeds unreadable — cannot attribute`);
    } else if (marketClosed.closed) {
      unknowns.push(
        `Chainlink feed stale (${age}) — but the market is CLOSED (freshest peer feed is ` +
          `${(marketClosed.freshestAgeS / 3600).toFixed(1)}h old), so this says nothing about the ticker. Re-run during market hours.`,
      );
    } else {
      reasons.push(
        `Chainlink feed stale (${age}) while peers are fresh ` +
          `(${(marketClosed.freshestAgeS / 3600).toFixed(1)}h) — ticker-specific`,
      );
    }
  }
  if (q.share_price_usd === null) reasons.push("no multiplier-adjusted share price");

  // 4. THE DECIDING GATE — a real Aerodrome market, liquidity AND volume.
  let dexUnavailable = false;
  if (q.dex_price_usd === null || q.dex_pool_address === null) {
    // Disambiguate: is there genuinely no market (TSLAc/AMZNc — a FAIL, and the
    // whole reason this gate exists), or did the indexer just rate-limit us?
    const pools = await poolCount(stock.token);
    if (pools === null) {
      dexUnavailable = true;
      unknowns.push("DEX read empty AND indexer unreachable — cannot tell 'no pool' from 'rate-limited'");
    } else if (pools === 0) {
      reasons.push("no Aerodrome pool exists (feed alone is NOT admission evidence)");
    } else {
      dexUnavailable = true;
      unknowns.push(`DEX read came back empty but the indexer lists ${pools} pool(s) — transient, re-run`);
    }
  } else {
    if (q.dex_liquidity_usd === null) {
      unknowns.push("pool liquidity unknown — cannot admit on unknown depth");
    } else if (q.dex_liquidity_usd < MIN_LIQUIDITY_USD) {
      reasons.push(`liquidity ${usd(q.dex_liquidity_usd)} < floor ${usd(MIN_LIQUIDITY_USD)}`);
    }
    if (q.dex_volume_24h_usd === null) {
      unknowns.push("pool 24h volume unknown — cannot admit on unknown flow");
    } else if (q.dex_volume_24h_usd < MIN_VOLUME_24H_USD) {
      reasons.push(`24h volume ${usd(q.dex_volume_24h_usd)} < floor ${usd(MIN_VOLUME_24H_USD)}`);
    }
  }

  // 5. can_fire — the exact predicate the poller/grader gate on. If the DEX leg
  //    was merely unreachable, `can_fire:false` is a symptom of OUR read, not of
  //    the token, so it must not be recorded as a measured failure.
  //    Likewise a `feed_stale` suppression during a market close is the calendar
  //    (see above) — recording it as a measured failure would double-count the
  //    clock and hand back a FAIL for a ticker we simply cannot judge yet.
  if (!q.can_fire && !dexUnavailable) {
    const staleWhileClosed =
      q.suppressed_reason === "feed_stale" && marketClosed !== null && marketClosed.closed;
    if (staleWhileClosed) {
      unknowns.push("can_fire == false (feed_stale) — market closed, not a ticker property");
    } else {
      reasons.push(`can_fire == false (${q.suppressed_reason ?? "unknown"})`);
    }
  }

  // 6. The BABA test — needs the hourly series, not a snapshot.
  let candles: number | null = null;
  let dead: number | null = null;
  let flat: number | null = null;
  if (opts.candles && q.dex_pool_address) {
    const c = await candleCheck(q.dex_pool_address);
    if (c === null) {
      unknowns.push("hourly candles unavailable — BABA test could not run (do not admit blind)");
    } else {
      candles = c.candles;
      dead = c.dead;
      flat = c.flat;
      if (c.candles < CANDLE_HOURS / 2) {
        reasons.push(`only ${c.candles} hourly candles — too little history to judge`);
      }
      if (c.dead / c.candles > MAX_DEAD_HOUR_FRAC) {
        reasons.push(`${c.dead}/${c.candles} zero-volume hours (BABA-style freeze)`);
      }
      if (c.flat / c.candles > MAX_DEAD_HOUR_FRAC) {
        reasons.push(`${c.flat}/${c.candles} hours with an unchanged close (frozen print)`);
      }
    }
  }

  return {
    ticker: stock.ticker,
    token: stock.token,
    feed: stock.chainlinkFeed,
    pool: q.dex_pool_address,
    liquidity: q.dex_liquidity_usd,
    volume24h: q.dex_volume_24h_usd,
    sharePrice: q.share_price_usd,
    driftPct: q.drift_pct,
    deadHours: dead,
    flatHours: flat,
    candles,
    // A measured shortfall outranks an unmeasurable one: if we KNOW it fails,
    // say FAIL. Otherwise any gap in the evidence means INCONCLUSIVE, which
    // still blocks admission — "unknown" is never read as "fine".
    verdict: reasons.length > 0 ? "FAIL" : unknowns.length > 0 ? "INCONCLUSIVE" : "PASS",
    reasons,
    unknowns,
  };
}

/** Every flag this probe understands. Anything else is a typo, and a typo here
 *  is dangerous: an unrecognised `--ticker` silently drops the script into
 *  health-check mode, printing the four INCUMBENTS under a header the operator
 *  read as their candidate. So unknown keys are a hard exit, not a warning. */
const KNOWN_FLAGS = new Set([
  "ticker", "token", "feed", "name", "heartbeat", "skip-candles",
]);

/**
 * Accepts BOTH `--key value` and `--key=value`. The `=` form used to fall
 * through the `startsWith("--")` check and register a flag literally named
 * `ticker=MSTR`, so `args.ticker` stayed undefined and the probe ran the wrong
 * mode without a word of complaint (hit for real, 2026-09-06).
 */
function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  const unknown: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const body = a.slice(2);
    const eq = body.indexOf("=");
    if (eq !== -1) {
      const key = body.slice(0, eq);
      if (!KNOWN_FLAGS.has(key)) unknown.push(key);
      out[key] = body.slice(eq + 1);
      continue;
    }
    if (!KNOWN_FLAGS.has(body)) unknown.push(body);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[body] = next;
      i++;
    } else {
      out[body] = true;
    }
  }
  if (unknown.length > 0) {
    console.error(
      `unknown flag(s): ${unknown.map((u) => `--${u}`).join(", ")}\n` +
        `known flags: ${[...KNOWN_FLAGS].map((k) => `--${k}`).join(", ")}\n` +
        "Refusing to run: a mistyped flag silently changes which tickers are probed.",
    );
    process.exit(1);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const withCandles = args["skip-candles"] !== true;

  let subjects: BaseStock[];
  let mode: string;

  if (args.ticker) {
    const ticker = String(args.ticker).toUpperCase();
    const token = args.token ? String(args.token) : "";
    const feed = args.feed ? String(args.feed) : "";
    if (!/^0x[0-9a-fA-F]{40}$/.test(token) || !/^0x[0-9a-fA-F]{40}$/.test(feed)) {
      console.error(
        "Both --token and --feed are required, as full 0x addresses.\n" +
          "Take the token from the official base.org/stocks table and the feed from\n" +
          "Chainlink's Base reference-data directory. NEVER match by ticker string.",
      );
      process.exit(2);
    }
    subjects = [
      {
        ticker,
        name: args.name ? String(args.name) : ticker,
        token: token as Address,
        symbol: `${ticker}c`,
        chainlinkFeed: feed as Address,
        chainlinkHeartbeat: args.heartbeat ? Number(args.heartbeat) : 86400,
        // A candidate has no band yet — that is the point. Run wide open so the
        // OTHER gates are what decide, then print a PROPOSED band from the
        // measured price for a human to check against a public quote. The band
        // must never be derived and adopted in the same automated breath: its
        // whole job is to disagree with the feed when the feed is broken.
        saneBand: { lo: 0, hi: Number.POSITIVE_INFINITY },
        admittedAt: new Date().toISOString().slice(0, 10),
      },
    ];
    mode = `CANDIDATE ${ticker}`;
  } else {
    subjects = [...BASE_STOCKS];
    mode = `re-checking ${subjects.length} ADMITTED ticker(s)`;
  }

  console.log(`\nBase B20 admission gate — ${mode}`);
  console.log(
    `floors: liquidity ≥ ${usd(MIN_LIQUIDITY_USD)} · 24h volume ≥ ${usd(MIN_VOLUME_24H_USD)}` +
      `${withCandles ? ` · ${CANDLE_HOURS}h candle scan` : " · candle scan SKIPPED"}`,
  );

  // Attribute feed staleness BEFORE grading any ticker on it.
  const marketClosed = await marketIsClosed();
  if (marketClosed === null) {
    console.log("market      ? peer feeds unreadable — staleness cannot be attributed");
  } else if (marketClosed.closed) {
    console.log(
      `market      CLOSED — freshest peer feed is ${(marketClosed.freshestAgeS / 3600).toFixed(1)}h old.\n` +
        "            Feed staleness is the calendar, not the ticker → INCONCLUSIVE, not FAIL.\n" +
        "            Re-run during US market hours to settle the oracle gates.",
    );
  } else {
    console.log(
      `market      OPEN — freshest peer feed is ${(marketClosed.freshestAgeS / 3600).toFixed(1)}h old; ` +
        "staleness is ticker-specific.",
    );
  }
  console.log("");

  const results: GateResult[] = [];
  for (const [i, s] of subjects.entries()) {
    if (i > 0) await sleep(TICKER_STAGGER_MS); // don't 429 ourselves into a false FAIL
    const r = await runGate(s, { candles: withCandles, marketClosed });
    results.push(r);

    console.log(`─── ${r.ticker} ${"─".repeat(Math.max(0, 56 - r.ticker.length))}`);
    console.log(`  token       ${r.token}`);
    console.log(`  feed        ${r.feed}`);
    console.log(`  pool        ${r.pool ?? "— none found —"}`);
    console.log(`  liquidity   ${usd(r.liquidity)}`);
    console.log(`  volume 24h  ${usd(r.volume24h)}`);
    console.log(
      `  price       ${r.sharePrice === null ? "—" : "$" + r.sharePrice.toFixed(2)}` +
        `   drift ${r.driftPct === null ? "—" : r.driftPct.toFixed(3) + "%"}`,
    );
    if (r.candles !== null) {
      console.log(
        `  candles     ${r.candles}h scanned · ${r.deadHours} zero-volume · ${r.flatHours} flat-close`,
      );
    }
    // A candidate needs a `saneBand` before it can be written to the registry,
    // and the band must be checked by a human against an INDEPENDENT public
    // quote — the feed cannot certify itself. Propose, never adopt.
    if (args.ticker && r.sharePrice !== null && r.sharePrice > 0) {
      const lo = r.sharePrice / 4;
      const hi = r.sharePrice * 4;
      console.log(
        `  band        proposed saneBand ≈ { lo: ${Math.floor(lo)}, hi: ${Math.ceil(hi)} }  ` +
          `(anchor $${r.sharePrice.toFixed(2)} ÷/× 4)`,
      );
      console.log(
        `              ⚠️ CHECK $${r.sharePrice.toFixed(2)} against a public quote for ${r.ticker} before adopting.`,
      );
      console.log(
        "              If the ticker has no public listing, it cannot get a defensible band — defer it.",
      );
    }
    console.log(`  >> ${r.verdict}`);
    for (const reason of r.reasons) console.log(`       ✗ ${reason}`);
    for (const u of r.unknowns) console.log(`       ? ${u}`);
    console.log("");
  }

  // The checkpoint table — this is what gets pasted for approval.
  console.log("─".repeat(118));
  console.log(
    "ticker".padEnd(8) +
      "token".padEnd(44) +
      "pool".padEnd(44) +
      "liquidity".padEnd(13) +
      "vol 24h".padEnd(13) +
      "gate",
  );
  console.log("─".repeat(118));
  for (const r of results) {
    console.log(
      r.ticker.padEnd(8) +
        r.token.padEnd(44) +
        (r.pool ?? "—").padEnd(44) +
        usd(r.liquidity).padEnd(13) +
        usd(r.volume24h).padEnd(13) +
        r.verdict,
    );
  }
  console.log("─".repeat(118));

  const failed = results.filter((r) => r.verdict === "FAIL");
  const unclear = results.filter((r) => r.verdict === "INCONCLUSIVE");

  if (failed.length === 0 && unclear.length === 0) {
    console.log(`\n✅ ${results.length}/${results.length} PASS`);
    process.exit(0);
  }
  if (failed.length > 0) {
    console.log(`\n❌ ${failed.length}/${results.length} FAILED: ${failed.map((f) => f.ticker).join(", ")}`);
    console.log("   Measured shortfall. Do NOT add a FAILED ticker to BASE_STOCKS —");
    console.log("   record it and revisit if its pool grows.");
  }
  if (unclear.length > 0) {
    console.log(`\n⚠️  ${unclear.length}/${results.length} INCONCLUSIVE: ${unclear.map((f) => f.ticker).join(", ")}`);
    console.log("   NOT a finding about these tickers — the evidence could not be read.");
    console.log("   Two common causes, and they need DIFFERENT re-runs:");
    console.log("     • market CLOSED (see banner) → the oracle simply isn't ticking;");
    console.log("       re-run during US market hours. Waiting minutes will not help.");
    console.log("     • GeckoTerminal 429 → the pool evidence was rate-limited;");
    console.log("       re-run in a few minutes.");
    console.log("   Read the ? lines above to see which one you hit.");
  }
  // 1 = a real measured failure · 2 = evidence incomplete. Both block admission.
  process.exit(failed.length > 0 ? 1 : 2);
}

main().catch((e) => {
  console.error("admission probe threw:", e);
  process.exit(1);
});
