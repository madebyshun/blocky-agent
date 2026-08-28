/**
 * Blue Hood — what the row-expand detail panel is allowed to show, per chain.
 *
 * WHY THIS IS ITS OWN MODULE
 * --------------------------
 * Same reason as `oracle-age.ts`: `TickerDetailPanel.tsx` and `HoodClient.tsx`
 * are `"use client"` React trees (wagmi, Privy, the whole board) that no plain
 * tsx script can import, so any rule living inline in them is enforced only by
 * reading the diff. Split out, this is dependency-free and
 * `scripts/hood-detail-chain-check.ts` exercises it directly — including the
 * DIFFERENTIAL that matters: base and robinhood must not plan the same way.
 *
 * THE BUG THIS CLOSES
 * -------------------
 * The panel resolved its two data blocks by BARE TICKER:
 *
 *     callTool("rh-stock-liquidity", { ticker })   // M3
 *     callTool("rh-stock-holders",   { ticker })   // D1
 *
 * Both tools read Robinhood Chain (4663) and only Robinhood Chain. NVDA, META,
 * GOOGL and AAPL exist on BOTH desks as DIFFERENT tokens with DIFFERENT pools,
 * so every Base row on the board rendered RH pools, RH TVL, RH holders and an
 * RH slippage table under a BASE badge. Measured on production 2026-08-28, the
 * error was not even directionally consistent — NVDA read $109.52M in the panel
 * against $1.71M in its own row (64× over), GOOGL 17× over, AAPL 1.4× over,
 * META 0.6× UNDER. No mental correction is possible from a wrong number that
 * swings both ways, which is what made the money-facing slippage strip unsafe.
 *
 * THE FIX IS NOT A DIFFERENT LOOKUP
 * ---------------------------------
 * Resolving the ticker against the Base registry instead would be the same
 * defect wearing a different registry: a ticker string is not an identity, a
 * chain + address is. There is no Base liquidity/holders source wired today, so
 * the honest output is to show NOTHING and say why — the `brief_status:
 * "skipped"` pattern from `ArrowBriefBlock.tsx`. Missing data is honest; a
 * number from the wrong chain is not.
 */
import type { HoodChain } from "./types";

/** Whether a block has a real source for this chain. */
export type DetailBlock = "render" | "skip";

export interface DetailPanelPlan {
  /**
   * Whether to call `/api/hood/ticker-detail` at all. `false` means the panel
   * must not fetch — not "fetch and hide", which would still burn two 15s tool
   * calls and, worse, would leave the provenance line ("fresh · updated 5s
   * ago") asserting that something on THIS chain had just been measured.
   */
  fetch: boolean;
  liquidity: DetailBlock;
  holders: DetailBlock;
  /** Why liquidity is skipped. Non-null iff `liquidity === "skip"`. */
  liquidityNote: string | null;
  /** Why holders is skipped. Non-null iff `holders === "skip"`. */
  holdersNote: string | null;
}

/**
 * The one decision. Takes a CHAIN and nothing else — deliberately, so the
 * mistake this module exists to prevent (deciding from a ticker) cannot be made
 * here even by accident.
 *
 * Note what the notes do NOT say. They do not say "unavailable" or "failed":
 * nothing was tried and nothing broke. They name the actual cause — the tool is
 * Robinhood-only — for the same reason `ArrowBriefBlock`'s skipped branch had to
 * stop claiming "A4 was unavailable" when A4 had simply never been asked.
 */
export function detailPanelPlan(chain: HoodChain): DetailPanelPlan {
  if (chain === "robinhood") {
    return {
      fetch: true,
      liquidity: "render",
      holders: "render",
      liquidityNote: null,
      holdersNote: null,
    };
  }
  // Every non-RH desk, present and future. Defaulting the UNKNOWN chain to
  // "skip" is the safe direction: a new desk shows nothing until someone wires
  // it a source, rather than silently inheriting RH numbers on day one — which
  // is exactly how Base rows came to display RH pools.
  return {
    fetch: false,
    liquidity: "skip",
    holders: "skip",
    liquidityNote:
      "Liquidity is not wired for this desk. M3 reads Robinhood Chain pools only — "
      + "the numbers it returns for this ticker belong to a different token on a different chain.",
    holdersNote:
      "Holders are not wired for this desk. D1 reads the Robinhood Chain explorer only — "
      + "the addresses it returns hold a different token on a different chain.",
  };
}

/**
 * Token page on the explorer that actually indexes this chain.
 *
 * A Base B20 does not exist on Robinhood's Blockscout and an RH token does not
 * exist on Basescan, so a hardcoded host does not merely look wrong — it 404s
 * or, worse, resolves to an unrelated contract that happens to share the
 * address space. #308 caught this class once already for the row-level links;
 * the panel's own `contract ↗` was missed because it sits behind an expand.
 *
 * The Robinhood branch must stay byte-for-byte what it was.
 */
export function explorerTokenUrl(chain: HoodChain, contract: string): string {
  return chain === "base"
    ? `https://basescan.org/token/${contract}`
    : `https://robinhoodchain.blockscout.com/token/${contract}`;
}

/** Address page, same rule as `explorerTokenUrl`. */
export function explorerAddressUrl(chain: HoodChain, address: string): string {
  return chain === "base"
    ? `https://basescan.org/address/${address}`
    : `https://robinhoodchain.blockscout.com/address/${address}`;
}

/**
 * KV key for the cached detail payload.
 *
 * ⚠️ THIS DELIBERATELY DOES NOT USE `chainSeg` from `kv-keys.ts`. That helper
 * returns the EMPTY string for robinhood so live keys stay byte-identical, and
 * it is right to do so for `bh:arrow:open:*` and `bh:arrow:cooldown:*` — those
 * hold DURABLE STATE, and re-keying them would orphan a real open position.
 * `bh:detail:*` holds a 300-second cache. The whole migration cost is one slow
 * click per ticker, re-warmed by the next sparkline cron pass, so there is
 * nothing to protect and the key can afford to say what it is out loud. A raw
 * KV scan should never leave a reader guessing which desk a payload came from.
 *
 * The ticker alone was the key before this. That is the bug at the storage
 * layer: it was latent only because nothing had yet written a Base payload, and
 * the first Base path added would have poisoned the RH entry for the same
 * ticker under a name that gave no hint the two could collide.
 */
export function detailCacheKey(chain: HoodChain, ticker: string): string {
  return `bh:detail:${chain}:${ticker.toUpperCase()}`;
}
