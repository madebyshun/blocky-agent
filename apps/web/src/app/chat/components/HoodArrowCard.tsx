"use client";

/**
 * Blue Chat card for a Blue Hood arrow (T-D D2 consumer).
 *
 * Renders the pre-shaped ChatCard + a compact facts strip from
 * `arrow.brief.facts_at_fire` so the LLM's follow-up ("why short X?")
 * has visible receipts. The [Review & Sign] button is a PLACEHOLDER
 * only — the trade action lands in T-E. Clicking it currently opens a
 * dev-console warning + a link to the inbox so the user can inspect
 * the raw arrow record.
 *
 * Design tokens follow Blue Hood: bg #050508, surface #0B0D13,
 * border #1A1A2E, RH_GREEN #34D399, mono JetBrains. This card is
 * rendered OUTSIDE `.hood-section` (chat context) so it re-declares
 * the mono family locally rather than relying on inherit.
 */

import { chainOf, type Arrow, type HoodChain } from "@/lib/blue-hood/types";
import type { ChatCard } from "@/lib/blue-hood/chat-card";
import Link from "next/link";
import { useState } from "react";
import ReviewSignPanel from "@/components/blue-hood/ReviewSignPanel";

const RH_GREEN = "#34D399";
const BLUE = "#4FC3F7";
const AMBER = "#f5b342";
const MUTED = "#6b7280";
const SURFACE = "#0B0D13";
const BORDER = "#1A1A2E";
const RED = "#ef4444";
const GREEN_TEXT = "#22c55e";

export interface HoodArrowResult {
  kind: "hood_arrow";
  not_found?: boolean;
  /** "no_arrow_on_chain" — the ticker exists, this DESK has never fired it.
   *  A distinct reason because "no NVDA arrow" and "no NVDA arrow on Base" are
   *  different facts, and the second one is the one the user asked about. */
  reason?: string;
  arrow?: Arrow;
  card?: ChatCard | null;
  signal?: string;
  /** Resolved server-side via `chainOf`, so the ~74 rows that predate the Base
   *  desk render "ROBINHOOD" rather than a blank badge. */
  chain?: HoodChain;
  age_hours?: number | null;
  /** Set when the requested desk is empty but the OTHER one has this ticker.
   *  Offered as a different question, never silently substituted. */
  other_chain?: { serial: string; chain: string } | null;
  deep_link?: { inbox: string; board: string; track: string };
  query?: { arrowIdArg?: string; serialArg?: string; tickerArg?: string; chainArg?: string };
}

const CHAIN_LABEL: Record<HoodChain, string> = { robinhood: "ROBINHOOD 4663", base: "BASE 8453" };

