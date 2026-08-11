/**
 * Blue Hood — recent Blue Chat cards list (T-D D2).
 *
 * Public GET. Returns the newest N chat-card ids (default 20, cap 100)
 * plus the hydrated card payloads. Chat consumers use this to render a
 * "recent Blue Hood arrows" strip without paging through the full
 * `/api/hood/arrows` list.
 *
 * The endpoint is deliberately lean: no filtering (chat can filter
 * client-side), no cursor (only 20-100 items ever returned), no cache
 * (cards go stale the moment a new arrow fires and the chat wants that
 * instantly).
 */
import { NextRequest, NextResponse } from "next/server";
import { listRecentChatCardIds, readChatCard } from "@/lib/blue-hood/chat-card";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const limitRaw = Number(req.nextUrl.searchParams.get("limit") ?? "20");
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(100, Math.trunc(limitRaw))) : 20;

  const ids = await listRecentChatCardIds(limit);
  // Hydrate in parallel; drop misses so the chat sees only live cards.
  const cards = (await Promise.all(ids.map((id) => readChatCard(id)))).filter(
    (c): c is NonNullable<typeof c> => c != null,
  );

  return NextResponse.json(
    { ok: true, cards, count: cards.length },
    { headers: { "Cache-Control": "no-store" } },
  );
}
