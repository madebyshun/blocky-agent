/**
 * ACP wrapper: Blue Hood EXECUTION PLAN (Offering #1).
 *
 * Public GET, ACP-shaped. Given `?ticker=&size_usd=` it returns a Blue Hood
 * execution plan (deepest pool + slippage estimate + split + route) computed
 * live from RH-Chain pool data — see `lib/blue-hood/execution-plan.ts`.
 *
 * WHY FREE-AT-THE-URL: like the other `/api/acp/*` endpoints, the HTTP layer
 * carries no paywall. Monetisation for Offering #1 is the ACP job/escrow layer
 * (built once the seller-adapter shape is confirmed with Virtuals) — the ACP
 * adapter is the sanctioned caller and gates on funded escrow. Exposing the
 * compute here now gives us the exact shape the adapter will call plus a URL to
 * self-test from outside (a graduation requirement).
 *
 * ── Anti-ungraduation guarantees enforced HERE ───────────────────────────────
 *   • REJECT-INCOMPLETE, immediately: missing/blank params → 400 with a clear,
 *     structured error. Never let a malformed request run then expire.
 *   • DECLINE, don't hang: the compute is raced against an INTERNAL deadline
 *     (< any ACP SLA). If live data is slow (GeckoTerminal 429/backoff) we
 *     return 503 "temporarily unavailable" — the job is declined with NO charge
 *     rather than left to time out.
 *   • The engine health-gate is deliberately NOT applied: this plan reads pools
 *     LIVE from GeckoTerminal, independent of the KV snapshot poller, so gating
 *     on `computeEngineHealth()` would cause FALSE declines when an unrelated KV
 *     throttle is up. The real dependency-gate ("did live pool data come back")
 *     lives in `computeExecutionPlan` → `no_market_data` decline.
 */
import { acpEnvelope, clientIp, corsHeaders, preflight, rateLimit } from "@/lib/acp";
import { computeExecutionPlan, type ExecPlanResult } from "@/lib/blue-hood/execution-plan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DOCS = "https://blueagent.dev/hood";
// Internal deadline. Must sit UNDER any ACP job SLA so we proactively decline
// instead of letting a job expire. GeckoTerminal's worst-case backoff can run
// long; 12s bounds our wait without cutting off a normal (~1–3s) read.
const INTERNAL_DEADLINE_MS = 12_000;

type Timeout = { __timeout: true };
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T | Timeout> {
  return Promise.race([
    p,
    new Promise<Timeout>((res) => setTimeout(() => res({ __timeout: true }), ms)),
  ]);
}

export async function OPTIONS() {
  return preflight();
}

export async function GET(req: Request) {
  const rl = rateLimit(clientIp(req));
  if (!rl.ok) {
    return Response.json(
      { error: "rate_limited", retry_after_s: rl.retry_after_s },
      { status: 429, headers: { ...corsHeaders(), "Retry-After": String(rl.retry_after_s) } },
    );
  }

  const url = new URL(req.url);
  const ticker = (url.searchParams.get("ticker") ?? "").trim();
  const sizeRaw = (url.searchParams.get("size_usd") ?? url.searchParams.get("size") ?? "").trim();
  const side = (url.searchParams.get("side") ?? "buy").trim().toLowerCase() === "sell" ? "sell" : "buy";

  // ── Reject-incomplete FAST — before any compute or network ───────────────
  if (!ticker || !sizeRaw) {
    return Response.json(
      acpEnvelope(
        {
          ok: false,
          error: "missing_input",
          reason: "Both `ticker` and `size_usd` are required.",
          hint: "e.g. /api/acp/execution-plan?ticker=TSLA&size_usd=100000",
        },
        DOCS,
      ),
      { status: 400, headers: corsHeaders() },
    );
  }
  const size = Number(sizeRaw);
  if (!Number.isFinite(size) || size <= 0) {
    return Response.json(
      acpEnvelope(
        {
          ok: false,
          error: "invalid_size",
          reason: "`size_usd` must be a positive number.",
          hint: "e.g. size_usd=100000 for a $100k order.",
        },
        DOCS,
      ),
      { status: 400, headers: corsHeaders() },
    );
  }

  // ── Compute, bounded by the internal deadline (never hang) ────────────────
  const raced = await withDeadline(
    computeExecutionPlan({ ticker, size_usd: size, side }),
    INTERNAL_DEADLINE_MS,
  );
  if ("__timeout" in raced) {
    return Response.json(
      acpEnvelope(
        {
          ok: false,
          error: "temporarily_unavailable",
          reason: `Market data did not return within ${INTERNAL_DEADLINE_MS}ms — job declined, no charge. Retry shortly.`,
        },
        DOCS,
      ),
      { status: 503, headers: corsHeaders() },
    );
  }

  const result = raced as ExecPlanResult;
  if (result.ok === false) {
    // reject = bad input (400, caller fixes it); decline = market unreadable
    // (503, retry later, no charge). Distinct so a buyer/adapter can tell "my
    // fault" from "come back later".
    const status = result.kind === "reject" ? 400 : 503;
    return Response.json(acpEnvelope(result, DOCS), { status, headers: corsHeaders() });
  }

  return Response.json(acpEnvelope(result, DOCS), { status: 200, headers: corsHeaders() });
}
