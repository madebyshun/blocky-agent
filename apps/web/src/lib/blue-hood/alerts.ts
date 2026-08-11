/**
 * Blue Hood — alert engine (task 2.1).
 *
 * When an arrow fires for ticker T, this module resolves the WATCHERS of T
 * (kind-filtered, via 1.7's reverse index) and writes one CHANNEL-AGNOSTIC
 * alert record per recipient. It does NOT send anything itself — 2.2 (Telegram)
 * and, later, web-push read these records and deliver. "Blue Hood is the proof":
 * the arrow already fired + graded; 2.1 is only the fan-out substrate.
 *
 * WHERE IT RUNS: hooked into the async `brief-worker` cron, right after the
 * existing Web Push fan-out — NOT inside `fireArrow`/the poll cycle. The
 * async-brief refactor deliberately moved all fan-out off the hot poll path to
 * keep cycle wall-time flat; 2.1 rides the same rails so the engine's fire path
 * never slows (Req 2 / DoD).
 *
 * THREE INVARIANTS this file guarantees:
 *   1. FIRE-AND-FORGET — `emitAlertsForArrow` never throws. A failed alert can
 *      never break the arrow-fire path (the worker wraps the call in try/catch
 *      too, for defense in depth).
 *   2. NO REPLAY — the record id is deterministic (`${arrowId}:${addr}`), so
 *      re-emitting the same arrow is idempotent: one arrow → one alert/person.
 *   3. HEALTH-GATED — if the engine is blind (KV throttle → observable:false)
 *      or its snapshot is stale, we do NOT emit alerts off possibly-blind data;
 *      a wrong alert is worse than a missed one. We DON'T backfill (a late alert
 *      is worse than none) — but we DO log the miss with arrow_id + recipient
 *      count so a silent signal loss is always recoverable.
 *
 * CHANNEL MODEL (read `kv-keys.ts` 2.1 block too): each record carries a
 * per-channel `delivered` cursor so many channels share ONE record. The
 * `bh:alert:pending` queue is TELEGRAM'S alone — web-push finds its work via
 * `bh:alert:addr:{addr}` + a `delivered.webpush` cursor and must NOT drain the
 * queue.
 */
import { kvGet, kvSet } from "@/lib/kv";
import {
  kvAlert,
  kvAlertsByAddr,
  KV_ALERT_PENDING,
  TTL_ALERT,
  ALERT_ADDR_MAX,
  ALERT_PENDING_MAX,
} from "./kv-keys";
import {
  recipientsForArrow,
  tgUserForAddress,
  broadcastMembers,
  ALL_KINDS,
  type AlertKind,
} from "./watchlist";
import { findByTicker } from "@/lib/robinhood/rwa-registry";
import { absoluteUrl } from "@/lib/site-url";
import type { Arrow } from "./types";
import type { EngineHealth } from "./health";

// ── Types ────────────────────────────────────────────────────────────────────

/** Delivery channels that read alert records. Each stamps its own `delivered` cursor. */
export type AlertChannel = "telegram" | "webpush";

/** One recipient's copy of a fired arrow. Channel-agnostic; delivery is per-channel. */
export interface HoodAlert {
  /** `${arrow_id}:${address}` — deterministic, so re-emit is a no-op (no replay). */
  id: string;
  /** Recipient wallet, lowercase. */
  address: string;
  arrow_id: string;
  /** Aesthetic serial (`#0067`) copied from the arrow for display. */
  serial: string;
  ticker: string;
  /** The arrow's kind (drift | arb | flow) — matches the watcher's opt-in. */
  kind: AlertKind;
  /** Compact human label, e.g. "DRIFT ↓", "ARB long dex". */
  signal: string;
  /** First line of the arrow's verdict note, if a brief was attached. */
  brief: string | null;
  /** Canonical inbox deep-link. */
  url: string;
  created_at: string;
  /** channel → ISO delivered-at. Empty until a channel sends. */
  delivered: Partial<Record<AlertChannel, string>>;

