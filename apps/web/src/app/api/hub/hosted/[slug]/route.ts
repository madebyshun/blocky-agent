/**
 * /api/hub/hosted/[slug]
 *   GET    — single hosted tool, PUBLIC projection (secrets stripped).
 *   DELETE — remove the hosted tool. Requires a SIWE signature over the canonical
 *            remove manifest AND a server-issued nonce, proving the requester
 *            owns tool.builderAddress and that this exact request is fresh.
 *            Non-custodial: no funds move; the pooled builder:earned:<wallet>
 *            counter is preserved so a batched payout still settles it.
 *
 * SECURITY: the DELETE path reads the tool only to check its builderAddress and
 * never echoes the secret config. The GET path uses getPublicHostedTool(), which
 * runs toPublicHostedTool() — systemPrompt / authValue never reach the client.
 *
 * ⚠ BREAKING, 2026-09-05 (#172). `nonce` must come from `GET /api/auth/nonce`;
 * a client-invented one is refused. See the sibling route
 * api/hub/tools/[id] for why a replayable DELETE is worse than a replayable POST.
 */
import { NextRequest, NextResponse } from "next/server";
import { verifyMessage } from "viem";
import { rateLimit, getIdentifier } from "@/lib/rate-limit";
import { spendNonce, NONCE_SOURCE_HINT } from "@/lib/session";
import { getPublicHostedTool, removeHostedTool } from "@/lib/hub-hosted";
import { removeToolSiweMessage } from "@/lib/hub-registry";

export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const tool = await getPublicHostedTool(slug);
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
  { params }: { params: Promise<{ slug: string }> },
) {
  const { success } = await rateLimit(getIdentifier(req), "api");
  if (!success) return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });

  const { slug } = await params;

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

  // Freshness gate, before any side effect — same ordering as the external
  // remove route.
  const spend = await spendNonce(nonce);
  if (!spend.ok) {
    return NextResponse.json({ error: `${spend.reason} ${NONCE_SOURCE_HINT}` }, { status: spend.status });
  }

  const tool = await getPublicHostedTool(slug);
  if (!tool) return NextResponse.json({ error: "Tool not found" }, { status: 404 });

  if (tool.builderAddress.toLowerCase() !== owner.toLowerCase()) {
    return NextResponse.json({ error: "Only the tool owner can remove it." }, { status: 403 });
  }

  const message = removeToolSiweMessage("hosted", slug, owner, nonce);
  let valid = false;
  try {
    valid = await verifyMessage({ address: owner, message, signature });
  } catch (e) {
    return NextResponse.json({ error: `Signature verification failed: ${(e as Error).message}` }, { status: 400 });
  }
  if (!valid) {
    return NextResponse.json({ error: "Invalid signature — does not match owner." }, { status: 401 });
  }

  await removeHostedTool(slug);
  return NextResponse.json({ ok: true, removed: slug }, {
    status: 200,
    headers: { "Cache-Control": "no-store" },
  });
}
