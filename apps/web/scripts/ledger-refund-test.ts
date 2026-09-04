/**
 * ledger-refund-test — regression test for `refund()` (#193).
 *
 *   npx tsx scripts/ledger-refund-test.ts   (also runs under `npm test`)
 *
 * The bug: `/api/chat` debits credits BEFORE calling the model, and had no way
 * back when the gateway then returned nothing. A Virtuals 500 was streamed as
 * the assistant's message and the ledger still recorded a 30-credit spend — the
 * user paid full price for an error string. Over an outage that drains every
 * user's daily allowance in exchange for nothing.
 *
 * Debit-first is still the right shape (it stops a failed request from serving
 * free compute), so the fix is a reversal path. What makes a reversal dangerous
 * is that the two buckets are NOT interchangeable:
 *
 *   - the daily allowance expires at UTC midnight (use-it-or-lose-it)
 *   - the pool is credits the user bought with USDC
 *
 * A refund that returns a daily credit into the pool converts an expiring
 * credit into a permanent one — a slow mint, one failed message at a time. So
 * the cases below assert WHICH BUCKET the credits land in, not just the total.
 *
 * Runs against the in-memory KV fallback ON PURPOSE — the Upstash env vars are
 * cleared below, so this can never touch production credit balances.
 */
delete process.env.KV_REST_API_URL;
delete process.env.KV_REST_API_TOKEN;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

import { topup, spend, refund, getBalance } from "../src/lib/credit-ledger";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}: got ${actual}, expected ${expected}`);
}

// Distinct wallet per case — a shared row would let one case's leftovers decide
// another's result, which is exactly the class of bug this file exists to catch.
const W = (n: number) => `0x${String(n).padStart(40, "0")}`;

async function main() {
  // ── 1. Daily-bucket spend → refund returns it to the DAILY bucket ──────────
  // Nothing was topped up, so every credit here came from the day's allowance.
  // The pool must stay at 0: if these credits landed there, we just minted
  // permanent balance out of an allowance that expires tonight.
  const a = W(1);
  const beforeA = await getBalance(a);
  await spend(a, 30, "chat:private", "ref-daily");
  const midA = await getBalance(a);
  check("daily spend: allowance drops 30", midA.dailyRemaining, (beforeA.dailyRemaining ?? 0) - 30);
  check("daily spend: pool untouched",      midA.pool, 0);

  const rA = await refund(a, "ref-daily");
  const afterA = await getBalance(a);
  check("refund status",                 rA.status, "refunded");
  check("refund returned 30",            rA.returned, 30);
  check("refund went to DAILY, not pool", rA.returnedDaily, 30);
  check("refund pool half is 0",          rA.returnedPool, 0);
  check("allowance restored",             afterA.dailyRemaining, beforeA.dailyRemaining);
  check("pool still 0 (no mint)",         afterA.pool, 0);
  check("balance restored",               afterA.balance, beforeA.balance);

  // ── 2. Overflow spend → each half returns to its OWN bucket ───────────────
  // Spend more than the daily allowance so the excess hits the paid pool, then
  // assert the split unwinds exactly. A refund that dumped the whole amount
  // into either single bucket would pass a total-only assertion and fail here.
  const b = W(2);
  await topup(b, 1_000, "test:seed");
  const beforeB = await getBalance(b);
  const dailyB  = beforeB.dailyRemaining ?? 0;
  const amountB = dailyB + 200;                 // drains daily, overflows 200 into pool
  await spend(b, amountB, "chat:private", "ref-split");
  const midB = await getBalance(b);
  check("overflow spend: allowance emptied", midB.dailyRemaining, 0);
  check("overflow spend: pool -200",         midB.pool, (beforeB.pool ?? 0) - 200);

  const rB = await refund(b, "ref-split");
  const afterB = await getBalance(b);
  check("split refund: daily half", rB.returnedDaily, dailyB);
  check("split refund: pool half",  rB.returnedPool, 200);
  check("split refund: allowance restored", afterB.dailyRemaining, dailyB);
  check("split refund: pool restored",      afterB.pool, beforeB.pool);

  // ── 3. Idempotent — a retried refund must not pay twice ───────────────────
  // The chat route's failure paths can fire more than once (a retry, a stream
  // that errors after the early return). Paying each time turns a gateway
  // outage into a credit faucet.
  const rB2 = await refund(b, "ref-split");
  const afterB2 = await getBalance(b);
  check("second refund is a no-op", rB2.status, "already");
  check("second refund returns 0",  rB2.returned, 0);
  check("balance unchanged by retry", afterB2.balance, afterB.balance);

  // ── 4. Unknown ref → nothing happens ──────────────────────────────────────
  // The only handle a caller has is a ref that must already exist as a spend.
  // This is what stops a refund call from inventing credits.
  const c = W(3);
  await topup(c, 500, "test:seed");
  const beforeC = await getBalance(c);
  const rC = await refund(c, "ref-never-spent");
  const afterC = await getBalance(c);
  check("unknown ref → not-found", rC.status, "not-found");
  check("unknown ref returns 0",   rC.returned, 0);
  check("unknown ref: balance unchanged", afterC.balance, beforeC.balance);

  // ── 5. A refund cannot exceed what was spent ──────────────────────────────
  // Two spends, one refund: only the named one comes back.
  const d = W(4);
  await spend(d, 10, "chat:pro", "ref-one");
  await spend(d, 25, "chat:pro", "ref-two");
  const beforeD = await getBalance(d);
  const rD = await refund(d, "ref-one");
  const afterD = await getBalance(d);
  check("targeted refund returns only its own amount", rD.returned, 10);
  check("targeted refund: balance +10", afterD.balance, beforeD.balance + 10);

  // ── 6. Pre-split events are refused, not guessed ──────────────────────────
  // A row written before the bucket split was recorded knows the total but not
  // which bucket paid it. Both wrong answers cost someone real credits, so the
  // honest output is "cannot assess" — the same rule the tool handlers follow.
  const e = W(5);
  await spend(e, 15, "chat:pro", "ref-legacy");
  const rowKey = `ledger:${e.toLowerCase()}`;
  const { kvGet, kvSetOrThrow } = await import("../src/lib/kv");
  const raw = await kvGet<string | Record<string, unknown>>(rowKey);
  const row = (typeof raw === "string" ? JSON.parse(raw) : raw) as {
    history: Array<Record<string, unknown>>;
  };
  for (const ev of row.history) {
    if (ev.ref === "ref-legacy") { delete ev.fromDaily; delete ev.fromPool; delete ev.day; }
  }
  await kvSetOrThrow(rowKey, JSON.stringify(row));
  const beforeE = await getBalance(e);
  const rE = await refund(e, "ref-legacy");
  const afterE = await getBalance(e);
  check("pre-split event → unsplittable", rE.status, "unsplittable");
  check("pre-split event returns 0",      rE.returned, 0);
  check("pre-split event: balance unchanged", afterE.balance, beforeE.balance);

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("threw:", e); process.exit(1); });
