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
 *  J/K. The brief-worker (added with the LAST part-2 site). This one is
 *     structurally different from every case above, and that is why it needs
 *     its own two groups:
 *
 *       – The bug is not "a read wipes the key it writes". `bh:brief:queue`
 *         survived a throttled read fine, because the empty-check returned
 *         before the write. The damage was elsewhere: the worker POPS ids, and
 *         a pop is destructive on its own. A throttled read of the ARROW then
 *         made the worker report `vanished from KV — dropping` about an arrow
 *         sitting safely in KV, with its id already gone from the queue. So J
 *         tests an HONESTY failure and K tests a LOSS failure, and the two
 *         controls have to assert different things.
 *
 *       – `processOne` cannot be exported (Next.js rejects non-handler exports
 *         from a `route.ts`), so J/K drive the REAL `POST` handler. That is the
 *         stronger test anyway: it exercises pop → process → re-queue as one
 *         piece, which is where the ordering bug would live.
 *
 *       – Every case here needs a SELECTIVE fault (`withReadFailureOn`). A
 *         blanket read failure cannot express "the queue read worked and the
 *         arrow read did not", which is the only shape that reaches the bug.
 *
 * Cases G, I, J and K are control PAIRS: the "before" shape is reimplemented
 * inline and asserted to be destructive (or dishonest), then the shipped code is
 * asserted not to be under the identical fault. Either half alone is decoration
 * — the old-shape assertion is what proves the new one is measuring something
 * real. J/K add a third leg: a HEALTHY-KV control, because "always answer
 * unavailable" and "always defer" would otherwise pass every fault case.
 */

import { kv, kvGet, kvSet, kvDel, kvMutate } from "../src/lib/kv";
import { persistPickCheck, type PickOutcome, type PendingPick } from "../src/app/api/x402/_handlers/picks-check";
import { KV_BRIEF_QUEUE, kvArrow } from "../src/lib/blue-hood/kv-keys";

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

/**
 * Fail `kv.get` for SOME keys only. Required by J/K: the brief-worker bug needs
 * the queue read to SUCCEED (so an id is really popped) and the arrow read to
 * fail. A blanket `withReadFailure` cannot reach that state at all — it stops
 * the worker at the queue and the destructive line is never executed.
 */
async function withReadFailureOn<T>(fails: (key: string) => boolean, fn: () => Promise<T>): Promise<T> {
  const realGet = kv.get.bind(kv);
  kv.get = (async <V,>(key: string): Promise<V | null> => {
    if (fails(key)) throw new Error("simulated Upstash throttle (max requests limit exceeded)");
    return realGet<V>(key);
  }) as typeof kv.get;
  try { return await fn(); } finally { kv.get = realGet; }
}

/** Swap in a throwing `kv.set`. Reads still work. */
async function withWriteFailure<T>(fn: () => Promise<T>): Promise<T> {
  const realSet = kv.set.bind(kv);
  kv.set = async () => { throw new Error("simulated write failure"); };
  try { return await fn(); } finally { kv.set = realSet; }
}

/** Let the first `n` writes through, then throw. Needed to reach a state a
 *  blanket failure cannot: the queue POP persisted, and a LATER write did not. */
async function withWriteFailureAfter<T>(n: number, fn: () => Promise<T>): Promise<T> {
  const realSet = kv.set.bind(kv);
  let seen = 0;
  kv.set = (async (key: string, value: unknown, opts?: { ex?: number }) => {
    if (seen++ >= n) throw new Error("simulated write failure");
    return realSet(key, value, opts);
  }) as typeof kv.set;
  try { return await fn(); } finally { kv.set = realSet; }
}

/** Count KV commands. The budget is the reason this whole family exists (#148),
 *  so "how many commands did that tick cost" is an assertable property, not a
 *  comment. */
