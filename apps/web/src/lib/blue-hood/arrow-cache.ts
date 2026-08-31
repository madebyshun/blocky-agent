/**
 * Blue Hood — hydrated arrow feed cache (#148 ②).
 *
 * ═══ WHAT THIS REPLACES ═══
 *
 * Every public arrow read used to be an N+1 fan-out:
 *
 *     const ids = (await kvGet<string[]>(KV_ARROW_FEED)) ?? [];   // 1 command
 *     await Promise.all(ids.map((id) => kvGet<Arrow>(kvArrow(id)))); // N more
 *
 * At N≈200 that is ~401 KV commands for ONE request, and five surfaces did it
 * — /api/hood/arrows, /api/acp/arrows, /api/hood/inbox/unread-count (polled
 * from AppShell on *every* page), `readPublicArrows`, and the serial lookup.
 * Four of those poll on a 15s timer. `s-maxage` (①) capped how many requests
 * reach the origin; it did nothing about what each one costs. This file is the
 * other half: through `readArrowFeed` the same read costs **1 command**.
 *
 * ═══ THE TWO RULES THAT MATTER ═══
 *
 * 1. THIS IS A CACHE, NEVER A SOURCE OF TRUTH. `bh:arrow:feed` and
 *    `bh:arrow:{id}` stay authoritative and are never written here. The blob
 *    is derived, disposable, and safe to `kvDel` at any instant — the cost of
 *    dropping it is one rebuild, never data. Every failure path below prefers
 *    dropping it to trusting it.
 *
 * 2. A FAILED READ IS NOT AN EMPTY FEED. This is the #150 rule, and it is the
 *    reason this file uses `kvGetProbe` throughout rather than `kvGet`. The
 *    2026-08-27 outage had /api/hood/arrows serving `{ok:true, arrows:[]}` and
 *    a `graded:0` hit rate off a suspended database — publishing "we have no
 *    track record" as fact while 300+ graded arrows sat safely in KV. A cache
 *    makes that failure mode *worse* if you let it: one throttled read would
 *    otherwise get baked in and served for the whole TTL. So:
 *      • blob read errors            → `unavailable` (and NO rebuild)
 *      • index read errors           → `unavailable`
 *      • ANY arrow record read errors → `unavailable`, nothing written
 *    Only a genuine `miss` — the key is absent — is allowed to mean empty.
 */
import { kvGetProbe, kvSet, kvDel, kvMutate, type KvProbe } from "@/lib/kv";
import {
  KV_ARROW_FEED,
  KV_ARROW_HYDRATED,
  ARROW_HYDRATED_MAX,
  TTL_ARROW_HYDRATED,
  kvArrow,
} from "./kv-keys";
import { warnIfArrowIndexLarge } from "./arrow-index";
import type { Arrow } from "./types";

/** Bump when the blob's shape changes — a version mismatch reads as a miss and rebuilds. */
export const HYDRATED_VERSION = 1;

export type HydratedFeed = {
  v: number;
  /** ISO timestamp of the last rebuild or patch. Surfaced by the API so blob staleness is observable, not silent. */
  built_at: string;
  /**
   * Newest-first arrow records, RAW and UNFILTERED — `test` and non-engine
   * arrows included on purpose. The `isPublicArrow` trust boundary is applied
   * at READ time by `public-feed.ts`, so `test_arrows_hidden` stays countable
   * and `?include_test=1` still works in dev. Filtering at write time would
   * bake a trust decision into a cache and make the two impossible to reconcile.
   */
  arrows: Arrow[];
};

export type ArrowFeedRead =
  | {
      status: "ok";
      arrows: Arrow[];
      built_at: string;
      source: "cache" | "rebuild";
      /** KV commands this read actually cost. Exists so a test can ASSERT the point of this file. */
      kv_commands: number;
    }
  | { status: "unavailable"; reason: string };

