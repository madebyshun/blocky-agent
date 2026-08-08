/**
 * ledger-race-test — regression test for the credit-ledger write lock.
 *
 *   npm run test:ledger
 *
 * `spend()` and `topup()` are read-modify-write over a single KV key, so two
 * concurrent writers used to read the same snapshot and the second save would
 * silently clobber the first. Reachable in ordinary use: a USDC top-up settling
 * while the same wallet sends a chat message. The loser is real money.
 *
 * This reproduces that interleave in-process. Control run with the lock removed
 * (2026-08-07) — the numbers below are why the lock exists:
 *
 *     FAIL  concurrent: topup 500+300 both landed: got 1000, expected 1800
 *     FAIL  25 concurrent topups × 10:             got 10,   expected 250
 *
 * i.e. 24 of 25 paid top-ups vanished. With the lock, all cases pass.
 *
 * Runs against the in-memory KV fallback ON PURPOSE — the Upstash env vars are
 * cleared below, so this can never touch production credit balances.
 */
delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

import { topup, spend, getBalance } from "../src/lib/credit-ledger";

const ADDR = "0x1111111111111111111111111111111111111111";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}: got ${actual}, expected ${expected}`);
}

async function main() {
  // ── 1. Sequential sanity ──────────────────────────────────────────────────
  await topup(ADDR, 1000, "test:seed");
  const bal = await getBalance(ADDR);
  check("topup 1000 → topup field", bal.topup, 1000);

  // ── 2. The actual race: a top-up settling while a chat message debits ─────
  const before = await getBalance(ADDR);
  await Promise.all([
    topup(ADDR, 500, "test:concurrent-topup"),
    spend(ADDR, 200, "test:concurrent-spend"),
    topup(ADDR, 300, "test:concurrent-topup-2"),
    spend(ADDR, 100, "test:concurrent-spend-2"),
  ]);
  const after = await getBalance(ADDR);

  check("concurrent: topup 500+300 both landed", after.topup, before.topup + 800);

  // Spends drain the daily allowance first, so `spent` only moves once the
  // daily bucket is exhausted. Assert on the history instead — it records every
  // event regardless of which bucket paid.
  const spends = after.recent.filter((e) => e.kind === "spend").length;
  const topups = after.recent.filter((e) => e.kind === "topup").length;
  check("concurrent: both spend events recorded", spends, 2);
  check("concurrent: both topup events recorded (+1 seed)", topups, 3);

  // ── 3. Hammer it — 25 interleaved writes, none may be lost ────────────────
  const HAMMER = "0x2222222222222222222222222222222222222222";
  await Promise.all(Array.from({ length: 25 }, (_, i) => topup(HAMMER, 10, `test:hammer-${i}`)));
  const hammered = await getBalance(HAMMER);
  check("25 concurrent topups × 10", hammered.topup, 250);

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("threw:", e); process.exit(1); });
