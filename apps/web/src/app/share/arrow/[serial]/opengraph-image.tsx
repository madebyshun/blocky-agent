/**
 * Dynamic OG banner for /share/arrow/[serial] — Next's file-based
 * opengraph-image convention. Every arrow permalink automatically gets its own
 * og:image + twitter:image: the PNG shows the REAL signal — ticker · serial ·
 * signal type · drift@fire · outcome badge (HIT / MISS / VOID / WATCHING) ·
 * "VERIFIED · <chain>" (verified only when the ticker resolves in the registry
 * of the ARROW'S OWN chain). HIT shows off; MISS is still shown — the misses
 * are the point.
 *
 * ⚠️ The verified pill NAMES THE CHAIN and must keep doing so. It used to be the
 * literal string "VERIFIED · Robinhood Chain" beside a `findByTicker(a.ticker)`
 * lookup, so a Base arrow's unfurl — the image that travels furthest, into
 * timelines that never open the page — captioned a Base signal with Robinhood's
 * company name and asserted Robinhood provenance. `resolveArrowToken` needs a
 * chain, and the label comes from the same resolution as the name.
 *
 * Cache-Control is outcome-aware: a graded arrow is immutable (1y), a WATCHING
 * arrow gets a short TTL because it can settle at any time. Never throws — a
 * generic brand card renders on a KV miss so a banner always exists.
 */
import { ImageResponse } from "next/og";
import { getBrandFonts, brandFonts } from "@/lib/og-font";
import { getPublicArrowBySerial, serialKey } from "@/lib/blue-hood/public-feed";
import { resolveArrowToken } from "@/lib/blue-hood/chain-token";
import type { Arrow } from "@/lib/blue-hood/types";

export const runtime = "nodejs";
export const alt = "Blue Hood signal receipt";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Blue Hood palette (mirrors /track + the permalink page, NOT the navy OG tokens).
const BG = "#050508";
const SURFACE = "#0B0D13";
const BORDER = "#1E2233";
const RH_GREEN = "#34D399";
const GREEN = "#22c55e";
const RED = "#ef4444";
const AMBER = "#f5b342";
const BLUE = "#4FC3F7";
const WHITE = "#FFFFFF";
const MUTED = "#7A8496";

export default async function Image({ params }: { params: Promise<{ serial: string }> }) {
  const { serial } = await params;

  let a: Arrow | null = null;
  try {
    a = await getPublicArrowBySerial(serial);
  } catch {
    a = null;
  }

  const brand = await getBrandFonts();
  const f = brandFonts(brand.length > 0);
  const fontsOpt = brand.length ? brand : undefined;

  const key = serialKey(serial);
  const serialLabel = a?.serial ?? (key ? `#${String(key).padStart(4, "0")}` : serial);

  // ── Fallback card (arrow not found) ────────────────────────────────────────
  if (!a) {
    return new ImageResponse(
      (
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            backgroundColor: BG,
            backgroundImage: `radial-gradient(900px 520px at 100% 0%, rgba(0,200,5,0.10), transparent 62%)`,
            padding: 64,
            fontFamily: f.display,
            color: WHITE,
          }}
        >
          <Wordmark f={f} />
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", fontSize: 60, fontWeight: 700, color: WHITE }}>
              Signal {serialLabel}
            </div>
            <div style={{ display: "flex", marginTop: 10, fontFamily: f.mono, fontSize: 26, color: MUTED }}>
              Public track record — every signal graded, misses included.
            </div>
          </div>
          <BottomBar f={f} verifiedName={null} chainLabel={null} />
        </div>
      ),
      { ...size, fonts: fontsOpt, headers: { "cache-control": "public, max-age=120, s-maxage=120" } },
    );
  }

  const oc = outcomeBadge(a);
  // Per-chain resolution: the company name and the "VERIFIED · <chain>" pill both
  // come from THIS arrow's desk, so the unfurl can never caption a Base signal
  // with Robinhood's row.
  const tok = resolveArrowToken(a);
  const oraclePx = a.snapshot_at_fire?.oracle_price_usd ?? a.brief?.facts_at_fire?.oracle_price_usd ?? null;
  const drift = oraclePx && oraclePx !== 0 ? ((a.reference_price - oraclePx) / oraclePx) * 100 : null;

  // Graded arrows never change → cache forever. WATCHING can settle → short TTL.
  const graded = a.status !== "open";
  const cacheControl = graded
    ? "public, immutable, no-transform, max-age=31536000"
    : "public, max-age=120, s-maxage=120, stale-while-revalidate=600";

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          backgroundColor: BG,
          backgroundImage: `radial-gradient(1000px 560px at 100% 0%, ${oc.color}22, transparent 60%), radial-gradient(680px 420px at 0% 100%, rgba(0,200,5,0.08), transparent 58%)`,
          padding: 64,
          fontFamily: f.display,
          color: WHITE,
        }}
      >
        {/* Top: brand + outcome badge */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <Wordmark f={f} />
          <div
            style={{
              display: "flex",
              alignItems: "center",
              fontFamily: f.mono,
              fontSize: 30,
              fontWeight: 700,
              letterSpacing: 3,
              color: oc.color,
              border: `3px solid ${oc.color}`,
              borderRadius: 14,
              padding: "10px 26px",
            }}
          >
            {oc.label}
          </div>
        </div>

        {/* Middle: ticker + serial + signal */}
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 22 }}>
            <div style={{ display: "flex", fontSize: 132, fontWeight: 700, letterSpacing: -2, color: WHITE }}>
              {a.ticker}
            </div>
            <div style={{ display: "flex", fontFamily: f.mono, fontSize: 34, color: MUTED }}>{serialLabel}</div>
          </div>
          <div style={{ display: "flex", marginTop: 6, fontFamily: f.mono, fontSize: 34, color: "#B7BECC" }}>
            {ogSignal(a)}
            <span style={{ color: MUTED }}>{`  ·  ${tok.chainLabel}`}</span>
            {tok.name ? <span style={{ color: MUTED }}>{`  ·  ${tok.name}`}</span> : null}
          </div>
        </div>

        {/* Facts row */}
        <div style={{ display: "flex", gap: 18 }}>
          <Stat f={f} label="DRIFT @ FIRE" value={fmtPct(drift)} color={drift == null ? WHITE : drift >= 0 ? GREEN : RED} />
          <Stat f={f} label="DEX @ FIRE" value={fmtUsd(a.reference_price)} color={WHITE} />
          <Stat f={f} label="ORACLE @ FIRE" value={fmtUsd(oraclePx)} color={WHITE} />
        </div>

        {/* Bottom: verified + domain — `verified` is per-chain, so an unresolved
            Base ticker shows no pill rather than borrowing Robinhood's answer. */}
        <BottomBar f={f} verifiedName={tok.verified ? tok.name : null} chainLabel={tok.chainLabel} />
      </div>
    ),
    { ...size, fonts: fontsOpt, headers: { "cache-control": cacheControl } },
  );
}

