"use client";

/**
 * Blue Hood — contextual sidebar.
 *
 * Mirrors the Chat sidebar convention (w-72, `#050508` bg, `#1A1A2E`
 * border, pulse dot at the top) so the whole app feels consistent. Blue
 * Hood's version replaces "conversations" with two live sections:
 *
 *   • WATCHLIST — every registry ticker with a color-coded status dot
 *     (verdict → dot). Click a row to scroll the drift board to that ticker.
 *   • RECENT ARROWS — last 8 non-test arrows with serial + relative time.
 *
 * The sidebar is a read-only client component; it consumes state props
 * from the parent so both panes render off the same fetch and stay in
 * sync (single source of truth = HoodClient's fetch loop).
 */

import { useState } from "react";
import Link from "next/link";
import type { Arrow, HoodSnapshot, M5Verdict, TickerSnapshot } from "@/lib/blue-hood/types";
import { rowKey } from "@/lib/blue-hood/types";

const RH_GREEN = "#34D399";
const BLUE = "#4FC3F7";
const AMBER = "#f5b342";
const RED = "#ef4444";
const GREEN = "#22c55e";
const MUTED = "#6b7280";
const BORDER = "#1A1A2E";
const BG = "#050508";
const DUST_TVL_USD = 5_000;

// Dust check matches the rule-engine gate: TOTAL token liquidity, not
// primary pool. Otherwise NVDA (bankr-robinhood WETH $21M + USDG $850k
// primary) would incorrectly badge dust in the sidebar picker.
function rowTotalTvlUi(r: TickerSnapshot): number {
  return r.total_tvl_usd ?? r.tvl_usd ?? 0;
}

function isDust(r: TickerSnapshot): boolean {
  return r.verdict !== "ERROR" && r.dex_usd !== null && rowTotalTvlUi(r) < DUST_TVL_USD;
}
function isNoData(r: TickerSnapshot): boolean {
  return r.verdict === "ERROR" || r.verdict === "INSUFFICIENT_DATA" || r.dex_usd === null;
}

function verdictDotColor(v: M5Verdict | "ERROR"): string {
  switch (v) {
    case "ALIGNED":
    case "LONG_DEX":
      return GREEN;
    case "SHORT_DEX":
      return RED;
    case "PREMARKET_DRIFT":
    case "AFTERHOURS_DRIFT":
      return AMBER;
    case "FROZEN_ALIGNED":
      return "#4b5563";
    case "INSUFFICIENT_DATA":
      return "#334155";
    default:
      return RED;
  }
}

