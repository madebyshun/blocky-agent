/**
 * Robinhood Chain crypto holdings — the leg the wallet was silently missing.
 *
 * ── The gap this closes ───────────────────────────────────────────────────────
 * `TokenTable` → /api/wallet/holdings → `checkWallet()` → Moralis, and Moralis
 * does not index RH Chain (4663). `StockTable` → /api/wallet/stocks reads RH,
 * but only equities from the pinned RWA registry. So a wallet holding RH crypto
 * saw its RH *stocks* and not its RH *tokens* — including USDG, which is what
 * this chain calls cash — with nothing on screen saying a whole chain went
 * unread. `stock-holdings.ts` even excludes USDG and WETH from its RH leg on the
 * grounds that "they already appear as ordinary tokens elsewhere". They did not.
 * Blue Chat's `check_wallet` card has shown both chains all along, so the app
 * gave two different answers depending on which surface you opened.
 *
 * ── Why this is its own module and not a branch inside holdings.ts ────────────
 * The two chains share no state and no reader. Base goes through Moralis with a
 * B20 `isB20()` confirmation and a 0x-backed quick-sell; RH goes through
 * Blockscout, has no Multicall3 (#88) and nothing to sell into. Folding RH rows
 * into the Base list would hand them a Sell button that cannot settle and a
 * trust verdict computed against the wrong chain's address book.
 *
 * ── Three answers, not two ────────────────────────────────────────────────────
 * Same rule the stock leg follows: "you hold none" and "we could not look" are
 * different facts. A dead explorer returns `status:"unavailable"` and the UI says
 * so — rendering it as an empty portfolio is how a user concludes their position
 * vanished.
 *
 * ZERO fabrication: every number is Blockscout's. A token Blockscout has no
 * exchange rate for keeps `usdValue: undefined` and shows a dash, never a zero.
 */
import { isAddress, getAddress } from "viem";
import { RH_CHAIN, RWA_TOKENS } from "@/lib/robinhood/rwa-registry";
import { readRobinhoodAddressBalances, type RhBalance } from "@/lib/robinhood/blockscout";
import { classifyToken, countsTowardTotal, type TokenTrust } from "@/lib/wallet/token-trust";

export interface RhHolding extends RhBalance {
  /** Derived here rather than in the view, so the total and the badge cannot
   *  disagree about which rows this app is willing to stand behind. */
  trust: TokenTrust;
  explorerUrl: string;
}

export interface RhHoldingsResult {
  address:  string;
  chainId:  number;
  label:    string;
  explorer: string;
  /** "ok" — we read the chain. "unavailable" — we could NOT, and the empty
   *  `holdings` is an absence of knowledge, not an absence of tokens. */
  status:   "ok" | "unavailable";
  holdings: RhHolding[];
  /** Sum of the rows this app will vouch for and that Blockscout priced.
   *  Impostors are excluded for the same reason as on Base: a token that quotes
   *  its own price through its own pool would otherwise set this number. */
  totalUsd: number;
  /** Rows dropped because `StockTable` already renders them. Surfaced rather
   *  than silently swallowed — otherwise a user comparing this against the
   *  explorer finds tokens missing and no reason given. */
  equitiesHidden: number;
  /** Blockscout answered for the ERC-20 list but not for native ETH. The leg is
   *  short by at most one row — never treat as "holds no ETH". */
  nativeUnread: boolean;
  /** This address holds more tokens than `RH_MAX_TOKEN_PAGES` reads. The rows
   *  here are real and are the highest-valued ones, but the LIST is short —
   *  the UI has to say so rather than present a partial view as the whole. */
  truncated: boolean;
  ts:     number;
  error?: string;
}

