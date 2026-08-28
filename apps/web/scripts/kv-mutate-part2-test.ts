/**
 * Control test for #150 Group A **part 2**.
 *
 * Run: `npx tsx scripts/kv-mutate-part2-test.ts` from `apps/web/`.
 * Hermetic: no KV env vars needed, it runs against the in-memory fallback.
 *
 * WHAT THIS ADDS OVER scripts/kv-mutate-control-test.ts
 *
 * That script already proves the core property (`kvMutate` refuses to write on
 * a failed read) and is not repeated here. Part 2 introduces three things it
 * cannot catch, and those are the only things tested below:
 *
 *  G. TTL pass-through. Part 2 converted 8 writes that carried a TTL. If
 *     kvMutate dropped it, the key would become permanent (or, with a TTL added
 *     where there was none, expire early). Neither `tsc` nor `next build` nor
 *     the part-1 test can see that — it is silent until data quietly outlives
 *     or outruns its window. I audited all 12 writes by eye; this pins it.
 *
 *  H. `"failed"` — a read that succeeds and a WRITE that throws. Four routes
 *     branch on `res === "skipped" || res === "failed"` to answer HTTP 503.
 *     Part 1 never makes `kv.set` throw, so half of that condition ships
 *     unexercised.
 *
 *  I. The two-key ordering in picks-check. This is the one genuinely new
 *     algorithm in part 2: HISTORY must be appended before PENDING is cleared,
 *     and PENDING must not be cleared at all if the append did not land.
 *     Case I calls the REAL exported `persistPickCheck` — not a copy of it.
 *     Testing a reimplementation would prove nothing about what ships.
 *
 * Cases G and I are control PAIRS: the "before" shape is reimplemented inline
 * and asserted to be destructive, then the shipped code is asserted not to be
 * under the identical fault. Either half alone is decoration — the old-shape
 * assertion is what proves the new one is measuring something real.
 */

import { kv, kvGet, kvSet, kvMutate } from "../src/lib/kv";
import { persistPickCheck, type PickOutcome, type PendingPick } from "../src/app/api/x402/_handlers/picks-check";

let failures = 0;
function check(label: string, pass: boolean, detail: string) {
  console.log(`${pass ? "  ✓" : "  ✗"} ${label} — ${detail}`);
  if (!pass) failures++;
}

/** Swap in a throwing `kv.get`, run `fn`, always restore. Writes still work —
 *  that asymmetry is the exact shape of the Upstash cap outages (#123, #148). */
async function withReadFailure<T>(fn: () => Promise<T>): Promise<T> {
  const realGet = kv.get.bind(kv);
  kv.get = async () => { throw new Error("simulated Upstash throttle (max requests limit exceeded)"); };
  try { return await fn(); } finally { kv.get = realGet; }
}

/** Swap in a throwing `kv.set`. Reads still work. */
async function withWriteFailure<T>(fn: () => Promise<T>): Promise<T> {
  const realSet = kv.set.bind(kv);
  kv.set = async () => { throw new Error("simulated write failure"); };
  try { return await fn(); } finally { kv.set = realSet; }
}

/** Record the opts every `kv.set` is called with, so TTL forwarding is observable. */
async function recordingSet<T>(fn: () => Promise<T>): Promise<{ result: T; calls: Array<{ key: string; opts?: { ex?: number } }> }> {
  const realSet = kv.set.bind(kv);
  const calls: Array<{ key: string; opts?: { ex?: number } }> = [];
  kv.set = async (key: string, value: unknown, opts?: { ex?: number }) => {
    calls.push({ key, opts });
    return realSet(key, value, opts);
  };
  try { return { result: await fn(), calls }; } finally { kv.set = realSet; }
}

const outcome = (symbol: string, o: PickOutcome["outcome"] = "WIN"): PickOutcome => ({
  symbol, price_at_signal: 1, signal_ts: 0, check_after: 0, volume_24h: 1, liquidity_usd: 1,
  price_at_check: 1.1, outcome_pct: 10, outcome: o, checked_ts: Date.now(),
});
const pick = (symbol: string, checkAfter: number): PendingPick => ({
  symbol, price_at_signal: 1, signal_ts: 0, check_after: checkAfter, volume_24h: 1, liquidity_usd: 1,
});

const HISTORY_KEY = "feed:picks:history";
const PENDING_KEY = "feed:picks:pending";

