/**
 * Base B20 stock quote — the "Base desk" price source for Blue Hood.
 *
 * This is the Base analogue of Robinhood Chain's oracle read, with ONE critical
 * extra layer that RH doesn't have: the **multiplier**. A Coinbase B20 tokenized
 * stock's Chainlink feed reports the *total-return value* — the share price
 * multiplied by a WAD-scaled `multiplier()` rebase factor — not the raw share
 * price. Read the feed answer naively and you get a price that is silently wrong
 * whenever the multiplier ≠ 1e18. So every share price here goes through
 * `sharePriceFromFeed`, which divides the multiplier back out in WAD math.
 *
 * ── Fail-loud, never fail-silent (hazard #1) ──────────────────────────────────
 * `sharePriceFromFeed` THROWS if the multiplier is ≤ 0. `readBaseStockQuote`
 * treats an unreadable/zero multiplier as a hard block: it logs (console.error)
 * and returns a quote with `share_price_usd: null` and `can_fire: false` — it
 * NEVER falls back to the raw feed answer, because a silent wrong price is the
 * most dangerous bug this module can have (lesson: kv.ts "fail silently" cost us
 * twice). "Cannot assess" is the correct output when the multiplier is in doubt.
 *
 * ── Defense-in-depth gates (each can suppress an arrow) ───────────────────────
 *   • impostor  — token must pass isB20() ∧ decimals==8 ∧ symbol=="<TICKER>c".
 *                 The `0xb200…` prefix is trivially forgeable and isB20() alone
 *                 is not proof (it answers true for empty prefixed addresses),
 *                 so we pin against the authoritative registry symbol (#280).
 *   • sequencer — Base is an OP-stack L2; if its sequencer is down or only just
 *                 recovered (< grace), feeds may be stale/frozen → don't fire.
 *   • multiplier— unreadable or ≤ 0 → hazard block (see above).
 *   • pause     — isPaused(TRANSFER) true (or unreadable) → suppress.
 *   • staleness — Chainlink `is_stale` (older than 2× heartbeat) → suppress.
 *                 ⚠️ Coinbase equity feeds DO NOT tick while US markets are
 *                 closed, so every Base ticker goes stale ~48h after Friday's
 *                 last print and stays stale until Monday's open. Suppressing
 *                 there is CORRECT — you cannot grade drift against a frozen
 *                 oracle — but it means a weekend read says nothing about a
 *                 ticker's quality. Measured 2026-09-06 (Sun): all 10 admitted
 *                 + candidate feeds last ticked Fri 2026-09-04, spread only by
 *                 what time that day they stopped. Do not read a weekend
 *                 `feed_stale` as evidence against a ticker (see the admission
 *                 probe, which classifies it INCONCLUSIVE rather than FAIL).
 *   • sane band — oracle or DEX price outside the registry's per-ticker
 *                 `saneBand` → the read is broken, not newsworthy → suppress.
 *   • dex       — no DEX spot → drift is undefined → can't fire (but oracle
 *                 share price is still returned for display).
 *
 * `drift_pct` is populated whenever BOTH prices exist (for honest display), but
 * `can_fire` — the "an arrow may be graded from this" flag — requires every gate
 * green. Phase 3 (poller/grader wiring) keys off `can_fire`, not on the presence
 * of a number.
 *
 * ── ⚠️ TRAP FOR A FUTURE BASE TRADE PATH: approve() IS NOT POLICY GATED ───────
 * READ THIS BEFORE WRITING ANY BUY/SELL FLOW FOR A B20 TOKEN.
 *
 * This module is READ-ONLY today — it quotes, it never trades — so the trap
 * below is not live. It is written here because this is the file someone will
 * open first when they add one, and because the failure it causes looks like a
 * success.
 *
 * B20 transfers are gated by the issuer's policy layer: an account must pass
 * `isAuthorized(policyID, account)` (KYC / whitelist / jurisdiction — the
 * tokenized stocks are non-US-eligible only) or the transfer reverts.
 * **`approve()` is NOT policy gated.** An unauthorized wallet can set an
 * allowance successfully and only discover the block when the swap reverts.
 *
 * That breaks the shape of our RH allowance pre-check (#122), which infers
 * "this wallet can trade" from "approve succeeded". On Base that inference is
 * INVALID and would show a FALSE GREEN: the UI says ready, the user signs, the
 * transaction reverts, and they pay gas to learn they were never eligible.
 *
 * So a Base trade path must call `isAuthorized(policyID, account)` explicitly
 * as its own gate — a successful `approve()` proves nothing about eligibility.
 * Ref: docs.base.org/base-chain/asset-issuance/tokenized-stocks-on-base.
 */
