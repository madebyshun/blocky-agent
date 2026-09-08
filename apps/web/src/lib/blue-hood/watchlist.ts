/**
 * Blue Hood — per-user alert watchlist + Telegram wallet-link (task 1.7).
 *
 * THE ONE server-side source of truth for "which wallet wants a DM when which
 * ticker moves". Every caller — the web CRUD routes, the Telegram bot (2.2),
 * and the alert cron (2.1) — imports from HERE. KV is the shared substrate;
 * the React `WatchlistProvider` is just a client-side cache over these same
 * routes, never a second copy of the rules.
 *
 * WHY NOT ONE GLOBAL ARRAY: the shape this deliberately rejects keeps ALL
 * watches in a single key, read+written whole on every edit — two concurrent
 * edits lose one, and the blob grows without bound. Per-user alerting cannot
 * scale on that. Here each wallet owns its own key, and the alert engine's hot
 * lookup ("who watches COIN?") is a single Redis SET read, not a scan of every
 * watcher. (The concrete example was Sentinel's `sentinel:watches`; Sentinel
 * was retired 2026-08-31 — the reasoning is what matters, not the corpse.)
 *
 * TWO KEYS, KEPT SYMMETRIC:
 *   • bh:watch:{address}       — forward, the user's list (UI edits this)
 *   • bh:watch:ticker:{TICKER} — reverse SET of addresses (alert engine reads this)
 * Every add SADDs the reverse set; every remove SREMs it. A removed ticker can
 * NEVER leave an orphaned subscriber that keeps getting alerts — that silent
 * "fail open" is the exact class of bug this codebase has been bitten by twice.
 *
 * ── A WATCH IS (TICKER, CHAIN), NEVER A TICKER ────────────────────────────────
 * This module had ZERO mentions of `chain` until the Base desk had been live 16
 * days. That was not an omission — it was correct while Robinhood was the only
 * desk. It stopped being correct the moment NVDA / META / GOOGL / AAPL existed
 * on BOTH Robinhood Chain (4663) and Base (8453) as different contracts: ★ on
 * the Base NVDA row and ★ on the Robinhood NVDA row wrote the same forward
 * entry and the same reverse set, so watching a Base row subscribed the user to
 * ROBINHOOD arrows for a token they had not looked at. Nothing errored; they
 * simply got the wrong desk's alerts.
 *
 * So the identity of an entry is `rowKey` (`NVDA` on RH, `base:NVDA` on Base) —
 * the same function the board keys its rows by, so the UI and the subscription
 * agree by construction rather than by convention. `chain` is OPTIONAL on the
 * stored record and absent ⟹ "robinhood" via `chainOf`, which makes every list
 * already in KV correct as written: they were all Robinhood. Reads go through
 * `entryKey`, writes stamp `chain` explicitly, and `chainSeg("robinhood")` is
 * the empty string, so no live key or subscription changes name.
 *
 * Validity is per chain (`isChainTicker`): the RH desk admits the 205-token RWA
 * registry, the Base desk admits ONLY the hand-verified B20 allow-list. A Base
 * ticker outside that list is refused rather than silently accepted against
 * Robinhood's list — cross-chain fallback is the bug, not the remedy.
 */

import {
  kvGet,
  kvGetProbe,
  kvSet,
  kvDel,
  kvSAdd,
  kvSRem,
  kvSMembers,
} from "@/lib/kv";
import {
  kvWatchlist,
  kvWatchTicker,
  KV_WATCH_INDEX,
  kvTgLink,
  kvTgLinkByAddr,
  kvTgLinkCode,
  TTL_TGLINK_CODE,
  KV_TG_BROADCAST,
} from "@/lib/blue-hood/kv-keys";
import {
  WATCHLIST_LIMITS,
  HARD_MAX_ENTRIES,
  WATCHLIST_ENFORCE,
  watchlistTier,
  type WatchlistTierName,
} from "@/lib/blue-hood/watchlist-config";
import { isChainTicker, CHAIN_LABEL } from "@/lib/blue-hood/chain-token";
import { chainOf, rowKey, type HoodChain } from "@/lib/blue-hood/types";