export default function HoodSidebar({
  snap,
  arrows,
  marketLabel,
  marketColor,
  onSelectTicker,
  inboxUnread = 0,
}: {
  snap: HoodSnapshot | null;
  arrows: Arrow[] | null;
  marketLabel: string;
  marketColor: string;
  onSelectTicker: (ticker: string) => void;
  /** Unread arrow count for the Inbox nav badge. Optional; 0 = no badge. */
  inboxUnread?: number;
}) {
  const rows: TickerSnapshot[] = snap?.tickers ?? [];

  // T2 — collapsible dust group. Tradable rows go up top; dust rows are
  // grouped, sorted, and hidden by default with a "· N dust pools" toggle.
  // NO DATA rows also cluster so a rate-limited cycle stays visible but
  // doesn't mingle with tradable rows.
  const tradable = rows.filter((r) => !isDust(r) && !isNoData(r));
  const dust = rows.filter(isDust);
  const noData = rows.filter(isNoData);
  const [dustOpen, setDustOpen] = useState(false);
  const [noDataOpen, setNoDataOpen] = useState(false);

  return (
    <aside
      className="hidden lg:flex flex-col w-72 shrink-0 h-full border-r"
      style={{ backgroundColor: "#050508", borderColor: BORDER }}
    >
      {/* Header row — mirrors Chat sidebar's pulse-dot header */}
      <div
        className="px-5 h-14 flex items-center border-b shrink-0"
        style={{ borderColor: BORDER }}
      >
        <span
          className="w-1.5 h-1.5 rounded-full shrink-0 mr-2 animate-pulse"
          style={{ backgroundColor: RH_GREEN }}
        />
        <span className="font-mono text-[12px] text-white tracking-wide">
          BLUE<span style={{ color: RH_GREEN }}>HOOD</span>
        </span>
        <span
          className="ml-auto font-mono text-[9px] tracking-widest"
          style={{ color: marketColor }}
        >
          {marketLabel}
        </span>
      </div>

      {/* Nav strip — Drift (current) · Inbox (n) · Track record.
          Before this the sidebar had no path to /hood/inbox or
          /hood/arrows; RECENT ARROWS below was the only clue that
          another view existed, and its click just scrolled the board.
          Real bug 2026-07-23. */}
      <nav
        className="px-3 pt-3 pb-2 flex flex-col gap-1 border-b"
        style={{ borderColor: BORDER }}
        aria-label="Blue Hood sections"
      >
        <span className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg font-mono text-[11px] tracking-wide" style={{ color: RH_GREEN, backgroundColor: "#0a1a0e" }}>
          <span>▸</span> Drift board
        </span>
        <Link
          href="/hood/inbox"
          className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg transition-colors hover:bg-[#ffffff08] font-mono text-[11px] tracking-wide"
          style={{ color: inboxUnread > 0 ? RH_GREEN : "#9aa1ac" }}
        >
          <span>▸</span> Inbox
          {inboxUnread > 0 && (
            <span
              className="ml-auto rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold"
              style={{ color: BG, backgroundColor: RH_GREEN }}
            >
              {inboxUnread}
            </span>
          )}
        </Link>
        <Link
          href="/hood/arrows"
          className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg transition-colors hover:bg-[#ffffff08] font-mono text-[11px] tracking-wide"
          style={{ color: "#9aa1ac" }}
        >
          <span>▸</span> Track record
        </Link>
      </nav>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {/* Watchlist — tradable first, then dust (collapsed by default),
            then NO DATA (also collapsed). Header stays sortable by |drift|. */}
        <div className="px-2 pt-3">
          <SectionLabel label="WATCHLIST" count={rows.length} />

          {rows.length === 0 ? (
            <SidebarEmpty text="Poller warming up…" />
          ) : (
            <>
              {tradable.length === 0 && (
                <SidebarEmpty text="No tradable rows this cycle." />
              )}
              <ul className="pb-1">
                {tradable
                  .slice()
                  .sort((a, b) => Math.abs(b.drift_pct ?? 0) - Math.abs(a.drift_pct ?? 0))
                  .map((r) => (
                    <WatchRow key={rowKey(r)} r={r} kind="tradable" onSelect={onSelectTicker} />
                  ))}
              </ul>

              {dust.length > 0 && (
                <>
                  <button
                    onClick={() => setDustOpen((v) => !v)}
                    className="w-full flex items-center gap-2 px-3 py-1.5 rounded-lg transition-colors hover:bg-[#ffffff06]"
                    style={{ color: MUTED }}
                  >
                    <span className="font-mono text-[10px] tracking-widest">
                      {dustOpen ? "▾" : "▸"} · {dust.length} DUST POOLS
                    </span>
                  </button>
                  {dustOpen && (
                    <ul className="pb-1">
                      {dust
                        .slice()
                        .sort((a, b) => rowTotalTvlUi(b) - rowTotalTvlUi(a))
                        .map((r) => (
                          <WatchRow key={rowKey(r)} r={r} kind="dust" onSelect={onSelectTicker} />
                        ))}
                    </ul>
                  )}
                </>
              )}

              {noData.length > 0 && (
                <>
                  {(() => {
                    // T-B.1 #4 — surface the split so a throttle-tail
                    // (many fetch_failed) is legible at a glance.
                    const failed = noData.filter((r) => r.no_data_reason === "fetch_failed").length;
                    const noPool = noData.filter((r) => r.no_data_reason === "no_pool").length;
                    const label = failed > 0 && noPool > 0
                      ? `${noData.length} NO DATA · ${failed} fetch fail · ${noPool} no pool`
                      : failed > 0
                        ? `${noData.length} FETCH FAILED`
                        : `${noData.length} NO POOL`;
                    return (
                      <button
                        onClick={() => setNoDataOpen((v) => !v)}
                        className="w-full flex items-center gap-2 px-3 py-1.5 rounded-lg transition-colors hover:bg-[#ffffff06]"
                        style={{ color: MUTED }}
                      >
                        <span className="font-mono text-[10px] tracking-widest">
                          {noDataOpen ? "▾" : "▸"} · {label}
                        </span>
                      </button>
                    );
                  })()}
                  {noDataOpen && (
                    <ul className="pb-1">
                      {noData.map((r) => (
                        <WatchRow key={rowKey(r)} r={r} kind="no_data" onSelect={onSelectTicker} />
                      ))}
                    </ul>
                  )}
                </>
              )}
            </>
          )}
        </div>

        {/* Recent arrows — the same list that lives in the main pane's feed,
            trimmed to a strip for quick scanning without scrolling to the
            arrows section. */}
        <div className="px-2 pt-3 border-t" style={{ borderColor: BORDER }}>
          <SectionLabel
            label="RECENT ARROWS"
            count={arrows?.length ?? 0}
          />
          {!arrows || arrows.length === 0 ? (
            <SidebarEmpty text="No arrows yet." />
          ) : (
            <ul className="pb-3">
              {arrows.slice(0, 8).map((a) => {
                // T-A — hover tooltip shows brief.verdict_note if attached,
                // else falls back to outcome_detail (once graded) or type.
                const tooltip = a.brief?.verdict_note
                  ?? a.outcome_detail
                  ?? `${a.type} · ${a.expected_direction ?? ""}`;
                // Deep-link to the inbox card for this arrow. Before this,
                // the row was `<button onClick={onSelectTicker(a.ticker)}>`
                // which just scrolled the board to the ticker — you lost
                // the arrow context and had no path to Review & Sign.
                // The `#${a.id}` anchor is respected by InboxClient (see
                // its `rowRefs` scroll-to-hash logic). 2026-07-23 fix.
                return (
                  <li key={a.id}>
                    <Link
                      href={`/hood/inbox#${a.id}`}
                      className="w-full flex items-center gap-2 px-3 py-1.5 rounded-lg transition-colors hover:bg-[#ffffff08]"
                      title={tooltip}
                    >
                      <span
                        className="font-mono text-[11px] tracking-wide shrink-0"
                        style={{ color: RH_GREEN }}
                      >
                        {a.serial}
                      </span>
                      <span className="font-mono text-[12px] text-slate-200">{a.ticker}</span>
                      <span className="font-mono text-[10px] uppercase" style={{ color: MUTED }}>
                        {a.type}
                      </span>
                      <span
                        className="ml-auto font-mono text-[10px] tracking-wider"
                        style={outcomeStyle(a)}
                      >
                        {outcomeLabel(a)}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {/* Footer — mirrors Blue Chat's sidebar credit-bar (px-5 py-3.5,
          border-t, shrink-0 to stay glued to the bottom). Live-cycle
          indicator dot on the left; tokens-tracked count in the middle;
          gear-icon docs link on the right. Same visual weight as the
          Chat surface for consistency. */}
      <Link
        href="/docs/blue-hood"
        className="px-5 py-3.5 border-t shrink-0 flex items-center gap-2.5 hover:bg-[#ffffff05] transition-colors group"
        style={{ borderColor: BORDER }}
        title="Docs — Blue Hood"
      >
        <span
          className="w-2 h-2 rounded-full shrink-0 transition-all animate-pulse"
          style={{
            backgroundColor: snap ? RH_GREEN : "#334155",
            boxShadow: snap ? `0 0 6px ${RH_GREEN}80` : undefined,
          }}
        />
        <span className="font-mono text-[11px] flex-1 text-left" style={{ color: "#64748b" }}>
          {/* Denominator is the feed-eligible pool, not the whole registry —
              the poller can't watch a row with no Chainlink feed. Matches the
              "TOKENS WATCHED" card in HoodClient; keep the two in step. */}
          {snap
            ? `${snap.metrics.tokens_watched}/${snap.metrics.tokens_eligible ?? snap.metrics.registry_total} tokens · 30 Hub skills`
            : "warming up…"}
        </span>
        <span className="font-mono text-[9px] text-slate-700 group-hover:text-slate-500 transition-colors">
          docs
        </span>
      </Link>
    </aside>
  );
}

function WatchRow({
  r,
  kind,
  onSelect,
}: {
  r: TickerSnapshot;
  kind: "tradable" | "dust" | "no_data";
  onSelect: (t: string) => void;
}) {
  const drift = r.drift_pct ?? 0;
  const dotColor =
    kind === "no_data"
      ? "#3f4550" // T3 — plain gray dot (we don't know direction/thinness yet)
      : verdictDotColor(r.verdict);
  const rowOpacity = kind === "tradable" ? 1 : 0.7;

  return (
    <li>
      <button
        // Base P1 — hand the caller the (chain, ticker) identity, not the bare
        // ticker: the parent looks this up in `rowRefs` to scroll the board,
        // and both chains list NVDA/META/GOOGL/AAPL. RH ⟹ bare ticker, so
        // clicking an RH watchlist row behaves exactly as it did before.
        onClick={() => onSelect(rowKey(r))}
        className="w-full flex items-center gap-2.5 px-3 py-1.5 rounded-lg transition-colors hover:bg-[#ffffff08]"
        style={{ opacity: rowOpacity }}
      >
        <span
          className={`w-1.5 h-1.5 rounded-full shrink-0 ${kind === "no_data" ? "" : ""}`}
          style={{ backgroundColor: dotColor }}
          title={kind === "no_data" ? "No pool data this cycle" : r.verdict}
        />
        <span className="font-mono text-[12px] text-slate-200 tracking-wide">
          {r.ticker}
        </span>
        {kind === "dust" && (
          <span
            className="font-mono text-[9px] uppercase tracking-widest ml-1"
            style={{ color: AMBER }}
            title={`Below $${DUST_TVL_USD.toLocaleString()} pool TVL — engine gate`}
          >
            dust
          </span>
        )}
        {kind === "no_data" ? (
          <span
            className="ml-auto font-mono text-[11px]"
            style={{ color: MUTED }}
          >
            ·
          </span>
        ) : (
          <span
            className="ml-auto font-mono text-[11px] tabular-nums"
            style={{ color: driftColor(drift) }}
          >
            {drift === 0 ? "—" : `${drift > 0 ? "+" : ""}${drift.toFixed(2)}%`}
          </span>
        )}
      </button>
    </li>
  );
}

function SectionLabel({ label, count }: { label: string; count: number }) {
  return (
    <div
      className="flex items-center justify-between px-3 pt-1 pb-1.5 font-mono text-[9px] tracking-widest"
      style={{ color: MUTED }}
    >
      <span>{label}</span>
      <span className="tabular-nums">{count}</span>
    </div>
  );
}

function SidebarEmpty({ text }: { text: string }) {
  return (
    <p
      className="px-3 py-2 font-mono text-[11px]"
      style={{ color: MUTED }}
    >
      {text}
    </p>
  );
}

function driftColor(pct: number): string {
  if (Math.abs(pct) < 0.5) return "#94a3b8";
  return pct > 0 ? GREEN : RED;
}

function outcomeLabel(a: Arrow): string {
  if (a.status === "open") return "WATCHING";
  if (a.outcome === "hit") return "HIT";
  if (a.outcome === "miss") return "MISS";
  if (a.outcome === "informational") return "INFO";
  return "—";
}

function outcomeStyle(a: Arrow): React.CSSProperties {
  if (a.status === "open") return { color: BLUE };
  if (a.outcome === "hit") return { color: GREEN };
  if (a.outcome === "miss") return { color: RED };
  return { color: MUTED };
}
