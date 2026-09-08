/**
 * The company mark for a stock row on the Blue Hood desk — resolved against the
 * registry of the row's OWN chain, never against "the registry".
 *
 * ── Why the key is chain-qualified ────────────────────────────────────────────
 *
 * A logo is an assertion about identity. Keying it by bare ticker would recreate
 * #219 / #161 in pixels: Base NVDA and RH NVDA would share one mark, and — far
 * worse — an RH-only ticker rendered on a Base row would be painted with a real
 * company's logo even though the Base registry never admitted it. That is the
 * sixth bare-ticker bug in this family, and the one that is hardest to doubt,
 * because a logo *looks* like it was looked up.
 *
 * MEASURED blast radius (2026-09-09, the day TSLA was admitted): `RWA_TOKENS`
 * lists 181 stocks and `BASE_STOCKS` lists 8, all 8 of which are also on RH. So
 * a bare-ticker resolver would confidently mark **173 tickers** that the Base
 * desk has never verified. Every admission moves these two numbers in opposite
 * directions, and nothing checks this prose — read them as a dated measurement,
 * and re-measure rather than quoting. Same shape as
 * #280's counterfeit TSLAc, which carried an identical `symbol` AND an identical
 * `name` and still answered `isB20() == false`: a near-match on one attribute is
 * not the attribute you needed.
 *
 * ── Why this does not reuse `rowKey` ──────────────────────────────────────────
 *
 * `rowKey` returns a BARE ticker for robinhood (`"NVDA"`) and a qualified one for
 * Base (`"base:NVDA"`), deliberately, so existing KV keys and hrefs keep
 * resolving. This table has no legacy readers to keep compatible, so it is
 * unambiguous by construction: `${chain}:${ticker}` on BOTH chains. Reusing
 * `rowKey` here would leave the RH half of the mark table bare-ticker-keyed —
 * i.e. it would import the exact defect this module exists to prevent.
 *
 * ── Why this holds NEITHER registry, and gates before it labels ───────────────
 *
 * `chain-token.ts` is the ONE module in `lib/blue-hood` allowed to import both
 * registries, asserted by `hood-chain-token-check`. This module imports neither:
 * a second dual-registry file is a second place a cross-chain fallback can be
 * written, which is the whole defect. So the door is `resolveChainToken`.
 *
 * But `resolveChainToken` is deliberately NOT the gate. On Robinhood it runs
 * `findByTicker`, which falls back to substring NAME matching — right for a
 * search box, wrong for an identity claim. MEASURED against the live registry:
 * `findByTicker("Micro")` returns **AMD** (Advanced Micro Devices), not Micron;
 * `findByTicker("Inc")` returns **AAPL**, because almost every company name
 * contains it. A logo routed through that would be a guess wearing a lookup's
 * clothes.
 *
 * So `listed` is decided by `isChainTicker` — the exact, uppercase, per-chain
 * allow-list `chain-token.ts` built for exactly this ("fuzzy is right for a
 * lookup and wrong for an allow-list"). Only AFTER that gate passes do we ask
 * `resolveChainToken` for the label, and by then `findByTicker` can only return
 * from its exact `BY_TICKER` branch — the fuzzy passes below it are unreachable.
 * That is asserted, not narrated: the guard feeds this resolver the company
 * NAMES ("Apple", "Tesla") that `findByTicker` does resolve, and requires them to
 * come back unlisted. Drop the gate and those checks fail.
 *
 * ── Three states, not two ─────────────────────────────────────────────────────
 *
 *   listed + mark   → the company's mark from `public/stocks/<slug>.svg`
 *   listed, no mark → the ticker in a neutral tile: "we list this, no mark on file"
 *   NOT listed      → "?" in a dimmer tile: "this chain's registry does not
 *                     admit this ticker" — and never, under any condition, a
 *                     real company's logo
 *
 * The neutral tint on the two fallbacks is deliberate. Rendering MSTR in
 * MicroStrategy red while refusing to draw MicroStrategy's mark would be a
 * quieter version of the same false claim; the tint has to agree with the glyph.
 */

import { isChainTicker, resolveChainToken, CHAIN_LABEL } from "./chain-token";
import type { HoodChain } from "./types";