async function main() {
  console.log("\n#150 Group A part-2 control test\n");

  // ── G. TTL pass-through ───────────────────────────────────────────────────
  console.log("G. TTL — kvMutate must forward the TTL it was given, and only then:");
  const TTL = 30 * 24 * 3600;

  await kvSet("test:p2:ttl", ["seed"]);
  const withTtl = await recordingSet(() =>
    kvMutate<string[]>("test:p2:ttl", [], (v) => [...v, "next"], TTL),
  );
  const ttlCall = withTtl.calls.find((c) => c.key === "test:p2:ttl");
  check("forwards ex when a TTL is passed", ttlCall?.opts?.ex === TTL, `ex=${ttlCall?.opts?.ex}`);

  await kvSet("test:p2:nottl", ["seed"]);
  const noTtl = await recordingSet(() =>
    kvMutate<string[]>("test:p2:nottl", [], (v) => [...v, "next"]),
  );
  const noTtlCall = noTtl.calls.find((c) => c.key === "test:p2:nottl");
  // CONTROL for G: if kvMutate hard-coded a TTL, the assertion above would pass
  // for the wrong reason. This is the half that catches that.
  check("sets NO ex when the TTL is omitted", noTtlCall?.opts?.ex === undefined, `ex=${noTtlCall?.opts?.ex}`);

  // ── H. write failure → "failed" (the untested half of the 503 condition) ──
  console.log("\nH. WRITE FAILURE — read fine, `kv.set` throws:");
  await kvSet("test:p2:writefail", ["seed"]);
  const failRes = await withWriteFailure(() =>
    kvMutate<string[]>("test:p2:writefail", [], (v) => [...v, "next"]),
  );
  const afterFail = (await kvGet<string[]>("test:p2:writefail")) ?? [];
  check('returns "failed" (not "ok")', failRes === "failed", `got "${failRes}"`);
  check("value unchanged on disk", afterFail.length === 1 && afterFail[0] === "seed", JSON.stringify(afterFail));

  // ── I. picks-check two-key ordering ──────────────────────────────────────
  const priorHistory = Array.from({ length: 30 }, (_, i) => outcome(`OLD${i}`));
  const duePicks     = [pick("DUE1", 0), pick("DUE2", 0)];
  const stillPending = [pick("LATER", Date.now() + 86_400_000)];
  const newOutcomes  = [outcome("DUE1"), outcome("DUE2", "LOSS")];

  console.log("\nI-A. CONTROL — old parallel `Promise.all([kvSet(pending), kvSet(history)])`:");
  await kvSet(HISTORY_KEY, priorHistory);
  await kvSet(PENDING_KEY, [...duePicks, ...stillPending]);
  await withReadFailure(async () => {
    // Verbatim the shape part 2 removes. Do NOT "fix" this — it is the control
    // and it is supposed to lose the record.
    const history = (await kvGet<PickOutcome[]>(HISTORY_KEY)) ?? [];
    const updated = [...newOutcomes, ...history].slice(0, 30);
    await Promise.all([
      kvSet(PENDING_KEY, stillPending, 7 * 24 * 3600),
      kvSet(HISTORY_KEY, updated, 30 * 24 * 3600),
    ]);
  });
  const oldHist = (await kvGet<PickOutcome[]>(HISTORY_KEY)) ?? [];
  const oldPend = (await kvGet<PendingPick[]>(PENDING_KEY)) ?? [];
  check("old shape collapses the 30-entry track record", oldHist.length === 2, `30 → ${oldHist.length}`);
  check("old shape clears pending anyway", oldPend.length === 1, `${oldPend.length} left`);

  console.log("\nI-B. FIX — shipped `persistPickCheck`, identical fault:");
  await kvSet(HISTORY_KEY, priorHistory);
  await kvSet(PENDING_KEY, [...duePicks, ...stillPending]);
  const skipped = await withReadFailure(() => persistPickCheck(newOutcomes, stillPending));
  const newHist = (await kvGet<PickOutcome[]>(HISTORY_KEY)) ?? [];
  const newPend = (await kvGet<PendingPick[]>(PENDING_KEY)) ?? [];
  check("reports persisted=false", skipped.persisted === false, `persisted=${skipped.persisted}`);
  check("track record survives intact", newHist.length === 30 && newHist[0].symbol === "OLD0", `${newHist.length} entries, head=${newHist[0]?.symbol}`);
  check(
    "pending NOT cleared — due picks stay queued for a retry",
    newPend.length === 3 && newPend.some((p) => p.symbol === "DUE1"),
    `${newPend.length} entries: ${newPend.map((p) => p.symbol).join(",")}`,
  );

  // Without this, "never write anything" would pass I-B.
  console.log("\nI-C. HAPPY PATH — healthy KV, same inputs:");
  await kvSet(HISTORY_KEY, priorHistory);
  await kvSet(PENDING_KEY, [...duePicks, ...stillPending]);
  const okRes = await persistPickCheck(newOutcomes, stillPending);
  const okHist = (await kvGet<PickOutcome[]>(HISTORY_KEY)) ?? [];
  const okPend = (await kvGet<PendingPick[]>(PENDING_KEY)) ?? [];
  check("reports persisted=true", okRes.persisted === true, `persisted=${okRes.persisted}`);
  check(
    "prepends outcomes and caps at 30",
    okHist.length === 30 && okHist[0].symbol === "DUE1" && okHist[2].symbol === "OLD0",
    `${okHist.length} entries, head=${okHist[0]?.symbol}`,
  );
  check("pending cleared down to the not-yet-due picks", okPend.length === 1 && okPend[0].symbol === "LATER", `${okPend.length} entries`);

  await kv.del(HISTORY_KEY, PENDING_KEY, "test:p2:ttl", "test:p2:nottl", "test:p2:writefail");

  console.log(failures === 0 ? "\n✓ all part-2 control assertions passed\n" : `\n✗ ${failures} assertion(s) failed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("test harness error:", e);
  process.exit(1);
});
