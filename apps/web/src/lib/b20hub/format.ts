// Shared number formatters used across all B20HUB surfaces (feed grid,
// token detail, preview card). Kept in one file so `$0.0₈223610` looks
// identical on every screen.

const SUB_ZERO = "₀₁₂₃₄₅₆₇₈₉";

/**
 * Format a micro-price with the "compressed leading zeros" notation used
 * by o1.exchange, DexScreener, and Bankr:
 *
 *   0.00000000223610  →  $0.0₈223610
 *   0.00042           →  $0.00042
 *   0.42              →  $0.42
 *   4200              →  $4,200
 *
 * The subscript number counts how many zeros come between the decimal
 * point and the first significant digit — one glyph is much easier to
 * scan than seven "0"s in a row.
 */
export function fmtPriceUsd(v: number | null | undefined, sigFigs = 4): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (v === 0) return "$0";
  if (v >= 1000) return "$" + v.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (v >= 1)    return "$" + v.toLocaleString("en-US", { maximumFractionDigits: sigFigs });

  // v < 1 → compressed leading-zeros form.
  const abs = Math.abs(v);
  const exp = Math.floor(Math.log10(abs));           // e.g. -8 for 2.43e-8
  const leadingZeros = -exp - 1;                     // 7 zeros between "." and "2"

  if (leadingZeros <= 2) {
    // Small enough to show normally without the subscript trick.
    const rounded = Number(abs.toPrecision(sigFigs));
    // toFixed to avoid scientific notation, then trim trailing zeros.
    const s = rounded.toFixed(leadingZeros + sigFigs).replace(/0+$/, "").replace(/\.$/, "");
    return "$" + s;
  }

  // ≥3 leading zeros → use $0.0₇digits form. Force fixed decimal notation
  // via toFixed(leadingZeros + sigFigs) so the significant digits come out
  // as "0.00000002431" not "2.431e-8". Then strip the "0.000…0" prefix.
  const fixed = abs.toFixed(leadingZeros + sigFigs);
  const digits = fixed.replace(/^0\.0+/, "").replace(/0+$/, "").replace(/\.$/, "");
  const sub = leadingZeros
    .toString()
    .split("")
    .map((d) => SUB_ZERO[Number(d)])
    .join("");
  return `$0.0${sub}${digits}`;
}

/** Compact USD amount: $4K / $1.2M / $500. Standard everywhere. */
export function fmtUsdCompact(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (v >= 1_000_000) return "$" + (v / 1_000_000).toFixed(2) + "M";
  if (v >= 1_000)     return "$" + (v / 1_000).toFixed(1) + "K";
  if (v >= 1)         return "$" + v.toFixed(2);
  if (v > 0)          return fmtPriceUsd(v);
  return "$0";
}

/** Signed % change with 1 decimal. */
export function fmtPct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return (v >= 0 ? "+" : "") + v.toFixed(1) + "%";
}

/** "5m ago" / "3h ago" / "2d ago" — relative age. */
export function fmtAge(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60)    return s + "s ago";
  if (s < 3600)  return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

/** Short address: 0x1234…abcd */
export function fmtAddr(addr?: string | null): string {
  if (!addr) return "—";
  if (addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
