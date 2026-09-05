/**
 * Public read of the latest Blue Hood snapshot.
 *
 * `/hood` calls this on mount + on a client-side timer so it doesn't need
 * to hit KV directly from React. Read-only, public, cache-busting headers
 * — no secret required.
 *
 * WHY kvGetProbe (not kvGet): a swallowed KV throw returns null, which the old
 * code reported as "Poller hasn't run" — the exact blind message that masked
 * the 2026-07-27 Upstash-cap outage. We now probe WITHOUT swallowing and split
 * the 503 into two honest causes so the board never blames the poller for what
 * is actually a monitoring blackout. `reason` is machine-readable so the client
 * can pick a banner; the richer WHY lives at `/api/hood/health`.
 */
import { NextResponse } from "next/server";
import { kvGet, kvGetProbe } from "@/lib/kv";
import { KV_SNAPSHOT_LATEST, KV_BASE_ROWS_LATEST } from "@/lib/blue-hood/kv-keys";
import { partitionBaseRows } from "@/lib/blue-hood/types";
import type { BaseDeskLatest, HoodSnapshot } from "@/lib/blue-hood/types";

export const runtime = "nodejs";

/**
 * Base P1 — a Base row set older than this is treated as absent.
 *
 * Belt to `TTL_BASE_ROWS`' braces: the TTL is what removes the key, this is
 * what stops us rendering a row that is technically still within TTL but
 * clearly from a dead desk (e.g. the poll cron itself stalled). 12 min ≈ 2.4
 * cycles — long enough that one skipped cycle doesn't blank the desk, short
 * enough that nobody sees a stock price from three cycles ago as "live".
 */
const BASE_ROWS_MAX_AGE_MS = 12 * 60 * 1000;

