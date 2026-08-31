/**
 * Control test for the #150 site that the first two passes MISSED:
 * `src/lib/hub-registry.ts`.
 *
 * Run: `npx tsx scripts/hub-registry-kv-test.ts` from `apps/web/`.
 *
 * ═══ WHY THIS FILE EXISTS SEPARATELY ═══
 *
 * `hub-hosted.ts` (the HOSTED half of Blue Hub) was swept in the first #150
 * pass: `putHostedTool` and `addBuilderEarnings` both went to `kvMutate`, and
 * `addBuilderEarnings` carries a "⚠ MONEY BOOKKEEPING" banner explaining why.
 * `hub-registry.ts` — the EXTERNAL half of the same submit flow, same two
 * functions, same key shapes — was never opened. `git log` on it stops in the
 * Hub-v2 era, well before #150. The twins disagreed, and the unswept one is the
 * one holding the 95% counter.
 *
 * So the cases below are not "does kvMutate work" (that is
 * scripts/kv-mutate-control-test.ts, and it is not repeated). They are: does
 * THIS file's exported behaviour still lose money / flatten the marketplace
 * index under the exact fault that made the Upstash cap outages (#123, #148)
 * routine — reads throttled, writes still landing.
 *
 * ═══ HOW TO READ A CASE ═══
 *
 * Every group is a TRIPLE, and all three legs are load-bearing:
 *   ·A CONTROL — the OLD shape, reimplemented inline, asserted to DESTROY.
 *                If this ever stops failing-destructively, the fix below is no
 *                longer protecting anything measurable and needs re-justifying.
 *   ·B FIX     — the REAL exported function, identical fault, asserted intact.
 *   ·C HAPPY   — healthy KV, asserted to actually mutate. Without it,
 *                "never write anything" would pass A and B forever.
 *
 * ═══ KEY-DRIFT NOTE ═══
 *
 * `hub-registry.K` is module-private, so the raw key strings are duplicated
 * below for SEEDING only. Every assertion reads back through the exported API
 * (`listRegisteredToolIds`, `getBuilderTools`, `getRegisteredTool`), so a key
 * rename cannot make this suite quietly pass against the wrong key: the seed
 * would land somewhere the control case cannot destroy, and the ·A leg fails.
 */

import { kv, kvGet, kvSet, kvDel } from "../src/lib/kv";
import {
  putTool,
  addRevenue,
  listRegisteredToolIds,
  getBuilderTools,
  getRegisteredTool,
  type RegisteredTool,
} from "../src/lib/hub-registry";
import { putHostedTool, type HostedTool } from "../src/lib/hub-hosted";

let failures = 0;
function check(label: string, pass: boolean, detail: string) {
  console.log(`${pass ? "  ✓" : "  ✗"} ${label} — ${detail}`);
  if (!pass) failures++;
}

/** Swap in a throwing `kv.get`, run `fn`, always restore. Writes still work —
 *  that asymmetry is the exact shape of the Upstash cap outages (#123, #148),
 *  and it is the only combination that DESTROYS rather than merely drops. */
async function withReadFailure<T>(fn: () => Promise<T>): Promise<T> {
  const realGet = kv.get.bind(kv);
  kv.get = async () => { throw new Error("simulated Upstash throttle (max requests limit exceeded)"); };
  try { return await fn(); } finally { kv.get = realGet; }
}

/** Fail `kv.get` for SELECTED keys only. Needed because both index writes in
 *  `putTool` fail together under a blanket fault, which would let a mutation
 *  that checks only ONE of the two results survive every other case here. */
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

/** Capture console.error so a log-only behaviour change is still assertable. */
async function captureErrors<T>(fn: () => Promise<T>): Promise<{ result: T; errors: string[] }> {
  const real = console.error;
  const errors: string[] = [];
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  try { return { result: await fn(), errors }; } finally { console.error = real; }
}

// ─── Raw keys — SEEDING ONLY (see the key-drift note in the header) ──────────
const INDEX          = "hub:tools:index";
const ITEM           = (id: string) => `hub:tools:item:${id}`;
const REVENUE        = (id: string) => `hub:tools:revenue:${id}`;
const BUILDER        = (a: string) => `hub:builders:tools:${a.toLowerCase()}`;
const HOSTED_INDEX   = "hub:hosted:index";
const HOSTED_ITEM    = (s: string) => `hub:hosted:item:${s}`;
const HOSTED_BUILDER = (a: string) => `hub:hosted:builders:${a.toLowerCase()}`;

