/**
 * /share/arrow/[serial] — PUBLIC per-arrow receipt (permalink).
 *
 * The share target for a single Blue Hood signal. No wallet, no app shell — the
 * opposite of /hood/arrows (behind the app). A reader lands here from a copied
 * link (the "Share" button on an arrow card) or from a social unfurl, and sees
 * the SAME graded truth the app shows: serial · ticker · signal · drift@fire ·
 * facts@fire · outcome (HIT / MISS / VOID / WATCHING) · verified contract.
 *
 * HONESTY: this page shows ONE arrow's evidence — it never computes a hit-rate,
 * so the aggregate gate (hit-rate-gate.ts) doesn't apply here; a single receipt
 * is always fair to show, misses included. VOID is shown clearly, never hidden.
 * "Verified on Robinhood Chain" renders ONLY when the ticker resolves in the RWA
 * registry (real contract) — never fabricated.
 *
 * The OG image is supplied by the sibling opengraph-image.tsx (Next's file
 * convention), so we deliberately do NOT set `images` in generateMetadata.
 * ISR 300s: a graded arrow is immutable; an open one settles within the window.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { cache } from "react";
import { getPublicArrowBySerial, serialKey } from "@/lib/blue-hood/public-feed";
import { findByTicker, RH_CHAIN } from "@/lib/robinhood/rwa-registry";
import type { Arrow } from "@/lib/blue-hood/types";

export const runtime = "nodejs";
export const revalidate = 300;

// cache() de-dupes the KV scan so generateMetadata + the page body share one read.
const getArrow = cache((serial: string) => getPublicArrowBySerial(serial));

// ── palette (mirror /track + the in-app board) ───────────────────────────────
const RH_GREEN = "#34D399";
const BLUE = "#4FC3F7";
const RED = "#ef4444";
const GREEN = "#22c55e";
const AMBER = "#f5b342";
const MUTED = "#6b7280";
const BG = "#050508";
const SURFACE = "#0B0D13";
const BORDER = "#1A1A2E";

// ── Metadata ─────────────────────────────────────────────────────────────────
export async function generateMetadata({
  params,
}: {
  params: Promise<{ serial: string }>;
}): Promise<Metadata> {
  const { serial } = await params;
  const a = await getArrow(serial);
  const key = serialKey(serial);
  const serialLabel = key ? `#${String(key).padStart(4, "0")}` : serial;

  if (!a) {
    return {
      title: `Signal ${serialLabel} — Blue Hood`,
      description: "A Blue Hood signal receipt — oracle-vs-DEX drift, graded in public.",
      robots: { index: false, follow: true },
    };
  }

  const oc = outcomeWord(a);
  const title = `${a.serial} ${a.ticker} · ${oc} — Blue Hood`;
  const drift = driftAtFire(a);
  const driftBit = drift !== null ? ` · drift ${fmtPct(drift)} at fire` : "";
  const description =
    `${a.ticker} ${signalWord(a)} signal${driftBit} · ${oc}` +
    `${a.outcome_detail ? ` (${a.outcome_detail})` : ""}. ` +
    `A graded Blue Hood signal — receipts, misses included.`;

  return {
    title,
    description,
    robots: { index: true, follow: true },
    alternates: { canonical: `https://blueagent.dev/share/arrow/${key ?? serial}` },
    openGraph: {
      title,
      description,
      url: `https://blueagent.dev/share/arrow/${key ?? serial}`,
      siteName: "Blue Agent",
      type: "article",
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
    },
  };
}

// ── Page ─────────────────────────────────────────────────────────────────────
export default async function ArrowSharePage({
  params,
}: {
  params: Promise<{ serial: string }>;
}) {
  const { serial } = await params;
  const a = await getArrow(serial);

  if (!a) return <NotFound serial={serial} />;

  const reg = findByTicker(a.ticker);
  const explorerUrl = reg ? `${RH_CHAIN.explorer}/token/${reg.contract}` : null;
  const oc = outcomeBadge(a);

  const oraclePx = a.snapshot_at_fire?.oracle_price_usd ?? a.brief?.facts_at_fire?.oracle_price_usd ?? null;
  const tvl = a.snapshot_at_fire?.dex_tvl_usd ?? a.brief?.facts_at_fire?.dex_tvl_usd ?? null;
  const vol = a.snapshot_at_fire?.dex_volume_24h_usd ?? a.brief?.facts_at_fire?.dex_volume_24h_usd ?? null;
  const chg = a.snapshot_at_fire?.dex_change_24h_pct ?? a.brief?.facts_at_fire?.dex_change_24h_pct ?? null;
  const clAge = a.snapshot_at_fire?.chainlink_age_seconds ?? a.brief?.facts_at_fire?.chainlink_age_seconds ?? null;
  const drift = driftAtFire(a);
  const dur = a.graded_at
    ? formatDuration(new Date(a.graded_at).getTime() - new Date(a.fired_at).getTime())
    : null;

  return (
    <div className="min-h-screen text-white" style={{ background: BG }}>
      {/* Header */}
      <header
        className="sticky top-0 z-10 flex h-14 items-center gap-3 border-b px-4 backdrop-blur-sm sm:px-8"
        style={{ borderColor: BORDER, background: `${BG}f2` }}
      >
        <Link href="/track" className="flex shrink-0 items-baseline gap-2">
          <span className="font-mono text-sm font-bold tracking-widest">
            BLUE<span style={{ color: RH_GREEN }}>HOOD</span>
          </span>
        </Link>
        <span className="hidden font-mono text-[10px] tracking-widest sm:block" style={{ color: MUTED }}>
          // PUBLIC SIGNAL RECEIPT
        </span>
        <div className="flex-1" />
        <Link
          href="/track"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 font-mono text-[11px] font-bold transition-colors"
          style={{ background: "#34D39915", color: RH_GREEN, border: "1px solid #34D39930" }}
        >
          Track record →
        </Link>
      </header>

      <main className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6 sm:py-12">
        {/* Card */}
        <div className="rounded-2xl border p-6 sm:p-8" style={{ borderColor: BORDER, background: SURFACE }}>
          {/* Top row: serial + ticker + outcome */}
          <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="mb-1 font-mono text-[11px] tracking-widest" style={{ color: MUTED }}>
                {a.serial} · SIGNAL
              </div>
              <div className="flex items-baseline gap-3">
                <span className="text-3xl font-bold tracking-tight text-white">{a.ticker}</span>
                {reg && <span className="text-[13px]" style={{ color: MUTED }}>{reg.name}</span>}
              </div>
              <div className="mt-1.5 font-mono text-[12px]" style={{ color: "#9aa1ac" }}>
                {signalLabel(a)} <span style={{ color: MUTED }}>· {signalPhrase(a)}</span>
              </div>
            </div>
            <span
              className="rounded-lg px-3 py-1.5 font-mono text-[12px] font-bold tracking-widest"
              style={{ color: oc.color, background: `${oc.color}1a`, border: `1px solid ${oc.color}40` }}
            >
              {oc.label}
            </span>
          </div>

          {/* Facts @ fire */}
          <div className="mb-2 font-mono text-[9px] uppercase tracking-widest" style={{ color: MUTED }}>
            // facts at fire
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Fact label="DEX @ fire" value={fmtUsd(a.reference_price)} />
            <Fact label="Oracle @ fire" value={fmtUsd(oraclePx)} />
            <Fact
              label="Drift @ fire"
              value={fmtPct(drift)}
              color={drift == null ? undefined : drift >= 0 ? GREEN : RED}
            />
            <Fact label="Pool TVL" value={fmtCompactUsd(tvl)} />
            <Fact label="24h volume" value={fmtCompactUsd(vol)} />
            <Fact
              label="24h change"
              value={fmtPct(chg)}
              color={chg == null ? undefined : chg >= 0 ? GREEN : RED}
            />
          </div>

          {/* Timeline */}
          <div className="mt-6 mb-2 font-mono text-[9px] uppercase tracking-widest" style={{ color: MUTED }}>
            // timeline
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Fact label="Fired" value={formatEtTime(a.fired_at)} />
            <Fact label="Grade window" value={`${a.grading_window_h}h`} />
            <Fact label="Graded" value={a.graded_at ? formatEtTime(a.graded_at) : "watching"} />
            <Fact label="Duration" value={dur ?? "—"} />
          </div>

          {/* Outcome detail */}
          {a.outcome_detail && (
            <div
              className="mt-6 rounded-lg border px-4 py-3 font-mono text-[12px]"
              style={{ borderColor: `${oc.color}30`, background: `${oc.color}0d`, color: "#c9ced6" }}
            >
              <span style={{ color: oc.color }}>{oc.label}</span> · {a.outcome_detail}
            </div>
          )}

          {/* Chainlink freshness note (when we have it) */}
          {clAge != null && Number.isFinite(clAge) && (
            <div className="mt-4 font-mono text-[10px]" style={{ color: MUTED }}>
              Chainlink oracle age at fire: {Math.round(clAge)}s
            </div>
          )}

          {/* Verified contract — only when the ticker resolves in the RWA registry */}
          <div className="mt-6 border-t pt-4" style={{ borderColor: BORDER }}>
            {reg && explorerUrl ? (
              <a
                href={explorerUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 font-mono text-[11px] hover:underline"
                style={{ color: RH_GREEN }}
              >
                <span
                  className="rounded px-1.5 py-0.5 text-[9px] font-bold tracking-wider"
                  style={{ background: "#34D39918", border: "1px solid #34D39930" }}
                >
                  VERIFIED
                </span>
                {shortAddr(reg.contract)} · Robinhood Chain ↗
              </a>
            ) : (
              <span className="font-mono text-[11px]" style={{ color: MUTED }}>
                Contract not in the RWA registry — quoted from Chainlink feed only.
              </span>
            )}
          </div>
        </div>

        {/* How graded + CTAs */}
        <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 px-1 font-mono text-[11px]" style={{ color: MUTED }}>
          <Link href="/docs/blue-hood#grading" className="hover:text-white">
            How grading works ↗
          </Link>
          <Link href="/track" className="hover:text-white">
            Full track record →
          </Link>
          <Link href="/hood" className="hover:text-white">
            Live board →
          </Link>
        </div>

        {/* Footer — honesty + sources. No Trade button: intelligence layer, not a venue. */}
        <footer className="mt-8 border-t pt-5 font-mono text-[10px] leading-relaxed" style={{ borderColor: BORDER, color: MUTED }}>
          <p>
            Oracle: Chainlink AggregatorV3 · DEX: GeckoTerminal (Uniswap V3/V4) · graded automatically by the
            same engine that fired the signal — the LLM never picks HIT / MISS.
          </p>
          <p className="mt-2">
            Blue Hood is an intelligence layer, not a venue. Signals are observations, not financial advice.
          </p>
        </footer>
      </main>
    </div>
  );
}

