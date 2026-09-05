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
 * chain + address is. Where no source exists the honest output is to show
 * NOTHING and say why — the `brief_status: "skipped"` pattern from
 * `ArrowBriefBlock.tsx`. Missing data is honest; a number from the wrong chain
 * is not.
 *
 * THE CORRECTION THAT FOLLOWED
 * ---------------------------
 * The first version of this module skipped BOTH blocks on Base with the note
 * "Liquidity is not wired for this desk." For holders that is true. For
 * liquidity it was FALSE, and visibly so: the same expanded row showed
 * TVL $1.90M / VOL 24H $10.43M an inch above the sentence denying it.
 *
 * What is RH-only is the M3 *tool*, not the data. The Base desk measures its own
 * depth every cycle — `base-poller.ts` sets `tvl_usd`/`total_tvl_usd` from the
 * Aerodrome pool's liquidity and `volume_24h_usd` from its 24h volume, and
 * `registry.ts` will not admit a Base token at all until that pool prints both.
 * `rule-engine.ts` then gates every arrow on that same number against
 * `DUST_TVL_USD`. So the panel was denying a figure the product elsewhere
 * treats as good enough to trade on.
 *
 * That mattered beyond the one panel: an unearned "not wired" devalues every
 * honest "skipped" note next to it, and it would have misinformed the #152 depth
 * question. The block is therefore sourced from the ROW rather than from a tool
 * — see `DetailSource` below.
 */
import type { HoodChain } from "./types";

/**
 * WHERE a block's numbers come from on this chain — not merely whether to draw
 * it. The distinction is the whole correction above: "we cannot show this" and
 * "the RH tool cannot show this, but the desk already measured it" are different
 * facts, and collapsing them into one boolean is what produced a panel that
 * contradicted the row it was attached to.
 */
export type DetailSource =
  /** `/api/hood/ticker-detail` → M3/D1. Robinhood Chain only. */
  | "tool"
  /** Already measured by this desk's own poll and carried on the snapshot row.
   *  No fetch, no tool call, no cross-chain lookup. */
  | "row"
  /** No source on this chain. Render the note instead of a number. */
  | "none";

export interface DetailPanelPlan {
  /**
   * Whether to call `/api/hood/ticker-detail` at all. `false` means the panel
   * must not fetch — not "fetch and hide", which would still burn two 15s tool
   * calls and, worse, would leave the provenance line ("fresh · updated 5s
   * ago") asserting that something on THIS chain had just been measured.
   */
  fetch: boolean;
  liquidity: DetailSource;
  holders: DetailSource;
  /**
   * What the reader must know about the liquidity block: why it is absent
   * (`"none"`) or how it is narrower than the tool-backed one (`"row"`).
   * Non-null iff the source is NOT `"tool"` — a block that is anything less
   * than the full render has to say so, and the full render needs no caveat.
   */
  liquidityNote: string | null;
  /** Same contract as `liquidityNote`. */
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
      liquidity: "tool",
      holders: "tool",
      liquidityNote: null,
      holdersNote: null,
    };
  }

  // Holders: genuinely unsourced on every non-RH desk. D1 reads the RH explorer
  // and nothing else, and no other desk has a holder index wired. Unchanged
  // wording — this note was always correct.
  const holdersNote =
    "Holders are not wired for this desk. D1 reads the Robinhood Chain explorer only — "
    + "the addresses it returns hold a different token on a different chain.";

  if (chain === "base") {
    return {
      // Still FALSE. Nothing here calls M3/D1 — the numbers come off the
      // snapshot row the board already has, so there is no request to make and
      // no provenance line claiming a fetch that never happened.
      fetch: false,
      liquidity: "row",
      holders: "none",
      liquidityNote:
        "Measured on Base by this desk's own poll — the single Aerodrome pool it admits for "
        + "this token, read fresh each cycle. M3 is not consulted: it reads Robinhood Chain "
        + "pools only. No slippage curve, because the poll records the pool's liquidity in "
        + "USD but not its reserves, which is what the xy=k bound needs.",
      holdersNote,
    };
  }

  // Every OTHER non-RH desk, present and future. The default arm stays "none"
  // for both blocks on purpose: `"row"` is not a property of being non-RH, it is
  // a property of Base's poller actually populating `total_tvl_usd` and
  // `volume_24h_usd`. A new desk whose poller does not must show nothing rather
  // than render whatever happens to be on its row — the same safe direction that
  // stopped a new desk from inheriting RH numbers on day one.
  return {
    fetch: false,
    liquidity: "none",
    holders: "none",
    liquidityNote:
      "Liquidity is not wired for this desk. M3 reads Robinhood Chain pools only — "
      + "the numbers it returns for this ticker belong to a different token on a different chain.",
    holdersNote,
  };
}

