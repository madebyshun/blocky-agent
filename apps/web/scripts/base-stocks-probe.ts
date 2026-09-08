/**
 * Blue Hood — Base B20 stock source probe (Phase 2).
 *
 * TWO independent checks, both must pass (exits non-zero on any failure — a
 * check that always exits 0 is not a check):
 *
 *   A. LIVE — read every BASE_STOCKS ticker end-to-end from Base mainnet and print the
 *      multiplier-adjusted share price, the raw total-return value, the DEX
 *      spot, the drift, and every suppression gate. Assert each share price
 *      lands in a sane per-ticker band, AND that it satisfies the division
 *      identity `share == total_return ÷ (multiplier / 1e18)`. This is the
 *      "sharePrice matches the REAL stock price (~$215), not $215 × multiplier"
 *      acceptance test.
 *
 *   B. SYNTHETIC — every registered token reports multiplier == 1e18 today, which
 *      makes the live division a no-op, so the hazard needs a second venue that
 *      does not depend on the market. We feed a FIXED answer through
 *      `sharePriceFromFeed` with multipliers ≠ 1e18 and assert the division
 *      actually happens (2× ⟹ half price; 1.05× ⟹ 205, not 215; 1.02× ⟹ the
 *      post-dividend case from the B20 spec) and that a zero multiplier THROWS.
 *
 * ⚠️ A AND B ARE NOT REDUNDANT, and A used to opt out of its half. B tests the
 * FUNCTION `sharePriceFromFeed` in isolation; A tests the WIRING — that
 * `readBaseStockQuote` actually hands that function this token's real multiplier.
 * A caller that passes `WAD` instead of `tok.multiplier` leaves B perfectly green
 * (the function is still correct!) and is visible ONLY to A. That is the shape a
 * refactor produces, so A is the load-bearing half for exactly the bug most
 * likely to be introduced.
 *
 * And A used to skip itself. The live identity was written
 * `if (q.multiplier_is_unit) { assert share == total }` — an assertion that only
 * ran while the multiplier was exactly 1e18, i.e. one that RETIRES ITSELF the
 * moment the thing it guards starts happening. Base's B20 spec folds cash
 * dividends into the multiplier rather than distributing them ("the multiplier
 * increases to 1.02"), so the first ex-dividend date on any of the six
 * dividend-paying tickers would have switched it off silently.
 *
 * MEASURED, not argued (scratch worktree, 2026-09-08): with the call site passing
 * WAD and the multiplier reading 1.02e18, the OLD probe exited 0 and printed
 * "ALL CHECKS PASSED" with zero FAIL lines while all 7 tickers served a price 2%
 * too high — inside every band, so nothing else caught it either. The new
 * unconditional identity failed all 7 and named each one with its expected value.
 * Anything it genuinely cannot check lands in the `skipped` ledger, which prints
 * next to the verdict. (#224.)
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

/**
 * Assertions that legitimately could NOT run this cycle (e.g. a suppressed quote
 * has no price to divide). These are not failures — but they are not allowed to
 * be silent either, which is the whole defect #224 is about: a check that stops
 * running while the summary line still says ALL CHECKS PASSED. Everything here
 * is reprinted next to that line, so the operator sees the hole.
 */
