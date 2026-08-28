"use client";

/**
 * /hood client — live drift board + arrows feed + contextual sidebar.
 *
 * Layout mirrors Blue Chat + Blue Hub: three columns on lg+ screens
 *   [ 72px AppShell rail ][ 288px HoodSidebar ][ flex-1 main content ]
 * Below lg the sidebar hides (AppShell's mobile drawer already exposes
 * the primary product nav; per-page context is one tap away via the
 * hamburger, mirroring Chat's mobile pattern).
 *
 * Design tokens follow AppShell:
 *   • bg #050508  · surface #0B0D13 · border #1A1A2E
 *   • font-mono for every number
 *   • section headers `// HOOD · <SECTION>` in slate-500 tracking-widest
 *   • Blue Hood green #34D399 (emerald) is THIS page's interactive accent
 *     (spec: "this section's own accent"); blue #4FC3F7 shows only in the
 *     footer "powered by 30 Blue Hub skills" attribution.
 *   • Base brand blue #0052FF is used NARROWLY for the venue (chain) axis
 *     only — the per-row chain chip + the Base pill in the chain selector —
 *     so emerald stays the primary accent while Base rows read at a glance.
 *
 * Two data fetches, both `no-store`:
 *   • /api/hood/snapshot — poller's latest snapshot
 *   • /api/hood/arrows   — fired arrows + graded hit-rate (test arrows
 *                          are filtered server-side; the UI can trust
 *                          whatever comes back is the public record)
 * Both refresh every 15s; a single AbortController handles unmount.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useAccount } from "wagmi";
import { usePolling } from "@/hooks/usePolling";
import type { HoodSnapshot, TickerSnapshot, M5Verdict, Arrow, HoodChain } from "@/lib/blue-hood/types";
import { chainOf, rowKey, ARB_MIN_ABS_PCT, DRIFT_MIN_ABS_PCT } from "@/lib/blue-hood/types";
import HoodSidebar from "./HoodSidebar";
import TickerDetailPanel from "./TickerDetailPanel";
import ArrowBriefBlock from "./ArrowBriefBlock";
import ReviewSignPanel from "@/components/blue-hood/ReviewSignPanel";
import PositionsStrip, { usePositions, positionsHeldMap } from "@/components/blue-hood/PositionsStrip";
import EnableAlertsButton from "./inbox/EnableAlertsButton";
import { HealthProvider, HealthBanner } from "./HealthProvider";
import { WatchlistProvider, useWatchlist } from "./WatchlistProvider";
import { WATCHLIST_LIMITS } from "@/lib/blue-hood/watchlist-config";

const REFRESH_MS = 15_000;
const RH_GREEN = "#34D399";
const BLUE = "#4FC3F7";
const AMBER = "#f5b342";
const RED = "#ef4444";
const GREEN_TEXT = "#22c55e";
const BG = "#050508";
const SURFACE = "#0B0D13";
const BORDER = "#1A1A2E";
const MUTED = "#6b7280";
// Base P (Surface Base UI) — venue accents. Base brand blue drives the chain
// selector's active Base pill; a lightened variant keeps the 9px per-row chip
// legible on the near-black table surface.
const BASE_BLUE = "#0052FF";
const BASE_BLUE_TEXT = "#5b8cff";

type SortKey = "drift" | "volume" | "tvl";
type Filter = "tradable" | "drifting" | "flow" | "frozen" | "dust" | "no_data" | "all";
// Orthogonal to `Filter` — a row is e.g. (tradable AND base), so the venue axis
// is its own selector that composes with the status filter. Absent ⟹ robinhood
// (see `chainOf`), so the default "all" and RH rows stay back-compatible.
type ChainFilter = "all" | "base" | "robinhood";

// T2 — dust floor matches the engine's arrow gate. Anything under this is
// treated as untradable at the row level (verdict badged as DUST, drift
// faded, sorted last, hidden from default filter).
//
// Reads TOTAL token liquidity (sum across every pool), matching the
// rule-engine dust gate. Old check on `tvl_usd` (primary pool only)
// would badge NVDA as DUST because its USDG-quoted pool is thin — even
// though the bankr-robinhood WETH pool holds $21M. That was blinding
// the board to the deepest tokens on chain. Fallback to `tvl_usd` for
// rows served from mid-deploy cycles that predate `total_tvl_usd`.
const DUST_TVL_USD = 5_000;

function rowTotalTvlUi(r: TickerSnapshot): number {
  return r.total_tvl_usd ?? r.tvl_usd ?? 0;
}

function isDust(r: TickerSnapshot): boolean {
  return r.verdict !== "ERROR" && r.dex_usd !== null && rowTotalTvlUi(r) < DUST_TVL_USD;
}
function isNoData(r: TickerSnapshot): boolean {
  return r.verdict === "ERROR" || r.verdict === "INSUFFICIENT_DATA" || r.dex_usd === null;
}
function isTradable(r: TickerSnapshot): boolean {
  return !isDust(r) && !isNoData(r);
}
function isFrozenLike(v: TickerSnapshot["verdict"]): boolean {
  return v === "FROZEN_ALIGNED" || v === "PREMARKET_DRIFT" || v === "AFTERHOURS_DRIFT";
}

/** Base P1 — `base_desk` is optional so a client running against an older
 *  deployment (or a cached response) degrades to "unknown" rather than
 *  crashing on a missing field. */
type BaseDeskState = { status: "live" | "stale" | "offline"; count: number };
type SnapshotRes =
  | { ok: true; snapshot: HoodSnapshot; base_desk?: BaseDeskState }
  | { ok: false; error: string };
type PerTypeStat = {
  ready: boolean;
  sample: number;
  hits: number;
  misses: number;
  pct?: number;
  needed: number;
};
type ArrowsRes =
  | {
      ok: true;
      arrows: Arrow[];
      arrows_today: number;
      hit_rate:
        | { ready: true; pct: number; sample: number }
        | { ready: false; sample: number; needed: number };
      per_type?: Partial<Record<"drift" | "arb" | "flow" | "whale", PerTypeStat>>;
      test_arrows_hidden: number;
    }
  | { ok: false; error: string };

