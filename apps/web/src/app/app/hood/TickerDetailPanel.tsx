"use client";

/**
 * Blue Hood — row-expand detail panel (T-B2).
 *
 * Fetches `/api/hood/ticker-detail?ticker=X&chain=C` lazily on first mount for
 * that row (accordion pattern above collapses the previous panel, so
 * we only ever have one instance mounted). Renders:
 *   • LIQUIDITY block — deepest pool, all pools, slippage strip (M3-backed), OR
 *     the narrower row-sourced block on a desk that measures its own depth
 *   • HOLDERS block — top 5, concentration + HHI, amber when top1 > 30%
 *   • ARROW BRIEF — inline if this row has an open arrow
 *   • LINKS strip — chain's own explorer, deepest pool
 *
 * ⚠️ `chain` IS REQUIRED AND IS NOT DECORATIVE. The two upstream tools take a
 * BARE TICKER and read Robinhood Chain only, so before this prop existed every
 * Base row rendered RH pools, RH TVL, RH holders and an RH slippage table under
 * a BASE badge — NVDA showed $109.52M against $1.71M in its own row. What the
 * panel may show per chain is decided in `blue-hood/detail-support.ts`, which is
 * dependency-free precisely so a script can test it; this file is a `"use
 * client"` tree nothing can import. Do not re-derive the decision here.
 *
 * ⚠️ THE OVERCORRECTION IS ALSO A BUG. The first fix for the above skipped BOTH
 * blocks on every non-RH chain, so a Base row said "Liquidity is not wired for
 * this desk" directly beneath its own TVL $1.90M / VOL 24H $10.43M. What is
 * RH-only is the M3 TOOL, not the data — hence three sources, not a boolean:
 * `"tool"` fetches, `"row"` reads the snapshot the board already has, `"none"`
 * draws the note. A block that shows nothing must be a block with nothing to
 * show, or every honest "skipped" note on this board gets cheaper.
 */

import { useEffect, useState } from "react";
import type { Arrow, HoodChain } from "@/lib/blue-hood/types";
import {
  detailPanelPlan,
  explorerAddressUrl,
  explorerTokenUrl,
  rowLiquidityView,
  type RowLiquidity,
} from "@/lib/blue-hood/detail-support";
import TickerChart from "@/components/blue-hood/TickerChart";

const BORDER = "#1A1A2E";
const SURFACE = "#0B0D13";
const MUTED = "#6b7280";
const AMBER = "#f5b342";
const GREEN = "#22c55e";
const RH_GREEN = "#34D399";

interface DetailPool {
  name?: string;
  dex?: string;
  reserve_usd?: number;
  volume_24h_usd?: number;
  pool_ref?: string;
  url?: string;
}
interface DetailHolder {
  address?: string;
  share_pct?: number;
  balance?: string;
}
interface Detail {
  ticker: string;
  fetched_at: string;
  liquidity: {
    total_tvl_usd?: number;
    pool_count?: number;
    deepest_pool?: DetailPool;
    pools?: DetailPool[];
    slippage_upper_bound?: {
      method?: string;
      note?: string;
      estimates?: { trade_size_usd?: number; slippage_pct_upper?: number | null; exceeds_pool_one_side?: boolean }[];
    };
    warnings?: string[];
    explorer_url?: string;
    error?: string;
  } | null;
  holders: {
    holders?: DetailHolder[];
    concentration?: { top1_pct?: number | null; top10_pct?: number | null; hhi?: number | null };
    warnings?: string[];
    error?: string;
  } | null;
}

