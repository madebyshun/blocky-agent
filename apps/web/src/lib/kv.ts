/**
 * Blue Agent — KV Store
 * Uses @upstash/redis when KV_REST_API_URL + KV_REST_API_TOKEN are set.
 * Falls back to in-memory Map for local dev (no env vars needed).
 */

// ─── In-memory fallback ───────────────────────────────────────────────────────
const memStore = new Map<string, { value: unknown; expiresAt?: number }>();

function memClean(key: string) {
  const entry = memStore.get(key);
  if (entry?.expiresAt && Date.now() > entry.expiresAt) {
    memStore.delete(key);
    return true;
  }
  return false;
}

const fallback = {
  async get<T>(key: string): Promise<T | null> {
    if (memClean(key)) return null;
    return (memStore.get(key)?.value as T) ?? null;
  },
  async set(key: string, value: unknown, opts?: { ex?: number }): Promise<void> {
    memStore.set(key, {
      value,
      expiresAt: opts?.ex ? Date.now() + opts.ex * 1000 : undefined,
    });
  },
  async del(...keys: string[]): Promise<void> {
    keys.forEach((k) => memStore.delete(k));
  },
  async incr(key: string): Promise<number> {
    if (memClean(key)) memStore.set(key, { value: 0 });
    const entry = memStore.get(key);
    const val = ((entry?.value as number) ?? 0) + 1;
    memStore.set(key, { value: val, expiresAt: entry?.expiresAt });
    return val;
  },
  async incrby(key: string, by: number): Promise<number> {
    if (memClean(key)) memStore.set(key, { value: 0 });
    const entry = memStore.get(key);
    const val = ((entry?.value as number) ?? 0) + by;
    memStore.set(key, { value: val, expiresAt: entry?.expiresAt });
    return val;
  },
  // Set ops backed by a string[] stored under the key (acts as a Set). We keep
  // the array de-duped so `sadd` is idempotent and `srem` never leaves a ghost.
  async sadd(key: string, ...members: string[]): Promise<number> {
    memClean(key);
    const entry = memStore.get(key);
    const set = new Set<string>((entry?.value as string[]) ?? []);
    let added = 0;
    for (const m of members) if (!set.has(m)) { set.add(m); added++; }
    memStore.set(key, { value: [...set], expiresAt: entry?.expiresAt });
    return added;
  },
  async srem(key: string, ...members: string[]): Promise<number> {
    if (memClean(key)) return 0;
    const entry = memStore.get(key);
    if (!entry) return 0;
    const set = new Set<string>((entry.value as string[]) ?? []);
    let removed = 0;
    for (const m of members) if (set.delete(m)) removed++;
    // Drop the key entirely when the set empties — mirrors Redis, where an
    // empty set stops existing, so an emptied reverse index reads as `miss`.
    if (set.size === 0) memStore.delete(key);
    else memStore.set(key, { value: [...set], expiresAt: entry.expiresAt });
    return removed;
  },
  async smembers(key: string): Promise<string[]> {
    if (memClean(key)) return [];
    return ((memStore.get(key)?.value as string[]) ?? []);
  },
};

// ─── Upstash Redis client ─────────────────────────────────────────────────────
type KVClient = {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, opts?: { ex?: number }): Promise<void>;
  del(...keys: string[]): Promise<void>;
  incr(key: string): Promise<number>;
  incrby(key: string, by: number): Promise<number>;
  sadd(key: string, ...members: string[]): Promise<number>;
  srem(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
};

// Resolve Upstash REST credentials from either env var convention:
//   - KV_REST_API_URL / KV_REST_API_TOKEN          (Vercel KV legacy naming)
//   - UPSTASH_REDIS_REST_URL / ..._TOKEN           (Upstash Marketplace naming)
// The Vercel ↔ Upstash Marketplace integration injects the UPSTASH_* names, so
// supporting both means "Connect Project" works with zero manual env copying.
function kvCreds(): { url: string; token: string } | null {
  const url   = process.env.KV_REST_API_URL   ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
}