async function countCommands<T>(fn: () => Promise<T>): Promise<{ result: T; gets: string[]; sets: string[] }> {
  const realGet = kv.get.bind(kv);
  const realSet = kv.set.bind(kv);
  const gets: string[] = [];
  const sets: string[] = [];
  kv.get = (async <V,>(key: string) => { gets.push(key); return realGet<V>(key); }) as typeof kv.get;
  kv.set = (async (key: string, value: unknown, opts?: { ex?: number }) => { sets.push(key); return realSet(key, value, opts); }) as typeof kv.set;
  try { return { result: await fn(), gets, sets }; } finally { kv.get = realGet; kv.set = realSet; }
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

  await briefWorkerCases();

  console.log(failures === 0 ? "\n✓ all part-2 control assertions passed\n" : `\n✗ ${failures} assertion(s) failed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

// ───────────────────────────────────────────────────────────────────────────
// J / K — brief-worker: the last part-2 site.
// ───────────────────────────────────────────────────────────────────────────

const LIVE_ID = "test-live-arrow-0001";
const GHOST_ID = "test-ghost-arrow-0002";
const OTHER_ID = "test-other-arrow-0003";

/** Enough of an `Arrow` for the reads under test. Nothing here reaches the A4
 *  path — every case below returns before `fetchArrowBrief`, which is what
 *  keeps this hermetic (no LLM, no network). */
const arrowRecord = (id: string) => ({
  id, serial: "TEST-9999", ticker: "TEST", brief_status: "pending", origin: "engine",
});

type WorkerBody = {
  ok: boolean;
  code?: string;
  reason?: string;
  processed: number;
  queue_len_before?: number;
  queue_len_after?: number;
  deferred?: number;
  requeued?: number;
  per_arrow: Array<{ arrow_id: string; status: string }>;
};

async function briefWorkerCases() {
  // BATCH=1 makes the queue's REMAINDER observable: with the default 8 both
  // fixture ids are popped together and a re-queue that prepends instead of
  // appends would be indistinguishable from one that appends.
  process.env.BH_BRIEF_BATCH = "1";
  // Empty ⇒ `isAuthorized` falls through to the non-production allowance.
  process.env.CRON_SECRET = "";
  // Dynamic: both env vars above are read at module scope, and a static import
  // would be hoisted above these assignments.
  const { POST } = await import("../src/app/api/cron/blue-hood/brief-worker/route");
  const call = async (): Promise<{ status: number; body: WorkerBody }> => {
    const { NextRequest } = await import("next/server");
    const res = await POST(new NextRequest("http://localhost/api/cron/blue-hood/brief-worker"));
    return { status: res.status, body: (await res.json()) as WorkerBody };
  };
  const queueNow = async () => (await kvGet<string[]>(KV_BRIEF_QUEUE)) ?? [];

  // ── J. the QUEUE read — an honesty failure, not a destructive one ─────────
  console.log("\nJ-A. CONTROL — old `kvGet ?? []` queue read under a throttle:");
  await kvSet(KV_BRIEF_QUEUE, [LIVE_ID, OTHER_ID]);
  const oldReport = await withReadFailure(async () => {
    // Verbatim the shape this PR removes. Note what it does NOT do: the
    // `length === 0` return fires before any write, so the queue survives.
    // That is exactly why this sat unnoticed — the damage is in the sentence.
    const queue = (await kvGet<string[]>(KV_BRIEF_QUEUE)) ?? [];
    if (queue.length === 0) return { ok: true, queue_len_before: 0, processed: 0 };
    return { ok: true, queue_len_before: queue.length, processed: queue.length };
  });
  const survived = await queueNow();
  check(
    "old shape reports an EMPTY queue it never managed to read",
    oldReport.ok === true && oldReport.queue_len_before === 0 && oldReport.processed === 0,
    JSON.stringify(oldReport),
  );
  check(
    "…while 2 ids were sitting in KV the whole time (so the loss is honesty, not data)",
    survived.length === 2,
    `${survived.length} still queued`,
  );

  console.log("\nJ-B. FIX — shipped POST handler, identical fault:");
  await kvSet(KV_BRIEF_QUEUE, [LIVE_ID, OTHER_ID]);
  const jb = await withReadFailure(call);
  const jbQueue = await queueNow();
  check("answers 503, not 200", jb.status === 503, `status=${jb.status}`);
  check('body says ok:false + code "kv_unavailable"', jb.body.ok === false && jb.body.code === "kv_unavailable", JSON.stringify({ ok: jb.body.ok, code: jb.body.code }));
  check("does NOT claim an empty queue", jb.body.queue_len_before === undefined, `queue_len_before=${jb.body.queue_len_before}`);
  check("queue untouched — nothing popped on a blind tick", jbQueue.length === 2, `${jbQueue.length} queued`);

  console.log("\nJ-C. CONTROL — healthy KV, genuinely empty queue:");
  // Without this, "always answer kv_unavailable" would pass J-B.
  await kvDel(KV_BRIEF_QUEUE);
  const jcRun = await countCommands(call);
  const jc = jcRun.result;
  check("answers 200 ok:true", jc.status === 200 && jc.body.ok === true, `status=${jc.status} ok=${jc.body.ok}`);
  check("reports the empty queue as empty", jc.body.queue_len_before === 0 && jc.body.processed === 0, JSON.stringify({ before: jc.body.queue_len_before, processed: jc.body.processed }));
  check("no kv_unavailable code on a real empty", jc.body.code === undefined, `code=${jc.body.code}`);
  // This cron ticks 1,440×/day and the queue is empty on most of them, against
  // the budget that has suspended the engine three times. Both numbers below
  // are load-bearing, not cosmetic: the health probe belongs AFTER the pop, and
  // an empty queue must not be re-written with `[]`.
  check("an empty tick costs exactly ONE read", jcRun.gets.length === 1 && jcRun.gets[0] === KV_BRIEF_QUEUE, `${jcRun.gets.length} reads: ${jcRun.gets.join(",")}`);
  check("an empty tick writes NOTHING", jcRun.sets.length === 0, `${jcRun.sets.length} writes: ${jcRun.sets.join(",")}`);

  console.log("\nJ-D. WRITE FAILURE — queue read fine, the pop never persists:");
  // The `|| popRes === "failed"` half of the bail condition. Without this the
  // handler could drop to a single `=== "skipped"` test and ship unexercised:
  // it would then process a batch whose ids are all still queued, against a KV
  // that just proved it cannot write.
  await kvSet(KV_BRIEF_QUEUE, [LIVE_ID, OTHER_ID]);
  const jd = await withWriteFailure(call);
  const jdQueue = await queueNow();
  check("answers 503", jd.status === 503, `status=${jd.status}`);
  check('distinguishes it as "queue write failed"', jd.body.code === "kv_unavailable" && jd.body.reason === "queue write failed", JSON.stringify({ code: jd.body.code, reason: jd.body.reason }));
  check("nothing processed", jd.body.processed === 0, `processed=${jd.body.processed}`);
  check("queue intact", jdQueue.length === 2, `${jdQueue.length} queued`);

  // ── K. the ARROW read — the destructive one, and the one triage missed ────
  console.log("\nK-A. CONTROL — old `kvGet` arrow read: popped, then throttled:");
  await kvSet(kvArrow(LIVE_ID), arrowRecord(LIVE_ID));
  await kvSet(KV_BRIEF_QUEUE, [LIVE_ID, OTHER_ID]);
  const oldRow = await (async () => {
    // Pop the old way (this part worked), then read the arrow the old way.
    const queue = (await kvGet<string[]>(KV_BRIEF_QUEUE)) ?? [];
    const [head, ...rest] = queue;
    await kvSet(KV_BRIEF_QUEUE, rest);
    return withReadFailureOn((k) => k === kvArrow(head), async () => {
      const arrow = await kvGet<unknown>(kvArrow(head));
      return arrow ? "processed" : "skipped_missing";
    });
  })();
  const oldAfter = await queueNow();
  const stillOnDisk = await kvGet<{ id: string }>(kvArrow(LIVE_ID));
  check(
    'old shape calls a LIVE arrow "vanished from KV"',
    oldRow === "skipped_missing" && stillOnDisk?.id === LIVE_ID,
    `row=${oldRow}, record on disk=${stillOnDisk?.id ?? "absent"}`,
  );
  check(
    "…and its id is already gone from the queue — the brief is lost for good",
    !oldAfter.includes(LIVE_ID),
    `queue=[${oldAfter.join(",")}]`,
  );

  console.log("\nK-B. FIX — shipped POST handler, identical fault:");
  await kvSet(kvArrow(LIVE_ID), arrowRecord(LIVE_ID));
  await kvSet(KV_BRIEF_QUEUE, [LIVE_ID, OTHER_ID]);
  const kb = await withReadFailureOn((k) => k === kvArrow(LIVE_ID), call);
  const kbQueue = await queueNow();
  check(
    'row status is "deferred_kv_unavailable", not "skipped_missing"',
    kb.body.per_arrow.length === 1 && kb.body.per_arrow[0].status === "deferred_kv_unavailable",
    JSON.stringify(kb.body.per_arrow),
  );
  check("counted as deferred + requeued, not as skipped", kb.body.deferred === 1 && kb.body.requeued === 1, JSON.stringify({ deferred: kb.body.deferred, requeued: kb.body.requeued }));
  check("batch that processed nothing does not report ok:true", kb.body.ok === false && kb.body.code === "kv_unavailable", JSON.stringify({ ok: kb.body.ok, code: kb.body.code }));
  check(
    "id is back in the queue, at the TAIL, behind the untouched remainder",
    kbQueue.length === 2 && kbQueue[0] === OTHER_ID && kbQueue[1] === LIVE_ID,
    `queue=[${kbQueue.join(",")}]`,
  );
  check("queue_len_after matches what is really there", kb.body.queue_len_after === kbQueue.length, `reported=${kb.body.queue_len_after} actual=${kbQueue.length}`);

  console.log("\nK-C. CONTROL — healthy KV, arrow genuinely absent:");
  // Without this, "always defer, never drop" would pass K-B — and the queue
  // would then grow forever on ids whose 30d TTL legitimately lapsed.
  await kvDel(kvArrow(GHOST_ID));
  await kvSet(KV_BRIEF_QUEUE, [GHOST_ID]);
  const kc = await call();
  const kcQueue = await queueNow();
  check(
    'a real miss still reports "skipped_missing"',
    kc.body.per_arrow.length === 1 && kc.body.per_arrow[0].status === "skipped_missing",
    JSON.stringify(kc.body.per_arrow),
  );
  check("a real miss is NOT re-queued", kcQueue.length === 0 && kc.body.requeued === 0, `queue=[${kcQueue.join(",")}] requeued=${kc.body.requeued}`);
  check("and the tick still reports ok:true", kc.body.ok === true && kc.body.code === undefined, `ok=${kc.body.ok} code=${kc.body.code}`);

  console.log("\nK-D. the id is ALREADY back in the queue (concurrent fire re-added it):");
  // `[LIVE, LIVE]` with BATCH=1 pops the head and leaves the second copy — the
  // exact state a fire produces if it re-enqueues while the batch is running.
  // Re-queueing blindly would double-list it and the arrow would be processed
  // twice; `rule-engine.ts` guards its own append the same way.
  await kvSet(kvArrow(LIVE_ID), arrowRecord(LIVE_ID));
  await kvSet(KV_BRIEF_QUEUE, [LIVE_ID, LIVE_ID]);
  const kd = await withReadFailureOn((k) => k === kvArrow(LIVE_ID), call);
  const kdQueue = await queueNow();
  check("does not double-list the id", kdQueue.length === 1 && kdQueue[0] === LIVE_ID, `queue=[${kdQueue.join(",")}]`);
  check("reports requeued=0 — nothing was added", kd.body.requeued === 0, `requeued=${kd.body.requeued}`);
  check("still reports it as deferred", kd.body.deferred === 1, `deferred=${kd.body.deferred}`);

  console.log("\nK-E. the re-queue itself fails to write:");
  // Pop persists (write #1), re-queue does not (write #2). The id is genuinely
  // lost here — nothing can prevent that — so the ONLY thing that can still go
  // wrong is the report. `requeued` must not claim a write that never landed.
  await kvSet(kvArrow(LIVE_ID), arrowRecord(LIVE_ID));
  await kvSet(KV_BRIEF_QUEUE, [LIVE_ID, OTHER_ID]);
  const ke = await withWriteFailureAfter(1, () =>
    withReadFailureOn((k) => k === kvArrow(LIVE_ID), call),
  );
  const keQueue = await queueNow();
  check("reports requeued=0, not 1", ke.body.requeued === 0, `requeued=${ke.body.requeued}`);
  check("still reports the row as deferred", ke.body.deferred === 1, `deferred=${ke.body.deferred}`);
  check("queue_len_after tells the truth about the loss", ke.body.queue_len_after === keQueue.length, `reported=${ke.body.queue_len_after} actual=${keQueue.length}`);

  await kvDel(KV_BRIEF_QUEUE, kvArrow(LIVE_ID), kvArrow(GHOST_ID), kvArrow(OTHER_ID));
}

main().catch((e) => {
  console.error("test harness error:", e);
  process.exit(1);
});
