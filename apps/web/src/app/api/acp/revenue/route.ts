/**
 * ACP wrapper: Blue Hood REVENUE PROOF (Offering #1).
 *
 * Public GET, ACP-shaped. Exposes the provable outcome of the paid offering:
 * how many ACP jobs Blue Hood has COMPLETED and how much USDC it has provably
 * collected — the "revenue you can verify" signal $IN has and Blue Agent lacked.
 * It also surfaces the consecutive-expire streak so anyone (including us) can see
 * the agent is nowhere near ACP's 10-in-a-row auto-ungraduation.
 *
 * WHY PUBLIC + FREE: provable means anyone can check. Numbers come straight from
 * the KV job ledger (`lib/blue-hood/acp-jobs.ts`), which only ever records public
 * routing/economic facts — no keys, no PII. There is nothing to gate.
 *
 * This is a READ of already-settled facts, never a compute or an on-chain action,
 * so it has no internal deadline — it just reflects the ledger. Empty ledger ⇒
 * all-zero summary (a truthful "no jobs yet"), never a fabricated number.
 */
import { acpEnvelope, clientIp, corsHeaders, preflight, rateLimit } from "@/lib/acp";
import { computeAcpRevenue } from "@/lib/blue-hood/acp-jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DOCS = "https://blueagent.dev/hood";

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

  const summary = await computeAcpRevenue();
  return Response.json(acpEnvelope({ ok: true, ...summary }, DOCS), {
    status: 200,
    headers: corsHeaders(),
  });
}