function getKV(): KVClient {
  const creds = kvCreds();

  if (creds) {
    const { url, token } = creds;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Redis } = require("@upstash/redis");
    const redis = new Redis({ url, token });
    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      get:  <T>(key: string) => redis.get(key) as Promise<T | null>,
      set:  (key: string, value: unknown, opts?: { ex?: number }) =>
              opts?.ex ? redis.set(key, value, { ex: opts.ex }) : redis.set(key, value),
      del:  (...keys: string[]) => redis.del(...keys),
      incr: (key: string) => redis.incr(key),
      incrby: (key: string, by: number) => redis.incrby(key, by),
      // Native Redis set ops — atomic + idempotent. SREM is the primitive that
      // makes the watchlist reverse index (bh:watch:ticker:*) orphan-proof: it
      // removes a member with no read-modify-write race, and an emptied set
      // ceases to exist. See lib/blue-hood/watchlist.ts.
      sadd: (key: string, ...members: string[]) =>
              redis.sadd(key, ...(members as [string, ...string[]])),
      srem: (key: string, ...members: string[]) =>
              redis.srem(key, ...(members as [string, ...string[]])),
      smembers: (key: string) => redis.smembers(key) as Promise<string[]>,
    };
  }

  return fallback;
}

export const kv = getKV();

// ─── Helpers ─────────────────────────────────────────────────────────────────

export async function kvGet<T>(key: string): Promise<T | null> {
  try { return await kv.get<T>(key); } catch (e) { console.error(`[kv:get] ${key}: ${(e as Error).message}`); return null; }
}

/**
 * Result of a KV read that DISTINGUISHES the three outcomes `kvGet` collapses:
 *   • hit   — key present, here's the value
 *   • miss  — key genuinely absent (client returned null, no error)
 *   • error — the KV command THREW (throttle / plan-cap / network)
 *
 * `kvGet` catches the throw and returns null, so a throttle looks identical to
 * an empty key — which is exactly how the 2026-07-27 Upstash-cap outage read
 * as "poller never ran" and went unnoticed. Callers that need to tell those
 * apart (the engine health probe) MUST use this, not `kvGet`.
 */
export type KvProbe<T> =
  | { status: "hit"; value: T }
  | { status: "miss" }
  | { status: "error"; message: string };

/**
 * Non-swallowing single-key read. The ONE place we deliberately surface a KV
 * error instead of degrading to null. Never throws — it converts the throw
 * into `{status:"error"}` so the caller decides what the error MEANS, rather
 * than the primitive silently pretending the key was empty.
 */
export async function kvGetProbe<T>(key: string): Promise<KvProbe<T>> {
  try {
    const value = await kv.get<T>(key);
    return value === null || value === undefined ? { status: "miss" } : { status: "hit", value };
  } catch (e) {
    return { status: "error", message: (e as Error).message };
  }
}

export async function kvSet(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
  try { await kv.set(key, value, ttlSeconds ? { ex: ttlSeconds } : undefined); } catch (e) { console.error(`[kv:set] ${key}: ${(e as Error).message}`); }
}

export async function kvDel(...keys: string[]): Promise<void> {
  try { await kv.del(...keys); } catch (e) { console.error(`[kv:del] ${keys.join(",")}: ${(e as Error).message}`); }
}

/**
 * Outcome of a `kvMutate`. Four states, because "didn't write" has three very
 * different causes and collapsing them is how this bug family started:
 *   • ok        — read succeeded, value changed, write landed
 *   • unchanged — read succeeded, `mutate` returned null (nothing to do)
 *   • skipped   — READ FAILED. We did not write. Contents still unknown.
 *   • failed    — read succeeded, the write itself failed
 */
export type KvMutateResult = "ok" | "unchanged" | "skipped" | "failed";

