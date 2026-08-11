/**
 * scripts/sale-batches-test.ts — `npm run test:sales`
 *
 * The sale batch section publishes one number that is not merely informative:
 * the RH/Base airdrop split. It decides what every pledger receives, it is
 * derived from a hand-edited JSON file, and by the time it is wrong the tokens
 * are already sold. So the derivation is asserted here rather than trusted.
 *
 * What this checks, and why each one is a way the page could lie quietly:
 *
 *   1. VALIDATION — the file is hand-edited, so a typo is the expected input,
 *      not the exceptional one. Every rejection path is exercised with a real
 *      malformed fixture. A validator whose branches never run is decoration.
 *   2. EXACTNESS — proceeds are summed as decimals. In float, 0.1 + 0.2 is
 *      0.30000000000000004; over a list of batches that error lands directly in
 *      the split. Asserted against values chosen to expose exactly that.
 *   3. PENDING SWAPS — a Base batch sold but not yet swapped to VIRT has an
 *      UNKNOWN VIRT value. Counting it as zero would understate Base's share.
 *      It must be excluded from the split AND counted in `pendingSwapCount` so
 *      the page can say so.
 *   4. SPLIT — the two percentages must sum to exactly 100%, and must be
 *      derived from VIRT totals only.
 *   5. FORMATTING — a real, nonzero amount must never render as "0". Per-token
 *      prices here are ~0.00001, which is precisely where a fixed-2dp formatter
 *      prints nothing.
 *   6. THE COMMITTED FILE — whatever is actually in `sale-batches.json` must
 *      load. This is what fails the build on a bad hand-edit.
 *
 * Pure and offline — no RPC, no keys, no network. Exits non-zero on failure.
 */
import {
  loadSaleBatches,
  computeTotals,
  formatScaled,
  fmtBps,
} from "../src/lib/pledge/sales";

let failures = 0;
const ok = (m: string) => console.log(`  ✓ ${m}`);
const bad = (m: string) => {
  failures++;
  console.log(`  ✗ ${m}`);
};
const info = (m: string) => console.log(`    ${m}`);

function header(title: string) {
  console.log(`\n─── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`);
}

const eq = (label: string, actual: unknown, expected: unknown) => {
  if (actual === expected) ok(`${label} = ${String(actual)}`);
  else bad(`${label}: expected ${String(expected)}, got ${String(actual)}`);
};

/** A batch is rejected when `loadSaleBatches` throws; silence is the failure. */
function rejects(label: string, batches: unknown[]) {
  try {
    loadSaleBatches({ batches });
    bad(`${label} — ACCEPTED, should have been rejected`);
  } catch (e) {
    ok(`${label} — rejected: ${(e as Error).message.slice(0, 78)}`);
  }
}

const rh = (over: Record<string, unknown> = {}) => ({
  id: 1,
  chain: "rh",
  date: "2026-08-20T14:00:00Z",
  tokensSold: "50000000",
  received: { asset: "VIRTUAL", amount: "812.44" },
  swappedToVirt: null,
  txHash: `0x${"a".repeat(64)}`,
  ...over,
});

const base = (over: Record<string, unknown> = {}) => ({
  id: 2,
  chain: "base",
  date: "2026-08-21T14:00:00Z",
  tokensSold: "1000000000",
  received: { asset: "WETH", amount: "1.5" },
  swappedToVirt: { amount: "400.0", txHash: `0x${"c".repeat(64)}` },
  txHash: `0x${"b".repeat(64)}`,
  ...over,
});

// ─── 1. Validation ───────────────────────────────────────────────────────────

function checkValidation() {
  header("1. Validation — every rejection path, with a real bad fixture");

  try {
    const rows = loadSaleBatches({ batches: [rh(), base()] });
    eq("well-formed pair loads", rows.length, 2);
  } catch (e) {
    bad(`well-formed pair threw: ${(e as Error).message}`);
  }

  rejects("chain is neither rh nor base", [rh({ chain: "solana" })]);
  rejects("id is not a positive integer", [rh({ id: 0 })]);
  rejects("date is unparseable", [rh({ date: "next tuesday" })]);
  rejects("sale txHash is not 32 bytes", [rh({ txHash: "0xdead" })]);
  rejects("received.asset is unknown", [rh({ received: { asset: "USDC", amount: "1" } })]);
  rejects("tokensSold is zero (also the divisor)", [rh({ tokensSold: "0" })]);
  rejects("received.amount is zero", [rh({ received: { asset: "VIRTUAL", amount: "0" } })]);
  rejects("amount has thousands separators", [
    rh({ received: { asset: "VIRTUAL", amount: "1,024.50" } }),
  ]);
  rejects("amount is a number, not a string", [
    rh({ received: { asset: "VIRTUAL", amount: 812.44 } }),
  ]);
  rejects("amount is negative", [rh({ received: { asset: "VIRTUAL", amount: "-5" } })]);
  rejects("amount is exponential notation", [
    rh({ received: { asset: "VIRTUAL", amount: "8.1244e2" } }),
  ]);
  rejects("swap txHash is not 32 bytes", [
    base({ swappedToVirt: { amount: "400", txHash: "0xbeef" } }),
  ]);
  rejects("RH batch claims a swap it cannot have", [
    rh({ swappedToVirt: { amount: "400", txHash: `0x${"d".repeat(64)}` } }),
  ]);
  rejects("duplicate batch id", [rh({ id: 7 }), base({ id: 7 })]);

  // `batches: []` is VALID and must not throw — it is the pre-launch state.
  try {
    eq("empty batches array is valid", loadSaleBatches({ batches: [] }).length, 0);
  } catch (e) {
    bad(`empty batches array threw: ${(e as Error).message}`);
  }
}

