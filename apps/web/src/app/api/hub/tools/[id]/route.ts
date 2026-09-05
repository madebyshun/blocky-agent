/**
 * /api/hub/tools/[id]
 *   GET    — single registered (external) tool with live call/revenue stats.
 *   DELETE — remove the tool. Requires a SIWE signature over the canonical
 *            remove manifest AND a server-issued nonce, proving the requester
 *            owns tool.builderAddress and that this exact request is fresh.
 *            Non-custodial: no funds move, accrued earnings are preserved.
 *
 * ⚠ BREAKING, 2026-09-05 (#172). `nonce` must come from `GET /api/auth/nonce`.
 * It used to be client-invented, which mattered more here than on the submit
 * routes: a replayed submit is absorbed by the uniqueness check (409), but a
 * replayed DELETE succeeds and destroys the listing again. The remove manifest
 * is (registry, slug, owner, nonce) with no timestamp, so a captured body stayed
 * valid indefinitely — the moment a builder re-registered the same slug, an old
 * captured delete would take it down a second time.
 */
import { NextRequest, NextResponse } from "next/server";
import { verifyMessage } from "viem";
import { rateLimit, getIdentifier } from "@/lib/rate-limit";
import { spendNonce, NONCE_SOURCE_HINT } from "@/lib/session";
import { getRegisteredTool, removeTool, removeToolSiweMessage } from "@/lib/hub-registry";

export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const tool = await getRegisteredTool(id);
  if (!tool) return NextResponse.json({ error: "Tool not found" }, { status: 404 });
  return NextResponse.json(tool, {
    headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=120" },
  });
}

interface DeleteBody {
  owner:     `0x${string}`;
  signature: `0x${string}`;
  nonce:     string;
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { success } = await rateLimit(getIdentifier(req), "api");
  if (!success) return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });

  const { id } = await params;

  let body: DeleteBody;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const { owner, signature, nonce } = body;
  if (!owner || !signature || !nonce) {
    return NextResponse.json({ error: "owner, signature and nonce are required" }, { status: 400 });
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(owner)) {
    return NextResponse.json({ error: "Invalid owner address" }, { status: 400 });
  }

  // Freshness gate, before any side effect. A remove is destructive and there is
  // nothing to retry into — so unlike the submit routes there is no UX cost to
  // spending early.
  const spend = await spendNonce(nonce);
  if (!spend.ok) {
    return NextResponse.json({ error: `${spend.reason} ${NONCE_SOURCE_HINT}` }, { status: spend.status });
  }

  const tool = await getRegisteredTool(id);
  if (!tool) return NextResponse.json({ error: "Tool not found" }, { status: 404 });

  // Ownership: signer must BE the builder wallet on record.
  if (tool.builderAddress.toLowerCase() !== owner.toLowerCase()) {
    return NextResponse.json({ error: "Only the tool owner can remove it." }, { status: 403 });
  }

  const message = removeToolSiweMessage("external", id, owner, nonce);
  let valid = false;
  try {
    valid = await verifyMessage({ address: owner, message, signature });
  } catch (e) {
    return NextResponse.json({ error: `Signature verification failed: ${(e as Error).message}` }, { status: 400 });
  }
  if (!valid) {
    return NextResponse.json({ error: "Invalid signature — does not match owner." }, { status: 401 });
  }

  await removeTool(id);
  return NextResponse.json({ ok: true, removed: id }, {
    status: 200,
    headers: { "Cache-Control": "no-store" },
  });
}
