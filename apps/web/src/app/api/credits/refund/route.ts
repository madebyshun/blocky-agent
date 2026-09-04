/**
 * POST /api/credits/refund
 *
 * Reverses ONE recorded spend, identified by the `ref` the original
 * /api/credits/spend call carried. Server-to-server only, gated on the same
 * INTERNAL_SERVICE_KEY as /api/credits/spend so there is one auth knob to
 * rotate.
 *
 * Body:
 *   { address, ref }          ← note: NO amount
 *
 * The missing `amount` is the entire security design. The figure comes from the
 * recorded spend event, so this endpoint cannot mint credits — the most it can
 * do is un-charge a debit that provably already happened, once. A caller who
 * somehow held the internal key still could not inflate a balance with it.
 *
 * Returns 200 for every outcome, with the outcome in the body, because "there
 * was nothing to refund" is a normal answer here and not an error: the chat
 * route fires this on failure paths that may or may not have debited (guests,
 * zero-cost tiers, a spend that 402'd). Statuses:
 *   refunded     → credits returned
 *   already      → this ref was refunded before; no-op, safe to retry
 *   not-found    → no spend carries that ref (nothing was charged)
 *   unsplittable → event predates bucket-split recording; refused, not guessed
 *
 * 401 → invalid internal key
 * 400 → malformed request
 * 500 → ledger unavailable (KV) — the caller must NOT read this as "refunded"
 */
import { NextRequest, NextResponse } from "next/server";
import { isAddress } from "viem";
import { refund } from "@/lib/credit-ledger";

export const runtime = "nodejs";
export const maxDuration = 15;

const INTERNAL_KEY = process.env.INTERNAL_SERVICE_KEY ?? "";

interface Body {
  address: string;
  ref:     string;
}

export async function POST(req: NextRequest) {
  const auth = req.headers.get("x-blue-internal") ?? req.headers.get("X-Blue-Internal");
  if (!INTERNAL_KEY || auth !== INTERNAL_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { address, ref } = body;
  if (!address || !isAddress(address)) {
    return NextResponse.json({ error: "Invalid address" }, { status: 400 });
  }
  if (!ref || typeof ref !== "string" || ref.length > 120) {
    return NextResponse.json({ error: "Invalid ref" }, { status: 400 });
  }

  try {
    const result = await refund(address, ref);
    return NextResponse.json(result, { status: 200 });
  } catch (e) {
    const err = e as Error & { code?: string };
    // A KV read/write failure must surface as a failure. Flattening it into
    // `{ status: "not-found" }` would tell the chat route the user was never
    // charged, which is the one thing we cannot know when the ledger is down.
    return NextResponse.json(
      { error: err.message ?? "Refund failed", code: err.code },
      { status: 500 },
    );
  }
}
