/**
 * Blue Hood — KV key conventions.
 *
 * Namespaced under `bh:` so this whole subsystem can be prefix-scanned or
 * flushed without touching other KV-backed features. Do NOT hardcode
 * these strings anywhere else — always import from here.
 */

/** Latest completed snapshot (written by the 60s poller). Readers of /hood + the alert engine hit this. */
export const KV_SNAPSHOT_LATEST = "bh:snapshot:latest";

/** Ring buffer entry for hour `H` (YYYYMMDDHH). Keep 24h for sparkline history. */
export const kvSnapshotHour = (yyyymmddhh: string) => `bh:snapshot:hour:${yyyymmddhh}`;

/** Monotonic counter for the aesthetic `#0001` serial. */
export const KV_ARROW_SERIAL_COUNTER = "bh:arrow:serial";

/** Individual arrow record. */
export const kvArrow = (id: string) => `bh:arrow:${id}`;

/** Index of currently-open (not yet graded) arrow ids per (ticker, type) — used for de-dup. */
export const kvArrowOpenIndex = (ticker: string, type: string) =>
  `bh:arrow:open:${ticker.toLowerCase()}:${type}`;

/**
 * P3.1 (v3 spec, 2026-07-24): index of currently-open arrows keyed by
 * TICKER (any type). A ticker can have at most ONE open arrow at a
 * time so we don't fire drift + arb + flow simultaneously on the same
 * ticker — the feed was doing exactly that (#0062-#0065 all one cycle,
 * COIN drift + COIN arb 42min apart) and it looked spammy.
 *
 * Same 30d TTL as the typed key so we're consistent.
 */
export const kvArrowOpenByTicker = (ticker: string) =>
  `bh:arrow:open_ticker:${ticker.toLowerCase()}`;

/**
 * P3.1: per-ticker cooldown key. Set when an arrow closes (graded),
 * TTL = 4h. `fireArrow` refuses if this key exists — no follow-up
 * arrow on the same ticker until the cooldown expires. Prevents the
 * "one ticker fires arb 15min after drift grade" pattern.
 */
export const kvArrowTickerCooldown = (ticker: string) =>
  `bh:arrow:cooldown:${ticker.toLowerCase()}`;

/** Rolling list of all arrow ids (newest first) — used by /hood feed + hit-rate math. */
export const KV_ARROW_FEED = "bh:arrow:feed";

/** T-B1 — hourly sparkline series per ticker. 24 close prices from M2.
 *  Refreshed by a separate cron (not the hot 72s poll cycle) so cycle
 *  time stays flat. See `sparkline-refresh` route + `getSparklineCached`. */
export const kvSparkline = (ticker: string) => `bh:spark:${ticker.toUpperCase()}`;

/** T-D D1 — per-address inbox "last-read" bookmark. Stores an ISO
 *  timestamp; UI treats any arrow with `fired_at > last_read` as unread.
 *  Anonymous callers share the "public" key so a fresh session at least
 *  sees the badge; connected wallets get their own scoped bookmark. */
export const kvInboxLastRead = (userId: string) =>
  `bh:inbox:last_read:${userId.toLowerCase()}`;

/** T-D D3 — a single web-push subscription. Serialized full
 *  `PushSubscription` JSON (endpoint + keys). Keyed by endpoint hash
 *  so re-subscribing from the same browser overwrites. */
export const kvPushSub = (endpointHash: string) => `bh:push:sub:${endpointHash}`;

/** T-D D3 — set of active push endpoint hashes (used by the fan-out
 *  when an engine arrow fires). Value = string[] of hashes. */
export const KV_PUSH_SUB_INDEX = "bh:push:index";

/** T-D D2 — Blue Chat card payload for one arrow. Written at fire time
 *  by the engine; Blue Chat pulls by arrow id when the LLM (or a chat
 *  hood tool) references it. Kept separate from the raw `bh:arrow:{id}`
 *  record so the chat consumer only touches a pre-shaped, chat-safe
 *  subset (never the raw brief chain of thought). */
export const kvChatCard = (arrowId: string) => `bh:chat:card:${arrowId}`;

/** T-D D2 — rolling list of chat-card ids (newest first) so the chat
 *  can page/enumerate without walking the whole arrow feed. Trim policy
 *  matches KV_ARROW_FEED (unbounded for now). */
export const KV_CHAT_CARD_FEED = "bh:chat:feed";

/** T-D async-brief queue (reviewer's "pre-prod TODO"). List of arrow
 *  ids whose brief has NOT been attached yet — `fireArrow` appends,
 *  `/api/cron/blue-hood/brief-worker` pops. Kept FIFO so the oldest
 *  pending brief attaches first. */
export const KV_BRIEF_QUEUE = "bh:brief:queue";

/** Pre-merge task #3 — cycle overlap guard. When a poll cycle starts
 *  it takes this lock (TTL 5 min via kvSetNX). Next-tick cron calls
 *  see the lock and no-op with a `[poller] skipped, previous cycle
 *  still running (Xs)` log. Prevents the 246s prod cycle overlapping
 *  the 5-minute schedule (see vercel.json crons; poll runs once every
 *  5 minutes) and bursting GT rate limits. */