/**
 * Read-modify-write against a single key, WITHOUT the wipe.
 *
 * ⚠ This exists to close a specific, repeated, data-destroying bug. The shape
 * it replaces appears ~30 times in this repo:
 *
 *     const list = (await kvGet<string[]>(K)) ?? [];   // throw → null → []
 *     list.push(x);
 *     await kvSet(K, list);                            // writes [x]
 *
 * `kvGet` catches a KV throw and returns null, so a throttle is indistinguishable
 * from an absent key. Feed that `?? []` into a write against THE SAME KEY and a
 * transient read error doesn't drop one item — it replaces the entire collection
 * with a one-element array. The Upstash cap outages (#123, #148) made exactly
 * this failure mode routine, not theoretical: throttled reads for minutes at a
 * time, every one of them a chance to flatten an index that has no TTL and no
 * backup. Same reasoning, same author, same fix as `recordToolPayment` (#147).
 *
 * So: the read goes through `kvGetProbe`, and on `error` we DO NOT WRITE. The
 * cost of skipping is that one mutation is lost. The cost of not skipping is
 * that every prior mutation is lost. Those are not comparable, and the whole
 * point of this helper is that the safe choice is now also the shorter one to
 * write — a rule nobody has to remember is a rule nobody can forget.
 *
 * `mutate` returns the next value, or `null` to mean "no change, skip the
 * write" (the `if (!list.includes(x))` guard, expressed as a return value).
 * It receives `empty` when the key is genuinely absent — a real miss, never an
 * error masquerading as one.
 *
 * NOT atomic. This is still read-then-write, so two concurrent mutators can
 * interleave and one update can be lost. That is a one-item gap, categorically
 * different from the wipe this prevents, and closing it needs native Redis ops
 * (SADD/SREM — see `kvSAdd`/`kvSRem`, which ARE atomic and are the better
 * choice for pure membership sets). Use this for the JSON-blob keys that can't
 * take a type change without a migration.
 */
export async function kvMutate<T>(
  key: string,
  empty: T,
  mutate: (current: T) => T | null,
  ttlSeconds?: number,
): Promise<KvMutateResult> {
  const probe = await kvGetProbe<T>(key);

  // The entire reason this function exists. Logged rather than silent:
  // `kvGet` used to print `[kv:get] …` from its own catch, and `kvGetProbe`
  // deliberately doesn't log — so without this line the fix would trade a
  // data-loss bug for an invisibility one.
  if (probe.status === "error") {
    console.error(`[kv:mutate] ${key}: SKIPPED write — read failed: ${probe.message}`);
    return "skipped";
  }

  const next = mutate(probe.status === "hit" ? probe.value : empty);
  if (next === null) return "unchanged";

  try {
    await kv.set(key, next, ttlSeconds ? { ex: ttlSeconds } : undefined);
    return "ok";
  } catch (e) {
    console.error(`[kv:mutate] ${key}: write failed: ${(e as Error).message}`);
    return "failed";
  }
}

/**
 * Durable write — the counterpart to `kvSet` that does NOT swallow failures.
 *
 * `kvSet` catches, logs and returns normally, so a throttled/failed write is
 * indistinguishable from a successful one. That's fine for caches; it is NOT
 * fine on the money path — a swallowed `kvSet` in the credit ledger lets
 * `topup()` report "credited" while nothing persisted, and the purchase route
 * then writes its `processed` marker, making the credits unrecoverable.
 * Callers that must know the write landed use this and let it throw.
 */
export async function kvSetOrThrow(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
  await kv.set(key, value, ttlSeconds ? { ex: ttlSeconds } : undefined);
}

/**
 * Outcome of an atomic SET-NX. Distinguishes the two cases `kvSetNX` collapses
 * into `false`:
 *   • acquired — the key was free, we own it until the TTL expires
 *   • held     — someone else owns it (real contention)
 *   • error    — the KV command THREW; we learned nothing about the key
 *
 * A lock caller MUST tell `held` from `error`: retrying is correct for `held`
 * but pointless for `error`, and treating `error` as `held` means one KV blip
 * blocks every writer. Same reasoning as `kvGetProbe` above.
 */
export type LockAttempt = "acquired" | "held" | "error";

/**
 * Atomic SET if-not-exists with TTL, reporting which of the three things
 * happened. `kvSetNX` is the boolean sugar over this.
 */
