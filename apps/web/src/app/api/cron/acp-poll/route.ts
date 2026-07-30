/**
 * Blue Hood — ACP v2 seller poll cron (task 2.3, Offering #1: execution-plan).
 *
 * Drives the paid Virtuals ACP offering from a serverless tick (the v1 host
 * decision: no always-on listener). Every ~2 min it runs ONE poll cycle:
 * connect → hydrate active jobs → act on our provider jobs by status → stop.
 * See `lib/blue-hood/acp-seller.ts` for the settlement boundary and the
 * anti-ungraduation guarantees (reject-incomplete, internal deadline < SLA,
 * exactly-once submit, every job logged to the KV ledger).
 *
 * INERT UNTIL CONFIGURED: with no ACP_WALLET_ADDRESS / ACP_WALLET_ID /
 * ACP_SIGNER_PRIVATE_KEY, `runAcpPollCycle()` returns `configured:false` WITHOUT
 * importing the heavy SDK — so this cron is a cheap no-op on every deploy that
 * hasn't wired the offering. It NEVER throws: a poll failure degrades this tick
 * only (jobs remain for the next), it never 500s the cron.
 *
 * Auth: `Authorization: Bearer $CRON_SECRET` (or `?secret=`) — same pattern as
 * the other Blue Hood crons.
 */
import { NextRequest, NextResponse } from "next/server";
import { runAcpPollCycle } from "@/lib/blue-hood/acp-seller";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const CRON_SECRET = process.env.CRON_SECRET ?? "";

function isAuthorized(req: NextRequest): boolean {
  if (!CRON_SECRET) return process.env.NODE_ENV !== "production";
  const authHeader = req.headers.get("authorization") ?? "";
  const secretParam = new URL(req.url).searchParams.get("secret") ?? "";
  return authHeader === `Bearer ${CRON_SECRET}` || secretParam === CRON_SECRET;
}

async function handle(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // runAcpPollCycle is total — it returns a result on every path and never
  // throws. The extra try/catch is belt-and-suspenders so the cron itself can
  // never 500 (a 500 would look like an outage to Vercel's cron monitor).
  try {
    const result = await runAcpPollCycle();
    if (result.configured) {
      console.log(
        `[acp-poll] ${result.ok ? "ok" : "degraded"} ` +
          `sessions=${result.provider_sessions ?? 0} budget=${result.budget_proposed ?? 0} ` +
          `delivered=${result.delivered ?? 0} rejected=${result.rejected_input ?? 0} ` +
          `declined=${result.declined ?? 0} completed=${result.completed ?? 0} ` +
          `expired=${result.expired ?? 0} errors=${result.errors ?? 0} ` +
          `${result.error ? "err=" + result.error + " " : ""}duration_ms=${result.duration_ms}`,
      );
    }
    return NextResponse.json(result);
  } catch (e) {
    // Should be unreachable (runAcpPollCycle is total), but a cron must never
    // surface a 500. Report as a soft-degraded tick.
    console.warn(`[acp-poll] unexpected throw: ${(e as Error).message}`);
    return NextResponse.json({ ok: false, configured: true, error: "unexpected", duration_ms: 0 });
  }
}

export const POST = handle;
export const GET = handle;