function rejectsNonArray() {
  try {
    loadSaleBatches({ batches: "nope" });
    bad("batches as a string — ACCEPTED, should have been rejected");
  } catch {
    ok("batches as a string — rejected");
  }
}

// ─── 2. Exactness ────────────────────────────────────────────────────────────

function checkExactness() {
  header("2. Exactness — decimal sums that float would get wrong");

  // 0.1 + 0.2 !== 0.3 in float. Three RH batches at those amounts must total
  // exactly 0.3 VIRT, because this sum ends up in the split's numerator.
  const rows = loadSaleBatches({
    batches: [
      rh({ id: 1, received: { asset: "VIRTUAL", amount: "0.1" } }),
      rh({ id: 2, received: { asset: "VIRTUAL", amount: "0.2" } }),
    ],
  });
  const t = computeTotals(rows);
  eq("0.1 + 0.2 VIRT (raw bigint)", t.virtRh, 300_000_000_000_000_000n);
  eq("0.1 + 0.2 VIRT (displayed)", formatScaled(t.virtRh, 4), "0.3");
  info(`float would give ${0.1 + 0.2}`);

  // 18 decimal places is the maximum a batch may carry; the smallest unit must
  // survive the round trip rather than being rounded off in the sum.
  const dust = loadSaleBatches({
    batches: [rh({ received: { asset: "VIRTUAL", amount: "0.000000000000000001" } })],
  });
  eq("1 wei of VIRT survives", computeTotals(dust).virtRh, 1n);
  rejects("19 decimal places (beyond scale)", [
    rh({ received: { asset: "VIRTUAL", amount: "0.0000000000000000001" } }),
  ]);

  // Large token counts must not lose digits either.
  const bigRows = loadSaleBatches({
    batches: [rh({ tokensSold: "99999999999" }), base({ id: 2, tokensSold: "1" })],
  });
  const bt = computeTotals(bigRows);
  eq("99,999,999,999 tokens sold on RH", formatScaled(bt.tokensSoldRh), "99,999,999,999");
}

// ─── 3. Pending swaps ────────────────────────────────────────────────────────

function checkPendingSwaps() {
  header("3. Pending swaps — unknown VIRT is excluded, not zeroed");

  const rows = loadSaleBatches({
    batches: [
      rh({ id: 1, received: { asset: "VIRTUAL", amount: "600" } }),
      base({ id: 2, received: { asset: "WETH", amount: "1.0" }, swappedToVirt: { amount: "400", txHash: `0x${"c".repeat(64)}` } }),
      base({ id: 3, received: { asset: "WETH", amount: "2.0" }, swappedToVirt: null }),
    ],
  });
  const t = computeTotals(rows);

  eq("pendingSwapCount", t.pendingSwapCount, 1);
  eq("virtBase counts only the settled swap", formatScaled(t.virtBase, 4), "400");
  eq("wethBase counts BOTH Base batches", formatScaled(t.wethBase, 4), "3");
  info("the unswapped 2.0 WETH is in the WETH total but not in the split");

  // 600 / (600 + 400) = 60%. If the pending batch were silently counted as 0
  // VIRT the number would be identical — so the discriminating assertion is
  // that pendingSwapCount is nonzero, which is what the page renders a warning
  // from. Confirm the split ignores it and the count exposes it.
  eq("split RH", fmtBps(t.splitRhBps), "60.0%");
  eq("split Base", fmtBps(t.splitBaseBps), "40.0%");

  // Once the pending swap settles, Base's share must RISE — the direction the
  // page promises in its warning line.
  const settled = loadSaleBatches({
    batches: [
      rh({ id: 1, received: { asset: "VIRTUAL", amount: "600" } }),
      base({ id: 2, received: { asset: "WETH", amount: "1.0" }, swappedToVirt: { amount: "400", txHash: `0x${"c".repeat(64)}` } }),
      base({ id: 3, received: { asset: "WETH", amount: "2.0" }, swappedToVirt: { amount: "800", txHash: `0x${"e".repeat(64)}` } }),
    ],
  });
  const st = computeTotals(settled);
  eq("after settling, pendingSwapCount", st.pendingSwapCount, 0);
  if (st.splitBaseBps > t.splitBaseBps) ok(`Base share rose ${fmtBps(t.splitBaseBps)} → ${fmtBps(st.splitBaseBps)}`);
  else bad(`Base share did not rise: ${fmtBps(t.splitBaseBps)} → ${fmtBps(st.splitBaseBps)}`);

  // Every Base batch pending and no RH batch at all ⇒ there is NO split yet.
  const noVirt = loadSaleBatches({ batches: [base({ id: 1, swappedToVirt: null })] });
  const nt = computeTotals(noVirt);
  eq("no settled VIRT ⇒ splitKnown", nt.splitKnown, false);
  info("the page renders 'not yet determined' here, never 0% / 100%");
}