import { type Address } from "viem";
import {
  chainlinkLatest,
  dexPrice,
  clientForSource,
  BASE_PRICE_SOURCE,
  type PriceSource,
  type OnchainQuote,
  type DexQuote,
} from "@/lib/robinhood/rwa-price";
import {
  FACTORY_ABI,
  TOKEN_READ_ABI,
  ASSET_ABI,
  PAUSABLE_FEATURE,
} from "@/lib/b20/inspect-abi";
import {
  B20_FACTORY,
  BASE_SEQUENCER_UPTIME_FEED,
  SEQUENCER_GRACE_SECONDS,
  type BaseStock,
} from "./registry";

/** WAD = 1e18, the fixed-point scale B20's `multiplier()` uses (1e18 = no rebase). */
export const WAD = 10n ** 18n;

/**
 * Divide the B20 total-return value back down to a plain USD share price.
 *
 * The Chainlink feed answer is `sharePrice × multiplier / WAD` (all integers,
 * feed-decimal scaled). To invert: `sharePrice = answer × WAD / multiplier`,
 * still feed-decimal scaled, then divide by 10^feedDecimals for USD.
 *
 * THROWS on a non-positive multiplier — that is the fail-loud contract. A caller
 * must catch and refuse to fire, never substitute the raw answer.
 *
 * @param feedAnswer   raw `int256` answer from latestRoundData (as bigint)
 * @param feedDecimals the feed's `decimals()` (8 for Coinbase B20 stock feeds)
 * @param multiplier   the token's `multiplier()` uint256 (1e18 == no rebase)
 */
export function sharePriceFromFeed(
  feedAnswer: bigint,
  feedDecimals: number,
  multiplier: bigint,
): number {
  if (multiplier <= 0n) {
    throw new Error(`B20 multiplier must be > 0 (got ${multiplier}) — refusing to price`);
  }
  if (feedAnswer < 0n) {
    throw new Error(`B20 feed answer must be >= 0 (got ${feedAnswer}) — refusing to price`);
  }
  const sharePriceRaw = (feedAnswer * WAD) / multiplier; // feed-decimal scaled
  return Number(sharePriceRaw) / 10 ** feedDecimals;
}

// The B20-specific reads (isB20 / multiplier / isPaused) use ABIs rwa-price
// doesn't expose, but we deliberately run them on rwa-price's SHARED client
// (`clientForSource`) rather than a private one: same cache key ⇒ viem batches
// these eth_calls together with the Chainlink feed read into one Multicall3 call
// per cycle, and the Base fallback/rpc config lives in exactly one place.