// ── Types ────────────────────────────────────────────────────────────────────

/** Which arrow kinds a watch fires on. Empty/absent ⇒ all (see normalizeKinds). */
export type AlertKind = "drift" | "arb" | "flow";
export const ALL_KINDS: readonly AlertKind[] = ["drift", "arb", "flow"] as const;

export interface WatchEntry {
  ticker: string;        // UPPERCASE, valid on `chain` (see isChainTicker)
  /** Which desk this watch is for. ABSENT ⟹ "robinhood" (`chainOf`) — every
   *  entry written before the Base desk existed really was Robinhood, so the
   *  default makes stored lists correct as written rather than needing a
   *  migration. New writes always stamp it explicitly. */
  chain?: HoodChain;
  kinds: AlertKind[];    // non-empty; defaults to ALL_KINDS
  addedAt: string;       // ISO
}

/**
 * The identity of a watch: `NVDA` on Robinhood, `base:NVDA` on Base. Same
 * function the /hood board keys its rows by, so a ★ on a row and the entry it
 * creates cannot disagree. Comparing `e.ticker` alone is the bug this replaces.
 */
function entryKey(e: { ticker: string; chain?: HoodChain }): string {
  return rowKey({ ticker: e.ticker.trim().toUpperCase(), chain: chainOf(e) });
}

export interface Watchlist {
  address: string;                 // lowercased; echoes the key for integrity
  entries: WatchEntry[];
  source: "default" | "custom";    // v1 is always "default"; "custom" reserved for premium multi-list
  updatedAt: string;               // ISO
}

/** The Telegram ↔ wallet link. Non-custodial: address + tg id only, never a key. */
export interface TgLink {
  address: string;
  tgUserId: string;
  tgUsername?: string;
  linkedAt: string;
}

interface TgLinkCode {
  address: string;
  expiresAt: string;   // ISO
}

export type WatchlistErrorCode = "bad_address" | "bad_ticker" | "at_cap" | "kv_unavailable";
export interface WatchlistError {
  code: WatchlistErrorCode;
  message: string;
}

/** Outcome of the cap check — surfaced so callers can log a would-block. */
export interface AddDecision {
  /** Whether the add is allowed to proceed. */
  ok: boolean;
  /** Whether the TIER gate would have blocked (distinct from the always-on hard cap). */
  wouldBlock: boolean;
  tier: WatchlistTierName;
  tierLimit: number;
  hardCap: number;
  reason?: string;
}

export type AddResult =
  | { ok: true; watchlist: Watchlist; decision: AddDecision; added: boolean }
  | { ok: false; error: WatchlistError };

export type RemoveResult =
  | { ok: true; watchlist: Watchlist; removed: boolean }
  | { ok: false; error: WatchlistError };

// ── Validation / normalization ───────────────────────────────────────────────

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

/**
 * Is this a watchable ticker ON `chain`?
 *
 * The chain is REQUIRED and has no default. It used to be a bare-ticker check
 * against the Robinhood registry alone, which answered `true` for a Base ticker
 * that happens to share a name with an RH one and `false` for a Base-only
 * ticker — both wrong, and neither visible. The per-chain allow-lists live in
 * `chain-token.ts` so this module never touches a single-chain registry.
 */
export function isValidTicker(ticker: string, chain: HoodChain): boolean {
  return isChainTicker(ticker, chain);
}

function normAddress(address: string): string | null {
  const a = address.trim().toLowerCase();
  return ADDRESS_RE.test(a) ? a : null;
}

function normalizeKinds(kinds: AlertKind[] | undefined): AlertKind[] {
  if (!kinds || kinds.length === 0) return [...ALL_KINDS];
  const seen = new Set<AlertKind>();
  for (const k of kinds) if (ALL_KINDS.includes(k)) seen.add(k);
  return seen.size ? [...seen] : [...ALL_KINDS];
}

