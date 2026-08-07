// BrandMark — the single place third-party brand logos are rendered.
//
// Why this exists: connector / integration cards used emoji stand-ins (🐙 for
// GitHub, 🔵 for Base, 💳 for Stripe…). Emoji render differently per-OS, carry
// no brand recognition, and made an integrations gallery look like a toy.
//
// Rules this file enforces:
//   1. Marks are INLINE SVG — no runtime fetch, no CDN, no favicon-proxy. A
//      favicon proxy (google s2, duckduckgo, etc.) would ping a third party
//      from every visitor's browser on page load; that's a privacy leak for a
//      decoration.
//   2. Only paths we can render FAITHFULLY get the `svg` tier. A wrong path is
//      worse than no path — it misrepresents someone else's trademark. Brands
//      whose official geometry we can't reproduce exactly fall back to `mono`
//      (a clean monogram tile), which reads as deliberate rather than broken.
//   3. Brand colors are only applied when the hex is known-correct. Inventing a
//      brand color is the same class of error as inventing a number, so unknown
//      brands render in the app's neutral slate instead of a guess.
//
// Usage is nominative (identifying an integration we connect to), which is what
// every brand's guidelines permit. Marks are unmodified apart from color for
// dark-mode legibility, which each of these brands publishes an inverse mark for.

import type { CSSProperties } from "react";

type Tier =
  | { tier: "svg"; viewBox: string; path: string; color: string }
  | { tier: "img"; src: string }
  | { tier: "mono"; text: string; color: string };

// Neutral used for brands with no verified color — never guess a brand hex.
const NEUTRAL = "#94A3B8";

export const BRANDS: Record<string, Tier> = {
  // ── Our own ────────────────────────────────────────────────────────────────
  "blue-agent": { tier: "img", src: "/logomark.svg" },

  // ── Verified marks ─────────────────────────────────────────────────────────
  base: {
    tier: "svg",
    color: "#0052FF",
    viewBox: "0 0 111 111",
    path: "M54.921 110.034C85.359 110.034 110.034 85.402 110.034 55.017C110.034 24.6323 85.359 0 54.921 0C26.0432 0 2.35281 22.1714 0 50.3923H72.8467V59.6416H0C2.35281 87.8625 26.0432 110.034 54.921 110.034Z",
  },
  github: {
    tier: "svg",
    color: "#FFFFFF",
    viewBox: "0 0 16 16",
    path: "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z",
  },
  stripe: {
    tier: "svg",
    color: "#635BFF",
    viewBox: "0 0 24 24",
    path: "M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.992 3.757 7.218c0 4.039 2.467 5.76 6.476 7.219 2.585.92 3.445 1.574 3.445 2.583 0 .98-.84 1.545-2.354 1.545-1.875 0-4.965-.921-6.99-2.109l-.9 5.555C5.175 22.99 8.385 24 11.714 24c2.641 0 4.843-.624 6.328-1.813 1.664-1.305 2.525-3.236 2.525-5.732 0-4.128-2.524-5.851-6.594-7.305z",
  },

  // ── Monogram tier — official geometry not reproduced, color where verified ──
  notion:      { tier: "mono", text: "N",  color: "#FFFFFF" },  // inverse mark on dark
  linear:      { tier: "mono", text: "L",  color: "#5E6AD2" },
  huggingface: { tier: "mono", text: "HF", color: "#FFD21E" },
  sentry:      { tier: "mono", text: "S",  color: NEUTRAL },
  deepwiki:    { tier: "mono", text: "DW", color: NEUTRAL },
  context7:    { tier: "mono", text: "C7", color: NEUTRAL },
};

export type BrandId = keyof typeof BRANDS;

export default function BrandMark({
  brand,
  size = 32,
  className = "",
  style,
}: {
  /** Key into BRANDS. An unknown key renders the neutral fallback tile. */
  brand?: string;
  /** Tile edge length in px. The glyph inside scales to ~56% of it. */
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  const entry = brand ? BRANDS[brand] : undefined;
  const glyph = Math.round(size * 0.56);

  const tile = (children: React.ReactNode, tint?: string) => (
    <span
      className={`inline-flex items-center justify-center rounded-lg shrink-0 overflow-hidden ${className}`}
      style={{
        width: size,
        height: size,
        // A faint wash of the brand color separates logos from the card without
        // turning the grid into a color riot.
        background: tint ? `${tint}14` : "#12121C",
        border: `1px solid ${tint ? `${tint}24` : "#1A1A2E"}`,
        ...style,
      }}
    >
      {children}
    </span>
  );

  if (!entry) {
    return tile(<span className="font-mono text-slate-600" style={{ fontSize: glyph * 0.62 }}>◇</span>);
  }

  if (entry.tier === "img") {
    return tile(
      // eslint-disable-next-line @next/next/no-img-element
      <img src={entry.src} alt="" width={glyph} height={glyph} className="rounded" />,
    );
  }

  if (entry.tier === "svg") {
    return tile(
      <svg
        width={glyph}
        height={glyph}
        viewBox={entry.viewBox}
        fill={entry.color}
        aria-hidden="true"
        role="presentation"
      >
        <path d={entry.path} />
      </svg>,
      entry.color,
    );
  }

  return tile(
    <span
      className="font-mono font-bold leading-none"
      style={{ color: entry.color, fontSize: entry.text.length > 1 ? glyph * 0.52 : glyph * 0.72 }}
    >
      {entry.text}
    </span>,
    entry.color,
  );
}
