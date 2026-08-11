/**
 * Gate 3 concurrency test: 20 concurrent M4 requests + mixed load.
 * Measures success rate, p50/p95 latency, and any 429s escaping to the
 * client. Uses local HANDLERS (fast, no HTTP overhead) to isolate the
 * measurement to upstream (GT / Chainlink RPC / Blockscout) behavior.
 */
import { HANDLERS } from "../src/app/api/x402/_handlers";

async function callOne(tool: string, body: unknown) {
  const t0 = Date.now();
  try {
    const req = new Request(`http://localhost/api/x402/${tool}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const res = await HANDLERS[tool](req);
    const data = await res.json();
    return {
      tool, ok: res.ok && !data.error,
      status: res.status, duration_ms: Date.now() - t0,
      hit_429: (data.warnings ?? []).some((w: string) => w.includes("429") || w.includes("rate")),
      error: data.error ?? null,
    };
  } catch (e) {
    return { tool, ok: false, status: 0, duration_ms: Date.now() - t0, error: (e as Error).message, hit_429: false };
  }
}

function summarize(label: string, results: Array<{ ok: boolean; status: number; duration_ms: number; hit_429: boolean; error: string | null; tool: string }>) {
  const durations = results.map((r) => r.duration_ms).sort((a, b) => a - b);
  const p50 = durations[Math.floor(durations.length / 2)];
  const p95 = durations[Math.floor(durations.length * 0.95)];
  const success = results.filter((r) => r.ok).length;
  const rate429 = results.filter((r) => r.hit_429).length;
  const errored = results.filter((r) => !r.ok);

  console.log(`\n── ${label} ──`);
  console.log(`  success: ${success}/${results.length}`);
  console.log(`  p50: ${p50}ms · p95: ${p95}ms · max: ${Math.max(...durations)}ms`);
  console.log(`  429 signals: ${rate429}`);
  if (errored.length) {
    console.log(`  errors:`);
    for (const e of errored.slice(0, 5)) {
      console.log(`    - ${e.tool} status=${e.status} err=${(e.error ?? "").slice(0, 80)}`);
    }
  }
  return { total: results.length, success, p50, p95, max: Math.max(...durations), rate429, errored: errored.length };
}

async function main() {
  console.log("Gate 3 concurrency test\n");

  // 3.1 — 20× M4 concurrent
  console.log("── 3.1 · 20× rh-stock-movers concurrent ──");
  const scenA = await Promise.all(Array.from({ length: 20 }, () => callOne("rh-stock-movers", { limit: 5 })));
  const sumA = summarize("3.1 result", scenA);

  // 3.2 — mixed: 10× M1 + 5× M5 + 5× D2
  console.log("\n── 3.2 · 10× M1 + 5× M5 + 5× D2 concurrent ──");
  const jobs = [
    ...Array.from({ length: 10 }, () => callOne("rh-stock-quote", { ticker: "AAPL" })),
    ...Array.from({ length: 5 }, () => callOne("rh-stock-arb", { ticker: "AAPL" })),
    ...Array.from({ length: 5 }, () => callOne("rh-stock-flow", { ticker: "AAPL" })),
  ];
  const scenB = await Promise.all(jobs);
  const sumB = summarize("3.2 result", scenB);

  const gatePass =
    sumA.success === 20 && sumA.p95 < 5000 && sumA.rate429 === 0 &&
    sumB.success === 20 && sumB.p95 < 5000 && sumB.rate429 === 0;

  console.log(`\n── GATE 3 ${gatePass ? "PASS ✅" : "FAIL ❌"} ──`);
  console.log(JSON.stringify({ scenario_A: sumA, scenario_B: sumB, pass: gatePass }, null, 2));
  process.exit(gatePass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