export async function GET() {
  const probe = await kvGetProbe<HoodSnapshot>(KV_SNAPSHOT_LATEST);

  if (probe.status === "error") {
    // KV threw (throttle / plan-cap / network) — we are BLIND, not down. Do not
    // say "poller hasn't run": the engine may be perfectly healthy behind an
    // unreadable KV. See /api/hood/health for the full discrimination.
    return NextResponse.json(
      {
        ok: false,
        reason: "kv_error",
        error: `KV unreachable (${probe.message}). Snapshot state UNKNOWN — monitoring is blind, not confirmed down.`,
      },
      { status: 503, headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  }

  if (probe.status === "miss") {
    return NextResponse.json(
      { ok: false, reason: "never_polled", error: "No snapshot yet — the poller has not produced one (cold start)." },
      { status: 503, headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  }

  // ── Base P1: merge the Base desk in, on the SUCCESS PATH ONLY ────────────
  //
  // Placement is the guarantee. Both 503 branches above have already returned,
  // so nothing here can turn a `kv_error` into a 200 or paper over a
  // `never_polled` — the documented failure semantics of this route are
  // untouched BY CONSTRUCTION, not by care.
  //
  // `kvGet` (swallowing) not `kvGetProbe` (throwing) on purpose: the RH
  // snapshot is the heartbeat and a Base-side KV problem must not take the
  // board down. Base absent → board renders RH exactly as it did before P1.
  const rh = probe.value;
  let baseRows: HoodSnapshot["tickers"] = [];
  let baseStale = false;
  /** Rows the Base desk polled that arrived without a chain marker and were
   *  therefore dropped rather than rendered as Robinhood. See the partition
   *  below. Surfaced on the response so `count` never silently disagrees with
   *  what the desk actually polled. */
  let baseUnattributed = 0;
  try {
    const baseLatest = await kvGet<BaseDeskLatest>(KV_BASE_ROWS_LATEST);
    if (baseLatest?.rows?.length) {
      const ageMs = Date.now() - new Date(baseLatest.started_at).getTime();
      if (Number.isFinite(ageMs) && ageMs <= BASE_ROWS_MAX_AGE_MS) {
        // #162 — check the Base marker instead of inheriting it from the type.
        // `kvGet<BaseDeskLatest>` is an unchecked cast over whatever JSON is at
        // that key, so `rows: BaseTickerSnapshot[]` binds the WRITER and proves
        // nothing here; a blob from an older deploy can hold rows with no
        // `chain` at all.
        //
        // Dropping an unattributed row is the safe direction, and it is the
        // same call `detail-support.ts` already makes for the panel: a row that
        // cannot say which desk it came from would otherwise be rendered as
        // Robinhood — RH badge, Basescan link replaced by Blockscout, RH pools
        // in the expand, RH-qualified arrow key — because `chainOf` reads
        // absence as robinhood for the legacy archive's sake. Showing nothing
        // is recoverable; showing NVDA's Base row under an RH identity is the
        // #161 defect wearing a fresh coat.
        const split = partitionBaseRows(baseLatest.rows);
        baseRows = split.attributed;
        if (split.unattributed.length > 0) {
          // Loud, because this is unreachable unless something upstream broke:
          // every producer is typed to require the marker. Silence here would
          // turn a writer regression into a board that quietly lists fewer
          // stocks than the desk polled.
          baseUnattributed = split.unattributed.length;
          console.error(
            `[hood/snapshot] dropped ${baseUnattributed} Base row(s) with no chain marker: ` +
              split.unattributed.map((r) => r.ticker).join(", "),
          );
        }
      } else {
        // Present but old — drop the rows and SAY so, rather than rendering a
        // stale stock price that looks live. A wrong price that looks fresh is
        // worse than no price, because it is actionable.
        baseStale = true;
      }
    }
  } catch {
    // Swallowed deliberately — see above. Base is additive; RH is the product.
  }

  // Mirror the merge `poll/route.ts` already performs in memory before running
  // the rule engine, so the board shows exactly the row set the engine graded.
  // Metrics MUST be bumped alongside `tickers` or the header strip's
  // "N tokens watched" stops describing the rows underneath it.
  const snapshot: HoodSnapshot = baseRows.length
    ? {
        ...rh,
        tickers: [...rh.tickers, ...baseRows],
        metrics: {
          ...rh.metrics,
          tokens_watched: rh.metrics.tokens_watched + baseRows.length,
          tokens_errored:
            rh.metrics.tokens_errored + baseRows.filter((r) => r.verdict === "ERROR").length,
        },
      }
    : rh;

  return NextResponse.json(
    {
      ok: true,
      snapshot,
      // Explicit desk state so the board can honour the #308 rule: show Base
      // even when it has zero arrows. `count: 0` with `status: "live"` renders
      // "watching N Base stocks, no drift past threshold" — a real state.
      // Silence would read as a bug, which is exactly what #308 forbade.
      base_desk: {
        status: baseRows.length ? "live" : baseStale ? "stale" : "offline",
        count: baseRows.length,
        // 0 in every healthy cycle. Non-zero means the desk polled rows this
        // reader refused to attribute, so `count` is BELOW what was polled —
        // stated rather than left as a silent shortfall, for the same reason
        // the archive watchdog reports `empty` instead of going quiet.
        unattributed: baseUnattributed,
      },
    },
    // CDN-cached on the SUCCESS PATH ONLY — the placement is the guarantee,
    // exactly as it is for the Base merge above. Both 503 branches returned
    // long before this line and keep their own `no-store`, so neither
    // `kv_error` ("we are BLIND") nor `never_polled` can ever be held at the
    // edge. That distinction is the whole point of this route and a cached
    // 503 would pin a transient KV blip across every visitor for 30s.
    //
    // NOTE the asymmetry with /api/hood/arrows, which additionally carries
    // `stale-while-revalidate`. That route has no 503 branch at all, so a
    // stale 200 can only ever replace a WORSE 200. This route DOES have one,
    // so SWR is deliberately absent here: it would serve a stale 200 over a
    // live outage and un-say the honest answer the 503 exists to give.
    { headers: { "Cache-Control": "public, max-age=0, s-maxage=30" } },
  );
}
