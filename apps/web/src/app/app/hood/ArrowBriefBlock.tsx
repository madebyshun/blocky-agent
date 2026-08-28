"use client";

/**
 * Blue Hood — shared arrow-brief expand block.
 *
 * Used by both `/hood`'s Arrows Feed row expand and `/hood/arrows`'s
 * track-record row expand. Renders the deterministic verdict_note, the
 * LLM one_line_context, A4's warnings verbatim, the facts_at_fire
 * receipt strip, the provenance chain trace, and (once graded) the
 * grader's outcome_detail line. Empty-state falls back to a note that
 * the brief pipeline was unavailable at fire time.
 */
import type { Arrow, ArrowBrief } from "@/lib/blue-hood/types";

const RH_GREEN = "#34D399";
const BLUE = "#4FC3F7";
const AMBER = "#f5b342";
const MUTED = "#6b7280";
const BORDER = "#1A1A2E";

export default function ArrowBriefBlock({
  a,
  hasBrief,
}: {
  a: Arrow;
  hasBrief: boolean;
}) {
  return (
    <div className="flex flex-col gap-2 text-[12px]">
      {hasBrief ? (
        <>
          <div className="font-mono text-white leading-relaxed">
            {a.brief!.verdict_note}
          </div>
          {a.brief!.one_line_context && (
            <div className="italic" style={{ color: "#cbd5e1" }}>
              &ldquo;{a.brief!.one_line_context}&rdquo;
            </div>
          )}
          {a.brief!.warnings.length > 0 && (
            <ul className="mt-1 space-y-1">
              {a.brief!.warnings.map((w, i) => (
                <li key={i} className="font-mono text-[11px]" style={{ color: AMBER }}>
                  ⚠ {w}
                </li>
              ))}
            </ul>
          )}
          <FactsAtFire brief={a.brief!} />
          <div className="pt-1 font-mono text-[10px]" style={{ color: MUTED }}>
            brief · {a.brief!.llm_provider ?? "no LLM"} · chain{" "}
            {a.brief!.llm_attempts.map((att) => `${att.provider}:${att.status}`).join("→") || "n/a"}
            {" "}· {formatRelTime(a.brief!.fetched_at)}
          </div>
        </>
      ) : a.brief_status === "pending" ? (
        <div className="font-mono text-[11px] flex items-center gap-2" style={{ color: MUTED }}>
          <span
            className="w-1.5 h-1.5 rounded-full animate-pulse"
            style={{ backgroundColor: AMBER, boxShadow: `0 0 6px ${AMBER}80` }}
            aria-hidden
          />
          brief attaching… (async worker runs every minute — refresh in a moment)
        </div>
      ) : a.brief_status === "failed" ? (
        <div className="hood-prose text-[13px] leading-relaxed" style={{ color: MUTED }}>
          Brief unavailable — A4 chain failed for this arrow. Numbers still stand on their own.
        </div>
      ) : (
        // brief_status "skipped" (or absent). Deliberately states NO cause: this
        // branch covers both "seeded arrow, brief skipped on purpose" and "Base
        // arrow, A4 is Robinhood-only" — and the old copy asserted "A4 was
        // unavailable", which is untrue of both.
        <div className="hood-prose text-[13px] leading-relaxed" style={{ color: MUTED }}>
          No brief attached to this arrow. Numbers still stand on their own.
        </div>
      )}
      {a.outcome_detail && (
        <div
          className="mt-2 rounded border px-2 py-1.5 font-mono text-[11px]"
          style={{ borderColor: BORDER, color: "#E7E9EE" }}
        >
          <span style={{ color: MUTED }}>outcome · </span>{a.outcome_detail}
        </div>
      )}
    </div>
  );
}

function FactsAtFire({ brief }: { brief: ArrowBrief }) {
  const f = brief.facts_at_fire;
  if (!f) return null;
  // Use formatUsd for DEX + oracle so RWA stock prices (SNDK $54.78, INTC
  // $23.12, etc.) render with 2 decimals instead of 4. The helper still
  // falls back to 4 decimals for sub-$1 tokens, so degen coins keep their
  // precision. Was: `.toFixed(4)` unconditional — read as "$54.7830" for
  // stocks, which looked broken.
  const pairs: [string, string][] = [
    ["dex", formatUsd(f.dex_price_usd)],
    ["oracle", formatUsd(f.oracle_price_usd)],
    ["tvl", f.dex_tvl_usd !== null ? formatUsd(f.dex_tvl_usd) : "—"],
    ["vol 24h", f.dex_volume_24h_usd !== null ? formatUsd(f.dex_volume_24h_usd) : "—"],
    ["chg 24h", f.dex_change_24h_pct !== null ? `${f.dex_change_24h_pct.toFixed(2)}%` : "—"],
    ["feed age", f.chainlink_age_seconds !== null ? `${f.chainlink_age_seconds}s` : "—"],
  ];
  return (
    <div
      className="mt-2 rounded border px-2 py-1.5 font-mono text-[11px]"
      style={{ borderColor: BORDER, backgroundColor: "#0a0c11", color: "#9aa1ac" }}
    >
      <div className="mb-1 font-mono text-[9px] uppercase tracking-widest" style={{ color: MUTED }}>
        facts at fire · anything in the brief above should reconcile against these
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-0.5">
        {pairs.map(([k, v]) => (
          <span key={k}>
            <span style={{ color: MUTED }}>{k}</span> {v}
          </span>
        ))}
      </div>
    </div>
  );
}

function formatUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n > 0) return `$${n.toFixed(4)}`;
  return "$0";
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

// Silence conditional-render constants that aren't otherwise referenced.
void RH_GREEN;
void BLUE;
