/**
 * Blue Hood — record a user's trade action against an arrow (T-E).
 *
 * POST body:
 *   {
 *     wallet: 0x… (required),
 *     tx_hash: 0x… (required, the SWAP tx — not the approve),
 *     side: "buy" | "sell",
 *     amount: number,
 *     denom: "USDG" | "WETH",
 *     min_out: number | null,
 *     status?: "broadcast" | "success" | "reverted" | "unknown" | "pending"  (default "broadcast")
 *     revert_reason?: string | null,
 *     block_number?: number | null,
 *   }
 *
 * The panel calls this at least TWICE per swap (v3, 2026-07-24):
 *   1. Right after the swap tx submits (status: "broadcast") — so the
 *      receipt shows up immediately, even if the tab closes. Prior code
 *      used "pending" here and let it decay into "success" by omission,
 *      making revert-rate structurally always 0.
 *   2. After `waitForTransactionReceipt` returns (status: "success" if
 *      receipt.status === "success", else "reverted") — upgrades the
 *      same entry (keyed on tx_hash). Optionally includes `revert_reason`
 *      when we could decode one (Uniswap "STF", "TOO_LITTLE_RECEIVED", etc.)
 *      and `block_number` from the receipt.
 *   3. Timeout / receipt fetch crash → status stays "broadcast" or gets
 *      posted as "unknown" — never silently upgraded.
 *
 * NO ownership verification: the wallet is a self-report. This is a
 * DISPLAY receipt, not an audit. A bad actor could spam other users'
 * addresses onto arrows, but:
 *   - they still can't hijack anyone else's UI (each user renders
 *     their OWN wallet's actions via a client-side filter),
 *   - they can't taint hit-rate (user_actions is NOT in hit-rate math).
 *
 * Rate-limited. Cap 20 actions per arrow so a malicious loop can't
 * explode the record.
 */
import { NextRequest, NextResponse } from "next/server";
import { kvGet, kvSet } from "@/lib/kv";
import { kvArrow } from "@/lib/blue-hood/kv-keys";
import { rateLimit, getIdentifier } from "@/lib/rate-limit";
import type { Arrow, UserAction } from "@/lib/blue-hood/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;
const TX_HASH_RE = /^0x[a-fA-F0-9]{64}$/;
const MAX_ACTIONS_PER_ARROW = 20;

type Body = {
  wallet?: string;
  tx_hash?: string;
  side?: "buy" | "sell";
  amount?: number;
  denom?: "USDG" | "WETH";
  min_out?: number | null;
  status?: "broadcast" | "success" | "reverted" | "unknown" | "pending";
  revert_reason?: string | null;
  block_number?: number | null;
};

const VALID_STATUSES = new Set(["broadcast", "success", "reverted", "unknown", "pending"]);

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { success } = await rateLimit(getIdentifier(req), "chat");
  if (!success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  const { id } = await ctx.params;
  if (!id || id.length > 128) return NextResponse.json({ error: "bad_id" }, { status: 400 });

  let body: Body = {};
  try { body = (await req.json()) as Body; } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const wallet = (body.wallet ?? "").trim().toLowerCase();
  const tx_hash = (body.tx_hash ?? "").trim().toLowerCase();
  const side: "buy" | "sell" = body.side === "sell" ? "sell" : "buy";
  const amount = Number(body.amount);
  const denom: "USDG" | "WETH" = body.denom === "WETH" ? "WETH" : "USDG";
  const min_out = body.min_out !== undefined && body.min_out !== null ? Number(body.min_out) : null;
  const status: UserAction["status"] = body.status && VALID_STATUSES.has(body.status)
    ? body.status
    // Default flipped from "pending" → "broadcast" (v3). Old clients still
    // sending "pending" are accepted verbatim above.
    : "broadcast";
  const revert_reason = typeof body.revert_reason === "string" ? body.revert_reason.slice(0, 200) : null;
  const block_number = typeof body.block_number === "number" && Number.isFinite(body.block_number) ? Math.floor(body.block_number) : null;

  if (!ADDR_RE.test(wallet)) return NextResponse.json({ error: "bad_wallet" }, { status: 400 });
  if (!TX_HASH_RE.test(tx_hash)) return NextResponse.json({ error: "bad_tx_hash" }, { status: 400 });
  if (!Number.isFinite(amount) || amount <= 0) return NextResponse.json({ error: "bad_amount" }, { status: 400 });

  const arrow = await kvGet<Arrow>(kvArrow(id));
  if (!arrow) return NextResponse.json({ error: "arrow_not_found" }, { status: 404 });

  const existing = arrow.user_actions ?? [];
  // Upsert on tx_hash — the "pending → success" upgrade path.
  const match = existing.findIndex((a) => a.tx_hash === tx_hash);
  const next: UserAction = {
    ts: new Date().toISOString(),
    wallet, tx_hash, side, amount, denom, min_out, status,
    revert_reason, block_number,
  };
  let updated: UserAction[];
  if (match >= 0) {
    // Upgrading an existing entry — preserve the ORIGINAL broadcast ts
    // so the "signed at" timestamp remains truthful; only the status /
    // revert_reason / block_number roll forward.
    updated = existing.map((a, i) => i === match ? {
      ...a,
      status: next.status,
      revert_reason: next.revert_reason ?? a.revert_reason ?? null,
      block_number: next.block_number ?? a.block_number ?? null,
    } : a);
  } else {
    if (existing.length >= MAX_ACTIONS_PER_ARROW) {
      return NextResponse.json({ error: "arrow_at_action_cap", cap: MAX_ACTIONS_PER_ARROW }, { status: 429 });
    }
    updated = [...existing, next];
  }

  await kvSet(kvArrow(id), { ...arrow, user_actions: updated });
  console.log(`[user-action] arrow=${arrow.serial} ticker=${arrow.ticker} wallet=${wallet.slice(0, 6)}… tx=${tx_hash.slice(0, 10)}… status=${status} count=${updated.length}`);
  return NextResponse.json({ ok: true, action: next, action_count: updated.length }, { headers: { "Cache-Control": "no-store" } });
}
