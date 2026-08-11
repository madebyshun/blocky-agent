/**
 * Blue Hood — web push subscribe / unsubscribe (T-D D3).
 *
 * Browser calls POST with a `PushSubscription.toJSON()` payload; we
 * persist to KV. DELETE with the same endpoint drops it. GET returns
 * the current public VAPID key so the client can build the
 * `applicationServerKey` for `pushManager.subscribe()`.
 */
import { NextRequest, NextResponse } from "next/server";
import { deleteSubscription, publicVapidKey, saveSubscription } from "@/lib/blue-hood/push";

export const runtime = "nodejs";

export async function GET() {
  const key = publicVapidKey();
  if (!key) {
    return NextResponse.json(
      { error: "push_disabled", hint: "VAPID keys not configured on the server." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  return NextResponse.json(
    { ok: true, vapid_public_key: key },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(req: NextRequest) {
  let body: {
    endpoint?: string;
    keys?: { p256dh?: string; auth?: string };
    ua?: string;
  } = {};
  try { body = (await req.json()) as typeof body; } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body.endpoint || !body.keys?.p256dh || !body.keys?.auth) {
    return NextResponse.json({ error: "missing_endpoint_or_keys" }, { status: 400 });
  }
  const result = await saveSubscription({
    endpoint: body.endpoint,
    keys: { p256dh: body.keys.p256dh, auth: body.keys.auth },
    ua: body.ua ?? req.headers.get("user-agent") ?? undefined,
    created_at: new Date().toISOString(),
  });
  return NextResponse.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(req: NextRequest) {
  let body: { endpoint?: string; hash?: string } = {};
  try { body = (await req.json()) as typeof body; } catch { /* fall through */ }
  const key = body.endpoint || body.hash;
  if (!key) return NextResponse.json({ error: "missing_endpoint_or_hash" }, { status: 400 });
  const removed = await deleteSubscription(key);
  return NextResponse.json({ ok: true, removed }, { headers: { "Cache-Control": "no-store" } });
}
