/**
 * Gate 2 semantic smoke — asserts BEHAVIOR, not just HTTP 200.
 *
 * Two modes:
 *   • `TARGET` env set → HTTP mode. Hits `${TARGET}/api/x402/*` with the
 *     `X-Blue-Internal` bypass. Used in CI against prod. Requires
 *     `INTERNAL_SERVICE_KEY` matching the deployment's value.
 *   • no `TARGET` → local mode. Imports HANDLERS directly, no HTTP, no
 *     secret needed. Fast iteration on assertions.
 *
 * Fails hard (exit 1) on any assertion mismatch — used in GitHub Actions
 * to gate PR merge + on 6h cron to catch prod drift.
 */

const TARGET = process.env.TARGET ?? "";
const INTERNAL_KEY = process.env.INTERNAL_SERVICE_KEY ?? "";
const MODE: "http" | "local" = TARGET ? "http" : "local";

if (MODE === "http" && !INTERNAL_KEY) {
  console.error("INTERNAL_SERVICE_KEY env var required when TARGET is set.");
  process.exit(2);
}

let localHandlers: Record<string, (req: Request) => Promise<Response>> | null = null;
async function getLocalHandlers() {
  if (localHandlers) return localHandlers;
  const mod = await import("../src/app/api/x402/_handlers");
  localHandlers = mod.HANDLERS;
  return localHandlers;
}

