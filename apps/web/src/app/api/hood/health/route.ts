/**
 * Blue Hood — engine health endpoint.
 *
 * ONE public source of truth for "is the engine alive, and if not, WHY". Both
 * the /hood banner and the Telegram broadcaster (2.2) read this so that when the
 * engine is silent they can say the REAL cause instead of going silent too.
 *
 *   curl -s https://blueagent.dev/api/hood/health | jq
 *
 * WHY THIS EXISTS: the 2026-07-27 outage (Upstash hit its 500K plan cap) left
 * the engine dark for hours because every surface read the snapshot via `kvGet`,
 * which swallows the KV error and returns null — indistinguishable from "the
 * poller never ran". This endpoint delegates to `computeEngineHealth`, which
 * probes KV WITHOUT swallowing and cross-references two timestamps to produce
 * exactly one of five non-overlapping states, each naming the real problem.
 *
 * HTTP status maps to observability, NOT to health:
 *   • observable  → 200. The engine's state is knowable (even if it's `cron_stalled`).
 *   • !observable → 503. This is the `kv_error` case ONLY — we literally cannot
 *     see, so a monitor should treat it as "blind", never as "engine down".
 * A consumer that just wants "should I broadcast?" reads `ok` (true only for
 * healthy | lagging); one that wants "can I even see?" reads `observable`.
 *
 * Public read — no secret. It exposes only health metadata (timestamps, ages,
 * a cause string), never wallet/user data, so the bot and board can poll it
 * without an internal key.
 */
import { NextResponse } from "next/server";
import { computeEngineHealth } from "@/lib/blue-hood/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const health = await computeEngineHealth();
  // 503 ONLY when we can't observe (kv_error). A confirmed-bad-but-visible state
  // (cron_stalled, poll_failing, never_polled) is still a 200 — the answer is
  // known, it's just not "healthy". This keeps "blind" and "down" distinct all
  // the way out to the HTTP layer, which is the whole point of this module.
  const status = health.observable ? 200 : 503;
  return NextResponse.json(health, {
    status,
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}
