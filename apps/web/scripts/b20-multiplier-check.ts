/**
 * B20 multiplier math + share-price identity — the HERMETIC half. (#224-residue.)
 *
 * ── Why this file exists as its own suite ─────────────────────────────────────
 * #224 fixed a check that retired itself: the probe's live division identity was
 * written `if (q.multiplier_is_unit) { ... }`, so it only ran while the multiplier
 * was exactly 1e18 — i.e. it switched off the moment the thing it guards started
 * happening. The fix made the identity unconditional. What the fix did NOT come
 * with was a runner.
 *
 * `scripts/base-stocks-probe.ts` is invoked by `npm run test:base-stocks` and by
 * nothing else. It does not match `run-tests.ts`'s `*-(test|check).ts` discovery
 * pattern, and no GitHub workflow calls that script. So the strongest assertion
 * about B20 pricing has been running on the days a human remembered to type the
 * command — which is the same self-silencing failure one level up: not "the check
 * is wrong" but "the check is not running and nothing says so".
 *
 * The probe cannot simply be renamed into the suite: half of it (Check A) reads
 * Base mainnet over RPC, and `run-tests.ts` requires hermetic suites because CI
 * runs with an empty environment. So the halves are split by what they need:
 *
 *   • THIS FILE — pure math, no network, no KV, no secrets. Auto-discovered by
 *     `npm test`, therefore runs on every PR via the `verify` job. It owns the
 *     synthetic `sharePriceFromFeed` cases (moved here from the probe, where they
 *     had never once run in CI) and the `verifySharePriceIdentity` tri-state.
 *
 *   • THE 5-MINUTE BASE DESK POLL — the live wiring check. `readBaseStockQuote`
 *     now calls `verifySharePriceIdentity` on every read, and the poll cron
 *     already reads `multiplier()` each cycle, so the identity is evaluated ~288
 *     times a day in production at zero extra cron/Upstash cost (#148). See the
 *     `verifySharePriceIdentity` doc comment.
 *
 *   • `npm run test:base-stocks` — still the live end-to-end probe. It imports
 *     the two functions below so there is exactly ONE copy of the synthetic
 *     cases; a second copy would drift.
 *
 * ── What this suite can and cannot prove ─────────────────────────────────────
 * It proves the FUNCTIONS are correct. It cannot prove the WIRING is correct —
 * a `readBaseStockQuote` that passes `WAD` instead of `tok.multiplier` leaves
 * every assertion here green, because the functions are still right. That is
 * Check A's job, and now also the poll's. Stated explicitly because the gap is
 * exactly the one #224 was about, and a suite that implies coverage it does not
 * have is worse than one that names its hole.
 *
 * Run: `npm test` (auto), or `npx tsx scripts/b20-multiplier-check.ts`.
 */
import {
  sharePriceFromFeed,
  verifySharePriceIdentity,
  WAD,
} from "../src/lib/base-stocks/b20-quote";
// Pure data module — an `as const` array plus two lookups, no env reads and no
// network, so importing it keeps this suite hermetic (run-tests.ts runs with an
// empty environment).
import { BASE_STOCKS } from "../src/lib/base-stocks/registry";

/** Reporter injected by the caller so the probe and this suite share one copy of
 *  the cases while keeping their own pass/fail bookkeeping and output style. */
export type Report = (name: string, ok: boolean, detail?: string) => void;

function approx(a: number, b: number, tolPct = 0.001) {
  return Math.abs(a - b) <= Math.abs(b) * tolPct + 1e-9;
}

/**
 * The multiplier division itself. Moved verbatim-in-substance from
 * `base-stocks-probe.ts::syntheticChecks` — same cases, same reasoning, now in a
 * file `npm test` actually discovers.
 */