/**
 * 4 pages × 50 = 200 tokens. Pages after the first are cursor-based and
 * therefore sequential, so this doubles as the latency ceiling on the read.
 *
 * WHY A CAP IS CHEAP HERE — MEASURED 2026-09-06, walking `0x1A18…A4E7` to
 * exhaustion. Blockscout serves this endpoint ordered by fiat value descending,
 * unpriced last; its `next_page_params` cursor carries the `fiat_value` it broke
 * on, so the ordering is readable rather than assumed:
 *
 *   page 1 → cursor fiat $33.33      page 4+ → cursor fiat null (unpriced)
 *   page 2 → cursor fiat  $3.93      …450+ rows and still going
 *   page 3 → cursor fiat  $0.036
 *
 * So by page 4 every remaining row is worth pennies or is unpriced: the cap
 * costs ROWS, not dollars, and `totalUsd` is materially complete. That address
 * is an airdrop magnet — 450+ tokens — and walking it fully would be nine
 * sequential requests to add nothing to the number on screen.
 *
 * "Materially complete" is still not "complete", and this ordering is one
 * measurement on one address, so hitting the cap is reported rather than
 * assumed harmless. Sampled holders sat at 47 and 36 rows and never hit it.
 *
 * Equities are unaffected either way: `StockTable` reads the pinned registry
 * directly, so a stock past this cursor still shows up there.
 */
const RH_MAX_TOKEN_PAGES = 4;

/**
 * Addresses whose rows belong to the STOCK table, not here.
 *
 * Exactly the same filter `stock-holdings.ts` applies (`kind` stock|etf), so the
 * two tables partition the registry between them instead of both claiming a row.
 * A holding shown twice is not a cosmetic problem — it is counted twice, and the
 * two tables then disagree about the same wallet.
 *
 * WETH and USDG are deliberately NOT in this set: the stock leg excludes them as
 * "cash and gas", which makes them this table's job.
 */
const EQUITY_ADDRESSES: ReadonlySet<string> = new Set(
  RWA_TOKENS.filter(t => t.kind === "stock" || t.kind === "etf")
    .map(t => t.contract.toLowerCase()),
);

/**
 * Never throws: the caller renders this, and "couldn't check" has to be sayable.
 *
 * One retry on the explorer read (see `bsFetch`) — a spurious "holdings unknown"
 * banner on ~1 load in 15 is how a user learns to scroll past the warning, and
 * then it is worth nothing on the day RH Chain is genuinely down.
 */
export async function readRhHoldings(address: string): Promise<RhHoldingsResult> {
  const meta = {
    chainId:  RH_CHAIN.chainId,
    label:    RH_CHAIN.name,
    explorer: RH_CHAIN.explorer,
    ts:       Date.now(),
  };

  if (!isAddress(address)) {
    return {
      ...meta, address, status: "unavailable", holdings: [],
      totalUsd: 0, equitiesHidden: 0, nativeUnread: false, truncated: false,
      error: "Invalid wallet address.",
    };
  }
  const wallet = getAddress(address);

  const read = await readRobinhoodAddressBalances(wallet, "mainnet", 1, RH_MAX_TOKEN_PAGES).catch(
    () => ({ status: "unavailable" as const, balances: [] as RhBalance[] }),
  );

  if (read.status !== "ok") {
    return {
      ...meta, address: wallet, status: "unavailable", holdings: [],
      totalUsd: 0, equitiesHidden: 0, nativeUnread: false, truncated: false,
    };
  }

  let equitiesHidden = 0;
  const holdings: RhHolding[] = [];
  for (const b of read.balances) {
    if (!b.isNative && EQUITY_ADDRESSES.has(b.address.toLowerCase())) { equitiesHidden++; continue; }
    holdings.push({
      ...b,
      trust: classifyToken(b, "robinhood"),
      explorerUrl: `${RH_CHAIN.explorer}/token/${b.address}?a=${wallet}`,
    });
  }

  // `readRobinhoodAddressBalances` already sorts native → stable → USD desc.
  // Only the impostor demotion is added, matching Base's `rank()`: the ordering
  // itself carries the warning, so it survives the badge being missed.
  holdings.sort((a, b) => {
    const ra = a.trust === "impostor" ? 1 : 0;
    const rb = b.trust === "impostor" ? 1 : 0;
    return ra - rb;
  });

  const totalUsd = holdings.reduce(
    (sum, h) => sum + (countsTowardTotal(h.trust) ? (h.usdValue ?? 0) : 0), 0,
  );

  return {
    ...meta, address: wallet, status: "ok", holdings,
    totalUsd, equitiesHidden, nativeUnread: read.nativeUnread,
    truncated: read.truncated,
  };
}
