/**
 * #150 group B — WHAT BLUE HUB SAYS ABOUT ITSELF under a throttled KV.
 *
 * Run: `npx tsx scripts/hub-dashboard-kv-test.ts` from `apps/web/`.
 *
 * Two scopes, one bug, and they are tested together on purpose:
 *   groups D–L  ONE BUILDER'S inventory and money  (/hub/builders/[addr]/dashboard)
 *   groups M–O  THE WHOLE MARKETPLACE'S census     (/api/hub/tools, /api/hub/hosted,
 *                                                   and the PAID `blue-registry` tool)
 *
 * ═══ WHY THIS FILE EXISTS SEPARATELY ═══
 *
 * `scripts/hub-registry-kv-test.ts` covers group A: WRITES that destroy
 * (`putTool` flattening the marketplace index, `addRevenue` resetting a
 * builder's 95% counter). Nothing here destroys anything. Every key stays
 * exactly where it was.
 *
 * What group B breaks is the ANSWER. Four independent KV reads feed
 * `/api/hub/builders/[address]/dashboard` — the external owner index, the
 * hosted owner index, every per-tool counter behind them, and the pooled
 * `builder:earned:<wallet>` figure — and each one used to degrade to `?? 0` /
 * `?? []`. The route then SUMMED them. So one throttled read (routine during
 * the Upstash cap windows, #123/#148) produced a confident
 * `earnings.totalUnits: 0` and `counts.total: 0`, which the dashboard rendered
 * as "$0.0000" and "No tools registered yet".
 *
 * That is not a display glitch. This is the one screen in the product that
 * makes a claim about someone's money, the counter IS the record (there is no
 * receipt to reconcile against), and a builder reads "$0.0000" as "Blue Hub
 * says I have earned nothing" — not as "Blue Hub could not check". So the
 * assertion throughout this file is narrow and specific: WE COULD NOT READ IT
 * and YOU HAVE NONE must not share a rendering.
 *
 * Groups M–O are the same sentence at marketplace scope, which is where the
 * family started (#149). `readRegisteredTools` / `readPublicHostedTools` are
 * `readBuilderTools` with the owner filter removed, so they are asserted with
 * the identical five shapes — outage, genuine-empty, unreadable record,
 * unreadable revenue counter, unreadable call counter. Three things make that
 * scope worse rather than merely bigger, and each has its own check:
 *   · the count is PUBLIC and is the headline on /hub, not one person's page;
 *   · `/api/hub/hosted` handed its answer to the CDN with s-maxage=60 +
 *     stale-while-revalidate=300, so a single throttled read was re-served as a
 *     confident empty registry for ~6 minutes AFTER KV recovered (group N-B);
 *   · `blue-registry` SELLS the census for $0.05 (group O).
 *
 * ═══ HOW TO READ A CASE ═══
 *
 * Every group is a TRIPLE, and all three legs are load-bearing:
 *   ·A CONTROL — the OLD shape, reimplemented inline, asserted to LIE. If this
 *                ever stops lying, the fix below is no longer protecting
 *                anything measurable and needs re-justifying.
 *   ·B FIX     — the REAL exported function (and, for the dashboard, the REAL
 *                route `GET`), identical fault, asserted honest.
 *   ·C HAPPY   — healthy KV, asserted to return REAL NUMBERS. Without it,
 *                "always answer `null` / `unavailable`" would pass A and B
 *                forever, and that is a strictly worse product than the bug.
 *
 * Group H is the same idea sharpened: a builder with a genuinely-empty counter
 * must still get `0`, `complete`, and the "No tools registered yet" card. The
 * fix is only correct if it kept that case intact.
 *
 * ═══ KEY-DRIFT NOTE ═══
 *
 * Both `K` maps are module-private, so the raw key strings are duplicated below
 * for SEEDING ONLY. Every assertion reads back through the real exported API,
 * so a key rename cannot make this suite quietly pass against the wrong key —
 * the seed would land somewhere the ·A control cannot lie about, and ·A fails.
 */

import { kv, kvGet, kvSet, kvDel, kvGetCounter } from "../src/lib/kv";
import {
  readBuilderTools,
  readRegisteredTool,
  readRegisteredTools,
  listRegisteredTools,
  getRegisteredTool,
  statsFromRead,
  worstCoverage,
  putTool,
  type RegisteredTool,
  type Coverage,
} from "../src/lib/hub-registry";
import {
  readBuilderHostedTools,
  readPublicHostedTools,
  listPublicHostedTools,
  getBuilderEarnings,
  putHostedTool,
  type HostedTool,
  type PublicHostedTool,
} from "../src/lib/hub-hosted";
import { GET as dashboardGET } from "../src/app/api/hub/builders/[address]/dashboard/route";
import { GET as toolsGET }     from "../src/app/api/hub/tools/route";
import { GET as hostedGET }    from "../src/app/api/hub/hosted/route";
import blueRegistryHandler     from "../src/app/api/x402/_handlers/blue-registry";
import { AGENT_TOOLS } from "../src/lib/agent-tools";

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

/** Fail `kv.get` for SELECTED keys only. This is the interesting fault for
 *  group B: a blanket outage is easy, but the case that actually shipped wrong
 *  answers is ONE counter throwing while the index and every sibling read fine. */
async function withReadFailureOn<T>(fails: (key: string) => boolean, fn: () => Promise<T>): Promise<T> {
  const realGet = kv.get.bind(kv);
  kv.get = (async <V,>(key: string): Promise<V | null> => {
    if (fails(key)) throw new Error("simulated Upstash throttle (max requests limit exceeded)");
    return realGet<V>(key);
  }) as typeof kv.get;
  try { return await fn(); } finally { kv.get = realGet; }
}

// ─── Raw keys — SEEDING ONLY (see the key-drift note in the header) ──────────
const INDEX          = "hub:tools:index";
const ITEM           = (id: string) => `hub:tools:item:${id}`;
const CALLS          = (id: string) => `hub:tools:calls:${id}`;
const REVENUE        = (id: string) => `hub:tools:revenue:${id}`;
const BUILDER        = (a: string) => `hub:builders:tools:${a.toLowerCase()}`;
const HOSTED_INDEX   = "hub:hosted:index";
const HOSTED_ITEM    = (s: string) => `hub:hosted:item:${s}`;
const HOSTED_BUILDER = (a: string) => `hub:hosted:builders:${a.toLowerCase()}`;
const HOSTED_USAGE   = (s: string) => `usage:${s}`;
const EARNED         = (a: string) => `builder:earned:${a.toLowerCase()}`;

