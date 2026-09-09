"use client";

/**
 * Blue Hood — the per-ticker price chart (#229).
 *
 * ⚠️ THIS FILE MAPS NUMBERS TO PIXELS AND DECIDES NOTHING.
 *
 * Every judgement — which hours are a hole, why, what counts as a break versus
 * an edge, what the deadband is, whether the series is drawable at all — lives
 * in `lib/blue-hood/chart-series.ts`, which is dependency-free so
 * `scripts/hood-chart-check.ts` can pin it. A `"use client"` tree is importable
 * by nothing, so a rule written here is enforced only by whoever reads the
 * diff. That is the same split `detail-support.ts` and `oracle-age.ts` use, and
 * the same reason: the panel's earlier chain bug (#161) survived review inside
 * a client component and was caught by a script the moment the rule moved out.
 *
 * The three things this file must not do, spelled out because each is one line
 * of "simplification" away:
 *
 *   1. NEVER build one polyline from `series.points`. That array is flattened
 *      for axis scaling and nothing else — drawing it joins 03:00 to 09:00
 *      across six hours nobody observed. Walk `segments`; one `<polyline>` per
 *      `run`. `seriesCoverage` warned about this in prose before any chart
 *      existed; this is where the warning either holds or doesn't.
 *   2. NEVER recompute drift from the two prices. It is copied from the archive
 *      because the desk graded its arrows against that exact number. A chart
 *      that disagrees with the receipt beside it discredits the receipt.
 *   3. NEVER draw a real price for a chain whose desk did not measure it. The
 *      component takes `chain` and renders it in the caption for the same
 *      reason the panel does: a ticker exists on both chains as different
 *      tokens, so an uncaptioned chart is an unfalsifiable claim.
 */

import { useEffect, useMemo, useState } from "react";
import {
  buildChartSeries,
  chartDomain,
  chartNote,
  hourToMs,
  isPlottable,
  type ChartGapReason,
  type ChartSegment,
  type ChartSeries,
} from "@/lib/blue-hood/chart-series";
import type { HoodChain } from "@/lib/blue-hood/types";

const BORDER = "#1A1A2E";
const MUTED = "#6b7280";
const AMBER = "#f5b342";
const ORACLE = "#8b93a7";
const DEX = "#4da3ff";

const W = 560;
const H_PRICE = 132;
const H_DRIFT = 56;
const PAD_L = 46;
const PAD_R = 8;
const PAD_T = 8;
const PAD_B = 14;

/** How each kind of nothing is drawn. Distinct fills on purpose: rendering an
 *  unreadable window the same as an unrecorded one tells the reader a KV outage
 *  and a quiet market look alike, which is the whole error the archive refuses
 *  on the read path. */
const GAP_STYLE: Record<ChartGapReason, { fill: string; label: string }> = {
  unreadable: { fill: "rgba(245,179,66,0.14)", label: "unreadable" },
  missing_day: { fill: "rgba(107,114,128,0.13)", label: "not recorded" },
  before_archive: { fill: "rgba(107,114,128,0.07)", label: "before archive" },
  hour_absent: { fill: "rgba(107,114,128,0.13)", label: "not recorded" },
  not_priced: { fill: "rgba(107,114,128,0.10)", label: "no price" },
  before_first_seen: { fill: "rgba(107,114,128,0.07)", label: "not yet listed" },
};

type ApiOk = {
  ok: true;
  ticker: string;
  chain: HoodChain;
  archive_start: string;
  complete: boolean;
  contiguous: boolean;
  plottable: boolean;
  note: string | null;
  counts: ChartSeries["counts"];
  dating: ChartSeries["dating"];
  deadband: ChartSeries["deadband"];
  segments: ChartSegment[];
};
type ApiErr = { ok: false; error?: string; reason?: string };

/** Rebuild the `ChartSeries` shape from the wire payload.
 *
 *  The route sends `segments` (the drawable form) but not `points` (the flat
 *  convenience array), because shipping both would double the payload for a
 *  field the renderer must not draw from anyway. Reconstructing it here from
 *  the runs — rather than asking the route for it — means the only flat array
 *  in this file is one this file built out of the segments it is already
 *  walking, so it cannot silently disagree with them. */
function fromApi(j: ApiOk): ChartSeries {
  return {
    ticker: j.ticker,
    chain: j.chain,
    segments: j.segments,
    points: j.segments.flatMap((s) => (s.kind === "run" ? s.points : [])),
    counts: j.counts,
    dating: j.dating,
    deadband: j.deadband,
  };
}

