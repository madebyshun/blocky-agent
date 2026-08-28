/**
 * /api/v1/healthz — liveness probe read by monitors and other agents.
 *
 * Two fields here were lying, and a health check is the worst place for it:
 * it is the endpoint whose entire job is to be trusted about the system's own
 * state, so a wrong answer here poisons every decision made downstream of it.
 *
 *  • `tools: 41` was a hardcoded literal, frozen at whatever the count was
 *    when this file was written. The real catalog is now TOOL_COUNT (112).
 *    Derived now, so it cannot go stale again.
 *
 *  • `upstreamLlm` was `!!process.env.BANKR_API_KEY`. Bankr was 403-banned
 *    2026-07-20 and BANKR_API_KEY is a DEAD env var that is not set anywhere,
 *    so this reported `false` — "our LLM is down" — permanently, while
 *    inference was in fact healthy on Virtuals the whole time. That is a
 *    false NEGATIVE in a health check: it invites someone to go debug, rotate
 *    keys, or redeploy in response to an outage that isn't happening, which is
 *    exactly the failure mode CLAUDE.md's "READ THE CODE before blaming infra"
 *    rule exists to prevent. Now keyed to VIRTUALS_API_KEY, the credential the
 *    gateway actually reads (`_lib/llm.ts:219`).
 *
 * Note this stays a CONFIGURATION check, not a reachability check — it says a
 * key is present, not that Virtuals answered. Naming it `llmKeyConfigured`
 * rather than `upstreamLlm` keeps that boundary visible instead of implying a
 * live upstream ping we never make.
 */
import { NextResponse } from "next/server";
import { TOOL_COUNT }   from "@/lib/agent-tools";

export async function GET() {
  return NextResponse.json(
    {
      ok:        true,
      service:   "blueagent-api",
      version:   "v1",
      timestamp: new Date().toISOString(),
      tools:     TOOL_COUNT,
      llmKeyConfigured: !!process.env.VIRTUALS_API_KEY,
      llmProvider:      "virtuals",
    },
    {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
      },
    }
  );
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin":  "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
    },
  });
}
