/**
 * Blue Hood watchlist — the subset of `RWA_TOKENS` the poller cycles through.
 *
 * Only stocks + ETFs are candidates for Blue Hood. Of those, some lack a
 * Chainlink oracle feed and can't produce an M5 verdict — those are
 * enumerated explicitly under `HOOD_EXCLUSIONS` so the metric strip can
 * be honest about the denominator instead of silently drop-and-round.
 *
 * ── Why the watchlist is an allowlist, not a filter ────────────────────────
 * It used to be "every stock/ETF row that has a Chainlink feed", which quietly
 * coupled two unrelated things: the size of the address book and the size of
 * the poll loop. `rwa-registry.ts` is the address book for ~30 rh-* tools that
 * only need to resolve a ticker to a contract; the poller is a cron with a
 * hard operating budget. Under the old filter, adding a row so `rh-stock-quote`
 * could answer a question also enlisted that ticker into a 5-minute cron
 * forever — and this engine has already been killed once by exceeding the
 * Upstash request cap (each polled ticker costs a sparkline read per cycle,
 * ~8.6K reads/month each). Growing the address book must therefore be free.
 *
 * So enrolment is explicit. `HOOD_ENABLED` is the poll loop; registry rows that
 * are eligible but not enrolled show up as `not_enabled`, visible rather than
 * silently dropped. Adding a ticker here is a deliberate capacity decision.
 */
import { RWA_TOKENS, type RwaToken } from "@/lib/robinhood/rwa-registry";

export type HoodWatchlistEntry = RwaToken & { chainlinkFeed: `0x${string}` };

export type HoodExclusionReason =
  | "utility"            // wrapped / stable — routing plumbing, not an RWA position
  | "no_chainlink_feed"  // stock/ETF row without a live Chainlink oracle yet
  | "not_enabled";       // has a feed, deliberately outside the poll budget

export interface HoodExclusion {
  ticker: string;
  reason: HoodExclusionReason;
}

/**
 * Tickers the poller actually cycles. This is a capacity budget, not a
 * statement about which tokens matter — see the note above before adding.
 * Every entry must have a `chainlinkFeed` in `RWA_TOKENS` or it is ignored.
 */
export const HOOD_ENABLED: ReadonlySet<string> = new Set([
  // Stocks
  "AAPL", "AMD", "AMZN", "BABA", "COIN", "CRCL", "CRWV", "GOOGL", "INTC",
  "META", "MSFT", "MSTR", "MU", "NVDA", "ORCL", "PLTR", "SNDK", "SPCX",
  "TSLA", "USAR",
  // ETFs
  "QQQ", "SGOV", "SLV", "SPY",
]);

/** Full RWA candidate set — everything the copilot could theoretically watch. */
const RWA_CANDIDATES = RWA_TOKENS.filter((t) => t.kind === "stock" || t.kind === "etf");

/** Rows that *could* be polled — a Chainlink feed is what M5 needs. */
const FEED_ELIGIBLE = RWA_CANDIDATES.filter(
  (t): t is HoodWatchlistEntry => Boolean(t.chainlinkFeed),
);

/** Actually-watched subset — feed-eligible AND enrolled in the poll budget. */
export const HOOD_WATCHLIST: HoodWatchlistEntry[] = FEED_ELIGIBLE.filter((t) =>
  HOOD_ENABLED.has(t.ticker),
);

/** Rows we consciously drop, with a machine-readable reason. */
export const HOOD_EXCLUSIONS: HoodExclusion[] = [
  ...RWA_CANDIDATES.filter((t) => !t.chainlinkFeed).map((t) => ({
    ticker: t.ticker,
    reason: "no_chainlink_feed" as const,
  })),
  ...FEED_ELIGIBLE.filter((t) => !HOOD_ENABLED.has(t.ticker)).map((t) => ({
    ticker: t.ticker,
    reason: "not_enabled" as const,
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
  /** Rows with a Chainlink feed — the set the poller could draw from. */
  feed_eligible: FEED_ELIGIBLE.length,
  /** Rows the poller cycles through. */
  watched: HOOD_WATCHLIST.length,
  /** Excluded rows, grouped by reason (utility drops are counted separately
   *  because they're not part of the RWA equity set — they're plumbing). */
  no_chainlink_feed: HOOD_EXCLUSIONS.filter((e) => e.reason === "no_chainlink_feed").length,
  not_enabled: HOOD_EXCLUSIONS.filter((e) => e.reason === "not_enabled").length,
  utility: HOOD_EXCLUSIONS.filter((e) => e.reason === "utility").length,
};
