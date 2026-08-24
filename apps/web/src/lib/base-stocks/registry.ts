/**
 * Base tokenized-stock registry — the Blue Hood "Base desk" address book.
 *
 * Scope is deliberately TINY: four Coinbase B20 tokenized stocks (NVDA, META,
 * GOOGL, AAPL) that we have independently verified end-to-end on Base mainnet
 * (chainId 8453). This is NOT a general B20 catalog — it is the allowlist of
 * tickers whose oracle-vs-DEX drift Blue Hood is authorized to grade. Adding a
 * ticker here is a correctness decision, not a convenience: every address below
 * was read from an AUTHORITATIVE source (Chainlink's Base feed directory for the
 * feeds, the Coinbase B20 factory for the tokens) and re-checksummed, NEVER
 * matched by ticker string. Impostor tokens share the `0xb200…` prefix and the
 * `isB20()` factory answers `true` for empty addresses with that prefix, so a
 * name/prefix match proves nothing (lesson #280). The read path in
 * `b20-quote.ts` re-verifies each token at read time (isB20 ∧ decimals==8 ∧
 * symbol=="<TICKER>c"); this file is the trusted seed those checks pin against.
 *
 * ── The multiplier hazard (why Base ≠ RH) ─────────────────────────────────────
 * A Coinbase B20 stock's Chainlink feed reports the *total-return value*
 * (share price × a WAD-scaled `multiplier()` rebase factor), NOT the raw share
 * price. Robinhood Chain has no such layer, so the RH path reads the feed answer
 * as the price directly. On Base you MUST divide the multiplier back out or the
 * price is silently wrong. That division lives in `b20-quote.ts`; this registry
 * only records addresses + metadata.
 *
 * Verified on-chain 2026-08-23 via `cast` (token isB20/symbol/decimals/name +
 * feed decimals/description/answer + Aerodrome pool spot); AAPL added and
 * verified the same way 2026-08-24. All four tokens currently report
 * `multiplier() == 1e18` (no rebase) and `isPaused(TRANSFER) == false`.
 *
 * ── ADMISSION GATE: the pool decides, NOT the feed ────────────────────────────
 * A readable Chainlink feed is NOT sufficient evidence to add a ticker, and the
 * gap is not hypothetical. Measured 2026-08-24: Chainlink publishes **13**
 * "Coinbase <TICKER>" equity feeds on Base, but only **4** of those tickers have
 * a real market. TSLAc's deepest pool held $1 and AMZNc's held $7 (both $0 24h
 * volume); SNDK · INTC · COIN · CRCL · MSTR · MSFT · SPCX had no pool at all.
 * Admitting on feed-existence would therefore have added 9 tickers whose drift
 * is pure noise — the same disease that forced the RH dead-pool liveness gate
 * (`rule-engine.ts::MIN_DEX_VOL_24H_USD`), where BABA was frozen 100% of hours
 * and SPCX 98%. The public track record is the product; a thin-pool ticker
 * poisons it. So the bar for a new row is:
 *   1. address from the official `base.org/stocks` table — never ticker-matched;
 *   2. on-chain `isB20` ∧ `decimals == 8` ∧ `symbol == "<TICKER>c"`;
 *   3. `multiplier()` and `isPaused(TRANSFER)` readable;
 *   4. a real Aerodrome pool — liquidity AND 24h volume printed, plus a 72h
 *      hourly-candle check for zero-volume / flat-OHLC hours (the BABA test);
 *   5. `readBaseStockQuote()` returns `can_fire: true`.
 *
 * ⚠️ Symbol-matching is actively dangerous here, not merely sloppy. Base carries
 * live counterfeits using the exact `<TICKER>c` symbol: "TSLAc" at
 * `0xb5be29124d8a97eb2df434444dd68c00b6c43fd7` and `0x8b012624874c556dadfa5c2b2de0b4eee4c3c1ef`,
 * "AMZNc" at `0xd6aace315732c354a2c89e222699f2a467b7abf7` — all `isB20() == false`,
 * all `decimals == 18`, with padded names like "Tesla Inc. ". Real B20 stocks
 * carry the `0xb2000000…` vanity prefix AND answer `isB20() == true`.
 */
import type { Address } from "viem";

