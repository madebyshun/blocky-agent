/**
 * Blue Hood — Base P3 WIRE probe (the pre-PR checkpoint).
 *
 * Phase 2 (`base-stocks-probe.ts`) proved the Base DATA SOURCE reads a correct,
 * multiplier-adjusted share price. This probe proves the Base rows are WIRED
 * into the chain-agnostic arrow engine correctly — the four gates ShunTr asked
 * to see answered before the PR, each DEMONSTRATED (a real blocked/allowed case)
 * rather than merely present in the code:
 *
 *   GATE 1 — multiplier/pause/identity guard blocks an arrow VIA can_fire.
 *     A suppressed BaseStockQuote (paused / bad-multiplier / share-price
 *     identity mismatch, `can_fire:false`) maps to a snapshot row that is
 *     UNGRADEABLE (verdict INSUFFICIENT_DATA AND drift_pct null), and
 *     `detectCandidate` / `detectArrow` return null for it. A healthy quote with
 *     the SAME shape but `can_fire:true` DOES yield a candidate — so the block is
 *     meaningful, not "everything returns null".
 *     The identity case (#224-residue) additionally asserts the verdict rides
 *     the row as a warning on EVERY branch, green ones included: a marker that
 *     appears only on failure cannot distinguish "never broke" from "stopped
 *     checking", which is the defect #224-residue exists to close.
 *
 *   GATE 2 — dead-pool liveness gate applies to Base (pool vol > 0, as for RH).
 *     A healthy Base drift row with `volume_24h_usd === 0` is dropped by
 *     `detectArrow` (dead pool); the identical row with real volume fires.
 *
 *   GATE 3 — pool correct · M5-comparable · arrow labelled with chain.
 *     Live `pollBaseStocks()`: every row is `chain:"base"`, carries the real
 *     Aerodrome `pool_ref`, and its `drift_pct` uses the SAME sign convention as
 *     RH M5 (positive ⟹ DEX above oracle) so a Base row and an RH row are
 *     directly comparable. `chainOf(row)` — the exact value `fireArrow` stamps
 *     onto the arrow — resolves to "base" (vs "robinhood" for a chain-less row).
 *
 *   GATE 4 — the grader reprices a Base arrow against the BASE quote, not RH.
 *     `readGradePrices(baseArrow(NVDA))` triple-matches an INDEPENDENT
 *     `readBaseStockQuote("NVDA")` (dex / oracle / drift). A coincidental match
 *     against the RH NVDA pool's drift is not possible, and the RH-routed read
 *     of the same ticker returns a DIFFERENT number — proving the chain routing.
 *
 * Gates 1–2 are offline + deterministic (never blocked by RPC). Gates 3–4 read
 * Base mainnet live. Exits non-zero on any hard failure.
 *
 * Run: `npm run test:base-hood-wire` (from apps/web).
 */
