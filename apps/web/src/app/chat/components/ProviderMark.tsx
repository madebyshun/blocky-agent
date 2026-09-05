"use client";

import { resolveProvider, type ModelProvider } from "@/lib/model-providers";

/**
 * The publisher's mark for a model, in a tile tinted with that provider's accent.
 *
 * Falls back to a monogram in the same tile chrome when no vector mark exists
 * (see `mark` in `model-providers.ts`). The fallback is a designed state, not a
 * broken one: it reads as "no mark on file", which is honest, where a
 * hand-approximated logo would read as a claim.
 */
export default function ProviderMark({
  modelId,
  name,
  size = 36,
  className = "",
}: {
  modelId: string;
  name?: string | null;
  size?: number;
  className?: string;
}) {
  const p: ModelProvider = resolveProvider(modelId, name);
  const glyph = Math.round(size * 0.56);

  return (
    <span
      title={p.label}
      className={`inline-flex items-center justify-center rounded-xl shrink-0 border ${className}`}
      style={{
        width: size,
        height: size,
        background: `${p.accent}14`,
        borderColor: `${p.accent}26`,
      }}
    >
      {p.mark ? (
        // eslint-disable-next-line @next/next/no-img-element -- static SVG, no loader needed
        <img
          src={`/models/${p.id}.svg`}
          alt={p.label}
          width={glyph}
          height={glyph}
          style={{ width: glyph, height: glyph }}
        />
      ) : (
        <span
          aria-label={p.label}
          className="font-mono font-bold leading-none tracking-tight"
          style={{ fontSize: Math.round(size * 0.34), color: p.accent }}
        >
          {p.monogram}
        </span>
      )}
    </span>
  );
}
