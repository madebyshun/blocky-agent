/**
 * Blue Hood — inbox unread count (T-D D1).
 *
 * Nav badge polls this at ~30s: reads the top of the arrow feed + the
 * bookmark, counts arrows fired after it. No LLM, no upstream — pure KV.
 *
 * ⚠ WAS NOT CHEAP, despite what this comment said until 2026-08-27. "Pure KV"
 * is true and was doing the work of implying "free". One GET was 1 (bookmark) +
 * 1 (feed index) + up to 200 (one read per arrow) = ~202 KV commands. At a 30s
 * poll that is ~582,000 commands/day PER OPEN TAB — and because the badge
 * lives in AppShell's nav, it runs on every /app page, not just Hood. That
 * single line item was the largest contributor to the Upstash suspensions
 * (#123, #148), larger than the Hood board itself.
 *
 * FIXED IN #148 ② exactly as this comment predicted. The response is per-user
 * (`uid` from X-Blue-User) so it can never be CDN-cached — it stays `no-store`.
 * But the EXPENSIVE half, reading 200 arrows that are byte-identical for every
 * user, is now shared through the hydrated blob (`lib/blue-hood/arrow-cache.ts`).
 * Per-user stays private and uncached; public stays shared and cached. Cost per
 * GET: ~202 commands → 2 (bookmark + blob).
 */
import { NextRequest, NextResponse } from "next/server";
import { kvGet } from "@/lib/kv";
import { kvInboxLastRead } from "@/lib/blue-hood/kv-keys";
import { readPublicArrowsProbe } from "@/lib/blue-hood/public-feed";

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
  // bookmark by definition (the feed is newest-first). The origin/test filter
  // is `isPublicArrow` inside `readPublicArrowsProbe`, NOT re-implemented here:
  // this route used to carry its own inline copy of that trust predicate, which
  // is how a public surface silently drifts from the other three.
  const feed = await readPublicArrowsProbe(200);

  // A dead database must not render as "0 unread". The badge hides at 0, so
  // collapsing an outage into a zero would quietly remove a signal the user is
  // waiting on and look identical to "all caught up". 503 → the client's
  // `if (!r.ok) return` keeps the last known count instead.
  if (feed.status === "unavailable") {
    return NextResponse.json(
      { ok: false, reason: "kv_error", error: `Unread count unknown — ${feed.reason}` },
      { status: 503, headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  }

  const unread = feed.arrows.filter((a) => new Date(a.fired_at).getTime() > cutoff).length;

  return NextResponse.json(
    { ok: true, user: uid, unread, last_read_at: bookmark ?? null },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}