const OWNER = "0x02950AD38ada1d599375Bd447e080Cd404809205" as `0x${string}`;
const EXT_IDS     = ["weather-on-base", "gas-oracle", "nft-floor"];
const HOSTED_SLUG = "hosted-summarizer";

/**
 * A SECOND hosted tool, used only by the census groups (M–O).
 *
 * They need two because with one tool `partial` and `unavailable` produce the
 * same empty list, and the test could not tell a NAMED gap from a blackout.
 * Deliberately kept out of `seedHealthy`: the dashboard groups above assert
 * `counts.hosted === 1`, and quietly changing their arithmetic would make an
 * unrelated regression surface as a census failure.
 */
const HOSTED_SLUG_2 = "hosted-classifier";

/** Per-tool 95% accruals, in USDC micro-units. Distinct values so a sum that
 *  drops one component is arithmetically visible, not just "smaller". */
const EXT_REVENUE: Record<string, number> = {
  "weather-on-base": 1_900_000,   // $1.90
  "gas-oracle":        450_000,   // $0.45
  "nft-floor":       2_650_000,   // $2.65
};
const EXT_CALLS: Record<string, number> = {
  "weather-on-base": 19, "gas-oracle": 5, "nft-floor": 31,
};
const HOSTED_POOLED = 3_100_000;  // $3.10 pooled 90% share
const EXT_TOTAL     = Object.values(EXT_REVENUE).reduce((a, b) => a + b, 0);   // $5.00
const GRAND_TOTAL   = EXT_TOTAL + HOSTED_POOLED;                               // $8.10

function usd(units: number | null): string {
  return units === null ? "null" : `$${(units / 1_000_000).toFixed(4)}`;
}

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
    template: "ai_tool", price: "$0.30", priceUSDC: 300_000, builderAddress: OWNER,
    inputs: [], submittedAt: Date.now(), signature: "0xsig", verified: false,
    config: { kind: "ai_tool", systemPrompt: "hello" },
  };
}

/** The shape the dashboard route actually returns. Declared, not inferred, so a
 *  field silently disappearing from the response is a type error here. */
interface DashboardBody {
  items: Array<{
    id: string; source: "external" | "hosted";
    callCount: number | null; earnedUnits: number | null;
    earningsScope: "per_tool" | "pooled";
  }>;
  counts: { external: number; hosted: number; total: number };
  earnings: { externalUnits: number | null; hostedUnits: number | null; totalUnits: number | null };
  coverage: Coverage;
  warnings: string[];
}

/** Drive the REAL route handler. Testing a reimplementation of the route would
 *  prove nothing about what ships — the whole #150 family is bugs that lived in
 *  the glue between honest pieces. `_req` is unused by the handler. */
async function dashboard(): Promise<DashboardBody> {
  const res = await dashboardGET(
    null as never,
    { params: Promise.resolve({ address: OWNER }) },
  );
  return (await res.json()) as DashboardBody;
}

/** Wipe every key this suite touches, so groups cannot leak into each other. */
async function reset() {
  await kvDel(
    INDEX, BUILDER(OWNER), HOSTED_INDEX, HOSTED_BUILDER(OWNER), EARNED(OWNER),
    HOSTED_ITEM(HOSTED_SLUG),   HOSTED_USAGE(HOSTED_SLUG),
    HOSTED_ITEM(HOSTED_SLUG_2), HOSTED_USAGE(HOSTED_SLUG_2),
    ...EXT_IDS.map(ITEM), ...EXT_IDS.map(CALLS), ...EXT_IDS.map(REVENUE),
  );
}

/** A fully-populated builder: 3 external tools with counters, 1 hosted tool,
 *  and a pooled hosted balance. Seeded through `kvSet` (not `putTool`) wherever
 *  the value is a counter, because counters are written by `kv.incr` in prod. */
async function seedHealthy() {
  await reset();
  await kvSet(INDEX, [...EXT_IDS]);
  await kvSet(BUILDER(OWNER), [...EXT_IDS]);
  for (const id of EXT_IDS) {
    await kvSet(ITEM(id), tool(id));
    await kvSet(CALLS(id), EXT_CALLS[id]);
    await kvSet(REVENUE(id), EXT_REVENUE[id]);
  }
  await putHostedTool(hosted(HOSTED_SLUG));
  await kvSet(HOSTED_USAGE(HOSTED_SLUG), 7);
  await kvSet(EARNED(OWNER), HOSTED_POOLED);
}

/** `seedHealthy` + the second hosted tool. See the note on HOSTED_SLUG_2. */
async function seedMarketplace() {
  await seedHealthy();
  await putHostedTool(hosted(HOSTED_SLUG_2));
  await kvSet(HOSTED_USAGE(HOSTED_SLUG_2), 4);
}

// ─── Census response shapes (declared, not inferred — see DashboardBody) ──────

interface CensusBody {
  tools:    RegisteredTool[];
  count:    number;
  coverage: Coverage;
  unreadableIds: string[];
}
interface HostedCensusBody {
  tools:    PublicHostedTool[];
  count:    number;
  coverage: Coverage;
  unreadableSlugs: string[];
}

/**
 * Drive the REAL route and KEEP THE HEADERS.
 *
 * A helper that returned only the body would hide half the hosted fix: the
 * `Cache-Control` value IS the bug there, because a `no-store` body and an
 * `s-maxage=60` body are byte-identical to the caller and only the header
 * decides whether the CDN pins an outage for six minutes.
 */
async function census(): Promise<{ body: CensusBody; cache: string | null }> {
  const res = await toolsGET();
  return { body: (await res.json()) as CensusBody, cache: res.headers.get("Cache-Control") };
}
async function hostedCensus(): Promise<{ body: HostedCensusBody; cache: string | null }> {
  const res = await hostedGET();
  return { body: (await res.json()) as HostedCensusBody, cache: res.headers.get("Cache-Control") };
}

/** The PAID `blue-registry` tool's own answer ($0.05 — group O). */
interface PaidRegistryBody {
  totals: { all: number; first_party: number; community: number; matched: number };
  registry_coverage: Coverage;
  registry_note?:    string;
  tools:             Array<{ id: string; source: "first-party" | "community" }>;
  tools_truncated:   boolean;
}
async function paidRegistry(): Promise<PaidRegistryBody> {
  const res = await blueRegistryHandler(
    new Request("https://blueagent.dev/api/x402/blue-registry"),
  );
  return (await res.json()) as PaidRegistryBody;
}