  // ── 2.2b enrichment (all optional — older records read back undefined and
  //    the DM render falls back gracefully) ────────────────────────────────
  /** Present ONLY on a BROADCAST copy (tier-1 firehose). When set, the drain DMs
   *  this tg id directly — there is no wallet to resolve (`address` is ""). */
  tg_user_id?: string;
  /** Canonical verified contract from the RWA registry (checksummed), or null if
   *  the ticker isn't a canonical registry token. Never a DEX-pool / user address. */
  contract?: string | null;
  /** True iff the ticker resolved to a canonical registry token — gates the
   *  "✓ verified canonical" DM line. NEVER label an unverified address verified. */
  verified?: boolean;
  /** Fire-time facts for the DM body (snapshotted from arrow.snapshot_at_fire). */
  oracle_price_usd?: number | null;
  dex_price_usd?: number | null;
  tvl_usd?: number | null;
  /** DEX-vs-oracle drift %, computed in code at emit time (never LLM-generated). */
  drift_pct?: number | null;
}

/** The subset of engine health the gate needs — narrowed so callers/tests need not build a full EngineHealth. */
export type AlertHealthGate = Pick<EngineHealth, "ok" | "observable" | "status">;

export interface AlertEmitResult {
  arrow_id: string;
  /** Records newly written this call (0 on skip / dedupe / no recipients). */
  emitted: number;
  /** Total unique recipients written — watchers ∪ broadcast (deduped by tg id).
   *  In the blind-skip case this is 0 (uncounted) — see skip_reason. */
  recipients: number;
  /** true only when the HEALTH gate suppressed emission. */
  skipped: boolean;
  skip_reason?: "engine_blind" | "engine_stale" | "not_engine_origin" | "no_alert_kind";
}

// ── Label ────────────────────────────────────────────────────────────────────

/** Compact signal label (mirrors the web-push payload wording). */
function signalLabel(a: Arrow): string {
  const dir = a.expected_direction === "up" ? "↑" : "↓";
  switch (a.type) {
    case "drift": return `DRIFT ${dir}`;
    case "arb":   return `ARB ${a.expected_direction === "up" ? "long dex" : "short dex"}`;
    case "flow":  return `FLOW ${a.expected_direction === "up" ? "buy" : "sell"}`;
    default:      return "WHALE Δ";
  }
}

// ── Emit ─────────────────────────────────────────────────────────────────────

/** Fire-time facts snapshotted onto every alert copy for the DM body. Computed
 *  ONCE per arrow (not per recipient) in {@link enrichFromArrow}; the drift %
 *  and the canonical contract come from CODE + the RWA registry — never an LLM. */
interface AlertEnrichment {
  /** Canonical verified contract (checksummed) or null when the ticker isn't a
   *  registry token. NEVER a DEX-pool / user address. */
  contract: string | null;
  /** True iff the ticker resolved to a canonical registry token. Gates the
   *  "✓ verified canonical" DM line — do NOT claim verified without a match. */
  verified: boolean;
  oracle_price_usd: number | null;
  dex_price_usd: number | null;
  tvl_usd: number | null;
  /** (dex − oracle) / oracle × 100, computed here. Null when either leg is missing. */
  drift_pct: number | null;
}

/** Resolve the canonical contract + fire-time prices/drift for an arrow, ONCE. */
function enrichFromArrow(arrow: Arrow): AlertEnrichment {
  const tok = findByTicker(arrow.ticker);
  const snap = arrow.snapshot_at_fire ?? null;
  const oracle = snap?.oracle_price_usd ?? null;
  // reference_price is the fire-time DEX baseline — a safe fallback when the
  // snapshot's dex leg is null.
  const dex = snap?.dex_price_usd ?? arrow.reference_price ?? null;
  const tvl = snap?.dex_total_tvl_usd ?? snap?.dex_tvl_usd ?? null;
  const drift =
    oracle != null && dex != null && Number.isFinite(oracle) && Number.isFinite(dex) && oracle > 0
      ? ((dex - oracle) / oracle) * 100
      : null;
  return {
    contract: tok?.contract ?? null,
    verified: !!tok,
    oracle_price_usd: oracle,
    dex_price_usd: dex,
    tvl_usd: tvl,
    drift_pct: drift,
  };
}

