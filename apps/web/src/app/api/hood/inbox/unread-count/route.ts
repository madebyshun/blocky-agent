/**
 * Blue Hood — inbox unread count (T-D D1).
 *
 * Nav badge polls this at ~30s: reads the top of the arrow feed + the
 * bookmark, counts arrows fired after it. No LLM, no upstream — pure KV.
 *
 * ⚠ NOT CHEAP, despite what this comment said until 2026-08-27. "Pure KV" is
 * true and was doing the work of implying "free". One GET is 1 (bookmark) +
 * 1 (feed index) + up to 200 (one read per arrow) = ~202 KV commands. At a 30s
 * poll that is ~582,000 commands/day PER OPEN TAB — and because the badge
 * lives in AppShell's nav, it runs on every /app page, not just Hood. That
 * single line item is the largest contributor to the two Upstash suspensions
 * (#123, #148), larger than the Hood board itself.
 *
 * It is NOT CDN-cacheable as written: the response is per-user (`uid` from
 * X-Blue-User), so it must stay `no-store` while the expensive part — reading
 * 200 arrows that are identical for everyone — is shared. The fix is to split
 * those: cache the public arrow timestamps and compare against the per-user
 * bookmark. That is task #148 ②, deliberately NOT done in the s-maxage pass
 * because it is a data-shape change, not a header change.
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