const AGGREGATOR_MINI_ABI = [
  {
    name: "latestRoundData", type: "function", stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
] as const;

export type SequencerStatus = {
  /** answer == 0 ⟹ the sequencer reports itself UP. */
  up: boolean;
  /** unix seconds the current up/down status began. */
  started_at: number;
  /** how long the current status has held. */
  seconds_since_change: number;
  /** true if the status changed more recently than the grace window. */
  within_grace: boolean;
  /** UP, a valid startedAt, and past the grace window — safe to trust L2 prices. */
  ok: boolean;
};

/** Read the Base L2 sequencer uptime feed. Returns null only on RPC failure. */
export async function readSequencerStatus(
  source: PriceSource = BASE_PRICE_SOURCE,
): Promise<SequencerStatus | null> {
  try {
    const d = await clientForSource(source).readContract({
      address: BASE_SEQUENCER_UPTIME_FEED,
      abi: AGGREGATOR_MINI_ABI,
      functionName: "latestRoundData",
    });
    const answer = d[1] as bigint;
    const startedAt = Number(d[2] as bigint);
    const up = answer === 0n;
    const now = Math.floor(Date.now() / 1000);
    const since = startedAt > 0 ? Math.max(0, now - startedAt) : 0;
    // Unknown start (startedAt == 0) is treated as "within grace" → not ok.
    const within_grace = startedAt > 0 ? since < SEQUENCER_GRACE_SECONDS : true;
    return { up, started_at: startedAt, seconds_since_change: since, within_grace, ok: up && startedAt > 0 && !within_grace };
  } catch {
    return null;
  }
}

/** Per-token on-chain state needed for the impostor + multiplier + pause gates. */
type TokenState = {
  is_b20: boolean;
  symbol: string | null;
  decimals: number | null;
  /** null ⟹ multiplier() was unreadable → hazard block. */
  multiplier: bigint | null;
  /** null ⟹ isPaused() was unreadable → treat as blocked. */
  paused: boolean | null;
};

async function readTokenState(stock: BaseStock, source: PriceSource): Promise<TokenState> {
  const client = clientForSource(source);
  const [isB20, symbol, decimals, multiplier, paused] = await Promise.allSettled([
    client.readContract({ address: B20_FACTORY, abi: FACTORY_ABI, functionName: "isB20", args: [stock.token] }),
    client.readContract({ address: stock.token, abi: TOKEN_READ_ABI, functionName: "symbol" }),
    client.readContract({ address: stock.token, abi: TOKEN_READ_ABI, functionName: "decimals" }),
    client.readContract({ address: stock.token, abi: ASSET_ABI, functionName: "multiplier" }),
    client.readContract({ address: stock.token, abi: TOKEN_READ_ABI, functionName: "isPaused", args: [PAUSABLE_FEATURE.TRANSFER] }),
  ]);
  return {
    is_b20: isB20.status === "fulfilled" ? Boolean(isB20.value) : false,
    symbol: symbol.status === "fulfilled" ? String(symbol.value) : null,
    decimals: decimals.status === "fulfilled" ? Number(decimals.value as number) : null,
    multiplier: multiplier.status === "fulfilled" ? (multiplier.value as bigint) : null,
    paused: paused.status === "fulfilled" ? Boolean(paused.value) : null,
  };
}

export type BaseStockQuote = {
  ticker: string;
  token: Address;

  // ── Oracle side (multiplier-adjusted) ──
  /** The real USD share price (feed ÷ multiplier). null ⟹ cannot assess. */
  share_price_usd: number | null;
  /** Raw feed price BEFORE dividing the multiplier — total-return value. */
  total_return_value_usd: number | null;
  /** multiplier() as a decimal string; "1000000000000000000" == no rebase. */
  multiplier: string | null;
  /** true when multiplier == 1e18 (the division is a no-op). */
  multiplier_is_unit: boolean;
  feed_answer_raw: string | null;
  feed_decimals: number | null;
  feed_updated_at: number | null;
  feed_age_seconds: number | null;
  feed_is_stale: boolean;
  /** false ⟹ oracle and/or DEX price fell outside the registry `saneBand`, i.e.
   *  the read is BROKEN rather than newsworthy. Suppresses the arrow. */
  price_in_band: boolean;

  // ── DEX side ──
  dex_price_usd: number | null;
  dex_pool_address: string | null;
  dex_liquidity_usd: number | null;
  dex_volume_24h_usd: number | null;
  dex_pool_url: string | null;

  // ── Drift (present iff both prices present) ──
  /** (dex − share) / share × 100. Positive ⟹ DEX richer than oracle. */
  drift_pct: number | null;

  // ── Gates ──
  impostor_ok: boolean;
  sequencer: SequencerStatus | null;
  sequencer_ok: boolean;
  paused: boolean;
  multiplier_ok: boolean;
  /** All gates green AND both prices present — an arrow may be graded. */
  can_fire: boolean;
  /** The primary reason can_fire is false (most fundamental first), else null. */
  suppressed_reason: string | null;
};

/**
 * Full Base B20 stock quote: oracle share price (multiplier-adjusted), DEX spot,
 * drift, and every suppression gate. Never throws — a hazard becomes
 * `can_fire: false` + a `suppressed_reason` + a logged error, not an exception.
 */
export async function readBaseStockQuote(
  stock: BaseStock,
  source: PriceSource = BASE_PRICE_SOURCE,
): Promise<BaseStockQuote> {
  const [seq, feed, dex, tok] = await Promise.all([
    readSequencerStatus(source),
    chainlinkLatest(stock.chainlinkFeed, stock.chainlinkHeartbeat, source),
    dexPrice(stock.token, source),
    readTokenState(stock, source),
  ]);

  const impostor_ok =
    tok.is_b20 && tok.decimals === 8 && tok.symbol === stock.symbol;
  if (!impostor_ok) {
    console.error(
      `[base-stocks] IMPOSTOR GATE failed for ${stock.ticker} @ ${stock.token}: ` +
        `isB20=${tok.is_b20} decimals=${tok.decimals} symbol=${tok.symbol} (expected ${stock.symbol}) — not firing`,
    );
  }

  const multiplier_ok = tok.multiplier !== null && tok.multiplier > 0n;
  if (!multiplier_ok) {
    // Hazard #1: never price off a bad multiplier. Fail loud, do not fire.
    console.error(
      `[base-stocks] MULTIPLIER hazard for ${stock.ticker} @ ${stock.token}: ` +
        `multiplier=${tok.multiplier} — refusing to compute share price, not firing`,
    );
  }

  // Oracle share price — only if BOTH the feed read and the multiplier are good.
  let share_price_usd: number | null = null;
  let total_return_value_usd: number | null = null;
  if (feed) total_return_value_usd = feed.price_usd;
  if (feed && multiplier_ok && tok.multiplier) {
    try {
      share_price_usd = sharePriceFromFeed(
        BigInt(feed.raw_answer),
        feed.feed_decimals,
        tok.multiplier,
      );
    } catch (e) {
      // sharePriceFromFeed only throws on a bad multiplier/answer — belt & braces
      // with the multiplier_ok guard above, but never let it become a wrong price.
      console.error(`[base-stocks] sharePriceFromFeed threw for ${stock.ticker}:`, e);
      share_price_usd = null;
    }
  }

  const dex_price_usd = dex?.price_usd ?? null;
  const drift_pct =
    share_price_usd !== null && share_price_usd > 0 && dex_price_usd !== null
      ? ((dex_price_usd - share_price_usd) / share_price_usd) * 100
      : null;

  const sequencer_ok = seq?.ok ?? false;
  const paused = tok.paused !== false; // true OR unreadable(null) ⟹ blocked
  const feed_is_stale = feed?.is_stale ?? true;

  // Sanity band — a magnitude break, not a market move. Deliberately checked on
  // BOTH legs: a decimals/multiplier fault corrupts the oracle, while a drained
  // or manipulated pool corrupts the DEX, and either one alone is enough to
  // poison an arrow. A null price is NOT out of band — that is "cannot assess",
  // already handled by its own reason below.
  const band = stock.saneBand;
  const outOfBand = (p: number | null) => p !== null && (p < band.lo || p > band.hi);
  const share_out_of_band = outOfBand(share_price_usd);
  const dex_out_of_band = outOfBand(dex_price_usd);
  const price_in_band = !share_out_of_band && !dex_out_of_band;
  if (!price_in_band) {
    console.error(
      `[base-stocks] ${stock.ticker} price outside sane band ` +
        `[${band.lo}, ${band.hi}]: oracle=${share_price_usd} dex=${dex_price_usd} — refusing to fire`,
    );
  }

  // Primary suppression reason — ordered most-fundamental first.
  let suppressed_reason: string | null = null;
  if (!impostor_ok) suppressed_reason = "impostor_gate";
  else if (!multiplier_ok) suppressed_reason = "multiplier_invalid";
  else if (!feed) suppressed_reason = "feed_unavailable";
  else if (feed_is_stale) suppressed_reason = "feed_stale";
  else if (!sequencer_ok) suppressed_reason = seq === null ? "sequencer_unreadable" : seq.up ? "sequencer_warming" : "sequencer_down";
  else if (paused) suppressed_reason = tok.paused === null ? "pause_unreadable" : "paused";
  else if (dex_price_usd === null) suppressed_reason = "dex_unavailable";
  else if (share_price_usd === null) suppressed_reason = "share_price_unavailable";
  else if (!price_in_band) suppressed_reason = "price_out_of_band";

  const can_fire = suppressed_reason === null && drift_pct !== null;

  return {
    ticker: stock.ticker,
    token: stock.token,

    share_price_usd,
    total_return_value_usd,
    multiplier: tok.multiplier !== null ? tok.multiplier.toString() : null,
    multiplier_is_unit: tok.multiplier === WAD,
    feed_answer_raw: feed?.raw_answer ?? null,
    feed_decimals: feed?.feed_decimals ?? null,
    feed_updated_at: feed?.updated_at ?? null,
    feed_age_seconds: feed?.age_seconds ?? null,
    feed_is_stale,
    price_in_band,

    dex_price_usd,
    dex_pool_address: dex?.pool_address ?? null,
    dex_liquidity_usd: dex?.liquidity_usd ?? null,
    dex_volume_24h_usd: dex?.volume_24h_usd ?? null,
    dex_pool_url: dex?.pool_url ?? null,

    drift_pct,

    impostor_ok,
    sequencer: seq,
    sequencer_ok,
    paused,
    multiplier_ok,
    can_fire,
    suppressed_reason,
  };
}

export type { OnchainQuote, DexQuote };
