"use client";

/**
 * /track client island — the public receipt book.
 *
 * Renders a server-provided, already-gated `PublicTrackRecord` (no client fetch:
 * SEO + the gate both want the data resolved server-side). Pure presentation +
 * client-side filter/sort over `record.receipts.arrows`.
 *
 * THE GATE, restated in the UI: `headline.hit_rate` is either
 * `{ready:true,pct}` or `{ready:false,graded,needed}`. When not ready this
 * component renders "warming up · N/needed" and NOTHING that discloses the rate
 * — no pct, no hits/misses aggregate. Individual arrow outcomes still show
 * (that's the evidence, and misses are the point).
 */
import { useMemo, useState } from "react";
import Link from "next/link";
import type { Arrow } from "@/lib/blue-hood/types";
import type { PublicTrackRecord, PublicPerTypeStats } from "@/lib/blue-hood/track-record-public";

const RH_GREEN = "#00C805";
const BLUE = "#4FC3F7";
const RED = "#ef4444";
const GREEN = "#22c55e";
const AMBER = "#f5b342";
const MUTED = "#6b7280";
const SURFACE = "#0B0D13";
const BORDER = "#1A1A2E";

type OutcomeFilter = "all" | "hit" | "miss" | "void" | "open";
type TypeFilter = "all" | "arb" | "drift" | "flow";
type SortKey = "newest" | "oldest" | "duration";

const PAGE_SIZE = 50;

export default function TrackView({ record }: { record: PublicTrackRecord }) {
  const arrows = record.receipts.arrows;
  const [outcome, setOutcome] = useState<OutcomeFilter>("all");
  const [ttype, setTtype] = useState<TypeFilter>("all");
  const [sort, setSort] = useState<SortKey>("newest");
  const [rulesOpen, setRulesOpen] = useState(false);
  const [page, setPage] = useState(1);

  const filtered = useMemo<Arrow[]>(() => {
    let list = arrows;
    if (outcome === "hit") list = list.filter((a) => a.outcome === "hit");
    else if (outcome === "miss") list = list.filter((a) => a.outcome === "miss");
    else if (outcome === "void") list = list.filter((a) => a.outcome === "void");
    else if (outcome === "open") list = list.filter((a) => a.status === "open");
    if (ttype !== "all") list = list.filter((a) => a.type === ttype);
    return [...list].sort((a, b) => {
      if (sort === "newest") return new Date(b.fired_at).getTime() - new Date(a.fired_at).getTime();
      if (sort === "oldest") return new Date(a.fired_at).getTime() - new Date(b.fired_at).getTime();
      const durA = a.graded_at ? new Date(a.graded_at).getTime() - new Date(a.fired_at).getTime() : Infinity;
      const durB = b.graded_at ? new Date(b.graded_at).getTime() - new Date(b.fired_at).getTime() : Infinity;
      return durB - durA;
    });
  }, [arrows, outcome, ttype, sort]);

  const paged = filtered.slice(0, page * PAGE_SIZE);
  const canPage = filtered.length > paged.length;

  const buckets = useMemo(() => ({
    all: arrows.length,
    hit: arrows.filter((a) => a.outcome === "hit").length,
    miss: arrows.filter((a) => a.outcome === "miss").length,
    void: arrows.filter((a) => a.outcome === "void").length,
    open: arrows.filter((a) => a.status === "open").length,
    arb: arrows.filter((a) => a.type === "arb").length,
    drift: arrows.filter((a) => a.type === "drift").length,
    flow: arrows.filter((a) => a.type === "flow").length,
  }), [arrows]);

  return (
    <div className="mx-auto max-w-5xl px-4 py-10 md:py-14">
      <Header arrowsToday={record.receipts.arrows_today} />
      <HeadlineHero headline={record.headline} />
      <MetricStrip record={record} filteredCount={filtered.length} />

      <div className="mb-3 mt-10 font-mono text-[10px] uppercase tracking-widest" style={{ color: MUTED }}>
        // every graded arrow · forever · misses included
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <FilterPills
          label="outcome"
          value={outcome}
          onChange={(v) => { setOutcome(v); setPage(1); }}
          opts={[
            { key: "all", label: "All", count: buckets.all },
            { key: "hit", label: "Hit", count: buckets.hit },
            { key: "miss", label: "Miss", count: buckets.miss },
            { key: "void", label: "Void", count: buckets.void },
            { key: "open", label: "Open", count: buckets.open },
          ]}
        />
        <FilterPills
          label="type"
          value={ttype}
          onChange={(v) => { setTtype(v); setPage(1); }}
          opts={[
            { key: "all", label: "All", count: buckets.all },
            { key: "arb", label: "Arb", count: buckets.arb },
            { key: "drift", label: "Drift", count: buckets.drift },
            { key: "flow", label: "Flow", count: buckets.flow },
          ]}
        />
        <div className="ml-auto flex items-center gap-2 text-[10px] uppercase tracking-widest" style={{ color: MUTED }}>
          <button
            onClick={() => setRulesOpen(true)}
            className="rounded border px-2 py-1 hover:text-white"
            style={{ borderColor: BORDER }}
          >
            How grading works
          </button>
          <span>sort</span>
          <SortToggle value={sort} onChange={(v) => { setSort(v); setPage(1); }} />
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState allZero={arrows.length === 0} />
      ) : (
        <>
          <ArrowTable arrows={paged} />
          {canPage && (
            <div className="mt-4 text-center">
              <button
                onClick={() => setPage((p) => p + 1)}
                className="rounded border px-4 py-1.5 text-xs font-mono"
                style={{ borderColor: BORDER, color: "#9aa1ac" }}
              >
                load {Math.min(PAGE_SIZE, filtered.length - paged.length)} more
              </button>
            </div>
          )}
        </>
      )}

      <Footer meta={record.meta} />

      {rulesOpen && <GradingRulesModal onClose={() => setRulesOpen(false)} />}
    </div>
  );
}