function emptyWatchlist(address: string): Watchlist {
  return { address, entries: [], source: "default", updatedAt: new Date().toISOString() };
}

// ── Cap logic ────────────────────────────────────────────────────────────────

/**
 * Decide whether one more entry may be added. The HARD cap always blocks (it's
 * the anti-bloat guarantee). The TIER cap blocks only when WATCHLIST_ENFORCE is
 * on — while it's off we let the add through and merely record `wouldBlock` so
 * a caller can log it, honoring "free feature works for everyone, log the
 * would-block but don't block yet".
 */
export function evaluateAdd(currentCount: number, tier: WatchlistTierName): AddDecision {
  const tierLimit = WATCHLIST_LIMITS[tier].maxEntries;
  const overTier = currentCount >= tierLimit;
  const overHard = currentCount >= HARD_MAX_ENTRIES;
  const ok = !overHard && (WATCHLIST_ENFORCE ? !overTier : true);
  const reason = overHard
    ? `hard cap ${HARD_MAX_ENTRIES} reached`
    : overTier
      ? `${tier} cap ${tierLimit} reached`
      : undefined;
  return { ok, wouldBlock: overTier, tier, tierLimit, hardCap: HARD_MAX_ENTRIES, reason };
}

// ── Read ─────────────────────────────────────────────────────────────────────

/**
 * Read a wallet's watchlist, distinguishing "empty" from "we could not read it".
 *
 * ⚠ MUTATORS MUST USE THIS, not `getWatchlist`. `getWatchlist` returns an empty
 * default on a KV read error, and every mutation here is a read-modify-write
 * against the same key — so under the old code a throttled read made
 * `addTicker` persist a one-entry list over the user's real one, and made
 * `removeTicker` see `entries.length === 0` and `kvDel` the watchlist outright
 * plus deregister the wallet from the global index. Silent, total, and only
 * noticed the next time that user opened /hood. See task #150.
 */
async function readWatchlistForWrite(a: string): Promise<Watchlist | "unavailable"> {
  const probe = await kvGetProbe<Watchlist>(kvWatchlist(a));
  if (probe.status === "error") {
    console.error(`[watchlist] refusing to mutate ${a} — KV read failed: ${probe.message}`);
    return "unavailable";
  }
  if (probe.status === "miss") return emptyWatchlist(a);
  return normalizeStored(a, probe.value);
}

const KV_UNAVAILABLE_ERR = {
  code: "kv_unavailable" as const,
  message: "watchlist store is temporarily unreachable — nothing was changed",
};

/** Guarantee the shape even if an older/partial record was stored. */
function normalizeStored(a: string, stored: Watchlist): Watchlist {
  return {
    address: a,
    entries: Array.isArray(stored.entries) ? stored.entries : [],
    source: stored.source === "custom" ? "custom" : "default",
    updatedAt: stored.updatedAt ?? new Date().toISOString(),
  };
}

/** A wallet's watchlist. Returns an empty default (never null) so callers don't branch on absence. */
export async function getWatchlist(address: string): Promise<Watchlist> {
  const a = normAddress(address);
  if (!a) return emptyWatchlist(address.toLowerCase());
  const stored = await kvGet<Watchlist>(kvWatchlist(a));
  if (!stored) return emptyWatchlist(a);
  // Defensive: guarantee the shape even if an older/partial record was stored.
  return {
    address: a,
    entries: Array.isArray(stored.entries) ? stored.entries : [],
    source: stored.source === "custom" ? "custom" : "default",
    updatedAt: stored.updatedAt ?? new Date().toISOString(),
  };
}

/** The alert engine's hot read: every address subscribed to a ticker ON ONE
 *  CHAIN. One SET read. Base NVDA and Robinhood NVDA are different subscriptions
 *  because they are different tokens. */
export async function watchersForTicker(ticker: string, chain: HoodChain): Promise<string[]> {
  if (!isValidTicker(ticker, chain)) return [];
  return kvSMembers(kvWatchTicker(ticker, chain));
}

