/**
 * Well-known Base mainnet ERC-20 tokens — verified addresses + on-chain decimals.
 *
 * This is a defense against the RPC-fallback-to-18 bug: if a decimals() read
 * fails silently and the create endpoint returns decimals=18 for USDC, the
 * user's approve() would be sized 10^12 too large ($2 request → $2 trillion
 * spending cap). Any address in this map returns the hardcoded decimals
 * without touching the RPC.
 *
 * Extend cautiously — every entry here must be independently verified on
 * Basescan (checksum + call decimals()). Do NOT copy from third-party lists.
 */

import type { Address } from "viem";

// Note: keys are lowercase for case-insensitive lookup
export const KNOWN_BASE_TOKENS: Record<string, { symbol: string; decimals: number }> = {
  // USDC (Circle native, verified 6 decimals on Basescan)
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": { symbol: "USDC",      decimals: 6  },
  // WETH (Optimism/Base standard weth9, verified 18 decimals)
  "0x4200000000000000000000000000000000000006": { symbol: "WETH",      decimals: 18 },
  // cbBTC (Coinbase-Wrapped BTC, verified 8 decimals — BTC standard)
  "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf": { symbol: "cbBTC",     decimals: 8  },
  // BLUEAGENT (Blue Agent v4 pool token, verified 18 decimals)
  "0xf895783b2931c919955e18b5e3343e7c7c456ba3": { symbol: "BLUEAGENT", decimals: 18 },
  // USDbC (bridged USDC, legacy — verified 6 decimals)
  "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca": { symbol: "USDbC",     decimals: 6  },
  // DAI on Base (verified 18 decimals)
  "0x50c5725949a6f0c72e6c4a641f24049a917db0cb": { symbol: "DAI",       decimals: 18 },
};

export function knownBaseToken(address: Address): { symbol: string; decimals: number } | null {
  return KNOWN_BASE_TOKENS[address.toLowerCase()] ?? null;
}
