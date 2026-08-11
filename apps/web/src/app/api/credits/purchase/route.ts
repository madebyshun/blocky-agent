// POST /api/credits/purchase  { address, txHash }
//
// Non-custodial USDC → credits top-up (the "Pay with USDC" flow).
//
// The user signs a DIRECT USDC transfer from their own wallet to the Blue
// treasury (client side, in TopUpModal). This route only READS the settled
// transaction and credits the off-chain ledger — it never holds a key, never
// moves funds, and never trusts a number from the client.
//
// Security model:
//   1. We fetch the on-chain receipt for txHash on Base and require status=success.
//   2. We decode the ERC-20 Transfer logs and sum ONLY transfers where
//        token == USDC_BASE  AND  to == TOPUP_TREASURY  AND  from == caller.
//      Binding `from == caller` stops anyone crediting themselves for someone
//      else's legitimate treasury-inbound transfer.
//   3. Idempotency: an atomic KV NX lock on `purchase:<txHash>` guarantees a
//      given settled tx can mint credits at most once, even under ret/races.
//      On verify-failure we RELEASE the lock (kvDel) so a genuine retry works;
//      on success we KEEP it (long TTL) as the permanent processed-marker.
//
// Credits are derived in CODE from the on-chain USDC amount (CREDITS_PER_USDC),
// never from anything the client sends.

import { NextRequest, NextResponse } from "next/server";
import {
  createPublicClient,
  http,
  parseEventLogs,
  formatUnits,
  isAddress,
  isHash,
  getAddress,
  type Hex,
} from "viem";
import { base } from "viem/chains";
import { topup } from "@/lib/credit-ledger";
import { kvGet, kvSet, kvSetNX, kvDel } from "@/lib/kv";
import { USDC_BASE, TOPUP_TREASURY, creditsForUsdc } from "@/lib/payments";

export const runtime = "nodejs";
export const maxDuration = 20;

const RPC = process.env.BASE_RPC_URL || "https://mainnet.base.org";

// ERC-20 Transfer(address indexed from, address indexed to, uint256 value).
const TRANSFER_EVENT = [
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { indexed: true, name: "from", type: "address" },
      { indexed: true, name: "to", type: "address" },
      { indexed: false, name: "value", type: "uint256" },
    ],
  },
] as const;

// Permanent processed-marker; also read on a duplicate call to return the
// original credited amount idempotently. TTL long enough to be effectively
// permanent for reconciliation, short enough not to hoard KV forever.
const PROCESSED_TTL = 365 * 24 * 3600; // 1 year
const LOCK_TTL = 600; // 10 min — an in-flight verify that dies releases naturally

interface PurchaseRecord {
  status:  "verifying" | "credited";
  ts:      number;
  address?: string;
  credits?: number;
  usdc?:    number;
}

function coerceRecord(raw: PurchaseRecord | string | null): PurchaseRecord | null {
  if (!raw) return null;
  if (typeof raw === "string") {
    try { return JSON.parse(raw) as PurchaseRecord; } catch { return null; }
  }
  return raw;
}

export async function POST(req: NextRequest) {
  let body: { address?: string; txHash?: string };
  try {
    body = (await req.json()) as { address?: string; txHash?: string };
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const address = (body.address ?? "").trim();
  const txHash  = (body.txHash ?? "").trim();

  if (!isAddress(address)) {
    return NextResponse.json({ ok: false, error: "Invalid address" }, { status: 400 });
  }
  if (!isHash(txHash)) {
    return NextResponse.json({ ok: false, error: "Invalid transaction hash" }, { status: 400 });
  }

  const caller  = getAddress(address);
  const lockKey = `purchase:${txHash.toLowerCase()}`;

  // ── Idempotency: acquire the per-tx lock (atomic SET NX EX) ─────────────────
  const gotLock = await kvSetNX(
    lockKey,
    JSON.stringify({ status: "verifying", ts: Date.now(), address: caller } satisfies PurchaseRecord),
    LOCK_TTL,
  );

  if (!gotLock) {
    // Someone already holds this tx — either mid-verify or already credited.
    const existing = coerceRecord(await kvGet<PurchaseRecord | string>(lockKey));
    if (existing?.status === "credited") {
      return NextResponse.json({
        ok: true,
        alreadyCredited: true,
        credits: existing.credits ?? 0,
        usdc:    existing.usdc ?? 0,
      });
    }
    return NextResponse.json(
      { ok: false, error: "This transaction is already being verified — refresh in a moment." },
      { status: 409 },
    );
  }

  // From here on, ANY verify-failure MUST release the lock so a real retry works.
  try {
    const client = createPublicClient({ chain: base, transport: http(RPC) });

    let receipt;
    try {
      receipt = await client.getTransactionReceipt({ hash: txHash as Hex });
    } catch {
      await kvDel(lockKey);
      return NextResponse.json(
        { ok: false, pending: true, error: "Transaction not found or not yet mined — try again in a few seconds." },
        { status: 202 },
      );
    }

    if (receipt.status !== "success") {
      await kvDel(lockKey);
      return NextResponse.json({ ok: false, error: "Transaction reverted on-chain." }, { status: 400 });
    }

    // Decode Transfer logs; keep only USDC → treasury FROM this caller.
    let logs: Array<{ address: string; args: { from?: string; to?: string; value?: bigint } }> = [];
    try {
      logs = parseEventLogs({ abi: TRANSFER_EVENT, logs: receipt.logs }) as typeof logs;
    } catch {
      logs = [];
    }

    let totalUnits = 0n; // USDC base units (6 decimals)
    for (const log of logs) {
      const from = log.args.from;
      const to   = log.args.to;
      const val  = log.args.value;
      if (from == null || to == null || val == null) continue;
      try {
        if (
          getAddress(log.address) === USDC_BASE &&
          getAddress(to)          === TOPUP_TREASURY &&
          getAddress(from)        === caller
        ) {
          totalUnits += val;
        }
      } catch {
        // malformed address in a log — skip it
      }
    }

    if (totalUnits <= 0n) {
      await kvDel(lockKey);
      return NextResponse.json(
        { ok: false, error: "No USDC transfer from your wallet to the Blue treasury was found in this transaction." },
        { status: 400 },
      );
    }

    const usdc    = Number(formatUnits(totalUnits, 6));
    const credits = creditsForUsdc(usdc);

    if (credits <= 0) {
      await kvDel(lockKey);
      return NextResponse.json({ ok: false, error: "Amount too small to credit." }, { status: 400 });
    }

    // Credit the ledger. On failure, release the lock so the user can retry.
    let summary;
    try {
      summary = await topup(caller, credits, "purchase:usdc", txHash);
    } catch (e) {
      await kvDel(lockKey);
      return NextResponse.json(
        { ok: false, error: `Ledger credit failed: ${(e as Error).message}` },
        { status: 500 },
      );
    }

    // Promote the lock to a permanent processed-marker (idempotent on re-POST).
    await kvSet(
      lockKey,
      JSON.stringify({ status: "credited", ts: Date.now(), address: caller, credits, usdc } satisfies PurchaseRecord),
      PROCESSED_TTL,
    );

    return NextResponse.json({
      ok: true,
      credits,
      usdc,
      balance: summary.balance,
      pool:    summary.pool,
    });
  } catch (e) {
    // Unexpected failure — release the lock, surface a generic error.
    await kvDel(lockKey);
    return NextResponse.json(
      { ok: false, error: `Verification failed: ${(e as Error).message}` },
      { status: 500 },
    );
  }
}