// ── Header ───────────────────────────────────────────────────────────────────
function Header({ arrowsToday }: { arrowsToday: number }) {
  return (
    <header className="mb-8 flex flex-wrap items-baseline gap-x-4 gap-y-2">
      <div className="flex items-baseline gap-3">
        <div className="text-[26px] font-bold tracking-tight text-white">
          BLUE<span style={{ color: RH_GREEN }}>HOOD</span>
          <span className="ml-2 text-[13px] font-normal" style={{ color: MUTED, letterSpacing: "0.08em" }}>
            · TRACK RECORD
          </span>
        </div>
        <div className="text-[11px]" style={{ color: "#9aa1ac" }}>
          public receipt book — every signal graded, misses included
        </div>
      </div>
      <div className="ml-auto flex items-center gap-4 text-[11px]">
        {arrowsToday > 0 && (
          <span className="font-mono" style={{ color: MUTED }}>
            <span style={{ color: RH_GREEN }}>{arrowsToday}</span> fired today
          </span>
        )}
        <Link href="/hood" className="hover:text-white" style={{ color: MUTED }}>
          Live board →
        </Link>
      </div>
    </header>
  );
}

// ── Headline hero (GATED) ────────────────────────────────────────────────────
function HeadlineHero({ headline }: { headline: PublicTrackRecord["headline"] }) {
  const hr = headline.hit_rate;
  const curve = headline.record_curve;

  const perTypeSub = (() => {
    const parts: { label: string; node: React.ReactNode }[] = [];
    const t = (key: "arb" | "drift", label: string) => {
      const s = headline.per_type[key] as PublicPerTypeStats | undefined;
      if (!s) return;
      if (s.ready && typeof s.pct === "number") {
        parts.push({ label, node: <><span className="text-white">{label} {s.pct}%</span> <span style={{ color: MUTED }}>· {s.graded}</span></> });
      } else {
        parts.push({ label, node: <span style={{ color: MUTED }}>{label} warming {s.graded}/{s.needed}</span> });
      }
    };
    t("arb", "arb");
    t("drift", "drift");
    return parts;
  })();

  return (
    <section
      className="mb-8 rounded-xl border p-6 md:p-8"
      style={{ borderColor: BORDER, backgroundColor: SURFACE }}
    >
      <div className="flex flex-wrap items-center justify-between gap-6">
        <div>
          <div className="mb-1 font-mono text-[10px] uppercase tracking-widest" style={{ color: MUTED }}>
            7-day hit rate
          </div>
          {hr.ready ? (
            <div className="flex items-baseline gap-3">
              <div className="font-mono text-5xl font-bold text-white tabular-nums">{hr.pct}%</div>
              <div className="text-[13px]" style={{ color: MUTED }}>
                {hr.graded} graded signals
              </div>
            </div>
          ) : (
            <div>
              <div className="font-mono text-4xl font-bold tabular-nums" style={{ color: AMBER }}>
                warming up
              </div>
              <div className="mt-1 text-[13px]" style={{ color: MUTED }}>
                {hr.graded} graded · {Math.max(0, hr.needed - hr.graded)} more to unlock the rate
              </div>
            </div>
          )}
          {perTypeSub.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[12px]">
              {perTypeSub.map((p) => <span key={p.label}>{p.node}</span>)}
            </div>
          )}
        </div>

        {/* Record curve — the gated HIT−MISS walk. Only when the sample earns it. */}
        {curve.ready && <RecordCurve curve={curve} />}
      </div>

      {!hr.ready && (
        <div className="mt-5">
          <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ backgroundColor: "#12151c" }}>
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.min(100, Math.round((hr.graded / hr.needed) * 100))}%`,
                backgroundColor: RH_GREEN,
              }}
            />
          </div>
          <div className="mt-2 font-mono text-[10px] uppercase tracking-widest" style={{ color: MUTED }}>
            we don&apos;t publish a hit rate the sample hasn&apos;t earned — this bar fills as arrows grade
          </div>
        </div>
      )}
    </section>
  );
}

function RecordCurve({ curve }: { curve: Extract<PublicTrackRecord["headline"]["record_curve"], { ready: true }> }) {
  const pts = curve.points;
  if (pts.length < 2) return null;
  const W = 220, H = 64, pad = 4;
  const vals = pts.map((p) => p.v);
  const min = Math.min(0, ...vals), max = Math.max(0, ...vals);
  const span = Math.max(1, max - min);
  const x = (i: number) => pad + (i / (pts.length - 1)) * (W - 2 * pad);
  const y = (v: number) => pad + (1 - (v - min) / span) * (H - 2 * pad);
  const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  const zeroY = y(0);
  const up = curve.final >= 0;
  return (
    <div className="flex flex-col items-end">
      <svg width={W} height={H} className="overflow-visible">
        <line x1={pad} y1={zeroY} x2={W - pad} y2={zeroY} stroke={BORDER} strokeWidth={1} strokeDasharray="3 3" />
        <path d={d} fill="none" stroke={up ? GREEN : RED} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <div className="mt-1 font-mono text-[10px]" style={{ color: MUTED }}>
        net <span style={{ color: up ? GREEN : RED }}>{curve.final >= 0 ? "+" : ""}{curve.final}</span> · peak +{curve.peak} · W/L walk
      </div>
    </div>
  );
}

// ── Metric strip (no pct leak when not ready) ────────────────────────────────
function MetricStrip({ record, filteredCount }: { record: PublicTrackRecord; filteredCount: number }) {
  const arrows = record.receipts.arrows;
  const graded = arrows.filter((a) => a.status === "graded");
  const durations = graded
    .filter((a) => a.graded_at)
    .map((a) => new Date(a.graded_at!).getTime() - new Date(a.fired_at).getTime());
  const avgDurationMs = durations.length ? durations.reduce((s, d) => s + d, 0) / durations.length : 0;

  const hr = record.headline.hit_rate;
  // Only ever a % when the gate says ready; otherwise "n/a" — never a raw rate.
  const hitRate = hr.ready ? `${hr.pct}%` : "n/a";
  const hitSub = hr.ready ? `${hr.graded} graded · 7d` : `warming up · ${hr.graded}/${hr.needed}`;

  const items: { label: string; value: string; sub?: string }[] = [
    { label: "HIT RATE 7D", value: hitRate, sub: hitSub },
    { label: "TOTAL GRADED", value: String(graded.length), sub: `${filteredCount} match filter` },
    {
      label: "AVG DURATION",
      value: durations.length ? formatDuration(avgDurationMs) : "—",
      sub: durations.length ? "fire → grade" : "no graded arrows yet",
    },
    {
      label: "SIGNALS LOGGED",
      value: String(arrows.length),
      sub: "engine-fired · non-test",
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {items.map((it) => (
        <div key={it.label} className="rounded border px-4 py-3" style={{ borderColor: BORDER, backgroundColor: SURFACE }}>
          <div className="mb-1 font-mono text-[9px] uppercase tracking-widest" style={{ color: MUTED }}>{it.label}</div>
          <div className="font-mono text-xl text-white">{it.value}</div>
          {it.sub && <div className="mt-1 text-[11px]" style={{ color: MUTED }}>{it.sub}</div>}
        </div>
      ))}
    </div>
  );
}

// ── Filters ──────────────────────────────────────────────────────────────────
function FilterPills<K extends string>({
  label, value, onChange, opts,
}: {
  label: string;
  value: K;
  onChange: (k: K) => void;
  opts: { key: K; label: string; count: number }[];
}) {
  return (
    <div className="flex items-center gap-1">
      <span className="mr-1 font-mono text-[10px] uppercase tracking-widest" style={{ color: MUTED }}>{label}</span>
      {opts.map((o) => {
        const active = value === o.key;
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

function SortToggle({ value, onChange }: { value: SortKey; onChange: (v: SortKey) => void }) {
  const opts: { key: SortKey; label: string }[] = [
    { key: "newest", label: "Newest" },
    { key: "oldest", label: "Oldest" },
    { key: "duration", label: "Duration" },
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

// ── Table ────────────────────────────────────────────────────────────────────
function ArrowTable({ arrows }: { arrows: Arrow[] }) {
  return (
    <div className="overflow-x-auto rounded border" style={{ borderColor: BORDER, backgroundColor: SURFACE }}>
      <table className="w-full text-sm">
        <thead className="font-mono text-[9px] uppercase tracking-widest" style={{ color: MUTED }}>
          <tr className="border-b" style={{ borderColor: BORDER }}>
            <th className="px-3 py-2 text-left">Serial</th>
            <th className="px-3 py-2 text-left">Ticker</th>
            <th className="px-3 py-2 text-left">Signal</th>
            <th className="px-3 py-2 text-left">Fired</th>
            <th className="px-3 py-2 text-left">Graded</th>
            <th className="px-3 py-2 text-left">Duration</th>
            <th className="px-3 py-2 text-right">Ref px</th>
            <th className="px-3 py-2 text-left">Outcome</th>
          </tr>
        </thead>
        <tbody className="font-mono text-[13px]">
          {arrows.map((a) => <TrackRow key={a.id} a={a} />)}
        </tbody>
      </table>
    </div>
  );
}

function TrackRow({ a }: { a: Arrow }) {
  const signal = signalLabel(a);
  const oc = outcomeBadge(a);
  const dur = a.graded_at
    ? formatDuration(new Date(a.graded_at).getTime() - new Date(a.fired_at).getTime())
    : "—";
  const serialParam = a.serial.replace(/^#/, "");

  return (
    <tr className="border-b last:border-b-0 hover:bg-black/40" style={{ borderColor: "#0f1218" }}>
      <td className="px-3 py-2 text-left">
        <Link
          href={`/share/arrow/${serialParam}`}
          className="hover:underline"
          style={{ color: RH_GREEN }}
          title="Open shareable permalink"
        >
          {a.serial} <span style={{ color: MUTED }}>↗</span>
        </Link>
      </td>
      <td className="px-3 py-2 text-left text-white">{a.ticker}</td>
      <td className="px-3 py-2 text-left" style={{ color: "#9aa1ac" }}>{signal}</td>
      <td className="px-3 py-2 text-left" style={{ color: MUTED }}>{formatEtTime(a.fired_at)}</td>
      <td className="px-3 py-2 text-left" style={{ color: MUTED }}>{a.graded_at ? formatEtTime(a.graded_at) : "—"}</td>
      <td className="px-3 py-2 text-left" style={{ color: MUTED }}>{dur}</td>
      <td className="px-3 py-2 text-right" style={{ color: "#E7E9EE" }}>${a.reference_price.toFixed(2)}</td>
      <td className="px-3 py-2 text-left">
        <span
          className="rounded px-2 py-0.5 font-mono text-[10px] font-semibold tracking-wider"
          style={{ color: oc.color, backgroundColor: `${oc.color}18` }}
        >
          {oc.label}
        </span>
      </td>
    </tr>
  );
}

function EmptyState({ allZero }: { allZero: boolean }) {
  return (
    <div className="rounded border py-12 text-center" style={{ borderColor: BORDER, backgroundColor: SURFACE, color: MUTED }}>
      {allZero ? (
        <>
          <div className="font-mono text-white text-[13px] mb-2">No graded arrows yet.</div>
          <p className="mx-auto max-w-md text-[13.5px] leading-relaxed">
            The engine fires on live Chainlink-vs-DEX setups and grades them automatically. First receipts land when NYSE opens.
          </p>
        </>
      ) : (
        <span className="font-mono text-[13px]">No arrows match this filter.</span>
      )}
    </div>
  );
}

function GradingRulesModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div
        className="max-w-lg rounded border p-6"
        style={{ borderColor: BORDER, backgroundColor: SURFACE }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <div className="font-mono text-[11px] uppercase tracking-widest" style={{ color: MUTED }}>// how grading works</div>
          <button onClick={onClose} className="text-slate-400 hover:text-white" aria-label="Close">✕</button>
        </div>
        <ul className="space-y-3 text-sm font-mono">
          <li>
            <span style={{ color: RH_GREEN }}>drift</span>{" "}
            <span style={{ color: "#9aa1ac" }}>= DEX↔oracle gap closes ≥ 50% within the first 2h of NYSE regular session (clock pauses at close — Chainlink freezes off-hours, so the gap literally can&apos;t close then).</span>
          </li>
          <li>
            <span style={{ color: RH_GREEN }}>arb</span>{" "}
            <span style={{ color: "#9aa1ac" }}>= spread returns below 0.5% within 4h of NYSE regular-session time (same market-aware clock as drift).</span>
          </li>
          <li>
            <span style={{ color: "#f5b342" }}>void</span>{" "}
            <span style={{ color: "#9aa1ac" }}>= graded before its regular-session window fully elapsed → excluded from the hit rate (never hidden — VOID stays in the list).</span>
          </li>
          <li>
            <span style={{ color: MUTED }}>flow / whale</span>{" "}
            <span style={{ color: "#9aa1ac" }}>= informational, does NOT count toward the hit rate.</span>
          </li>
        </ul>
        <p className="mt-4 text-[11px] font-mono" style={{ color: MUTED }}>
          Every outcome is hard-mapped in code by the same tool that fired the arrow — the LLM never picks HIT / MISS.{" "}
          <Link href="/docs/blue-hood#grading" className="underline" style={{ color: BLUE }}>Full rules ↗</Link>
        </p>
      </div>
    </div>
  );
}

function Footer({ meta }: { meta: PublicTrackRecord["meta"] }) {
  return (
    <footer className="mt-12 border-t pt-6 text-[11px]" style={{ borderColor: BORDER, color: MUTED }}>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <span>Oracle: Chainlink AggregatorV3 on Robinhood Chain</span>
        <span>DEX: GeckoTerminal (Uniswap V3/V4)</span>
        <span>
          Track-record API <span style={{ color: BLUE }}>v{meta.api_version}</span> ·{" "}
          <Link href="/docs/blue-hood#grading" className="underline">grading rules</Link>
        </span>
      </div>
    </footer>
  );
}

// ── Shared label/format helpers (mirror the in-app track record) ─────────────
function signalLabel(a: Arrow): string {
  if (a.type === "drift") return `DRIFT ${a.expected_direction === "up" ? "↑" : "↓"}`;
  if (a.type === "arb") return `ARB ${a.expected_direction === "up" ? "long dex" : "short dex"}`;
  if (a.type === "flow") return `FLOW ${a.expected_direction === "up" ? "buy" : "sell"}`;
  return "WHALE Δ";
}

function outcomeBadge(a: Arrow): { label: string; color: string } {
  if (a.status === "open") return { label: "OPEN", color: BLUE };
  if (a.outcome === "hit") return { label: "HIT", color: GREEN };
  if (a.outcome === "miss") return { label: "MISS", color: RED };
  if (a.outcome === "void") return { label: "VOID", color: AMBER };
  if (a.outcome === "informational") return { label: "INFO", color: MUTED };
  return { label: "—", color: MUTED };
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const s = ms / 1000;
  if (s < 60) return `${Math.round(s)}s`;
  const m = s / 60;
  if (m < 60) return `${Math.round(m)}m`;
  const h = m / 60;
  if (h < 24) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

function formatEtTime(iso: string): string {
  const d = new Date(iso);
  const et = new Date(d.getTime() - 4 * 3600 * 1000);
  const mm = String(et.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(et.getUTCDate()).padStart(2, "0");
  const hh = String(et.getUTCHours()).padStart(2, "0");
  const mi = String(et.getUTCMinutes()).padStart(2, "0");
  return `${mm}/${dd} ${hh}:${mi} ET`;
}
