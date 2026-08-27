/**
 * Control test for `kvMutate` — task #150.
 *
 * Run: `npx tsx scripts/kv-mutate-control-test.ts` from `apps/web/`.
 * Hermetic: no KV env vars needed, it runs against the in-memory fallback.
 *
 * WHY THIS IS A *CONTROL* TEST, not a unit test.
 *
 * A test that only exercises the fix cannot tell you whether the fix was
 * needed. If we only asserted "kvMutate preserves the list", the test would
 * pass just as happily against a codebase where the bug never existed, and it
 * would keep passing if someone later reverted `kvMutate` to swallow reads —
 * because the assertion never pins down WHAT it is protecting against.
 *
 * So case A deliberately reimplements the OLD shape, inline, and asserts that
 * it DESTROYS the data. That assertion failing is itself a real signal: it
 * would mean the wipe is no longer reproducible and this whole change needs
 * re-justifying rather than trusting. Case B then asserts the new helper does
 * not wipe under the identical fault. The pair is the evidence; either half
 * alone is decoration.
 *
 * The simulated fault is precise: we break `kv.get` ONLY, leaving `kv.set`
 * working. That is the exact real-world shape of the Upstash cap outages
 * (#123, #148) — reads throttled, writes still landing — and it is the only
 * combination that destroys data instead of merely dropping a write.
 */
import { kv, kvMutate, kvGet, kvSet } from "../src/lib/kv";

const K = "test:kv-mutate:feed";
const SEED = Array.from({ length: 200 }, (_, i) => `arrow-${i}`);

let failures = 0;
function check(label: string, pass: boolean, detail: string) {
  console.log(`${pass ? "  ✓" : "  ✗"} ${label} — ${detail}`);
  if (!pass) failures++;
}

/** Swap in a throwing `kv.get`, run `fn`, always restore. */
async function withReadFailure<T>(fn: () => Promise<T>): Promise<T> {
  const realGet = kv.get.bind(kv);
  kv.get = async () => {
    throw new Error("simulated Upstash throttle (max requests limit exceeded)");
  };
  try {
    return await fn();
  } finally {
    kv.get = realGet;
  }
}

async function main() {
  console.log("\nkvMutate control test — #150\n");

  // ── A. CONTROL: the old shape must still be reproducibly destructive ──────
  console.log("A. CONTROL — old `(await kvGet(K)) ?? []` shape, read failing:");
  await kvSet(K, SEED);
  await withReadFailure(async () => {
    // Verbatim the shape this task removes. Do not "fix" this — it is the
    // control, and it is supposed to lose the data.
    const feed = (await kvGet<string[]>(K)) ?? [];
    feed.unshift("arrow-new");
    await kvSet(K, feed);
  });
  const afterOld = (await kvGet<string[]>(K)) ?? [];
  check(
    "old shape wipes the list",
    afterOld.length === 1 && afterOld[0] === "arrow-new",
    `200 entries → ${afterOld.length} (${JSON.stringify(afterOld.slice(0, 2))})`,
  );

  // ── B. FIX: kvMutate must refuse to write on a failed read ───────────────
  console.log("\nB. FIX — `kvMutate`, same simulated read failure:");
  await kvSet(K, SEED);
  const result = await withReadFailure(() =>
    kvMutate<string[]>(K, [], (feed) => ["arrow-new", ...feed]),
  );
  const afterNew = (await kvGet<string[]>(K)) ?? [];
  check("returns \"skipped\"", result === "skipped", `got "${result}"`);
  check(
    "list survives intact",
    afterNew.length === 200 && afterNew[0] === "arrow-0",
    `${afterNew.length} entries, head=${afterNew[0]}`,
  );

  // ── C. Happy path must still actually mutate ─────────────────────────────
  // Without this, "never write anything" would pass A and B.
  console.log("\nC. HAPPY PATH — healthy KV:");
  await kvSet(K, SEED);
  const okRes = await kvMutate<string[]>(K, [], (feed) => ["arrow-new", ...feed]);
  const afterOk = (await kvGet<string[]>(K)) ?? [];
  check("returns \"ok\"", okRes === "ok", `got "${okRes}"`);
  check(
    "prepends without loss",
    afterOk.length === 201 && afterOk[0] === "arrow-new" && afterOk[1] === "arrow-0",
    `${afterOk.length} entries, head=${afterOk[0]}`,
  );

  // ── D. `null` from mutate means "no change", not "write null" ────────────
  console.log("\nD. NO-OP — mutate returns null (the `if (!includes)` guard):");
  await kvSet(K, SEED);
  const noopRes = await kvMutate<string[]>(K, [], (feed) =>
    feed.includes("arrow-0") ? null : [...feed, "arrow-0"],
  );
  const afterNoop = (await kvGet<string[]>(K)) ?? [];
  check("returns \"unchanged\"", noopRes === "unchanged", `got "${noopRes}"`);
  check("list untouched", afterNoop.length === 200, `${afterNoop.length} entries`);

  // ── E. Genuine miss must use `empty`, not skip ───────────────────────────
  // The distinction that makes this safe to adopt everywhere: a real absent
  // key still behaves like the code it replaces. Only an ERROR skips.
  console.log("\nE. GENUINE MISS — absent key, healthy KV:");
  const missRes = await kvMutate<string[]>("test:kv-mutate:absent", [], (f) => [...f, "first"]);
  const afterMiss = (await kvGet<string[]>("test:kv-mutate:absent")) ?? [];
  check("returns \"ok\"", missRes === "ok", `got "${missRes}"`);
  check("seeds from empty", afterMiss.length === 1 && afterMiss[0] === "first", JSON.stringify(afterMiss));

  // ── F. Counter shape — the `?? 0` variant ────────────────────────────────
  console.log("\nF. COUNTER — `?? 0` variant (serials, builder revenue):");
  await kvSet("test:kv-mutate:counter", 4200);
  const cRes = await withReadFailure(() =>
    kvMutate<number>("test:kv-mutate:counter", 0, (n) => n + 1),
  );
  const cAfter = (await kvGet<number>("test:kv-mutate:counter")) ?? 0;
  check("returns \"skipped\"", cRes === "skipped", `got "${cRes}"`);
  check("counter does not reset to 1", cAfter === 4200, `value=${cAfter}`);

  console.log(
    failures === 0
      ? "\n✓ all control assertions passed\n"
      : `\n✗ ${failures} assertion(s) failed\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("test harness error:", e);
  process.exit(1);
});