/**
 * Sentinel handed to `kvMutate` as its `empty` value on the write paths.
 *
 * ⚠ Load-bearing. `kvMutate` seeds the mutator from `empty` when the key is
 * absent, so a naive `{v:1, arrows:[]}` would let a single fire write a
 * ONE-ARROW blob and publish it as the whole feed for 6h — the exact
 * `?? [] → write` shape #150 exists to kill, rebuilt inside its own fix.
 * `v: -1` can never equal `HYDRATED_VERSION`, so every mutator below bails
 * with `null` (no write) and leaves the rebuild to the next read.
 */
const ABSENT: HydratedFeed = { v: -1, built_at: "", arrows: [] };

function isErrorProbe<T>(p: KvProbe<T>): p is Extract<KvProbe<T>, { status: "error" }> {
  return p.status === "error";
}

/**
 * Read the hydrated feed. One KV command on the happy path.
 *
 * On a miss (cold key, expired TTL, version bump) this rebuilds inline and
 * pays the fan-out once, then every subsequent reader is back to 1 command.
 * On an ERROR it returns `unavailable` and deliberately does NOT rebuild:
 * a rebuild is ~252 further reads aimed at a database that just failed one,
 * which is precisely how a throttle becomes a suspension.
 */
export async function readArrowFeed(): Promise<ArrowFeedRead> {
  const probe = await kvGetProbe<HydratedFeed>(KV_ARROW_HYDRATED);

  if (probe.status === "error") {
    return { status: "unavailable", reason: `hydrated feed read failed: ${probe.message}` };
  }

  if (probe.status === "hit" && probe.value?.v === HYDRATED_VERSION && Array.isArray(probe.value.arrows)) {
    return {
      status: "ok",
      arrows: probe.value.arrows,
      built_at: probe.value.built_at,
      source: "cache",
      kv_commands: 1,
    };
  }

  const rebuilt = await rebuildArrowFeed();
  // +1 for the probe we already spent getting here.
  return rebuilt.status === "ok" ? { ...rebuilt, kv_commands: rebuilt.kv_commands + 1 } : rebuilt;
}

/**
 * Rebuild the blob from the authoritative index + records. The ONLY place that
 * pays the fan-out. Writes the result unless anything about the read was
 * uncertain.
 */
export async function rebuildArrowFeed(): Promise<ArrowFeedRead> {
  const index = await kvGetProbe<string[]>(KV_ARROW_FEED);
  if (index.status === "error") {
    return { status: "unavailable", reason: `arrow index read failed: ${index.message}` };
  }

  // `miss` here is the one honest empty: the index key is genuinely absent, so
  // no arrow has ever fired. Distinct from the `error` above — collapsing those
  // two is the whole bug family.
  const all = index.status === "hit" ? index.value ?? [] : [];

  // #154 — second observation point for the index size, measured on `all`
  // BEFORE the slice below. Two reasons it is here and not only at the append
  // site in `rule-engine.ts`:
  //   • different code path — the append is what the budget outage starves
  //     first, so if firing stalls, this read is the one still reporting;
  //   • no extra cost — the full index is already in hand, and a rebuild is
  //     rare (write-time patching keeps the blob warm; the 6h TTL is only a
  //     corruption backstop), so this cannot become log spam.
  // The hot readers are deliberately NOT instrumented — see `arrow-index.ts`.
  warnIfArrowIndexLarge(all.length, "cache rebuild");

  // The slice is the CACHE's depth, not a trim of the index: `all` is a local
  // copy of a value this file never writes. `bh:arrow:feed` keeps every id.
  const ids = all.slice(0, ARROW_HYDRATED_MAX);

  const probes = await Promise.all(ids.map((id) => kvGetProbe<Arrow>(kvArrow(id))));

  const failed = probes.find(isErrorProbe);
  if (failed) {
    // A PARTIAL fan-out must never be written. Persisting a short feed would
    // convert one throttled read into 6h of a silently-truncated public track
    // record — the outage bug, cached. Bail; the next read tries again.
    return { status: "unavailable", reason: `arrow record read failed: ${failed.message}` };
  }

  // An individual `miss` IS expected and fine: ids outlive records when an
  // arrow's 30d TTL lapses before the index is trimmed. The old code dropped
  // those with `!== null`; same behaviour, just no longer conflated with error.
  const arrows = probes.flatMap((p) => (p.status === "hit" ? [p.value] : []));

  const blob: HydratedFeed = { v: HYDRATED_VERSION, built_at: new Date().toISOString(), arrows };
  await kvSet(KV_ARROW_HYDRATED, blob, TTL_ARROW_HYDRATED);

  return {
    status: "ok",
    arrows,
    built_at: blob.built_at,
    source: "rebuild",
    kv_commands: 1 + ids.length + 1, // index + fan-out + the write
  };
}

