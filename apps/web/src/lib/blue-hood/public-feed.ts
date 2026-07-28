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
import { KV_ARROW_FEED, kvArrow } from "@/lib/blue-hood/kv-keys";
import type { Arrow } from "@/lib/blue-hood/types";

/**
 * Read the newest public arrows (engine origin, non-test), most-recent first.
 *
 * `limit` caps the returned list. We over-read the id list (×3) before
 * filtering so that culling test/seeded arrows can't starve the result below
 * `limit` when the tail of the feed happens to hold non-public arrows.
 */
export async function readPublicArrows(limit = 200): Promise<Arrow[]> {
  const ids = ((await kvGet<string[]>(KV_ARROW_FEED)) ?? []).slice(0, limit * 3);
  const all = (await Promise.all(ids.map((id) => kvGet<Arrow>(kvArrow(id))))).filter(
    (a): a is Arrow => a !== null,
  );

  // TRUST boundary — engine-origin, non-test only. Same predicate the drift
  // board and /api/acp/arrows use. `!a.origin` treated as engine for
  // backward-compat with arrows fired before `origin` was stamped.
  return all.filter((a) => !a.test && (!a.origin || a.origin === "engine")).slice(0, limit);
}

/** Count of public arrows fired in the last 24 wall-clock hours. */
export function arrowsFiredToday(arrows: Arrow[], now: number = Date.now()): number {
  return arrows.filter((a) => new Date(a.fired_at).getTime() >= now - 24 * 3_600 * 1000).length;
}
