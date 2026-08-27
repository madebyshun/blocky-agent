"use client";

/**
 * /hood/inbox client — feed + last-read bookmark.
 *
 * Lists every arrow (open / graded / informational), newest first. Rows
 * above the `last_read_at` bookmark are visually marked unread (bold
 * ticker + green dot). "Mark all read" POSTs the current timestamp so
 * the bookmark moves forward to now.
 *
 * Same accordion pattern as /hood/arrows — click a row to see the
 * shared ArrowBriefBlock (verdict_note · one_line_context · warnings ·
 * facts_at_fire · outcome_detail).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAccount } from "wagmi";
import type { Arrow } from "@/lib/blue-hood/types";
import ArrowBriefBlock from "../ArrowBriefBlock";
import EnableAlertsButton from "./EnableAlertsButton";
import ReviewSignPanel from "@/components/blue-hood/ReviewSignPanel";
import HoodShellFrame from "../HoodShellFrame";
import { useHoodShellData } from "../useHoodShellData";

const RH_EXPLORER = "https://robinhoodchain.blockscout.com";

const REFRESH_MS = 15_000;
const RH_GREEN = "#34D399";
const BLUE = "#4FC3F7";
const RED = "#ef4444";
const GREEN = "#22c55e";
const MUTED = "#6b7280";
const BG = "#050508";
const SURFACE = "#0B0D13";
const BORDER = "#1A1A2E";

interface ArrowsRes {
  ok: boolean;
  arrows: Arrow[];
  arrows_today: number;
}
interface LastReadRes {
  ok: boolean;
  last_read_at: string | null;
}

export default function InboxClient() {
  const [arrows, setArrows] = useState<Arrow[]>([]);
  const [lastRead, setLastRead] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Deep-link support — `/hood/inbox#<arrow.id>` auto-expands + scrolls
  // to that card. Sidebar's RECENT ARROWS + Web Push notifications both
  // point here; before this the hash was ignored → clicked notifications
  // dumped you at the top of the inbox with no visible focus. 2026-07-23.
  const [openArrowId, setOpenArrowId] = useState<string | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const readHash = () => {
      const h = window.location.hash.replace(/^#/, "");
      setOpenArrowId(h || null);
    };
    readHash();
    window.addEventListener("hashchange", readHash);
    return () => window.removeEventListener("hashchange", readHash);
  }, []);
  // Scroll to the target arrow after it renders. requestAnimationFrame
  // waits for one paint so the <li id={a.id}> is in the DOM.
  useEffect(() => {
    if (!openArrowId || arrows.length === 0 || typeof window === "undefined") return;
    const raf = requestAnimationFrame(() => {
      const el = document.getElementById(openArrowId);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    return () => cancelAnimationFrame(raf);
  }, [openArrowId, arrows.length]);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const [a, lr] = await Promise.all([
        // Public + `s-maxage` → no `no-store`, so the edge cache is used. The
        // `?limit=200` variant is its own cache key, which is fine.
        fetch("/api/hood/arrows?limit=200", { signal }).then((r) => r.json() as Promise<ArrowsRes>),
        // Per-user (keyed on X-Blue-User) — MUST stay uncached and `no-store`.
        fetch("/api/hood/inbox/last-read", { cache: "no-store", signal }).then((r) => r.json() as Promise<LastReadRes>),
      ]);
      if (a.ok) setArrows(a.arrows);
      if (lr.ok) setLastRead(lr.last_read_at);
      setErr(null);
    } catch (e) {
      if ((e as Error).name !== "AbortError") setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    const ctl = new AbortController();
    load(ctl.signal);
    const t = setInterval(() => load(ctl.signal), REFRESH_MS);
    return () => { ctl.abort(); clearInterval(t); };
  }, [load]);

  const cutoff = useMemo(() => (lastRead ? new Date(lastRead).getTime() : 0), [lastRead]);
  const unread = useMemo(
    () => arrows.filter((a) => new Date(a.fired_at).getTime() > cutoff).length,
    [arrows, cutoff],
  );

  const markAllRead = useCallback(async () => {
    const now = new Date().toISOString();
    // Optimistic — flip local bookmark immediately.
    setLastRead(now);
    try {
      await fetch("/api/hood/inbox/last-read", { method: "POST", cache: "no-store" });
    } catch {
      // If the POST fails the next 15s refresh will pull the server state.
    }
  }, []);

  // Sidebar data — separate fetch from the inbox's own arrows (which
  // uses limit=200 for the full list). Sidebar-hook is cheap and gives
  // us marketBadge + unread badge consistent with /hood.
  const shell = useHoodShellData();
  const router = useRouter();
  // Watchlist row click on /hood/inbox → navigate to /hood#<TICKER> so
  // the drift board expands and scrolls to that ticker. Same behavior
  // as intra-page scroll on /hood, just cross-page.
  const onSidebarSelect = useCallback((ticker: string) => {
    router.push(`/hood#${ticker.toUpperCase()}`);
  }, [router]);

  return (
    <HoodShellFrame
      snap={shell.snap}
      arrows={shell.arrows}
      marketLabel={shell.marketLabel}
      marketColor={shell.marketColor}
      onSelectTicker={onSidebarSelect}
      inboxUnread={unread}
    >
        <Header unread={unread} onMarkAllRead={markAllRead} />
        {err && (
          <div
            role="alert"
            className="mb-6 rounded border px-3 py-2 text-sm"
            style={{ borderColor: "#3b2a15", backgroundColor: "#1a1408", color: "#f6c88f" }}
          >
            {err}
          </div>
        )}

        <SectionHeader label="// HOOD · INBOX" />
        {arrows.length === 0 ? (
          <EmptyState />
        ) : (
          <ul className="space-y-2">
            {arrows.map((a) => (
              <InboxCard
                key={a.id}
                a={a}
                isUnread={new Date(a.fired_at).getTime() > cutoff}
                initialOpen={openArrowId === a.id}
              />
            ))}
          </ul>
        )}

        <Footer />
    </HoodShellFrame>
  );
}

function Header({ unread, onMarkAllRead }: { unread: number; onMarkAllRead: () => void }) {
  return (
    <header className="mb-8 flex flex-wrap items-baseline gap-x-4 gap-y-2">
      {/* T-V1 — same BLUE·HOOD wordmark as /hood + sidebar. The current
          view is disambiguated by the "· INBOX" suffix rather than
          changing the wordmark, keeping the brand shape identical
          everywhere it appears. */}
      <div className="flex items-baseline gap-3">
        <div className="text-[24px] font-bold tracking-tight text-white">
          BLUE<span style={{ color: RH_GREEN }}>HOOD</span>
          <span className="ml-2 text-[13px] font-normal" style={{ color: MUTED, letterSpacing: "0.08em" }}>· INBOX</span>
        </div>
        <div className="text-[11px] tabular-nums" style={{ color: "#9aa1ac" }}>
          {unread === 0 ? "all caught up" : `${unread} unread`}
        </div>
      </div>
      <div className="ml-auto flex items-center gap-3 text-[11px]">
        <Link href="/hood" className="hover:text-white" style={{ color: MUTED }}>
          ← Live board
        </Link>
        <Link href="/hood/arrows" className="hover:text-white" style={{ color: MUTED }}>
          Track record →
        </Link>
        <EnableAlertsButton />
        {unread > 0 && (
          <button
            onClick={onMarkAllRead}
            className="rounded border px-2 py-1 hover:text-white"
            style={{ borderColor: BORDER, color: "#9aa1ac" }}
          >
            Mark all read
          </button>
        )}
      </div>
    </header>
  );
}

