/**
 * ACP wrapper: Blue Hood drift board snapshot.
 *
 * Public GET. Returns the same snapshot `/api/hood/snapshot` returns,
 * shaped for consumption outside the Blue Hood UI: strips per-row
 * `polled_at_ms` and `data_age_s` (implementation detail), keeps every
 * meaningful field, and adds the ACP envelope.
 *
 * Read-only. Server-side we hit KV (already cached by the poll cron
 * every 2 min) so this endpoint adds zero load beyond a single KV get.
 * Client-side we mark 60s Cache-Control so upstream CDNs cache too.
 */
import { kvGet } from "@/lib/kv";
import { KV_SNAPSHOT_LATEST } from "@/lib/blue-hood/kv-keys";
import type { HoodSnapshot, TickerSnapshot } from "@/lib/blue-hood/types";
import { acpEnvelope, clientIp, corsHeaders, preflight, rateLimit } from "@/lib/acp";

export const runtime = "nodejs";

export async function OPTIONS() {
  return preflight();
}

interface ACPRow {
  ticker: string;
  name: string;
  contract: string;
  verdict: string;
  oracle_usd: number | null;
  dex_usd: number | null;
  drift_pct: number | null;
  /** Deprecated alias for `primary_pool_tvl_usd`. Kept for downstream
   *  ACP consumers that already read `tvl_usd`. New consumers should
   *  read `primary_pool_tvl_usd` + `total_tvl_usd` and pick whichever
   *  matches their semantic. */
  tvl_usd: number | null;
  /** TVL of the pool the swap route uses (USDG-quoted preferred, then
   *  deepest). This is the honest "how deep is the executable price
   *  frame" number — matches the tvl_usd column in the /hood UI. */
  primary_pool_tvl_usd: number | null;
  /** SUM across every pool for this token on RH Chain. Blue Hood's dust
   *  gate reads this — a token with a $21M bankr-robinhood WETH pool +
   *  a $850k USDG pool is objectively deep even if its primary pool is
   *  thin, and downstream agents should see the same. */
  total_tvl_usd: number | null;
  volume_24h_usd: number | null;
  pool_ref: string | null;
  market_session: string;
}

export async function GET(req: Request) {
  const rl = rateLimit(clientIp(req));
  if (!rl.ok) {
    return Response.json(
      { error: "rate_limited", retry_after_s: rl.retry_after_s },
      { status: 429, headers: { ...corsHeaders(), "Retry-After": String(rl.retry_after_s) } },
    );
  }

  const snap = await kvGet<HoodSnapshot>(KV_SNAPSHOT_LATEST);
  if (!snap) {
    return Response.json(
      acpEnvelope(
        { error: "no_snapshot_yet", hint: "Blue Hood cron hasn't populated a snapshot. Retry in 60s." },
        "https://blueagent.dev/hood",
      ),
      { status: 503, headers: corsHeaders() },
    );
  }

  const rows: ACPRow[] = snap.tickers.map((r: TickerSnapshot) => ({
    ticker: r.ticker,
    name: r.name,
    contract: r.contract,
    verdict: r.verdict,
    oracle_usd: r.oracle_usd,
    dex_usd: r.dex_usd,
    drift_pct: r.drift_pct,
    // `tvl_usd` = deprecated alias for primary. Populated verbatim to
    // avoid breaking existing ACP consumers. New fields spell out the
    // semantics unambiguously so downstream agents don't guess.
    tvl_usd: r.tvl_usd,
    primary_pool_tvl_usd: r.tvl_usd,
    total_tvl_usd: r.total_tvl_usd,
    volume_24h_usd: r.volume_24h_usd,
    pool_ref: r.pool_ref,
    market_session: r.market.session,
  }));

  // Data freshness — surface staleness explicitly so downstream ACP
  // consumers don't have to derive it. If the poll cron has died the
  // envelope now says `is_stale: true` + a specific age, matching the
  // /hood UI header banner. Threshold matches the UI: 15 min.
  const ageMs = Date.now() - new Date(snap.finished_at).getTime();
  const data_age_seconds = Math.max(0, Math.round(ageMs / 1000));
  const is_stale = data_age_seconds > 15 * 60;

  return Response.json(
    acpEnvelope(
      {
        as_of: snap.finished_at,
        data_age_seconds,
        is_stale,
        market: {
          is_open: snap.metrics.market_is_open,
          session: snap.metrics.market_session,
        },
        tokens: {
          registry_total: snap.metrics.registry_total,
          watched: snap.metrics.tokens_watched,
          no_chainlink_feed: snap.metrics.tokens_no_feed,
          errored: snap.metrics.tokens_errored,
        },
        tvl_scanned_usd: snap.metrics.tvl_scanned_usd,
        rows,
      },
      "https://blueagent.dev/hood",
    ),
    {
      status: 200,
      headers: {
        ...corsHeaders(),
        // If stale, don't let CDNs pin it for 60s — force short cache
        // so a recovered poll cycle propagates fast.
        "Cache-Control": is_stale ? "public, max-age=15, s-maxage=15" : "public, max-age=60, s-maxage=60",
      },
    },
  );
}