// ── Pieces ───────────────────────────────────────────────────────────────────
function Wordmark({ f }: { f: { display: string; mono: string } }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
      <div style={{ display: "flex", fontSize: 34, fontWeight: 700, letterSpacing: 1 }}>
        <span style={{ color: WHITE }}>BLUE</span>
        <span style={{ color: RH_GREEN }}>HOOD</span>
      </div>
      <div style={{ display: "flex", fontFamily: f.mono, fontSize: 18, color: MUTED, letterSpacing: 2 }}>
        // SIGNAL RECEIPT
      </div>
    </div>
  );
}

function Stat({
  f,
  label,
  value,
  color,
}: {
  f: { display: string; mono: string };
  label: string;
  value: string;
  color: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        backgroundColor: SURFACE,
        border: `2px solid ${BORDER}`,
        borderRadius: 16,
        padding: "18px 24px",
      }}
    >
      <div style={{ display: "flex", fontFamily: f.mono, fontSize: 18, letterSpacing: 2, color: MUTED }}>{label}</div>
      <div style={{ display: "flex", marginTop: 6, fontFamily: f.mono, fontSize: 40, fontWeight: 700, color }}>
        {value}
      </div>
    </div>
  );
}

/**
 * `chainLabel` is REQUIRED whenever `verifiedName` is set — the pill asserts
 * provenance, and provenance without a chain is the claim that was wrong. Both
 * null on the fallback card, which asserts nothing.
 */
function BottomBar({
  f,
  verifiedName,
  chainLabel,
}: {
  f: { display: string; mono: string };
  verifiedName: string | null;
  chainLabel: string | null;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        {verifiedName && chainLabel ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              fontFamily: f.mono,
              fontSize: 22,
              color: RH_GREEN,
              border: `2px solid ${RH_GREEN}55`,
              borderRadius: 999,
              padding: "6px 18px",
            }}
          >
            VERIFIED · {chainLabel}
          </div>
        ) : null}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            fontFamily: f.mono,
            fontSize: 22,
            color: MUTED,
            border: `2px solid ${BORDER}`,
            borderRadius: 999,
            padding: "6px 18px",
          }}
        >
          graded · misses included
        </div>
      </div>
      <div style={{ display: "flex", fontFamily: f.mono, fontSize: 22, color: MUTED }}>blueagent.dev/track</div>
    </div>
  );
}

// ── Helpers (OG-safe: no ↑↓/Δ glyphs — spell directions out) ─────────────────
function ogSignal(a: Arrow): string {
  if (a.type === "drift") return `DRIFT ${a.expected_direction === "up" ? "UP" : "DOWN"}`;
  if (a.type === "arb") return `ARB ${a.expected_direction === "up" ? "LONG DEX" : "SHORT DEX"}`;
  if (a.type === "flow") return `FLOW ${a.expected_direction === "up" ? "BUY" : "SELL"}`;
  return "WHALE";
}

function outcomeBadge(a: Arrow): { label: string; color: string } {
  if (a.status === "open") return { label: "WATCHING", color: BLUE };
  if (a.outcome === "hit") return { label: "HIT", color: GREEN };
  if (a.outcome === "miss") return { label: "MISS", color: RED };
  if (a.outcome === "void") return { label: "VOID", color: AMBER };
  if (a.outcome === "informational") return { label: "INFO", color: MUTED };
  return { label: "OPEN", color: BLUE };
}

function fmtUsd(n: number | null | undefined, dp = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
}

function fmtPct(n: number | null | undefined, dp = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(dp)}%`;
}
