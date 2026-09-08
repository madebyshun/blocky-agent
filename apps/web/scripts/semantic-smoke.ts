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

// This script answers two DIFFERENT questions depending on how it was
// triggered, and one of its assertions was only ever valid for one of them:
//
//   schedule (0 */6 * * *) → MONITOR. "Is prod healthy right now?" A third-
//                            party gateway being down is a real incident and
//                            SHOULD go red.
//   pull_request           → GATE.    "Is it safe to merge this diff?" The
//                            script hits TARGET=blueagent.dev, i.e. PROD — it
//                            never executes the branch's code — so an upstream
//                            outage says nothing about the diff, yet it blocked
//                            the merge anyway.
//
// MEASURED 2026-09-07: that is exactly what happened to #416. Virtuals
// returned `content_len=0`, A4's `llm.provider` came back null, and a PR whose
// diff touches no rh-* handler and no LLM path went red. `main` itself was red
// in 3 of its last 4 runs for the same reason. A gate that a PR cannot pass by
// being correct, and cannot fail by being wrong, is not gating anything.
//
// So: assertions that depend on a THIRD-PARTY service are declared with
// `mustUpstream` and are advisory in gate mode. Everything about OUR OWN code
// — including how it degrades when that service is down — stays `must` and
// stays fatal in both modes. This narrows what can block a merge; it does not
// narrow what gets checked.
const SMOKE_MODE = (process.env.SMOKE_MODE ?? "monitor").toLowerCase() === "gate" ? "gate" : "monitor";
const upstreamDown: string[] = [];
function mustUpstream(ok: boolean, label: string, detail?: string) {
  if (ok || SMOKE_MODE === "monitor") return must(ok, label, detail);
  upstreamDown.push(`${label}${detail ? ` — ${detail}` : ""}`);
  console.warn(`  ⚠️  ${label}${detail ? ` — ${detail}` : ""} (upstream dependency; advisory in gate mode)`);
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
  must(r.status === 200, "A4 status 200", `got ${r.status}`);
  // Every assertion below reads the `llm` block of the response BODY. If the
  // call itself didn't succeed there is no body to read, and asserting on it
  // invents a second finding for one cause — a 402 would be reported as both
  // "status != 200" AND "the tool failed to admit its context was missing",
  // the latter describing a degradation path that was never reached. One root
  // cause, one failure line.
  if (r.status !== 200) return;
  const llm = r.data.llm as {
    provider?: string | null;
    web_search_used?: boolean;
    duration_ms?: number | null;
    attempts?: Array<{ provider?: string; status?: string; duration_ms?: number }>;
  } | undefined;
  // Upstream: this is Virtuals' uptime, not our correctness. Fatal on the 6h
  // monitor, advisory on a PR — see the mustUpstream header.
  mustUpstream(llm?.provider != null, "A4 llm.provider non-null", `got provider=${llm?.provider}`);

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

  // The handler emits ONE of two mutually-exclusive warnings, and this used to
  // assert on only half of the condition that picks between them. From
  // rh-stock-agent-brief.ts:
  //
  //   llm_provider === null           → "llm_context_unavailable: …"
  //   provider !== null && !searched  → "no_web_search_this_run: served by <p>…"
  //
  // The second is deliberately withheld when no provider answered, because its
  // own text reads "served by <provider>" and "served by null" is nonsense.
  // The old check keyed on `web_search_used === false` alone — which is also
  // the default when the gateway never answered (llm_web_search_used = false at
  // declaration) — so on an outage it demanded the exact warning the handler is
  // written not to emit, and failed CORRECT degradation.
  //
  // Both branches are now asserted. The `else` is NEW and is deliberately
  // fatal: a null provider with no warning at all would be a silent degrade —
  // the tool answering 200 with a deterministic verdict while never admitting
  // the narrative context is missing. That is our bug, not Virtuals', so it
  // blocks a merge in either mode.
  const warnings = (r.data.warnings ?? []) as string[];
  if (llm?.provider != null) {
    if (llm.web_search_used === false) {
      must(
        warnings.some((w) => w.includes("no_web_search_this_run")),
        "A4 no_web_search_this_run warning when a provider answered without search",
        `warnings=${JSON.stringify(warnings)}`,
      );
    }
  } else {
    must(
      warnings.some((w) => w.includes("llm_context_unavailable")),
      "A4 llm_context_unavailable warning when no provider answered",
      `warnings=${JSON.stringify(warnings)}`,
    );
  }
}

async function main() {
  console.log(`Semantic smoke → ${TARGET} [mode=${SMOKE_MODE}]`);
  await m5AapleArb();
  await x1SwapQuote();
  await m4Movers();
  await m2Ohlc();
  await l4Verify();
  await a4Brief();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n── SUMMARY ── ${results.length - failed.length}/${results.length} pass`);

  // Downgraded, never dropped. A gate-mode run that goes green while a
  // dependency is down still SAYS SO, in the log and in the job summary — the
  // point was to stop an outage blocking merges, not to stop reporting it.
  if (upstreamDown.length) {
    console.warn(`\n⚠️  ${upstreamDown.length} upstream-dependency assertion(s) failed (advisory in gate mode):`);
    for (const u of upstreamDown) console.warn(`  - ${u}`);
    console.warn(`  → prod may be degraded right now. The 6h monitor run treats these as fatal.`);
  }

  if (failed.length) {
    console.error(`\n${failed.length} assertion(s) failed:`);
    for (const f of failed) console.error(`  - ${f.label}${f.detail ? ` (${f.detail})` : ""}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
