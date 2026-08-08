/**
 * GET /api/credits/balance/[address]
 *
 * Returns the wallet's claimable credit balance:
 *
 *   accrued  — on-chain staking accrual (BlueMarketStaking.totalCreditsAccrued)
 *   topup    — off-chain credits added via USDC top-up
 *   spent    — off-chain credits debited via chat / tool runs
 *   balance  — max(0, accrued + topup - spent)
 *   recent   — last 10 ledger events
 *
 * Public read; cached for 15s so the dashboard doesn't hammer KV + RPC on
 * every render.
 */
import { NextRequest, NextResponse } from "next/server";
import { isAddress } from "viem";
import { getBalance } from "@/lib/credit-ledger";

export const runtime = "nodejs";
// One RPC roundtrip + one KV read — well under a second in practice.
export const maxDuration = 15;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ address: string }> },
) {
  const { address } = await params;
  if (!isAddress(address)) {
    return NextResponse.json({ error: "Invalid address" }, { status: 400 });
  }
  try {
    const summary = await getBalance(address);
    return NextResponse.json(summary, {
      headers: {
        "Cache-Control": "public, s-maxage=15, stale-while-revalidate=60",
      },
    });
  } catch (e) {
    // KV read failed. Deliberately return NO `balance` field: every client here
    // (ChatContext, WalletBar, /app/usage, the dashboard) only applies the value
    // when it parses as a finite number, so they keep the last known figure
    // instead of flashing a fabricated "0 credits" at a paying user.
    return NextResponse.json(
      { error: (e as Error).message, code: "LEDGER_UNAVAILABLE" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
