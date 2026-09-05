/**
 * Tokenized-stock holdings — the wallet's equity leg, across BOTH venues.
 *
 * The crypto table (`TokenTable` → /api/wallet/holdings → Moralis) is Base-only
 * and knows nothing about equities. This module answers the other half: which
 * tokenized shares does this address actually hold, on Base 8453 (Coinbase B20)
 * and on Robinhood Chain 4663 (RHJ RWA tokens).
 *
 * ── A ticker is not an identity ───────────────────────────────────────────────
 * NVDA, META, GOOGL and AAPL currently exist on BOTH chains as DIFFERENT tokens
 * with different addresses and different decimals (8 on Base, 18 on RH). So
 * nothing here is ever resolved by ticker string. Every row starts from a pinned
 * registry ADDRESS — `BASE_STOCKS` for Base, `RWA_TOKENS` for RH — and each
 * holding is stamped with the chain it was read on. That is also why the two
 * legs are returned separately rather than merged into one list keyed by ticker:
 * merging them would require deciding that two different assets are the same
 * asset, which they are not.
 *
 * ── What this deliberately does NOT do ────────────────────────────────────────
 * It does not discover stock tokens. It only checks balances at addresses that
 * were verified into a registry ahead of time. A counterfeit "NVDAc" at some
 * other address therefore cannot appear here at all — it surfaces in the crypto
 * table, where `token-trust.ts` flags it. Discovery-by-symbol is exactly how the
 * #280 impostor got in, and this module is the wrong place to reopen that door.
 *
 * ── Three answers, not two ────────────────────────────────────────────────────
 * "You hold none", "we could not look", and "we looked and the price is unknown"
 * are three different facts and each is rendered differently. A failed balance
 * read is counted in `unread`, never folded in as a zero; a dead explorer makes
 * the whole leg `unavailable`; a missing price leaves `valueUsd: null` with a
 * reason instead of a fabricated number.
 */
import { getAddress, isAddress, type Address } from "viem";
import { BASE_STOCKS, type BaseStock } from "@/lib/base-stocks/registry";
import { readBaseStockQuote } from "@/lib/base-stocks/b20-quote";
import { clientForSource, BASE_PRICE_SOURCE } from "@/lib/robinhood/rwa-price";
import { RH_CHAIN, RWA_TOKENS, type RwaToken } from "@/lib/robinhood/rwa-registry";
import { priceHoldings } from "@/lib/robinhood/rwa-portfolio";
import { getRobinhoodTokenBalances } from "@/lib/robinhood/blockscout";

const ERC20_BALANCE_ABI = [
  {
    type: "function", name: "balanceOf", stateMutability: "view",
    inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }],
  },
] as const;

const BASE_EXPLORER = "https://basescan.org";

export type StockVenue = "base" | "robinhood";

export interface StockHolding {
  venue:    StockVenue;
  chainId:  number;
  ticker:   string;          // the underlying equity, e.g. "NVDA"
  name:     string;
  /** On-chain symbol — "NVDAc" on Base, "NVDA" on RH. Shown so the two venues'
   *  tokens are visibly different things and not two rows of one asset. */
  symbol:   string;
  contract: string;
  decimals: number;
  amount:   string;          // human-readable, trailing zeros trimmed
  raw:      string;          // exact integer balance
  kind:     "stock" | "etf";
  priceUsd:     number | null;
  priceSource:  "chainlink" | "dex-spot" | null;
  valueUsd:     number | null;
  /** Present iff `valueUsd` is null — says WHY, so the UI never has to guess
   *  whether a blank cell means zero or unknown. */
  unpricedReason?: string;
  explorerUrl: string;
}

export interface StockLeg {
  venue:    StockVenue;
  chainId:  number;
  label:    string;
  explorer: string;
  /** "ok" — we read the chain. "unavailable" — we could NOT, and the empty
   *  `holdings` below is an absence of knowledge, not an absence of shares. */
  status:   "ok" | "unavailable";
  /** Registry rows checked. Being absent from the registry is not the same as
   *  not existing, so the count is surfaced rather than implied. */
  scanned:  number;
  /** Rows whose balance read failed. The leg is incomplete by exactly this
   *  many tokens — never treat as zero. */
  unread:   number;
  holdings: StockHolding[];
  note?:    string;
}

export interface StockPortfolio {
  address: string;
  legs:    StockLeg[];
  ts:      number;
  error?:  string;
}

/** "1.2300" → "1.23", "5.0" → "5". */
function trimAmount(s: string): string {
  if (!s.includes(".")) return s;
  return s.replace(/\.?0+$/, "") || "0";
}

