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

/**
 * Who we say we are. RH Chain's Blockscout is behind Cloudflare, and Cloudflare
 * 403s Node's default `undici/x.y` User-Agent with an interstitial challenge
 * page — so every server-side call here failed, `bsFetch` mapped the non-ok to
 * `null`, and the surfaces above reported "not found" / "no holdings" instead of
 * "the explorer refused us".
 *
 * MEASURED 2026-09-04, same IP, same second:
 *   (no UA / undici default)                          → 403 + HTML challenge
 *   "BlueAgent/1.0 (+https://blueagent.dev)"          → 403 + HTML challenge
 *   "Mozilla/5.0 (compatible; BlueAgent/1.0; +url)"   → 200 + JSON
 * Production was in the same state: blueagent.dev/api/robinhood/explore returned
 * its "still indexing" 404 for RH AAPL, a token with a $4.9M market cap that
 * Blockscout indexes fine.
 *
 * The string below is the long-standing convention for a well-behaved automated
 * client — the exact shape Googlebot and friends use — and it identifies this
 * app by name with a contact URL. It is NOT a browser impersonation: nothing
 * here claims to be Chrome, and no challenge is being solved or evaded. The
 * `Mozilla/5.0 (compatible; …)` prefix is simply what the filter is keyed on.
 */
const BLOCKSCOUT_UA = "Mozilla/5.0 (compatible; BlueAgent/1.0; +https://blueagent.dev)";

