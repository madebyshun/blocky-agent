/**
 * Blue Hood — how the board is allowed to talk about a closed session.
 *
 * WHY THIS IS ITS OWN MODULE
 * --------------------------
 * Both functions here used to be inline in `HoodClient.tsx`, which is a
 * `"use client"` React tree (wagmi, Privy, the whole board). Nothing could
 * import it to check the one property that matters, so the rule "the badge
 * never claims a frozen feed" was only ever enforced by reading the diff.
 * Split out, it is dependency-free and `scripts/hood-badge-honesty-check.ts`
 * exercises it directly — see that file for the mutations it catches.
 *
 * THE RULE
 * --------
 * `FROZEN_ALIGNED` is a MARKET-CLOCK verdict: market closed, |drift| inside the
 * closed-session aligned band. It says nothing about whether the Chainlink feed
 * is actually static. The board previously rendered it as the literal word
 * "FROZEN" on any non-weekend closed session, which turns a clock reading into
 * an assertion about the oracle. On a weekday off-hours the feed may well have
 * printed since the close.
 *
 * The staleness flag does not rescue it: `feed_is_stale` fires at 2× the 86400s
 * heartbeat (>48h) and forces `can_fire=false` → INSUFFICIENT_DATA in
 * `base-poller.ts`. Any row that still carries FROZEN_ALIGNED therefore has a
 * round younger than 48h by construction. That gate detects an OUTAGE; it
 * cannot separate "frozen since the 16:00 close" from "printing normally".
 *
 * So the label states only what the row proves, and the oracle's age is
 * reported as a measured number instead of being compressed into a word.
 */
import type { MarketSession } from "./types";

/**
 * Age of the Chainlink round a row priced against, as display text.
 *
 * The three inputs are three DIFFERENT facts — see the doc on
 * `TickerSnapshot.oracle_updated_at`, which this function exists to respect:
 *   • number    — a real round timestamp (unix SECONDS). Measurable.
 *   • null      — the Base desk read the feed and could not date the round.
 *   • undefined — the RH desk never records it. That is "no reading", not
 *                 "no round", and collapsing it into `null` would assert a
 *                 failed read that never happened.
 *
 * Only the first case licenses any claim about what the oracle is doing, and
 * even then the claim made is the age itself — never the word "frozen".
 *
 * `now` is injectable so the age branches are testable without freezing wall
 * time; production callers omit it.
 */
export function oracleRoundAgeText(
  oracleUpdatedAt: number | null | undefined,
  now: number = Date.now(),
): string {
  if (oracleUpdatedAt === undefined) return "oracle round age is not recorded on this desk";
  if (oracleUpdatedAt === null || !Number.isFinite(oracleUpdatedAt)) {
    return "oracle round could not be dated (feed unreadable)";
  }
  const sec = Math.max(0, Math.round(now / 1000 - oracleUpdatedAt));
  if (sec < 60) return `Chainlink round ${sec}s old`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `Chainlink round ${min}m old`;
  const h = Math.floor(min / 60);
  if (h < 24) return `Chainlink round ${h}h ${min % 60}m old`;
  return `Chainlink round ${Math.floor(h / 24)}d ${h % 24}h old`;
}

/**
 * Badge label for a `FROZEN_ALIGNED` row.
 *
 * Names the closed session — which is exactly what `session` is for — and says
 * the drift is aligned. Both halves are read off the row. It must never emit
 * the word "FROZEN": that is a claim about the oracle, and this function has no
 * oracle reading in scope by construction (it takes only the session, so the
 * mistake cannot be made here even by accident).
 *
 * `"holiday"` is handled explicitly. It used to fall through the old
 * `isWeekend === false` test and get labelled "FROZEN" by accident — right for
 * the wrong reason, since B20 is 24/5 and does hold last close on holidays.
 *
 * NOTE for whoever wants the word back: it is earnable, but only by comparing
 * `oracle_updated_at` against the session's own close instant — not by an age
 * threshold. A 0.5% deviation deadband means a live-but-quiet feed looks
 * arbitrarily old, so any "older than N ⟹ frozen" rule re-creates the original
 * bug with extra steps. The close comparison needs a trading calendar
 * (premarket and post-midnight both point at a PREVIOUS session's close).
 */
export function closedAlignedLabel(session?: MarketSession | string): string {
  switch (session) {
    case "weekend":    return "WKND ALIGN";
    case "holiday":    return "HOL ALIGN";
    case "premarket":  return "PRE ALIGN";
    case "afterhours": return "AH ALIGN";
    // Includes "regular" — a FROZEN_ALIGNED row during the regular session
    // would be a contradiction upstream, so name it neutrally rather than
    // inventing a session word the row does not support.
    default:           return "CLOSED ALIGN";
  }
}
