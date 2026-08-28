/**
 * Control test for the hydrated arrow cache — task #148 ②.
 *
 * Run: `npx tsx scripts/arrow-cache-test.ts` from `apps/web/`.
 * Hermetic: no KV env vars needed, it runs against the in-memory fallback.
 *
 * WHAT THIS IS PROTECTING, in one line: `bh:arrow:hydrated` is a CACHE, and the
 * two ways a cache kills you are (a) it starts being treated as the truth, and
 * (b) its ABSENCE gets read as "the truth is empty".
 *
 * (b) is the one the user asked for by name — "đừng để blob-vắng thành zero-giả",
 * don't let a missing blob become a fake zero. It is also the exact shape of the
 * bug this whole task exists to kill (#150): a read that fails, gets `?? []`'d,
 * and publishes "Blue Hood has no track record" as a fact while 300+ graded
 * arrows sit intact in KV. Introducing a NEW cache in front of that feed is a
 * fresh opportunity to reintroduce it, so the branch is tested explicitly.
 *
 * WHY SEVERAL OF THESE ARE *CONTROL* TESTS, not unit tests.
 *
 * A test that only exercises the fix cannot tell you whether the fix was needed.
 * Cases marked CONTROL are paired with a sibling: one asserts the dangerous
 * thing DOESN'T happen, the other asserts that the same code still does the
 * useful thing, so that "never write / always drop / always fail" cannot pass.
 *   • F (absent blob + fire → must NOT write) is controlled by G (present blob
 *     + fire → MUST patch). Without G, an `onArrowFired` that did nothing at all
 *     would pass.
 *   • I (drop on drift) is controlled by J (don't drop for an arrow that's
 *     legitimately outside the window). Without J, "always invalidate" passes.
 *   • B (`kv_commands === 1` on a cache hit) is the only assertion that proves
 *     ② bought anything at all. If that number is not 1, the ~401→1 reduction
 *     this task is justified by did not happen, and the rest is decoration.
 *
 * The simulated fault is precise: `kv.get` throws while `kv.set` keeps working.
 * That is the real shape of the Upstash cap outages (#123, #148) — reads
 * throttled, writes still landing — and it is the only combination that
 * destroys data rather than merely dropping a write.
 */
import { kv, kvGet, kvSet, kvDel } from "../src/lib/kv";
import {
  KV_ARROW_FEED,
  KV_ARROW_HYDRATED,
  ARROW_HYDRATED_MAX,
  kvArrow,
} from "../src/lib/blue-hood/kv-keys";
import {
  readArrowFeed,
  onArrowFired,
  onArrowUpdated,
  invalidateArrowCache,
  HYDRATED_VERSION,
  type HydratedFeed,
} from "../src/lib/blue-hood/arrow-cache";
import { readPublicArrowsProbe, readPublicArrows } from "../src/lib/blue-hood/public-feed";
import type { Arrow } from "../src/lib/blue-hood/types";

let failures = 0;
function check(label: string, pass: boolean, detail: string) {
  console.log(`${pass ? "  ✓" : "  ✗"} ${label} — ${detail}`);
  if (!pass) failures++;
}

// ── fixtures ────────────────────────────────────────────────────────────────
/** `i` doubles as recency rank: i=0 is NEWEST. Serial/fired_at stay consistent
 *  with that so the drift math in `onArrowUpdated` is exercised for real. */
function makeArrow(i: number, over: Partial<Arrow> = {}): Arrow {
  const firedAt = new Date(Date.UTC(2026, 7, 20) + (10_000 - i) * 60_000).toISOString();
  return {
    id: `arrow-${String(i).padStart(4, "0")}`,
    serial: `#${String(1000 - i).padStart(4, "0")}`,
    ticker: "NVDA",
    chain: "base",
    type: "drift",
    expected_direction: "up",
    grading_window_h: 2,
    reference_price: 100 + i,
    snapshot_refs: [],
    fired_at: firedAt,
    status: "graded",
    outcome: "hit",
    graded_at: firedAt,
    outcome_detail: "gap closed",
    origin: "engine",
    ...over,
  };
}

const SEED_N = 60;
const SEED = Array.from({ length: SEED_N }, (_, i) => makeArrow(i));

/** Write the source of truth (index + one record per arrow). Never writes the blob. */
async function seedSource(arrows: Arrow[] = SEED) {
  await kvDel(KV_ARROW_HYDRATED);
  await kvSet(KV_ARROW_FEED, arrows.map((a) => a.id));
  for (const a of arrows) await kvSet(kvArrow(a.id), a);
}