// ── Small components ─────────────────────────────────────────────────────────
function Fact({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="rounded-lg border px-3 py-2" style={{ borderColor: BORDER, background: BG }}>
      <div className="mb-0.5 font-mono text-[9px] uppercase tracking-widest" style={{ color: MUTED }}>
        {label}
      </div>
      <div className="font-mono text-[14px] tabular-nums" style={{ color: color ?? "#E7E9EE" }}>
        {value}
      </div>
    </div>
  );
}

function NotFound({ serial }: { serial: string }) {
  const key = serialKey(serial);
  const label = key ? `#${String(key).padStart(4, "0")}` : serial;
  return (
    <div className="flex min-h-screen items-center justify-center px-4" style={{ background: BG }}>
      <div className="text-center">
        <div
          className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-3xl border"
          style={{ borderColor: BORDER, background: SURFACE }}
        >
          <span className="text-2xl">🎯</span>
        </div>
        <p className="mb-1 font-mono text-sm text-slate-400">Signal {label} not found</p>
        <p className="mb-6 font-mono text-[11px] text-slate-600">
          It may not be a public engine signal, or the serial is wrong.
        </p>
        <Link href="/track" className="font-mono text-[12px] hover:underline" style={{ color: RH_GREEN }}>
          Browse the full track record →
        </Link>
      </div>
    </div>
  );
}