export interface BaseStock {
  ticker: string;
  /** Issuer's self-reported company name — for display + read-time sanity. */
  name: string;
  /** Coinbase B20 token (chainId 8453). `<TICKER>c` symbol, 8 decimals. */
  token: Address;
  /** On-chain symbol we expect (`NVDAc` etc.) — pinned for the impostor gate. */
  symbol: string;
  /** Chainlink AggregatorV3 feed — reports total-return value, NOT share price
   *  (must be divided by `multiplier()`; see `b20-quote.ts`). 8 decimals. */
  chainlinkFeed: Address;
  /** Feed heartbeat in seconds — used for the staleness flag on the oracle read. */
  chainlinkHeartbeat: number;
}

/**
 * The four verified Base stocks. Do NOT add a ticker here without walking the
 * 5-step admission gate in the file header — an unverified row is a silent
 * wrong-price risk, and a thin-pool row is track-record noise. Both are worse
 * than a shorter list.
 */
export const BASE_STOCKS: readonly BaseStock[] = [
  {
    ticker: "NVDA",
    name: "NVIDIA Corporation",
    token: "0xb20000000000000000000078ee7ce2fE4908108C",
    symbol: "NVDAc",
    chainlinkFeed: "0x04689a41629776563E6822F76f2e57D148d28513",
    chainlinkHeartbeat: 86400,
  },
  {
    ticker: "META",
    name: "Meta Platforms Inc.",
    token: "0xb2000000000000000000008bC8786B856E61707C",
    symbol: "METAc",
    chainlinkFeed: "0x6526aE6797A76123638b863AeE4dD27Ba4E4b27D",
    chainlinkHeartbeat: 86400,
  },
  {
    ticker: "GOOGL",
    name: "Alphabet Inc.",
    token: "0xb2000000000000000000002D0BA3164cc74f58B7",
    symbol: "GOOGLc",
    chainlinkFeed: "0x5bF49E0ffA937CE2FfF033c739aD7C634c4D34F2",
    chainlinkHeartbeat: 86400,
  },
  {
    // Added 2026-08-24. Pool evidence at admission (Aerodrome slipstream
    // AAPL/USDC `0xa3b1e3f9747065e2073722ff4c9027d3ea4994f0`): $671,452
    // liquidity, $1,377,117 24h volume — the DEEPEST of the four, and 72/72
    // hourly candles over 3 days had non-zero volume and a distinct close
    // (no BABA-style freeze). `readBaseStockQuote` returned can_fire:true,
    // drift 0.094%. NOTE: AAPL also exists on RH Chain (`0xaF3D76f1…`,
    // 18 decimals) — a DIFFERENT token. Chain-qualified keys keep the two
    // apart; see `base-poller.ts` header.
    ticker: "AAPL",
    name: "Apple Inc.",
    token: "0xb200000000000000000000C2e324d24d7eEcd1fb",
    symbol: "AAPLc",
    chainlinkFeed: "0x787f13dEa48Db0897CbCDD985de77809D837F988",
    chainlinkHeartbeat: 86400,
  },
] as const;

/** Base mainnet USDC — the quote asset on every B20 stock's Aerodrome pool. */
export const BASE_USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/** Coinbase B20 factory (Base 8453) — `isB20(addr)` read for the impostor gate. */
export const B20_FACTORY: Address = "0xB20f000000000000000000000000000000000000";

/**
 * Chainlink L2 Sequencer Uptime feed on Base (chainId 8453). Base is an OP-stack
 * L2: if its sequencer is down (or was only just restarted), price feeds may be
 * stale/unmovable and MUST NOT be trusted. This feed's `latestRoundData` answer
 * is 0 ⟹ sequencer UP, 1 ⟹ DOWN; `startedAt` is when the current status began.
 * We require the UP status to have held for at least `SEQUENCER_GRACE_SECONDS`
 * before firing any drift, so a just-recovered sequencer can't produce a bad
 * arrow. Verified 2026-08-23: answer 0 (UP), startedAt ~57 days ago.
 */
export const BASE_SEQUENCER_UPTIME_FEED: Address =
  "0xBCF85224fc0756B9Fa45aA7892530B47e10b6433";

/** How long the sequencer must have been UP before L2 prices are trustworthy. */
export const SEQUENCER_GRACE_SECONDS = 3600;

/** Case-insensitive ticker lookup into the verified allowlist. */
export function findBaseStock(ticker: string): BaseStock | undefined {
  const t = ticker.trim().toUpperCase();
  return BASE_STOCKS.find((s) => s.ticker === t);
}