function fmtUsd(n: number | null): string {
  if (n === null) return "—";
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function TickerChart({
  ticker,
  chain,
  days = 14,
}: {
  ticker: string;
  chain: HoodChain;
  days?: number;
}) {
  const [data, setData] = useState<ApiOk | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setData(null);
    setErr(null);
    // `chain` is in the query string, never assumed. The route 400s without it
    // rather than defaulting — see its header for why the most under-specified
    // request must not get the most confident answer.
    fetch(
      `/api/hood/ticker-series?ticker=${encodeURIComponent(ticker)}&chain=${encodeURIComponent(chain)}&days=${days}`,
    )
      .then(async (r) => {
        const j: ApiOk | ApiErr = await r.json();
        if (!live) return;
        if (!j.ok) {
          setErr(j.error ?? j.reason ?? `HTTP ${r.status}`);
          return;
        }
        setData(j);
      })
      .catch((e: unknown) => live && setErr((e as Error).message));
    return () => {
      live = false;
    };
  }, [ticker, chain, days]);

  const series = useMemo(() => (data ? fromApi(data) : null), [data]);

  if (err) {
    // "Could not read" — never "no data". The distinction is the archive's
    // central rule and it does not get to lapse in the failure branch.
    return (
      <p className="font-mono text-[11px] leading-relaxed" style={{ color: AMBER }}>
        history unavailable · {err}
      </p>
    );
  }
  if (!series || !data) {
    return (
      <div className="h-[188px] w-full animate-pulse rounded" style={{ backgroundColor: "#0E1017" }} />
    );
  }

  const note = chartNote(series);
  if (!isPlottable(series)) {
    return (
      <p className="font-mono text-[11px] leading-relaxed" style={{ color: MUTED }}>
        {note ?? "Nothing on record for this window."}
      </p>
    );
  }

  const domain = chartDomain(series)!;
  const span = domain.to_ms - domain.from_ms;
  const x = (hour: string) =>
    PAD_L + ((hourToMs(hour) - domain.from_ms) / span) * (W - PAD_L - PAD_R);

  // Price scale spans BOTH series so oracle and DEX are directly comparable —
  // separate scales would make a 0.2% drift look like a chasm or vanish, and
  // the whole point of this chart is the distance between the two lines.
  const prices = series.points.flatMap((p) =>
    [p.oracle_usd, p.dex_usd].filter((v): v is number => v !== null),
  );
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  const padY = (hi - lo) * 0.12 || Math.max(hi * 0.001, 0.01);
  const yPrice = (v: number) =>
    PAD_T + (1 - (v - (lo - padY)) / (hi + padY - (lo - padY))) * (H_PRICE - PAD_T - PAD_B);

  // Drift scale is symmetric around zero and never narrower than the deadband,
  // so the band is always visible at its true relative size. Letting the scale
  // shrink to the data would render a window that never left the deadband as a
  // dramatic full-height wiggle — technically auto-scaled, and the single most
  // misleading thing this chart could do given that 92% of production readings
  // sit inside that band.
  const drifts = series.points.flatMap((p) => (p.drift_pct === null ? [] : [Math.abs(p.drift_pct)]));
  const dMax = Math.max(series.deadband.abs_pct * 1.25, ...drifts, 0.001);
  const yDrift = (v: number) =>
    H_PRICE + PAD_T + (1 - (v + dMax) / (2 * dMax)) * (H_DRIFT - PAD_T - PAD_B);

  const gapRects = series.segments.flatMap((s) =>
    s.kind === "gap" ? [{ seg: s, x0: x(s.from_hour), x1: x(s.to_hour) + 2 }] : [],
  );

  return (
    <div className="flex flex-col gap-1.5">
      <svg
        viewBox={`0 0 ${W} ${H_PRICE + H_DRIFT}`}
        className="w-full"
        role="img"
        aria-label={`${ticker} on the ${chain} desk — oracle and DEX price, ${series.counts.plotted} hourly points from the archive`}
      >
        {/* Gap bands, drawn UNDER the lines. Only interior gaps land inside the
            domain at all; the edges map outside it and are stated in the
            caption instead — see `chartDomain`. */}
        {gapRects.map(({ seg, x0, x1 }, i) =>
          x1 < PAD_L || x0 > W - PAD_R ? null : (
            <rect
              key={`g${i}`}
              x={Math.max(x0, PAD_L)}
              y={PAD_T}
              width={Math.max(Math.min(x1, W - PAD_R) - Math.max(x0, PAD_L), 1)}
              height={H_PRICE + H_DRIFT - PAD_T - PAD_B}
              fill={GAP_STYLE[seg.reason].fill}
            />
          ),
        )}

        {/* Deadband: everything between ±0.5%. Drawn, not annotated, because a
            reader comparing a wiggle to a footnote will not do it. */}
        <rect
          x={PAD_L}
          y={yDrift(series.deadband.abs_pct)}
          width={W - PAD_L - PAD_R}
          height={yDrift(-series.deadband.abs_pct) - yDrift(series.deadband.abs_pct)}
          fill="rgba(107,114,128,0.16)"
        />
        <line
          x1={PAD_L}
          x2={W - PAD_R}
          y1={yDrift(0)}
          y2={yDrift(0)}
          stroke={BORDER}
          strokeWidth={1}
        />

        {/* ONE POLYLINE PER RUN. Never one through `series.points`. */}
        {series.segments.map((s, i) =>
          s.kind !== "run" ? null : (
            <g key={`r${i}`}>
              <polyline
                fill="none"
                stroke={ORACLE}
                strokeWidth={1}
                points={s.points
                  .flatMap((p) => (p.oracle_usd === null ? [] : [`${x(p.hour)},${yPrice(p.oracle_usd)}`]))
                  .join(" ")}
              />
              <polyline
                fill="none"
                stroke={DEX}
                strokeWidth={1.25}
                points={s.points
                  .flatMap((p) => (p.dex_usd === null ? [] : [`${x(p.hour)},${yPrice(p.dex_usd)}`]))
                  .join(" ")}
              />
              <polyline
                fill="none"
                stroke={AMBER}
                strokeWidth={1}
                points={s.points
                  .flatMap((p) => (p.drift_pct === null ? [] : [`${x(p.hour)},${yDrift(p.drift_pct)}`]))
                  .join(" ")}
              />
            </g>
          ),
        )}

        <text x={2} y={yPrice(hi)} fill={MUTED} fontSize={8} fontFamily="ui-monospace, monospace">
          {fmtUsd(hi)}
        </text>
        <text x={2} y={yPrice(lo)} fill={MUTED} fontSize={8} fontFamily="ui-monospace, monospace">
          {fmtUsd(lo)}
        </text>
        <text x={2} y={yDrift(0) + 3} fill={MUTED} fontSize={8} fontFamily="ui-monospace, monospace">
          0%
        </text>
        <text
          x={2}
          y={yDrift(series.deadband.abs_pct) + 3}
          fill={MUTED}
          fontSize={8}
          fontFamily="ui-monospace, monospace"
        >
          {series.deadband.abs_pct}%
        </text>
      </svg>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[9px]" style={{ color: MUTED }}>
        <span style={{ color: ORACLE }}>── oracle</span>
        <span style={{ color: DEX }}>── dex</span>
        <span style={{ color: AMBER }}>── drift</span>
        <span>
          band = ±{series.deadband.abs_pct}% feed deadband · {series.deadband.inside}/
          {series.deadband.graded} readings inside
        </span>
        <span className="ml-auto">
          {series.counts.plotted}h on record · {chain} desk
        </span>
      </div>

      {/* The caveats, in the one place a reader is already looking. Each is
          rendered only when it is TRUE — a permanently-visible disclaimer is a
          disclaimer nobody reads, which is how the honest ones get cheaper. */}
      {note && (
        <p className="font-mono text-[10px] leading-relaxed" style={{ color: MUTED }}>
          {note}
        </p>
      )}
      {!data.complete && (
        <p className="font-mono text-[10px] leading-relaxed" style={{ color: AMBER }}>
          Part of this window could not be read. Its contents are unknown — not empty.
        </p>
      )}
      {series.counts.trailing_hours > 0 && (
        <p className="font-mono text-[10px] leading-relaxed" style={{ color: AMBER }}>
          No observation in the last {series.counts.trailing_hours}h — the line ends before the
          window does.
        </p>
      )}
      {series.dating.supported && series.dating.predates_field > 0 && (
        <p className="font-mono text-[10px] leading-relaxed" style={{ color: MUTED }}>
          {series.dating.predates_field} of {series.counts.plotted} points predate the oracle-round
          field, so their drift cannot be separated from a stale feed.
        </p>
      )}
      {!series.dating.supported && (
        <p className="font-mono text-[10px] leading-relaxed" style={{ color: MUTED }}>
          This desk does not record oracle rounds, so no reading here can be dated against the feed.
        </p>
      )}
    </div>
  );
}