function InboxCard({ a, isUnread, initialOpen = false }: { a: Arrow; isUnread: boolean; initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  // Re-sync `open` when initialOpen flips true (deep-link arrives after
  // arrows fetch resolves).
  useEffect(() => { if (initialOpen) setOpen(true); }, [initialOpen]);
  const outcome = (() => {
    if (a.status === "open") return { label: "WATCHING", color: BLUE };
    if (a.outcome === "hit") return { label: "HIT", color: GREEN };
    if (a.outcome === "miss") return { label: "MISS", color: RED };
    if (a.outcome === "informational") return { label: "INFO", color: MUTED };
    return { label: "—", color: MUTED };
  })();
  const signal = (() => {
    if (a.type === "drift") return `DRIFT ${a.expected_direction === "up" ? "↑" : "↓"}`;
    if (a.type === "arb") return `ARB ${a.expected_direction === "up" ? "long dex" : "short dex"}`;
    if (a.type === "flow") return `FLOW ${a.expected_direction === "up" ? "buy" : "sell"}`;
    return "WHALE Δ";
  })();
  const briefLine = a.brief?.verdict_note
    ?? (a.brief_status === "pending" ? "brief attaching…"
        : a.brief_status === "failed" ? "Brief unavailable — A4 chain failed."
        : "No brief attached at fire time.");

  return (
    <li id={a.id}>
      <div
        // T-V2 #2 — `hood-row` adds the terminal-cursor border-left on
        // hover. Rounded corners + the surface hover-darken keep the
        // card feel; the cursor bar just tells the user which row is
        // about to open.
        className="hood-row rounded border cursor-pointer transition-colors hover:bg-black/40"
        style={{
          borderColor: isUnread ? "#1f3924" : BORDER,
          backgroundColor: SURFACE,
        }}
        onClick={() => setOpen((v) => !v)}
      >
        <div className="flex items-start gap-3 px-3 py-2.5">
          {isUnread && (
            <span
              className="mt-2 w-1.5 h-1.5 rounded-full shrink-0"
              style={{ backgroundColor: RH_GREEN, boxShadow: `0 0 6px ${RH_GREEN}80` }}
              aria-label="unread"
            />
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-[11px]" style={{ color: RH_GREEN }}>{a.serial}</span>
              <span className={`font-mono text-[13px] ${isUnread ? "text-white font-semibold" : "text-slate-300"}`}>
                {a.ticker}
              </span>
              <span className="font-mono text-[10px] uppercase" style={{ color: MUTED }}>{signal}</span>
              <span className="ml-auto font-mono text-[10px]" style={{ color: MUTED }}>
                {formatRelTime(a.fired_at)}
              </span>
            </div>
            <div className="mt-1 font-mono text-[12px] truncate" style={{ color: "#9aa1ac" }}>
              {briefLine}
            </div>
          </div>
          <span
            className="rounded px-2 py-0.5 font-mono text-[10px] font-semibold tracking-wider shrink-0"
            style={{ color: outcome.color, backgroundColor: `${outcome.color}18` }}
          >
            {outcome.label}
          </span>
          <span className="font-mono text-[10px]" style={{ color: MUTED }}>{open ? "▾" : "▸"}</span>
        </div>
        {open && (
          <div className="border-t px-3 py-3 space-y-3" style={{ borderColor: "#0f1218" }}>
            <ArrowBriefBlock a={a} hasBrief={!!a.brief} />
            <InboxCardTradeRow arrow={a} />
          </div>
        )}
      </div>
    </li>
  );
}

/**
 * T-E entry point for the inbox row-expand. Same pattern as the chat
 * card's ActionsRow: opens ReviewSignPanel modal. Disabled when the
 * arrow is graded/informational.
 */
function InboxCardTradeRow({ arrow }: { arrow: Arrow }) {
  const [open, setOpen] = useState(false);
  const { address } = useAccount();
  const arrowOpen = arrow.status === "open";
  // P2.1 — connected-wallet-only. See ArrowFeedTradeRow (HoodClient.tsx)
  // for the parallel filter; both surfaces read the same shape.
  const actions = useMemo(() => {
    if (!address) return [];
    const lower = address.toLowerCase();
    return (arrow.user_actions ?? []).filter((a) => a.wallet.toLowerCase() === lower);
  }, [arrow.user_actions, address]);
  const tradedCount = actions.length;
  const successCount  = actions.filter((a) => a.status === "success").length;
  const revertedCount = actions.filter((a) => a.status === "reverted").length;
  const pendingCount  = actions.filter((a) => a.status === "broadcast" || a.status === "pending" || a.status === "unknown").length;
  // stopPropagation on the wrapper — the parent InboxCard has an
  // outer `onClick={() => setOpen((v) => !v)}` that TOGGLES the row
  // expansion. Without this, clicking [Review & Sign] fires setOpen(true)
  // for the panel AND bubbles up to collapse the row, which unmounts
  // this component in the same tick → panel state destroyed, modal
  // never renders. Real bug found in preview 2026-07-23.
  return (
    <div
      className="flex flex-wrap items-center gap-2 pt-1"
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
        actions.length === 1 ? (
          (() => {
            const a = actions[0];
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
                  {`${a.tx_hash.slice(0, 6)}…${a.tx_hash.slice(-4)}`} ↗
                </a>
              </span>
            );
          })()
        ) : (
          <span
            className="flex items-center gap-1 font-mono text-[10px]"
            title={`you traded ${tradedCount} times: ${successCount} success · ${revertedCount} reverted · ${pendingCount} broadcast/unknown`}
          >
            <span style={{ color: MUTED }}>you traded ·</span>
            {successCount  > 0 && <span style={{ color: RH_GREEN  }}>{successCount} ✓</span>}
            {revertedCount > 0 && <span style={{ color: "#f87171" }}>{revertedCount} ✗</span>}
            {pendingCount  > 0 && <span style={{ color: "#facc15" }}>{pendingCount} ●</span>}
          </span>
        )
      )}
      {open && <ReviewSignPanel arrow={arrow} onClose={() => setOpen(false)} />}
    </div>
  );
}

function EmptyState() {
  return (
    <div
      className="rounded border py-12 text-center"
      style={{ borderColor: BORDER, backgroundColor: SURFACE, color: MUTED }}
    >
      {/* Empty-state title stays mono (short label). The paragraph below
          is a real ≥2-sentence run and takes the `hood-prose` token. */}
      <div className="font-mono text-white text-[13px] mb-2">Inbox empty.</div>
      <p className="hood-prose max-w-md mx-auto text-[13.5px] leading-relaxed">
        Arrows land here the moment the engine fires. First delivery when NYSE opens Monday.
      </p>
    </div>
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
