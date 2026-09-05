/**
 * Blue Agent — Health Check
 * Referenced in /.well-known/agent.json
 * Used by external agents to verify Blue Agent is up before integrating.
 *
 * This is a PUBLIC storefront: any agent, partner or investor evaluating
 * whether to integrate hits this first. Until 2026-08-18 it live-pinged
 * `llm.bankr.bot` on every request and published the reply verbatim, so the
 * response advertised `"bankr_llm": "error_403: This account has been banned"`
 * — a dead provider's ban notice presented as our own health. Bankr was
 * 403-banned 2026-07-20 and has not been in the inference path since; the
 * probe now targets Virtuals, the only gateway we actually call.
 *
 * Never re-add a provider we don't use: a red light for a dependency we
 * dropped is worse than no light at all, and a green one is a lie.
 */
import { NextResponse } from "next/server";
import { isKVEnabled } from "@/lib/kv";
import { probeVirtuals } from "@/app/api/_lib/llm";

export const runtime = "nodejs";
// Vercel kills serverless functions at 60s by default — explicit budget so
// it fails loudly instead of silently 504-ing.
export const maxDuration = 10;

// Well inside maxDuration: a health check must always answer, even when the
// thing it is checking hangs. A slow gateway is reported as unreachable, not
// escalated into a 504 on our own status page.
const LLM_PROBE_TIMEOUT_MS = 4000;

const START_TIME = Date.now();

export async function GET() {
  const uptime = Math.floor((Date.now() - START_TIME) / 1000);

  const llm = await probeVirtuals(LLM_PROBE_TIMEOUT_MS);

  return NextResponse.json({
    status:   "ok",
    agent:    "Blue Agent",
    version:  "1.0.0",
    network:  "base",
    chain_id: 8453,
    uptime_seconds: uptime,
    services: {
      kv:           isKVEnabled() ? "connected" : "fallback",
      llm_provider: "virtuals",
      llm_model:    llm.model,
      llm_key:      process.env.VIRTUALS_API_KEY ? "set" : "MISSING",
      llm:          llm.status,
      llm_latency_ms: llm.latencyMs,
      // Probe is cached (see probeVirtuals) so a public endpoint can't be used
      // to hammer the gateway. Publish the freshness rather than passing a
      // cached verdict off as a live one.
      llm_checked_at: llm.checkedAt,
      llm_cached:     llm.cached,
    },
    endpoints: {
      web:     "https://blueagent.dev",
      signal:  "https://blueagent.dev/api/signal",
      webhook: "https://blueagent.dev/api/webhook/aeon",
      signals: "https://blueagent.dev/api/signals",
      docs:    "https://blueagent.dev/docs",
    },
    timestamp: new Date().toISOString(),
  }, {
    headers: { "Cache-Control": "no-store" },
  });
}
