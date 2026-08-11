/**
 * Blue Hood — Blue Chat card payload (T-D D2).
 *
 * When an arrow fires, `writeChatCard` shapes a chat-consumable card and
 * stashes it at `bh:chat:card:{arrow_id}`. A separate rolling list at
 * `bh:chat:feed` keeps the last N ids newest-first so the chat can
 * enumerate without walking the raw arrow feed.
 *
 * Kept intentionally lean:
 *   - Only fields Blue Chat wants to render (serial, ticker, signal,
 *     verdict_note, deep-links).
 *   - No `snapshot_refs`, no `outcome_detail` (chat is fire-time), no
 *     full brief (we take just the one-liner + optional context line).
 *   - Numeric fields are pre-formatted strings so the chat renderer
 *     never has to know Robinhood-Chain USDC decimals.
 *
 * The write is best-effort — a failure logs and returns null; the arrow
 * still fires. The chat consumer is expected to gracefully skip missing
 * cards.
 *
 * NOTE: this is the write-side only. A read helper lives at
 * `/api/hood/chat/card/[id]` (public GET) so the eventual chat consumer
 * or the LLM tool can fetch by id without importing internal libs.
 */
import { kvGet, kvSet } from "@/lib/kv";
import { absoluteUrl } from "@/lib/site-url";
import { kvChatCard, KV_CHAT_CARD_FEED, TTL_CHAT_CARD } from "./kv-keys";
import type { Arrow } from "./types";

export interface ChatCard {
  /** Payload version — bump only if the chat renderer needs to migrate. */
  v: 1;
  /** Stable UUID (same as the arrow's). */
  id: string;
  /** Cosmetic `#0001` serial for chat headers. */
  serial: string;
  ticker: string;
  /** Human-readable signal tag e.g. "DRIFT ↑", "ARB long dex". */
  signal: string;
  /** One-line brief verdict note — the chat's headline body. Empty if
   *  the brief chain was skipped or crashed at fire time. */
  headline: string;
  /** Optional one-line market context ("premarket · closed", etc.).
   *  Never mixed with `headline` server-side so the chat can style them
   *  differently (headline bold, context muted). */
  context: string;
  /** ISO timestamp — chat renders relative time from this. */
  fired_at: string;
  /** Deep-links so the card can offer "Open in inbox" / "Track record". */
  href: {
    inbox: string;
    board: string;
  };
}

function signalTag(a: Arrow): string {
  if (a.type === "drift") return `DRIFT ${a.expected_direction === "up" ? "↑" : "↓"}`;
  if (a.type === "arb") return `ARB ${a.expected_direction === "up" ? "long dex" : "short dex"}`;
  if (a.type === "flow") return `FLOW ${a.expected_direction === "up" ? "buy" : "sell"}`;
  return "WHALE Δ";
}

export function buildChatCard(a: Arrow): ChatCard {
  return {
    v: 1,
    id: a.id,
    serial: a.serial,
    ticker: a.ticker,
    signal: signalTag(a),
    headline: (a.brief?.verdict_note ?? "").trim(),
    context: (a.brief?.one_line_context ?? "").trim(),
    fired_at: a.fired_at,
    href: {
      // Absolute URLs — the card is persisted in KV and may be
      // rendered from any origin (chat is same-origin today, but the
      // reviewer is planning cross-context surfaces). `absoluteUrl`
      // pins to `NEXT_PUBLIC_SITE_URL` on prod; falls back to a
      // relative path on preview/localhost.
      inbox: absoluteUrl(`/hood/inbox#${a.id}`),
      board: absoluteUrl(`/hood`),
    },
  };
}

/**
 * Persist a chat card + push its id onto the feed list. Errors are
 * swallowed with a warn — arrow firing must never depend on chat write.
 */
export async function writeChatCard(a: Arrow): Promise<ChatCard | null> {
  try {
    const card = buildChatCard(a);
    await kvSet(kvChatCard(a.id), card, TTL_CHAT_CARD);
    const feed = (await kvGet<string[]>(KV_CHAT_CARD_FEED)) ?? [];
    // Guard against duplicate pushes (e.g. if fireArrow is retried while
    // the card write already succeeded).
    if (!feed.includes(a.id)) {
      feed.unshift(a.id);
      await kvSet(KV_CHAT_CARD_FEED, feed);
    }
    console.log(`[chat-card] written arrow=${a.serial} ticker=${a.ticker} headline_len=${card.headline.length}`);
    return card;
  } catch (e) {
    console.warn(`[chat-card] write failed for ${a.serial} ${a.ticker}: ${(e as Error).message}`);
    return null;
  }
}

/** Best-effort read for the API surface + eventual chat consumer. */
export async function readChatCard(arrowId: string): Promise<ChatCard | null> {
  return (await kvGet<ChatCard>(kvChatCard(arrowId))) ?? null;
}

/** Newest N card ids (default 20). Trimmed inline so the chat consumer
 *  doesn't have to know the KV shape. */
export async function listRecentChatCardIds(limit = 20): Promise<string[]> {
  const feed = (await kvGet<string[]>(KV_CHAT_CARD_FEED)) ?? [];
  return feed.slice(0, Math.max(1, Math.min(200, limit)));
}
