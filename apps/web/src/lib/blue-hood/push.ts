/**
 * Blue Hood — web push infrastructure (T-D D3).
 *
 * Two responsibilities:
 *
 * 1. **Subscription store** — persist a browser's PushSubscription in KV
 *    (`bh:push:sub:{endpointHash}`) plus keep an index of every active
 *    hash (`bh:push:index`). Endpoint URLs are hashed to keep KV keys
 *    fixed-length; the full endpoint stays in the value.
 *
 * 2. **Fan-out** — given a fresh engine arrow, walk the index and send
 *    a compact notification to every live subscription. Sends run in
 *    parallel but bounded to 20 at a time so a large index doesn't
 *    blow the Vercel function's socket count. Any 404/410 from the
 *    push service means the endpoint is gone → drop it from the index.
 *
 * Only engine-origin, non-test arrows push. Seeded arrows never.
 */
import crypto from "crypto";
import webpush from "web-push";
import { kvDel, kvGet, kvSet } from "@/lib/kv";
import { absoluteUrl } from "@/lib/site-url";
import { KV_PUSH_SUB_INDEX, kvPushSub, TTL_PUSH_SUB } from "./kv-keys";
import type { Arrow } from "./types";

export interface StoredPushSub {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  ua?: string;
  created_at: string;
}

/** Deterministic 12-char hash of the endpoint URL. Not a security hash —
 *  just a compact KV key that survives across sessions. */
export function endpointHash(endpoint: string): string {
  return crypto.createHash("sha256").update(endpoint).digest("hex").slice(0, 24);
}

function loadKeys(): { public: string; private: string; subject: string } | null {
  const pub = process.env.VAPID_PUBLIC_KEY ?? "";
  const priv = process.env.VAPID_PRIVATE_KEY ?? "";
  const subject = process.env.VAPID_SUBJECT ?? "mailto:blueagent@blueagent.dev";
  if (!pub || !priv) return null;
  return { public: pub, private: priv, subject };
}

/** Configure the web-push global VAPID details once per warm instance. */
export function ensureVapidConfigured(): boolean {
  const keys = loadKeys();
  if (!keys) return false;
  webpush.setVapidDetails(keys.subject, keys.public, keys.private);
  return true;
}

export function publicVapidKey(): string | null {
  return loadKeys()?.public ?? null;
}

// ── Subscription CRUD ─────────────────────────────────────────────────────

export async function saveSubscription(sub: StoredPushSub): Promise<{ hash: string; created: boolean }> {
  const hash = endpointHash(sub.endpoint);
  const existed = (await kvGet<StoredPushSub>(kvPushSub(hash))) != null;
  await kvSet(kvPushSub(hash), sub, TTL_PUSH_SUB);
  const index = (await kvGet<string[]>(KV_PUSH_SUB_INDEX)) ?? [];
  if (!index.includes(hash)) {
    index.push(hash);
    await kvSet(KV_PUSH_SUB_INDEX, index);
  }
  return { hash, created: !existed };
}

export async function deleteSubscription(endpointOrHash: string): Promise<boolean> {
  const hash = endpointOrHash.startsWith("http") ? endpointHash(endpointOrHash) : endpointOrHash;
  const existed = (await kvGet<StoredPushSub>(kvPushSub(hash))) != null;
  await kvDel(kvPushSub(hash));
  const index = (await kvGet<string[]>(KV_PUSH_SUB_INDEX)) ?? [];
  const next = index.filter((h) => h !== hash);
  await kvSet(KV_PUSH_SUB_INDEX, next);
  return existed;
}

// ── Fan-out ───────────────────────────────────────────────────────────────

interface FanoutStats {
  attempted: number;
  delivered: number;
  gone: number;
  errored: number;
}

function payloadFor(a: Arrow): string {
  // Kept small — most push services cap around 4KB but many enforce a
  // much smaller practical limit. serial + ticker + signal + first-line
  // brief keeps us well under.
  const briefLine = a.brief?.verdict_note ?? "";
  const signal = a.type === "drift" ? `DRIFT ${a.expected_direction === "up" ? "↑" : "↓"}`
    : a.type === "arb" ? `ARB ${a.expected_direction === "up" ? "long dex" : "short dex"}`
    : a.type === "flow" ? `FLOW ${a.expected_direction === "up" ? "buy" : "sell"}`
    : "WHALE Δ";
  return JSON.stringify({
    kind: "hood.arrow",
    id: a.id,
    serial: a.serial,
    ticker: a.ticker,
    signal,
    brief: briefLine.slice(0, 240),
    // Absolute (canonical) URL — see `src/lib/site-url.ts`. On prod
    // this points at blueagent.dev/hood/inbox#<id>; on preview /
    // localhost it degrades to a relative path so the SW's
    // notificationclick opens correctly regardless of origin.
    url: absoluteUrl(`/hood/inbox#${a.id}`),
  });
}

/**
 * Send a push for one arrow to every live subscription. Never throws.
 * Prunes 404/410 subscriptions from the index inline.
 */
export async function pushArrowToAll(a: Arrow): Promise<FanoutStats> {
  if (a.test || (a.origin && a.origin !== "engine")) {
    return { attempted: 0, delivered: 0, gone: 0, errored: 0 };
  }
  if (!ensureVapidConfigured()) {
    console.warn("[push] VAPID keys missing — skipping fan-out");
    return { attempted: 0, delivered: 0, gone: 0, errored: 0 };
  }

  const index = (await kvGet<string[]>(KV_PUSH_SUB_INDEX)) ?? [];
  if (index.length === 0) return { attempted: 0, delivered: 0, gone: 0, errored: 0 };

  const payload = payloadFor(a);
  const stats: FanoutStats = { attempted: 0, delivered: 0, gone: 0, errored: 0 };
  const survivors: string[] = [];

  const BATCH = 20;
  for (let i = 0; i < index.length; i += BATCH) {
    const slice = index.slice(i, i + BATCH);
    const results = await Promise.all(slice.map(async (hash) => {
      const sub = await kvGet<StoredPushSub>(kvPushSub(hash));
      if (!sub) return { hash, gone: true };
      stats.attempted++;
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          payload,
          { TTL: 60 },
        );
        return { hash, delivered: true };
      } catch (e) {
        const err = e as { statusCode?: number; message?: string };
        const status = err.statusCode ?? 0;
        // 404 = subscription gone; 410 = expired. Prune.
        if (status === 404 || status === 410) return { hash, gone: true };
        console.warn(`[push] send failed hash=${hash} status=${status} msg=${err.message?.slice(0, 120)}`);
        return { hash, errored: true };
      }
    }));
    for (const r of results) {
      if (r.gone) { stats.gone++; await kvDel(kvPushSub(r.hash)); }
      else if (r.delivered) { stats.delivered++; survivors.push(r.hash); }
      else if (r.errored) { stats.errored++; survivors.push(r.hash); }
    }
  }

  await kvSet(KV_PUSH_SUB_INDEX, survivors);
  console.log(`[push] arrow=${a.serial} ticker=${a.ticker} attempted=${stats.attempted} delivered=${stats.delivered} gone=${stats.gone} errored=${stats.errored}`);
  return stats;
}
