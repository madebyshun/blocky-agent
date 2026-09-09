"use client";

import { resolveStockLogo, type StockLogo } from "@/lib/blue-hood/stock-logo";
import type { HoodChain } from "@/lib/blue-hood/types";

/**
 * The company mark for a stock row, resolved against the row's OWN chain.
 *
 * `chain` is REQUIRED and has no default. Every other prop could be optional;
 * this one cannot, because `chainOf`'s "absent ⟹ robinhood" rule is right for
 * reading legacy KV rows and wrong here — a Base row that forgot to pass its
 * chain would silently render whatever RH lists under that ticker. Making the
 * prop required moves that from a runtime mistake to a compile error.
 *
 * Three rendered states, mirroring `ProviderMark`'s reasoning: the fallback is a
 * designed state, not a broken one. A monogram reads as "no mark on file" and a
 * `?` reads as "this chain does not list this ticker" — both honest. A
 * hand-approximated logo would read as a claim, and a logo borrowed from the
 * other chain's registry would be a *false* claim.
 */
export default function StockMark({
  ticker,
  chain,
  size = 28,
  className = "",
}: {
  ticker: string;
  chain: HoodChain;
  size?: number;
  className?: string;
}) {
  const logo: StockLogo = resolveStockLogo(chain, ticker);
  const glyph = Math.round(size * 0.58);

  // The monogram is the ticker itself, so unlike ProviderMark's fixed two
  // letters the type has to shrink to fit rather than overflow the tile.
  // MEASURED across both registries: tickers run 1–5 chars — 2 at one char
  // (F, P), 125 at four, and exactly one at five (GOOGL). The ladder covers
  // that full range rather than assuming the common four.
  const chars = logo.monogram.length;
  const fontSize = Math.round(size * (chars <= 1 ? 0.44 : chars <= 3 ? 0.34 : chars <= 4 ? 0.27 : 0.22));

  const title = logo.mark
    ? logo.label
    : logo.listed
      ? `${logo.label} — no mark on file`
      : `${logo.ticker} is not listed on ${logo.chainLabel}`;

  return (
    <span
      title={title}
      className={`inline-flex items-center justify-center rounded-lg shrink-0 border ${className}`}
      style={{
        width: size,
        height: size,
        background: `${logo.accent}14`,
        borderColor: `${logo.accent}26`,
      }}
    >
      {logo.mark && logo.slug ? (
        // eslint-disable-next-line @next/next/no-img-element -- static local SVG, no loader needed
        <img
          src={`/stocks/${logo.slug}.svg`}
          alt={logo.label}
          width={glyph}
          height={glyph}
          style={{ width: glyph, height: glyph }}
        />
      ) : (
        <span
          aria-label={title}
          className="font-mono font-bold leading-none tracking-tight"
          style={{ fontSize, color: logo.accent }}
        >
          {logo.monogram}
        </span>
      )}
    </span>
  );
}
