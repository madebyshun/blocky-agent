/**
 * Blue Hood — Trade prepare proxy (T-E step 3).
 *
 * Thin server-side proxy over `rh-stock-swap-prepare` (X2). Returns
 * the unsigned tx calldata sequence — the client's wallet signs.
 *
 * ────────────────────────────────────────────────────────────────────
 * CRITICAL SAFETY INVARIANT (T-E rule #2):
 *   `recipient` is REQUIRED. It comes from the client's request body
 *   ONLY, and it must match the wallet the user connected in the
 *   Review & Sign panel. The route:
 *     - REJECTS the request if `recipient` is missing / malformed.
 *     - DOES NOT default from any env var or hardcoded address.
 *     - DOES NOT accept a recipient from a URL param — body only, so
 *       it's harder to fat-finger via a shared link.
 *   Wrong recipient = funds go to a stranger's wallet. There is no
 *   "reasonable default" — the tool bounces if the client doesn't
 *   pass one explicitly.
 * ────────────────────────────────────────────────────────────────────
 *
 * NO wallet-vs-request-origin check is performed here (that would be
 * theatre without a signature). The onus is on the CLIENT to pass
 * `useAccount().address` and nothing else — see the grep in
 * `ReviewSignPanel.tsx`.
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
  /** REQUIRED — the wallet that will receive the swap output. Must be
   *  a 0x-prefixed 20-byte address. See safety invariant above. */
  recipient?: string;
};

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;

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
  const recipient = (body.recipient ?? "").trim();

  if (!ticker || !Number.isFinite(amount) || amount <= 0) {
    return NextResponse.json({ error: "bad_input", detail: "ticker + positive amount required" }, { status: 400 });
  }
  if (!recipient || !ADDR_RE.test(recipient)) {
    // Explicit — do not fall back to env, do not read a default. See
    // the safety invariant at the top of this file.
    return NextResponse.json({
      error: "recipient_required",
      detail: "Explicit recipient (0x…) is required. The Review & Sign panel must pass the connected wallet address.",
    }, { status: 400 });
  }

  const r = await callTool<Record<string, unknown>>("rh-stock-swap-prepare", {
    ticker, side, amount, denom, slippage_bps, deadline_minutes, recipient,
  }, { timeoutMs: 25_000 });

  if (!r.ok) {
    return NextResponse.json(
      { error: "prepare_failed", status: r.status, detail: r.error },
      { status: r.status || 502, headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.json(r.data, {
    headers: { "Cache-Control": "no-store" },
  });
}