/**
 * Write ONE recipient copy of a fired arrow. Unified for both tiers:
 *   • watcher copy   → id `${arrowId}:${address}`, indexed under the wallet.
 *   • broadcast copy → id `${arrowId}:tg:${tgUserId}`, address "", tg_user_id set,
 *     NO per-wallet index (there's no wallet — the drain DMs tg_user_id directly).
 * Both always append to the Telegram pending queue. Idempotent on the id, so an
 * arrow reprocessed by the worker never double-alerts anyone. Never throws.
 */
async function writeAlertRecord(args: {
  arrow: Arrow;
  kind: AlertKind;
  enrich: AlertEnrichment;
  address: string;
  tgUserId?: string;
}): Promise<boolean> {
  const { arrow, kind, enrich, address, tgUserId } = args;
  const id = tgUserId ? `${arrow.id}:tg:${tgUserId}` : `${arrow.id}:${address}`;
  const existing = await kvGet<HoodAlert>(kvAlert(id));
  if (existing) return false; // already emitted — one arrow → one alert/recipient

  const rec: HoodAlert = {
    id,
    address,
    arrow_id: arrow.id,
    serial: arrow.serial,
    ticker: arrow.ticker,
    kind,
    signal: signalLabel(arrow),
    brief: arrow.brief?.verdict_note?.slice(0, 240) ?? null,
    url: absoluteUrl(`/hood/inbox#${arrow.id}`),
    created_at: new Date().toISOString(),
    delivered: {},
    contract: enrich.contract,
    verified: enrich.verified,
    oracle_price_usd: enrich.oracle_price_usd,
    dex_price_usd: enrich.dex_price_usd,
    tvl_usd: enrich.tvl_usd,
    drift_pct: enrich.drift_pct,
    ...(tgUserId ? { tg_user_id: tgUserId } : {}),
  };
  await kvSet(kvAlert(id), rec, TTL_ALERT);

  // Per-address index (newest-first, capped) — the read endpoint + web-push
  // cursor. Broadcast copies have no wallet, so they skip the index entirely.
  if (address) {
    const idxKey = kvAlertsByAddr(address);
    const idx = (await kvGet<string[]>(idxKey)) ?? [];
    if (!idx.includes(id)) {
      idx.unshift(id);
      await kvSet(idxKey, idx.slice(0, ALERT_ADDR_MAX), TTL_ALERT);
    }
  }

  // Telegram (2.2) pending queue (FIFO, ceilinged so a stalled consumer can't bloat KV).
  const pend = (await kvGet<string[]>(KV_ALERT_PENDING)) ?? [];
  if (!pend.includes(id)) {
    pend.push(id);
    const trimmed = pend.length > ALERT_PENDING_MAX ? pend.slice(pend.length - ALERT_PENDING_MAX) : pend;
    await kvSet(KV_ALERT_PENDING, trimmed);
  }
  return true;
}

/**
 * Resolve + write alerts for one freshly-persisted arrow. Called by the
 * brief-worker after brief attach + push fan-out. Never throws.
 *
 * @param health — engine health computed ONCE per worker invocation (see the
 *   brief-worker `handle()`), passed in so every arrow in a batch shares the
 *   same gate decision without re-probing KV per arrow.
 */
