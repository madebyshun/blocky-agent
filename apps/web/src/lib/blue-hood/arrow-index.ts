/**
 * Blue Hood — size assertion for the authoritative arrow index (task #154).
 *
 * The index is `bh:arrow:feed` (`KV_ARROW_FEED`): one KV value holding every
 * arrow id ever fired, newest-first. It is the ONLY thing that points at the
 * arrow records, so it is also the only thing that makes the public track
 * record enumerable.
 *
 * ═══ THE ONE RULE: WARN, NEVER TRIM ═══
 *
 * This module logs. It does not, and must not, shorten anything.
 *
 * The track record IS the product's moat, and it is forward-only. Every id in
 * here is a published claim that was later graded in public; dropping the tail
 * to save bytes destroys exactly the evidence that makes the record worth
 * anything, and — unlike a cache — it cannot be rebuilt afterwards, because the
 * thing that would tell you what was dropped is the thing you dropped. A trim
 * is therefore not a smaller version of this warning. It is the failure this
 * warning exists to get a human in front of.
 *
 * So the code's job stops at "say the number out loud". Sharding the key,
 * archiving cold ids to a second key, or accepting the size are all decisions
 * with different trade-offs and different blast radii, and each one is a
 * person's call. A threshold is not a licence to pick one automatically.
 *
 * (Note for anyone reading `rule-engine.ts` history: the append site used to
 * carry a comment promising exactly the forbidden thing — "when it grows past
 * ~500 we can trim in a follow-up". That comment predates the track record
 * being the product. It is gone; this is what replaced it.)
 *
 * ═══ WHY WARN AT ALL ═══
 *
 * Unbounded growth eventually collides with the Upstash request/size budget
 * that has already suspended this engine three times (#148, #123). Two costs
 * scale with the length, not just one:
 *   • storage — the value has a hard ~1 MB ceiling, past which the write starts
 *     failing SILENTLY (the same trap already documented on `ARROW_HYDRATED_MAX`);
 *   • bandwidth — several callers read the WHOLE array (`grader`, `purge`, the
 *     chat serial lookup, every cache rebuild), so each id is re-transferred on
 *     every one of those reads, forever.
 *
 * Knowing early is cheap. Discovering it via a suspension — which is how the
 * last three went — costs the engine's uptime and the record's credibility at
 * the same moment.
 */

/**
 * Warn above this many ids. Derived, not taste, and deliberately far from the
 * wall so the warning arrives while there is still time to think:
 *
 *   • An id is `crypto.randomUUID()` — 36 chars, serialized in the array as
 *     `"…",` ≈ 39 bytes.
 *   • The ~1 MB value ceiling is therefore ≈ 26,800 ids. That is the point of
 *     silent write failure.
 *   • 5,000 ids ≈ 195 KB ≈ 19% of that ceiling.
 *
 * For scale: the feed measured n≈200 on 2026-08-27 (see `ARROW_HYDRATED_MAX`),
 * so this fires roughly an order of magnitude before the number stops being
 * routine, and roughly five times before it becomes dangerous.
 *
 * Raising this is a legitimate human decision once someone has looked. Turning
 * it into a cap is not — see the module header.
 */
export const ARROW_INDEX_WARN_AT = 5000;

/**
 * Pure half: the message a given index length deserves, or `null` for "nothing
 * to say". Split out from the logging so the threshold can be asserted directly
 * by a test instead of by scraping console output.
 *
 * Strictly greater-than: exactly `ARROW_INDEX_WARN_AT` is not yet "past" it.
 */
export function arrowIndexWarning(count: number, where: string): string | null {
  if (!Number.isFinite(count) || count <= ARROW_INDEX_WARN_AT) return null;
  return (
    `[arrow-index] bh:arrow:feed holds ${count} ids (> ${ARROW_INDEX_WARN_AT}) at ${where} — ` +
    `this index is unbounded BY DESIGN and must NOT be trimmed: it is the public ` +
    `track record and it cannot be rebuilt. Human decision needed (shard the key, ` +
    `archive cold ids elsewhere, or accept the size). See task #154.`
  );
}

/**
 * Effectful half. Call from a LOW-FREQUENCY site that already knows the full
 * length — appends and cache rebuilds — never from a hot read path. The hot
 * readers (`grader`, the 15s pollers) see the same array many times a minute,
 * and a line repeated that often is how a real warning gets scrolled past. That
 * is the same reasoning that keeps leading/trailing misses out of the archive
 * gap report: an alarm on the expected trains people to ignore the alarm.
 */
export function warnIfArrowIndexLarge(count: number, where: string): void {
  const msg = arrowIndexWarning(count, where);
  if (msg) console.warn(msg);
}