/** Drop the blob. Next read rebuilds. Cheap, and always safe — see rule 1 up top. */
export async function invalidateArrowCache(): Promise<void> {
  await kvDel(KV_ARROW_HYDRATED);
}

/**
 * Write-time patch: a new arrow just fired. Prepends it so the blob stays
 * fresh without waiting on the TTL.
 *
 * If the patch cannot be applied, the blob is DROPPED rather than left behind.
 * A stale blob missing the newest arrow would hide a live signal for up to 6h;
 * a dropped one costs a single rebuild. Always prefer the rebuild.
 */
export async function onArrowFired(arrow: Arrow): Promise<void> {
  const res = await kvMutate<HydratedFeed>(
    KV_ARROW_HYDRATED,
    ABSENT,
    (cur) => {
      // Covers BOTH "key absent" (the ABSENT sentinel) and "old schema".
      // Either way there is nothing coherent to patch — decline the write and
      // let the next reader rebuild from the source of truth.
      if (cur.v !== HYDRATED_VERSION) return null;
      return {
        v: HYDRATED_VERSION,
        built_at: new Date().toISOString(),
        // De-dupe by id so a retried fire can't double-list the same arrow.
        arrows: [arrow, ...cur.arrows.filter((a) => a.id !== arrow.id)].slice(0, ARROW_HYDRATED_MAX),
      };
    },
    TTL_ARROW_HYDRATED,
  );

  if (res === "skipped" || res === "failed") {
    console.error(`[arrow-cache] fire patch ${res} for ${arrow.id} — dropping blob so the next read rebuilds`);
    await invalidateArrowCache();
  }
}

/**
 * Write-time patch: an existing arrow changed (graded, voided, regraded).
 * Replaces it in place.
 *
 * Doubles as a DRIFT DETECTOR. If the arrow belongs in the window the blob
 * covers but isn't in it, the blob has diverged from the index — almost
 * certainly a fire whose patch was skipped during a KV wobble. That is exactly
 * the state we must not keep serving, so we drop it.
 */
export async function onArrowUpdated(arrow: Arrow): Promise<void> {
  let drifted = false;

  const res = await kvMutate<HydratedFeed>(
    KV_ARROW_HYDRATED,
    ABSENT,
    (cur) => {
      if (cur.v !== HYDRATED_VERSION) return null; // absent or stale schema — nothing to patch

      let found = false;
      const arrows = cur.arrows.map((a) => {
        if (a.id !== arrow.id) return a;
        found = true;
        return arrow;
      });
      if (found) return { v: HYDRATED_VERSION, built_at: new Date().toISOString(), arrows };

      // Not found. Only a problem if it SHOULD have been here — an arrow older
      // than the blob's tail is legitimately outside the window (backfills
      // regrade ancient arrows), and dropping the cache for those would be a
      // self-inflicted rebuild on every backfill row.
      const oldest = cur.arrows.length ? cur.arrows[cur.arrows.length - 1].fired_at : null;
      // ISO-8601 UTC strings sort lexicographically; every `fired_at` is `toISOString()`.
      drifted = cur.arrows.length < ARROW_HYDRATED_MAX || (oldest !== null && arrow.fired_at >= oldest);
      return null;
    },
    TTL_ARROW_HYDRATED,
  );

  if (res === "skipped" || res === "failed" || drifted) {
    await invalidateArrowCache();
  }
}
