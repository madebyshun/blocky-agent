/**
 * Blue Hood v3 P1.1 — V4 count diagnostic.
 *
 * The question: of the 26 tickers on the RH Chain watchlist, how many
 * have a deepest pool on Uniswap V4 that our V3-only router cannot
 * route through? Bằng chứng: SPCX → V3 pool, swap OK. SNDK → no route.
 * BABA → 4/4 pools all V4.
 *
 * This script hits the SAME quote endpoint the panel uses, once per
 * ticker with a $1 USDG buy. For each: whether the quote returns
 * `route.executable === true` and, if false, why. Also shows the
 * deepest pool version reported by GT.
 *
 * Decision rule (per user):
 *   > 1/3 of tickers not routable → task #75 (V4/Universal Router)
 *   enters T-E immediately. Otherwise, merge T-E with V3 and lean on
 *   the existing `no_executable_route_v3_only` warning in the UI.
 *
 * Read-only. No KV writes, no signing. Fires 26 requests sequentially
 * with a 500ms stagger to stay under any per-IP rate limits on the
 * quote endpoint.
 *
 * Run: cd apps/web && npx tsx scripts/hood-v4-diagnostic.ts
 */

export {};

import { HOOD_WATCHLIST } from "../src/lib/blue-hood/registry";

interface QuoteResponse {
  ticker?: string;
  route?: {
    kind?: string;
    executable?: boolean;
    unavailable_reason?: string | null;
    version?: string; // "v3" | "v4" | mix
    pool_ref?: string;
  };
  dex?: {
    primary_pool_version?: string;
    pools?: Array<{ version?: string; tvl_usd?: number; pool_ref?: string }>;
  };
  warnings?: string[];
  error?: string;
  detail?: string;
}

interface Row {
  ticker: string;
  status: "executable" | "not_executable" | "quote_error";
  reason: string;
  primaryVersion: string | null;
  poolCount: number | null;
  v3PoolCount: number | null;
  v4PoolCount: number | null;
  deepestVersion: string | null;
}

const PROD = "https://blueagent.dev/api/hood/trade/quote";

async function probe(ticker: string): Promise<Row> {
  try {
    const res = await fetch(PROD, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticker, side: "buy", amount: 1, denom: "USDG", slippage_bps: 100 }),
    });
    const body = (await res.json()) as QuoteResponse;
    if (!res.ok || body.error) {
      return {
        ticker,
        status: "quote_error",
        reason: body.detail ?? body.error ?? `HTTP ${res.status}`,
        primaryVersion: null,
        poolCount: null,
        v3PoolCount: null,
        v4PoolCount: null,
        deepestVersion: null,
      };
    }
    const pools = body.dex?.pools ?? [];
    // Sort deepest first.
    const sorted = [...pools].sort((a, b) => (b.tvl_usd ?? 0) - (a.tvl_usd ?? 0));
    const deepestVersion = sorted[0]?.version ?? null;
    const executable = Boolean(body.route?.executable);
    return {
      ticker,
      status: executable ? "executable" : "not_executable",
      reason: body.route?.unavailable_reason ?? (executable ? "ok" : "unknown"),
      primaryVersion: body.route?.version ?? body.dex?.primary_pool_version ?? null,
      poolCount: pools.length,
      v3PoolCount: pools.filter((p) => (p.version ?? "").toLowerCase().includes("v3")).length,
      v4PoolCount: pools.filter((p) => (p.version ?? "").toLowerCase().includes("v4")).length,
      deepestVersion,
    };
  } catch (e) {
    return {
      ticker,
      status: "quote_error",
      reason: (e as Error).message,
      primaryVersion: null,
      poolCount: null,
      v3PoolCount: null,
      v4PoolCount: null,
      deepestVersion: null,
    };
  }
}

async function main() {
  console.log("═══ BLUE HOOD V3 P1.1 — V4 COUNT DIAGNOSTIC ═══");
  console.log(`watchlist size: ${HOOD_WATCHLIST.length}`);
  console.log(`probing prod: ${PROD} (1 USDG buy per ticker, 500ms stagger)\n`);

  const rows: Row[] = [];
  for (let i = 0; i < HOOD_WATCHLIST.length; i++) {
    const t = HOOD_WATCHLIST[i];
    process.stdout.write(`[${i + 1}/${HOOD_WATCHLIST.length}] ${t.ticker.padEnd(6)} … `);
    const row = await probe(t.ticker);
    rows.push(row);
    console.log(`${row.status.padEnd(15)} deepest=${(row.deepestVersion ?? "?").padEnd(4)} pools=${row.poolCount ?? "?"} (v3=${row.v3PoolCount ?? "?"} v4=${row.v4PoolCount ?? "?"})${row.status !== "executable" ? " · " + row.reason : ""}`);
    if (i < HOOD_WATCHLIST.length - 1) await new Promise((r) => setTimeout(r, 500));
  }

  // ── Table ──────────────────────────────────────────────────────────────
  console.log("\n═══ TABLE ═══");
  console.log(`${"ticker".padEnd(7)} ${"status".padEnd(15)} ${"primary".padEnd(8)} ${"pools".padEnd(6)} ${"v3".padEnd(3)} ${"v4".padEnd(3)} ${"deepest".padEnd(8)} reason`);
  for (const r of rows) {
    console.log(`${r.ticker.padEnd(7)} ${r.status.padEnd(15)} ${(r.primaryVersion ?? "?").padEnd(8)} ${(r.poolCount ?? "?").toString().padEnd(6)} ${(r.v3PoolCount ?? "?").toString().padEnd(3)} ${(r.v4PoolCount ?? "?").toString().padEnd(3)} ${(r.deepestVersion ?? "?").padEnd(8)} ${r.reason}`);
  }

  // ── Summary ────────────────────────────────────────────────────────────
  const total = rows.length;
  const okCount = rows.filter((r) => r.status === "executable").length;
  const noRouteCount = rows.filter((r) => r.status === "not_executable").length;
  const errorCount = rows.filter((r) => r.status === "quote_error").length;
  const v4DeepestButNotRoutable = rows.filter(
    (r) => r.status === "not_executable" && (r.deepestVersion ?? "").toLowerCase().includes("v4"),
  ).length;
  const notRoutableRatio = noRouteCount / total;

  console.log("\n═══ SUMMARY ═══");
  console.log(`executable:                       ${okCount}/${total}`);
  console.log(`not executable:                   ${noRouteCount}/${total}`);
  console.log(`  of those, deepest is V4:        ${v4DeepestButNotRoutable}`);
  console.log(`quote errors (not counted):       ${errorCount}`);
  console.log();
  console.log(`Not-routable ratio: ${(notRoutableRatio * 100).toFixed(1)}% (threshold 33.3%)`);
  console.log(
    notRoutableRatio > 1 / 3
      ? "→ DECISION: >1/3 not routable · TASK #75 (V4 / Universal Router) enters T-E immediately."
      : "→ DECISION: ≤1/3 not routable · merge T-E with V3-only · UI already warns via `no_executable_route_v3_only`.",
  );

  console.log("\n═══ END OF DIAGNOSTIC ═══");
}

main().catch((e) => { console.error(e); process.exit(1); });
