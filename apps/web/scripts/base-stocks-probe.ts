/**
 * Blue Hood — Base B20 stock source probe (Phase 2).
 *
 * TWO independent checks, both must pass (exits non-zero on any failure — a
 * check that always exits 0 is not a check):
 *
 *   A. LIVE — read every BASE_STOCKS ticker end-to-end from Base mainnet and print the
 *      multiplier-adjusted share price, the raw total-return value, the DEX
 *      spot, the drift, and every suppression gate. Assert each share price
 *      lands in a sane per-ticker band. This is the "sharePrice matches the
 *      REAL stock price (~$215), not $215 × multiplier" acceptance test.
 *
 *   B. SYNTHETIC — the multiplier hazard cannot be caught by the live test today
 *      because every registered token currently reports multiplier == 1e18, which makes
 *      the division a no-op (share == total-return). So we feed a FIXED answer
 *      through `sharePriceFromFeed` with multipliers ≠ 1e18 and assert the
 *      division actually happens (2× multiplier ⟹ half price; 1.05× ⟹ 205, not
 *      215) and that a zero multiplier THROWS (the fail-loud contract). THIS is
 *      the test that would catch a dropped division.
 *
 * Run: `npm run test:base-stocks` (from apps/web).
 */
import {
  sharePriceFromFeed,
  readBaseStockQuote,
  WAD,
} from "../src/lib/base-stocks/b20-quote";
import { BASE_STOCKS } from "../src/lib/base-stocks/registry";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  const mark = ok ? "  ok " : "FAIL ";
  console.log(`${mark} ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
}
function approx(a: number, b: number, tolPct = 0.001) {
  return Math.abs(a - b) <= Math.abs(b) * tolPct + 1e-9;
}

// Sane per-ticker share-price bands. Wide enough to survive normal market drift
// over days, tight enough that a ×multiplier / scale bug (which would 2×, 100×,
// or 1e18× the value) blows straight through them.
//
// ⚠️ EVERY ticker in BASE_STOCKS needs a row here. A missing band used to SKIP
// the assertion silently, so a newly-admitted ticker would have quietly lost the
// single strongest check in this probe. Missing is now a hard FAIL (see below).
//
// ⚠️ These are DELIBERATELY NOT the registry's `saneBand`, and must never be
// derived from it. `b20-quote.ts` already suppresses any price outside
// `stock.saneBand` before this probe ever sees it, so asserting production's
// output against production's own band is a tautology that can never fail.
// The value here is an INDEPENDENT second opinion, held tighter on purpose —
// registry bands are a wide "don't publish an absurdity" backstop, these are a
// narrow "does today's read look like the actual stock" acceptance test.
const SANE_BAND: Record<string, [number, number]> = {
  NVDA: [120, 340],
  META: [320, 840],
  GOOGL: [190, 540],
  AAPL: [170, 500], // ~$310 at admission 2026-08-24
  // Admitted 2026-09-08. Floors sit below each ticker's measured 52-week low so
  // a real return to a price it traded at THIS YEAR is not reported as a bug;
  // ceilings sit above the 52w high with room, and still well under 2× spot.
  AMZN: [140, 420], // anchor $256.23, 52w $196.00–$287.20 — 2× ⇒ $512 caught, ÷2 ⇒ $128 caught
  MSFT: [270, 800], // anchor $496.57, 52w $349.20–$553.72 — 2× ⇒ $993 caught, ÷2 ⇒ $248 caught
  // ⚠️ MSTR is the one row that CANNOT catch a 2× error, and pretending
  // otherwise would be worse than saying so. Its own 52-week range is
  // $81.81–$365.21 — 4.5× wide — so any band that tolerates real MSTR movement
  // is wider than a doubling. Narrowing it would make the probe cry wolf on a
  // genuine move, which gets a check ignored rather than obeyed.
  // A 2× is NOT uncovered, it is covered ELSEWHERE and better: while the
  // multiplier reads 1e18 the `unit-multiplier ⇒ share == total-return` check
  // below asserts exact equality, so a dropped or doubled division shows up
  // there regardless of magnitude. This band still catches the errors that
  // check cannot: ÷100 ⇒ $1.38 and ×100 ⇒ $13,830 both blow through.
  MSTR: [60, 500], // anchor $138.30, 52w $81.81–$365.21
};

async function liveChecks() {
  console.log(`\n=== A. LIVE Base reads (${BASE_STOCKS.map((s) => s.ticker).join(" / ")}) ===\n`);
  for (const stock of BASE_STOCKS) {
    let q;
    try {
      q = await readBaseStockQuote(stock);
    } catch (e) {
      check(`${stock.ticker} read`, false, `threw: ${(e as Error).message}`);
      continue;
    }

    const fmt = (n: number | null, d = 2) => (n === null ? "—" : n.toFixed(d));
    console.log(
      [
        `[${stock.ticker}]`,
        `share=$${fmt(q.share_price_usd)}`,
        `totalReturn=$${fmt(q.total_return_value_usd)}`,
        `mult=${q.multiplier}${q.multiplier_is_unit ? " (1e18)" : ""}`,
        `dex=$${fmt(q.dex_price_usd)}`,
        `drift=${fmt(q.drift_pct, 3)}%`,
      ].join("  "),
    );
    console.log(
      [
        `        gates:`,
        `impostor_ok=${q.impostor_ok}`,
        `sequencer_ok=${q.sequencer_ok}`,
        `multiplier_ok=${q.multiplier_ok}`,
        `paused=${q.paused}`,
        `feed_stale=${q.feed_is_stale}`,
        `can_fire=${q.can_fire}`,
        `reason=${q.suppressed_reason ?? "—"}`,
      ].join("  "),
    );
    if (q.dex_pool_url) console.log(`        pool: ${q.dex_pool_url}`);
    console.log(
      `        feed_age=${q.feed_age_seconds ?? "—"}s  liquidity=$${fmt(q.dex_liquidity_usd, 0)}  vol24h=$${fmt(q.dex_volume_24h_usd, 0)}`,
    );

    // Acceptance assertions.
    const band = SANE_BAND[stock.ticker];
    check(
      `${stock.ticker} has a sane-price band defined`,
      band !== undefined,
      band ? "" : "add one to SANE_BAND — do not let a new ticker skip this check",
    );
    check(
      `${stock.ticker} share price present`,
      q.share_price_usd !== null,
      q.suppressed_reason ?? "",
    );
    if (q.share_price_usd !== null && band) {
      check(
        `${stock.ticker} share price in sane band [$${band[0]}, $${band[1]}]`,
        q.share_price_usd >= band[0] && q.share_price_usd <= band[1],
        `got $${q.share_price_usd.toFixed(2)}`,
      );
    }
    check(`${stock.ticker} impostor gate passes`, q.impostor_ok);
    check(`${stock.ticker} multiplier readable & > 0`, q.multiplier_ok);
    // When multiplier == 1e18 the share price must equal the raw total-return
    // value; if they diverge with a unit multiplier the WAD math is broken.
    if (q.multiplier_is_unit && q.share_price_usd !== null && q.total_return_value_usd !== null) {
      check(
        `${stock.ticker} unit-multiplier ⇒ share == total-return`,
        approx(q.share_price_usd, q.total_return_value_usd, 1e-6),
        `share=$${q.share_price_usd.toFixed(6)} tr=$${q.total_return_value_usd.toFixed(6)}`,
      );
    }
    console.log("");
  }
}

function syntheticChecks() {
  console.log("=== B. SYNTHETIC multiplier math (the hazard test) ===\n");
  // NVDA-like fixed answer at 8 decimals → $215.33 total-return value.
  const ANSWER = 21533020000n;
  const DECIMALS = 8;
  const raw = Number(ANSWER) / 10 ** DECIMALS; // 215.3302

  // 1. multiplier == WAD ⟹ no-op: share == raw total-return value.
  const unit = sharePriceFromFeed(ANSWER, DECIMALS, WAD);
  check("multiplier 1e18 is a no-op (share == raw)", approx(unit, raw, 1e-9), `got $${unit.toFixed(6)}`);

  // 2. multiplier == 2×WAD ⟹ share is EXACTLY half. This is the load-bearing
  //    test: if the division were dropped, share would still read $215, not $107.
  const dbl = sharePriceFromFeed(ANSWER, DECIMALS, 2n * WAD);
  check("multiplier 2e18 ⇒ share is half of raw", approx(dbl, raw / 2, 1e-6), `got $${dbl.toFixed(6)} (raw/2=$${(raw / 2).toFixed(6)})`);
  check("multiplier 2e18 ⇒ share ≠ raw (division not skipped)", !approx(dbl, raw, 0.01), `got $${dbl.toFixed(6)} vs raw $${raw.toFixed(6)}`);

  // 3. multiplier == 1.05×WAD ⟹ 215.33 / 1.05 ≈ 205.08 (a realistic rebase).
  const m105 = (105n * WAD) / 100n;
  const rebased = sharePriceFromFeed(ANSWER, DECIMALS, m105);
  check("multiplier 1.05e18 ⇒ share ≈ raw/1.05", approx(rebased, raw / 1.05, 1e-4), `got $${rebased.toFixed(4)} (expected $${(raw / 1.05).toFixed(4)})`);
  check("multiplier 1.05e18 ⇒ share < raw", rebased < raw, `got $${rebased.toFixed(4)} < $${raw.toFixed(4)}`);

  // 4. Fail-loud contract: a zero (or negative) multiplier MUST throw, never
  //    silently return the raw answer.
  let threwZero = false;
  try {
    sharePriceFromFeed(ANSWER, DECIMALS, 0n);
  } catch {
    threwZero = true;
  }
  check("multiplier 0 THROWS (fail-loud, no silent raw fallback)", threwZero);

  let threwNeg = false;
  try {
    sharePriceFromFeed(ANSWER, DECIMALS, -1n);
  } catch {
    threwNeg = true;
  }
  check("multiplier < 0 THROWS", threwNeg);
  console.log("");
}

async function main() {
  syntheticChecks(); // offline + deterministic first — never blocked by RPC.
  await liveChecks();

  console.log("─".repeat(60));
  if (failures === 0) {
    console.log("✅ ALL CHECKS PASSED");
    process.exit(0);
  } else {
    console.log(`❌ ${failures} CHECK(S) FAILED`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("probe crashed:", e);
  process.exit(1);
});
