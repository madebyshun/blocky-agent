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

/** Read balanceOf(wallet) for every RWA token in parallel. Fast + safe. */
export async function readAllBalances(
  wallet: Address,
): Promise<Array<{ token: RwaToken; balance: bigint }>> {
  const balances = await Promise.all(
    RWA_TOKENS.map(async (t) => {
      try {
        const b = await rpc().readContract({
          address: t.contract, abi: ERC20_ABI, functionName: "balanceOf", args: [wallet],
        });
        return { token: t, balance: b as bigint };
      } catch {
        return { token: t, balance: 0n };
      }
    }),
  );
  return balances;
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