export interface StockLogo {
  /** `${chain}:${ticker}` — chain-qualified on BOTH chains, always. */
  key: string;
  /** Normalised (upper-cased) ticker. */
  ticker: string;
  chain: HoodChain;
  /**
   * "Robinhood Chain" | "Base" — from `CHAIN_LABEL`, never hardcoded at a call
   * site. The desk name in user-facing copy has to come from the same resolution
   * as the label, for the reason `hood-chain-token-check` asserts on the share
   * card: a hardcoded desk name is a claim nothing verified.
   */
  chainLabel: string;
  /**
   * Company name as THIS CHAIN's registry spells it, or the bare ticker when the
   * chain does not list it. Never borrowed from the other chain.
   */
  label: string;
  /** Whether this chain's own registry admits this ticker. */
  listed: boolean;
  /** Whether `public/stocks/<slug>.svg` exists. `false` ⟹ render `monogram`. */
  mark: boolean;
  /** Filename stem under `public/stocks/`. `null` whenever `mark` is false. */
  slug: string | null;
  /** Matches the rendered mark so the tile tint and the glyph agree. */
  accent: string;
  /** Rendered when `mark` is false. */
  monogram: string;
}

/** Tile colour for a ticker we list but hold no mark for. */
const NEUTRAL_ACCENT = "#94A3B8";
/** Tile colour for a ticker this chain's registry does not list at all. */
const UNLISTED_ACCENT = "#64748B";

/**
 * `${chain}:${ticker}` → the mark we are willing to assert, and the colour it is
 * actually rendered in (see `public/stocks/README.md` for how each hex was
 * derived — brand hex, lifted toward white only when it fails the readability
 * floor on the `#050508` background).
 *
 * Every entry is written out per chain even where the two agree. That costs a
 * duplicated line and buys the property that no ticker can inherit a mark from a
 * chain it was never verified on.
 *
 * Absent on purpose — these companies have NO mark in simple-icons v16.30.0, so
 * they render a monogram rather than something drawn from memory:
 *   AMZN (Amazon)  MSFT (Microsoft)  ORCL (Oracle)  MU (Micron)
 *   SNDK (SanDisk) CRWV (CoreWeave)  USAR (USA Rare Earth)
 *   QQQ · SGOV · SLV · SPY (Invesco / iShares / SPDR fund marks)
 *
 * Absent on purpose despite a *similar* icon existing — the near-match trap:
 *   • MSTR — our registries name it "Strategy Inc.". simple-icons ships
 *     `siMicrostrategy`, sourced from microstrategy.com's press kit: the RETIRED
 *     brand. A current mark for a former name is a claim about who this is.
 *   • BABA — our registries name it "Alibaba Group". simple-icons ships only
 *     "Alibaba Cloud" and "Alibaba.com" — subsidiaries, not the group. This is
 *     the `isB20(StudentCoin) == true` shape exactly: an approximately-right
 *     attribute does not substitute for the one that was needed.
 *
 * Present via a documented substitution, same shape as `anthropic → claude` on
 * the models page:
 *   • GOOGL — registries name it "Alphabet Inc."; simple-icons has no Alphabet
 *     mark. The Google mark is used because Google is a current operating brand
 *     of that same entity. The rule this follows, stated once: *the mark must
 *     belong to the entity our registry names — a current brand of that entity
 *     is allowed, a retired name is not.* That rule admits GOOGL and rejects
 *     MSTR, which is why it is written down rather than applied case by case.
 */