/**
 * 2.1 alert engine — resolve the recipients of an arrow, KIND-FILTERED.
 *
 * The reverse index (`bh:watch:ticker:{T}`) is a SET of addresses only — it
 * carries no per-watcher kind preference, on purpose (that would complicate
 * 1.7's symmetric dual-write). So kind filtering happens HERE: read the reverse
 * set (1 SET read), then load each watcher's forward list and keep only those
 * whose WatchEntry for this ticker opted into `kind`. A watcher on "drift" alone
 * gets NO alert for an "arb" arrow.
 *
 * Cost is 1 + N reads (N = watchers on the ticker), incurred ONLY when a real
 * arrow fires — there is no poll loop and arrows are dedup+cooldown-capped to a
 * handful/day, so this is bounded, not a hot read (Req 4). Never throws: every
 * KV helper it calls swallows and returns a safe empty on failure.
 *
 * ⚠️ Takes the ARROW, not its ticker. Passing `arrow.ticker` is exactly how a
 * Base arrow used to fan out to Robinhood watchers: the chain was available at
 * every call site and dropped on the way in. `chainOf` applies the documented
 * absent ⟹ robinhood default, so the pre-migration arrows resolve unchanged.
 */
export async function recipientsForArrow(
  arrow: { ticker: string; chain?: HoodChain },
  kind: AlertKind,
): Promise<string[]> {
  const chain = chainOf(arrow);
  const T = arrow.ticker.trim().toUpperCase();
  if (!isValidTicker(T, chain)) return [];
  const addrs = await watchersForTicker(T, chain);
  if (addrs.length === 0) return [];
  const key = rowKey({ ticker: T, chain });
  const out: string[] = [];
  for (const a of addrs) {
    const wl = await getWatchlist(a);
    const entry = wl.entries.find((e) => entryKey(e) === key);
    if (entry && entry.kinds.includes(kind)) out.push(a);
  }
  return out;
}

// ── Write (symmetric dual-write) ─────────────────────────────────────────────

/**
 * Add a (ticker, chain) watch to a wallet's list. Validates the ticker against
 * THAT CHAIN's registry, dedupes on `rowKey`, applies the cap policy, then
 * writes the forward record AND the reverse index + global index in lockstep.
 *
 * @param opts.chain — which desk. Absent ⟹ "robinhood" through `chainOf`, the
 *   one place that default lives, so an older caller that predates the Base desk
 *   keeps its exact meaning instead of silently landing on the wrong chain.
 * @param opts.blueBalance — the wallet's $BLUE balance for tier resolution. Omit
 *   (or pass undefined) until 1.1 WalletProvider can supply it; the gate then
 *   resolves everyone to "free" and, with enforcement off, never blocks.
 */