// ─── 4. Split arithmetic ─────────────────────────────────────────────────────

function checkSplit() {
  header("4. Split — always sums to exactly 100%");

  const cases: [string, string][] = [
    ["1", "2"],
    ["1", "0"],
    ["0.000000000000000001", "1000000"],
    ["333.333333333333333333", "666.666666666666666667"],
    ["7", "13"],
  ];

  for (const [a, b] of cases) {
    const batches: unknown[] = [rh({ id: 1, received: { asset: "VIRTUAL", amount: a } })];
    if (b !== "0") {
      batches.push(base({ id: 2, swappedToVirt: { amount: b, txHash: `0x${"c".repeat(64)}` } }));
    }
    const t = computeTotals(loadSaleBatches({ batches }));
    const sum = t.splitRhBps + t.splitBaseBps;
    if (sum === 10_000) ok(`${a} : ${b} → ${fmtBps(t.splitRhBps)} / ${fmtBps(t.splitBaseBps)} (sums to 100%)`);
    else bad(`${a} : ${b} → bps sum ${sum}, expected 10000`);
  }

  // Empty ledger: no split at all, and no division by zero.
  const empty = computeTotals(loadSaleBatches({ batches: [] }));
  eq("empty ledger splitKnown", empty.splitKnown, false);
  eq("empty ledger virtRh", empty.virtRh, 0n);
}

// ─── 5. Formatting ───────────────────────────────────────────────────────────

function checkFormatting() {
  header("5. Formatting — a real amount never renders as 0");

  // The spec's own example: 812.44 VIRTUAL for 50,000,000 tokens.
  const rows = loadSaleBatches({ batches: [rh()] });
  const price = formatScaled(rows[0].avgPriceScaled, 4);
  eq("avg price of the spec's example batch", price, "0.00001624");
  if (price !== "0" && !/^0\.0*$/.test(price)) ok("a sub-0.0001 price still shows digits");
  else bad(`price rendered as visual zero: ${price}`);

  eq("thousands separators", formatScaled(1_234_567n * 10n ** 18n), "1,234,567");
  eq("trailing zeros trimmed", formatScaled(1_500_000_000_000_000_000n, 4), "1.5");
  eq("exact zero", formatScaled(0n), "0");
  eq("1 wei is not zero", formatScaled(1n, 2), "0.000000000000000001");
  eq("half a percent", fmtBps(50), "0.5%");
  eq("100 percent", fmtBps(10_000), "100.0%");
}

// ─── 6. The committed file ───────────────────────────────────────────────────

function checkCommittedFile() {
  header("6. The committed sale-batches.json");

  try {
    const rows = loadSaleBatches();
    const t = computeTotals(rows);
    ok(`loads — ${rows.length} batch(es)`);
    if (rows.length === 0) {
      info("empty: the /pledge section renders nothing, which is correct pre-launch");
    } else {
      info(`RH ${formatScaled(t.virtRh, 4)} VIRT · Base ${formatScaled(t.wethBase, 4)} WETH → ${formatScaled(t.virtBase, 4)} VIRT`);
      info(t.splitKnown ? `split ${fmtBps(t.splitRhBps)} / ${fmtBps(t.splitBaseBps)}` : "split not yet determined");
      if (t.pendingSwapCount > 0) info(`${t.pendingSwapCount} batch(es) awaiting swap`);
    }
  } catch (e) {
    bad(`the committed file does not load: ${(e as Error).message}`);
  }
}

// ─── run ─────────────────────────────────────────────────────────────────────

checkValidation();
rejectsNonArray();
checkExactness();
checkPendingSwaps();
checkSplit();
checkFormatting();
checkCommittedFile();

console.log(
  failures === 0
    ? "\n✓ sale batches — all checks passed\n"
    : `\n✗ sale batches — ${failures} check(s) failed\n`,
);
process.exit(failures === 0 ? 0 : 1);