// ── Signal / outcome helpers (mirror /track) ─────────────────────────────────
function signalLabel(a: Arrow): string {
  if (a.type === "drift") return `DRIFT ${a.expected_direction === "up" ? "↑" : "↓"}`;
  if (a.type === "arb") return `ARB ${a.expected_direction === "up" ? "long dex" : "short dex"}`;
  if (a.type === "flow") return `FLOW ${a.expected_direction === "up" ? "buy" : "sell"}`;
  return "WHALE Δ";
}

function signalPhrase(a: Arrow): string {
  if (a.type === "drift") return `expecting DEX to move ${a.expected_direction ?? "?"} toward the oracle`;
  if (a.type === "arb")
    return `${a.expected_direction === "up" ? "long DEX" : "short DEX"} · spread expected to compress`;
  if (a.type === "flow") return "order-flow signal · informational (not graded)";
  return "whale signal · informational (not graded)";
}

function signalWord(a: Arrow): string {
  return a.type.toUpperCase();
}

function outcomeBadge(a: Arrow): { label: string; color: string } {
  if (a.status === "open") return { label: "WATCHING", color: BLUE };
  if (a.outcome === "hit") return { label: "HIT", color: GREEN };
  if (a.outcome === "miss") return { label: "MISS", color: RED };
  if (a.outcome === "void") return { label: "VOID", color: AMBER };
  if (a.outcome === "informational") return { label: "INFO", color: MUTED };
  return { label: "—", color: MUTED };
}

function outcomeWord(a: Arrow): string {
  return outcomeBadge(a).label;
}

/** Drift % at fire = (DEX − oracle) / oracle × 100. Null when oracle unknown. */
function driftAtFire(a: Arrow): number | null {
  const oracle = a.snapshot_at_fire?.oracle_price_usd ?? a.brief?.facts_at_fire?.oracle_price_usd ?? null;
  if (oracle == null || oracle === 0 || !Number.isFinite(oracle)) return null;
  return ((a.reference_price - oracle) / oracle) * 100;
}

// ── Format helpers ───────────────────────────────────────────────────────────
function fmtUsd(n: number | null | undefined, dp = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
}

function fmtCompactUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function fmtPct(n: number | null | undefined, dp = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(dp)}%`;
}

function shortAddr(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
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