export function HoodArrowCard({ result }: { result: HoodArrowResult }) {
  if (result.not_found) {
    // #206 — a chain-scoped miss says which desk it searched. The old copy read
    // "No arrow matching NVDA", which is FALSE when Robinhood has fired NVDA 40
    // times and only Base is empty — and it was rendered right next to prose
    // answering a Base question with a Robinhood arrow.
    const onChain = result.reason === "no_arrow_on_chain" && result.query?.chainArg;
    return (
      <div
        className="rounded border px-4 py-3 font-mono text-[12px]"
        style={{ borderColor: BORDER, backgroundColor: SURFACE, color: MUTED }}
      >
        <div className="mb-1 text-[11px] uppercase" style={{ color: AMBER, letterSpacing: "0.08em" }}>
          // BLUE HOOD · {onChain ? "no arrow on this desk" : "not found"}
        </div>
        {onChain ? (
          <div className="text-white">
            No <span style={{ color: RH_GREEN }}>{result.query?.tickerArg}</span> arrow on{" "}
            <span style={{ color: BLUE }}>{result.query?.chainArg === "base" ? "Base (8453)" : "Robinhood Chain (4663)"}</span>.
          </div>
        ) : (
          <div className="text-white">
            No arrow matching{" "}
            <span style={{ color: RH_GREEN }}>
              {result.query?.arrowIdArg
                ? `id ${result.query.arrowIdArg.slice(0, 8)}…`
                : result.query?.serialArg
                  ? `#${result.query.serialArg}`
                  : result.query?.tickerArg ?? "your query"}
            </span>
            .
          </div>
        )}
        {result.other_chain && (
          <div className="mt-1">
            The other desk has one:{" "}
            <span style={{ color: RH_GREEN }}>{result.other_chain.serial}</span> on{" "}
            <span style={{ color: BLUE }}>{result.other_chain.chain}</span> — a different question, not this answer.
          </div>
        )}
        <div className="mt-1">Check <Link href="/hood/inbox" className="underline">/hood/inbox</Link> for every fired arrow.</div>
      </div>
    );
  }

  const a = result.arrow;
  if (!a) return null;
  const brief = a.brief;
  const facts = brief?.facts_at_fire;
  // Prefer the server's resolved value, but fall back through `chainOf` rather
  // than to a blank: a card that omits the desk is exactly how a Robinhood
  // arrow got read as Base. Never `a.chain` bare — it is absent on legacy rows.
  const chain = result.chain ?? chainOf(a);
  const ageLabel = formatAge(result.age_hours ?? hoursSince(a.fired_at));
  const outcome = (() => {
    if (a.status === "open") return { label: "WATCHING", color: BLUE };
    if (a.outcome === "hit") return { label: "HIT", color: GREEN_TEXT };
    if (a.outcome === "miss") return { label: "MISS", color: RED };
    if (a.outcome === "informational") return { label: "INFO", color: MUTED };
    return { label: "—", color: MUTED };
  })();

  return (
    <div
      className="rounded border overflow-hidden"
      style={{ borderColor: BORDER, backgroundColor: SURFACE, fontFamily: "'JetBrains Mono', ui-monospace, monospace" }}
    >
      {/* ── Header strip ────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 px-3 py-2 border-b" style={{ borderColor: "#0f1218" }}>
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="text-[11px]" style={{ color: RH_GREEN }}>{a.serial}</span>
          <span className="text-[14px] font-semibold text-white truncate">{a.ticker}</span>
          {/* #206 — NVDA/META/GOOGL exist on both desks, so ticker alone names
              nothing. The badge sits next to the ticker it qualifies. */}
          <span
            className="rounded px-1.5 py-0.5 text-[9px] font-semibold tracking-wider shrink-0"
            style={{ color: BLUE, backgroundColor: `${BLUE}18` }}
            title={`This arrow fired on ${CHAIN_LABEL[chain]} — the other desk's numbers are not interchangeable`}
          >
            {CHAIN_LABEL[chain]}
          </span>
          <span className="text-[10px] uppercase" style={{ color: MUTED, letterSpacing: "0.08em" }}>
            {result.signal ?? a.type}
          </span>
        </div>
        {/* Age, so a three-day-old graded arrow cannot read as "right now". */}
        {ageLabel && (
          <span className="ml-auto text-[10px] shrink-0" style={{ color: MUTED }} title={`fired ${a.fired_at}`}>
            {ageLabel}
          </span>
        )}
        <span
          className={`${ageLabel ? "" : "ml-auto "}rounded px-2 py-0.5 text-[10px] font-semibold tracking-wider shrink-0`}
          style={{ color: outcome.color, backgroundColor: `${outcome.color}18` }}
        >
          {outcome.label}
        </span>
      </div>

      {/* ── Verdict + context ───────────────────────────────────────── */}
      <div className="px-3 py-3 space-y-1.5 text-[12px]">
        {brief?.verdict_note && (
          <div className="text-white leading-relaxed">{brief.verdict_note}</div>
        )}
        {brief?.one_line_context && (
          <div className="italic" style={{ color: "#cbd5e1" }}>
            &ldquo;{brief.one_line_context}&rdquo;
          </div>
        )}
        {!brief?.verdict_note && a.brief_status === "pending" && (
          <div className="text-[11px] flex items-center gap-2" style={{ color: MUTED }}>
            <span
              className="w-1.5 h-1.5 rounded-full animate-pulse"
              style={{ backgroundColor: AMBER, boxShadow: `0 0 6px ${AMBER}80` }}
              aria-hidden
            />
            brief attaching…
          </div>
        )}
        {!brief?.verdict_note && a.brief_status !== "pending" && (
          <div className="text-[11px]" style={{ color: MUTED }}>
            Brief unavailable — verdict + numbers still stand on their own.
          </div>
        )}
      </div>

      {/* ── Facts strip (mono, tabular) ─────────────────────────────── */}
      {facts && (
        <div
          className="mx-3 mb-3 rounded border px-2 py-1.5 text-[11px]"
          style={{ borderColor: BORDER, backgroundColor: "#0a0c11", color: "#9aa1ac" }}
        >
          <div className="mb-1 text-[9px] uppercase" style={{ color: MUTED, letterSpacing: "0.15em" }}>
            facts at fire
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-0.5 tabular-nums">
            <FactPair k="dex" v={facts.dex_price_usd !== null ? `$${facts.dex_price_usd.toFixed(4)}` : "—"} />
            <FactPair k="oracle" v={facts.oracle_price_usd !== null ? `$${facts.oracle_price_usd.toFixed(4)}` : "—"} />
            <FactPair k="tvl" v={facts.dex_tvl_usd !== null ? formatUsd(facts.dex_tvl_usd) : "—"} />
            <FactPair k="vol 24h" v={facts.dex_volume_24h_usd !== null ? formatUsd(facts.dex_volume_24h_usd) : "—"} />
            <FactPair k="chg 24h" v={facts.dex_change_24h_pct !== null ? `${facts.dex_change_24h_pct.toFixed(2)}%` : "—"} />
            <FactPair k="feed age" v={facts.chainlink_age_seconds !== null ? `${facts.chainlink_age_seconds}s` : "—"} />
          </div>
        </div>
      )}

      {/* ── Actions ─────────────────────────────────────────────────── */}
      <ActionsRow arrow={a} deepLink={result.deep_link} />
    </div>
  );
}