export default function HoodClient() {
  const [snap, setSnap] = useState<HoodSnapshot | null>(null);
  /** Base P1 — desk state from /api/hood/snapshot. `null` = the field wasn't
   *  in the response (older deploy / never fetched), which is NOT the same as
   *  "offline" and must not be rendered as a failure. */
  const [baseDesk, setBaseDesk] = useState<BaseDeskState | null>(null);
  const [arrowsData, setArrowsData] = useState<Extract<ArrowsRes, { ok: true }> | null>(null);
  // P2.4 (2026-07-24): positions read at the top-level so BOTH the
  // PositionsStrip and the drift-board rows can see the "held" set.
  const { positions: userPositions } = usePositions(snap?.tickers ?? []);
  const heldTickers = useMemo(() => positionsHeldMap(userPositions), [userPositions]);
  const [lastFetch, setLastFetch] = useState<number>(0);
  // Inbox last-read bookmark — mirrored from /hood/inbox so we can badge
  // the "Inbox" nav link with an unread count. Same source, same math.
  const [inboxLastRead, setInboxLastRead] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>("drift");
  // T2 — default filter hides dust so the top of the board is tradable
  // rows, not COIN +132% on a $1k pool.
  const [filter, setFilter] = useState<Filter>("tradable");
  // Base P — venue axis. Defaults to "all" so the board shows both desks
  // (Coinbase B20 on Base + Robinhood Chain) until the reader narrows it.
  const [chainFilter, setChainFilter] = useState<ChainFilter>("all");
  const rowRefs = useRef<Record<string, HTMLTableRowElement | null>>({});

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const [s, a, lr] = await Promise.all([
        // Both public and now `s-maxage`-cached; `no-store` is gone on purpose
        // so the shared edge cache is actually consulted. See useHoodShellData.
        fetch("/api/hood/snapshot", { signal }).then((r) => r.json() as Promise<SnapshotRes>),
        fetch("/api/hood/arrows", { signal }).then((r) => r.json() as Promise<ArrowsRes>),
        // Inbox unread count needs the read bookmark. Cheap GET, one KV
        // read; noop if the endpoint errors (nav still works, just no
        // badge). Never throws upward.
        (async (): Promise<{ ok: true; last_read_at: string | null } | { ok: false }> => {
          try {
            const r = await fetch("/api/hood/inbox/last-read", { cache: "no-store", signal });
            if (!r.ok) return { ok: false };
            return await r.json() as { ok: true; last_read_at: string | null };
          } catch {
            return { ok: false };
          }
        })(),
      ]);
      // Snapshot: on success, swap it in. On failure we deliberately do NOT
      // clear the last-good snapshot or set an inline error — the honest,
      // cause-specific narrative (kv_error vs never_polled vs cron_stalled)
      // is owned entirely by <HealthBanner>, which reads /api/hood/health.
      if (s.ok) {
        setSnap(s.snapshot);
        setBaseDesk(s.base_desk ?? null);
      }
      if (a.ok) setArrowsData(a);
      if (lr.ok) setInboxLastRead(lr.last_read_at);
      setLastFetch(Date.now());
    } catch {
      // Swallow — a failed board fetch is surfaced by HealthBanner, not here.
    }
  }, []);

  // Unread = arrows fired after the read bookmark. If no bookmark yet
  // (fresh user), everything is unread — matches /hood/inbox behaviour.
  const inboxUnread = useMemo(() => {
    const arrows = arrowsData?.arrows ?? [];
    const cutoff = inboxLastRead ? new Date(inboxLastRead).getTime() : 0;
    return arrows.filter((a) => new Date(a.fired_at).getTime() > cutoff).length;
  }, [arrowsData, inboxLastRead]);

  // #148 ③ — same loop as before, but paused while the tab is hidden.
  usePolling(load, REFRESH_MS);

  // Base P — venue counts come from the FULL snapshot (never chain-scoped) so
  // the chain selector always shows how many rows each desk has, even when a
  // venue is currently the active filter.
  const chainCounts = useMemo(() => {
    const t = snap?.tickers ?? [];
    return {
      all: t.length,
      base: t.filter((r) => chainOf(r) === "base").length,
      robinhood: t.filter((r) => chainOf(r) === "robinhood").length,
    };
  }, [snap]);

  // T2 + T3 — categorize once so filter pill counts + row grouping stay in sync.
  // Base P — the status buckets are computed over the CHAIN-SCOPED rows, so
  // picking "Base" makes every downstream count (tradable/dust/no-data) and
  // pill reflect just that desk.
  const buckets = useMemo(() => {
    if (!snap) return { tradable: [], dust: [], no_data: [] } as Record<"tradable" | "dust" | "no_data", TickerSnapshot[]>;
    const inChain = chainFilter === "all" ? snap.tickers : snap.tickers.filter((r) => chainOf(r) === chainFilter);
    const tradable: TickerSnapshot[] = [];
    const dust: TickerSnapshot[] = [];
    const no_data: TickerSnapshot[] = [];
    for (const r of inChain) {
      if (isNoData(r)) no_data.push(r);
      else if (isDust(r)) dust.push(r);
      else tradable.push(r);
    }
    return { tradable, dust, no_data };
  }, [snap, chainFilter]);

  const filtered = useMemo<TickerSnapshot[]>(() => {
    let list: TickerSnapshot[];
    switch (filter) {
      case "tradable": list = buckets.tradable; break;
      case "dust":     list = buckets.dust; break;
      case "no_data":  list = buckets.no_data; break;
      case "drifting": list = buckets.tradable.filter((r) => Math.abs(r.drift_pct ?? 0) >= 1); break;
      case "flow":     list = buckets.tradable.filter((r) => (r.volume_24h_usd ?? 0) >= 5_000); break;
      case "frozen":   list = buckets.tradable.filter((r) => isFrozenLike(r.verdict)); break;
      case "all":      list = [...buckets.tradable, ...buckets.dust, ...buckets.no_data]; break;
    }
    return [...list].sort((a, b) => {
      if (sort === "drift") return Math.abs(b.drift_pct ?? 0) - Math.abs(a.drift_pct ?? 0);
      if (sort === "volume") return (b.volume_24h_usd ?? 0) - (a.volume_24h_usd ?? 0);
      // TVL sort — rank by TOTAL depth (matches dust gate + the honest
      // "which token has the deepest liquidity on chain" answer).
      return rowTotalTvlUi(b) - rowTotalTvlUi(a);
    });
  }, [buckets, sort, filter]);

  const marketBadge = useMemo(() => {
    if (!snap) return { label: "…", color: MUTED };
    const { market_is_open, market_session } = snap.metrics;
    if (market_is_open) return { label: "NYSE OPEN", color: GREEN_TEXT };
    if (market_session === "premarket") return { label: "PREMARKET", color: AMBER };
    if (market_session === "afterhours") return { label: "AFTER HOURS", color: AMBER };
    if (market_session === "weekend") return { label: "WEEKEND · CLOSED", color: MUTED };
    if (market_session === "holiday") return { label: "HOLIDAY · CLOSED", color: MUTED };
    return { label: "MARKET CLOSED", color: MUTED };
  }, [snap]);

  const scrollToTicker = useCallback((ticker: string) => {
    // If the current filter is hiding the ticker, drop back to "all" first
    // so the row is actually in the DOM to scroll to. Same for the venue
    // axis — a Base-only view would hide an RH target (and vice versa).
    if (filter !== "all") setFilter("all");
    if (chainFilter !== "all") setChainFilter("all");
    // rAF because setFilter's re-render hasn't landed yet on same tick.
    requestAnimationFrame(() => {
      const el = rowRefs.current[ticker];
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, [filter, chainFilter]);

  return (
    <HealthProvider>
    <WatchlistProvider>
    <div className="h-full flex flex-row" style={{ backgroundColor: BG }}>
      <HoodSidebar
        snap={snap}
        arrows={arrowsData?.arrows ?? null}
        marketLabel={marketBadge.label}
        marketColor={marketBadge.color}
        onSelectTicker={scrollToTicker}
        inboxUnread={inboxUnread}
      />

      <div className="flex-1 min-w-0 overflow-y-auto hood-scroll">
        {/* Full-width main — no max-w cap (matches Virtuals reference:
            drift board's 8-col table wants the full viewport width).
            Generous padding on lg+ so it doesn't feel edge-to-edge on
            ultra-wide monitors. Same shape used by /hood/inbox and
            /hood/arrows via HoodShellFrame. */}
        <div className="w-full px-4 py-6 md:px-8 md:py-8 xl:px-12">
          <Header snap={snap} lastFetch={lastFetch} marketBadge={marketBadge} inboxUnread={inboxUnread} />
          {/* Cause-specific engine banner (task 1.3). Replaces the old blind
              StaleBanner + "Poller warming up" line: it distinguishes KV-blind
              from cron-dead from cold-start from cycle-failing, so the board
              never again reports a monitoring blackout as "the poller". */}
          <HealthBanner />

          <MetricStrip snap={snap} arrows={arrowsData} />

          {/* P2.4 YOUR POSITIONS strip (v3, 2026-07-24). Mounts only when
              the user is connected + holds anything; renders nothing for
              guests. Balances live-read via wagmi multicall against RH
              Chain, prices from the snapshot the drift board already has.
              [Sell] scrolls to the ticker row where the existing per-row
              trade flow (with the P0 allowance-race guards) can run. */}
          <PositionsStrip
            tickers={snap?.tickers ?? []}
            tickersWithOpenArrow={useMemo(() => {
              // Base P1 — RH arrows ONLY. This set gates the [Sell] button on
              // a REAL RH holding; a Base NVDA arrow reaching it would enable
              // Sell on the RH NVDA position and hand ReviewSignPanel an arrow
              // from the wrong chain. Bare ticker can't tell them apart, so
              // filter on `chainOf` at the source.
              const s = new Set<string>();
              for (const a of arrowsData?.arrows ?? []) {
                if (a.status === "open" && chainOf(a) === "robinhood") s.add(a.ticker);
              }
              return s;
            }, [arrowsData?.arrows])}
            onOpenTrade={(ticker) => {
              const row = rowRefs.current[ticker];
              if (!row) return;
              row.scrollIntoView({ behavior: "smooth", block: "center" });
              // Flash the row briefly so the user's eye lands on it.
              row.classList.add("hood-row-flash");
              setTimeout(() => row.classList.remove("hood-row-flash"), 1600);
            }}
          />

          <SectionHeader label="// HOOD · DRIFT BOARD" />

          <div className="mb-4 flex flex-wrap items-center gap-2">
            <FilterPills value={filter} onChange={setFilter} buckets={buckets} />
            <ChainToggle value={chainFilter} onChange={setChainFilter} counts={chainCounts} />
            <div className="ml-auto flex items-center gap-2 text-[10px] uppercase tracking-widest" style={{ color: MUTED }}>
              <span>sort</span>
              <SortToggle value={sort} onChange={setSort} />
            </div>
          </div>

          <BaseDeskNote desk={baseDesk} marketOpen={snap?.metrics.market_is_open ?? false} />

          <DriftBoard rows={filtered} rowRefs={rowRefs} arrows={arrowsData?.arrows ?? null} heldTickers={heldTickers} />

          <div className="h-10" />
          <div className="mb-3 flex items-center justify-between">
            <div className="font-mono text-[10px] uppercase tracking-widest" style={{ color: MUTED }}>
              // HOOD · ARROWS FEED
            </div>
            <Link
              href="/hood/arrows"
              className="font-mono text-[11px] hover:text-white"
              style={{ color: RH_GREEN }}
            >
              Track record →
            </Link>
          </div>
          <ArrowsFeed data={arrowsData} />

          <Footer />
        </div>
      </div>
    </div>
    </WatchlistProvider>
    </HealthProvider>
  );
}

// ── Header ─────────────────────────────────────────────────────────────────
// "updated Xs ago" now sources from `snap.finished_at` (the moment the
// poll cycle wrote the snapshot), NOT `Date.now() - lastFetch`. The old
// logic showed "updated 0s ago" over 2-day-old data because it measured
// browser fetch latency, not data age. With the fix a stale snapshot
// (e.g. cron black-hole from vercel.json in the wrong monorepo location)
// surfaces immediately in the header + banner. `lastFetch` prop is kept
// for compat with any future "refresh in-flight" indicator. (The amber
// staleness threshold now lives server-side in health.ts / LAGGING_MAX_AGE_S,
// consumed by <HealthBanner> — the header only formats the age it's given.)

function Header({
  snap,
  marketBadge,
  inboxUnread,
}: {
  snap: HoodSnapshot | null;
  lastFetch: number;
  marketBadge: { label: string; color: string };
  inboxUnread: number;
}) {
  const dataAgeS = snap ? Math.max(0, Math.round((Date.now() - new Date(snap.finished_at).getTime()) / 1000)) : null;

  return (
    <header className="mb-8 flex flex-wrap items-baseline gap-x-4 gap-y-2">
      {/* T-V1 — wordmark. ONE wordmark shape used everywhere (sidebar,
          header, meta title): BLUE (white) + HOOD (RH_GREEN), all-caps,
          mono 700, tight tracking. `text-[24px]` for the 24px page-title
          slot; sidebar keeps 12px, they read as the same word.  */}
      <div className="flex items-baseline gap-3">
        <div className="text-[24px] font-bold tracking-tight text-white">
          BLUE<span style={{ color: RH_GREEN }}>HOOD</span>
        </div>
        <div className="text-[12px]" style={{ color: "#9aa1ac", letterSpacing: "0.02em" }}>
          oracle-vs-DEX drift, graded in public
        </div>
      </div>
      {/* Nav: DRIFT (current) · INBOX (n unread) · TRACK RECORD + push
          alerts. Mirrors the InboxClient + TrackRecordClient headers so
          the three views have symmetric nav — before this, /hood had no
          link to /hood/inbox, so a user who fires an arrow had no path
          to Review & Sign except by typing the URL. Real bug 2026-07-23. */}
      <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px]">
        <Link
          href="/hood/inbox"
          className="hover:text-white"
          style={{ color: inboxUnread > 0 ? RH_GREEN : MUTED }}
        >
          Inbox{inboxUnread > 0 ? ` (${inboxUnread})` : ""} →
        </Link>
        <Link href="/hood/arrows" className="hover:text-white" style={{ color: MUTED }}>
          Track record →
        </Link>
        <EnableAlertsButton />
        <TelegramLinkButton />
        <span style={{ color: marketBadge.color }}>● {marketBadge.label}</span>
        <span className="flex items-center gap-1.5" style={{ color: MUTED }}>
          {/* T-V2 #1 — LIVE PULSE. Gentle dot signals the page is alive.
              (Semantics unchanged; the number next to it now reflects
              REAL snapshot age, not fetch latency.) */}
          <span className="hood-live-dot" aria-hidden />
          {dataAgeS === null || !snap ? "…" : `updated ${formatAgeShort(dataAgeS)} ago`}
        </span>
      </div>
    </header>
  );
}

// NOTE: the old snapshot-age `StaleBanner` (and its STALE_THRESHOLD_S) lived
// here. Both were replaced by <HealthBanner> (see ./HealthProvider), which
// supersedes them: staleness is now just one of five discriminated states, and
// the banner also names KV-blind, cron-dead, cold-start and cycle-failing —
// causes the age-only banner could never tell apart.

// ── Telegram-link button (2.2b · B1) ─────────────────────────────────────────
// "Get alerts on Telegram" — rendered ONLY when a wallet is connected. One tap:
// POST the connected address to /api/hood/tglink, get back a server-built
// t.me/<bot>?start=link_<code> DEEP LINK, and open it. The user taps Start in
// Telegram and the bot links the wallet — NO code to copy, NO code to type, NO
// wallet to paste. We NEVER render the bare code; `link:null` (bot username env
// unset) surfaces as "unavailable", not a leaked code.
//
// Popup-blocker–safe: a browser only honours window.open() inside the click
// gesture, but the deep link isn't known until the fetch resolves. So we open a
// blank tab synchronously and redirect it once the link is back; if the pre-open
// was blocked (popup === null) we fall back to a same-tab navigation.
function TelegramLinkButton() {
  const { address, isConnected } = useAccount();
  const [state, setState] = useState<"idle" | "busy" | "opened" | "error">("idle");

  if (!isConnected || !address) return null;

  async function onClick() {
    if (state === "busy") return;
    setState("busy");
    const popup = typeof window !== "undefined" ? window.open("", "_blank") : null;
    try {
      const res = await fetch("/api/hood/tglink", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address }),
      });
      const body = (await res.json()) as { ok?: boolean; link?: string | null };
      const link = body?.ok ? body.link ?? null : null;
      if (!link) {
        // No deep link (bot username unset, or a mint error). Never show a code.
        if (popup) popup.close();
        setState("error");
        return;
      }
      if (popup) popup.location.href = link;
      else window.location.href = link; // popup blocked → same-tab fallback
      setState("opened");
    } catch {
      if (popup) popup.close();
      setState("error");
    }
  }

  const label =
    state === "busy" ? "opening…"
      : state === "opened" ? "check Telegram →"
        : state === "error" ? "unavailable"
          : "Get alerts on Telegram →";

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={state === "busy"}
      className="hover:text-white disabled:opacity-60"
      style={{ color: state === "error" ? MUTED : RH_GREEN }}
      title="Link your wallet to the Telegram bot — one tap, no code to type"
    >
      {label}
    </button>
  );
}

