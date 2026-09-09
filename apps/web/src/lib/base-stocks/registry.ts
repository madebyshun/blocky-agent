/**
 * Base tokenized-stock registry — the Blue Hood "Base desk" address book.
 *
 * Scope is deliberately TINY: eight Coinbase B20 tokenized stocks (NVDA, META,
 * GOOGL, AAPL, AMZN, MSFT, MSTR, TSLA) that we have independently verified
 * end-to-end on Base mainnet (chainId 8453). Count the array, not this sentence
 * — it said "four" for two weeks after the desk reached seven, because a prose
 * count is a second source of truth that nothing checks.
 * This is NOT a general B20 catalog — it is the allowlist of
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
 * verified the same way 2026-08-24; AMZN · MSFT · MSTR 2026-09-08; TSLA the
 * same day. Every token in the array currently reports `multiplier() == 1e18`
 * (no rebase) and `isPaused(TRANSFER) == false` — but do NOT encode that as an
 * assumption anywhere: `multiplier() == 1e18` is today's reading, not a
 * property, and a dividend changes it on a schedule someone else controls
 * (see #434, which had to un-gate the division check for exactly this reason).
 *
 * ── ADMISSION GATE: the pool decides, NOT the feed ────────────────────────────
 * A readable Chainlink feed is NOT sufficient evidence to add a ticker, and the
 * gap is not hypothetical. Measured 2026-08-24: Chainlink publishes **13**
 * "Coinbase <TICKER>" equity feeds on Base, but only **4** of those tickers had
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
 *  4b. that pool must be quoted in a USD-ANCHORED asset (USDC / WETH), and
 *  4c. the DEX price must AGREE with the oracle at admission (±25%);
 *   5. `readBaseStockQuote()` returns `can_fire: true`;
 *   6. a `saneBand` you can DEFEND — see below.
 *
 * ⚠️ That 2026-08-24 snapshot is HISTORY, not current state. Re-measured
 * 2026-09-08: five of the nine rejects had grown real markets ($130k–$280k
 * liquidity, $210k–$660k 24h volume). A ticker refused for thin liquidity is
 * refused *as of a date* — re-run the probe rather than quoting an old table.
 *
 * ── 4b/4c exist because the gate PASSED a price that was 38.9× wrong ─────────
 * Added 2026-09-08. TSLA cleared every floor above — $261,562 liquidity,
 * $214,799 24h volume, 65 live candles — while the price the production path
 * would have published was **$13,789.61** against an oracle share price of
 * **$354.24**. `dexPriceDexScreener` takes the deepest pair whose BASE token is
 * ours, and DexScreener labels the illiquid `TSLAc/STC` V4 pool with TSLAc on
 * the base side, so that sort beat the genuine `TSLAc/USDC` Aerodrome pool
 * ($195,852 liquidity, $354.87, drift ~0.01%). Every gate 1–6 measured how BUSY
 * the pool was; none asked what it was priced AGAINST. A deep pool against a
 * memecoin is still a deep pool, and its "price" is an exchange rate, not a
 * share price.
 *
 * ── Why a ticker can pass every gate and still be refused ─────────────────────
 * `saneBand` is the one field that cannot be derived from chain state, because
 * its job is to disagree with chain state when chain state is broken. Anchoring
 * it on the oracle alone would be circular: the feed would be certifying itself.
 * So the band is only meaningful when a HUMAN can check the anchor against an
 * independent public quote.
 *
 * That is a real bar, and SPCX (SpaceX) fails it: SpaceX is not publicly
 * traded, so no independent reference price exists for anyone — us or a user
 * auditing the track record. Its band would be unfalsifiable by construction.
 * SPCX was therefore DEFERRED on 2026-09-06 despite passing every measurable
 * gate with room to spare ($165,042 liquidity, $1,592,131 24h volume — the
 * second-deepest flow of the six candidates, 71/71 live candles). This is not a
 * quality judgement about the token; it is an admission that we cannot build
 * the safety net that every other row gets. Do not "fix" this by anchoring
 * SPCX's band to its own feed.
 *
 * ── The deferrals, and why they are DIFFERENT things ─────────────────────────
 * Both pass the pool floors. Neither can be admitted, for unrelated reasons —
 * do not collapse them into one "rejected" bucket:
 *
 *   • SPCX — NO INDEPENDENT REFERENCE EXISTS. SpaceX is not publicly traded, so
 *     nobody (us or a user auditing the record) can check the anchor. Permanent
 *     until SpaceX lists.
 *
 *   • SNDK — THE BAND RECIPE DOES NOT FIT. Anchor confirmed ($1,770.23 oracle
 *     vs $1,740.00 public, 1.7%), pool excellent ($225,313 / $659,494, 72/72
 *     live candles). But its 52-week range is **$69.57 → $2,354.39** — a 33.8×
 *     swing, +525% YTD. The `[anchor/4, anchor*4]` band assumes "real equity
 *     movement stays inside it for years"; SNDK falsifies that premise, so
 *     {442, 7081} would suppress a real return to its own 52-week low as
 *     `price_out_of_band` — the silent-suppression failure this file calls
 *     "strictly worse than missing an exotic break". Widening far enough to
 *     hold the observed range (~{35, 4700}, 134×) leaves only ~2× margin to a
 *     10² decimals error, versus 25× for a mega-cap. The gap between "real
 *     volatility" and "smallest realistic break" has closed for this ticker,
 *     and a band that can do neither job is worse than no row. Revisit if SNDK
 *     settles — this is a judgement about TODAY's volatility, not the token.
 *
 * A third deferral, TSLA, was RESOLVED 2026-09-08 and is now a row below. It is
 * recorded here because it is the one deferral that was never about the ticker:
 * the market was always fine, OUR READ was broken. `dexPriceDexScreener` priced
 * it on the `TSLAc/STC` pool at $13,789.61 against a $354.24 oracle (38.9×),
 * because that pool out-ranked the real `TSLAc/USDC` Aerodrome pool on a sort
 * that asked only how DEEP a pool was and never what it was priced AGAINST.
 * Fixed by the anchored-quote rule (#435); TSLA needed no change of its own.
 * Keep this paragraph: "deferred" covered three unrelated diagnoses, and the
 * only one that a code fix could clear is exactly the one a future reader would
 * otherwise mistake for a verdict on the asset.
 *
 * ⚠️ Symbol-matching is actively dangerous here, not merely sloppy. Base carries
 * live counterfeits using the exact `<TICKER>c` symbol: "TSLAc" at
 * `0xb5be29124d8a97eb2df434444dd68c00b6c43fd7` and `0x8b012624874c556dadfa5c2b2de0b4eee4c3c1ef`,
 * "AMZNc" at `0xd6aace315732c354a2c89e222699f2a467b7abf7` — all `isB20() == false`,
 * all `decimals == 18`, with padded names like "Tesla Inc. ". Real B20 stocks
 * carry the `0xb2000000…` vanity prefix AND answer `isB20() == true`.
 *
 * ⚠️ …but `isB20() == true` is NOT the same claim as "this is a tokenized
 * stock", and the difference is measurable. `0xB200000000000000000000CfCD1d711EEf213b01`
 * is **"StudentCoin" (STC), 18 decimals, a memecoin** — and the factory answers
 * `isB20(STC) == true`. It is the counter-token of the pool that priced TSLAc
 * at $15,424 (see the TSLA note above). So a hypothetical "only quote against
 * B20 assets" rule would have admitted that pool. `isB20` is one conjunct of
 * three (∧ `decimals == 8` ∧ `symbol == "<TICKER>c"`), never a sufficient test.
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
  /**
   * Plausible USD share-price range. A quote outside it is treated as BROKEN,
   * not as news: `readBaseStockQuote` returns `can_fire:false` with
   * `suppressed_reason:"price_out_of_band"` rather than grading drift off it.
   *
   * ⚠️ This is a MAGNITUDE-BREAK detector, not a volatility detector. It exists
   * to catch a decimals misread, a multiplier misapplication, or a drained /
   * manipulated pool — failures that land 10²–10⁸ away from the truth. It is
   * deliberately NOT tuned to catch a subtle mispricing; that is what the
   * impostor, multiplier and drift gates are for. Set the band too tight and it
   * silently suppresses real arrows, which looks like "no signal" instead of
   * like a bug — strictly worse than missing an exotic break.
   *
   * Construction (see `admittedAt` for the anchor date): `[anchor/4, anchor*4]`
   * around the oracle share price measured at admission, rounded outward. The
   * 4× envelope sits in the empty gap between the two populations — real equity
   * movement stays inside it for years, while the SMALLEST realistic break (a
   * 10² decimals error) is 25× outside it. Widen a band when a real move
   * approaches an edge; never widen one to make a failing read pass.
   */
  saneBand: { lo: number; hi: number };
  /**
   * ISO date this ticker entered the allowlist. Written so #152 can cut the
   * drift sample by cohort — a row admitted mid-window has fewer observation
   * hours than one present since the desk opened, and averaging the two without
   * saying so understates the newer ticker. This is a provenance field: it
   * records when WE started grading the ticker, not when the token deployed.
   */
  admittedAt: string;
}