const OWNER = "0x02950AD38ada1d599375Bd447e080Cd404809205" as `0x${string}`;
const TOOL_ID = "new-tool";
/** Tools the marketplace already holds. `putTool` must never cost them their listing. */
const EXISTING_IDS = ["weather-on-base", "gas-oracle", "nft-floor"];
/** Tools OWNER already has listed. Their inventory must survive too. */
const OWNER_EXISTING = ["gas-oracle", "nft-floor"];

function tool(id: string): RegisteredTool {
  return {
    id, name: `Tool ${id}`, description: "test fixture", category: "Data",
    endpoint: "https://example.com/api", inputs: [], price: "$0.20", priceUSDC: 200_000,
    builderAddress: OWNER, submittedAt: Date.now(), signature: "0xsig",
    verified: false, aiReady: true,
  };
}

function hosted(slug: string): HostedTool {
  return {
    slug, name: `Hosted ${slug}`, description: "test fixture", category: "Data",
    template: "ai_tool", price: "$0.20", priceUSDC: 200_000, builderAddress: OWNER,
    inputs: [], submittedAt: Date.now(), signature: "0xsig", verified: false,
    config: { kind: "ai_tool", systemPrompt: "hello" },
  };
}

/** Wipe every key this suite touches, so groups cannot leak into each other. */
async function reset() {
  await kvDel(
    INDEX, BUILDER(OWNER), HOSTED_INDEX, HOSTED_BUILDER(OWNER),
    ITEM(TOOL_ID), REVENUE(TOOL_ID), HOSTED_ITEM(TOOL_ID),
    ...EXISTING_IDS.map(ITEM), ...EXISTING_IDS.map(REVENUE),
  );
}