// ── Metric strip ───────────────────────────────────────────────────────────
function MetricStrip({
  snap,
  arrows,
}: {
  snap: HoodSnapshot | null;
  arrows: Extract<ArrowsRes, { ok: true }> | null;
}) {
  // P3.2 — aggregate headline unchanged (30-sample gate now enforced in
  // /lib/blue-hood/hit-rate-gate). Sub-line prefers per-type readout when
  // arb OR drift has cleared its own 15-sample bar; that's the honest
  // number a reader can act on. Falls back to the aggregate "N graded · 7d"
  // otherwise.
  const hitLabel = arrows
    ? arrows.hit_rate.ready ? `${arrows.hit_rate.pct}%` : "n/a"
    : "…";
  const perTypeSub = (() => {
    const p = arrows?.per_type;
    if (!p) return null;
    const parts: string[] = [];
    if (p.arb?.ready && typeof p.arb.pct === "number")     parts.push(`arb ${p.arb.pct}% · ${p.arb.sample}`);
    else if (p.arb)                                        parts.push(`arb warm ${p.arb.sample}/${p.arb.needed}`);
    if (p.drift?.ready && typeof p.drift.pct === "number") parts.push(`drift ${p.drift.pct}% · ${p.drift.sample}`);
    else if (p.drift)                                      parts.push(`drift warm ${p.drift.sample}/${p.drift.needed}`);
    return parts.length ? parts.join(" · ") : null;
  })();
  const hitSub = arrows
    ? perTypeSub
      ?? (arrows.hit_rate.ready
        ? `${arrows.hit_rate.sample} graded · 7d`
        : `warming up · ${arrows.hit_rate.sample}/${arrows.hit_rate.needed}`)
    : undefined;

  // BLOCKER 2 — honest denominator, and it is deliberately NOT registry_total.
  // The poller can only ever watch a row that has a Chainlink feed, so
  // `tokens_eligible` is what coverage should be read against; printing
  // "24/96" would imply 72 misses when 61 of those have no oracle to miss.
  // The sub-label closes the gap so the arithmetic is checkable by eye:
  //   watched + not_enabled = eligible, and eligible + no_feed = registry_total.
  // (`tokens_eligible` is absent on snapshots written before the registry
  //  sweep — fall back rather than render "undefined".)
  const watchedValue = snap
    ? `${snap.metrics.tokens_watched - snap.metrics.tokens_errored}/${snap.metrics.tokens_eligible ?? snap.metrics.registry_total}`
    : "…";
  const watchedSub = snap
    ? [
        snap.metrics.tokens_errored > 0 ? `${snap.metrics.tokens_errored} errored` : null,
        snap.metrics.tokens_not_enabled ? `${snap.metrics.tokens_not_enabled} not enabled` : null,
        snap.metrics.tokens_no_feed > 0 ? `${snap.metrics.tokens_no_feed} no feed` : null,
      ]
        .filter(Boolean)
        .join(" · ") || "chainlink-backed"
    : undefined;

  const items: { label: string; value: string; sub?: string }[] = [
    { label: "ARROWS TODAY", value: arrows ? String(arrows.arrows_today) : "…", sub: "fired in last 24h" },
    { label: "HIT RATE 7D", value: hitLabel, sub: hitSub },
    { label: "TOKENS WATCHED", value: watchedValue, sub: watchedSub },
    { label: "TVL SCANNED", value: snap ? formatUsd(snap.metrics.tvl_scanned_usd) : "…", sub: "all pools, sum" },
  ];

  return (
    <div className="mb-8 grid grid-cols-2 gap-3 md:grid-cols-4">
      {items.map((it) => (
        <div
          key={it.label}
          className="rounded border px-4 py-3"
          style={{ borderColor: BORDER, backgroundColor: SURFACE }}
        >
          {/* T-V1 sizes — label 11px caps, number 20px, sub 11px — all
              mono. Sublabel was falling through to app-shell sans; now
              explicit `font-mono` so the metric card reads as ONE voice. */}
          <div className="mb-1 text-[11px] uppercase" style={{ color: MUTED, letterSpacing: "0.08em" }}>
            {it.label}
          </div>
          <div className="text-[20px] font-medium text-white tabular-nums">{it.value}</div>
          {it.sub && (
            <div className="mt-1 text-[11px] tabular-nums" style={{ color: MUTED }}>{it.sub}</div>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Filter + sort ──────────────────────────────────────────────────────────
function FilterPills({
  value,
  onChange,
  buckets,
}: {
  value: Filter;
  onChange: (v: Filter) => void;
  buckets: Record<"tradable" | "dust" | "no_data", TickerSnapshot[]>;
}) {
  // T5 — every pill shows its bucket count. Empty buckets get grayed but
  // stay clickable so the presence of a category is always visible.
  const driftingN = buckets.tradable.filter((r) => Math.abs(r.drift_pct ?? 0) >= 1).length;
  const flowN = buckets.tradable.filter((r) => (r.volume_24h_usd ?? 0) >= 5_000).length;
  const frozenN = buckets.tradable.filter((r) => isFrozenLike(r.verdict)).length;

  const opts: { key: Filter; label: string; count: number }[] = [
    { key: "tradable", label: "Tradable", count: buckets.tradable.length },
    { key: "drifting", label: "Drifting", count: driftingN },
    { key: "flow",     label: "Flow",     count: flowN },
    { key: "frozen",   label: "Frozen",   count: frozenN },
    { key: "dust",     label: "Dust",     count: buckets.dust.length },
    { key: "no_data",  label: "No data",  count: buckets.no_data.length },
  ];
  return (
    <div className="flex flex-wrap gap-1">
      {opts.map((o) => {
        const active = o.key === value;
        const empty = o.count === 0;
        return (
          <button
            key={o.key}
            onClick={() => onChange(o.key)}
            disabled={empty && !active}
            className="rounded-full border px-3 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed"
            style={{
              borderColor: active ? RH_GREEN : BORDER,
              backgroundColor: active ? "rgba(0,200,5,0.10)" : "transparent",
              color: active ? RH_GREEN : empty ? "#3f4550" : "#9aa1ac",
              opacity: empty && !active ? 0.55 : 1,
            }}
          >
            <span>{o.label}</span>
            <span className="ml-1 font-mono tabular-nums" style={{ opacity: 0.65 }}>({o.count})</span>
          </button>
        );
      })}
    </div>
  );
}

// Base P — venue selector. Orthogonal to the status FilterPills (a row is e.g.
// tradable AND base), so it's a separate control that composes with the filter.
// Active Base wears Base brand blue, active RH the page emerald, "All chains"
// neutral. Counts come from the FULL snapshot so the reader always sees how many
// rows each desk carries; an empty venue grays out (matching FilterPills) rather
// than vanishing — the desk still exists, it's just quiet this cycle.
function ChainToggle({
  value,
  onChange,
  counts,
}: {
  value: ChainFilter;
  onChange: (v: ChainFilter) => void;
  counts: { all: number; base: number; robinhood: number };
}) {
  const opts: { key: ChainFilter; label: string; count: number; accent: string }[] = [
    { key: "all", label: "All chains", count: counts.all, accent: "#E7E9EE" },
    { key: "base", label: "Base", count: counts.base, accent: BASE_BLUE },
    { key: "robinhood", label: "RH", count: counts.robinhood, accent: RH_GREEN },
  ];
  return (
    <div className="flex items-center gap-1">
      <span className="mr-1 font-mono text-[10px] uppercase tracking-widest" style={{ color: MUTED }}>chain</span>
      {opts.map((o) => {
        const active = o.key === value;
        const empty = o.count === 0;
        return (
          <button
            key={o.key}
            onClick={() => onChange(o.key)}
            disabled={empty && !active}
            className="rounded-full border px-3 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed"
            style={{
              borderColor: active ? o.accent : BORDER,
              backgroundColor: active ? `${o.accent}1A` : "transparent",
              color: active ? o.accent : empty ? "#3f4550" : "#9aa1ac",
              opacity: empty && !active ? 0.55 : 1,
            }}
          >
            <span>{o.label}</span>
            <span className="ml-1 font-mono tabular-nums" style={{ opacity: 0.65 }}>({o.count})</span>
          </button>
        );
      })}
    </div>
  );
}

// Base P1 — the Base desk explains itself when it is quiet.
//
// WHY THIS EXISTS: `ChainToggle` renders the Base pill `disabled` and dimmed at
// "(0)" with no explanation. A desk that is merely below threshold then looks
// exactly like a desk that is broken — the #308 rule ("show Base even at 0
// arrows") is about precisely this failure mode: silence must not read as an
// error. So a quiet Base desk states its own count and the threshold it is
// waiting on, and a Base desk that is actually degraded says THAT instead.
//
// Thresholds are imported from `@/lib/blue-hood/types`, never typed as literal
// copy — the printed number and the fired number are the same constant. Which
// one applies swaps with the session (2% closed → 1% open), so the note reads
// `marketOpen` rather than assuming the closed-market case.
//
// `desk == null` means the snapshot response carried no `base_desk` field at
// all — an older deployment, or the very first render before the fetch lands.
// That is NOT a failure, so it renders nothing rather than claiming "offline".
function BaseDeskNote({
  desk,
  marketOpen,
}: {
  desk: { status: "live" | "stale" | "offline"; count: number } | null;
  marketOpen: boolean;
}) {
  if (!desk) return null;

  const threshold = marketOpen ? ARB_MIN_ABS_PCT : DRIFT_MIN_ABS_PCT;
  const kind = marketOpen ? "arb" : "drift";

  let body: React.ReactNode;
  let accent = BASE_BLUE_TEXT;
  if (desk.status === "live") {
    body = (
      <>
        Watching <span className="font-mono tabular-nums">{desk.count}</span> Base B20 stock
        {desk.count === 1 ? "" : "s"} — {kind} arrows fire past{" "}
        <span className="font-mono tabular-nums">±{threshold.toFixed(1)}%</span>
        {marketOpen ? " while the market is open" : " while the market is closed"}.
      </>
    );
  } else if (desk.status === "stale") {
    accent = AMBER;
    body = (
      <>
        Base desk rows are older than the freshness window, so they are withheld rather than shown
        as live. Robinhood rows below are unaffected.
      </>
    );
  } else {
    accent = MUTED;
    body = (
      <>
        Base desk returned no rows this cycle. Robinhood rows below are unaffected.
      </>
    );
  }

  return (
    <div
      className="mb-3 rounded border px-3 py-2 text-[11px] leading-relaxed"
      style={{ borderColor: BORDER, backgroundColor: SURFACE, color: "#9aa1ac" }}
    >
      <span className="mr-2 font-mono text-[10px] uppercase tracking-widest" style={{ color: accent }}>
        base desk
      </span>
      {body}
    </div>
  );
}

function SortToggle({ value, onChange }: { value: SortKey; onChange: (v: SortKey) => void }) {
  const opts: { key: SortKey; label: string }[] = [
    { key: "drift", label: "Drift" },
    { key: "volume", label: "Volume" },
    { key: "tvl", label: "TVL" },
  ];
  return (
    <div className="flex gap-1">
      {opts.map((o) => {
        const active = o.key === value;
        return (
          <button
            key={o.key}
            onClick={() => onChange(o.key)}
            className="rounded border px-2 py-1 text-[11px] font-medium transition-colors"
            style={{ borderColor: active ? "#3f4550" : BORDER, color: active ? "#E7E9EE" : MUTED }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// ── Drift board ────────────────────────────────────────────────────────────
function DriftBoard({
  rows,
  rowRefs,
  arrows,
  heldTickers,
}: {
  rows: TickerSnapshot[];
  rowRefs: React.MutableRefObject<Record<string, HTMLTableRowElement | null>>;
  arrows: Arrow[] | null;
  heldTickers: Set<string>;
}) {
  // T-B2 — accordion: at most one row expanded at a time.
  const [expanded, setExpanded] = useState<string | null>(null);
  const toggle = useCallback((ticker: string) => {
    setExpanded((cur) => (cur === ticker ? null : ticker));
  }, []);

  if (rows.length === 0) {
    return (
      <div
        className="rounded border border-dashed py-12 text-center text-sm"
        style={{ borderColor: BORDER, color: MUTED }}
      >
        No rows match this filter yet.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded border" style={{ borderColor: BORDER, backgroundColor: SURFACE }}>
      <table className="w-full text-sm">
        <thead className="font-mono text-[9px] uppercase tracking-widest" style={{ color: MUTED }}>
          <tr className="border-b" style={{ borderColor: BORDER }}>
            {/* T-V4 — column widths explicit so 24H sparkline gets a
                proper 200px cell (was cramped in a 100px auto slot),
                and every numeric column is right-aligned consistently.
                User feedback 2026-07-23: "24h chart could be wider,
                inconsistent left/right alignment across columns" */}
            <th className="px-3 py-2 text-left w-[132px]">Ticker</th>
            <th className="px-3 py-2 text-right w-[120px]">Oracle</th>
            <th className="px-3 py-2 text-right w-[120px]">DEX</th>
            <th className="px-3 py-2 text-right w-[96px]">Drift</th>
            <th className="px-3 py-2 text-left w-[220px]">24h</th>
            <th className="px-3 py-2 text-right w-[140px]">TVL</th>
            <th className="px-3 py-2 text-right w-[120px]">Vol 24h</th>
            <th className="px-3 py-2 text-right w-[120px]">Verdict</th>
          </tr>
        </thead>
        <tbody className="font-mono text-[13px]">
          {rows.map((r) => {
            // Base P1 — the open-arrow lookup MUST match on chain too. Arrows
            // carry `chain` (absent ⟹ robinhood, see chainOf), and a bare
            // ticker match would hang the Base NVDA arrow off the RH NVDA row
            // and vice versa: two real, independent signals shown as one.
            const openArrow =
              arrows?.find(
                (a) => a.ticker === r.ticker && chainOf(a) === chainOf(r) && a.status === "open",
              ) ?? null;
            // Base P1 — identity is (chain, ticker), not ticker. RH rows keep
            // the bare-ticker key byte-for-byte, so their React key, ref, and
            // accordion state are unchanged. See `rowKey`.
            const k = rowKey(r);
            return (
              <DriftRow
                key={k}
                r={r}
                rowKeyStr={k}
                rowRefs={rowRefs}
                expanded={expanded === k}
                onToggle={() => toggle(k)}
                openArrow={openArrow}
                // Base P1 — `heldTickers` comes from PositionsStrip, whose
                // balances are read at RH_CHAIN_ID. Holding RH NVDA does not
                // mean holding Base NVDA, so the held marker is RH-only.
                isHeld={chainOf(r) === "robinhood" && heldTickers.has(r.ticker)}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// T-B1 — sparkline SVG. 1-stroke polyline, no axis, colored by current
// drift sign. Faded horizontal rule = current oracle price. Hidden
// entirely when < 6 candles (never draw a stub line).
function Sparkline({
  points,
  oracle,
  driftPct,
}: {
  points: number[] | null;
  oracle: number | null;
  driftPct: number | null;
}) {
  if (!points || points.length < 6) return <span style={{ color: "#334155" }}>—</span>;

  // T-V4 — widened sparkline SVG (was 60×20, now 200×32) so the 24h
  // shape is actually readable. Matches Virtuals reference where the
  // sparkline is a real visual, not a dot.
  const w = 200;
  const h = 32;
  const pad = 1;
  const min = Math.min(...points, oracle ?? points[0]);
  const max = Math.max(...points, oracle ?? points[0]);
  const range = max - min || 1;
  const yFor = (v: number) => pad + (1 - (v - min) / range) * (h - pad * 2);
  const step = (w - pad * 2) / (points.length - 1);
  const d = points
    .map((v, i) => `${i === 0 ? "M" : "L"}${(pad + i * step).toFixed(2)},${yFor(v).toFixed(2)}`)
    .join(" ");

  const drift = driftPct ?? 0;
  const strokeColor =
    Math.abs(drift) < 0.5 ? "#64748b" : drift > 0 ? GREEN_TEXT : RED;
  const oracleY = oracle !== null && Number.isFinite(oracle) ? yFor(oracle) : null;

  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      {oracleY !== null && (
        <line
          x1={0}
          x2={w}
          y1={oracleY}
          y2={oracleY}
          stroke="#3f4550"
          strokeWidth={0.5}
          strokeDasharray="2 2"
          opacity={0.7}
        />
      )}
      <path d={d} fill="none" stroke={strokeColor} strokeWidth={1.2} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function DriftRow({
  r,
  rowKeyStr,
  rowRefs,
  expanded,
  onToggle,
  openArrow,
  isHeld,
}: {
  r: TickerSnapshot;
  /** Base P1 — `rowKey(r)`: the (chain, ticker) identity this row registers
   *  its DOM ref under. Passed in rather than recomputed so the ref key and
   *  the React key are provably the same string. RH ⟹ the bare ticker, so
   *  every existing `rowRefs.current["NVDA"]` caller keeps resolving. */
  rowKeyStr: string;
  rowRefs: React.MutableRefObject<Record<string, HTMLTableRowElement | null>>;
  expanded: boolean;
  onToggle: () => void;
  openArrow: Arrow | null;
  isHeld: boolean;
}) {
  const drift = r.drift_pct ?? 0;
  const dust = isDust(r);
  const noData = isNoData(r);
  const driftColor = Math.abs(drift) < 0.5 ? "#9aa1ac" : drift > 0 ? GREEN_TEXT : RED;

  // T3 — NO DATA row is a distinct visual state: dim oracle, no DEX, no drift.
  if (noData) {
    return (
      <tr
        ref={(el) => { rowRefs.current[rowKeyStr] = el; }}
        className="border-b last:border-b-0 hover:bg-black/40"
        style={{ borderColor: "#0f1218" }}
      >
        <td className="px-3 py-2 text-left">
          <a
            href={tokenExplorerUrl(r)}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-slate-500 hover:text-slate-300"
          >
            {r.ticker}
          </a>
          <ChainTag chain={chainOf(r)} />
          {isHeld && (
            <span
              className="ml-2 font-mono text-[9px] uppercase tracking-widest"
              style={{ color: RH_GREEN }}
              title="You hold this token"
            >
              · held
            </span>
          )}
        </td>
        <td className="px-3 py-2 text-right text-slate-500">{formatUsd(r.oracle_usd)}</td>
        <td className="px-3 py-2 text-right text-slate-600">—</td>
        <td className="px-3 py-2 text-right text-slate-600">—</td>
        {/* T-B1 — NO POOL DATA gets an em-dash placeholder in the sparkline column. */}
        <td className="px-3 py-2 text-left text-slate-600">—</td>
        <td className="px-3 py-2 text-right text-slate-600">—</td>
        <td className="px-3 py-2 text-right text-slate-600">—</td>
        <td className="px-3 py-2 text-left">
          <span
            className="rounded px-2 py-0.5 font-mono text-[10px] font-semibold tracking-wider"
            style={{ color: "#6b7280", backgroundColor: "#0f1218" }}
            title={r.error ?? (r.no_data_reason === "fetch_failed"
              ? "GT fetch failed (rate-limit / timeout). Retry next cycle."
              : "GT reached, but no valid pool for this token yet.")}
          >
            {r.no_data_reason === "fetch_failed" ? "FETCH FAILED" : "NO POOL"}
          </span>
        </td>
      </tr>
    );
  }

  // T2 — dust row: badge = DUST (gray), drift faded, no LONG/SHORT verdict.
  const rowOpacity = dust ? 0.55 : 1;
  const driftDisplay = dust ? { color: "#4b5563" } : { color: driftColor };
  // T-B1 — sparkline cell content: only shown for tradable rows. Dust
  // rows fall through to the same em-dash placeholder as the header row.
  const sparklineCell = dust ? (
    <span style={{ color: "#334155" }}>—</span>
  ) : (
    <Sparkline points={r.sparkline} oracle={r.oracle_usd} driftPct={r.drift_pct ?? null} />
  );

  const chevron = expanded ? "▾" : "▸";

  return (
    <>
      <tr
        ref={(el) => { rowRefs.current[rowKeyStr] = el; }}
        // T-V2 #2 — `hood-row` gives the terminal-cursor border-left on
        // hover. Layered on top of the existing `hover:bg-black/40` so
        // the surface still darkens at the same time.
        className="hood-row border-b last:border-b-0 hover:bg-black/40 cursor-pointer"
        style={{ borderColor: "#0f1218", opacity: rowOpacity }}
        onClick={onToggle}
      >
        <td className="px-3 py-2 text-left">
          <span style={{ color: MUTED, marginRight: 4 }}>{chevron}</span>
          <a
            href={tokenExplorerUrl(r)}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="font-medium text-white transition-colors"
            onMouseEnter={(e) => (e.currentTarget.style.color = RH_GREEN)}
            onMouseLeave={(e) => (e.currentTarget.style.color = "#ffffff")}
          >
            {r.ticker}
          </a>
          <ChainTag chain={chainOf(r)} />
          {isHeld && (
            <span
              className="ml-2 font-mono text-[9px] uppercase tracking-widest"
              style={{ color: RH_GREEN }}
              title="You hold this token"
            >
              · held
            </span>
          )}
          <WatchToggle ticker={r.ticker} />
        </td>
        <td className="px-3 py-2 text-right text-[#E7E9EE]">
          <FlashCell value={r.oracle_usd} />
        </td>
        <td className="px-3 py-2 text-right">
          {r.pool_ref ? (
            <a
              href={poolUrl(r.pool_ref, chainOf(r))}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="text-[#E7E9EE] hover:underline"
            >
              <FlashCell value={r.dex_usd} />
            </a>
          ) : (
            <span className="text-[#E7E9EE]"><FlashCell value={r.dex_usd} /></span>
          )}
        </td>
        <td className="px-3 py-2 text-right font-mono" style={driftDisplay}>
          {drift > 0 ? "+" : ""}{drift.toFixed(2)}%
        </td>
        <td className="px-3 py-2 text-left align-middle">{sparklineCell}</td>
        <td
          className="px-3 py-2 text-right"
          style={{ color: dust ? AMBER : "#9aa1ac" }}
          title={
            dust
              ? `Total token liquidity across all pools is below $${DUST_TVL_USD.toLocaleString()} — arrows are gated off this row`
              : (r.total_tvl_usd !== null && r.tvl_usd !== null && r.total_tvl_usd !== r.tvl_usd)
                ? `Total across all pools: ${formatUsd(r.total_tvl_usd)} · primary (swap route): ${formatUsd(r.tvl_usd)}`
                : undefined
          }
        >
          <div className="leading-tight">
            <div>{formatUsd(rowTotalTvlUi(r))}</div>
            {r.total_tvl_usd !== null && r.tvl_usd !== null && r.total_tvl_usd !== r.tvl_usd ? (
              <div className="text-[10px] font-mono" style={{ color: MUTED }}>
                {formatUsd(r.tvl_usd)} pri
              </div>
            ) : null}
          </div>
        </td>
        <td className="px-3 py-2 text-right" style={{ color: "#9aa1ac" }}>{formatUsd(r.volume_24h_usd)}</td>
        <td className="px-3 py-2 text-right">
          {/* T-V4 — right-align verdict badge so it hangs off the same
              edge as every numeric column above. Consistent alignment
              per user feedback 2026-07-23. */}
          {dust ? <DustBadge /> : <VerdictBadge verdict={r.verdict} session={r.market.session} />}
        </td>
      </tr>
      {expanded && (
        <tr style={{ borderBottom: "1px solid #0f1218" }}>
          <td colSpan={8} className="px-4 py-3" style={{ backgroundColor: "#07090e" }}>
            <TickerDetailPanel ticker={r.ticker} contract={r.contract} openArrow={openArrow} />
          </td>
        </tr>
      )}
    </>
  );
}

// ── Per-ticker watch toggle (2.2b · B2) ──────────────────────────────────────
// A compact ★/☆ glyph in the drift-board Ticker cell. Four states:
//   • disconnected → dimmed ☆, tooltip "connect wallet to watch" (inert)
//   • watching     → green ★, tooltip "watching · click to remove"
//   • at free cap  → dimmed ☆, DISABLED, tooltip "free limit N · hold $BLUE for
//                    more". UI-only: the server does NOT enforce the free cap
//                    yet (1.7 tier-config default-off), so this is a nudge, not
//                    a wall — we never fabricate an enforcement that isn't there.
//   • watchable    → ☆, tooltip "watch for alerts"
// Lives inside a <tr onClick> that expands the detail panel, so EVERY handler
// stops propagation — a click here must never toggle the row.
function WatchToggle({ ticker }: { ticker: string }) {
  const { isConnected } = useAccount();
  const { watchlist, isWatching, add, remove } = useWatchlist();
  const [busy, setBusy] = useState(false);
  const watching = isWatching(ticker);
  const count = watchlist?.entries.length ?? 0;
  const atCap = !watching && count >= WATCHLIST_LIMITS.free.maxEntries;

  // Disconnected — a dimmed star that hints what connecting unlocks. Inert, but
  // still swallows the click so it can't expand the row.
  if (!isConnected) {
    return (
      <span
        className="ml-2 cursor-default align-baseline text-[12px]"
        style={{ color: "#3a3f4b", lineHeight: 1 }}
        title="connect wallet to watch"
        onClick={(e) => e.stopPropagation()}
      >
        ☆
      </span>
    );
  }

  async function onClick(e: React.MouseEvent) {
    e.stopPropagation();
    if (busy || atCap) return;
    setBusy(true);
    try {
      if (watching) await remove(ticker);
      else await add(ticker); // no kinds → server defaults to ALL_KINDS
    } finally {
      setBusy(false);
    }
  }

  const title = watching
    ? "watching · click to remove"
    : atCap
      ? `free limit ${WATCHLIST_LIMITS.free.maxEntries} · hold $BLUE for more`
      : "watch for alerts";

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy || atCap}
      className="ml-2 align-baseline text-[12px] transition-opacity disabled:cursor-not-allowed"
      style={{
        color: watching ? RH_GREEN : atCap ? "#3a3f4b" : MUTED,
        opacity: busy ? 0.5 : 1,
        lineHeight: 1,
      }}
      title={title}
      aria-pressed={watching}
      aria-label={watching ? `Unwatch ${ticker}` : `Watch ${ticker}`}
    >
      {watching ? "★" : "☆"}
    </button>
  );
}

// Base P — per-row venue chip. Base rows wear Base blue (lightened for legible
// 9px text on near-black); RH rows wear the page emerald. `chainOf` supplies the
// value (absent ⟹ robinhood), so the legacy RH-only board reads unchanged and
// the 3 Coinbase-B20 Base rows now stand out at a glance.
function ChainTag({ chain }: { chain: HoodChain }) {
  const isBase = chain === "base";
  return (
    <span
      className="ml-2 rounded px-1.5 py-0.5 align-middle font-mono text-[9px] font-semibold uppercase tracking-wider"
      style={{
        color: isBase ? BASE_BLUE_TEXT : RH_GREEN,
        backgroundColor: isBase ? "rgba(0,82,255,0.16)" : "rgba(52,211,153,0.12)",
      }}
      title={isBase
        ? "Coinbase B20 tokenized stock on Base (chain 8453)"
        : "Tokenized stock on Robinhood Chain (chain 4663)"}
    >
      {isBase ? "BASE" : "RH"}
    </span>
  );
}

// T2 — separate badge so LONG/SHORT never leaks onto a dust row.
function DustBadge() {
  return (
    <span
      className="rounded px-2 py-0.5 font-mono text-[10px] font-semibold tracking-wider"
      style={{ color: "#6b7280", backgroundColor: "#0f1218" }}
      title="Pool TVL below $5k floor — the engine won't fire arrows off this row"
    >
      DUST
    </span>
  );
}

function VerdictBadge({
  verdict,
  session,
}: {
  verdict: M5Verdict | "ERROR";
  session?: string;
}) {
  // T4 — semantic colors by direction/state:
  //   LONG DEX  = green  (DEX cheaper than oracle → buy DEX)
  //   SHORT DEX = red    (DEX more expensive → sell DEX / short)
  //   ALIGNED   = gray   (no signal, not a direction)
  //   FROZEN_*  = amber  (market closed, tool is honest that this isn't arb)
  //
  // P1.2 — weekend distinction. M5's enum has no weekend value; it
  // keeps returning AFTERHOURS_DRIFT / FROZEN_ALIGNED on Sat/Sun. When
  // session === "weekend" we relabel so the badge doesn't lie about
  // being "AH DRIFT" on a Saturday afternoon. Enum stays untouched.
  const isWeekend = session === "weekend";
  const map: Record<M5Verdict | "ERROR", { label: string; color: string; bg: string }> = {
    ALIGNED:          { label: "ALIGNED",   color: "#94a3b8", bg: "#0f1218" },
    LONG_DEX:         { label: "LONG DEX",  color: GREEN_TEXT, bg: "rgba(34,197,94,0.10)" },
    SHORT_DEX:        { label: "SHORT DEX", color: RED,        bg: "rgba(239,68,68,0.10)" },
    FROZEN_ALIGNED:   { label: isWeekend ? "WKND ALIGN" : "FROZEN",   color: AMBER, bg: "rgba(245,179,66,0.10)" },
    PREMARKET_DRIFT:  { label: "PRE DRIFT", color: AMBER, bg: "rgba(245,179,66,0.10)" },
    AFTERHOURS_DRIFT: { label: isWeekend ? "WKND DRIFT" : "AH DRIFT", color: AMBER, bg: "rgba(245,179,66,0.10)" },
    INSUFFICIENT_DATA:{ label: "NO DATA",   color: MUTED, bg: "#0f1218" },
    ERROR:            { label: "ERR",       color: RED,   bg: "rgba(239,68,68,0.10)" },
  };
  const s = map[verdict];
  return (
    <span
      className="rounded px-2 py-0.5 font-mono text-[10px] font-semibold tracking-wider"
      style={{ color: s.color, backgroundColor: s.bg }}
    >
      {s.label}
    </span>
  );
}

// ── Arrows feed ────────────────────────────────────────────────────────────
function ArrowsFeed({ data }: { data: Extract<ArrowsRes, { ok: true }> | null }) {
  if (!data) {
    return (
      <div className="rounded border border-dashed py-8 text-center text-sm" style={{ borderColor: BORDER, color: MUTED }}>
        Loading feed…
      </div>
    );
  }
  if (data.arrows.length === 0) {
    return (
      <div className="rounded border py-8 text-center text-sm" style={{ borderColor: BORDER, backgroundColor: SURFACE, color: MUTED }}>
        No arrows fired yet. The engine skips a ticker when TVL &lt; $5k,
        the feed is abnormally stale, or an open arrow already covers that
        (ticker, type). Next cycle in ≤ 60s.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded border" style={{ borderColor: BORDER, backgroundColor: SURFACE }}>
      <table className="w-full text-sm">
        <thead className="font-mono text-[9px] uppercase tracking-widest" style={{ color: MUTED }}>
          <tr className="border-b" style={{ borderColor: BORDER }}>
            <th className="px-3 py-2 text-left">Serial</th>
            <th className="px-3 py-2 text-left">Ticker</th>
            <th className="px-3 py-2 text-left">Signal</th>
            <th className="px-3 py-2 text-left">Fired</th>
            <th className="px-3 py-2 text-left">Ref px</th>
            <th className="px-3 py-2 text-left">Outcome</th>
          </tr>
        </thead>
        <tbody className="font-mono text-[13px]">
          {data.arrows.map((a) => <ArrowRow key={a.id} a={a} />)}
        </tbody>
      </table>
    </div>
  );
}

function ArrowRow({ a }: { a: Arrow }) {
  const [open, setOpen] = useState(false);
  const signal = (() => {
    if (a.type === "drift") return `DRIFT ${a.expected_direction === "up" ? "↑" : "↓"}`;
    if (a.type === "arb") return `ARB ${a.expected_direction === "up" ? "long dex" : "short dex"}`;
    if (a.type === "flow") return `FLOW ${a.expected_direction === "up" ? "buy" : "sell"}`;
    return "WHALE Δ";
  })();
  const outcome = (() => {
    if (a.status === "open") return { label: "WATCHING", color: BLUE };
    if (a.outcome === "hit") return { label: "HIT", color: GREEN_TEXT };
    if (a.outcome === "miss") return { label: "MISS", color: RED };
    if (a.outcome === "informational") return { label: "INFO", color: MUTED };
    return { label: "—", color: MUTED };
  })();

  const hasBrief = !!a.brief;
  const chevron = open ? "▾" : "▸";

  return (
    <>
      <tr
        className="border-b last:border-b-0 hover:bg-black/40 cursor-pointer"
        style={{ borderColor: "#0f1218" }}
        onClick={() => setOpen((v) => !v)}
      >
        <td className="px-3 py-2 text-left" style={{ color: RH_GREEN }}>
          <span style={{ color: MUTED, marginRight: 4 }}>{chevron}</span>
          {a.serial}
        </td>
        <td className="px-3 py-2 text-left text-white">{a.ticker}</td>
        <td className="px-3 py-2 text-left" style={{ color: "#9aa1ac" }}>{signal}</td>
        <td className="px-3 py-2 text-left" style={{ color: MUTED }}>{formatRelTime(a.fired_at)}</td>
        <td className="px-3 py-2 text-left" style={{ color: "#E7E9EE" }}>${a.reference_price.toFixed(2)}</td>
        <td className="px-3 py-2 text-left">
          <span
            className="rounded px-2 py-0.5 font-mono text-[10px] font-semibold tracking-wider"
            style={{ color: outcome.color, backgroundColor: `${outcome.color}18` }}
            title={a.outcome_detail ?? undefined}
          >
            {outcome.label}
          </span>
        </td>
      </tr>
      {open && (
        <tr style={{ borderBottom: "1px solid #0f1218" }}>
          <td colSpan={6} className="px-3 py-3 space-y-3" style={{ backgroundColor: "#07090e" }}>
            <ArrowBriefBlock a={a} hasBrief={hasBrief} />
            <ArrowFeedTradeRow arrow={a} />
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * T-E entry point in the drift-board arrows-feed row-expand. Same
 * pattern as the chat card + inbox: opens ReviewSignPanel modal.
 * Disabled when arrow is graded.
 */
function ArrowFeedTradeRow({ arrow }: { arrow: Arrow }) {
  const [open, setOpen] = useState(false);
  const { address } = useAccount();
  const arrowOpen = arrow.status === "open";
  // P2.1 (v3, 2026-07-24): filter user_actions to the CONNECTED wallet
  // only — no public counter. Guests see no badge; other wallets' trades
  // are their business.
  const actions = useMemo(() => {
    if (!address) return [];
    const lower = address.toLowerCase();
    return (arrow.user_actions ?? []).filter((a) => a.wallet.toLowerCase() === lower);
  }, [arrow.user_actions, address]);
  const tradedCount = actions.length;
  const successCount  = actions.filter((a) => a.status === "success").length;
  const revertedCount = actions.filter((a) => a.status === "reverted").length;
  const pendingCount  = actions.filter((a) => a.status === "broadcast" || a.status === "pending" || a.status === "unknown").length;
  // stopPropagation on wrapper + button — the parent `<tr>` in the
  // arrows feed has `onClick={() => setOpen((v) => !v)}` that toggles
  // the row expansion. Without this, clicking [Review & Sign] fires
  // setOpen(true) for the panel AND bubbles up to collapse the row,
  // unmounting this component in the same tick → modal never renders.
  // Real bug found in preview 2026-07-23; same bite as inbox.
  return (
    <div
      className="flex flex-wrap items-center gap-2"
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        disabled={!arrowOpen}
        className="rounded border px-3 py-1.5 font-mono text-[11px] font-semibold hover:bg-black/40 disabled:opacity-50 disabled:cursor-not-allowed"
        style={{ borderColor: RH_GREEN, color: RH_GREEN }}
        title={arrowOpen ? "Open the trade panel" : "Signal closed — read-only"}
      >
        {arrowOpen ? "[Review & Sign]" : "[Signal closed]"}
      </button>
      {tradedCount > 0 && (
        <YouTradedBadge
          actions={actions}
          successCount={successCount}
          revertedCount={revertedCount}
          pendingCount={pendingCount}
        />
      )}
      {open && <ReviewSignPanel arrow={arrow} onClose={() => setOpen(false)} />}
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────

/**
 * P2.1 "you traded this" badge (v3, 2026-07-24). Only mounted when the
 * caller has already filtered `actions` to the connected wallet — never
 * shows aggregate/public counts. Single action → inline tx link. More
 * than one → summary chip with per-bucket counts + tooltip listing
 * the most recent 3 tx hashes.
 */
function YouTradedBadge({
  actions,
  successCount,
  revertedCount,
  pendingCount,
}: {
  actions: { tx_hash: string; status: string; ts: string }[];
  successCount: number;
  revertedCount: number;
  pendingCount: number;
}) {
  const RH_EXPLORER = "https://robinhoodchain.blockscout.com";
  // Newest first — the arrow feed reads chronologically top-down.
  const sorted = useMemo(
    () => [...actions].sort((a, b) => (b.ts ?? "").localeCompare(a.ts ?? "")),
    [actions],
  );
  const shorten = (h: string) => `${h.slice(0, 6)}…${h.slice(-4)}`;

  // Single action → inline link with status color. This is what the
  // user asked for verbatim: "you traded this · 0xa9bc…↗".
  if (actions.length === 1) {
    const a = sorted[0];
    const color =
      a.status === "success"  ? RH_GREEN
      : a.status === "reverted" ? "#f87171"
      : "#facc15";
    return (
      <span className="flex items-center gap-1 font-mono text-[10px]" style={{ color }}>
        <span style={{ color: MUTED }}>you traded ·</span>
        <a
          href={`${RH_EXPLORER}/tx/${a.tx_hash}`}
          target="_blank"
          rel="noreferrer"
          className="underline hover:brightness-125"
          onClick={(e) => e.stopPropagation()}
          title={`${a.status} · ${a.ts}`}
        >
          {shorten(a.tx_hash)} ↗
        </a>
      </span>
    );
  }

  // Multiple actions → bucket summary + tooltip with most recent hashes.
  const tooltip = `you traded ${actions.length} times · ` +
    sorted.slice(0, 3).map((a) => `${shorten(a.tx_hash)} (${a.status})`).join(", ") +
    (sorted.length > 3 ? `, +${sorted.length - 3} more` : "");
  return (
    <span
      className="flex items-center gap-1 font-mono text-[10px]"
      title={tooltip}
    >
      <span style={{ color: MUTED }}>you traded ·</span>
      {successCount  > 0 && <span style={{ color: RH_GREEN     }}>{successCount} ✓</span>}
      {revertedCount > 0 && <span style={{ color: "#f87171"    }}>{revertedCount} ✗</span>}
      {pendingCount  > 0 && <span style={{ color: "#facc15"    }}>{pendingCount} ●</span>}
    </span>
  );
}

function SectionHeader({ label }: { label: string }) {
  return (
    <div className="mb-3 font-mono text-[10px] uppercase tracking-widest" style={{ color: MUTED }}>
      {label}
    </div>
  );
}

function Footer() {
  return (
    <footer className="mt-12 border-t pt-6 text-[11px]" style={{ borderColor: BORDER, color: MUTED }}>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <span>Oracle: Chainlink AggregatorV3 (RH) + B20 share price (Base)</span>
        <span>DEX: GeckoTerminal (Uniswap V3/V4 · Aerodrome)</span>
        <span>
          Powered by 30 <span style={{ color: BLUE }}>Blue Hub</span> skills · x402 · $0.05/call
        </span>
      </div>
    </footer>
  );
}

// ── T-V2 #3 · price flash ─────────────────────────────────────────────────
//
// `FlashCell` compares its incoming `value` with the previous one; when
// the number moves up or down between polls the underlying span
// re-mounts (via a monotonic key) so the `hood-flash-up` /
// `hood-flash-down` CSS animation replays for 400ms. First render never
// flashes — nothing to compare against yet. Null → null transitions are
// ignored. Reduced-motion users get no flash (see globals.css).
//
// Kept small on purpose: no debounce, no memoization gymnastics — a poll
// happens at most every 15s so the extra re-mounts are negligible.
function FlashCell({
  value,
  format = formatUsd,
}: {
  value: number | null | undefined;
  format?: (v: number | null | undefined) => string;
}) {
  const prevRef = useRef<number | null | undefined>(value);
  const [state, setState] = useState<{ key: number; dir: "up" | "down" | null }>({ key: 0, dir: null });

  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = value;
    if (typeof value !== "number" || typeof prev !== "number") return;
    if (value === prev) return;
    const dir = value > prev ? "up" : "down";
    setState((s) => ({ key: s.key + 1, dir }));
  }, [value]);

  const flashCls = state.dir === "up"
    ? "hood-flash-up"
    : state.dir === "down"
      ? "hood-flash-down"
      : "";
  return (
    <span
      key={state.key}
      // `inline-block` + tiny padding so the flash rectangle has body;
      // negative margin cancels the visible offset so the number stays
      // in its column exactly where it was.
      className={`inline-block px-1 -mx-1 rounded tabular-nums ${flashCls}`}
    >
      {format(value)}
    </span>
  );
}

// ── Utils ──────────────────────────────────────────────────────────────────
function formatUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n > 0) return `$${n.toFixed(4)}`;
  return "$0";
}

// Base P — chain-aware token explorer. A Base B20 token lives on Basescan
// (8453); an RH token on the RH Blockscout (4663). The Base contract does not
// exist on RH's explorer, so this must key off the row's chain, never a
// hardcoded host.
function tokenExplorerUrl(r: TickerSnapshot): string {
  return chainOf(r) === "base"
    ? `https://basescan.org/token/${r.contract}`
    : `https://robinhoodchain.blockscout.com/token/${r.contract}`;
}

// Base P — GeckoTerminal indexes both desks: Aerodrome pools under `base`, the
// RWA pools under `robinhood`. Build the network segment from the row's chain so
// a Base pool link never points at the RH index (and vice versa).
function poolUrl(poolRef: string, chain: HoodChain): string {
  const network = chain === "base" ? "base" : "robinhood";
  return `https://www.geckoterminal.com/${network}/pools/${poolRef}`;
}

function formatRelTime(iso: string): string {
  const sec = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

/** Compact age formatter for the header + stale banner. Takes seconds
 *  since the event. Always returns a short two- or three-char string:
 *  "9s", "45m", "3h", "2d". Never returns a decimal. */
function formatAgeShort(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}
