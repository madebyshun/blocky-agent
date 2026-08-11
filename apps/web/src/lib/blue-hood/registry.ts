/**
 * Blue Hood watchlist — the subset of `RWA_TOKENS` the poller cycles through.
 *
 * The RWA registry (`lib/robinhood/rwa-registry.ts`) is 28 rows total; only
 * stocks + ETFs (26) are candidates for Blue Hood. Of those, some lack a
 * Chainlink oracle feed and can't produce an M5 verdict — those are
 * enumerated explicitly under `HOOD_EXCLUSIONS` so the metric strip can
 * be honest about the denominator ("24/26 watched · 2 no feed") instead of
 * silently drop-and-round.
 */
import { RWA_TOKENS, type RwaToken } from "@/lib/robinhood/rwa-registry";

export type HoodWatchlistEntry = RwaToken & { chainlinkFeed: `0x${string}` };

export type HoodExclusionReason =
  | "utility"       // wrapped / stable — routing plumbing, not an RWA position
  | "no_chainlink_feed"; // stock/ETF row without a live Chainlink oracle yet

export interface HoodExclusion {
  ticker: string;
  reason: HoodExclusionReason;
}

/** Full RWA candidate set — everything the copilot could theoretically watch. */
const RWA_CANDIDATES = RWA_TOKENS.filter((t) => t.kind === "stock" || t.kind === "etf");

/** Actually-watched subset — must have a Chainlink feed to feed M5. */
export const HOOD_WATCHLIST: HoodWatchlistEntry[] = RWA_CANDIDATES.filter(
  (t): t is HoodWatchlistEntry => Boolean(t.chainlinkFeed),
);

/** Rows we consciously drop, with a machine-readable reason. */
export const HOOD_EXCLUSIONS: HoodExclusion[] = [
  ...RWA_CANDIDATES.filter((t) => !t.chainlinkFeed).map((t) => ({
    ticker: t.ticker,
    reason: "no_chainlink_feed" as const,
  })),
  ...RWA_TOKENS.filter((t) => t.kind === "stable" || t.kind === "wrapped").map((t) => ({
    ticker: t.ticker,
    reason: "utility" as const,
  })),
];

/**
 * Denominators surfaced in the metric strip. The UI is honest: "N watched /
 * M in the RWA registry, K excluded" — never self-referential.
 */
export const HOOD_REGISTRY_STATS = {
  /** Every stock + ETF in the RWA registry — the honest denominator. */
  rwa_candidates: RWA_CANDIDATES.length,
  /** Rows the poller cycles through — must have a Chainlink feed. */
  watched: HOOD_WATCHLIST.length,
  /** Excluded rows, grouped by reason (utility drops are counted separately
   *  because they're not part of the RWA equity set — they're plumbing). */
  no_chainlink_feed: HOOD_EXCLUSIONS.filter((e) => e.reason === "no_chainlink_feed").length,
  utility: HOOD_EXCLUSIONS.filter((e) => e.reason === "utility").length,
};