export function runSyntheticChecks(check: Report) {
  console.log("=== A. SYNTHETIC multiplier math (the hazard test) ===\n");
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
  //     scheduled, dated event that takes any ticker off 1e18. Most of the desk
  //     pays dividends; the first ex-div date is when the live identity check
  //     stops being arithmetically vacuous and starts doing real work.
  //
  //     A dropped division here is small and therefore INVISIBLE to every sane
  //     band: $215.33 vs $211.11 is a 2% gap, well inside even a tight NVDA band
  //     and nowhere near the registry's wider one. That is what makes the
  //     identity the only thing that can catch it.
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

/**
 * The runtime cross-check that now runs inside `readBaseStockQuote` on every
 * Base desk poll. Three states, and "unchecked" is deliberately NOT a pass.
 */
export function runIdentityChecks(check: Report) {
  console.log("=== B. verifySharePriceIdentity — the runtime cross-check ===\n");

  const TR = 215.3302; // total-return value straight off the feed

  // ── ok ─────────────────────────────────────────────────────────────────────
  const unit = verifySharePriceIdentity({
    share_price_usd: TR,
    total_return_value_usd: TR,
    multiplier: WAD,
  });
  check("multiplier 1e18, share == total_return ⇒ ok", unit.status === "ok", `status=${unit.status} detail=${unit.detail}`);
  check("ok carries multiplier_x == 1", unit.multiplier_x === 1, `got ${unit.multiplier_x}`);

  const m102 = (102n * WAD) / 100n;
  const rebasedOk = verifySharePriceIdentity({
    share_price_usd: TR / 1.02,
    total_return_value_usd: TR,
    multiplier: m102,
  });
  check("multiplier 1.02e18, share == tr/1.02 ⇒ ok", rebasedOk.status === "ok", `status=${rebasedOk.status} detail=${rebasedOk.detail}`);

  // ── mismatch — THE POINT OF THE WHOLE TASK ────────────────────────────────
  // This is the WAD-substitution bug expressed as data: a call site that passed
  // `WAD` instead of the token's real 1.02e18 multiplier produces a share price
  // equal to the raw total-return value. Today no live ticker can produce this
  // shape (every registered multiplier reads exactly 1e18), which is precisely
  // why it has to be constructed here rather than waited for.
  const wadSubstitution = verifySharePriceIdentity({
    share_price_usd: TR, // ← what `sharePriceFromFeed(answer, dec, WAD)` returns
    total_return_value_usd: TR,
    multiplier: m102, // ← what the token actually reports
  });
  check(
    "WAD passed instead of a 1.02e18 multiplier ⇒ mismatch",
    wadSubstitution.status === "mismatch",
    `status=${wadSubstitution.status}`,
  );
  check(
    "mismatch names the expected value (an operator can act on it)",
    wadSubstitution.detail !== null && wadSubstitution.detail.includes("211.1"),
    wadSubstitution.detail ?? "(no detail)",
  );
  check(
    "mismatch reports expected_share_usd ≈ tr/1.02",
    wadSubstitution.expected_share_usd !== null && approx(wadSubstitution.expected_share_usd, TR / 1.02, 1e-6),
    `got ${wadSubstitution.expected_share_usd}`,
  );

  // A 2% gap is the SMALLEST realistic one (the first dividend). Confirm the
  // tolerance is nowhere near wide enough to swallow it — a check whose epsilon
  // exceeds the defect it hunts is decorative.
  const tiny = verifySharePriceIdentity({
    share_price_usd: TR * 1.0001, // 1 basis point out
    total_return_value_usd: TR,
    multiplier: WAD,
  });
  check("a 1bp divergence is still a mismatch (tolerance is rounding-only)", tiny.status === "mismatch", `status=${tiny.status}`);

  // ...and that it does tolerate genuine float-vs-bigint rounding, or the desk
  // would suppress every ticker forever, which is its own outage.
  const rounding = verifySharePriceIdentity({
    share_price_usd: TR * (1 + 1e-9),
    total_return_value_usd: TR,
    multiplier: WAD,
  });
  check("a 1e-9 relative divergence is tolerated (bigint vs float rounding)", rounding.status === "ok", `status=${rounding.status}`);

  // ── unchecked — must never be reported as ok ──────────────────────────────
  const noMult = verifySharePriceIdentity({
    share_price_usd: TR,
    total_return_value_usd: TR,
    multiplier: null,
  });
  check("multiplier unreadable ⇒ unchecked, NOT ok", noMult.status === "unchecked", `status=${noMult.status}`);
  check("unchecked says why", noMult.detail !== null && noMult.detail.length > 0, noMult.detail ?? "(no detail)");

  const zeroMult = verifySharePriceIdentity({
    share_price_usd: TR,
    total_return_value_usd: TR,
    multiplier: 0n,
  });
  check("multiplier 0 ⇒ unchecked (no division by zero, no false ok)", zeroMult.status === "unchecked", `status=${zeroMult.status}`);

  const noShare = verifySharePriceIdentity({
    share_price_usd: null,
    total_return_value_usd: TR,
    multiplier: WAD,
  });
  check("share price null ⇒ unchecked", noShare.status === "unchecked", `status=${noShare.status}`);

  const noTr = verifySharePriceIdentity({
    share_price_usd: TR,
    total_return_value_usd: null,
    multiplier: WAD,
  });
  check("total_return null ⇒ unchecked", noTr.status === "unchecked", `status=${noTr.status}`);

  // The tri-state must be exhaustive — a fourth value would silently bypass
  // every `status === "ok"` gate in b20-quote.ts as neither ok nor an offender.
  const all = [unit, rebasedOk, wadSubstitution, tiny, rounding, noMult, zeroMult, noShare, noTr];
  check(
    "every result is one of ok | mismatch | unchecked",
    all.every((r) => r.status === "ok" || r.status === "mismatch" || r.status === "unchecked"),
    `saw ${[...new Set(all.map((r) => r.status))].sort().join(", ")}`,
  );
  console.log("");
}

// ── C. Acceptance-band coverage ─────────────────────────────────────────────
//
// Sane per-ticker share-price bands used by the LIVE probe. Wide enough to
// survive normal market drift over days, tight enough that a ×multiplier / scale
// bug (which would 2×, 100×, or 1e18× the value) blows straight through them.
//
// ⚠️ These live HERE rather than in the probe, and the move is the whole point.
// The probe already failed a missing band loudly — but the probe has no
// scheduled runner, so on 2026-09-09 TSLA shipped to production (#228) with no
// band and the failure sat unread in a command nobody typed. Held here, the
// coverage assertion below runs on every PR via `npm test`, and the next
// admission cannot merge without its row. This is #224-residue applied one level
// out: the earlier fix made the check unconditional, this one makes it observed.
//
// ⚠️ These are DELIBERATELY NOT the registry's `saneBand`, and must never be
// derived from it. `b20-quote.ts` already suppresses any price outside
// `stock.saneBand` before the probe ever sees it, so asserting production's
// output against production's own band is a tautology that can never fail.
// The value here is an INDEPENDENT second opinion, held tighter on purpose —
// registry bands are a wide "don't publish an absurdity" backstop, these are a
// narrow "does today's read look like the actual stock" acceptance test. That
// intent is now ENFORCED (strictly-inside assertion below), because a comment
// asking future readers not to copy the registry band is not a mechanism.
export const SANE_BAND: Record<string, [number, number]> = {
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
  // `share == total-return ÷ multiplier` identity asserts exact equality, so a
  // dropped or doubled division shows up there regardless of magnitude.
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
  // Admitted 2026-09-08 (#228), band added 2026-09-09 — see the ⚠️ above; the
  // row was missing for a day because nothing scheduled the probe that checks.
  // Anchor: oracle share price $368.96 at admission, cross-checked against an
  // independent public quote of $367.79. 52w $297.38–$498.83, so the floor sits
  // 23% under the 52w low and the ceiling 24% over the 52w high — real room —
  // while ÷2 ⇒ $184 and 2× ⇒ $738 both land outside. Unlike MSTR, TSLA's 52w
  // range (1.68× wide) still leaves a doubling detectable, so this row does the
  // job MSTR's cannot; do not widen it to "match the others".
  TSLA: [230, 620],
};

/** Hermetic: every admitted ticker owns an acceptance band, and that band is a
 *  genuinely independent second opinion rather than a copy of the registry's. */
export function runBandCoverageChecks(check: Report) {
  console.log("=== C. Acceptance-band coverage (every admitted ticker) ===\n");

  // Derived from the registry, never a literal list — a hardcoded roster would
  // need the same manual update as the band itself and would go stale together
  // with it, which is precisely the failure this check exists to catch.
  for (const stock of BASE_STOCKS) {
    const band = SANE_BAND[stock.ticker];
    check(
      `${stock.ticker} (admitted ${stock.admittedAt}) has a probe acceptance band`,
      band !== undefined,
      band ? `[$${band[0]}, $${band[1]}]` : "MISSING — add a row to SANE_BAND before admitting a ticker",
    );
    if (!band) continue;
    check(`${stock.ticker} band is non-degenerate (lo < hi)`, band[0] < band[1], `[${band[0]}, ${band[1]}]`);
    // Strictly INSIDE the registry band on both edges. Equality is a failure,
    // not a pass: an edge copied from the registry is the tautology the comment
    // above warns about, and production has already suppressed anything outside
    // it, so a copied edge can never fire.
    check(
      `${stock.ticker} band is strictly tighter than the registry saneBand (not a copy)`,
      band[0] > stock.saneBand.lo && band[1] < stock.saneBand.hi,
      `probe [$${band[0]}, $${band[1]}] vs registry [$${stock.saneBand.lo}, $${stock.saneBand.hi}]`,
    );
  }

  // The reverse direction: a band for a ticker that is no longer admitted is
  // dead weight that reads as coverage. Cheap to assert, and it keeps the map
  // honest when a ticker is ever withdrawn.
  const admitted = new Set(BASE_STOCKS.map((s) => s.ticker));
  const orphans = Object.keys(SANE_BAND).filter((t) => !admitted.has(t));
  check("no band for a ticker that is not in BASE_STOCKS", orphans.length === 0,
    orphans.length ? `orphans: ${orphans.join(", ")}` : `${admitted.size} tickers, ${Object.keys(SANE_BAND).length} bands`);
  console.log("");
}

// ── Standalone entry ────────────────────────────────────────────────────────
// Guarded so `base-stocks-probe.ts` can import the functions above without
// this block firing and calling process.exit() out from under it.
if ((process.argv[1] ?? "").endsWith("b20-multiplier-check.ts")) {
  let failures = 0;
  const check: Report = (name, ok, detail = "") => {
    console.log(`${ok ? "  ok " : "FAIL "} ${name}${detail ? `  — ${detail}` : ""}`);
    if (!ok) failures++;
  };
  runSyntheticChecks(check);
  runIdentityChecks(check);
  runBandCoverageChecks(check);
  if (failures === 0) {
    console.log("✅ ALL CHECKS PASSED");
    process.exit(0);
  }
  console.log(`❌ ${failures} CHECK(S) FAILED`);
  process.exit(1);
}