const MARKS: Readonly<Record<string, { slug: string; accent: string }>> = {
  // ── Base 8453 (Coinbase B20) ──
  "base:AAPL": { slug: "apple", accent: "#FFFFFF" },
  "base:GOOGL": { slug: "google", accent: "#4B8BF5" },
  "base:META": { slug: "meta", accent: "#6FA8ED" },
  "base:NVDA": { slug: "nvidia", accent: "#76B900" },
  // `base:TSLA` arrives in the SAME commit that admits TSLA to `BASE_STOCKS`,
  // and that is not tidiness. Split across two commits, the first one FAILS
  // `hood-logo-check` by design — MEASURED before merging: 55/56, naming the
  // site ("HALF-MARKED: TSLA"). Admitting a ticker and giving it its mark is one
  // decision; a desk that lists a company without marking it shows that company
  // two ways, which is the thing this table exists to prevent.
  "base:TSLA": { slug: "tesla", accent: "#E06666" },

  // ── Robinhood Chain 4663 (RHJ) ──
  "robinhood:AAPL": { slug: "apple", accent: "#FFFFFF" },
  "robinhood:AMD": { slug: "amd", accent: "#F2555B" },
  "robinhood:COIN": { slug: "coinbase", accent: "#4D86FF" },
  "robinhood:CRCL": { slug: "circle", accent: "#9880BA" },
  "robinhood:GOOGL": { slug: "google", accent: "#4B8BF5" },
  "robinhood:INTC": { slug: "intel", accent: "#4095D4" },
  "robinhood:META": { slug: "meta", accent: "#6FA8ED" },
  "robinhood:NVDA": { slug: "nvidia", accent: "#76B900" },
  "robinhood:PLTR": { slug: "palantir", accent: "#FFFFFF" },
  "robinhood:SPCX": { slug: "spacex", accent: "#FFFFFF" },
  "robinhood:TSLA": { slug: "tesla", accent: "#E06666" },
};

/** Every slug referenced above, for the guard that checks each has a file. */
export const STOCK_MARK_SLUGS: readonly string[] = Array.from(
  new Set(Object.values(MARKS).map((m) => m.slug)),
).sort();

/** The mark table's keys, exported so a guard can assert every one is qualified. */
export const STOCK_MARK_KEYS: readonly string[] = Object.keys(MARKS).sort();

/**
 * Chain-qualified logo key. Exported so callers and guards spell it one way.
 * Unlike `rowKey`, this is qualified on both chains — see the header.
 */
export function logoKey(chain: HoodChain, ticker: string): string {
  return `${chain}:${ticker.trim().toUpperCase()}`;
}

/**
 * The name THIS chain's registry gives this ticker, or `null` if it does not
 * list it.
 *
 * Two steps, in this order, and the order is the point:
 *   1. `isChainTicker` — the EXACT per-chain allow-list. This is what decides
 *      "listed", so a company name never gets through.
 *   2. `resolveChainToken(...).name` — the label, read from the row that the
 *      one dual-registry module matched on THIS chain. Unreachable for a fuzzy
 *      input because step 1 already rejected it.
 *
 * Swapping the order, or using `.verified` as the gate, re-opens the name match.
 */
function registryName(chain: HoodChain, ticker: string): string | null {
  if (!isChainTicker(ticker, chain)) return null;
  return resolveChainToken(ticker, chain).name;
}

/**
 * Resolve the mark for `ticker` **as listed on `chain`**.
 *
 * `chain` is the first parameter and is required: there is no overload that
 * takes a ticker alone, so a call site physically cannot forget to say which
 * desk it is on. A ticker string does not identify a token — chain + address
 * does — and this function refuses to pretend otherwise.
 */
export function resolveStockLogo(chain: HoodChain, ticker: string): StockLogo {
  const t = ticker.trim().toUpperCase();
  const key = `${chain}:${t}`;
  const chainLabel = CHAIN_LABEL[chain];
  const name = registryName(chain, t);

  if (name === null) {
    // Not listed on this chain. It may well be listed on the other one — that is
    // exactly the case a bare-ticker resolver gets wrong, so we say "unknown"
    // rather than borrowing the other chain's answer.
    return {
      key,
      ticker: t,
      chain,
      chainLabel,
      label: t,
      listed: false,
      mark: false,
      slug: null,
      accent: UNLISTED_ACCENT,
      monogram: "?",
    };
  }

  const found = MARKS[key];
  if (!found) {
    return {
      key,
      ticker: t,
      chain,
      chainLabel,
      label: name,
      listed: true,
      mark: false,
      slug: null,
      accent: NEUTRAL_ACCENT,
      monogram: t,
    };
  }

  return {
    key,
    ticker: t,
    chain,
    chainLabel,
    label: name,
    listed: true,
    mark: true,
    slug: found.slug,
    accent: found.accent,
    monogram: t,
  };
}
