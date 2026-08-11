/**
 * Blue Hood — Trade quote proxy (T-E step 1).
 *
 * Thin server-side proxy over `rh-stock-swap-quote` (X1) so the Review
 * & Sign panel can hit ONE public endpoint on our own domain instead
 * of dealing with x402 402/tool-runner routing on the client. Uses the
 * shared `callTool` (internal-bypass in prod, HANDLERS import in dev).
 *
 * Contract: whatever X1 returns, we return verbatim — including its
 * `warnings` array. NO filtering, NO editorializing (E-rule #4:
 * "display tool warnings VERBATIM"). If the tool errors,
 * we surface the status + message so the panel can render "quote
 * failed · <reason>" instead of hanging.
 *
 * Rate-limited (chat identifier — one per IP+wallet combo). Never
 * writes anything; safe to call at any interval.
 */
import { NextRequest, NextResponse } from "next/server";
import { callTool } from "@/lib/blue-hood/tool-caller";
import { rateLimit, getIdentifier } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  ticker?: string;
  side?: "buy" | "sell";
  amount?: string | number;
  denom?: "USDG" | "WETH";
  slippage_bps?: number;
  deadline_minutes?: number;
};

export async function POST(req: NextRequest) {
  const { success } = await rateLimit(getIdentifier(req), "chat");
  if (!success) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  let body: Body = {};
  try { body = (await req.json()) as Body; } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const ticker = (body.ticker ?? "").trim().toUpperCase();
  const side = body.side === "sell" ? "sell" : "buy";
  const amount = Number(body.amount);
  const denom = body.denom === "WETH" ? "WETH" : "USDG";
  const slippage_bps = Number.isFinite(body.slippage_bps as number)
    ? Math.max(1, Math.min(5000, Math.trunc(body.slippage_bps as number)))
    : 100;
  const deadline_minutes = Number.isFinite(body.deadline_minutes as number)
    ? Math.max(1, Math.min(60, Math.trunc(body.deadline_minutes as number)))
    : 5;

  if (!ticker || !Number.isFinite(amount) || amount <= 0) {
    return NextResponse.json({ error: "bad_input", detail: "ticker + positive amount required" }, { status: 400 });
  }

  const r = await callTool<Record<string, unknown>>("rh-stock-swap-quote", {
    ticker, side, amount, denom, slippage_bps, deadline_minutes,
  }, { timeoutMs: 20_000 });

  if (!r.ok) {
    return NextResponse.json(
      { error: "quote_failed", status: r.status, detail: r.error },
      { status: r.status || 502, headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.json(r.data, {
    headers: { "Cache-Control": "no-store" },
  });
}