async function main() {
  console.log("\n#150 — hub-registry.ts, the site both earlier passes skipped\n");

  // ── 0. SAFETY GATE ────────────────────────────────────────────────────────
  // This suite drives the REAL `putTool`, which writes the REAL
  // `hub:tools:index` — the master list of every external tool in the live
  // marketplace. It cannot be namespaced without testing a copy instead of the
  // shipped code. So if credentials are present, refuse to run: the ·A control
  // cases are DELIBERATELY destructive and would flatten the production
  // registry. (Memory #155: `.env.local` points at a stale KV — "it's only the
  // dev database" is not a defence when the key names are identical.)
  const live = (process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL)
            && (process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN);
  if (live) {
    console.error("  ✗ ABORT — KV credentials are set. This suite writes hub:tools:index and its");
    console.error("            control cases are intentionally destructive. Run it with no KV env.");
    process.exit(1);
  }
  console.log("  ✓ safety gate — no KV credentials; running against the in-memory fallback\n");

  // ══ L. addRevenue — the builder's lifetime 95% counter ════════════════════
  //
  // Called on EVERY paid external tool call (api/hub/tools/[id]/call:66). The
  // counter IS the record — no receipt exists to rebuild it from — and Phase 4's
  // payout splitter is specified to read it. A wipe here is not a display bug.

  console.log("L-A. CONTROL — old `(await kvGet(K)) ?? 0` → `kvSet(K, …)`, read failing:");
  await reset();
  await kvSet(REVENUE(TOOL_ID), 5_000_000);            // $5.00 accrued over months
  await withReadFailure(async () => {
    // Verbatim the shape this change removes. Do NOT "fix" it — it is the
    // control, and it is supposed to lose the money.
    const current = (await kvGet<number>(REVENUE(TOOL_ID))) ?? 0;
    await kvSet(REVENUE(TOOL_ID), current + 190_000);
  });
  const afterOldRev = (await kvGet<number>(REVENUE(TOOL_ID))) ?? 0;
  check(
    "old shape RESETS the counter to one call's share",
    afterOldRev === 190_000,
    `$5.0000 accrued → $${(afterOldRev / 1e6).toFixed(4)} (lost $${((5_000_000 - afterOldRev) / 1e6).toFixed(4)})`,
  );

  console.log("\nL-B. FIX — real `addRevenue`, identical fault:");
  await reset();
  await kvSet(REVENUE(TOOL_ID), 5_000_000);
  const { errors: revErrs } = await captureErrors(() =>
    withReadFailure(() => addRevenue(TOOL_ID, 190_000)),
  );
  const afterFixRev = (await kvGet<number>(REVENUE(TOOL_ID))) ?? 0;
  check("balance survives intact", afterFixRev === 5_000_000, `$${(afterFixRev / 1e6).toFixed(4)}`);
  check(
    "the skipped accrual is LOGGED, not silent",
    revErrs.some((e) => e.includes("[hub-registry]") && e.includes("NOT accrued") && e.includes(TOOL_ID)),
    revErrs.length ? JSON.stringify(revErrs[revErrs.length - 1]).slice(0, 110) : "(no console.error)",
  );

  console.log("\nL-C. HAPPY PATH — healthy KV (without this, \"never write\" passes L-A+L-B):");
  await reset();
  await kvSet(REVENUE(TOOL_ID), 5_000_000);
  await addRevenue(TOOL_ID, 190_000);
  const afterOk = (await kvGet<number>(REVENUE(TOOL_ID))) ?? 0;
  check("accrual actually lands", afterOk === 5_190_000, `$${(afterOk / 1e6).toFixed(4)}`);

  console.log("\nL-D. COLD KEY — first ever sale, key genuinely absent:");
  // A genuine `miss` must seed from `empty = 0` and WRITE. Getting this wrong in
  // the safe direction (bail when absent) would mean a builder's very first sale
  // never registers — a silent zero that looks exactly like no sales at all.
  await reset();
  await addRevenue(TOOL_ID, 190_000);
  const afterCold = (await kvGet<number>(REVENUE(TOOL_ID))) ?? 0;
  check("absent key seeds from 0 and writes", afterCold === 190_000, `$${(afterCold / 1e6).toFixed(4)}`);

  console.log("\nL-E. WRITE FAILURE — read fine, `kv.set` throws:");
  // The other half of `res !== "ok"`. A read-only fault never reaches it.
  await reset();
  await kvSet(REVENUE(TOOL_ID), 5_000_000);
  const { errors: wErrs } = await captureErrors(() =>
    withWriteFailure(() => addRevenue(TOOL_ID, 190_000)),
  );
  const afterWFail = (await kvGet<number>(REVENUE(TOOL_ID))) ?? 0;
  check("balance untouched", afterWFail === 5_000_000, `$${(afterWFail / 1e6).toFixed(4)}`);
  check(
    "logged with result=failed",
    wErrs.some((e) => e.includes("[hub-registry]") && e.includes("result=failed")),
    wErrs.length ? JSON.stringify(wErrs[wErrs.length - 1]).slice(0, 110) : "(no console.error)",
  );

  // ══ M. putTool — the master index + the owner's inventory ═════════════════
  //
  // `hub:tools:index` is the ONLY thing that makes an external tool listable.
  // The item records survive a wipe untouched under `hub:tools:item:<id>` —
  // they just become unreferenced, so /hub shows a marketplace that lost
  // everyone else's tools the moment one builder submitted during a throttle.

  console.log("\nM-A. CONTROL — old `?? [] → push → kvSet` on both indexes, read failing:");
  await reset();
  await kvSet(INDEX, [...EXISTING_IDS]);
  await kvSet(BUILDER(OWNER), [...OWNER_EXISTING]);
  await withReadFailure(async () => {
    // Verbatim the old body of `putTool`. The control, not a bug to fix.
    const ids = (await kvGet<string[]>(INDEX)) ?? [];
    if (!ids.includes(TOOL_ID)) { ids.push(TOOL_ID); await kvSet(INDEX, ids); }
    const bids = (await kvGet<string[]>(BUILDER(OWNER))) ?? [];
    if (!bids.includes(TOOL_ID)) { bids.push(TOOL_ID); await kvSet(BUILDER(OWNER), bids); }
  });
  const oldIdx  = await listRegisteredToolIds();
  const oldBIdx = (await kvGet<string[]>(BUILDER(OWNER))) ?? [];
  check(
    "old shape flattens the MASTER index to one id",
    oldIdx.length === 1 && oldIdx[0] === TOOL_ID,
    `${EXISTING_IDS.length} listed → ${oldIdx.length} (${JSON.stringify(oldIdx)})`,
  );
  check(
    "old shape flattens the OWNER's inventory too",
    oldBIdx.length === 1 && oldBIdx[0] === TOOL_ID,
    `${OWNER_EXISTING.length} owned → ${oldBIdx.length} (${JSON.stringify(oldBIdx)})`,
  );

  console.log("\nM-B. FIX — real `putTool`, identical fault:");
  await reset();
  await kvSet(INDEX, [...EXISTING_IDS]);
  await kvSet(BUILDER(OWNER), [...OWNER_EXISTING]);
  for (const id of EXISTING_IDS) await kvSet(ITEM(id), tool(id));
  const { errors: putErrs } = await captureErrors(() =>
    withReadFailure(() => putTool(tool(TOOL_ID))),
  );
  const newIdx  = await listRegisteredToolIds();
  const newBIdx = (await kvGet<string[]>(BUILDER(OWNER))) ?? [];
  const savedItem = await kvGet<RegisteredTool>(ITEM(TOOL_ID));
  check(
    "master index survives intact",
    newIdx.length === 3 && EXISTING_IDS.every((id) => newIdx.includes(id)),
    `${newIdx.length} entries: ${JSON.stringify(newIdx)}`,
  );
  check(
    "owner's inventory survives intact",
    newBIdx.length === 2 && OWNER_EXISTING.every((id) => newBIdx.includes(id)),
    `${newBIdx.length} entries: ${JSON.stringify(newBIdx)}`,
  );
  check(
    "the tool record IS saved (the honest partial state the log describes)",
    savedItem?.id === TOOL_ID,
    savedItem ? `hub:tools:item:${TOOL_ID} present` : "MISSING — the log line would be lying",
  );
  check(
    "\"saved but NOT fully indexed\" is logged with a re-submit instruction",
    putErrs.some((e) => e.includes("[hub-registry]") && e.includes("NOT fully indexed") && e.includes("re-submit")),
    putErrs.length ? JSON.stringify(putErrs[putErrs.length - 1]).slice(0, 130) : "(no console.error)",
  );

  console.log("\nM-C. HAPPY PATH — healthy KV:");
  await reset();
  await kvSet(INDEX, [...EXISTING_IDS]);
  await kvSet(BUILDER(OWNER), [...OWNER_EXISTING]);
  for (const id of EXISTING_IDS) await kvSet(ITEM(id), tool(id));
  await putTool(tool(TOOL_ID));
  const okIdx = await listRegisteredToolIds();
  const owned = await getBuilderTools(OWNER);
  const readBack = await getRegisteredTool(TOOL_ID);
  check(
    "appends without loss",
    okIdx.length === 4 && okIdx[3] === TOOL_ID && EXISTING_IDS.every((id) => okIdx.includes(id)),
    `${okIdx.length} entries, tail=${okIdx[okIdx.length - 1]}`,
  );
  check(
    "owner's inventory gains it (read through the exported API)",
    owned.length === 3 && owned.some((t) => t.id === TOOL_ID),
    `${owned.length} owned: ${JSON.stringify(owned.map((t) => t.id))}`,
  );
  check("tool is readable end-to-end", readBack?.id === TOOL_ID, readBack ? `revenueTotal=${readBack.revenueTotal}` : "null");

  console.log("\nM-D. IDEMPOTENT — same tool submitted twice, healthy KV:");
  // The `includes` guard expressed as `mutate → null`. Drop it and every
  // re-submit duplicates the id in both indexes, double-counting the tool on
  // /hub and in the owner's dashboard count.
  await putTool(tool(TOOL_ID));
  const dupIdx  = await listRegisteredToolIds();
  const dupBIdx = (await kvGet<string[]>(BUILDER(OWNER))) ?? [];
  check(
    "no duplicate in either index",
    dupIdx.filter((i) => i === TOOL_ID).length === 1 && dupBIdx.filter((i) => i === TOOL_ID).length === 1,
    `index=${dupIdx.length} builder=${dupBIdx.length}`,
  );

  console.log("\nM-E. WRITE FAILURE — reads fine, `kv.set` throws:");
  // `kvMutate` returns "failed" here, not "skipped". The first #150 pass only
  // branched on "skipped", so this whole state shipped unreported; the guard
  // now covers both. Nothing persists at all — `kvSet(K.item…)` swallows too —
  // so the submit silently did nothing, which is precisely worth a log line.
  await reset();
  await kvSet(INDEX, [...EXISTING_IDS]);
  await kvSet(BUILDER(OWNER), [...OWNER_EXISTING]);
  const { errors: putWErrs } = await captureErrors(() =>
    withWriteFailure(() => putTool(tool(TOOL_ID))),
  );
  const wIdx  = await listRegisteredToolIds();
  const wBIdx = (await kvGet<string[]>(BUILDER(OWNER))) ?? [];
  check("indexes untouched", wIdx.length === 3 && wBIdx.length === 2, `index=${wIdx.length} builder=${wBIdx.length}`);
  check("nothing persisted at all", (await kvGet(ITEM(TOOL_ID))) === null, "hub:tools:item:new-tool absent");
  check(
    "logged with index=failed builder=failed",
    putWErrs.some((e) => e.includes("[hub-registry]") && e.includes("index=failed") && e.includes("builder=failed")),
    putWErrs.length ? JSON.stringify(putWErrs[putWErrs.length - 1]).slice(0, 130) : "(no console.error)",
  );

  console.log("\nM-F. PARTIAL — only the BUILDER key's read fails:");
  // The two indexes fail together under every blanket fault, so a guard that
  // inspects only `idxRes` would pass M-B and M-E unnoticed. This is the case
  // that distinguishes them: the master index lands, the owner's does not, and
  // the tool is listed on /hub while missing from its own creator's dashboard.
  await reset();
  await kvSet(INDEX, [...EXISTING_IDS]);
  await kvSet(BUILDER(OWNER), [...OWNER_EXISTING]);
  const { errors: partErrs } = await captureErrors(() =>
    withReadFailureOn((k) => k === BUILDER(OWNER), () => putTool(tool(TOOL_ID))),
  );
  const pIdx  = await listRegisteredToolIds();
  const pBIdx = (await kvGet<string[]>(BUILDER(OWNER))) ?? [];
  check("master index DID gain it", pIdx.length === 4 && pIdx.includes(TOOL_ID), JSON.stringify(pIdx));
  check("owner's inventory did NOT lose its two", pBIdx.length === 2, JSON.stringify(pBIdx));
  check(
    "the half-failure is reported (index=ok builder=skipped)",
    partErrs.some((e) => e.includes("[hub-registry]") && e.includes("index=ok") && e.includes("builder=skipped")),
    partErrs.length ? JSON.stringify(partErrs[partErrs.length - 1]).slice(0, 130) : "(no console.error)",
  );

  // ══ N. The twin: putHostedTool must log a WRITE failure too ═══════════════
  //
  // The first #150 pass fixed `putHostedTool`'s writes but only branched on
  // `"skipped"` (the READ threw). `kvMutate` also returns `"failed"` (the WRITE
  // threw), which leaves the tool exactly as unlistable — and logged nothing at
  // all. Same partial state, no operator signal.

  console.log("\nN-A. CONTROL — the old `=== \"skipped\"`-only condition, write failing:");
  await reset();
  const oldCondFires = await withWriteFailure(async () => {
    // Reimplementation of the old guard against the results a write failure
    // actually produces. Both mutates return "failed", so the old condition is
    // false and nothing is reported.
    const idxRes = "failed", bRes = "failed";
    return (idxRes as string) === "skipped" || (bRes as string) === "skipped";
  });
  check("old condition stays silent on a write failure", oldCondFires === false, `fires=${oldCondFires}`);

  console.log("\nN-B. FIX — real `putHostedTool`, write failing:");
  await reset();
  const { errors: hostErrs } = await captureErrors(() =>
    withWriteFailure(() => putHostedTool(hosted(TOOL_ID))),
  );
  check(
    "logs index=failed builder=failed",
    hostErrs.some((e) => e.includes("[hub-hosted]") && e.includes("index=failed") && e.includes("builder=failed")),
    hostErrs.length ? JSON.stringify(hostErrs[hostErrs.length - 1]).slice(0, 130) : "(no console.error)",
  );

  console.log("\nN-C. HAPPY PATH — healthy KV must stay quiet:");
  // Without this, "always log an error" would pass N-B.
  await reset();
  const { errors: quietErrs } = await captureErrors(() => putHostedTool(hosted(TOOL_ID)));
  const hostedIdx = (await kvGet<string[]>(HOSTED_INDEX)) ?? [];
  check("no error logged", quietErrs.length === 0, `${quietErrs.length} error(s)`);
  check("hosted tool indexed", hostedIdx.includes(TOOL_ID), JSON.stringify(hostedIdx));

  await reset();
  console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("test harness error:", e); process.exit(1); });
