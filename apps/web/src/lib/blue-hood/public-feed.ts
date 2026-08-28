/**
 * Blue Hood — the canonical "what's public" arrow read.
 *
 * WHY THIS FILE: three surfaces now read the arrow feed — /api/hood/arrows,
 * /api/acp/arrows, and the new /api/acp/track-record. Each was about to grow
 * its own copy of the KV read + the origin/test filter. That filter is a
 * TRUST boundary (seeded/test arrows must never inflate a public number), so
 * it gets exactly one definition here. Callers windows/aggregate on top of the
 * list this returns; they never re-derive the filter.
 */
import { kvGet } from "@/lib/kv";
import { KV_ARROW_FEED, kvArrow, ARROW_HYDRATED_MAX } from "@/lib/blue-hood/kv-keys";
import { readArrowFeed } from "@/lib/blue-hood/arrow-cache";
import type { Arrow } from "@/lib/blue-hood/types";

/**
 * Read the newest public arrows (engine origin, non-test), most-recent first.
 *
 * `limit` caps the returned list. We over-read the id list (×3) before
 * filtering so that culling test/seeded arrows can't starve the result below
 * `limit` when the tail of the feed happens to hold non-public arrows.
 */
/**
 * The TRUST boundary — engine-origin, non-test only. ONE definition: the drift
 * board, /api/acp/arrows, the public track record AND the /share/arrow permalink
 * all gate on exactly this predicate, so a seeded/QA arrow can never inflate a
 * public number or become publicly linkable. `!a.origin` is treated as engine
 * for backward-compat with arrows fired before `origin` was stamped.
 */
export function isPublicArrow(a: Arrow): boolean {
  return !a.test && (!a.origin || a.origin === "engine");
}

/**
 * Probe-shaped public read — the one callers should prefer.
 *
 * Distinguishes "the feed is empty" from "we could not read the feed", which
 * `readPublicArrows` below structurally cannot. Backed by the hydrated blob
 * (#148 ②), so this costs ONE KV command instead of the ~401-command fan-out
 * it replaced.
 */
export async function readPublicArrowsProbe(
  limit = 200,
): Promise<
  | { status: "ok"; arrows: Arrow[]; built_at: string; source: "cache" | "rebuild"; kv_commands: number }
  | { status: "unavailable"; reason: string }
> {
  const read = await readArrowFeed();
  if (read.status !== "ok") return read;
  return { ...read, arrows: read.arrows.filter(isPublicArrow).slice(0, limit) };
}

/**
 * Read the newest public arrows, most-recent first.
 *
 * ⚠ GROUP-B GAP, KNOWN AND DELIBERATE (#150): this returns `[]` when KV is
 * unreachable, so its callers cannot tell an empty feed from a dead database.
 * That is unchanged from before the cache — converting the six call sites is a
 * separate pass. New code should call `readPublicArrowsProbe` instead; this
 * wrapper stays so the existing importers keep compiling and still get ②'s
 * cost fix for free.
 */
export async function readPublicArrows(limit = 200): Promise<Arrow[]> {
  const read = await readPublicArrowsProbe(limit);
  return read.status === "ok" ? read.arrows : [];
}

/** Count of public arrows fired in the last 24 wall-clock hours. */
export function arrowsFiredToday(arrows: Arrow[], now: number = Date.now()): number {
  return arrows.filter((a) => new Date(a.fired_at).getTime() >= now - 24 * 3_600 * 1000).length;
}

/**
 * Canonicalize a serial to its numeric key: `#0042` | `0042` | `42` → 42.
 * Null when there's no positive integer to key on. Lets `/share/arrow/42`,
 * `/0042`, and `/%230042` all resolve the same arrow.
 */
export function serialKey(serial: string): number | null {
  const digits = String(serial).replace(/\D/g, "");
  if (!digits) return null;
  const n = parseInt(digits, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Resolve ONE public arrow by its serial — backs the /share/arrow/[serial]
 * permalink. There is NO serial→id index (arrows are keyed by id, serial is a
 * field), so we read the same feed `readPublicArrows` does and scan for the
 * serial. The trust boundary (`isPublicArrow`) is applied identically — a
 * seeded/test arrow is never resolvable through a public permalink.
 *
 * TWO TIERS since #148 ②. The hydrated blob covers the newest
 * `ARROW_HYDRATED_MAX` arrows and answers almost every real share link in ONE
 * KV command. Only a serial older than that window falls through to the
 * original 600-id scan — correctness is preserved for deep permalinks without
 * paying ~601 commands for the recent ones people actually open. The share
 * page layers ISR on top, so even the fallback isn't paid per request.
 */
export async function getPublicArrowBySerial(serial: string): Promise<Arrow | null> {
  const wanted = serialKey(serial);
  if (wanted === null) return null;

  const cached = await readArrowFeed();
  if (cached.status === "ok") {
    const hit = cached.arrows.find((a) => isPublicArrow(a) && serialKey(a.serial) === wanted);
    if (hit) return hit;
    // Genuinely not in the recent window — fall through to the deep scan below.
  } else {
    // KV just failed. Do NOT answer a failed read with 600 more reads; that is
    // how a throttle becomes a suspension. Report "not found" — same as today.
    console.error(`[public-feed] serial ${serial}: ${cached.reason}`);
    return null;
  }

  const ids = ((await kvGet<string[]>(KV_ARROW_FEED)) ?? []).slice(0, 600).slice(ARROW_HYDRATED_MAX);
  const all = (await Promise.all(ids.map((id) => kvGet<Arrow>(kvArrow(id))))).filter(
    (a): a is Arrow => a !== null,
  );
  return all.find((a) => isPublicArrow(a) && serialKey(a.serial) === wanted) ?? null;
}