const skipped: string[] = [];
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
  // A 2× is NOT uncovered, it is covered ELSEWHERE and better: the
  // `share == total-return ÷ multiplier` identity below asserts exact equality,
  // so a dropped or doubled division shows up there regardless of magnitude.
  // This band still catches the errors that check cannot: ÷100 ⇒ $1.38 and
  // ×100 ⇒ $13,830 both blow through.
  //
  // ⚠️ That sentence used to read "*while* the multiplier reads 1e18" — and the
  // hedge was load-bearing, because the identity check really did switch itself
  // off above 1e18. MSTR pays no dividend, but a split or any other rebase moves
  // its multiplier too, and on THIS row a self-retiring identity check meant a 2×
  // would have had no cover at all: the band can't see it and the check wouldn't
  // have run. The identity is now unconditional, so the caveat is gone rather
  // than merely reworded.
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

    // ── The division identity, asserted at EVERY multiplier ──────────────────
    //
    // ⚠️ This check used to read `if (q.multiplier_is_unit) { ... }` — it only
    // ran while the multiplier happened to be exactly 1e18. That is a gate that
    // RETIRES ITSELF. Base's B20 spec is explicit that a cash dividend is not
    // distributed but folded into the multiplier ("After a dividend on a
    // tokenized equity, the multiplier increases to 1.02"), so the first
    // dividend on any ticker would have silently switched this assertion off —
    // and the probe would have gone on printing "ALL CHECKS PASSED" with the
    // strongest check in the file no longer running. Six of the seven tickers
    // pay dividends. (#224, same family as #222.)
    //
    // The identity below holds at ANY multiplier:
    //     share == total_return ÷ (multiplier / 1e18)
    // At multiplier == 1e18 it reduces exactly to the old `share == total_return`,
    // so nothing is lost — and above 1e18 it is strictly stronger, because it is
    // the ONLY thing here that can catch a dropped or doubled division on a
    // ticker whose saneBand is too wide to notice one. MSTR is exactly that
    // ticker; see the SANE_BAND note.
    if (q.multiplier === null) {
      check(
        `${stock.ticker} multiplier readable for the division identity`,
        false,
        "multiplier() unreadable — the division identity CANNOT be checked for this ticker",
      );
    } else if (q.share_price_usd === null || q.total_return_value_usd === null) {
      // A suppressed quote legitimately has no price, so this is not a failure —
      // but it is never allowed to be SILENT. It lands in the skipped ledger and
      // is reprinted at the end, so "ALL CHECKS PASSED" can't hide a hole.
      skipped.push(
        `${stock.ticker} division identity — no price to check ` +
          `(share=${q.share_price_usd === null ? "null" : "ok"}, ` +
          `total_return=${q.total_return_value_usd === null ? "null" : "ok"}, ` +
          `reason=${q.suppressed_reason ?? "unknown"})`,
      );
    } else {
      const mult = Number(BigInt(q.multiplier)) / Number(WAD);
      const expected = q.total_return_value_usd / mult;
      check(
        `${stock.ticker} share == total-return ÷ multiplier (×${mult})`,
        approx(q.share_price_usd, expected, 1e-6),
        `share=$${q.share_price_usd.toFixed(6)}  tr=$${q.total_return_value_usd.toFixed(6)}  ` +
          `mult=${mult}  expected=$${expected.toFixed(6)}`,
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

  // 3b. THE DIVIDEND CASE — multiplier == 1.02×WAD. Not a hypothetical: this is
  //     the exact number from Base's B20 spec, "After a dividend on a tokenized
  //     equity, the multiplier increases to 1.02". A cash dividend is NOT
  //     distributed to holders, it is folded into the multiplier, so this is the
  //     scheduled, dated event that takes any ticker off 1e18. Six of our seven
  //     pay dividends; the first ex-div date is when the live identity check
  //     above stops being a no-op and starts doing real work.
  //
  //     A dropped division here is small and therefore INVISIBLE to every band in
  //     this file: $215.33 vs $211.11 is a 2% gap, well inside even the tight
  //     NVDA band and nowhere near the registry's wider one. That is what makes
  //     the identity the only thing that can catch it.
  const m102 = (102n * WAD) / 100n;
  const afterDiv = sharePriceFromFeed(ANSWER, DECIMALS, m102);
  check(
    "multiplier 1.02e18 (post-dividend, per B20 spec) ⇒ share ≈ raw/1.02",
    approx(afterDiv, raw / 1.02, 1e-4),
    `got $${afterDiv.toFixed(4)} (expected $${(raw / 1.02).toFixed(4)})`,
  );
  check(
    "a 2% dividend rebase is too small for any sane band ⇒ only the identity catches it",
    !approx(afterDiv, raw, 1e-4) && Math.abs(afterDiv - raw) / raw < 0.05,
    `gap=${(((raw - afterDiv) / raw) * 100).toFixed(2)}% — under every SANE_BAND width`,
  );

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
  // The skipped ledger prints BEFORE the verdict, always, even on a clean run.
  // #224 was not "a check computed the wrong answer" — it was "a check quietly
  // stopped running while the last line still said ALL CHECKS PASSED". A green
  // summary that can't be read without also reading what didn't run is the fix.
  if (skipped.length > 0) {
    console.log(`⚠️  ${skipped.length} ASSERTION(S) SKIPPED — not failures, but NOT verified:`);
    for (const s of skipped) console.log(`     • ${s}`);
    console.log("─".repeat(60));
  }
  if (failures === 0) {
    console.log(
      skipped.length === 0
        ? "✅ ALL CHECKS PASSED"
        : `✅ ALL CHECKS PASSED (with ${skipped.length} skipped — see above)`,
    );
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
