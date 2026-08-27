/**
 * Blue Agent — Memory API
 * KV-backed persistent memory (fallback to in-memory when KV not configured).
 */
import { NextRequest, NextResponse } from "next/server";
import { kvGet, kvDel, kvMutate, isKVEnabled } from "@/lib/kv";
import { rateLimit, getIdentifier } from "@/lib/rate-limit";

export const runtime = "nodejs";
// Vercel kills serverless functions at 60s by default — explicit budget so
// it fails loudly instead of silently 504-ing.
export const maxDuration = 15;

const KEY = (wallet: string) => `memory:${wallet}`;
const TTL = 60 * 60 * 24 * 30; // 30 days

export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("wallet") ?? "anon";

  const data = await kvGet<Record<string, unknown>>(KEY(wallet)) ?? {};
  return NextResponse.json({
    wallet,
    memory: data,
    persistent: isKVEnabled(),
  });
}

export async function POST(req: NextRequest) {
  // Rate limit
  const id = getIdentifier(req);
  const { success } = await rateLimit(id, "api");
  if (!success) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: { wallet?: string; key: string; value: unknown } = { key: "", value: null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const wallet = body.wallet ?? "anon";

  // `kvMutate` (task #150): this is a read-modify-write against the wallet's
  // ENTIRE memory blob. The old `?? {}` meant a throttled read spread an empty
  // object, so saving one key silently deleted every other memory that wallet
  // had — and the response still said `ok: true`. Refusing the write loses the
  // one new key instead, which the caller can retry.
  let updated: Record<string, unknown> = {};
  const res = await kvMutate<Record<string, unknown>>(
    KEY(wallet),
    {},
    (existing) => (updated = { ...existing, [body.key]: body.value, updatedAt: Date.now() }),
    TTL,
  );
  if (res === "skipped" || res === "failed") {
    return NextResponse.json(
      { error: "Memory store temporarily unavailable — nothing was saved or changed" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.json({
    ok: true,
    wallet,
    memory: updated,
    persistent: isKVEnabled(),
  });
}

export async function DELETE(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("wallet") ?? "anon";
  await kvDel(KEY(wallet));
  return NextResponse.json({ ok: true, wallet });
}