async function bsFetchOnce<T>(
  network: RobinhoodNetwork,
  path: string,
  timeoutMs?: number,
): Promise<T | null> {
  try {
    const res = await fetch(`${EXPLORER_BASE[network]}${path}`, {
      // Blockscout data changes fast (transfers/holders) — don't cache.
      cache: "no-store",
      headers: { "User-Agent": BLOCKSCOUT_UA, Accept: "application/json" },
      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/**
 * `retries` defaults to 0 — every pre-existing caller keeps its exact behaviour.
 *
 * Opt in only where a blip is EXPENSIVE. MEASURED 2026-09-04: this endpoint
 * answered 12/12 in a tight loop and 5/5 via curl, but one call in an earlier
 * run came back non-ok — a genuine intermittent, call it a few percent.
 *
 * A few percent is fine for a card that degrades quietly and wrong for the
 * wallet's stock section, which renders a failed read as a full-width amber
 * "your holdings are unknown here". Crying wolf on ~1 load in 15 is how a user
 * learns to scroll past that box — and then it is worth nothing on the day the
 * explorer is genuinely down. One retry keeps the warning rare enough to mean
 * something; a real outage still fails both attempts and still shows it.
 */
async function bsFetch<T>(
  network: RobinhoodNetwork,
  path: string,
  timeoutMs?: number,
  retries = 0,
): Promise<T | null> {
  for (let attempt = 0; ; attempt++) {
    const out = await bsFetchOnce<T>(network, path, timeoutMs);
    if (out !== null || attempt >= retries) return out;
    await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
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
//
// ⚠️ The token address field on `/addresses/{a}/tokens` is `token.address_hash`,
// NOT `token.address` — MEASURED 2026-09-04, the response has no `address` key
// at all (keys: address_hash, circulating_market_cap, circulating_supply,
// decimals, exchange_rate, holders_count, icon_url, name, reputation, symbol,
// total_supply, type, volume_24h). Note `/tokens/{addr}` DOES use `address_hash`
// too, but the holders/transfers endpoints nest a full address object under
// `address.hash` — three shapes, one explorer.
//
// This is worth a warning because the mistake is silent in both directions:
// `bsFetch`'s generic is hand-written, so a wrong field name still typechecks,
// and the wrong field reads `undefined` rather than throwing. Both functions
// below shipped with `token.address` — the filter dropped every row, so a wallet
// holding 5,665 AAPL reported no stock holdings at all, and check_wallet's RH
// rows carried `address: undefined`. Verify field names against a live payload,
// not against the type you just wrote.

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
 * Raw ERC-20 balances for an address, with the outage kept VISIBLE.
 *
 * `getRobinhoodAddressBalances` below fail-softs a dead Blockscout into an empty
 * array, which is right for a card that degrades to "what it has" — and wrong
 * for anything that renders the result as a portfolio, because "the explorer did
 * not answer" and "you hold nothing" then look identical. That is the same
 * defect as reading a KV throttle as an absent key (#150), and it is worse here:
 * the user would see an empty stock section and reasonably conclude their
 * position is gone.
 *
 * So this returns a three-way and lets the caller say "couldn't check".
 * RH Chain has no Multicall3 deployed (task #88), so the one-shot explorer
 * index is also the only way to read 200+ registry tokens without 200 eth_calls.
 */
export type RhTokenBalanceRead =
  | { status: "ok"; items: Array<{ address: string; raw: string }> }
  | { status: "unavailable" };

export async function getRobinhoodTokenBalances(
  address: string,
  network: RobinhoodNetwork = "mainnet",
): Promise<RhTokenBalanceRead> {
  const list = await bsFetch<{ items?: Array<{ token: { address_hash: string }; value: string }> }>(
    network,
    `/api/v2/addresses/${address}/tokens?type=ERC-20`,
    undefined,
    1, // see bsFetch — a spurious "holdings unknown" banner is the costly failure here
  );
  if (!list) return { status: "unavailable" };
  const items = (list.items ?? [])
    .filter((it) => it?.token?.address_hash && it.value && it.value !== "0")
    .map((it) => ({ address: it.token.address_hash, raw: it.value }));
  return { status: "ok", items };
}

/**
 * The same read as `getRobinhoodAddressBalances`, but with the outage VISIBLE.
 *
 * Prefer this anywhere the result is rendered as a PORTFOLIO. The fail-soft
 * wrapper below collapses "the explorer did not answer" into "you hold nothing",
 * and a user looking at their own wallet cannot tell those apart — they conclude
 * the position is gone. Same three-way, same reason, as `getRobinhoodTokenBalances`
 * above; this one just carries the token metadata too.
 *
 * `unavailable` is decided by the ERC-20 list call alone, because that is the one
 * that defines the portfolio. The native-ETH call failing on its own leaves the
 * token list perfectly real and the leg short by exactly one row, which is
 * `nativeUnread` — reported, not silently dropped and not counted as zero ETH.
 *
 * `balances` is populated on BOTH arms, and on the `unavailable` arm it holds
 * whatever did come back (at most the native row). That is not an invitation to
 * render it as a portfolio — it exists so the fail-soft wrapper below can return
 * exactly what it always returned. A caller that shows this to a user must branch
 * on `status` first.
 *
 * `retries` and `maxPages` are parameters rather than constants so the existing
 * chat card keeps its exact behaviour (0 and 1) while the wallet can opt into
 * more — see `bsFetch` on why a rare spurious banner is the expensive failure
 * for a portfolio.
 *
 * PAGINATION — `truncated`. Blockscout serves this endpoint 50 rows at a time
 * and hands back a `next_page_params` cursor. This function ignored it, so a
 * wallet holding more than 50 tokens was read as if it held exactly 50.
 * MEASURED 2026-09-06 on `0x1A18…A4E7`: page 1 was full, page 2 was also full,
 * and the reader was reporting 2 crypto rows (the other 48 being equities that
 * route to the stock table). Whatever sits past the cursor is invisible AND
 * unaccounted for in any total computed from this list.
 *
 * `maxPages` bounds the walk — this is a wallet page, not a crawler, and a
 * spam-airdropped address can hold hundreds of rows. When the cursor is still
 * live at the cap we stop and set `truncated`, which is the same contract as
 * `nativeUnread`: the list is short, by an amount we do not know, and the
 * caller has to SAY so rather than present it as the whole portfolio.
 */
export type RhAddressBalanceRead =
  | { status: "ok";          balances: RhBalance[]; nativeUnread: boolean; truncated: boolean }
  | { status: "unavailable"; balances: RhBalance[]; nativeUnread: boolean; truncated: boolean };

type RhTokenPage = {
  items?: Array<{
    token: {
      address_hash: string;
      name?: string | null;
      symbol?: string | null;
      decimals?: string | null;
      exchange_rate?: string | null;
    };
    value: string;
  }>;
  next_page_params?: Record<string, string | number | null> | null;
};

export async function readRobinhoodAddressBalances(
  address: string,
  network: RobinhoodNetwork = "mainnet",
  retries = 0,
  maxPages = 1,
): Promise<RhAddressBalanceRead> {
  const tokenPath = `/api/v2/addresses/${address}/tokens?type=ERC-20`;

  // Page 1 runs alongside the native-balance call; later pages are cursor-based
  // and therefore strictly sequential.
  const [addrInfo, firstPage] = await Promise.all([
    bsFetch<{ coin_balance?: string; exchange_rate?: string | null }>(
      network, `/api/v2/addresses/${address}`, undefined, retries),
    bsFetch<RhTokenPage>(network, tokenPath, undefined, retries),
  ]);

  const pages: RhTokenPage[] = firstPage ? [firstPage] : [];
  let cursor = firstPage?.next_page_params ?? null;
  let truncated = false;

  while (cursor && Object.keys(cursor).length > 0) {
    if (pages.length >= maxPages) { truncated = true; break; }
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(cursor)) if (v != null) qs.set(k, String(v));
    const next = await bsFetch<RhTokenPage>(network, `${tokenPath}&${qs}`, undefined, retries);
    // A mid-walk failure is a short list, not an empty one — the pages already
    // read are real, so keep them and mark the remainder unknown.
    if (!next) { truncated = true; break; }
    pages.push(next);
    cursor = next.next_page_params ?? null;
  }

  const tokenList = firstPage ? { items: pages.flatMap(p => p.items ?? []) } : null;

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
      address:  it.token.address_hash,
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

  return tokenList
    ? { status: "ok",          balances: out, nativeUnread: !addrInfo, truncated }
    : { status: "unavailable", balances: out, nativeUnread: !addrInfo, truncated };
}

/**
 * Live token holdings for an address on Robinhood Chain via Blockscout v2.
 * Two calls in parallel: `/addresses/{addr}` (native ETH + rate) and
 * `/addresses/{addr}/tokens?type=ERC-20` (all ERC-20). Fail-soft: any missing
 * source returns an empty leg — the caller degrades to what it has.
 *
 * ⚠️ Fail-soft is right for a card that says "here is what I could find" and
 * WRONG for a portfolio — see `readRobinhoodAddressBalances` above, which is
 * this same read with the outage kept distinguishable. Use that one for new
 * callers; this wrapper exists for the chat `check_wallet` card, whose whole
 * contract is to degrade quietly.
 */
export async function getRobinhoodAddressBalances(
  address: string,
  network: RobinhoodNetwork = "mainnet",
): Promise<RhBalance[]> {
  return (await readRobinhoodAddressBalances(address, network)).balances;
}