function formatUnits(raw: bigint, decimals: number): string {
  const neg = raw < 0n;
  const v = neg ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

// ── Base 8453 — Coinbase B20 ──────────────────────────────────────────────────

async function readBaseLeg(wallet: Address): Promise<StockLeg> {
  const leg: StockLeg = {
    venue: "base", chainId: 8453, label: "Base",
    explorer: BASE_EXPLORER, status: "ok",
    scanned: BASE_STOCKS.length, unread: 0, holdings: [],
  };

  const client = clientForSource(BASE_PRICE_SOURCE);

  // One multicall for the whole (tiny) registry. `allowFailure` so a single
  // reverting token cannot take the other three down with it.
  type MC = { status: "success"; result: bigint } | { status: "failure"; error: unknown };
  let results: MC[];
  try {
    results = (await client.multicall({
      allowFailure: true,
      contracts: BASE_STOCKS.map(s => ({
        address: s.token, abi: ERC20_BALANCE_ABI, functionName: "balanceOf", args: [wallet],
      })) as never,
    })) as unknown as MC[];
  } catch {
    // The RPC itself is down — the whole leg is unknown, not empty.
    return { ...leg, status: "unavailable", note: "Base RPC did not answer — stock balances unknown." };
  }

  const held: Array<{ stock: BaseStock; raw: bigint }> = [];
  BASE_STOCKS.forEach((stock, i) => {
    const r = results[i];
    if (!r || r.status !== "success") { leg.unread++; return; }
    if (r.result > 0n) held.push({ stock, raw: r.result });
  });

  // Quote ONLY what is held. `readBaseStockQuote` costs a Chainlink read, a DEX
  // HTTP call and four token reads per ticker; running it for a wallet holding
  // nothing would be four round-trips to render an empty table.
  const quotes = await Promise.all(
    held.map(h => readBaseStockQuote(h.stock).catch(() => null)),
  );

  held.forEach(({ stock, raw }, i) => {
    const q = quotes[i];
    // B20 stock tokens are 8-decimal by definition, and the impostor gate below
    // re-asserts it on-chain; using the registry value keeps the amount readable
    // even when the quote failed entirely.
    const decimals = 8;
    const amountNum = Number(raw) / 10 ** decimals;

    let priceUsd: number | null = null;
    let priceSource: StockHolding["priceSource"] = null;
    let unpricedReason: string | undefined;

    if (!q) {
      unpricedReason = "price read failed";
    } else if (!q.impostor_ok) {
      // The address came from the pinned registry, so a genuine counterfeit is
      // not reachable here — in practice this means the verification READ did
      // not come back clean. Either way the honest move is the same: show the
      // balance, withhold the valuation, and say the check did not pass.
      unpricedReason = "on-chain verification did not pass — value withheld";
    } else if (!q.multiplier_is_unit) {
      // A rebased B20 splits "price per share" from "value per token", and we
      // have never observed one live (all four have read 1e18 since the desk
      // went up). Rather than pick an interpretation and be silently wrong for
      // whoever is holding it, say so. See b20-quote.ts on the multiplier.
      unpricedReason = "token has rebased — value per token unverified";
    } else if (q.total_return_value_usd != null && !q.feed_is_stale) {
      // multiplier == 1e18, so the feed's total-return value IS the per-token
      // value and the share price; the two only diverge under a rebase, which
      // the branch above has already excluded.
      priceUsd = q.total_return_value_usd;
      priceSource = "chainlink";
    } else if (q.dex_price_usd != null) {
      // Oracle stale or unreadable → live pool spot, labelled as such. Same
      // order of preference the RH leg uses (Chainlink first, DEX fallback).
      priceUsd = q.dex_price_usd;
      priceSource = "dex-spot";
    } else {
      unpricedReason = q.feed_is_stale ? "oracle stale and no pool price" : "no live price source";
    }

    leg.holdings.push({
      venue: "base", chainId: 8453,
      ticker: stock.ticker, name: stock.name, symbol: stock.symbol,
      contract: stock.token, decimals,
      amount: trimAmount(formatUnits(raw, decimals)), raw: raw.toString(),
      kind: "stock",
      priceUsd, priceSource,
      valueUsd: priceUsd == null ? null : amountNum * priceUsd,
      unpricedReason,
      explorerUrl: `${BASE_EXPLORER}/token/${stock.token}?a=${wallet}`,
    });
  });

  leg.holdings.sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1));
  if (leg.unread > 0) {
    leg.note = `${leg.unread} of ${leg.scanned} balance reads failed — this leg is incomplete, not empty.`;
  }
  return leg;
}

// ── Robinhood Chain 4663 — RHJ RWA ────────────────────────────────────────────

