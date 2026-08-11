// Load .env.local so the LLM health assertion (T-A.1 #3) sees the same
// keys `next dev` would. tsx doesn't auto-load; Next does. We hand-roll
// a minimal parser instead of pulling `dotenv` into apps/web just for a
// smoke script (dotenv lives at the repo root, not in apps/web/node_modules,
// so a direct import breaks `next build` typechecking on Vercel).
import fs from "fs";
import path from "path";
(function loadEnvLocal() {
  try {
    const p = path.resolve(__dirname, "../.env.local");
    if (!fs.existsSync(p)) return;
    const raw = fs.readFileSync(p, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s.startsWith("#")) continue;
      const eq = s.indexOf("=");
      if (eq < 0) continue;
      const key = s.slice(0, eq).trim();
      let value = s.slice(eq + 1).trim();
      // Strip matched surrounding quotes.
      if ((value.startsWith("\"") && value.endsWith("\"")) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch { /* smoke keeps running even if env load fails */ }
})();

/**
 * Blue Hood — semantic smoke.
 *
 * Separate from `scripts/semantic-smoke.ts` (which gates the FROZEN 30 x402
 * skills). This one covers Blue Hood-layer invariants — market clock
 * transitions, rule-engine sanity, arrow-feed test-filter — so a change
 * to Hood can't accidentally regress its own contract.
 *
 * Run: `npx tsx scripts/blue-hood-smoke.ts`
 * Exit code: 0 all pass, 1 any assertion fails (CI-friendly).
 */

import { nyseMarketStatus } from "../src/lib/robinhood/rwa-market";
import { detectCandidate, runRuleEngine } from "../src/lib/blue-hood/rule-engine";
import { HOOD_REGISTRY_STATS } from "../src/lib/blue-hood/registry";
import type { HoodSnapshot, TickerSnapshot } from "../src/lib/blue-hood/types";
import { detectBriefNumberDrift } from "../src/lib/blue-hood/brief";
import { callLLM } from "../src/app/api/_lib/llm";

// T-B.1 #1 — strict vs warn mode. Local runs should stay green (WARN prints
// the same signal but doesn't exit non-zero, so a permanently-red assertion
// doesn't train the eye to ignore red). CI + prod cron set BH_SMOKE_STRICT=1
// so a broken chain still fails the build. `must` = hard, `should` = soft.
const STRICT = process.env.BH_SMOKE_STRICT === "1";
let failed = 0;
let warned = 0;
function must(ok: boolean, label: string, detail?: string) {
  if (ok) console.log(`  ✅ ${label}`);
  else { failed++; console.error(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`); }
}
function should(ok: boolean, label: string, detail?: string) {
  if (ok) { console.log(`  ✅ ${label}`); return; }
  if (STRICT) { failed++; console.error(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`); }
  else { warned++; console.warn(`  ⚠  ${label}${detail ? ` — ${detail}` : ""} (WARN — set BH_SMOKE_STRICT=1 to fail)`); }
}

async function main() {
// ── Section 1: Market clock transitions (BLOCKER CHECK — weekend) ─────────
{
  console.log("\n── market clock ──");

  // Saturday any hour → weekend
  const sat = new Date("2026-07-18T12:00:00Z"); // Sat noon UTC
  const satS = nyseMarketStatus(sat);
  must(satS.session === "weekend" && !satS.is_open, "Sat → weekend + closed",
       `session=${satS.session} is_open=${satS.is_open}`);

  // Sunday any hour → weekend
  const sun = new Date("2026-07-19T15:00:00Z");
  const sunS = nyseMarketStatus(sun);
  must(sunS.session === "weekend" && !sunS.is_open, "Sun → weekend + closed",
       `session=${sunS.session} is_open=${sunS.is_open}`);

  // Monday 06:00 ET = 10:00 UTC (during DST -4) → premarket
  const monPre = new Date("2026-07-20T10:00:00Z");
  const monPreS = nyseMarketStatus(monPre);
  must(monPreS.session === "premarket" && !monPreS.is_open, "Mon 06:00 ET → premarket",
       `session=${monPreS.session} is_open=${monPreS.is_open}`);

  // Monday 13:30 UTC = 09:30 ET → regular open
  const monOpen = new Date("2026-07-20T13:30:00Z");
  const monOpenS = nyseMarketStatus(monOpen);
  must(monOpenS.session === "regular" && monOpenS.is_open, "Mon 09:30 ET → regular + open",
       `session=${monOpenS.session} is_open=${monOpenS.is_open}`);

  // Monday 20:00 UTC = 16:00 ET → afterhours (16:00 is close)
  const monClose = new Date("2026-07-20T20:00:00Z");
  const monCloseS = nyseMarketStatus(monClose);
  must(monCloseS.session === "afterhours" && !monCloseS.is_open, "Mon 16:00 ET → afterhours",
       `session=${monCloseS.session} is_open=${monCloseS.is_open}`);

  // Monday 22:00 UTC = 18:00 ET → afterhours
  const monPost = new Date("2026-07-20T22:00:00Z");
  const monPostS = nyseMarketStatus(monPost);
  must(monPostS.session === "afterhours" && !monPostS.is_open, "Mon 18:00 ET → afterhours",
       `session=${monPostS.session} is_open=${monPostS.is_open}`);
}

// ── Section 2: Registry honest denominator (BLOCKER 2) ─────────────────────
{
  console.log("\n── registry denominator ──");
  must(HOOD_REGISTRY_STATS.rwa_candidates > 0, "rwa_candidates > 0");
  must(HOOD_REGISTRY_STATS.watched > 0, "watched > 0");
  must(
    HOOD_REGISTRY_STATS.watched + HOOD_REGISTRY_STATS.no_chainlink_feed === HOOD_REGISTRY_STATS.rwa_candidates,
    "watched + no_feed = rwa_candidates",
    `${HOOD_REGISTRY_STATS.watched} + ${HOOD_REGISTRY_STATS.no_chainlink_feed} vs ${HOOD_REGISTRY_STATS.rwa_candidates}`,
  );
  must(HOOD_REGISTRY_STATS.no_chainlink_feed >= 1, "at least one row is drop-with-reason (surface honesty)");
}

// ── Section 3: Rule engine sanity (BLOCKER 3 — log breakdown sums) ────────
{
  console.log("\n── rule engine sanity ──");

  // Synthesize a snapshot with 4 rows exercising every branch:
  //   TSLA — market open, LONG_DEX 1.5%, TVL $10k → fires arb
  //   NVDA — market open, LONG_DEX 1.5%, TVL $2k → skipped_dust
  //   AAPL — market closed, drift +3%, TVL $10k → fires drift
  //   MSFT — market open, ALIGNED, drift 0.1% → below_threshold
  const mk = (
    ticker: string,
    verdict: TickerSnapshot["verdict"],
    isOpen: boolean,
    driftPct: number,
    tvl: number,
    warnings: string[] = [],
  ): TickerSnapshot => ({
    ticker,
    name: ticker,
    contract: `0x${ticker}`,
    verdict,
    oracle_usd: 100,
    dex_usd: 100 * (1 + driftPct / 100),
    // Test rows: primary + total set equal so smoke fixtures match
    // pre-existing dust-gate semantics. NVDA row @ tvl $2k still fires
    // skipped_dust because total_tvl_usd (= tvl) < $5k. Real prod rows
    // will have primary != total; this fixture is only exercising the
    // rule-engine gate logic.
    tvl_usd: tvl,
    total_tvl_usd: tvl,
    volume_24h_usd: 1_000,
    drift_pct: driftPct,
    pool_ref: "0xpool",
    is_v4_pool_id: false,
    market: {
      is_open: isOpen,
      session: isOpen ? "regular" : "afterhours",
      ny_time_iso: new Date().toISOString(),
    },
    warnings,
    polled_at_ms: 0,
    data_age_s: null,
    sparkline: null,
    no_data_reason: null,
  });

  const snap: HoodSnapshot = {
    cycle_id: Date.now(),
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    duration_ms: 0,
    tickers: [
      mk("TSLA", "LONG_DEX",       true,  1.5, 10_000),
      mk("NVDA", "LONG_DEX",       true,  1.5,  2_000),
      mk("AAPL", "AFTERHOURS_DRIFT", false, 3,  10_000),
      mk("MSFT", "ALIGNED",        true,  0.1, 10_000),
    ],
    metrics: {
      registry_total: 26,
      tokens_watched: 4,
      tokens_no_feed: 0,
      tokens_errored: 0,
      tvl_scanned_usd: 32_000,
      market_is_open: true,
      market_session: "regular",
    },
  };

  // Rule-engine writes to KV — the local in-memory map is fine for this
  // smoke; still, clear the module state between runs.
  const { kvSet } = await import("../src/lib/kv");
  await kvSet("bh:arrow:feed", []);
  await kvSet("bh:arrow:serial", 0);

  const rep = await runRuleEngine(snap);

  // detectCandidate spot-checks
  must(detectCandidate(snap.tickers[0])?.type === "arb", "TSLA row → arb candidate");
  must(detectCandidate(snap.tickers[2])?.type === "drift", "AAPL row → drift candidate");
  must(detectCandidate(snap.tickers[3]) === null, "MSFT row → no candidate (below threshold)");

  // Engine report shape
  must(rep.candidates_over_threshold === 3, "candidates_over_threshold = 3",
       `got ${rep.candidates_over_threshold}`);
  must(rep.skipped_dust === 1, "skipped_dust = 1 (NVDA)", `got ${rep.skipped_dust}`);
  must(rep.below_threshold === 1, "below_threshold = 1 (MSFT)", `got ${rep.below_threshold}`);
  must(rep.fired === 2, "fired = 2 (TSLA arb + AAPL drift)", `got ${rep.fired}`);
  must(rep.deduped === 0, "deduped = 0 on cold run", `got ${rep.deduped}`);

  // Sanity conservation
  const sum = rep.skipped_dust + rep.skipped_feed_stale + rep.deduped + rep.fired;
  must(sum === rep.candidates_over_threshold,
       "candidates_over_threshold = dust + stale + deduped + fired",
       `${rep.candidates_over_threshold} vs ${sum}`);
  must(rep.candidates_over_threshold + rep.below_threshold === snap.tickers.length,
       "candidates + below = tokens_watched (excl. errored)");

  // Second run — dedup should trigger
  const rep2 = await runRuleEngine(snap);
  must(rep2.deduped === 2, "second run deduped = 2 (both open)", `got ${rep2.deduped}`);
  must(rep2.fired === 0, "second run fired = 0");
}


// ── Section 4: brief_number_drift guard (T-A.1 #2) ────────────────────────
{
  console.log("\n── brief_number_drift guard ──");
  const facts = { dex_change_24h_pct: -1.42 };
  const clean = detectBriefNumberDrift("Apple decline ~1.42% today", facts);
  must(clean.length === 0, "reconciling number is silent", `warnings=${clean.length}`);
  const drift = detectBriefNumberDrift("Apple 1.57% 24h decline", facts);
  must(drift.length === 1, "drift > 0.1pp raises exactly one warning", `warnings=${drift.length}`);
  must(drift[0]?.startsWith("brief_number_drift:"), "warning uses standard prefix");
  const noPct = detectBriefNumberDrift("no percentages here", facts);
  must(noPct.length === 0, "text without % never triggers");
  const closeEnough = detectBriefNumberDrift("~1.47% decline", facts);
  must(closeEnough.length === 0, "within 0.1pp tolerance is silent (1.47 vs 1.42)");
}

// ── Section 5: LLM chain health (T-A.1 #3, gated per T-B.1 #1) ────────────
// `should` = warn-by-default. Local dev without keys keeps smoke green (a
// permanently-red assertion trains the eye to ignore red); CI + prod cron
// set BH_SMOKE_STRICT=1 to hard-fail on broken chain.
{
  console.log("\n── LLM chain health ──");
  try {
    const r = await callLLM({
      system: "Reply with one word: ok.",
      user: "ping",
      temperature: 0,
      maxTokens: 4,
      webSearch: false,
    });
    should(!!r.provider, `at least one provider succeeded (${r.provider})`);
    should(Array.isArray(r.attempts) && r.attempts.length > 0, "attempts trace non-empty");
  } catch (e) {
    const err = e as Error & { attempts?: unknown[] };
    const chain = Array.isArray(err.attempts)
      ? err.attempts.map((a) => `${(a as { provider?: string }).provider}:${(a as { status?: string }).status}`).join("→")
      : "n/a";
    should(false, "at least one provider succeeded", `all failed — chain: ${chain}`);
  }
}
}

main().then(() => {
  const status = failed === 0
    ? (warned === 0 ? "all passed ✓" : `all passed ✓ · ${warned} warning(s) (STRICT=off)`)
    : `${failed} assertion(s) failed`;
  console.log(`\n── SUMMARY ── ${status}`);
  process.exit(failed === 0 ? 0 : 1);
}).catch((e) => {
  console.error("smoke crashed:", e);
  process.exit(2);
});
