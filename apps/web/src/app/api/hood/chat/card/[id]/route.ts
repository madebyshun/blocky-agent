/**
 * Blue Hood — Blue Chat card read endpoint (T-D D2).
 *
 * Public GET. Returns the pre-shaped `ChatCard` for one arrow so the
 * chat consumer never touches internal KV. Cache off — the chat renders
 * this at message time.
 *
 * 404 semantics: returns `{ ok: false, error: "not_found" }` with a 404
 * status. Never leaks the underlying arrow record; if the chat wants
 * more than the card carries, it should hit `/api/hood/arrows`.
 */
import { NextResponse } from "next/server";
import { readChatCard } from "@/lib/blue-hood/chat-card";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  if (!id || typeof id !== "string" || id.length > 128) {
    return NextResponse.json(
      { ok: false, error: "invalid_id" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  const card = await readChatCard(id);
  if (!card) {
    return NextResponse.json(
      { ok: false, error: "not_found" },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }
  return NextResponse.json(
    { ok: true, card },
    { headers: { "Cache-Control": "no-store" } },
  );
}