export default function TickerDetailPanel({
  ticker,
  chain,
  contract,
  openArrow,
  rowLiquidity,
}: {
  ticker: string;
  chain: HoodChain;
  contract: string;
  openArrow: Arrow | null;
  /**
   * The row's OWN depth figures, for desks whose poll measures them (Base).
   * Required, not optional: a call site that omits it would silently fall back
   * to "no reading this cycle" on a token the desk measures every cycle, which
   * is the understating twin of the bug this panel already carries a header
   * about. Pass `null` only for a desk that genuinely has none.
   */
  rowLiquidity: RowLiquidity | null;
}) {
  const plan = detailPanelPlan(chain);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [cache, setCache] = useState<boolean>(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    // No source for this chain ⟹ do not call. Fetching and then hiding would
    // still burn two 15s tool calls AND leave the provenance line below saying
    // "fresh · updated 5s ago", which asserts a measurement on THIS desk that
    // never happened. The absence has to go all the way down.
    if (!detailPanelPlan(chain).fetch) return;
    let cancelled = false;
    setDetail(null);
    setErr(null);
    (async () => {
      try {
        const r = await fetch(
          `/api/hood/ticker-detail?ticker=${encodeURIComponent(ticker)}&chain=${encodeURIComponent(chain)}`,
          { cache: "no-store" },
        );
        const body = await r.json() as { ok: boolean; detail?: Detail; cache?: boolean; error?: string };
        if (cancelled) return;
        if (body.ok && body.detail) {
          setDetail(body.detail);
          setCache(!!body.cache);
        } else {
          setErr(body.error ?? "detail unavailable");
        }
      } catch (e) {
        if (!cancelled) setErr((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [ticker, chain]);

  // NO TOOL FETCH ON THIS CHAIN — which is not the same as no data, and the
  // difference is the whole point of `DetailSource`. On Base the desk's own poll
  // has already measured depth, so `plan.liquidity === "row"` says to draw it
  // from the snapshot row instead of from M3. The previous version of this
  // branch rendered the note alone for every non-RH chain, which put "Liquidity
  // is not wired for this desk" an inch below a row printing TVL $1.90M.
  //
  // The provenance line deliberately does NOT say "fresh · updated Ns ago" here:
  // nothing was fetched by this panel. It names the desk, and the row block
  // carries its own age implicitly by being this cycle's snapshot.
  if (!plan.fetch) {
    return (
      <div className="flex flex-col gap-4 text-[12px]">
        <div className="flex items-center gap-3 font-mono text-[10px]" style={{ color: MUTED }}>
          <span>{chain} desk</span>
          <a
            href={explorerTokenUrl(chain, contract)}
            target="_blank"
            rel="noreferrer"
            className="ml-auto hover:text-white"
          >
            contract ↗
          </a>
        </div>
        {/* PRICE HISTORY is on BOTH branches, unlike liquidity/holders. Those
            depend on an RH-only tool; this reads the permanent archive, which
            both desks write. A Base row showing no chart while an RH row shows
            one would repeat the overcorrection warned about in this file's
            header — a block empty for a reason the data does not have. */}
        <Section label="// PRICE HISTORY">
          <TickerChart ticker={ticker} chain={chain} />
        </Section>
        <Section label="// LIQUIDITY">
          {plan.liquidity === "row" ? (
            <RowLiquidityBlock chain={chain} row={rowLiquidity} note={plan.liquidityNote} />
          ) : (
            <p className="font-mono text-[11px] leading-relaxed" style={{ color: MUTED }}>
              {plan.liquidityNote}
            </p>
          )}
        </Section>
        <Section label="// HOLDERS">
          <p className="font-mono text-[11px] leading-relaxed" style={{ color: MUTED }}>
            {plan.holdersNote}
          </p>
        </Section>
        <OpenArrowSection openArrow={openArrow} />
      </div>
    );
  }

  if (err) {
    return (
      <div className="rounded border px-3 py-2 text-sm font-mono" style={{ borderColor: BORDER, color: "#f6c88f", backgroundColor: "#1a1408" }}>
        detail unavailable · {err} · <RetryButton />
      </div>
    );
  }
  if (!detail) {
    return <DetailSkeleton />;
  }

  const liq = detail.liquidity;
  const hol = detail.holders;
  return (
    <div className="flex flex-col gap-4 text-[12px]">
      {/* Provenance */}
      <div className="flex items-center gap-3 font-mono text-[10px]" style={{ color: MUTED }}>
        <span>{cache ? "cached" : "fresh"}</span>
        <span>·</span>
        <span>updated {relTime(detail.fetched_at)}</span>
        <a
          href={liq?.explorer_url ?? explorerTokenUrl(chain, contract)}
          target="_blank"
          rel="noreferrer"
          className="ml-auto hover:text-white"
        >
          contract ↗
        </a>
      </div>

      {/* PRICE HISTORY — archive-sourced, so it renders on every desk. */}
      <Section label="// PRICE HISTORY">
        <TickerChart ticker={ticker} chain={chain} />
      </Section>

      {/* LIQUIDITY */}
      <Section label="// LIQUIDITY">
        {liq?.error ? (
          <p className="font-mono text-[11px]" style={{ color: MUTED }}>M3 error: {liq.error}</p>
        ) : liq ? (
          <>
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-[12px]">
              <div><span style={{ color: MUTED }}>total tvl</span> {fmtUsd(liq.total_tvl_usd)}</div>
              <div><span style={{ color: MUTED }}>pool count</span> {liq.pool_count ?? "—"}</div>
              <div className="col-span-2">
                <span style={{ color: MUTED }}>deepest</span>{" "}
                {liq.deepest_pool?.url ? (
                  <a href={liq.deepest_pool.url} target="_blank" rel="noreferrer" className="hover:underline text-white">
                    {liq.deepest_pool.dex ?? "?"} · {fmtUsd(liq.deepest_pool.reserve_usd)}
                  </a>
                ) : (
                  <span>—</span>
                )}
              </div>
            </div>
            {liq.pools && liq.pools.length > 0 && (
              <div className="mt-2">
                <div className="mb-1 font-mono text-[9px] uppercase tracking-widest" style={{ color: MUTED }}>pools</div>
                <ul className="space-y-0.5">
                  {liq.pools.slice(0, 5).map((p, i) => (
                    <li key={i} className="font-mono text-[11px] flex flex-wrap gap-x-3">
                      <span className="text-white">{p.dex ?? "?"}</span>
                      <span style={{ color: MUTED }}>tvl {fmtUsd(p.reserve_usd)}</span>
                      <span style={{ color: MUTED }}>vol24 {fmtUsd(p.volume_24h_usd)}</span>
                      {p.url && (
                        <a href={p.url} target="_blank" rel="noreferrer" className="ml-auto text-slate-500 hover:text-white">↗</a>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {liq.slippage_upper_bound?.estimates && liq.slippage_upper_bound.estimates.length > 0 && (
              <div className="mt-2">
                <div className="mb-1 font-mono text-[9px] uppercase tracking-widest" style={{ color: MUTED }}>slippage upper bound · xy=k</div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px]">
                  {liq.slippage_upper_bound.estimates.map((e, i) => (
                    <span key={i}>
                      <span style={{ color: MUTED }}>${e.trade_size_usd?.toLocaleString()}</span>{" "}
                      <span style={{ color: e.exceeds_pool_one_side ? AMBER : "#E7E9EE" }}>
                        {e.slippage_pct_upper === null || e.slippage_pct_upper === undefined ? "—" : `${e.slippage_pct_upper.toFixed(2)}%`}
                      </span>
                    </span>
                  ))}
                </div>
                {liq.slippage_upper_bound.note && (
                  <p className="mt-1 font-mono text-[10px]" style={{ color: MUTED }}>{liq.slippage_upper_bound.note}</p>
                )}
              </div>
            )}
            {liq.warnings && liq.warnings.length > 0 && (
              <ul className="mt-2 space-y-0.5 font-mono text-[11px]" style={{ color: AMBER }}>
                {liq.warnings.map((w, i) => <li key={i}>⚠ {w}</li>)}
              </ul>
            )}
          </>
        ) : (
          <p className="font-mono text-[11px]" style={{ color: MUTED }}>no data</p>
        )}
      </Section>

      {/* HOLDERS */}
      <Section label="// HOLDERS">
        {hol?.error ? (
          <p className="font-mono text-[11px]" style={{ color: MUTED }}>D1 error: {hol.error}</p>
        ) : hol ? (
          <>
            <div className="grid grid-cols-3 gap-x-6 font-mono text-[12px]">
              <div>
                <span style={{ color: MUTED }}>top 1</span>{" "}
                <span style={{ color: (hol.concentration?.top1_pct ?? 0) > 30 ? AMBER : "#E7E9EE" }}>
                  {fmtPct(hol.concentration?.top1_pct ?? null)}
                </span>
              </div>
              <div>
                <span style={{ color: MUTED }}>top 10</span> {fmtPct(hol.concentration?.top10_pct ?? null)}
              </div>
              <div>
                <span style={{ color: MUTED }}>HHI</span> {hol.concentration?.hhi ?? "—"}
              </div>
            </div>
            {hol.holders && hol.holders.length > 0 && (
              <ul className="mt-2 space-y-0.5">
                {hol.holders.slice(0, 5).map((h, i) => (
                  <li key={h.address ?? i} className="font-mono text-[11px] flex items-center gap-3">
                    <span className="text-slate-500 tabular-nums">{i + 1}.</span>
                    <a
                      href={h.address ? explorerAddressUrl(chain, h.address) : "#"}
                      target="_blank"
                      rel="noreferrer"
                      className="text-slate-300 hover:text-white truncate max-w-[240px]"
                    >
                      {h.address ?? "?"}
                    </a>
                    <span className="ml-auto tabular-nums" style={{ color: (h.share_pct ?? 0) > 30 ? AMBER : "#9aa1ac" }}>
                      {fmtPct(h.share_pct ?? null)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {(hol.concentration?.top1_pct ?? 0) > 30 && (
              <p className="mt-2 font-mono text-[11px]" style={{ color: AMBER }}>
                ⚠ single holder controls &gt; 30% — watchable-but-illiquid caveat
              </p>
            )}
          </>
        ) : (
          <p className="font-mono text-[11px]" style={{ color: MUTED }}>no data</p>
        )}
      </Section>

      <OpenArrowSection openArrow={openArrow} />
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────

/**
 * Inline open-arrow brief — sourced from the parent to avoid a second fetch.
 *
 * Extracted so the skipped-chain branch renders THE SAME component rather than
 * a copy: this block is chain-correct already (the parent matches on `chainOf`,
 * not on ticker), and it is the one thing a Base row has a real source for. A
 * duplicated JSX version would be free to drift out from under that guarantee.
 */
function OpenArrowSection({ openArrow }: { openArrow: Arrow | null }) {
  if (!openArrow) return null;
  return (
    <Section label={`// OPEN ARROW · ${openArrow.serial}`}>
      {openArrow.brief ? (
        <div className="flex flex-col gap-1.5">
          <div className="font-mono text-white leading-relaxed">{openArrow.brief.verdict_note}</div>
          {openArrow.brief.one_line_context && (
            <div className="italic" style={{ color: "#cbd5e1" }}>&ldquo;{openArrow.brief.one_line_context}&rdquo;</div>
          )}
          <div className="font-mono text-[10px]" style={{ color: MUTED }}>
            brief · {openArrow.brief.llm_provider ?? "no LLM"} · {relTime(openArrow.brief.fetched_at)}
          </div>
        </div>
      ) : (
        <div className="font-mono text-[11px]" style={{ color: MUTED }}>
          open arrow · no brief attached (A4 unavailable at fire time)
        </div>
      )}
      <div className="mt-1 font-mono text-[11px]" style={{ color: RH_GREEN }}>
        {openArrow.type.toUpperCase()} {openArrow.expected_direction === "up" ? "↑" : openArrow.expected_direction === "down" ? "↓" : ""} · ref ${openArrow.reference_price.toFixed(2)} · grading window {openArrow.grading_window_h}h
      </div>
    </Section>
  );
}

/**
 * LIQUIDITY drawn from the SNAPSHOT ROW, for a desk whose own poll measures depth.
 *
 * Deliberately narrower than the M3-backed block above: two figures and one pool
 * link — no pool count, no slippage strip. Both omissions are properties of the
 * source rather than oversights. `registry.ts` admits exactly one Aerodrome pool
 * per Base token, so a count of "1" would be a tautology dressed as a
 * measurement; and the poll records that pool's liquidity in USD but not its
 * reserves, which is what the xy=k bound needs. The caveat printed under the
 * numbers says which, so a reader comparing this against an RH panel is told why
 * it is shorter instead of being left to guess that something failed.
 *
 * The pool link is labelled with the TRUNCATED ADDRESS, not the DEX's name. A
 * hardcoded "Aerodrome" in a chain-generic component is a fact about today's
 * Base registry sitting in a file that has no way to notice when it changes;
 * the address is carried by the row and cannot go stale against it.
 */
function RowLiquidityBlock({
  chain,
  row,
  note,
}: {
  chain: HoodChain;
  row: RowLiquidity | null;
  note: string | null;
}) {
  const view = rowLiquidityView(chain, row);
  const poolLabel = row?.poolRef ? shortAddr(row.poolRef) : null;
  return (
    <>
      {view.measured ? (
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-[12px]">
          <div><span style={{ color: MUTED }}>pool tvl</span> {fmtUsd(view.tvlUsd)}</div>
          <div><span style={{ color: MUTED }}>vol 24h</span> {fmtUsd(view.volume24hUsd)}</div>
          <div className="col-span-2">
            <span style={{ color: MUTED }}>pool</span>{" "}
            {view.poolUrl && poolLabel ? (
              <a href={view.poolUrl} target="_blank" rel="noreferrer" className="text-white hover:underline">
                {poolLabel} ↗
              </a>
            ) : (
              <span style={{ color: MUTED }}>—</span>
            )}
          </div>
        </div>
      ) : (
        // Amber, not muted grey: an absent reading changes what the number below
        // the row means, so it is a warning rather than a footnote.
        <p className="font-mono text-[11px] leading-relaxed" style={{ color: AMBER }}>
          ⚠ {view.emptyNote}
        </p>
      )}
      {note && (
        <p className="mt-2 font-mono text-[10px] leading-relaxed" style={{ color: MUTED }}>
          {note}
        </p>
      )}
    </>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 font-mono text-[10px] uppercase tracking-widest" style={{ color: MUTED }}>
        {label}
      </div>
      <div className="rounded border px-3 py-2" style={{ borderColor: BORDER, backgroundColor: SURFACE }}>
        {children}
      </div>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      {[0, 1, 2].map((i) => (
        <div key={i} className="rounded border h-14 animate-pulse" style={{ borderColor: BORDER, backgroundColor: SURFACE, opacity: 0.7 }} />
      ))}
      <p className="font-mono text-[10px]" style={{ color: MUTED }}>loading M3 + D1…</p>
    </div>
  );
}

function RetryButton() {
  return <span className="underline">reload the page to retry</span>;
}

// ── Utils ──────────────────────────────────────────────────────────────────
function fmtUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n > 0) return `$${n.toFixed(4)}`;
  return "$0";
}
/** `0x1234…abcd`. Left short enough to read, long enough to check against the
 *  explorer page the link opens. */
function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}
function fmtPct(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `${n.toFixed(2)}%`;
}
function relTime(iso: string): string {
  const sec = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  return `${h}h ago`;
}

// Suppress "unused" for the GREEN token, kept for future ok-badge usage.
void GREEN;