async function readBlob(): Promise<HydratedFeed | null> {
  return kvGet<HydratedFeed>(KV_ARROW_HYDRATED);
}

// ── instrumentation ─────────────────────────────────────────────────────────
/**
 * Count every `kv.get`, and optionally make a chosen subset of keys throw.
 * Counting matters as much as the return value: "returned unavailable" and
 * "returned unavailable WITHOUT then firing 251 more reads into a database
 * that is already throttling" are different behaviours, and only the second
 * one is safe to ship. Assertions on the count are the only way to tell them
 * apart from outside.
 */
async function instrument<T>(
  fn: () => Promise<T>,
  failKey?: (key: string) => boolean,
): Promise<{ result: T; gets: number; sets: number; dels: number }> {
  const realGet = kv.get.bind(kv);
  const realSet = kv.set.bind(kv);
  const realDel = kv.del.bind(kv);
  let gets = 0, sets = 0, dels = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  kv.get = (async (key: string) => {
    gets++;
    if (failKey?.(key)) throw new Error("simulated Upstash throttle (max requests limit exceeded)");
    return realGet(key);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  kv.set = (async (...args: unknown[]) => { sets++; return (realSet as any)(...args); }) as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  kv.del = (async (...args: unknown[]) => { dels++; return (realDel as any)(...args); }) as any;
  try {
    return { result: await fn(), gets, sets, dels };
  } finally {
    kv.get = realGet; kv.set = realSet; kv.del = realDel;
  }
}

async function main() {
  console.log("\narrow-cache control test — #148 ②\n");

  // ── A. THE BRANCH THE USER ASKED FOR: blob missing → rebuild, NOT zero ─────
  console.log("A. BLOB MISSING, healthy KV — must rebuild from records, not report empty:");
  await seedSource();
  const a = await instrument(() => readArrowFeed());
  const rebuilt = a.result;
  check(
    "status ok (NOT unavailable, NOT empty)",
    rebuilt.status === "ok",
    rebuilt.status === "ok" ? `${rebuilt.arrows.length} arrows` : `got "${rebuilt.status}"`,
  );
  check(
    "returns the REAL feed, not a fake zero",
    rebuilt.status === "ok" && rebuilt.arrows.length === SEED_N,
    rebuilt.status === "ok" ? `${rebuilt.arrows.length}/${SEED_N}` : "n/a",
  );
  check("source = rebuild", rebuilt.status === "ok" && rebuilt.source === "rebuild",
    rebuilt.status === "ok" ? rebuilt.source : "n/a");
  check("blob was persisted for the next reader", (await readBlob())?.arrows.length === SEED_N,
    `blob=${(await readBlob())?.arrows.length ?? "absent"}`);
  check("rebuild cost is the N+1 we're trying to avoid", a.gets === 1 + 1 + SEED_N,
    `${a.gets} gets (blob + index + ${SEED_N} records)`);

  // ── B. THE WHOLE POINT OF ②: second read is ONE command ───────────────────
  console.log("\nB. BLOB PRESENT — the reduction ② is justified by:");
  const b = await instrument(() => readArrowFeed());
  check("source = cache", b.result.status === "ok" && b.result.source === "cache",
    b.result.status === "ok" ? b.result.source : "n/a");
  check("EXACTLY 1 KV command", b.gets === 1, `${b.gets} gets`);
  check("reported kv_commands matches reality",
    b.result.status === "ok" && b.result.kv_commands === b.gets,
    b.result.status === "ok" ? `reported ${b.result.kv_commands}, actual ${b.gets}` : "n/a");
  check("same arrows as the rebuild", b.result.status === "ok" && b.result.arrows.length === SEED_N,
    b.result.status === "ok" ? `${b.result.arrows.length}` : "n/a");

  // ── C. Blob read ERRORS → unavailable, and NO rebuild stampede ────────────
  console.log("\nC. BLOB READ FAILS — must say unknown, and must NOT retry 62 more reads:");
  const c = await instrument(() => readArrowFeed(), (k) => k === KV_ARROW_HYDRATED);
  check("status unavailable (not an empty feed)", c.result.status === "unavailable",
    c.result.status === "unavailable" ? c.result.reason.slice(0, 48) + "…" : `got "${c.result.status}"`);
  check("stopped at 1 command — no fan-out into a throttled DB", c.gets === 1, `${c.gets} gets`);
  check("wrote nothing", c.sets === 0, `${c.sets} sets`);

  // ── D. Index read ERRORS during rebuild → unavailable, nothing written ────
  console.log("\nD. INDEX READ FAILS (blob absent) — must not publish an empty track record:");
  await seedSource();
  const d = await instrument(() => readArrowFeed(), (k) => k === KV_ARROW_FEED);
  check("status unavailable", d.result.status === "unavailable",
    d.result.status === "unavailable" ? "unavailable" : `got "${d.result.status}"`);
  check("no blob written", (await readBlob()) === null, `blob=${(await readBlob()) ? "written" : "absent"}`);

  // ── E. PARTIAL fan-out must never be written ─────────────────────────────
  // The nastiest failure available here: 59 of 60 records read fine. Writing
  // that would cache a SILENTLY TRUNCATED track record as fact for 6h — worse
  // than an outage, because it looks completely healthy.
  console.log("\nE. ONE RECORD FAILS mid-rebuild — a truncated feed must never be cached:");
  await seedSource();
  const e = await instrument(() => readArrowFeed(), (k) => k === kvArrow(SEED[7].id));
  check("status unavailable", e.result.status === "unavailable",
    e.result.status === "unavailable" ? "unavailable" : `got "${e.result.status}"`);
  check("did NOT cache the 59 that worked", (await readBlob()) === null,
    `blob=${(await readBlob())?.arrows.length ?? "absent"}`);

  // ── F. CONTROL — fire against an ABSENT blob must not publish a 1-arrow feed
  // `kvMutate` seeds its mutator from `empty` on a miss. If the seed were a
  // plausible-looking `{v:1, arrows:[]}`, this single fire would write a
  // ONE-ARROW blob and serve it as the entire track record for 6h — the exact
  // `?? [] → write` shape #150 exists to kill, rebuilt inside its own fix.
  console.log("\nF. CONTROL — arrow fires while blob is absent:");
  await kvDel(KV_ARROW_HYDRATED);
  await onArrowFired(makeArrow(-1));
  check("blob still absent (did NOT write a 1-arrow feed)", (await readBlob()) === null,
    `blob=${(await readBlob())?.arrows.length ?? "absent"}`);

  // ── G. …but a fire against a PRESENT blob MUST patch it ──────────────────
  // Sibling of F. Without this, an `onArrowFired` that did nothing would pass.
  console.log("\nG. SIBLING OF F — arrow fires while blob is present:");
  await seedSource();
  await readArrowFeed(); // hydrate
  const fresh = makeArrow(-1, { id: "arrow-fresh", serial: "#1001" });
  const g = await instrument(() => onArrowFired(fresh));
  const gBlob = await readBlob();
  check("patched in place, not rebuilt", g.gets === 1, `${g.gets} gets`);
  check("new arrow is at the head", gBlob?.arrows[0]?.id === "arrow-fresh", `head=${gBlob?.arrows[0]?.id}`);
  check("nothing lost", gBlob?.arrows.length === SEED_N + 1, `${gBlob?.arrows.length} arrows`);

  // ── H. Grade/brief update patches the existing entry ─────────────────────
  console.log("\nH. ARROW UPDATED (grade lands, brief attaches):");
  await seedSource();
  await readArrowFeed();
  const graded: Arrow = { ...SEED[3], outcome: "miss", outcome_detail: "reverted" };
  await onArrowUpdated(graded);
  const hBlob = await readBlob();
  check("blob kept (patched, not dropped)", hBlob !== null, hBlob ? "present" : "dropped");
  check("entry updated in place",
    hBlob?.arrows.find((x) => x.id === SEED[3].id)?.outcome === "miss",
    `outcome=${hBlob?.arrows.find((x) => x.id === SEED[3].id)?.outcome}`);
  check("no duplicate row", hBlob?.arrows.filter((x) => x.id === SEED[3].id).length === 1,
    `${hBlob?.arrows.filter((x) => x.id === SEED[3].id).length} rows`);
  check("length unchanged", hBlob?.arrows.length === SEED_N, `${hBlob?.arrows.length}`);

  // ── I. Update for an arrow the blob SHOULD have had → drop it ────────────
  // If an arrow that belongs in the window isn't in the blob, the blob is
  // already wrong about something. Drop rather than patch: a rebuild is
  // cheap and correct, a guess is neither.
  console.log("\nI. UPDATE FOR A MISSING-BUT-IN-WINDOW ARROW — blob has drifted, drop it:");
  await seedSource();
  await readArrowFeed();
  await onArrowUpdated(makeArrow(-5, { id: "arrow-never-cached", serial: "#1005" }));
  check("blob dropped so the next read rebuilds", (await readBlob()) === null,
    `blob=${(await readBlob()) ? "still present" : "dropped"}`);

  // ── J. CONTROL FOR I — an arrow legitimately outside the window must NOT drop
  // Without this, an `onArrowUpdated` that unconditionally invalidates passes I
  // — and silently turns every grade into a full 251-command rebuild, undoing ②.
  console.log("\nJ. CONTROL FOR I — arrow older than the cached window:");
  const full = Array.from({ length: ARROW_HYDRATED_MAX }, (_, i) => makeArrow(i));
  await seedSource(full);
  await readArrowFeed();
  const older = makeArrow(ARROW_HYDRATED_MAX + 50, { id: "arrow-ancient", serial: "#0001" });
  await onArrowUpdated(older);
  check("blob KEPT (nothing has drifted — it's just old)", (await readBlob()) !== null,
    `blob=${(await readBlob())?.arrows.length ?? "dropped"}`);

  // ── K. Cap holds ─────────────────────────────────────────────────────────
  // The cap is a byte budget: 250 × ~2KB ≈ 490KB against a 1MB value limit.
  // If a fire could grow the blob past the cap, writes start silently failing.
  console.log("\nK. CAP — a fire on a full blob must not grow it:");
  await onArrowFired(makeArrow(-9, { id: "arrow-overflow", serial: "#1009" }));
  const kBlob = await readBlob();
  check(`length stays at ARROW_HYDRATED_MAX (${ARROW_HYDRATED_MAX})`,
    kBlob?.arrows.length === ARROW_HYDRATED_MAX, `${kBlob?.arrows.length}`);
  check("newest kept", kBlob?.arrows[0]?.id === "arrow-overflow", `head=${kBlob?.arrows[0]?.id}`);

  // ── L. Version bump invalidates by construction ─────────────────────────
  console.log("\nL. STALE SCHEMA — a blob from an older HYDRATED_VERSION:");
  await seedSource();
  await kvSet(KV_ARROW_HYDRATED, {
    v: HYDRATED_VERSION - 1, built_at: new Date().toISOString(), arrows: [makeArrow(0)],
  });
  const l = await readArrowFeed();
  check("ignored and rebuilt", l.status === "ok" && l.source === "rebuild" && l.arrows.length === SEED_N,
    l.status === "ok" ? `${l.source}, ${l.arrows.length} arrows` : `got "${l.status}"`);

  // ── M. Public filter still applies on top of the cache ──────────────────
  // The blob is deliberately UNFILTERED (it's shared by every caller, and
  // `?include_test=1` needs the seeded rows). The trust boundary has to
  // survive that: a seeded arrow must not reach a public surface.
  console.log("\nM. TRUST BOUNDARY — seeded/test arrows must not leak through the cache:");
  const mixed = [
    makeArrow(0, { id: "pub-1" }),
    makeArrow(1, { id: "seeded-1", origin: "seeded" }),
    makeArrow(2, { id: "legacy-test", test: true }),
    makeArrow(3, { id: "pub-2" }),
  ];
  await seedSource(mixed);
  await invalidateArrowCache();
  const m = await readPublicArrowsProbe(50);
  check("blob holds all 4 (unfiltered by design)", (await readBlob())?.arrows.length === 4,
    `${(await readBlob())?.arrows.length}`);
  check("public feed shows only the 2 engine arrows",
    m.status === "ok" && m.arrows.length === 2 && m.arrows.every((x) => x.id.startsWith("pub-")),
    m.status === "ok" ? m.arrows.map((x) => x.id).join(",") : `got "${m.status}"`);

  // ── N. Public probe surfaces the outage; legacy wrapper still lies ──────
  // CONTROL for the whole task. `readPublicArrows` is the Group-B gap that is
  // knowingly still open (documented in public-feed.ts). Asserting it STILL
  // returns [] is not endorsing it — it pins the difference, so if someone
  // "fixes" one and not the other, this file says which is which.
  console.log("\nN. KV DOWN — probe API vs legacy API:");
  await invalidateArrowCache();
  const n1 = await instrument(() => readPublicArrowsProbe(50), () => true);
  check("readPublicArrowsProbe → unavailable (honest)", n1.result.status === "unavailable",
    n1.result.status === "unavailable" ? "unavailable" : `got "${n1.result.status}"`);
  const n2 = await instrument(() => readPublicArrows(50), () => true);
  check("readPublicArrows → [] (KNOWN Group-B gap, still open, see #150)",
    Array.isArray(n2.result) && n2.result.length === 0, `${n2.result.length} arrows`);

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
