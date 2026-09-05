// RH RWA portfolio helpers — shared math + on-chain readers for P1–P4.

import { createPublicClient, http, type Address } from "viem";
import { robinhoodMainnet } from "./chains";
import { RWA_TOKENS, RH_CHAINLINK_ETH_USD, type RwaToken } from "./rwa-registry";
import { chainlinkLatest, dexPrice } from "./rwa-price";

let _client: ReturnType<typeof createPublicClient> | null = null;
function rpc() {
  if (_client) return _client;
  _client = createPublicClient({ chain: robinhoodMainnet, transport: http() });
  return _client;
}

const ERC20_ABI = [{
  name: "balanceOf", type: "function", stateMutability: "view",
  inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }],
}] as const;

export type Holding = {
  ticker: string;
  name: string;
  contract: Address;
  kind: RwaToken["kind"];
  sector: string | null;
  balance_raw: string;       // wei-style, base units
  balance: number;            // human-readable
  price_usd: number | null;
  price_source: "chainlink" | "dex-spot" | null;
  value_usd: number | null;
};

/**
 * Ceiling on in-flight balanceOf calls.
 *
 * This used to be an unbounded `Promise.all` over the registry, which was 26
 * concurrent eth_calls and fine. Completing the registry from the RHJ factory
 * log took it to 205 — one burst per portfolio request, against a single
 * public RPC with no Multicall3 deployed on RH Chain (see task #88). Bounded,
 * it is a few sequential waves and no throttling.
 */
const BALANCE_CONCURRENCY = 12;

export type BalanceRow = { token: RwaToken; balance: bigint; failed: boolean };

/**
 * Read balanceOf(wallet) for every RWA token.
 *
 * `failed` exists because the old version returned 0n on a thrown call, which
 * makes a throttled read indistinguishable from "you don't hold this" — the
 * worst possible failure mode for a portfolio tool, since it silently
 * under-reports a position and every downstream total inherits it. Callers are
 * expected to surface a non-empty failure set rather than present a partial
 * portfolio as complete.
 */
export async function readAllBalances(wallet: Address): Promise<BalanceRow[]> {
  const out = new Array<BalanceRow>(RWA_TOKENS.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(BALANCE_CONCURRENCY, RWA_TOKENS.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= RWA_TOKENS.length) return;
        const t = RWA_TOKENS[i];
        try {
          const b = await rpc().readContract({
            address: t.contract, abi: ERC20_ABI, functionName: "balanceOf", args: [wallet],
          });
          out[i] = { token: t, balance: b as bigint, failed: false };
        } catch {
          out[i] = { token: t, balance: 0n, failed: true };
        }
      }
    }),
  );
  return out;
}

/** For each token with non-zero balance, resolve a price (Chainlink first,
 *  DEX fallback) and compute USD value. Deterministic, no LLM. */
export async function priceHoldings(
  raw: Array<{ token: RwaToken; balance: bigint }>,
): Promise<Holding[]> {
  const nonzero = raw.filter((r) => r.balance > 0n);
  if (!nonzero.length) return [];

  // Optionally fetch WETH/USD once, in case any wrapped is priced via DEX.
  const wethQuote = await chainlinkLatest(RH_CHAINLINK_ETH_USD, 86400);

  const priced = await Promise.all(
    nonzero.map(async ({ token, balance }) => {
      const balNum = Number(balance) / Math.pow(10, token.decimals);

      let price_usd: number | null = null;
      let price_source: Holding["price_source"] = null;

      // Chainlink first.
      if (token.chainlinkFeed) {
        const q = await chainlinkLatest(token.chainlinkFeed, token.chainlinkHeartbeat ?? 86400);
        if (q && !q.is_stale) { price_usd = q.price_usd; price_source = "chainlink"; }
      }
      // Stablecoin fallback: USDG ≈ $1.
      if (price_usd === null && token.kind === "stable") { price_usd = 1; price_source = "chainlink"; }
      // WETH: use Chainlink ETH/USD.
      if (price_usd === null && token.kind === "wrapped" && wethQuote) {
        price_usd = wethQuote.price_usd; price_source = "chainlink";
      }
      // DEX fallback.
      if (price_usd === null) {
        const d = await dexPrice(token.contract);
        if (d) { price_usd = d.price_usd; price_source = "dex-spot"; }
      }

      const value_usd = price_usd !== null ? balNum * price_usd : null;

      return {
        ticker: token.ticker,
        name: token.name,
        contract: token.contract,
        kind: token.kind,
        sector: token.sector ?? null,
        balance_raw: balance.toString(),
        balance: balNum,
        price_usd,
        price_source,
        value_usd,
      } as Holding;
    }),
  );
  // Sort by USD value descending (nulls last).
  priced.sort((a, b) => (b.value_usd ?? -1) - (a.value_usd ?? -1));
  return priced;
}
