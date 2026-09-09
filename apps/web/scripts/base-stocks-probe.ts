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
 *      ⚠️ B NO LONGER LIVES HERE — it is imported from
 *      `scripts/b20-multiplier-check.ts` and called below, so there is exactly
 *      ONE copy of these cases. It moved because it was hermetic all along while
 *      trapped in a probe that is not: this file is `npm run test:base-stocks`
 *      and matches no discovery pattern, so B had never once run in CI despite
 *      needing neither network nor secrets. `*-check.ts` is auto-discovered by
 *      `run-tests.ts`, so it now runs on every PR. (#224-residue.)
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
 * ⚠️ AND THIS PROBE HAS NO SCHEDULED RUNNER. That is the residue #224 left: the
 * identity is unconditional now, but "unconditional" only matters if something
 * evaluates it, and the only caller is a human typing the command below. So the
 * check ALSO runs in production — `readBaseStockQuote` calls
 * `verifySharePriceIdentity` on every read, and the Base desk poll reads
 * `multiplier()` every 5 minutes anyway, giving the identity ~288 evaluations a
 * day at zero extra cron/Upstash cost. This probe stays as the manual deep read
 * (it prints every gate and every price); production is what makes it continuous.
 *
 * Run: `npm run test:base-stocks` (from apps/web).
 */
import { readBaseStockQuote, WAD } from "../src/lib/base-stocks/b20-quote";
import {
  runSyntheticChecks,
  runIdentityChecks,
  runBandCoverageChecks,
  SANE_BAND,
} from "./b20-multiplier-check";
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

// Acceptance bands moved to `b20-multiplier-check.ts` (#224-residue). They are
// unchanged in content, but the coverage assertion over them now runs on every
// PR instead of only when a human types `npm run test:base-stocks` — which is
// how TSLA reached production on 2026-09-09 with no band at all. See the ⚠️
// block above `SANE_BAND` there for the rule and the reasoning per ticker.

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
        `identity=${q.share_price_identity.status}`,
        `reason=${q.suppressed_reason ?? "—"}`,
      ].join("  "),
    );
    if (q.dex_pool_url) console.log(`        pool: ${q.dex_pool_url}`);
    console.log(
      `        feed_age=${q.feed_age_seconds ?? "—"}s  liquidity=$${fmt(q.dex_liquidity_usd, 0)}  vol24h=$${fmt(q.dex_volume_24h_usd, 0)}`,
    );

    // Acceptance assertions. Band PRESENCE is asserted once, up in
    // `runBandCoverageChecks` (which CI runs) — not re-asserted per ticker here,
    // because two copies of one assertion drift and the copy that drifts is the
    // one nothing schedules. What this loop owns is the part that needs a live
    // price: does today's read fall inside it.
    const band = SANE_BAND[stock.ticker];
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
    } else if (q.share_price_usd !== null && !band) {
      // Never silent: the coverage check above already FAILED for this ticker,
      // but the skipped ledger is what makes the consequence legible — a green
      // per-ticker block that quietly lost its strongest assertion is #224.
      skipped.push(`${stock.ticker} share-price band range (no band defined — see check C)`);
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

    // ── Does PRODUCTION agree? (#224-residue) ────────────────────────────────
    // Everything above is this probe's own arithmetic. `readBaseStockQuote` now
    // runs the same identity itself, on every read, which is what gives the
    // check a runner instead of a volunteer. So assert the two verdicts MATCH.
    //
    // This is not a tautology: the probe derived `expected` with its own
    // `approx` and its own float division a few lines up and never called
    // `verifySharePriceIdentity`. Comparing conclusions is a cross-check;
    // comparing a value against the function that produced it would not be.
    //
    // The point is to catch the runner going quiet. If someone removes the call
    // from `readBaseStockQuote`, `share_price_identity` degrades to a constant
    // and stops tracking reality — and this line is what notices, rather than
    // production silently not checking while the probe still says PASSED.
    const probeVerdict: "ok" | "mismatch" | "unchecked" =
      q.multiplier === null || q.share_price_usd === null || q.total_return_value_usd === null
        ? "unchecked"
        : approx(q.share_price_usd, q.total_return_value_usd / (Number(BigInt(q.multiplier)) / Number(WAD)), 1e-6)
          ? "ok"
          : "mismatch";
    check(
      `${stock.ticker} production identity verdict agrees with this probe`,
      q.share_price_identity.status === probeVerdict,
      `production=${q.share_price_identity.status} probe=${probeVerdict}` +
        `${q.share_price_identity.detail ? ` (${q.share_price_identity.detail})` : ""}`,
    );
    // An unverified identity must never be firable. Structural in b20-quote.ts
    // (`can_fire` ANDs on it), asserted here against the live object.
    check(
      `${stock.ticker} identity != ok ⇒ can_fire == false`,
      q.share_price_identity.status === "ok" || q.can_fire === false,
      `identity=${q.share_price_identity.status} can_fire=${q.can_fire}`,
    );

    console.log("");
  }
}

/**
 * B. SYNTHETIC — delegated to `b20-multiplier-check.ts` so there is exactly ONE
 * copy of these cases. That file is `*-check.ts`, so `npm test` discovers it and
 * runs it on every PR; this probe calls the same functions with its own reporter
 * so `npm run test:base-stocks` still covers both halves in one command.
 *
 * Do NOT re-inline them here "for convenience": two copies of an assertion drift,
 * and the one that drifts is always the one nothing schedules.
 */
function syntheticChecks() {
  runSyntheticChecks(check);
  runIdentityChecks(check);
  // Run BEFORE the live half on purpose: a missing acceptance band means the
  // live loop below is about to skip its strongest per-ticker assertion, and the
  // operator should learn that at the top of the output, not infer it from an
  // absence hundreds of lines down.
  runBandCoverageChecks(check);
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
