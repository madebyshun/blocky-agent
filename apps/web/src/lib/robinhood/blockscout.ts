// Thin server-side client for Robinhood Chain's Blockscout instance (REST API
// v2 — confirmed live at robinhoodchain.blockscout.com/api/v2 and
// explorer.testnet.chain.robinhood.com/api/v2, same shape on both networks).
// Read-only — no wallet/signing involved. Used to power the "Explore" panel
// on /app/launches so users can see real holders/transfers for a Robinhood
// direct-deploy token without leaving the app.

const EXPLORER_BASE = {
  mainnet: "https://robinhoodchain.blockscout.com",
  testnet: "https://explorer.testnet.chain.robinhood.com",
} as const;

export type RobinhoodNetwork = keyof typeof EXPLORER_BASE;

export type BlockscoutAddressRef = {
  hash: string;
  is_contract: boolean;
  is_verified: boolean;
  name: string | null;
};

export type BlockscoutTokenInfo = {
  address_hash: string;
  name: string | null;
  symbol: string | null;
  decimals: string | null;
  total_supply: string | null;
  holders_count: string | null;
  exchange_rate: string | null;
  circulating_market_cap: string | null;
  volume_24h: string | null;
  icon_url: string | null;
};

export type BlockscoutHolder = {
  address: BlockscoutAddressRef;
  value: string;
};

export type BlockscoutTransfer = {
  block_number: number;
  timestamp: string;
  from: BlockscoutAddressRef;
  to: BlockscoutAddressRef;
  total?: { value?: string; decimals?: string };
  tx_hash?: string;
  transaction_hash?: string;
};

async function bsFetch<T>(
  network: RobinhoodNetwork,
  path: string,
  timeoutMs?: number,
): Promise<T | null> {
  try {
    const res = await fetch(`${EXPLORER_BASE[network]}${path}`, {
      // Blockscout data changes fast (transfers/holders) — don't cache.
      cache: "no-store",
      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function getTokenInfo(network: RobinhoodNetwork, address: string) {
  return bsFetch<BlockscoutTokenInfo>(network, `/api/v2/tokens/${address}`);
}

export async function getTokenHolders(network: RobinhoodNetwork, address: string) {
  const data = await bsFetch<{ items: BlockscoutHolder[] }>(network, `/api/v2/tokens/${address}/holders`);
  return data?.items ?? [];
}

export async function getTokenTransfers(network: RobinhoodNetwork, address: string) {
  const data = await bsFetch<{ items: BlockscoutTransfer[] }>(network, `/api/v2/tokens/${address}/transfers`);
  return data?.items ?? [];
}

export function explorerBase(network: RobinhoodNetwork): string {
  return EXPLORER_BASE[network];
}

/**
 * Who deployed this contract. Returns the creator address, or null when
 * Blockscout doesn't know (EOA, unindexed, or the request failed).
 *
 * Provenance is the only property of a token an impersonator cannot copy:
 * name, symbol and decimals are free to forge, but the creator is written at
 * deployment. `rh-rwa-verify` leans on this to tell a real Robinhood stock
 * token from a byte-identical fake.
 *
 * Null means "couldn't determine", NOT "not the deployer" — callers must keep
 * those two apart or a Blockscout hiccup turns into a false accusation.
 *
 * Measured 2.4–8.8s per call on RH Chain's Blockscout, so the timeout is
 * explicit: a defensive tool that hangs is a defensive tool nobody calls.
 */
const CREATOR_TIMEOUT_MS = 10_000;

export async function getContractCreator(
  address: string,
  network: RobinhoodNetwork = "mainnet",
): Promise<string | null> {
  const info = await bsFetch<{ creator_address_hash?: string | null }>(
    network,
    `/api/v2/addresses/${address}`,
    CREATOR_TIMEOUT_MS,
  );
  return info?.creator_address_hash ?? null;
}

// ─── Address balances (native ETH + all ERC-20) ─────────────────────────────
// Powers the check_wallet card's Robinhood Chain leg (Moralis doesn't index
// RH). All fields come straight from Blockscout — never fabricate.

export interface RhBalance {
  symbol:    string;
  name?:     string;
  address:   string;   // "0xeee…eee" for native ETH; token contract otherwise
  amount:    string;   // human-readable, decimal
  raw:       string;   // raw integer balance
  decimals:  number;
  isNative?: boolean;
  usdValue?: number;   // computed from Blockscout exchange_rate when available
}

function trimDecimal(s: string): string {
  if (!s.includes(".")) return s;
  return s.replace(/\.?0+$/, "") || "0";
}

/**
 * Live token holdings for an address on Robinhood Chain via Blockscout v2.
 * Two calls in parallel: `/addresses/{addr}` (native ETH + rate) and
 * `/addresses/{addr}/tokens?type=ERC-20` (all ERC-20). Fail-soft: any missing
 * source returns an empty leg — the caller degrades to what it has.
 */
export async function getRobinhoodAddressBalances(
  address: string,
  network: RobinhoodNetwork = "mainnet",
): Promise<RhBalance[]> {
  const [addrInfo, tokenList] = await Promise.all([
    bsFetch<{ coin_balance?: string; exchange_rate?: string | null }>(network, `/api/v2/addresses/${address}`),
    bsFetch<{ items?: Array<{
      token: {
        address: string;
        name?: string | null;
        symbol?: string | null;
        decimals?: string | null;
        exchange_rate?: string | null;
      };
      value: string;
    }> }>(network, `/api/v2/addresses/${address}/tokens?type=ERC-20`),
  ]);

  const out: RhBalance[] = [];

  // Native ETH — only push when non-zero to avoid clutter.
  if (addrInfo?.coin_balance && addrInfo.coin_balance !== "0") {
    const wei = BigInt(addrInfo.coin_balance);
    // Number() may lose precision on wei bigger than 2^53, but for display
    // that's fine; the raw string is preserved in .raw for exact math.
    const eth = Number(wei) / 1e18;
    const rate = addrInfo.exchange_rate ? Number(addrInfo.exchange_rate) : null;
    out.push({
      symbol:   "ETH",
      address:  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      amount:   trimDecimal(eth.toFixed(18)),
      raw:      addrInfo.coin_balance,
      decimals: 18,
      isNative: true,
      usdValue: rate && Number.isFinite(rate) ? eth * rate : undefined,
    });
  }

  // ERC-20 holdings
  for (const it of tokenList?.items ?? []) {
    const dec = it.token.decimals ? parseInt(it.token.decimals, 10) : 18;
    const raw = it.value;
    if (!raw || raw === "0") continue;
    let amount = 0;
    try {
      amount = Number(BigInt(raw)) / Math.pow(10, dec);
    } catch { amount = 0; }
    const rate = it.token.exchange_rate ? Number(it.token.exchange_rate) : null;
    out.push({
      symbol:   it.token.symbol || "?",
      name:     it.token.name || undefined,
      address:  it.token.address,
      amount:   trimDecimal(amount.toFixed(dec)),
      raw,
      decimals: dec,
      usdValue: rate && Number.isFinite(rate) ? amount * rate : undefined,
    });
  }

  // Sort: native → stablecoins → highest USD → rest
  const stables = new Set(["USDC", "USDT", "DAI", "USDG"]);
  out.sort((a, b) => {
    const ra = a.isNative ? 0 : stables.has(a.symbol.toUpperCase()) ? 1 : 2;
    const rb = b.isNative ? 0 : stables.has(b.symbol.toUpperCase()) ? 1 : 2;
    if (ra !== rb) return ra - rb;
    return (b.usdValue ?? 0) - (a.usdValue ?? 0);
  });

  return out;
}