async function readRobinhoodLeg(wallet: Address): Promise<StockLeg> {
  // Only equities. USDG and WETH are in the same registry but they are cash and
  // gas, and they belong in the ordinary token table — which for RH is
  // `lib/wallet/rh-holdings.ts`. That module excludes exactly the rows this
  // filter KEEPS, so the two partition the registry instead of both claiming a
  // holding and counting it twice. (This comment used to say they "already
  // appear as ordinary tokens elsewhere"; until the RH token table existed they
  // appeared nowhere at all.)
  const equities = RWA_TOKENS.filter(t => t.kind === "stock" || t.kind === "etf");
  const leg: StockLeg = {
    venue: "robinhood", chainId: RH_CHAIN.chainId, label: RH_CHAIN.name,
    explorer: RH_CHAIN.explorer, status: "ok",
    scanned: equities.length, unread: 0, holdings: [],
  };

  // One explorer call instead of 200+ eth_calls — RH Chain has no Multicall3
  // (task #88), so per-token reads would be a burst against a single public RPC.
  const read = await getRobinhoodTokenBalances(wallet, "mainnet");
  if (read.status !== "ok") {
    return {
      ...leg, status: "unavailable",
      note: "Robinhood Chain explorer did not answer — stock balances unknown.",
    };
  }

  // Intersect the explorer's list with the registry BY ADDRESS. The registry is
  // the provenance claim (every row was crawled out of the RHJ factory's own
  // deploy events); the explorer merely says what the wallet touched, and it
  // indexes counterfeits just as happily as the real thing.
  const byAddress = new Map<string, RwaToken>(
    equities.map(t => [t.contract.toLowerCase(), t]),
  );
  const matched: Array<{ token: RwaToken; balance: bigint }> = [];
  for (const item of read.items) {
    const token = byAddress.get(item.address.toLowerCase());
    if (!token) continue;               // not a canonical RHJ equity — not ours to show
    let balance: bigint;
    try { balance = BigInt(item.raw); } catch { leg.unread++; continue; }
    if (balance > 0n) matched.push({ token, balance });
  }

  // Reuse the vetted pricing path (Chainlink → DEX spot, null when neither).
  const priced = await priceHoldings(matched).catch(() => null);
  if (priced === null) {
    return {
      ...leg, status: "unavailable",
      note: "Robinhood Chain price reads failed — holdings withheld rather than shown unpriced.",
    };
  }

  leg.holdings = priced.map(h => {
    const token = byAddress.get(h.contract.toLowerCase());
    return {
      venue: "robinhood" as const, chainId: RH_CHAIN.chainId,
      ticker: h.ticker, name: h.name,
      symbol: h.ticker,          // RH tokens carry the bare ticker as their symbol
      contract: h.contract,
      decimals: token?.decimals ?? 18,
      amount: trimAmount(h.balance.toFixed(6)),
      raw: h.balance_raw,
      kind: (h.kind === "etf" ? "etf" : "stock") as "stock" | "etf",
      priceUsd: h.price_usd,
      priceSource: h.price_source,
      valueUsd: h.value_usd,
      // 168 of the 203 RHJ rows have no Chainlink feed at all, so "no price" is
      // the normal case here, not a failure. Say which it is.
      unpricedReason: h.value_usd == null ? "no oracle feed and no pool price" : undefined,
      explorerUrl: `${RH_CHAIN.explorer}/token/${h.contract}?a=${wallet}`,
    };
  });

  return leg;
}

/**
 * Both venues, read in parallel. Never throws: a dead chain becomes an
 * `unavailable` leg, because the caller renders this and "couldn't check" has
 * to be sayable.
 */
export async function readStockHoldings(address: string): Promise<StockPortfolio> {
  if (!isAddress(address)) {
    return { address, legs: [], ts: Date.now(), error: "Invalid wallet address." };
  }
  const wallet = getAddress(address);
  const [base, rh] = await Promise.all([
    readBaseLeg(wallet).catch((): StockLeg => ({
      venue: "base", chainId: 8453, label: "Base", explorer: BASE_EXPLORER,
      status: "unavailable", scanned: BASE_STOCKS.length, unread: 0, holdings: [],
      note: "Base read failed — stock balances unknown.",
    })),
    readRobinhoodLeg(wallet).catch((): StockLeg => ({
      venue: "robinhood", chainId: RH_CHAIN.chainId, label: RH_CHAIN.name,
      explorer: RH_CHAIN.explorer, status: "unavailable",
      scanned: RWA_TOKENS.filter(t => t.kind === "stock" || t.kind === "etf").length,
      unread: 0, holdings: [],
      note: "Robinhood Chain read failed — stock balances unknown.",
    })),
  ]);
  return { address: wallet, legs: [base, rh], ts: Date.now() };
}