export async function kvTryLock(key: string, value: unknown, ttlSeconds: number): Promise<LockAttempt> {
  try {
    const creds = kvCreds();
    if (creds) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { Redis } = require("@upstash/redis");
      const redis  = new Redis({ url: creds.url, token: creds.token });
      // SET key value NX EX ttl — atomic, returns "OK" or null
      const result = await redis.set(key, value, { nx: true, ex: ttlSeconds });
      return result === "OK" ? "acquired" : "held";
    }
    // In-memory fallback: check expiry + set atomically
    const existing = memStore.get(key);
    const expired  = existing?.expiresAt ? Date.now() > existing.expiresAt : false;
    if (existing && !expired) return "held";
    memStore.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    return "acquired";
  } catch (e) {
    console.error(`[kv:setNX] ${key}: ${(e as Error).message}`);
    return "error";
  }
}

/**
 * Atomic SET if-not-exists with TTL.
 * Returns true if the key was set (lock acquired), false if it already existed
 * — or if the KV command failed. Use `kvTryLock` when those differ to you.
 * Uses Redis SET NX EX — single atomic op, no race condition.
 */
export async function kvSetNX(key: string, value: unknown, ttlSeconds: number): Promise<boolean> {
  return (await kvTryLock(key, value, ttlSeconds)) === "acquired";
}

/**
 * Set helpers — thin, fault-tolerant wrappers over Redis SADD/SREM/SMEMBERS.
 * A KV set is the right primitive for a "who's subscribed to X" list: adds are
 * idempotent, removes never leave orphans, and membership reads are one call —
 * no whole-array read-modify-write (the race-prone shape Sentinel's global
 * `sentinel:watches` array has). Never throw: a failed set op logs and no-ops,
 * so a KV blip degrades one alert route, it doesn't 500 the caller.
 */
export async function kvSAdd(key: string, ...members: string[]): Promise<void> {
  if (members.length === 0) return;
  try { await kv.sadd(key, ...members); } catch (e) { console.error(`[kv:sadd] ${key}: ${(e as Error).message}`); }
}
export async function kvSRem(key: string, ...members: string[]): Promise<void> {
  if (members.length === 0) return;
  try { await kv.srem(key, ...members); } catch (e) { console.error(`[kv:srem] ${key}: ${(e as Error).message}`); }
}
export async function kvSMembers(key: string): Promise<string[]> {
  try { return (await kv.smembers(key)) ?? []; } catch (e) { console.error(`[kv:smembers] ${key}: ${(e as Error).message}`); return []; }
}

export const isKVEnabled = (): boolean => kvCreds() !== null;

/**
 * Scan keys matching a glob pattern (e.g. "ledger:*").
 *
 * Cursor-paginates the Upstash SCAN until exhausted or `max` keys collected
 * (a safety cap so a huge keyspace can't blow up a request). In the in-memory
 * fallback it filters the local Map by prefix. Fault-tolerant: returns whatever
 * it gathered on error, never throws.
 */
export async function kvScan(match: string, max = 10000): Promise<string[]> {
  try {
    const creds = kvCreds();
    if (!creds) {
      // Fallback: only "prefix*" globs are supported locally.
      const prefix = match.endsWith("*") ? match.slice(0, -1) : match;
      return [...memStore.keys()].filter((k) => k.startsWith(prefix)).slice(0, max);
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Redis } = require("@upstash/redis");
    const redis = new Redis({ url: creds.url, token: creds.token });
    const keys: string[] = [];
    let cursor = "0";
    do {
      // scan(cursor, { match, count }) → [nextCursor, keys]
      const [next, batch] = (await redis.scan(cursor, { match, count: 500 })) as [string, string[]];
      keys.push(...batch);
      cursor = next;
    } while (cursor !== "0" && keys.length < max);
    return keys.slice(0, max);
  } catch (e) {
    console.error(`[kv:scan] ${match}: ${(e as Error).message}`);
    return [];
  }
}