/**
 * The 501 sentence for `/api/hood/ticker-detail`, composed FROM THE PLAN.
 *
 * The route used to hardcode `No liquidity/holders source is wired for chain
 * "${chain}"` — the same false claim the panel was making, on the surface where
 * it is worse. A human reading the panel could at least see the row's TVL an
 * inch above and distrust the sentence; a machine gets only this string, and
 * "no source is wired" tells it to stop looking for a number that exists one
 * route away. Composing from `plan.liquidity` / `plan.holders` means the
 * sentence cannot drift from what the UI draws, because there is only one
 * decision and both read it.
 *
 * Returns `null` — not `""` — when the endpoint CAN serve this chain, so a
 * caller that forgets to check gets a type error rather than an empty error
 * message that reads like success.
 */
export function detailUnavailableReason(chain: HoodChain): string | null {
  const plan = detailPanelPlan(chain);
  if (plan.fetch) return null;
  const where = (block: string, source: DetailSource): string => {
    switch (source) {
      case "tool":
        // Unreachable while `fetch` is false. Stated rather than assumed: an
        // exhaustive switch is what makes adding a fourth source a compile
        // error here instead of a silently mis-worded sentence in production.
        return `${block} is served by this endpoint`;
      case "row":
        return (
          `${block} IS measured on this chain — by the desk's own poll, not by M3 — and is `
          + `carried on the /api/hood/snapshot row (total_tvl_usd, volume_24h_usd, pool_ref)`
        );
      case "none":
        return `${block} has no source on this chain`;
    }
  };
  return (
    `M3 and D1 read Robinhood Chain only, so this endpoint has nothing to serve for chain `
    + `"${chain}". ${where("Liquidity", plan.liquidity)}; ${where("holders", plan.holders)}.`
  );
}

/** The liquidity figures a snapshot row already carries, chain-agnostic. */
export interface RowLiquidity {
  totalTvlUsd: number | null;
  volume24hUsd: number | null;
  /** The pool's own address on THIS chain (`pool_ref` on the row). */
  poolRef: string | null;
}

export interface RowLiquidityView {
  /** Did the poll actually come back with a depth reading this cycle? */
  measured: boolean;
  tvlUsd: number | null;
  volume24hUsd: number | null;
  /** Pool page on the explorer that indexes THIS chain, or null. */
  poolUrl: string | null;
  /** Non-null iff `measured` is false — says WHICH nothing this is. */
  emptyNote: string | null;
}

/**
 * Turn the row's own liquidity fields into what the panel may draw.
 *
 * Takes a CHAIN and three numbers — deliberately no ticker, for the same reason
 * `detailPanelPlan` takes only a chain: the defect this module exists to prevent
 * is resolving a token by its ticker string, and a function that never receives
 * one cannot commit it.
 *
 * THREE NOTHINGS, NOT ONE. The `measured` flag and the wording of `emptyNote`
 * exist because an absent number here has three different causes and they must
 * not be allowed to render as each other:
 *
 *   1. `row === null` — this panel was never handed the figures. A wiring fault
 *      on OUR side; it says nothing at all about the pool.
 *   2. both fields null — the poll ran and the pool read came back empty.
 *      `base-poller.ts` leaves `dex_liquidity_usd` null in exactly this case and
 *      the dust gate then fails closed (`rowTotalTvl → 0 < $5k`). A fact about
 *      the pool, not about us.
 *   3. a reading of `0` — a real measurement that happens to be zero.
 *
 * Collapsing 1 into 2 would blame the pool for our bug; collapsing 2 into 3
 * would report $0 of depth that was never measured. Both are the same species
 * of error as the one this whole module exists to close: a confident number (or
 * a confident em-dash) standing in for an absent one.
 */
export function rowLiquidityView(chain: HoodChain, row: RowLiquidity | null): RowLiquidityView {
  if (row === null) {
    return {
      measured: false,
      tvlUsd: null,
      volume24hUsd: null,
      poolUrl: null,
      emptyNote:
        "This panel was not handed the row's depth figures — a wiring fault here, not a "
        + "statement about the pool. The desk's own poll may well have measured it.",
    };
  }
  const measured = row.totalTvlUsd !== null || row.volume24hUsd !== null;
  return {
    measured,
    tvlUsd: row.totalTvlUsd,
    volume24hUsd: row.volume24hUsd,
    poolUrl: row.poolRef ? explorerAddressUrl(chain, row.poolRef) : null,
    emptyNote: measured
      ? null
      : "No pool reading this cycle — the poll returned no depth for this token, "
        + "which fails the dust gate closed. This is an absent measurement, not $0 of liquidity.",
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