function FactPair({ k, v }: { k: string; v: string }) {
  return (
    <span>
      <span style={{ color: MUTED }}>{k}</span> {v}
    </span>
  );
}

/**
 * T-E entry point in the chat card. Opens the ReviewSignPanel modal
 * when clicked. The panel does its own guard-railing; the card just
 * disables the button when the arrow is graded (informational).
 * "you traded this arrow" line only renders when we know a wallet-
 * matching action is present — kept simple in v1 (all actions shown,
 * not filtered by connected wallet; connected wallet visibility is
 * handled inside ReviewSignPanel).
 */
function ActionsRow({ arrow, deepLink }: { arrow: Arrow; deepLink?: { inbox: string; board: string; track: string } }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const arrowOpen = arrow.status === "open";
  const traded = (arrow.user_actions ?? []).length > 0;

  // Public, no-wallet permalink — always the canonical main host so a pasted
  // link unfurls the OG card and is indexable, regardless of which host the app
  // is served from.
  const serialParam = arrow.serial.replace(/^#/, "");
  const shareUrl = `https://blueagent.dev/share/arrow/${serialParam}`;
  const onShare = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard blocked (permissions / insecure ctx) — open the permalink so
      // the user can copy it from the address bar.
      window.open(shareUrl, "_blank", "noopener");
    }
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 px-3 pb-3">
        <button
          type="button"
          onClick={() => setOpen(true)}
          disabled={!arrowOpen}
          className="rounded border px-3 py-1.5 text-[11px] font-semibold hover:bg-black/40 disabled:opacity-50 disabled:cursor-not-allowed"
          style={{ borderColor: RH_GREEN, color: RH_GREEN }}
          title={arrowOpen ? "Open the trade panel" : "Signal closed — read-only"}
        >
          {arrowOpen ? "[Review & Sign]" : "[Signal closed]"}
        </button>
        <button
          type="button"
          onClick={onShare}
          className="rounded border px-3 py-1.5 text-[11px] hover:text-white"
          style={{ borderColor: copied ? RH_GREEN : BORDER, color: copied ? RH_GREEN : MUTED }}
          title="Copy the public share link for this signal"
        >
          {copied ? "✓ link copied" : "Share ↗"}
        </button>
        <Link
          href={deepLink?.inbox ?? `/hood/inbox#${arrow.id}`}
          className="rounded border px-3 py-1.5 text-[11px] hover:text-white"
          style={{ borderColor: BORDER, color: MUTED }}
        >
          Open in inbox →
        </Link>
        {traded && (
          <span className="text-[10px]" style={{ color: RH_GREEN }} title="A trade has been recorded on this arrow">
            ● traded ({(arrow.user_actions ?? []).length})
          </span>
        )}
        <Link
          href={deepLink?.track ?? "/hood/arrows"}
          className="ml-auto text-[10px] hover:text-white"
          style={{ color: MUTED }}
        >
          track record
        </Link>
      </div>
      {open && (
        <ReviewSignPanel arrow={arrow} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

function hoursSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? (Date.now() - t) / 3_600_000 : null;
}

/** "2h ago" / "3d ago". Null when the timestamp is unreadable — a missing age
 *  is better than a wrong one, and "just now" is the wrong guess. */
function formatAge(h: number | null | undefined): string | null {
  if (h === null || h === undefined || !Number.isFinite(h) || h < 0) return null;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m ago`;
  if (h < 48) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function formatUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n > 0) return `$${n.toFixed(4)}`;
  return "$0";
}
