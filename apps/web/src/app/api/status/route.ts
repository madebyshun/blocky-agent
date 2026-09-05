/**
 * Blue Agent — Service Status Check
 * GET /api/status
 *
 * Checks: Virtuals LLM gateway, Hub reachability.
 *
 * PUBLIC endpoint — same storefront caveat as /api/health. Until 2026-08-18
 * this pinged Bankr and Venice, so prod published `status: "degraded"` with
 * `Bankr LLM ok=false HTTP 403` on every call. Both were misleading in
 * opposite directions: Bankr has been 403-banned since 2026-07-20 (a red
 * light for something we don't call), and Venice answered OK while receiving
 * zero traffic from us — `callVeniceLLM` has delegated to Virtuals since
 * 2026-07-25, so that green light measured nothing. Meanwhile the one gateway
 * that can actually take the product down, Virtuals, wasn't checked at all.
 *
 * Rule: only probe what we actually depend on. `status` here gates the public
 * operational/degraded signal, so a stale probe doesn't just look bad — it
 * makes the signal meaningless.
 */
import { NextResponse } from "next/server";
import { probeVirtuals } from "@/app/api/_lib/llm";

export const runtime = "nodejs";
// Vercel kills serverless functions at 60s by default — explicit budget so
// it fails loudly instead of silently 504-ing.
export const maxDuration = 30;

interface ServiceStatus {
  name:    string;
  ok:      boolean;
  latency: number | null;
  detail:  string;
}

async function ping(url: string, opts: RequestInit, label: string): Promise<ServiceStatus> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(8_000) });
    const latency = Date.now() - t0;
    if (res.status === 401) return { name: label, ok: false, latency, detail: "Invalid API key (401)" };
    if (res.status === 429) return { name: label, ok: false, latency, detail: "Rate limited (429)" };
    if (!res.ok)            return { name: label, ok: false, latency, detail: `HTTP ${res.status}` };
    return { name: label, ok: true, latency, detail: "OK" };
  } catch (e) {
    return { name: label, ok: false, latency: null, detail: (e as Error).message };
  }
}

export async function GET() {
  const [llm, hub] = await Promise.all([
    // Virtuals — the only inference gateway. Model list: verifies reachability
    // + key validity without spending credits (see probeVirtuals for why a
    // real completion would be wrong on a public route).
    probeVirtuals(8_000),

    // Hub — internal health check
    ping(
      `${process.env.NEXT_PUBLIC_APP_URL ?? "https://blueagent.dev"}/api/health`,
      {},
      "Blue Hub"
    ),
  ]);

  const checks: ServiceStatus[] = [
    {
      name:    "Virtuals LLM",
      ok:      llm.ok,
      latency: llm.latencyMs,
      detail:  llm.ok ? "OK" : llm.status,
    },
    hub,
  ];

  const allOk = checks.every((c) => c.ok);

  return NextResponse.json(
    {
      status:   allOk ? "operational" : "degraded",
      services: checks,
      ts:       new Date().toISOString(),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
