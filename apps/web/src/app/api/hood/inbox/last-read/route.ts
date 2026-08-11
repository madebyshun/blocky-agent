/**
 * Blue Hood — inbox last-read bookmark (T-D D1).
 *
 * The nav-item unread badge is: `arrows.filter(a => a.fired_at > last_read).length`.
 * This endpoint owns the write side of that bookmark.
 *
 * Auth model (v1): trust the caller-supplied `X-Blue-User` address
 * (checksum or lowercase 0x). No signature check — the ledger/wallet
 * plumbing this hooks into elsewhere in the app can add SIWE later.
 * Anonymous callers (no header) share the "public" bookmark so the badge
 * still works before wallet connect; every browser-session shares that
 * one, which is fine — the trade-off is "sometimes you re-see arrows
 * across devices" vs "have to sign to get an inbox".
 */
import { NextRequest, NextResponse } from "next/server";
import { kvGet, kvSet } from "@/lib/kv";
import { kvInboxLastRead } from "@/lib/blue-hood/kv-keys";

export const runtime = "nodejs";

function userId(req: NextRequest): string {
  const raw = req.headers.get("x-blue-user") ?? req.headers.get("X-Blue-User") ?? "";
  if (/^0x[a-fA-F0-9]{40}$/.test(raw)) return raw.toLowerCase();
  return "public";
}

export async function GET(req: NextRequest) {
  const uid = userId(req);
  const iso = await kvGet<string>(kvInboxLastRead(uid));
  return NextResponse.json(
    { ok: true, user: uid, last_read_at: iso ?? null },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}

export async function POST(req: NextRequest) {
  const uid = userId(req);
  // Body optionally specifies an explicit ISO; otherwise "now" (marking
  // every arrow so far as read).
  let iso: string | null = null;
  try {
    const body = (await req.json().catch(() => ({}))) as { at?: string };
    if (typeof body.at === "string" && !Number.isNaN(Date.parse(body.at))) iso = body.at;
  } catch { /* body optional */ }
  const stamp = iso ?? new Date().toISOString();
  await kvSet(kvInboxLastRead(uid), stamp);
  return NextResponse.json(
    { ok: true, user: uid, last_read_at: stamp },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}
