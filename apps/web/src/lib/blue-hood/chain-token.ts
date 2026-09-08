/**
 * Blue Hood — the ONE place that answers "which token is <ticker> on <chain>?"
 *
 * ── Why this file exists ──────────────────────────────────────────────────────
 * A bare ticker does not identify a token. NVDA, META, GOOGL and AAPL exist on
 * BOTH Robinhood Chain (4663) and Base (8453) today, as different contracts on
 * chains that share no state. So `findByTicker("NVDA")` is not a lookup — it is
 * a silent chain choice, and on the arrow path it was choosing Robinhood every
 * time, including for arrows that fired on Base.
 *
 * That produced the worst shape of wrong: `enrichFromArrow` attached the
 * ROBINHOOD contract to a Base arrow and set `verified: true`, so the alert DM
 * asserted "✓ verified canonical" over an address on the wrong chain. The public
 * share card did the same and linked it to Robinhood's Blockscout. Those are not
 * display glitches — they are verified claims about a contract, which is the one
 * category this project treats as seriously as inventing an address outright.
 *
 * The fix is not four patches. It is one resolver that CANNOT be called without
 * naming a chain, plus a guard (`scripts/hood-chain-token-check.ts`) asserting
 * no file on the arrow path imports a single-chain registry directly.
 *
 * ── Why it is measured, not hypothetical ─────────────────────────────────────
 * On 2026-09-08 the production feed held 200 arrows spanning 2026-08-17 →
 * 2026-09-08: 142 `robinhood`, 58 pre-`chain` (⟹ robinhood by `chainOf`), and
 * ZERO `base`. The Base desk had been live 16 days and had never fired. So every
 * one of these sites was real code with no victim yet — fixed on purpose while
 * that was still true, rather than after the first Base arrow shipped a
 * Robinhood address to a watcher's DM.
 *
 * ── The two registries this unifies ──────────────────────────────────────────
 *   • robinhood → `lib/robinhood/rwa-registry` (`findByTicker`, 205 tokens),
 *     whose provable claim is RHJ-factory provenance.
 *   • base      → `lib/base-stocks/registry` (`findBaseStock`), the tiny
 *     hand-verified B20 allowlist. Its addresses come from `base.org/stocks`
 *     and are re-checksummed, NEVER ticker-matched — Base carries live
 *     counterfeits using the exact `<TICKER>c` symbol (lesson #280).
 *
 * `verified` is true ONLY when a canonical row matched ON THE ARROW'S OWN CHAIN.
 * A Base ticker absent from the B20 allowlist resolves to `contract: null`,
 * `verified: false` — an honest "we cannot name this token", never a fallback to
 * the other chain's answer. Cross-chain fallback is the bug, not the remedy.
 */
import { findByTicker, RWA_TOKENS } from "@/lib/robinhood/rwa-registry";
import { findBaseStock, BASE_STOCKS } from "@/lib/base-stocks/registry";
import { explorerTokenUrl } from "./detail-support";
import { chainOf, type HoodChain } from "./types";

/** Human label for a chain — for DM/share copy that must say which desk it means. */
export const CHAIN_LABEL: Record<HoodChain, string> = {
  robinhood: "Robinhood Chain",
  base: "Base",
};

/** A ticker resolved against exactly one chain's canonical registry. */
export interface ChainToken {
  chain: HoodChain;
  /** UPPERCASE ticker, echoed for integrity. */
  ticker: string;
  /** "Robinhood Chain" | "Base" — never omit this from user-facing copy. */
  chainLabel: string;
  /**
   * Issuer's company name from THIS chain's registry ("NVIDIA Corporation"),
   * or null when unresolved. Shown next to the ticker on the share card; it must
   * come from the same row as `contract` or the card would caption one chain's
   * token with the other chain's metadata.
   */
  name: string | null;
  /**
   * Canonical contract on `chain`, or null when this chain's registry has no
   * such ticker. NEVER the other chain's address, and never a DEX-pool or user
   * address.
   */
  contract: string | null;
  /** Token page on the explorer that actually indexes `chain`. Null with no contract. */
  explorerTokenUrl: string | null;
  /** True iff a canonical row matched on THIS chain. Gates any "verified" claim. */
  verified: boolean;
}