export async function addTicker(
  address: string,
  ticker: string,
  opts?: { chain?: HoodChain; kinds?: AlertKind[]; blueBalance?: number },
): Promise<AddResult> {
  const a = normAddress(address);
  if (!a) return { ok: false, error: { code: "bad_address", message: "not a 0x… address" } };

  const chain = chainOf(opts);
  const T = ticker.trim().toUpperCase();
  if (!isValidTicker(T, chain)) {
    // Name the CHAIN in the rejection. "NVDA is not a ticker" would be a lie on
    // a desk where it is one; the honest message is which desk we checked.
    return {
      ok: false,
      error: { code: "bad_ticker", message: `${T} is not a ${CHAIN_LABEL[chain]} ticker Blue Hood tracks` },
    };
  }
  const key = rowKey({ ticker: T, chain });

  const wlRead = await readWatchlistForWrite(a);
  if (wlRead === "unavailable") return { ok: false, error: KV_UNAVAILABLE_ERR };
  const wl = wlRead;
  const kinds = normalizeKinds(opts?.kinds);

  // Already watching → idempotent: refresh kinds, no double-count, no cap hit.
  const existing = wl.entries.find((e) => entryKey(e) === key);
  if (existing) {
    existing.kinds = kinds;
    // Stamp the chain on an entry stored before this field existed. It resolves
    // to the same value via `chainOf`, so this is a no-op in meaning — it just
    // stops the record depending on a default.
    existing.chain = chain;
    wl.updatedAt = new Date().toISOString();
    await kvSet(kvWatchlist(a), wl);
    // Reverse index is a set — re-adding is a harmless no-op, but do it so a
    // repaired list heals a previously-missing reverse entry.
    await kvSAdd(kvWatchTicker(T, chain), a);
    await kvSAdd(KV_WATCH_INDEX, a);
    return { ok: true, watchlist: wl, decision: evaluateAdd(wl.entries.length - 1, watchlistTier(opts?.blueBalance)), added: false };
  }

  const tier = watchlistTier(opts?.blueBalance);
  const decision = evaluateAdd(wl.entries.length, tier);
  if (!decision.ok) {
    return { ok: false, error: { code: "at_cap", message: decision.reason ?? "watchlist is full" } };
  }
  if (decision.wouldBlock) {
    // Enforcement is off, so we let it through but leave a breadcrumb — this is
    // the signal that flips to a hard block once the gate goes live.
    console.warn(`[watchlist] would-block ${a} +${key}: ${decision.reason} (enforce off)`);
  }

  wl.entries.push({ ticker: T, chain, kinds, addedAt: new Date().toISOString() });
  wl.updatedAt = new Date().toISOString();

  await kvSet(kvWatchlist(a), wl);
  await kvSAdd(kvWatchTicker(T, chain), a);   // reverse index (per chain)
  await kvSAdd(KV_WATCH_INDEX, a);            // global index (first non-empty write registers the wallet)

  return { ok: true, watchlist: wl, decision, added: true };
}

/**
 * Remove a (ticker, chain) watch from a wallet's list. SYMMETRIC to addTicker:
 * it SREMs the address from THAT CHAIN's reverse set so no orphaned subscriber
 * survives. When the wallet's last watch is removed, its forward key is deleted
 * and the wallet drops out of the global index too — it disappears from every
 * reverse set it was ever in (each removal already pruned its own set).
 *
 * `chain` is absent ⟹ "robinhood" for the same reason as `addTicker`: symmetry.
 * If the two disagreed on the default, un-starring would leave the reverse set
 * populated and the user would keep getting DMs they had cancelled.
 */
export async function removeTicker(
  address: string,
  ticker: string,
  opts?: { chain?: HoodChain },
): Promise<RemoveResult> {
  const a = normAddress(address);
  if (!a) return { ok: false, error: { code: "bad_address", message: "not a 0x… address" } };

  const chain = chainOf(opts);
  const T = ticker.trim().toUpperCase();
  const key = rowKey({ ticker: T, chain });
  // ⚠ Must be the strict read: the `entries.length === 0` branch below DELETES
  // the watchlist key and deregisters the wallet globally. An unreadable list
  // reaching that branch as "empty" wipes a real one. See #150.
  const wlRead = await readWatchlistForWrite(a);
  if (wlRead === "unavailable") return { ok: false, error: KV_UNAVAILABLE_ERR };
  const wl = wlRead;
  const before = wl.entries.length;
  wl.entries = wl.entries.filter((e) => entryKey(e) !== key);
  const removed = wl.entries.length < before;

  // Always SREM the reverse set — even if the forward record didn't list it,
  // this heals a stale reverse entry. SREM is idempotent, so it's safe.
  await kvSRem(kvWatchTicker(T, chain), a);

  if (wl.entries.length === 0) {
    // Empty list: delete the forward key and deregister from the global index.
    await kvDel(kvWatchlist(a));
    await kvSRem(KV_WATCH_INDEX, a);
  } else {
    wl.updatedAt = new Date().toISOString();
    await kvSet(kvWatchlist(a), wl);
  }

  return { ok: true, watchlist: wl, removed };
}

// ── Telegram wallet-link ─────────────────────────────────────────────────────