async function call(tool: string, body: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
  if (MODE === "http") {
    // NOTE: paid tools require BOTH headers on the internal-bypass path:
    //   - X-Blue-Internal proves the caller knows the internal secret
    //   - X-Blue-Service: internal declares intent as a server-to-server job
    //     (otherwise the handler returns 402 WALLET_REQUIRED to close the
    //     "guest calls paid tool with just the key" loophole).
    const r = await fetch(`${TARGET}/api/x402/${tool}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Blue-Internal": INTERNAL_KEY,
        "X-Blue-Service": "internal",
      },
      body: JSON.stringify(body),
    });
    return { status: r.status, data: await r.json() as Record<string, unknown> };
  }
  const HANDLERS = await getLocalHandlers();
  const h = HANDLERS[tool];
  if (!h) throw new Error(`No handler for ${tool}`);
  const req = new Request(`http://localhost/api/x402/${tool}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = await h(req);
  return { status: res.status, data: await res.json() as Record<string, unknown> };
}

type AssertionResult = { ok: boolean; label: string; detail?: string };
const results: AssertionResult[] = [];
function must(ok: boolean, label: string, detail?: string) {
  results.push({ ok, label, detail });
  if (!ok) console.error(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
  else console.log(`  ✅ ${label}`);
}

async function m5AapleArb() {
  console.log("\n── M5 rh-stock-arb AAPL ──");
  const r = await call("rh-stock-arb", { ticker: "AAPL" });
  must(r.status === 200, "M5 status 200", `got ${r.status}`);

  const allowedVerdicts = ["ALIGNED", "LONG_DEX", "SHORT_DEX", "FROZEN_ALIGNED", "PREMARKET_DRIFT", "AFTERHOURS_DRIFT", "INSUFFICIENT_DATA"];
  must(
    allowedVerdicts.includes(r.data.verdict as string),
    `M5 verdict ∈ ${allowedVerdicts.join("|")}`,
    `got "${r.data.verdict}"`,
  );

  const market = r.data.market as { is_open?: boolean; session?: string } | undefined;
  const nyNow = new Date(Date.now() - 4 * 3600 * 1000);
  const day = nyNow.getUTCDay();
  const minutes = nyNow.getUTCHours() * 60 + nyNow.getUTCMinutes();
  const isWeekend = day === 0 || day === 6;
  const expectedOpen = !isWeekend && minutes >= 9 * 60 + 30 && minutes < 16 * 60;
  must(
    market?.is_open === expectedOpen,
    `M5 market.is_open matches NY clock (${expectedOpen ? "open" : "closed"})`,
    `got is_open=${market?.is_open}`,
  );
}

async function x1SwapQuote() {
  console.log("\n── X1 rh-stock-swap-quote AAPL ──");
  // Retry once — GT can rate-limit and force chainlink fallback, but the
  // reviewer's rule says spot_source MUST be "pool" (prevents X2 revert
  // when oracle diverges). One retry with a short cooldown clears
  // transient rate-limits.
  let r = await call("rh-stock-swap-quote", { ticker: "AAPL", side: "buy", amount: 100, denom: "USDG" });
  if (r.data.spot_source !== "pool") {
    await new Promise((res) => setTimeout(res, 1500));
    r = await call("rh-stock-swap-quote", { ticker: "AAPL", side: "buy", amount: 100, denom: "USDG" });
  }
  must(r.status === 200, "X1 status 200", `got ${r.status}`);
  const exp = r.data.expected_out as number;
  const eai = r.data.expected_after_impact as number;
  const min = r.data.min_out as number;
  must(typeof exp === "number" && exp > 0, "X1 expected_out is positive number");
  must(typeof eai === "number" && eai > 0, "X1 expected_after_impact is positive number");
  must(typeof min === "number" && min > 0, "X1 min_out is positive number");
  must(min < eai, "X1 min_out < expected_after_impact");
  must(eai <= exp, "X1 expected_after_impact <= expected_out");
  must(r.data.spot_source === "pool", `X1 spot_source == "pool" (after retry)`, `got "${r.data.spot_source}"`);
}

async function m4Movers() {
  console.log("\n── M4 rh-stock-movers ──");
  const r = await call("rh-stock-movers", { limit: 10 });
  must(r.status === 200, "M4 status 200", `got ${r.status}`);
  const gainers = (r.data.gainers ?? []) as Array<Record<string, unknown>>;
  const losers = (r.data.losers ?? []) as Array<Record<string, unknown>>;

  for (const g of gainers) {
    must(
      typeof g.tvl_usd === "number" && (g.tvl_usd as number) >= 5000,
      `M4 gainer ${g.ticker} tvl_usd ≥ $5k`,
      `got ${g.tvl_usd}`,
    );
    must(
      typeof g.volume_24h_usd === "number" && (g.volume_24h_usd as number) >= 500,
      `M4 gainer ${g.ticker} volume_24h ≥ $500`,
    );
  }
  const gTickers = new Set(gainers.map((g) => g.ticker));
  const overlap = losers.some((l) => gTickers.has(l.ticker));
  must(!overlap, "M4 gainers / losers disjoint");
}

async function m2Ohlc() {
  console.log("\n── M2 rh-stock-ohlc AAPL day×7 ──");
  const r = await call("rh-stock-ohlc", { ticker: "AAPL", timeframe: "day", limit: 7 });
  must(r.status === 200, "M2 status 200", `got ${r.status}`);
  const candlesReturned = r.data.candles_returned as number;
  const warnings = (r.data.warnings ?? []) as string[];
  // Accepted "we don't have full data" honesty warnings — each surfaces a
  // real reason the candle array is short (or empty). Any of them satisfies
  // the reviewer's rule that M2 must never silently return incomplete data.
  const HONESTY_WARNINGS = ["insufficient_history", "ohlc_unavailable", "single_candle", "no_pool"];
  const hasHonestyWarning = warnings.some((w) => HONESTY_WARNINGS.some((h) => w.includes(h)));
  must(
    (candlesReturned ?? 0) >= 1 || hasHonestyWarning,
    "M2 candles_returned ≥ 1 OR partial-data honesty warning",
    `candles_returned=${candlesReturned}, warnings=${JSON.stringify(warnings)}`,
  );
}

async function l4Verify() {
  console.log("\n── L4 rh-rwa-verify (MSTR + random) ──");
  const mstr = await call("rh-rwa-verify", { contract: "0xec262a75e413fAfD0dF80480274532C79D42da09" });
  must(mstr.status === 200, "L4 MSTR status 200");
  must(mstr.data.verdict === "CANONICAL", "L4 MSTR verdict CANONICAL", `got "${mstr.data.verdict}"`);

  const rand = await call("rh-rwa-verify", { contract: "0x0000000000000000000000000000000000001234" });
  must(rand.status === 200, "L4 random status 200");
  must(rand.data.verdict !== "CANONICAL", `L4 random verdict != CANONICAL`, `got "${rand.data.verdict}"`);
}

async function a4Brief() {
  console.log("\n── A4 rh-stock-agent-brief AAPL ──");
  const r = await call("rh-stock-agent-brief", { ticker: "AAPL" });
  must(r.status === 200, "A4 status 200");
  const llm = r.data.llm as {
    provider?: string | null;
    web_search_used?: boolean;
    duration_ms?: number | null;
    attempts?: Array<{ provider?: string; status?: string; duration_ms?: number }>;
  } | undefined;
  must(llm?.provider != null, "A4 llm.provider non-null", `got provider=${llm?.provider}`);

  // Log-only evidence (no assertion change). Grep target for launch
  // content — the first line here becomes "provider=virtuals model=X
  // duration_ms=Y" once the chain is healthy.
  if (llm?.provider) {
    const attempt = llm.attempts?.find((a) => a.provider === llm.provider && a.status === "success");
    // A4's response doesn't currently surface the model that succeeded, so
    // we derive it from what the deployed llm.ts would pick: env override
    // → VIRTUALS_DEFAULT_MODEL for the virtuals path; llama-3.3-70b for
    // venice. We prefix the log line so a `grep '\[a4-evidence\]'` in the
    // CI log pulls it out cleanly.
    const modelHint = llm.provider === "virtuals" ? "deepseek-deepseek-v4-flash (default; env VIRTUALS_MODEL overrides)"
      : llm.provider === "venice"   ? "llama-3.3-70b (Venice default)"
      : "(bankr default)";
    console.log(`  [a4-evidence] provider=${llm.provider} model=${modelHint} duration_ms=${llm.duration_ms ?? attempt?.duration_ms ?? "n/a"}`);
  } else {
    // Failure evidence — prints the full chain trace so the next CI log
    // says exactly which provider(s) failed and why. Log-only, no new
    // assertion. Grep target: `[a4-fail-chain]`.
    const attemptsStr = (llm?.attempts ?? [])
      .map((a) => {
        const err = (a as { error?: string }).error ?? "";
        return `${a.provider ?? "?"}:${a.status ?? "?"}${a.duration_ms != null ? `:${a.duration_ms}ms` : ""}${err ? ` err="${err.slice(0, 120)}"` : ""}`;
      })
      .join(" | ") || "no_attempts_array";
    console.log(`  [a4-fail-chain] attempts=[${attemptsStr}] warnings=${JSON.stringify(((r.data.warnings ?? []) as string[]).slice(0, 6))}`);
  }

  const warnings = (r.data.warnings ?? []) as string[];
  if (llm?.web_search_used === false) {
    const has = warnings.some((w) => w.includes("no_web_search_this_run"));
    must(has, "A4 no_web_search_this_run warning when web_search_used=false");
  }
}

async function main() {
  console.log(`Semantic smoke → ${TARGET}`);
  await m5AapleArb();
  await x1SwapQuote();
  await m4Movers();
  await m2Ohlc();
  await l4Verify();
  await a4Brief();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n── SUMMARY ── ${results.length - failed.length}/${results.length} pass`);
  if (failed.length) {
    console.error(`\n${failed.length} assertion(s) failed:`);
    for (const f of failed) console.error(`  - ${f.label}${f.detail ? ` (${f.detail})` : ""}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