/**
 * Resolve a ticker against ONE chain's registry.
 *
 * The chain parameter is REQUIRED and has no default. That is the entire point:
 * a defaulted chain is how the bug happened, and a caller who does not know the
 * chain does not know the token either. If you hold a row or an arrow, use
 * {@link resolveArrowToken} so `chainOf`'s back-compat default is applied in the
 * one place that owns it.
 */
export function resolveChainToken(ticker: string, chain: HoodChain): ChainToken {
  const t = ticker.trim().toUpperCase();
  const chainLabel = CHAIN_LABEL[chain];

  // Base: the B20 allowlist. `token` is the B20 share contract (8 decimals,
  // `<TICKER>c` symbol) — verified at admission and re-asserted at read time by
  // `b20-quote.ts`. Absent ⟹ we cannot name it; say so.
  if (chain === "base") {
    const stock = findBaseStock(t);
    return {
      chain,
      ticker: t,
      chainLabel,
      name: stock?.name ?? null,
      contract: stock?.token ?? null,
      explorerTokenUrl: stock ? explorerTokenUrl(chain, stock.token) : null,
      verified: !!stock,
    };
  }

  // Robinhood: unchanged behaviour, byte for byte. RH pays no migration cost for
  // a defect it did not cause — the same principle as `chainOf`/`rowKey`.
  const tok = findByTicker(t);
  return {
    chain,
    ticker: t,
    chainLabel,
    name: tok?.name ?? null,
    contract: tok?.contract ?? null,
    explorerTokenUrl: tok ? explorerTokenUrl(chain, tok.contract) : null,
    verified: !!tok,
  };
}

/**
 * Resolve the token an arrow (or any chain-carrying row) actually refers to.
 *
 * Takes the whole object rather than a ticker so the chain cannot be dropped on
 * the way in — passing `a.ticker` alone is precisely the mistake being fixed.
 * `chainOf` supplies the documented absent ⟹ "robinhood" default, so the 58
 * pre-migration arrows keep resolving exactly as they did.
 */
export function resolveArrowToken(a: { ticker: string; chain?: HoodChain }): ChainToken {
  return resolveChainToken(a.ticker, chainOf(a));
}

/**
 * STRICT per-chain ticker allow-lists, for gates that admit user input.
 *
 * Deliberately NOT `resolveChainToken(...).verified`: on Robinhood that runs
 * `findByTicker`, which also does fuzzy NAME matching ("Tesla" → TSLA, plus a
 * ≥3-char substring pass). Fuzzy is right for a lookup and wrong for an
 * allow-list — a subscription gate that accepts "Apple" writes a KV set keyed on
 * something that is not a ticker. These sets are exact, uppercase, and built
 * once at module load.
 */
const CHAIN_TICKERS: Record<HoodChain, ReadonlySet<string>> = {
  robinhood: new Set(RWA_TOKENS.map((t) => t.ticker.toUpperCase())),
  base: new Set(BASE_STOCKS.map((s) => s.ticker.toUpperCase())),
};

/**
 * Is `ticker` a real token ON `chain`? The chain is REQUIRED for the same reason
 * as {@link resolveChainToken}: "is NVDA valid?" has two different answers and
 * answering it without a chain is how the watch star subscribed a Base row to
 * Robinhood arrows.
 */
export function isChainTicker(ticker: string, chain: HoodChain): boolean {
  return CHAIN_TICKERS[chain].has(ticker.trim().toUpperCase());
}

/** Every ticker the desk on `chain` can be watched on. Sorted, uppercase. */
export function chainTickers(chain: HoodChain): string[] {
  return [...CHAIN_TICKERS[chain]].sort();
}
