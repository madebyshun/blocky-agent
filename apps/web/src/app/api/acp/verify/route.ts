/**
 * ACP wrapper: L4 `rh-rwa-verify` (canonical / non-canonical RWA check).
 *
 * Public GET, no auth, no payment. Maps `?contract=0x… &expected_ticker=…`
 * to the L4 handler and returns the result verbatim + an ACP envelope.
 *
 * L4 is a free tool (price $0.00) that reads Blockscout + the RWA
 * registry — no LLM, no upstream cost. Fine to expose without gating.
 */
import { HANDLERS } from "@/app/api/x402/_handlers";
import { acpEnvelope, clientIp, corsHeaders, preflight, rateLimit } from "@/lib/acp";

export const runtime = "nodejs";

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
  const contract = (url.searchParams.get("contract") ?? "").trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(contract)) {
    return Response.json(
      acpEnvelope(
        { error: "Provide ?contract=0x… (42-char hex address)" },
        "https://blueagent.dev/hub/tool/rh-rwa-verify",
      ),
      { status: 400, headers: corsHeaders() },
    );
  }

  const handler = HANDLERS["rh-rwa-verify"];
  if (!handler) {
    return Response.json(
      acpEnvelope({ error: "L4 handler not registered" }, "https://blueagent.dev/hub/tool/rh-rwa-verify"),
      { status: 503, headers: corsHeaders() },
    );
  }

  // Call the frozen L4 handler with a synthesized POST — it also reads
  // GET query params (see handler line 22) but the internal contract is
  // POST-with-JSON, so we mirror that.
  const inner = new Request(`https://blueagent.dev/api/x402/rh-rwa-verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contract,
      expected_ticker: url.searchParams.get("expected_ticker") ?? undefined,
    }),
  });
  const inner_res = await handler(inner);
  const inner_data = (await inner_res.json().catch(() => ({}))) as Record<string, unknown>;
  return Response.json(
    acpEnvelope(inner_data, "https://blueagent.dev/hub/tool/rh-rwa-verify"),
    { status: inner_res.status, headers: corsHeaders() },
  );
}