/** The compiled-in half of the paid catalog. Never degrades — that is the point. */
const FIRST_PARTY_COUNT = AGENT_TOOLS.filter(t => !!t.price).length;

async function main() {
  console.log("\n#150 group B — does the dashboard say \"we couldn't read it\" or \"you have nothing\"?\n");

  // ── 0. SAFETY GATE ────────────────────────────────────────────────────────
  // This suite drives the REAL `putTool` / `putHostedTool`, which write the
  // REAL `hub:tools:index` and `hub:hosted:index`, and it seeds the REAL
  // `builder:earned:<wallet>` money counter. It cannot be namespaced without
  // testing a copy instead of the shipped code. (Memory #155: `.env.local`
  // points at a stale KV — "it's only the dev database" is not a defence when
  // the key names are identical.)
  const live = (process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL)
            && (process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN);
  if (live) {
    console.error("  ✗ ABORT — KV credentials are set. This suite writes hub:tools:index and");
    console.error("            builder:earned:<wallet>. Run it with no KV env.");
    process.exit(1);
  }
  console.log("  ✓ safety gate — no KV credentials; running against the in-memory fallback\n");

  // ══ I. kvGetCounter — the primitive the whole fix rests on ════════════════
  //
  // Three-way, and the three cases are not interchangeable: a counter that was
  // never incremented IS zero (a fact worth rendering), while a counter that
  // threw is an absence of information (never renderable as a number).
  console.log("I. kvGetCounter — hit / miss / error are three different answers:");
  await reset();
  await kvSet(REVENUE("gas-oracle"), 450_000);
  const cHit  = await kvGetCounter(REVENUE("gas-oracle"));
  const cMiss = await kvGetCounter(REVENUE("never-touched"));
  const cErr  = await withReadFailure(() => kvGetCounter(REVENUE("gas-oracle")));
  await kvSet(REVENUE("junk"), "not-a-number");
  const cJunk = await kvGetCounter(REVENUE("junk"));
  check("hit → the value", cHit === 450_000, String(cHit));
  check("miss → 0 (never incremented IS zero)", cMiss === 0, String(cMiss));
  check("error → null, NOT 0", cErr === null, String(cErr));
  check("non-numeric junk → 0, not NaN", cJunk === 0, String(cJunk));
  await kvDel(REVENUE("junk"));

  // ══ J. worstCoverage — an aggregator must not pick the optimistic read ════
  console.log("\nJ. worstCoverage lattice:");
  check("empty → complete", worstCoverage() === "complete", worstCoverage());
  check("complete+partial → partial",
    worstCoverage("complete", "partial") === "partial",
    worstCoverage("complete", "partial"));
  check("partial+unavailable → unavailable",
    worstCoverage("partial", "unavailable") === "unavailable",
    worstCoverage("partial", "unavailable"));
  check("order-independent",
    worstCoverage("unavailable", "complete") === worstCoverage("complete", "unavailable"),
    `${worstCoverage("unavailable", "complete")} / ${worstCoverage("complete", "unavailable")}`);

  // ══ D. THE DASHBOARD'S ANSWER — total KV read outage ══════════════════════
  //
  // The headline case. Everything is intact in KV; only the reads throw.
  console.log("\nD-A. CONTROL — the OLD dashboard shape under a read outage:");
  await seedHealthy();
  const oldAnswer = await withReadFailure(async () => {
    // Verbatim shape of the pre-fix code path, inlined.
    const ids     = (await kvGet<string[]>(BUILDER(OWNER))) ?? [];
    const items   = (await Promise.all(ids.map(id => kvGet<RegisteredTool>(ITEM(id)))))
                      .filter((t): t is RegisteredTool => !!t);
    const extSum  = (await Promise.all(items.map(t => kvGet<number>(REVENUE(t.id)))))
                      .reduce<number>((s, r) => s + (r ?? 0), 0);
    const pooled  = (await kvGet<number>(EARNED(OWNER))) ?? 0;
    return { count: items.length, totalUnits: extSum + pooled };
  });
  check(
    "old shape reports a tool count of 0 as a FACT",
    oldAnswer.count === 0,
    `count=${oldAnswer.count} (3 tools sat intact in KV)`,
  );
  check(
    "old shape reports $0.0000 earned as a FACT",
    oldAnswer.totalUnits === 0,
    `${usd(oldAnswer.totalUnits)} — ${usd(GRAND_TOTAL)} was in KV the whole time`,
  );

  console.log("\nD-B. FIX — the REAL route GET, identical outage:");
  const outage = await withReadFailure(dashboard);
  check("coverage is unavailable", outage.coverage === "unavailable", outage.coverage);
  check("totalUnits is null, not 0", outage.earnings.totalUnits === null, usd(outage.earnings.totalUnits));
  check("externalUnits is null, not 0", outage.earnings.externalUnits === null, usd(outage.earnings.externalUnits));
  check("hostedUnits is null, not 0", outage.earnings.hostedUnits === null, usd(outage.earnings.hostedUnits));
  check(
    "warnings say it explicitly, so the UI cannot guess wrong",
    outage.warnings.some(w => /not an empty list/i.test(w))
      && outage.warnings.some(w => /pooled hosted earnings/i.test(w)),
    JSON.stringify(outage.warnings),
  );
  check(
    "counts.total is still 0 — but coverage marks it unreadable, not empty",
    outage.counts.total === 0 && outage.coverage === "unavailable",
    `total=${outage.counts.total} coverage=${outage.coverage}`,
  );

  console.log("\nD-C. HAPPY — healthy KV must produce REAL NUMBERS:");
  const okBody = await dashboard();
  check("coverage is complete", okBody.coverage === "complete", okBody.coverage);
  check("no warnings", okBody.warnings.length === 0, JSON.stringify(okBody.warnings));
  check("counts.total = 3 external + 1 hosted",
    okBody.counts.total === 4 && okBody.counts.external === 3 && okBody.counts.hosted === 1,
    JSON.stringify(okBody.counts));
  check(`externalUnits = ${usd(EXT_TOTAL)}`,
    okBody.earnings.externalUnits === EXT_TOTAL, usd(okBody.earnings.externalUnits));
  check(`hostedUnits = ${usd(HOSTED_POOLED)}`,
    okBody.earnings.hostedUnits === HOSTED_POOLED, usd(okBody.earnings.hostedUnits));
  check(`totalUnits = ${usd(GRAND_TOTAL)}`,
    okBody.earnings.totalUnits === GRAND_TOTAL, usd(okBody.earnings.totalUnits));
  check("hosted items declare their earnings POOLED, not zero",
    okBody.items.filter(i => i.source === "hosted").every(i => i.earningsScope === "pooled" && i.earnedUnits === null),
    JSON.stringify(okBody.items.filter(i => i.source === "hosted").map(i => i.earningsScope)));

  // ══ E. PARTIAL — the index reads, ONE tool record does not ════════════════
  //
  // The fault that a blanket outage cannot catch. The dashboard still has 2 of
  // 3 tools; the question is whether it admits the third exists.
  console.log("\nE-A. CONTROL — old shape silently drops the unreadable tool:");
  await seedHealthy();
  const dropped = await withReadFailureOn(k => k === ITEM("gas-oracle"), async () => {
    const ids   = (await kvGet<string[]>(BUILDER(OWNER))) ?? [];
    const items = await Promise.all(ids.map(async id => {
      try { return await kvGet<RegisteredTool>(ITEM(id)); } catch { return null; }
    }));
    return items.filter(Boolean).length;
  });
  check(
    "old shape publishes 2 as the tool count, with no trace of the third",
    dropped === 2,
    `count=${dropped} of 3 — indistinguishable from a deleted tool`,
  );

  console.log("\nE-B. FIX — readBuilderTools names what it could not see:");
  const partial = await withReadFailureOn(k => k === ITEM("gas-oracle"), () => readBuilderTools(OWNER));
  check("coverage is partial", partial.coverage === "partial", partial.coverage);
  check("the readable tools are still served",
    partial.tools.length === 2 && !partial.tools.some(t => t.id === "gas-oracle"),
    `${partial.tools.length} tools: ${JSON.stringify(partial.tools.map(t => t.id))}`);
  check("the unreadable id is reported by name",
    partial.unreadableIds.length === 1 && partial.unreadableIds[0] === "gas-oracle",
    JSON.stringify(partial.unreadableIds));
  check("statsFromRead carries the coverage through to the profile page",
    statsFromRead(partial).coverage === "partial" && statsFromRead(partial).toolCount === 2,
    JSON.stringify(statsFromRead(partial)));

  // ⚠ The check that actually caught a bug. An unreadable tool RECORD never
  // becomes an item, so a route inspecting only the items it HAS cannot notice
  // the gap: the first cut of this handler published $7.65 as a total when the
  // truth was $8.10, silently swallowing gas-oracle's $0.45. Assert the exact
  // wrong number is not produced, not merely that "something is null".
  const partialBody = await withReadFailureOn(k => k === ITEM("gas-oracle"), dashboard);
  const SHORT_TOTAL = GRAND_TOTAL - EXT_REVENUE["gas-oracle"];
  check("route: totalUnits is null because a component is unknown",
    partialBody.earnings.totalUnits === null,
    `${usd(partialBody.earnings.totalUnits)}${partialBody.earnings.totalUnits === SHORT_TOTAL
      ? ` ← the short total: dropped ${usd(EXT_REVENUE["gas-oracle"])} it could not see` : ""}`);
  check("route: externalUnits is null too — a tool it could not read is a missing component",
    partialBody.earnings.externalUnits === null, usd(partialBody.earnings.externalUnits));
  check("route: hostedUnits survives as a real number — the floor is still useful",
    partialBody.earnings.hostedUnits === HOSTED_POOLED, usd(partialBody.earnings.hostedUnits));
  check("route: warns that a tool is missing from the page",
    partialBody.warnings.some(w => /could not be read and are missing/i.test(w)),
    JSON.stringify(partialBody.warnings));
  check("route: does NOT misattribute a record failure to a revenue counter",
    !partialBody.warnings.some(w => /revenue counter/i.test(w)),
    JSON.stringify(partialBody.warnings));

  console.log("\nE-C. HAPPY — same read, healthy KV:");
  const full = await readBuilderTools(OWNER);
  check("coverage complete, nothing unreadable",
    full.coverage === "complete" && full.unreadableIds.length === 0 && full.tools.length === 3,
    `${full.tools.length} tools, coverage=${full.coverage}`);
  check("counters are real values, not null",
    full.tools.every(t => t.revenueTotal === EXT_REVENUE[t.id] && t.callCount === EXT_CALLS[t.id]),
    JSON.stringify(full.tools.map(t => `${t.id}=${usd(t.revenueTotal ?? null)}/${t.callCount}`)));

  // ══ F. COUNTER-ONLY failure — the tool exists, its money does not read ════
  //
  // The asymmetry that makes this fix non-obvious: a failed COUNTER must not
  // hide a live listing, but must not be summed either.
  console.log("\nF-A. CONTROL — old shape folds an unreadable counter into the sum as 0:");
  await seedHealthy();
  const sunk = await withReadFailureOn(k => k === REVENUE("nft-floor"), async () => {
    const ids = (await kvGet<string[]>(BUILDER(OWNER))) ?? [];
    let sum = 0;
    for (const id of ids) {
      try { sum += (await kvGet<number>(REVENUE(id))) ?? 0; } catch { sum += 0; }
    }
    return sum;
  });
  check(
    "old shape under-reports the total and calls it a total",
    sunk === EXT_TOTAL - EXT_REVENUE["nft-floor"],
    `${usd(sunk)} reported vs ${usd(EXT_TOTAL)} real — ${usd(EXT_REVENUE["nft-floor"])} vanished`,
  );

  console.log("\nF-B. FIX — the tool stays listed, its figure goes null, the sum refuses:");
  const cRead = await withReadFailureOn(k => k === REVENUE("nft-floor"), () => readRegisteredTool("nft-floor"));
  check("a failed counter does NOT hide the tool",
    cRead.status === "ok" && cRead.tool.id === "nft-floor",
    cRead.status);
  check("revenueTotal is null while callCount still reads",
    cRead.status === "ok" && cRead.tool.revenueTotal === null && cRead.tool.callCount === EXT_CALLS["nft-floor"],
    cRead.status === "ok" ? `revenue=${cRead.tool.revenueTotal} calls=${cRead.tool.callCount}` : cRead.status);

  // F-C. The MIDDLE RUNG — `readBuilderTools` must degrade on a null counter,
  // not just on an unreadable record.
  //
  // This exists because mutation testing found it missing. Deleting
  // `countersIncomplete` from readBuilderTools (making a counter failure report
  // `complete`) survived the whole suite: the route still caught it, because the
  // route re-derives the fact from the items themselves. But the route is not
  // the only consumer — `statsFromRead` feeds the two builder PROFILE pages,
  // which have no such second opinion and would have rendered a floor as a
  // headline total under a `complete` flag. A guarantee only one caller happens
  // to re-check is not a guarantee.
  //
  // Both halves of the condition are pinned separately: the revenue counter
  // below, the CALL counter after it. A test that only exercises one half lets
  // the other be deleted.
  const revPartial = await withReadFailureOn(k => k === REVENUE("nft-floor"), () => readBuilderTools(OWNER));
  check("readBuilderTools: an unreadable REVENUE counter alone → partial",
    revPartial.coverage === "partial", revPartial.coverage);
  check("...with nothing in unreadableIds — the tool is here, only its money is not",
    revPartial.unreadableIds.length === 0 && revPartial.tools.length === 3,
    `unreadable=${JSON.stringify(revPartial.unreadableIds)} tools=${revPartial.tools.length}`);
  const revStats = statsFromRead(revPartial);
  check("statsFromRead: the profile page inherits partial, not complete",
    revStats.coverage === "partial", revStats.coverage);
  check("...and its revenue is the FLOOR, which is why the flag has to travel with it",
    revStats.totalRevenue === EXT_TOTAL - EXT_REVENUE["nft-floor"],
    `${usd(revStats.totalRevenue)} of ${usd(EXT_TOTAL)}`);

  const callPartial = await withReadFailureOn(k => k === CALLS("gas-oracle"), () => readBuilderTools(OWNER));
  check("readBuilderTools: an unreadable CALL counter alone → partial too",
    callPartial.coverage === "partial", callPartial.coverage);
  check("...and the call total is a floor while revenue stays whole",
    statsFromRead(callPartial).totalCalls === EXT_CALLS["weather-on-base"] + EXT_CALLS["nft-floor"]
      && statsFromRead(callPartial).totalRevenue === EXT_TOTAL,
    `calls=${statsFromRead(callPartial).totalCalls} revenue=${usd(statsFromRead(callPartial).totalRevenue)}`);

  const counterBody = await withReadFailureOn(k => k === REVENUE("nft-floor"), dashboard);
  check("route: all 4 items still listed",
    counterBody.counts.total === 4, JSON.stringify(counterBody.counts));
  check("route: coverage partial, externalUnits null (a floor is not a total)",
    counterBody.coverage === "partial" && counterBody.earnings.externalUnits === null,
    `${counterBody.coverage} / ${usd(counterBody.earnings.externalUnits)}`);
  check("route: warns about the revenue counter specifically",
    counterBody.warnings.some(w => /revenue counter could not be read/i.test(w)),
    JSON.stringify(counterBody.warnings));

  // ══ G. POOLED hosted earnings — its own independent failure mode ══════════
  //
  // The hosted INDEX can read perfectly while `builder:earned:<wallet>` throws.
  // That single key is the whole hosted balance.
  console.log("\nG-A. CONTROL — old getBuilderEarnings answered 0 for \"unreachable\":");
  await seedHealthy();
  const oldPooled = await withReadFailureOn(k => k === EARNED(OWNER), async () =>
    (await kvGet<number>(EARNED(OWNER))) ?? 0);
  check(
    "old shape reports a $0.00 balance for a wallet holding $3.10",
    oldPooled === 0,
    `${usd(oldPooled)} vs ${usd(HOSTED_POOLED)} accrued`,
  );

  console.log("\nG-B. FIX — null, and the total refuses to drop it:");
  const newPooled = await withReadFailureOn(k => k === EARNED(OWNER), () => getBuilderEarnings(OWNER));
  check("getBuilderEarnings → null", newPooled === null, usd(newPooled));

  const pooledBody = await withReadFailureOn(k => k === EARNED(OWNER), dashboard);
  check("route: hostedUnits null", pooledBody.earnings.hostedUnits === null, usd(pooledBody.earnings.hostedUnits));
  check("route: totalUnits null — a total missing a component is the bug",
    pooledBody.earnings.totalUnits === null, usd(pooledBody.earnings.totalUnits));
  check("route: externalUnits survives, so the builder still sees their floor",
    pooledBody.earnings.externalUnits === EXT_TOTAL, usd(pooledBody.earnings.externalUnits));
  check("route: every tool is still listed — a stats failure is not an inventory failure",
    pooledBody.counts.total === 4, JSON.stringify(pooledBody.counts));

  console.log("\nG-C. HAPPY — healthy pooled read:");
  check("getBuilderEarnings returns the real balance",
    (await getBuilderEarnings(OWNER)) === HOSTED_POOLED, usd(await getBuilderEarnings(OWNER)));

  // ══ H. THE DISCRIMINATION CHECK — a real zero must survive the fix ════════
  //
  // Without this group, "return null / unavailable unconditionally" passes every
  // case above, and a brand-new builder would see "—" where the honest answer
  // is "$0.0000, you haven't earned anything yet". The fix is only correct if
  // it left the genuinely-empty case alone.
  console.log("\nH. GENUINE ZERO — a new builder, healthy KV, nothing accrued:");
  await reset();
  await kvSet(INDEX, []);
  await kvSet(BUILDER(OWNER), []);
  const emptyRead = await readBuilderTools(OWNER);
  const emptyBody = await dashboard();
  check("empty inventory is coverage=complete, not unavailable",
    emptyRead.coverage === "complete" && emptyRead.tools.length === 0,
    `${emptyRead.tools.length} tools, coverage=${emptyRead.coverage}`);
  check("route: coverage complete + zero counts → the UI may say \"no tools yet\"",
    emptyBody.coverage === "complete" && emptyBody.counts.total === 0,
    `${emptyBody.coverage} / total=${emptyBody.counts.total}`);
  check("route: totalUnits is 0, NOT null — nothing accrued is a fact",
    emptyBody.earnings.totalUnits === 0, usd(emptyBody.earnings.totalUnits));
  check("route: no warnings on a healthy empty account",
    emptyBody.warnings.length === 0, JSON.stringify(emptyBody.warnings));

  // A never-called tool: counters absent, everything else fine.
  await reset();
  await putTool(tool("brand-new"));
  const virgin = await readRegisteredTool("brand-new");
  check("a never-called tool reads 0 calls / 0 revenue, not null",
    virgin.status === "ok" && virgin.tool.callCount === 0 && virgin.tool.revenueTotal === 0,
    virgin.status === "ok" ? `calls=${virgin.tool.callCount} revenue=${virgin.tool.revenueTotal}` : virgin.status);
  const virginRead = await readBuilderTools(OWNER);
  check("and its owner's coverage stays complete",
    virginRead.coverage === "complete" && virginRead.tools.length === 1,
    `${virginRead.tools.length} tools, coverage=${virginRead.coverage}`);

  // ══ K. FAIL-CLOSED invariant — do NOT "fix" this into fail-open ═══════════
  //
  // `getRegisteredTool` / `getHostedTool` collapsing unreadable→null is CORRECT
  // and load-bearing: the paid invoke route 404s on null, so an unreadable tool
  // must not be invoked (and must not take payment) against a half-read config.
  // Pinned here because the obvious next "cleanup" is to make every reader
  // coverage-aware, and doing it to these two would open a payment path.
  console.log("\nK. FAIL-CLOSED — existence checks must keep collapsing unreadable → null:");
  await seedHealthy();
  const closed = await withReadFailureOn(k => k === ITEM("gas-oracle"), () => getRegisteredTool("gas-oracle"));
  check("getRegisteredTool returns null on an unreadable record",
    closed === null, String(closed));
  const closedRead = await withReadFailureOn(k => k === ITEM("gas-oracle"), () => readRegisteredTool("gas-oracle"));
  check("...while readRegisteredTool distinguishes it from genuinely-missing",
    closedRead.status === "unavailable", closedRead.status);
  check("a genuinely-absent id is `missing`, not `unavailable`",
    (await readRegisteredTool("no-such-tool")).status === "missing",
    (await readRegisteredTool("no-such-tool")).status);

  // ══ L. HOSTED INDEX outage while the external half is healthy ═════════════
  //
  // The dashboard is the only screen that unions two registries, so it is the
  // only place where half the answer can be wrong.
  console.log("\nL. SPLIT FAULT — hosted index down, external half healthy:");
  await seedHealthy();
  const split = await withReadFailureOn(k => k === HOSTED_BUILDER(OWNER), dashboard);
  check("external tools are all still listed",
    split.counts.external === 3, JSON.stringify(split.counts));
  check("hosted count is 0 but coverage is unavailable, not complete",
    split.counts.hosted === 0 && split.coverage === "unavailable",
    `hosted=${split.counts.hosted} coverage=${split.coverage}`);
  check("warns that the hosted list is unreadable, not empty",
    split.warnings.some(w => /hosted tool list/i.test(w) && /not an empty list/i.test(w)),
    JSON.stringify(split.warnings));
  const hostedRead = await withReadFailureOn(k => k === HOSTED_BUILDER(OWNER), () => readBuilderHostedTools(OWNER));
  check("readBuilderHostedTools agrees (the twins must not drift again)",
    hostedRead.coverage === "unavailable" && hostedRead.tools.length === 0,
    `${hostedRead.tools.length} tools, coverage=${hostedRead.coverage}`);

  // ══════════════════════════════════════════════════════════════════════════
  //  M–O. THE CENSUS — the same bug at MARKETPLACE scope (#149)
  //
  //  Everything above is scoped to one wallet. Everything below answers "how
  //  many tools does Blue Hub have?", which is a public claim, is the headline
  //  on /hub, is served over the wire to anything that caches it, and in group
  //  O is literally sold for $0.05.
  // ══════════════════════════════════════════════════════════════════════════

  // ══ M. THE EXTERNAL CENSUS — readRegisteredTools + /api/hub/tools ═════════
  console.log("\nM-A. CONTROL — the OLD /api/hub/tools shape under a read outage:");
  await seedMarketplace();
  const oldCensus = await withReadFailure(async () => {
    // Both collapse points, verbatim, in the order they used to run.
    const ids   = (await kvGet<string[]>(INDEX)) ?? [];                       // #1: index → []
    const items = (await Promise.all(ids.map(id => kvGet<RegisteredTool>(ITEM(id)))))
                    .filter((t): t is RegisteredTool => !!t);                 // #2: record → dropped
    return items.length;
  });
  check(
    "old shape publishes count:0 — indistinguishable from \"nobody has built anything\"",
    oldCensus === 0,
    `count=${oldCensus} while ${EXT_IDS.length} tools sat intact in KV`,
  );

  console.log("\nM-B. FIX — readRegisteredTools + the REAL route, identical outage:");
  const censusOut = await withReadFailure(() => readRegisteredTools());
  check("coverage is unavailable", censusOut.coverage === "unavailable", censusOut.coverage);
  check("...and unreadableIds is EMPTY — the index never read, so there is no id to name",
    censusOut.unreadableIds.length === 0 && censusOut.tools.length === 0,
    `tools=${censusOut.tools.length} unreadable=${JSON.stringify(censusOut.unreadableIds)}`);
  const outCensus = await withReadFailure(census);
  check("route: coverage rides on the wire next to count, so count:0 is qualified",
    outCensus.body.count === 0 && outCensus.body.coverage === "unavailable",
    `count=${outCensus.body.count} coverage=${outCensus.body.coverage}`);
  check("route: Cache-Control no-store — the CDN cannot re-serve the outage",
    outCensus.cache === "no-store", String(outCensus.cache));

  console.log("\nM-C. HAPPY — healthy KV must produce the REAL registry:");
  const censusOk = await census();
  check("coverage complete, all 3 tools, nothing unreadable",
    censusOk.body.coverage === "complete" && censusOk.body.count === EXT_IDS.length
      && censusOk.body.unreadableIds.length === 0,
    `count=${censusOk.body.count} coverage=${censusOk.body.coverage}`);
  check("counters are real values, not null",
    censusOk.body.tools.every(t => t.revenueTotal === EXT_REVENUE[t.id] && t.callCount === EXT_CALLS[t.id]),
    JSON.stringify(censusOk.body.tools.map(t => `${t.id}=${usd(t.revenueTotal ?? null)}/${t.callCount}`)));
  check("route: still no-store even when healthy — the registry is mutable (a removed tool must vanish)",
    censusOk.cache === "no-store", String(censusOk.cache));

  console.log("\nM-D. DISCRIMINATION — a genuinely empty registry is still a FACT:");
  // Without this, "always answer unavailable" passes M-A/M-B forever and a
  // brand-new Hub would claim it could not read itself. `miss` ≠ `error`.
  await reset();
  await kvSet(INDEX, []);
  const emptyCensus = await readRegisteredTools();
  check("empty index → complete, not unavailable",
    emptyCensus.coverage === "complete" && emptyCensus.tools.length === 0,
    `${emptyCensus.tools.length} tools, coverage=${emptyCensus.coverage}`);
  await kvDel(INDEX);
  const absentCensus = await readRegisteredTools();
  check("an ABSENT index is also complete — never incremented IS zero",
    absentCensus.coverage === "complete" && absentCensus.tools.length === 0,
    `${absentCensus.tools.length} tools, coverage=${absentCensus.coverage}`);

  console.log("\nM-E. PARTIAL — the index reads, ONE tool record does not:");
  await seedMarketplace();
  const censusPartial = await withReadFailureOn(k => k === ITEM("gas-oracle"), () => readRegisteredTools());
  check("coverage partial", censusPartial.coverage === "partial", censusPartial.coverage);
  check("the other two are still served — a gap is not a blackout",
    censusPartial.tools.length === 2 && !censusPartial.tools.some(t => t.id === "gas-oracle"),
    JSON.stringify(censusPartial.tools.map(t => t.id)));
  check("the unreadable id is named, so count:2 is legible as a FLOOR",
    censusPartial.unreadableIds.length === 1 && censusPartial.unreadableIds[0] === "gas-oracle",
    JSON.stringify(censusPartial.unreadableIds));
  const partialCensusBody = await withReadFailureOn(k => k === ITEM("gas-oracle"), census);
  check("route: publishes the floor AND the id behind it",
    partialCensusBody.body.count === 2 && partialCensusBody.body.coverage === "partial"
      && partialCensusBody.body.unreadableIds[0] === "gas-oracle",
    JSON.stringify({ count: partialCensusBody.body.count, coverage: partialCensusBody.body.coverage,
                     unreadable: partialCensusBody.body.unreadableIds }));

  console.log("\nM-F. COUNTER-ONLY — both halves of the `||` pinned separately:");
  // Same M5 lesson as F-C: a condition whose halves are not tested independently
  // lets one of them be deleted. Here `countersIncomplete` is the ONLY thing that
  // can produce `partial` with an empty `unreadableIds`, and unlike the dashboard
  // there is no second consumer re-deriving it — /hub renders this flag directly.
  const censusRev = await withReadFailureOn(k => k === REVENUE("nft-floor"), () => readRegisteredTools());
  check("an unreadable REVENUE counter alone → partial",
    censusRev.coverage === "partial", censusRev.coverage);
  check("...with unreadableIds EMPTY and all 3 tools listed — the tool is here, only its money is not",
    censusRev.unreadableIds.length === 0 && censusRev.tools.length === 3,
    `unreadable=${JSON.stringify(censusRev.unreadableIds)} tools=${censusRev.tools.length}`);
  check("...and that tool's revenueTotal is null, not 0",
    censusRev.tools.find(t => t.id === "nft-floor")?.revenueTotal === null,
    String(censusRev.tools.find(t => t.id === "nft-floor")?.revenueTotal));
  const censusCalls = await withReadFailureOn(k => k === CALLS("gas-oracle"), () => readRegisteredTools());
  check("an unreadable CALL counter alone → partial too (the other half)",
    censusCalls.coverage === "partial" && censusCalls.unreadableIds.length === 0
      && censusCalls.tools.length === 3,
    `${censusCalls.coverage} unreadable=${censusCalls.unreadableIds.length} tools=${censusCalls.tools.length}`);

  console.log("\nM-G. ONE IMPLEMENTATION, TWO PROJECTIONS — the legacy list cannot drift:");
  // `listRegisteredTools` is defined AS `(await readRegisteredTools()).tools`.
  // Pinned because the hosted/external twins already drifted once (#150 part 3)
  // and the cheapest way to reintroduce that is a "quick" second implementation.
  const legacyList = await withReadFailureOn(k => k === ITEM("gas-oracle"), () => listRegisteredTools());
  check("listRegisteredTools returns exactly the honest read's tools",
    JSON.stringify(legacyList.map(t => t.id)) === JSON.stringify(censusPartial.tools.map(t => t.id)),
    JSON.stringify(legacyList.map(t => t.id)));

  // ══ N. THE HOSTED CENSUS — the twin, plus the CDN ═════════════════════════
  console.log("\nN-A. CONTROL — the OLD /api/hub/hosted shape under a read outage:");
  await seedMarketplace();
  const oldHosted = await withReadFailure(async () => {
    const slugs = (await kvGet<string[]>(HOSTED_INDEX)) ?? [];
    const items = (await Promise.all(slugs.map(s => kvGet<HostedTool>(HOSTED_ITEM(s)))))
                    .filter((t): t is HostedTool => !!t);
    return items.length;
  });
  check("old shape publishes count:0 for a 2-tool hosted registry",
    oldHosted === 0, `count=${oldHosted}`);

  console.log("\nN-B. FIX — and the header, which is the half that lasted 6 minutes:");
  const hostedOut = await withReadFailure(() => readPublicHostedTools());
  check("coverage unavailable, unreadableSlugs empty (no index → no slug to name)",
    hostedOut.coverage === "unavailable" && hostedOut.tools.length === 0
      && hostedOut.unreadableSlugs.length === 0,
    `tools=${hostedOut.tools.length} coverage=${hostedOut.coverage}`);
  const hostedOutBody = await withReadFailure(hostedCensus);
  check("route: count:0 is qualified by coverage",
    hostedOutBody.body.count === 0 && hostedOutBody.body.coverage === "unavailable",
    `count=${hostedOutBody.body.count} coverage=${hostedOutBody.body.coverage}`);
  check("⚠ route: a DEGRADED read is never handed to the CDN",
    hostedOutBody.cache === "no-store",
    `${hostedOutBody.cache} — s-maxage would re-serve this outage for ~6 min after KV recovered`);

  console.log("\nN-C. HAPPY — real registry, and the edge cache comes BACK:");
  const hostedOk = await hostedCensus();
  check("coverage complete, both hosted tools listed",
    hostedOk.body.coverage === "complete" && hostedOk.body.count === 2
      && hostedOk.body.unreadableSlugs.length === 0,
    `count=${hostedOk.body.count} coverage=${hostedOk.body.coverage}`);
  check("...and it IS cacheable again — \"always no-store\" would be a silent perf regression",
    (hostedOk.cache ?? "").includes("s-maxage=60"), String(hostedOk.cache));
  check("secrets stay stripped on the public census (config + signature)",
    hostedOk.body.tools.every(t => !("config" in t) && !("signature" in t)),
    JSON.stringify(hostedOk.body.tools.map(t => Object.keys(t).length)));

  console.log("\nN-D. DISCRIMINATION — an empty hosted registry is a fact:");
  await reset();
  await kvSet(HOSTED_INDEX, []);
  const hostedEmpty = await readPublicHostedTools();
  check("empty index → complete, not unavailable",
    hostedEmpty.coverage === "complete" && hostedEmpty.tools.length === 0,
    `${hostedEmpty.tools.length} tools, coverage=${hostedEmpty.coverage}`);

  console.log("\nN-E. PARTIAL — one hosted record unreadable, the other still served:");
  await seedMarketplace();
  const hostedPartial = await withReadFailureOn(
    k => k === HOSTED_ITEM(HOSTED_SLUG_2), () => readPublicHostedTools());
  check("coverage partial, the readable tool survives",
    hostedPartial.coverage === "partial" && hostedPartial.tools.length === 1
      && hostedPartial.tools[0].slug === HOSTED_SLUG,
    `${hostedPartial.tools.length} tools: ${JSON.stringify(hostedPartial.tools.map(t => t.slug))}`);
  check("the unreadable slug is named",
    hostedPartial.unreadableSlugs.length === 1 && hostedPartial.unreadableSlugs[0] === HOSTED_SLUG_2,
    JSON.stringify(hostedPartial.unreadableSlugs));
  const hostedPartialBody = await withReadFailureOn(
    k => k === HOSTED_ITEM(HOSTED_SLUG_2), hostedCensus);
  check("route: a PARTIAL read is not cached either — a floor must not be pinned",
    hostedPartialBody.cache === "no-store" && hostedPartialBody.body.coverage === "partial",
    `${hostedPartialBody.cache} / ${hostedPartialBody.body.coverage}`);

  console.log("\nN-F. COUNTER-ONLY on the hosted half — both halves again:");
  const hostedUsage = await withReadFailureOn(
    k => k === HOSTED_USAGE(HOSTED_SLUG_2), () => readPublicHostedTools());
  check("an unreadable USAGE counter alone → partial, unreadableSlugs EMPTY, both tools listed",
    hostedUsage.coverage === "partial" && hostedUsage.unreadableSlugs.length === 0
      && hostedUsage.tools.length === 2,
    `${hostedUsage.coverage} unreadable=${hostedUsage.unreadableSlugs.length} tools=${hostedUsage.tools.length}`);
  // The pooled wallet counter is read PER HOSTED TOOL (readHostedTool asks for
  // `builder:earned:<owner>` every time), so it is a second, independent way for
  // the hosted census to go partial — and the only one shared across tools.
  const hostedEarned = await withReadFailureOn(k => k === EARNED(OWNER), () => readPublicHostedTools());
  check("an unreadable POOLED earnings counter → partial too, with both tools still listed",
    hostedEarned.coverage === "partial" && hostedEarned.tools.length === 2
      && hostedEarned.tools.every(t => t.earnedTotal === null),
    `${hostedEarned.coverage} earned=${JSON.stringify(hostedEarned.tools.map(t => t.earnedTotal))}`);

  console.log("\nN-G. the hosted legacy projection is the same single implementation:");
  const legacyHosted = await withReadFailureOn(
    k => k === HOSTED_ITEM(HOSTED_SLUG_2), () => listPublicHostedTools());
  check("listPublicHostedTools returns exactly the honest read's tools",
    JSON.stringify(legacyHosted.map(t => t.slug)) === JSON.stringify(hostedPartial.tools.map(t => t.slug)),
    JSON.stringify(legacyHosted.map(t => t.slug)));

  // ══ O. THE PAID CENSUS — `blue-registry`, $0.05 a call ════════════════════
  //
  // The buyer's whole purchase is `totals`. Before the fix, a throttled Upstash
  // read shipped a smaller catalog under an unqualified `data_source` claim and
  // the buyer had no field to tell a QUIET marketplace from an UNREADABLE one.
  console.log("\nO-A. the paid tool under a read outage:");
  await seedMarketplace();
  const paidOut = await withReadFailure(paidRegistry);
  check("registry_coverage: unavailable",
    paidOut.registry_coverage === "unavailable", paidOut.registry_coverage);
  check("...and a note that says community:0 means NOTHING WAS READ",
    /not an empty registry/i.test(paidOut.registry_note ?? ""),
    JSON.stringify(paidOut.registry_note));
  check("the first-party half is still EXACT — AGENT_TOOLS is compiled in and cannot degrade",
    paidOut.totals.first_party === FIRST_PARTY_COUNT && paidOut.totals.community === 0,
    `first_party=${paidOut.totals.first_party}/${FIRST_PARTY_COUNT} community=${paidOut.totals.community}`);

  console.log("\nO-B. healthy — real totals, no disclaimer:");
  const paidOk = await paidRegistry();
  check("registry_coverage complete and NO registry_note",
    paidOk.registry_coverage === "complete" && paidOk.registry_note === undefined,
    `${paidOk.registry_coverage} note=${JSON.stringify(paidOk.registry_note)}`);
  check(`community = ${EXT_IDS.length}, all = first_party + community`,
    paidOk.totals.community === EXT_IDS.length
      && paidOk.totals.all === FIRST_PARTY_COUNT + EXT_IDS.length,
    JSON.stringify(paidOk.totals));
  // ⚠ The check that caught the SECOND bug in this handler. `tools` is capped at
  // 60 and AGENT_TOOLS is 112 priced tools, so with first-party ordered first
  // every community tool fell off the end — the response claimed "community: 3"
  // and shipped none of them, while closing with "register your own x402 tool".
  check("⚠ community tools actually APPEAR in the capped payload, not just in totals",
    EXT_IDS.every(id => paidOk.tools.some(t => t.id === id && t.source === "community")),
    `${paidOk.tools.filter(t => t.source === "community").length} community entries in a ${paidOk.tools.length}-row payload`);
  check("...and truncation is declared, so tools.length is never mistaken for a count",
    paidOk.tools_truncated === true && paidOk.totals.matched > paidOk.tools.length,
    `truncated=${paidOk.tools_truncated} matched=${paidOk.totals.matched} rows=${paidOk.tools.length}`);

  console.log("\nO-C. partial — the paid answer says which half it is short on:");
  const paidPartial = await withReadFailureOn(k => k === ITEM("gas-oracle"), paidRegistry);
  check("registry_coverage partial, community total is the FLOOR 2",
    paidPartial.registry_coverage === "partial" && paidPartial.totals.community === EXT_IDS.length - 1,
    `${paidPartial.registry_coverage} community=${paidPartial.totals.community}`);
  check("...and the note counts what is missing",
    /1 community tool\(s\) could not be read/i.test(paidPartial.registry_note ?? ""),
    JSON.stringify(paidPartial.registry_note));

  await reset();
  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("test harness error:", e); process.exit(1); });
