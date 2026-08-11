/**
 * Blue Hood — inbox unread count (T-D D1).
 *
 * Nav badge polls this at ~30s. Cheap: reads the top of the arrow feed
 * + the bookmark, counts arrows fired after it. No LLM, no upstream —
 * pure KV.
 */
import { NextRequest, NextResponse } from "next/server";
import { kvGet } from "@/lib/kv";
import { KV_ARROW_FEED, kvArrow, kvInboxLastRead } from "@/lib/blue-hood/kv-keys";
import type { Arrow } from "@/lib/blue-hood/types";

export const runtime = "nodejs";

function userId(req: NextRequest): string {
  const raw = req.headers.get("x-blue-user") ?? req.headers.get("X-Blue-User") ?? "";
  if (/^0x[a-fA-F0-9]{40}$/.test(raw)) return raw.toLowerCase();
  return "public";
}

export async function GET(req: NextRequest) {
  const uid = userId(req);
  const bookmark = await kvGet<string>(kvInboxLastRead(uid));
  const cutoff = bookmark ? new Date(bookmark).getTime() : 0;

  // Only look at the newest ~200 arrows — anything older can't beat the
  // bookmark by definition (the feed is newest-first). Then filter the
  // same way the public feed does (`origin === "engine"`, no `test`).
  const ids = ((await kvGet<string[]>(KV_ARROW_FEED)) ?? []).slice(0, 200);
  const arrows = (await Promise.all(ids.map((id) => kvGet<Arrow>(kvArrow(id))))).filter(
    (a): a is Arrow => a !== null && !a.test && (!a.origin || a.origin === "engine"),
  );
  const unread = arrows.filter((a) => new Date(a.fired_at).getTime() > cutoff).length;

  return NextResponse.json(
    { ok: true, user: uid, unread, last_read_at: bookmark ?? null },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}