export const KV_POLL_LOCK = "bh:poll:lock";
export const TTL_POLL_LOCK = 60 * 5; // 5 min — matches the cron cadence

/**
 * Poll ROUTE heartbeat — written at the TOP of the cron handler on every tick
 * (before the lock, even on the skipped path), proving the scheduler actually
 * fired. Distinct from `KV_SNAPSHOT_LATEST.started_at`, which only advances on
 * a cycle that SUCCEEDS end-to-end. Together they separate "cron dead" (this
 * key stale) from "cron alive but every cycle failing" (this fresh, snapshot
 * stale). Read via `kvGetProbe` in health.ts. Long TTL so a genuinely dead
 * cron leaves a readable last-seen timestamp instead of a null.
 */
export const KV_POLL_HEARTBEAT = "bh:poll:heartbeat";
export const TTL_POLL_HEARTBEAT = 60 * 60 * 24; // 24h — keep last-fired readable long after death

// ── 1.7 per-user alert watchlist ─────────────────────────────────────────────
//
// DISTINCT from `HOOD_WATCHLIST` (registry.ts), which is the ENGINE-wide polled
// set. This namespace is the PER-USER alert watchlist: "wallet X wants a DM when
// ticker Y drifts". Both the web UI and the Telegram bot (2.2) read these keys —
// KV is the shared substrate, not React state.
//
// Shape:
//   • bh:watch:{address}        → Watchlist (forward, source of truth; UI edits this)
//   • bh:watch:ticker:{TICKER}  → Redis SET of addresses (reverse index; the alert
//                                 engine reads ONE key when an arrow fires instead
//                                 of scanning every watcher). Kept in sync by a
//                                 SYMMETRIC dual-write — a remove SREMs the address,
//                                 so no orphaned subscriber ever keeps getting alerts.
//   • bh:watch:index            → Redis SET of addresses with a non-empty list
//                                 (enumeration / rebuild / a cheap watcher-count signal).

/** Forward key: one wallet's alert watchlist. No TTL — a list shouldn't evaporate; bloat is bounded by an entry cap, not by expiry. */
export const kvWatchlist = (address: string) => `bh:watch:${address.toLowerCase()}`;

/** Reverse index: SET of addresses watching a ticker. The alert engine's hot read. */
export const kvWatchTicker = (ticker: string) => `bh:watch:ticker:${ticker.toUpperCase()}`;

/** SET of every address that currently has a non-empty watchlist. */
export const KV_WATCH_INDEX = "bh:watch:index";

// ── 1.7 Telegram wallet-link ─────────────────────────────────────────────────
//
// Maps a Telegram user to a wallet so 2.2 can DM the right person when an arrow
// fires for a ticker they watch. Non-custodial: stores only { address, tgUserId },
// never a key — the tg id is a routing handle, not an authz token for funds.
//
// Handshake (web issues, bot consumes):
//   1. web (wallet already connected) POSTs → we mint bh:tglink:code:{code} (TTL 10m)
//   2. user sends `/link {code}` to the bot → bot consumes the code, writes both
//      link directions, deletes the code. Both sides proven; no signature needed.

/** Forward: tg user id → { address }. */
export const kvTgLink = (tgUserId: string | number) => `bh:tglink:${tgUserId}`;

/** Reverse: address → { tgUserId } (one wallet ↔ one tg for v1). The alert DM path reads this. */
export const kvTgLinkByAddr = (address: string) => `bh:tglink:addr:${address.toLowerCase()}`;

/** Short-lived link code minted by web, consumed by the bot. TTL below. */
export const kvTgLinkCode = (code: string) => `bh:tglink:code:${code.toUpperCase()}`;

/** Link-code lifetime — long enough to switch to Telegram and paste, short enough to not linger. */
export const TTL_TGLINK_CODE = 60 * 10; // 10 min

/** TTL constants (seconds). */
export const TTL_SNAPSHOT_HOUR = 60 * 60 * 25; // 25h so we always have a full 24h window
export const TTL_ARROW_INDEX = 60 * 60 * 24 * 30; // 30d — grading windows are at most 24h
/** P3.1 — 4h ticker cooldown after grading. Reasonable balance between
 *  "one open arrow at a time" and "let the next real setup fire soon". */
export const TTL_TICKER_COOLDOWN = 60 * 60 * 4; // 4h
export const TTL_SPARKLINE = 60 * 20; // 20 min — hourly candles don't need to be fresher than that
export const TTL_PUSH_SUB = 60 * 60 * 24 * 90; // 90d — browser subs expire on their own well before this
export const TTL_CHAT_CARD = 60 * 60 * 24 * 30; // 30d — matches TTL_ARROW_INDEX so cards don't outlive arrows

/** Utility: format a Date into `YYYYMMDDHH` for the ring-buffer bucket. */
export function yyyymmddhh(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const h = String(d.getUTCHours()).padStart(2, "0");
  return `${y}${m}${day}${h}`;
}