/**
 * The verified Base stocks. Do NOT add a ticker here without walking the
 * admission gate in the file header — an unverified row is a silent wrong-price
 * risk, and a thin-pool row is track-record noise. Both are worse than a
 * shorter list.
 */
export const BASE_STOCKS: readonly BaseStock[] = [
  {
    ticker: "NVDA",
    name: "NVIDIA Corporation",
    token: "0xb20000000000000000000078ee7ce2fE4908108C",
    symbol: "NVDAc",
    chainlinkFeed: "0x04689a41629776563E6822F76f2e57D148d28513",
    chainlinkHeartbeat: 86400,
    // Band anchor: oracle share price $229.96, read 2026-09-06.
    saneBand: { lo: 55, hi: 950 },
    admittedAt: "2026-08-23",
  },
  {
    ticker: "META",
    name: "Meta Platforms Inc.",
    token: "0xb2000000000000000000008bC8786B856E61707C",
    symbol: "METAc",
    chainlinkFeed: "0x6526aE6797A76123638b863AeE4dD27Ba4E4b27D",
    chainlinkHeartbeat: 86400,
    // Band anchor: oracle share price $615.23, read 2026-09-06.
    saneBand: { lo: 150, hi: 2500 },
    admittedAt: "2026-08-23",
  },
  {
    ticker: "GOOGL",
    name: "Alphabet Inc.",
    token: "0xb2000000000000000000002D0BA3164cc74f58B7",
    symbol: "GOOGLc",
    chainlinkFeed: "0x5bF49E0ffA937CE2FfF033c739aD7C634c4D34F2",
    chainlinkHeartbeat: 86400,
    // Band anchor: oracle share price $338.71, read 2026-09-06.
    saneBand: { lo: 80, hi: 1400 },
    admittedAt: "2026-08-23",
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
    // Band anchor: oracle share price $320.08, read 2026-09-06.
    saneBand: { lo: 80, hi: 1300 },
    admittedAt: "2026-08-24",
  },
  // ── Admitted 2026-09-08 ────────────────────────────────────────────────────
  // Three of six candidates. All addresses read from the official
  // `base.org/stocks` table and re-asserted on-chain against the B20 factory
  // (`isB20 == true`, `decimals == 8`, `symbol == "<TICKER>c"`, name matches) —
  // never derived from the Robinhood registry, which holds DIFFERENT contracts
  // for these same tickers on a chain that shares no state with Base.
  // TSLA · SNDK · SPCX deferred; see the three-deferrals note in the header.
  {
    // Pool evidence (Aerodrome AMZNc/USDC `0xd03bc8c7…`): $278,082 liquidity,
    // $482,906 24h volume, 72/72 hourly candles live (0 zero-volume, 0 flat).
    // DEX $257.02 vs oracle $256.23 — drift 0.308%.
    ticker: "AMZN",
    name: "Amazon.com, Inc.",
    token: "0xb200000000000000000000d9192b6B456483C2E8",
    symbol: "AMZNc",
    chainlinkFeed: "0x06A8E4b3aBB3B7543d8396FB2B763d22820cB295",
    chainlinkHeartbeat: 86400,
    // Band anchor: oracle share price $256.23, read 2026-09-08, checked against
    // a public quote of $258.51 (0.9%). 52-week range $196.00–$287.20 sits well
    // inside the envelope — 3.1× clear of the floor, 3.6× clear of the ceiling.
    saneBand: { lo: 64, hi: 1025 },
    admittedAt: "2026-09-08",
  },
  {
    // Pool evidence (Aerodrome MSFTc/USDC `0x7103eb3c…`): $222,751 liquidity,
    // $320,348 24h volume, 72/72 hourly candles live.
    // DEX $496.84 vs oracle $496.57 — drift 0.053%.
    ticker: "MSFT",
    name: "Microsoft Corporation",
    token: "0xB200000000000000000000Ab99cFa739E253872B",
    symbol: "MSFTc",
    chainlinkFeed: "0xeB10A6c9aa7E537aEd766C08c35Dae35B321b18c",
    chainlinkHeartbeat: 86400,
    // Band anchor: oracle share price $496.57, read 2026-09-08, checked against
    // a public session range of $499.36–$511.00 (~2%). 52-week range
    // $349.20–$553.72 — 2.8× clear of the floor, 3.6× clear of the ceiling.
    saneBand: { lo: 124, hi: 1987 },
    admittedAt: "2026-09-08",
  },
  {
    // Pool evidence (Aerodrome MSTRc/USDC `0x8b27f626…`): $136,918 liquidity,
    // $333,872 24h volume, 72/72 hourly candles live.
    // DEX $139.68 vs oracle $139.83 — drift -0.106%.
    ticker: "MSTR",
    name: "Strategy Inc.",
    token: "0xb2000000000000000000004884b426556b92883d",
    symbol: "MSTRc",
    chainlinkFeed: "0xB3cE282CD188b35DA0E38D8Bc7d58e33173D202a",
    chainlinkHeartbeat: 86400,
    // Band anchor: oracle share price $139.83, read 2026-09-08, checked against
    // a public quote of $142.80 (2.1%).
    //
    // ⚠️ DELIBERATELY WIDER THAN [anchor/4, anchor*4] = {34, 560}. MSTR is a
    // bitcoin proxy and its measured 52-week range is $81.81–$365.21 (4.5×) —
    // the naive ceiling sits only 1.53× above a level this stock traded at
    // THIS YEAR, so a rally back through it would suppress real arrows as
    // `price_out_of_band`. Widened to hold the observed range with ~2× margin
    // on both sides, which is the header's sanctioned reason to widen ("when a
    // real move approaches an edge"), never to make a failing read pass. Still
    // catches the smallest realistic break comfortably: a 10² decimals error
    // lands at $1.40 (25× below the floor) or $13,983 (18.6× above the ceiling).
    saneBand: { lo: 35, hi: 750 },
    admittedAt: "2026-09-08",
  },
  {
    // The fourth of six candidates, admitted the same day the anchored-quote
    // rule (#435) shipped — it was deferred hours earlier for a bug in OUR read,
    // never for anything about the ticker. Re-measured after the fix, during US
    // market hours:
    //
    // Pool evidence (Aerodrome TSLAc/USDC `0x469337fd…a7bb`): $611,434
    // liquidity, $677,725 24h volume, 72h scanned with 0 zero-volume and 0
    // flat-close hours. DEX $367.61 vs oracle $368.96 — drift -0.367%.
    //
    // ⚠️ TSLAc is the ticker that proves depth is not a safety property, so do
    // not "simplify" the pool sort back to deepest-wins. Ranked by liquidity on
    // admission day, the runners-up behind the real USDC pool were LiTesla/TSLAc
    // ($407,864), STONKER/TSLAc ($281,656) and **TSLAc/STC ($267,810, which
    // prices TSLAc at $15,424)**. The day before, that STC pool was the DEEPER
    // of the two base-side pairs and won — same code, same ticker, opposite
    // answer, 24h apart. The anchor rule is what makes today's correct answer a
    // guarantee instead of a coin-flip.
    ticker: "TSLA",
    name: "Tesla Inc.",
    token: "0xb2000000000000000000001e800a7f5189430cD0",
    symbol: "TSLAc",
    chainlinkFeed: "0xFaf869185383a24F8cb00e27BdA6b63B9905DCb4",
    chainlinkHeartbeat: 86400,
    // Band anchor: oracle share price $368.96, read 2026-09-08, checked against
    // an independent public quote of $367.79 (0.32%). Standard [anchor/4,
    // anchor*4] — no widening needed: the 52-week range $297.38–$498.83 sits
    // 3.2× above the floor and 3.0× below the ceiling, and a 10² decimals error
    // lands ~25× outside either edge.
    saneBand: { lo: 92, hi: 1476 },
    admittedAt: "2026-09-08",
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
