/**
 * /api/usage — real paid-run counts per tool, for dynamic ranking and the
 * run-count chips on the Hub + Skills catalogs.
 *
 * Counters are `usage:<id>` integers in KV, incremented by every surface that
 * actually executes something:
 *   - /api/x402/[tool]        → paid hub-tool runs
 *   - /api/mcp                → hub tools called over MCP (internal bypass)
 *   - /api/hub/tools/[id]/call→ community-registered hosted tools
 *   - /api/console            → the 5 blue_* commands (idea/build/audit/ship/raise)
 *
 * The id space is closed on purpose: we only ever read keys derived from our
 * own catalogs, never an id supplied by the caller. That keeps this public
 * endpoint from being usable as an arbitrary KV probe.
 *
 * These are FORWARD-ONLY counters — each one starts accruing when its surface
 * was first instrumented, not at project launch. So a 0 means "nothing recorded
 * on this counter", NOT "nobody has ever used it". Consumers must render a
 * count only when it is > 0 rather than printing a zero that reads as a
 * popularity verdict.
 */
import { NextResponse } from "next/server";
import { kvGet } from "@/lib/kv";
import { AGENT_TOOLS } from "@/lib/agent-tools";
import { CONSOLE_SYSTEMS } from "@/lib/console-systems";

export const runtime = "nodejs";
// Vercel kills serverless functions at 60s by default — explicit budget so
// it fails loudly instead of silently 504-ing.
export const maxDuration = 10;

// The 5 console commands are counted as `usage:blue_<cmd>` (see /api/console),
// sharing the hub-tool key shape so one fetch covers every measurable surface.
const CONSOLE_IDS = Object.keys(CONSOLE_SYSTEMS).map((c) => `blue_${c}`);

export async function GET() {
  const ids = [...AGENT_TOOLS.map((t) => t.id), ...CONSOLE_IDS];
  const entries = await Promise.all(
    ids.map(async (id) => [id, (await kvGet<number>(`usage:${id}`)) ?? 0] as const),
  );
  return NextResponse.json(Object.fromEntries(entries), {
    headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" },
  });
}