// Unambiguous alphabet (no I/L/O/0/1) so a pasted code is unmistakable.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function genCode(len = 6): string {
  let s = "";
  for (let i = 0; i < len; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return s;
}

/**
 * Web side: the connected wallet requests a short-lived link code. The wallet is
 * already proven (wagmi connection), so the code only needs to prove the OTHER
 * side (Telegram) when the bot consumes it. TTL is short — see TTL_TGLINK_CODE.
 */
export async function issueTgLinkCode(address: string): Promise<{ code: string; expiresAt: string } | { error: WatchlistError }> {
  const a = normAddress(address);
  if (!a) return { error: { code: "bad_address", message: "not a 0x… address" } };
  const code = genCode();
  const expiresAt = new Date(Date.now() + TTL_TGLINK_CODE * 1000).toISOString();
  await kvSet(kvTgLinkCode(code), { address: a, expiresAt } satisfies TgLinkCode, TTL_TGLINK_CODE);
  return { code, expiresAt };
}

/**
 * Bot side (owned by 2.2, contract defined here): consume a `/link {code}`. On a
 * valid, unexpired code we write BOTH link directions and delete the code so it
 * can't be replayed. Returns the linked address on success.
 */
export async function consumeTgLinkCode(
  code: string,
  tgUserId: string | number,
  tgUsername?: string,
): Promise<{ ok: true; address: string } | { ok: false; reason: string }> {
  const key = kvTgLinkCode(code.trim());
  const rec = await kvGet<TgLinkCode>(key);
  if (!rec) return { ok: false, reason: "code not found or expired" };
  if (Date.parse(rec.expiresAt) < Date.now()) {
    await kvDel(key);
    return { ok: false, reason: "code expired" };
  }
  const tg = String(tgUserId);
  const link: TgLink = { address: rec.address, tgUserId: tg, tgUsername, linkedAt: new Date().toISOString() };
  await kvSet(kvTgLink(tg), link);              // forward: tg → wallet
  await kvSet(kvTgLinkByAddr(rec.address), link); // reverse: wallet → tg (alert DM path)
  await kvDel(key);                              // one-time use
  return { ok: true, address: rec.address };
}

/** Alert DM path: which Telegram user (if any) should be DM'd for this wallet. */
export async function tgUserForAddress(address: string): Promise<string | null> {
  const a = normAddress(address);
  if (!a) return null;
  const link = await kvGet<TgLink>(kvTgLinkByAddr(a));
  return link?.tgUserId ?? null;
}

/** Reverse of the above: which wallet a Telegram user linked (for bot `/watch` etc.). */
export async function addressForTgUser(tgUserId: string | number): Promise<string | null> {
  const link = await kvGet<TgLink>(kvTgLink(String(tgUserId)));
  return link?.address ?? null;
}

// ── 2.2b Telegram broadcast tier ─────────────────────────────────────────────
//
// The tier-1 firehose (KV_TG_BROADCAST): a plain `/start` (no deep-link payload)
// opts a tg user into EVERY tradable arrow, no wallet required. Distinct from the
// wallet-scoped, kind-filtered watchlist above. The alert fan-out (2.1) unions
// both sets and dedups by tg id. Non-custodial: a tg user id is a routing handle,
// never an authz token. Each helper is idempotent and never throws (the KV layer
// swallows and returns a safe empty on failure).

/** Opt a Telegram user INTO the broadcast firehose (plain `/start`). Idempotent. */
export async function addToBroadcast(tgUserId: string | number): Promise<void> {
  await kvSAdd(KV_TG_BROADCAST, String(tgUserId));
}

/** Opt a Telegram user OUT of the broadcast firehose (`/mute`). Idempotent. */
export async function removeFromBroadcast(tgUserId: string | number): Promise<void> {
  await kvSRem(KV_TG_BROADCAST, String(tgUserId));
}

/** Every tg user id currently opted into the broadcast firehose. One SET read. */
export async function broadcastMembers(): Promise<string[]> {
  return kvSMembers(KV_TG_BROADCAST);
}