import {
  baseQuoteToSnapshot,
  baseVerdict,
  pollBaseStocks,
} from "../src/lib/base-stocks/base-poller";
import {
  readBaseStockQuote,
  verifySharePriceIdentity,
  type BaseStockQuote,
} from "../src/lib/base-stocks/b20-quote";
import { BASE_STOCKS, findBaseStock } from "../src/lib/base-stocks/registry";
import { detectCandidate, detectArrow } from "../src/lib/blue-hood/rule-engine";
import { readGradePrices } from "../src/lib/blue-hood/grader";
import { chainOf, type Arrow } from "../src/lib/blue-hood/types";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  const mark = ok ? "  ok " : "FAIL ";
  console.log(`${mark} ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
}
function approx(a: number, b: number, tolPct = 0.005) {
  return Math.abs(a - b) <= Math.abs(b) * tolPct + 1e-9;
}

/** Market clock for a CLOSED afterhours session — the regime where drift fires. */
const CLOSED_MARKET = {
  is_open: false,
  session: "afterhours" as const,
  ny_time_iso: "2026-08-23T18:00:00-04:00",
};
/** Market clock for a live OPEN regular session — the regime where arb fires. */
const OPEN_MARKET = {
  is_open: true,
  session: "regular" as const,
  ny_time_iso: "2026-08-24T11:00:00-04:00",
};

/**
 * A healthy, gradeable NVDA-shaped BaseStockQuote. Share $215, DEX $225 ⟹ drift
 * +4.65% (well over the 2% drift floor), deep pool, real volume, all gates green.
 * Overrides let each gate craft the exact case it needs.
 *
 * #224-residue — `share_price_identity` is DERIVED by calling the production
 * verifier on the fixture's own post-override price triple, never hardcoded to
 * `"ok"`. A hardcoded verdict would make this probe assert that the wiring
 * carries a constant, which stays green even if the identity stops being
 * computed — the exact shape of the defect #224-residue exists to close. Derived,
 * a case that overrides the multiplier or nulls a price gets the verdict
 * production would compute for it.
 */
function healthyQuote(over: Partial<BaseStockQuote> = {}): BaseStockQuote {
  const share = 215;
  const dex = 225;
  const q: BaseStockQuote = {
    ticker: "NVDA",
    token: "0xb20000000000000000000078ee7ce2fE4908108C",
    share_price_usd: share,
    total_return_value_usd: share,
    multiplier: "1000000000000000000",
    multiplier_is_unit: true,
    feed_answer_raw: "21500000000",
    feed_decimals: 8,
    feed_updated_at: Math.floor(Date.now() / 1000) - 60,
    feed_age_seconds: 60,
    feed_is_stale: false,
    price_in_band: true,
    dex_price_usd: dex,
    dex_pool_address: "0x1111111111111111111111111111111111111111",
    dex_liquidity_usd: 100_000,
    dex_volume_24h_usd: 50_000,
    dex_pool_url: "https://aerodrome.finance/pool/0x1111",
    drift_pct: ((dex - share) / share) * 100,
    impostor_ok: true,
    sequencer: { up: true, started_at: 1, seconds_since_change: 999_999, within_grace: false, ok: true },
    sequencer_ok: true,
    paused: false,
    multiplier_ok: true,
    can_fire: true,
    suppressed_reason: null,
    // Placeholder — overwritten below from the FINAL field values. Present only
    // because the field is required (and required on purpose: tsc refusing is
    // stronger than a reviewer noticing).
    share_price_identity: { status: "unchecked", detail: "not yet derived", multiplier_x: null, expected_share_usd: null },
    ...over,
  };
  if (over.share_price_identity === undefined) {
    q.share_price_identity = verifySharePriceIdentity({
      share_price_usd: q.share_price_usd,
      total_return_value_usd: q.total_return_value_usd,
      multiplier: q.multiplier === null ? null : BigInt(q.multiplier),
    });
  }
  return q;
}

/** Minimal Arrow for grader routing (gate 4). `chain` decides RH vs Base. */
function mkArrow(over: Partial<Arrow>): Arrow {
  return {
    id: "probe-" + Math.random().toString(36).slice(2),
    serial: "#TEST",
    ticker: "NVDA",
    type: "drift",
    expected_direction: "down",
    grading_window_h: 6,
    reference_price: 100,
    snapshot_refs: [],
    fired_at: new Date().toISOString(),
    status: "open",
    outcome: null,
    graded_at: null,
    outcome_detail: null,
    origin: "engine",
    ...over,
  };
}

// ── GATE 1 ───────────────────────────────────────────────────────────────────
function gate1_multiplierPauseGuard() {
  console.log("\n=== GATE 1 — pause / bad-multiplier blocked via can_fire ===\n");

  // (a) PAUSED: real share + DEX prices EXIST on the quote (paused doesn't null
  //     them) and drift_pct is a real number — but can_fire:false must force the
  //     snapshot UNGRADEABLE anyway. This is the belt-and-suspenders case.
  const paused = healthyQuote({
    paused: true,
    can_fire: false,
    suppressed_reason: "paused",
    // leave share/dex/drift populated to prove the snapshot nulls drift regardless
  });
  const pausedRow = baseQuoteToSnapshot(paused, "NVIDIA Corporation", CLOSED_MARKET, 0);
  check("paused → verdict INSUFFICIENT_DATA", pausedRow.verdict === "INSUFFICIENT_DATA", pausedRow.verdict);
  check("paused → drift_pct null (guard 2, even though quote had a drift)", pausedRow.drift_pct === null,
    `quote.drift=${paused.drift_pct?.toFixed(2)}% → row.drift=${pausedRow.drift_pct}`);
  check("paused → row.chain === 'base'", chainOf(pausedRow) === "base");
  check("paused → warnings surface reason", pausedRow.warnings.includes("base_suppressed_paused"),
    JSON.stringify(pausedRow.warnings));
  check("paused → detectCandidate() null (no arrow)", detectCandidate(pausedRow) === null);
  check("paused → detectArrow() null (no arrow)", detectArrow(pausedRow) === null);

  // (b) BAD MULTIPLIER (hazard #1): share_price_usd null, drift null on the quote.
  const badMult = healthyQuote({
    share_price_usd: null,
    multiplier: "0",
    multiplier_is_unit: false,
    multiplier_ok: false,
    drift_pct: null,
    can_fire: false,
    suppressed_reason: "multiplier_invalid",
  });
  const badMultRow = baseQuoteToSnapshot(badMult, "NVIDIA Corporation", CLOSED_MARKET, 0);
  check("bad-multiplier → verdict INSUFFICIENT_DATA", badMultRow.verdict === "INSUFFICIENT_DATA", badMultRow.verdict);
  check("bad-multiplier → drift_pct null", badMultRow.drift_pct === null);
  check("bad-multiplier → warnings surface reason",
    badMultRow.warnings.includes("base_suppressed_multiplier_invalid"), JSON.stringify(badMultRow.warnings));
  check("bad-multiplier → detectCandidate() null (no arrow)", detectCandidate(badMultRow) === null);
  check("bad-multiplier → detectArrow() null (no arrow)", detectArrow(badMultRow) === null);

  // (c) IDENTITY MISMATCH (#224-residue, hazard #2). Constructed as the actual
  //     bug shape: a 1.02e18 multiplier (post-dividend) with the TOTAL-RETURN
  //     value left sitting in the share field — i.e. the division skipped. That
  //     is arithmetically invisible while every live multiplier is 1e18, which
  //     is exactly why it has to be a continuous runtime check and why the case
  //     has to be constructed here rather than waited for.
  //
  //     The mismatch verdict is DERIVED (healthyQuote calls the production
  //     verifier), so this case cannot go vacuous: if the identity ever stopped
  //     firing on this triple, the assert below catches it before the wiring
  //     asserts do.
  const idMismatch = healthyQuote({
    multiplier: "1020000000000000000",
    multiplier_is_unit: false,
    // share_price_usd stays 215 == total_return_value_usd ⟹ 215 ≠ 215/1.02.
    can_fire: false,
    suppressed_reason: "share_price_identity_mismatch",
  });
  check("identity mismatch → fixture really is a mismatch (case not vacuous)",
    idMismatch.share_price_identity.status === "mismatch",
    idMismatch.share_price_identity.detail ?? idMismatch.share_price_identity.status);
  const idRow = baseQuoteToSnapshot(idMismatch, "NVIDIA Corporation", CLOSED_MARKET, 0);
  check("identity mismatch → verdict INSUFFICIENT_DATA", idRow.verdict === "INSUFFICIENT_DATA", idRow.verdict);
  check("identity mismatch → drift_pct null (even though the quote had one)", idRow.drift_pct === null,
    `quote.drift=${idMismatch.drift_pct?.toFixed(2)}% → row.drift=${idRow.drift_pct}`);
  check("identity mismatch → warnings carry base_identity_mismatch",
    idRow.warnings.includes("base_identity_mismatch"), JSON.stringify(idRow.warnings));
  check("identity mismatch → warnings also carry the suppression reason",
    idRow.warnings.includes("base_suppressed_share_price_identity_mismatch"), JSON.stringify(idRow.warnings));
  check("identity mismatch → detectArrow() null (no arrow)", detectArrow(idRow) === null);

  // (c2) UNCHECKED is NOT a pass — it must still be marked on the row it rode in
  //      on. The bad-multiplier row above is exactly that case (multiplier 0 ⟹
  //      nothing to divide by), and it must NOT be labelled ok.
  check("bad-multiplier → identity verdict is 'unchecked', not 'ok'",
    badMult.share_price_identity.status === "unchecked", badMult.share_price_identity.status);
  check("bad-multiplier → row carries base_identity_unchecked (not inferred from the sibling gate)",
    badMultRow.warnings.includes("base_identity_unchecked"), JSON.stringify(badMultRow.warnings));

  // (d) CONTRAST: the SAME healthy quote, can_fire:true, DOES produce a candidate.
  //     Without this, "everything returns null" would pass gate 1 vacuously.
  const healthy = healthyQuote();
  const healthyRow = baseQuoteToSnapshot(healthy, "NVIDIA Corporation", CLOSED_MARKET, 0);
  check("healthy → verdict AFTERHOURS_DRIFT (gradeable)", healthyRow.verdict === "AFTERHOURS_DRIFT", healthyRow.verdict);
  check("healthy → drift_pct ≈ +4.65%", healthyRow.drift_pct !== null && approx(healthyRow.drift_pct, 4.651, 0.01),
    `drift=${healthyRow.drift_pct?.toFixed(3)}%`);
  const cand = detectCandidate(healthyRow);
  check("healthy → detectCandidate() returns a DRIFT candidate", cand?.type === "drift", cand ? cand.type : "null");
  check("healthy → detectArrow() returns a candidate (all gates pass)", detectArrow(healthyRow) !== null);
  // The per-cycle LIVENESS marker: a green row must still say the check ran.
  // Without this, "identity ok" and "identity never computed" look identical.
  check("healthy → row carries base_identity_ok (the check ran, on a GREEN row)",
    healthyRow.warnings.includes("base_identity_ok"), JSON.stringify(healthyRow.warnings));

  // Sanity on the verdict helper itself: sign convention matches rh-stock-arb.
  check("baseVerdict: closed + drift -3% (afterhours) ⟹ AFTERHOURS_DRIFT",
    baseVerdict(-3, CLOSED_MARKET) === "AFTERHOURS_DRIFT");
  check("baseVerdict: open + drift -3% ⟹ LONG_DEX (DEX cheap)", baseVerdict(-3, OPEN_MARKET) === "LONG_DEX");
  check("baseVerdict: open + drift +3% ⟹ SHORT_DEX (DEX rich)", baseVerdict(3, OPEN_MARKET) === "SHORT_DEX");
}

// ── GATE 2 ───────────────────────────────────────────────────────────────────
function gate2_deadPoolGate() {
  console.log("\n=== GATE 2 — dead-pool liveness gate applies to Base ===\n");

  // Healthy drift row, deep pool ($100k ≥ dust+executable floors), but ZERO 24h
  // volume ⟹ the DEX print can't have moved; the "drift" is the oracle walking
  // away from a stale quote. Same gate RH uses (rule-engine.ts isDeadPool).
  const dead = baseQuoteToSnapshot(
    healthyQuote({ dex_volume_24h_usd: 0 }),
    "NVIDIA Corporation",
    CLOSED_MARKET,
    0,
  );
  check("dead pool → row.volume_24h_usd === 0", dead.volume_24h_usd === 0, String(dead.volume_24h_usd));
  check("dead pool → detectCandidate() still sees a candidate (gate is downstream)",
    detectCandidate(dead)?.type === "drift");
  check("dead pool → detectArrow() null (liveness gate drops it)", detectArrow(dead) === null);

  // Contrast: identical row with real volume fires.
  const live = baseQuoteToSnapshot(
    healthyQuote({ dex_volume_24h_usd: 50_000 }),
    "NVIDIA Corporation",
    CLOSED_MARKET,
    0,
  );
  check("live pool → detectArrow() returns a candidate", detectArrow(live) !== null,
    `vol=${live.volume_24h_usd}`);

  // And prove the liveness gate is the ONLY thing separating them: total/primary
  // TVL are identical and both over the dust floor, so only volume differs.
  check("dead vs live differ ONLY by volume (same TVL, both ≥ $5k floor)",
    dead.total_tvl_usd === live.total_tvl_usd && (dead.total_tvl_usd ?? 0) >= 5000,
    `tvl=${dead.total_tvl_usd}`);
}

// ── GATE 3 ───────────────────────────────────────────────────────────────────
async function gate3_liveLabelAndComparable() {
  console.log("\n=== GATE 3 — live: pool correct · M5-comparable · chain label ===\n");

  const rows = await pollBaseStocks(Date.now());
  // Derived from the registry, never a literal — adding a ticker (AAPL,
  // 2026-08-24) must not silently break this probe or, worse, keep passing
  // while the poller quietly drops a row.
  const expected = BASE_STOCKS.map((s) => s.ticker);
  check(
    `pollBaseStocks returned ${expected.length} rows (${expected.join("/")})`,
    rows.length === expected.length,
    `got ${rows.length}`,
  );
  check(
    "pollBaseStocks covers every registry ticker, no extras",
    expected.every((t) => rows.some((r) => r.ticker === t)) && rows.length === expected.length,
    `rows=[${rows.map((r) => r.ticker).join(",")}]`,
  );

  // A chain-less RH-style row must resolve to "robinhood" — proves the label
  // actually distinguishes the two desks (not a constant "base").
  check("chainOf({}) === 'robinhood' (RH contrast — label is real)",
    chainOf({ chain: undefined }) === "robinhood");

  for (const row of rows) {
    const priced = row.dex_usd !== null && row.oracle_usd !== null && row.drift_pct !== null;
    console.log(
      `  [${row.ticker}] chain=${row.chain} verdict=${row.verdict} ` +
        `oracle=$${row.oracle_usd?.toFixed(2) ?? "—"} dex=$${row.dex_usd?.toFixed(2) ?? "—"} ` +
        `drift=${row.drift_pct?.toFixed(3) ?? "—"}% pool=${row.pool_ref ?? "—"}`,
    );

    // arrow label chain — the EXACT value fireArrow stamps onto the arrow.
    check(`${row.ticker}: chainOf(row) === 'base'`, chainOf(row) === "base", String(row.chain));

    if (row.verdict === "ERROR") {
      // A transient RPC error is not a wiring failure — surface it, don't fail
      // the gate on infra. The row is still correctly chain-labelled (asserted
      // above) and counted as errored by the poller.
      console.log(`      (${row.ticker} errored this read: ${row.error ?? "?"} — skipping price asserts)`);
      continue;
    }

    if (priced) {
      // pool correct — a real Aerodrome pool address is attached.
      check(`${row.ticker}: pool_ref present & 0x-address`,
        typeof row.pool_ref === "string" && /^0x[0-9a-fA-F]{40}$/.test(row.pool_ref), row.pool_ref ?? "null");
      // M5-comparable — drift uses the SAME sign convention as rh-stock-arb:
      // positive ⟹ DEX above oracle. Recompute from oracle/dex and match.
      const recomputed = ((row.dex_usd! - row.oracle_usd!) / row.oracle_usd!) * 100;
      check(`${row.ticker}: drift sign convention matches (positive ⟹ DEX>oracle)`,
        Math.sign(row.drift_pct!) === Math.sign(recomputed) || Math.abs(recomputed) < 1e-9,
        `row=${row.drift_pct!.toFixed(4)}% recomputed=${recomputed.toFixed(4)}%`);
      check(`${row.ticker}: drift magnitude matches recompute`,
        approx(row.drift_pct!, recomputed, 0.001), `row=${row.drift_pct!.toFixed(4)}% vs ${recomputed.toFixed(4)}%`);
    } else {
      console.log(`      (${row.ticker} suppressed/no-DEX: verdict=${row.verdict} — chain label still asserted)`);
    }
  }
}

// ── GATE 4 ───────────────────────────────────────────────────────────────────
async function gate4_graderChainRouting() {
  console.log("\n=== GATE 4 — grader reprices a Base arrow against BASE, not RH ===\n");

  const nvda = findBaseStock("NVDA");
  if (!nvda) { check("findBaseStock('NVDA')", false, "not in registry"); return; }

  // Independent Base read — the ground truth readGradePrices must reproduce.
  const q = await readBaseStockQuote(nvda);
  const baseGradeable =
    typeof q.dex_price_usd === "number" && q.dex_price_usd > 0 &&
    typeof q.share_price_usd === "number" && q.share_price_usd > 0 &&
    typeof q.drift_pct === "number";
  console.log(
    `  independent Base NVDA: oracle=$${q.share_price_usd?.toFixed(2) ?? "—"} ` +
      `dex=$${q.dex_price_usd?.toFixed(2) ?? "—"} drift=${q.drift_pct?.toFixed(4) ?? "—"}% ` +
      `can_fire=${q.can_fire} reason=${q.suppressed_reason ?? "—"}`,
  );

  const basePrices = await readGradePrices(mkArrow({ chain: "base", ticker: "NVDA" }));

  if (baseGradeable) {
    check("Base arrow → readGradePrices returned prices (routed to Base source)", basePrices !== null);
    if (basePrices) {
      // Oracle sanity — a real multiplier-adjusted NVDA share price, NOT
      // share × 1e18. Proves the Base multiplier path, not a raw feed answer.
      // Read from the REGISTRY band rather than a literal: this probe and
      // `readBaseStockQuote` are asserting the same property (magnitude break,
      // not market move), so two hand-maintained copies could only drift apart
      // — and the tighter one would start failing on a real move that the
      // runtime happily accepts, which reads as a bug in the wrong component.
      check(`Base grade oracle in NVDA registry saneBand [$${nvda.saneBand.lo},$${nvda.saneBand.hi}]`,
        basePrices.oracle >= nvda.saneBand.lo && basePrices.oracle <= nvda.saneBand.hi,
        `$${basePrices.oracle.toFixed(2)}`);
      // The load-bearing proof it read BASE not RH: drift/dex triple-match the
      // independent Base read. RH's NVDA pool drift is an independent number;
      // matching it here to this tolerance is not possible by coincidence.
      check("Base grade dex matches independent Base read",
        approx(basePrices.dex, q.dex_price_usd!, 0.005),
        `grade=$${basePrices.dex.toFixed(4)} indep=$${q.dex_price_usd!.toFixed(4)}`);
      check("Base grade drift matches independent Base read (⟹ read Base, not RH)",
        Math.abs(basePrices.deltaPct - q.drift_pct!) < 0.05,
        `grade=${basePrices.deltaPct.toFixed(4)}% indep=${q.drift_pct!.toFixed(4)}%`);
    }
  } else {
    // Base NVDA not gradeable right now (paused / stale / no DEX). Then the
    // grader MUST soft-skip (null) rather than grade off a hazardous read —
    // that agreement is itself the correct Base-routed behaviour.
    check("Base arrow → readGradePrices null when Base quote ungradeable (soft-skip)",
      basePrices === null, `suppressed_reason=${q.suppressed_reason ?? "—"}`);
  }

  // Contrast (best-effort): the SAME ticker routed to RH goes through
  // rh-stock-arb — a DIFFERENT source, DIFFERENT pool, DIFFERENT drift. If the
  // local RH upstream is reachable, show the numbers differ; if not, skip
  // without failing (RH M5 needs a live tool call this probe can't guarantee).
  let rhPrices: { dex: number; oracle: number; deltaPct: number } | null = null;
  try {
    rhPrices = await readGradePrices(mkArrow({ ticker: "NVDA" })); // no chain ⟹ robinhood
  } catch (e) {
    console.log(`  RH contrast: read threw (${(e as Error).message}) — skipping`);
  }
  if (rhPrices && basePrices) {
    console.log(
      `  RH NVDA (rh-stock-arb): oracle=$${rhPrices.oracle.toFixed(2)} ` +
        `dex=$${rhPrices.dex.toFixed(4)} drift=${rhPrices.deltaPct.toFixed(4)}%`,
    );
    // Informational, not a hard gate — proves the two routes are genuinely
    // different sources. Two independent pools sharing a drift to 4 dp is
    // effectively impossible, but we don't fail the checkpoint on infra.
    const differ = !approx(rhPrices.dex, basePrices.dex, 0.0005) ||
      Math.abs(rhPrices.deltaPct - basePrices.deltaPct) >= 0.01;
    console.log(`  ${differ ? "✓" : "⚠"} RH vs Base are ${differ ? "DIFFERENT" : "suspiciously equal"} sources ` +
      `(base drift ${basePrices.deltaPct.toFixed(4)}% vs RH drift ${rhPrices.deltaPct.toFixed(4)}%)`);
  } else if (!rhPrices) {
    console.log("  RH contrast: rh-stock-arb unreachable locally — skipped (not a failure)");
  }
}

async function main() {
  gate1_multiplierPauseGuard();  // offline + deterministic first
  gate2_deadPoolGate();
  await gate3_liveLabelAndComparable();
  await gate4_graderChainRouting();

  console.log("\n" + "─".repeat(64));
  if (failures === 0) {
    console.log("✅ ALL GATES PASSED — Base P3 wiring verified");
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
