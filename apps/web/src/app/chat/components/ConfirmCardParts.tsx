"use client";
// Shared presentational parts for the confirm-only action cards (send / swap /
// bridge). #107: these cards are CONFIRM-ONLY — the amount and route come from
// the LLM's tool call and are display-only. No editable fields = no drift from
// the chat context (Issue 1). If a value is wrong the user re-chats.
//
// Purely presentational — no hooks, no wallet coupling. Each card keeps its own
// tx state machine and passes already-computed strings/nodes into these parts,
// so "design once, apply to all 3" holds without abstracting the money path.

import React from "react";

// Recognisable accents for well-known tickers; everything else hashes into a
// stable palette so the same symbol always gets the same colour.
const KNOWN: Record<string, string> = {
  ETH: "#627EEA", WETH: "#627EEA",
  USDC: "#2775CA", USDG: "#2775CA", USDT: "#26A17B", DAI: "#F5AC37",
  BLUEAGENT: "#4FC3F7", VIRTUAL: "#4FC3F7",
};
const PALETTE = [
  "#4FC3F7", "#34D399", "#F59E0B", "#A78BFA",
  "#F472B6", "#22C55E", "#E879F9", "#60A5FA",
];

/** Stable accent colour for a token symbol (or any short string). */
export function symbolColor(sym: string): string {
  const s = (sym || "").replace(/^\$/, "").toUpperCase();
  if (KNOWN[s]) return KNOWN[s];
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

// A couple of tokens read better as a glyph than as two letters.
const GLYPH: Record<string, string> = { ETH: "Ξ", WETH: "Ξ" };

/**
 * Monogram token chip. An honest placeholder — no fake logo CDN, so we never
 * imply a verified logo we don't have. First 1-2 chars of the ticker on a
 * stable-coloured circle (Ξ for ETH/WETH).
 */
export function TokenGlyph({ symbol, size = 22 }: { symbol: string; size?: number }) {
  const s = (symbol || "?").replace(/^\$/, "").toUpperCase();
  const label = GLYPH[s] ?? s.slice(0, 2);
  return (
    <span
      className="inline-flex items-center justify-center rounded-full font-bold text-black shrink-0"
      style={{ width: size, height: size, background: symbolColor(s), fontSize: Math.round(size * 0.42) }}
    >
      {label}
    </span>
  );
}

/** Subtle gradient avatar derived from an address — for the "recipient" side. */
export function AddrGlyph({ address, size = 22 }: { address: string; size?: number }) {
  const seed = (address || "0x000000").slice(2, 8);
  return (
    <span
      className="inline-block rounded-full shrink-0"
      style={{ width: size, height: size, background: `linear-gradient(135deg, ${symbolColor(seed)}, #0a0a0f)` }}
    />
  );
}

/** Small filled dot in a chain accent — the bridge shows chains, not tokens. */
export function ChainDot({ color }: { color: string }) {
  return <span className="inline-block w-2.5 h-2.5 rounded-full shrink-0" style={{ background: color }} />;
}

// ── Quantity-word resolution ────────────────────────────────────────────────
// #107 made the action cards confirm-only (no editable amount). But users say
// "swap ALL USAR", "bridge my MAX ETH", "send HALF" — words, not numbers. The
// LLM passes the word through verbatim; the card resolves it against the live
// balance it already reads. This keeps confirm-only intact: the number is
// DERIVED from the user's own balance + the word they said, never typed, so
// there's still no drift from the chat context (Issue 1 stays fixed).

/** Words the card accepts in place of a number: all | max | half | "50%". */
export const SYMBOLIC_AMOUNT_RE = /^(all|max|half|\d+(?:\.\d+)?%)$/i;

// Native-gas reserve kept back when resolving all/max/100% on NATIVE ETH, so the
// wallet still has enough to pay for the tx it's about to sign. Base + RH are
// L2s (gas is a fraction of a cent) but a swap signs approve+swap, so leave a
// little headroom. ERC-20 amounts need no reserve — gas is paid in ETH, apart.
export const NATIVE_GAS_RESERVE = 0.0001;

export interface ResolvedQuantity {
  /** Numeric amount to sign, or null when it can't be resolved yet (no balance). */
  value: number | null;
  /** True when the raw input was a quantity word rather than a plain number. */
  symbolic: boolean;
  /** The word, lower-cased ("all" | "max" | "half" | "50%") — for the UI hint. */
  word?: string;
}

/**
 * Resolve a marker amount that may be a plain number OR a quantity word.
 * - plain number → parsed as-is (symbolic:false).
 * - all | max     → full balance (native: minus NATIVE_GAS_RESERVE).
 * - half          → balance / 2.
 * - "N%"          → balance × N / 100 (native 100% keeps the gas reserve).
 * Returns value:null while balance is still loading so the caller can wait.
 */
export function resolveQuantity(
  raw: string | number | undefined,
  balance: number | null,
  opts?: { isNative?: boolean },
): ResolvedQuantity {
  const s = String(raw ?? "").trim();
  if (!SYMBOLIC_AMOUNT_RE.test(s)) {
    const n = parseFloat(s);
    return { value: Number.isFinite(n) ? n : null, symbolic: false };
  }
  const word = s.toLowerCase();
  if (balance == null || !Number.isFinite(balance) || balance <= 0) {
    return { value: null, symbolic: true, word };
  }
  const reserve = opts?.isNative ? NATIVE_GAS_RESERVE : 0;
  const usable = Math.max(balance - reserve, 0);
  let value: number;
  if (word === "all" || word === "max") {
    value = usable;
  } else if (word === "half") {
    value = balance / 2;
  } else {
    const pct = parseFloat(word); // "50%" → 50
    value = opts?.isNative && pct >= 100 ? usable : (balance * pct) / 100;
  }
  value = Math.max(value, 0);
  return { value: value > 0 ? value : null, symbolic: true, word };
}

/**
 * Truncate a plain decimal string to at most `dp` fractional digits. FLOORS
 * (never rounds up) so a resolved "all"/"half"/"N%" can't tip a hair over the
 * real balance. parseUnits() throws when a string carries more decimals than
 * the token supports — and a symbolic fraction easily does (half of an odd
 * 6-dp balance → 7 dp). Call this right before parseUnits(amount, dec) on any
 * client that signs. Non-exponential inputs only (the cards never feed it a
 * word or "1e-7"); returns the input unchanged when it has no fractional part.
 */
export function clampDecimals(s: string, dp: number): string {
  if (!s || !s.includes(".")) return s;
  const [intPart, fracPart = ""] = s.split(".");
  const frac = dp > 0 ? fracPart.slice(0, dp) : "";
  let out = frac ? `${intPart}.${frac}` : intPart;
  if (out.includes(".")) out = out.replace(/0+$/, "").replace(/\.$/, "");
  return out;
}

export interface PreviewSide {
  /** Leading avatar/glyph (TokenGlyph / AddrGlyph). */
  glyph?: React.ReactNode;
  /** Big line — the amount, or an address for a transfer. */
  top: React.ReactNode;
  /** Small line under it — symbol / chain / "recipient". */
  bottom?: React.ReactNode;
}

/**
 * The compact "IN → OUT" confirm preview line shared by all three cards.
 * Left = what you pay, right = what you get (or the recipient). Display-only.
 */
export function ConfirmPreview({
  left, right, arrow = "→",
}: { left: PreviewSide; right: PreviewSide; arrow?: string }) {
  return (
    <div className="rounded-lg border border-[#1A1A2E] bg-[#050508] p-3 mb-2 flex items-center gap-2">
      <PreviewCol side={left} align="left" />
      <span className="text-slate-500 text-[13px] px-0.5 shrink-0">{arrow}</span>
      <PreviewCol side={right} align="right" />
    </div>
  );
}

/**
 * The banner a card shows when it could not read the balance it is about to
 * spend against — the rendered half of `resolveSpend`'s `unverified`.
 *
 * One component for the same reason `useSpendableBalance` is one hook: all
 * three cards reach this state and must not grow three different ways of
 * admitting it. `onRetry` is REQUIRED, not optional, so a card cannot render
 * the admission without also rendering the way out — a gate that stops the
 * user with no path forward is not a safe card, it is a broken one.
 *
 * Presentational, per this file's contract: the callback and the busy flag are
 * both derived by the caller from the very queries the retry re-runs.
 */
export function UnverifiedBalance({
  symbol, onRetry, busy,
}: { symbol?: string; onRetry: () => void; busy: boolean }) {
  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5 mb-2 flex items-start justify-between gap-2">
      <div className="text-[10px] text-amber-300 leading-relaxed">
        <span className="font-bold">Couldn&apos;t read your {symbol ? `${symbol} ` : ""}balance.</span>{" "}
        Confirming now could spend gas on a transaction that can&apos;t settle, so it&apos;s held
        until the read succeeds. This says nothing about what you hold.
      </div>
      <button onClick={onRetry} disabled={busy}
        className="shrink-0 text-[10px] px-2 py-1 rounded-lg font-bold transition-opacity hover:opacity-80 disabled:opacity-50"
        style={{ background: "#F59E0B15", color: "#F59E0B", border: "1px solid #F59E0B35" }}>
        {busy ? "reading…" : "Retry"}
      </button>
    </div>
  );
}

function PreviewCol({ side, align }: { side: PreviewSide; align: "left" | "right" }) {
  const right = align === "right";
  return (
    <div className={`flex items-center gap-1.5 min-w-0 flex-1 ${right ? "justify-end" : ""}`}>
      {!right && side.glyph}
      <div className={`min-w-0 ${right ? "text-right" : ""}`}>
        <div className="text-[13px] text-white truncate">{side.top}</div>
        {side.bottom != null && <div className="text-[9px] text-slate-500 truncate">{side.bottom}</div>}
      </div>
      {right && side.glyph}
    </div>
  );
}