export async function emitAlertsForArrow(arrow: Arrow, health: AlertHealthGate): Promise<AlertEmitResult> {
  const base = { arrow_id: arrow.id };

  // Defense in depth — seeded/test arrows never alert real wallets (mirrors
  // pushArrowToAll's own origin check).
  if (arrow.test || (arrow.origin && arrow.origin !== "engine")) {
    return { ...base, emitted: 0, recipients: 0, skipped: false, skip_reason: "not_engine_origin" };
  }

  // Only drift/arb/flow are watchable. "whale" is informational — no AlertKind,
  // so no watchlist alert (and nobody can subscribe to it).
  const kind = arrow.type;
  if (!ALL_KINDS.includes(kind as AlertKind)) {
    return { ...base, emitted: 0, recipients: 0, skipped: false, skip_reason: "no_alert_kind" };
  }
  const alertKind = kind as AlertKind;

  // ── Health gate (Req 3) ──────────────────────────────────────────────────
  // health.ok is true ONLY for healthy|lagging. false ⇒ blind (kv_error) OR
  // stale. Suppress the fan-out either way. The arrow itself still fired + still
  // grades — only the watcher alert is dropped, and NOT backfilled. What we owe
  // is a traceable miss (arrow_id + recipient count) so this can never be a
  // silent signal loss.
  if (!health.ok) {
    const at = new Date().toISOString();
    if (!health.observable) {
      // KV is unreachable — counting recipients would hit the same dead KV, so
      // the honest recipient count is UNKNOWN, not 0.
      console.warn(
        `[alert] skip arrow=${arrow.serial} arrow_id=${arrow.id} ticker=${arrow.ticker} ` +
          `kind=${alertKind} recipients_skipped=unknown reason=engine_blind ` +
          `health=${health.status} observable=false at=${at} (no backfill by design)`,
      );
      return { ...base, emitted: 0, recipients: 0, skipped: true, skip_reason: "engine_blind" };
    }
    // Observable but not ok ⇒ stale snapshot. KV IS readable, so count exactly
    // how many watchers lost this alert.
    const recipients = await recipientsForArrow(arrow.ticker, alertKind);
    console.warn(
      `[alert] skip arrow=${arrow.serial} arrow_id=${arrow.id} ticker=${arrow.ticker} ` +
        `kind=${alertKind} recipients_skipped=${recipients.length} reason=engine_stale ` +
        `health=${health.status} observable=true at=${at} (no backfill by design)`,
    );
    return { ...base, emitted: 0, recipients: recipients.length, skipped: true, skip_reason: "engine_stale" };
  }

  // ── Emit (Req 1 + 5 + 2.2b fan-out) ──────────────────────────────────────
  // Recipient set = WATCHERS of this ticker/kind (tier-2, targeted) UNION the
  // BROADCAST firehose (tier-1, every tradable arrow). Someone who both watches
  // NVDA and is on the broadcast list must get EXACTLY ONE DM — so we dedup the
  // broadcast list against the tg ids already covered by a watcher copy.
  // enrich is computed ONCE and shared by every copy.
  const enrich = enrichFromArrow(arrow);

  const watchers = await recipientsForArrow(arrow.ticker, alertKind);
  const coveredTgIds = new Set<string>();
  let emitted = 0;
  for (const addr of watchers) {
    if (await writeAlertRecord({ arrow, kind: alertKind, enrich, address: addr })) emitted++;
    // Resolve regardless of the write result: on a reprocessed arrow the watcher
    // copy already exists (write=false) but this person is STILL covered and must
    // still suppress their broadcast copy.
    const tg = await tgUserForAddress(addr);
    if (tg) coveredTgIds.add(tg);
  }

  // Broadcast tier — firehose subscribers not already reached as a watcher.
  // A KV hiccup on the firehose must NEVER break the watcher fan-out above.
  let broadcast: string[] = [];
  try {
    broadcast = await broadcastMembers();
  } catch {
    broadcast = [];
  }
  const broadcastTargets = broadcast.filter((tg) => !coveredTgIds.has(tg));

  if (watchers.length === 0 && broadcastTargets.length === 0) {
    return { ...base, emitted: 0, recipients: 0, skipped: false };
  }

  for (const tg of broadcastTargets) {
    if (await writeAlertRecord({ arrow, kind: alertKind, enrich, address: "", tgUserId: tg })) emitted++;
  }

  const recipients = watchers.length + broadcastTargets.length;
  console.log(
    `[alert] arrow=${arrow.serial} ticker=${arrow.ticker} kind=${alertKind} ` +
      `watchers=${watchers.length} broadcast=${broadcastTargets.length} ` +
      `recipients=${recipients} emitted=${emitted}`,
  );
  return { ...base, emitted, recipients, skipped: false };
}

// ── Read / consume ───────────────────────────────────────────────────────────

/** Recent alerts for a wallet, newest-first. Powers GET /api/hood/alerts. Never throws. */
export async function getAlertsForAddress(address: string, limit = 50): Promise<HoodAlert[]> {
  const addr = address.trim().toLowerCase();
  const ids = (await kvGet<string[]>(kvAlertsByAddr(addr))) ?? [];
  const out: HoodAlert[] = [];
  for (const id of ids.slice(0, limit)) {
    const rec = await kvGet<HoodAlert>(kvAlert(id));
    if (rec) out.push(rec);
  }
  return out;
}

/**
 * 2.2 drain — PEEK the head of the Telegram pending queue (does not remove).
 * The bot sends, then calls `markAlertDelivered` + `removeFromPending` on
 * success; on failure the id stays for the next drain (at-least-once delivery).
 * Prunes ids whose record has expired/vanished so a dead id can't wedge the head.
 * Never throws.
 */
export async function peekPendingAlerts(limit: number): Promise<HoodAlert[]> {
  const ids = (await kvGet<string[]>(KV_ALERT_PENDING)) ?? [];
  const out: HoodAlert[] = [];
  const alive: string[] = [];
  let pruned = false;
  for (const id of ids) {
    if (out.length >= limit) { alive.push(id); continue; }
    const rec = await kvGet<HoodAlert>(kvAlert(id));
    if (rec) { out.push(rec); alive.push(id); }
    else { pruned = true; } // record gone (TTL/expiry) — drop the dead id
  }
  if (pruned) await kvSet(KV_ALERT_PENDING, alive);
  return out;
}

/** Stamp a channel's delivery cursor on the shared record. Idempotent. Never throws. */
export async function markAlertDelivered(id: string, channel: AlertChannel): Promise<void> {
  const rec = await kvGet<HoodAlert>(kvAlert(id));
  if (!rec) return;
  rec.delivered = { ...rec.delivered, [channel]: new Date().toISOString() };
  await kvSet(kvAlert(id), rec, TTL_ALERT);
}

/**
 * Stamp a NON-delivery SENTINEL on a channel cursor — e.g. `"skipped_no_tg"`
 * when a recipient has no Telegram link. Deliberately distinct from
 * `markAlertDelivered`'s ISO timestamp: a reader can tell "sent" from
 * "permanently skipped", and the 2.2 drain uses it to drop a never-deliverable
 * alert from the pending queue instead of retrying it forever. Idempotent.
 * Never throws.
 */
export async function markAlertSkipped(id: string, channel: AlertChannel, reason: string): Promise<void> {
  const rec = await kvGet<HoodAlert>(kvAlert(id));
  if (!rec) return;
  rec.delivered = { ...rec.delivered, [channel]: reason };
  await kvSet(kvAlert(id), rec, TTL_ALERT);
}

/**
 * Remove an id from the TELEGRAM pending queue after the bot has sent it. Only
 * the Telegram consumer calls this — other channels track progress via their own
 * `delivered.<channel>` cursor and never touch this queue.
 */
export async function removeFromPending(id: string): Promise<void> {
  const ids = (await kvGet<string[]>(KV_ALERT_PENDING)) ?? [];
  if (!ids.includes(id)) return;
  await kvSet(KV_ALERT_PENDING, ids.filter((x) => x !== id));
}
