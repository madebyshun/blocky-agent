/**
 * Where pledge transfers are read from.
 *
 * Three adapters, all answering the same question — "which ERC-20 transfers of
 * the old token landed in the receiving wallet?" — with different trade-offs:
 *
 *   • Moralis    (Base) — indexed, full history, one paged call. Needs a key.
 *   • Blockscout (RH)   — indexed, full history, one paged call. No key.
 *   • RPC getLogs (both) — trustless but pages over block ranges, so it is the
 *     FALLBACK, used only when the indexer for that chain fails.
 *
 * Why an indexer leads on a page whose whole promise is verifiability: the
 * alternative was measured, not assumed. Scanning from genesis at a 9,500-block
 * range costs 5,239 sequential calls on Base and 3,426 on RH; at the 0.51s per
 * call measured against the public RPC on 2026-08-10 that is ~74 minutes for a
 * single ledger build, against a Vercel function ceiling of 10–60s. The page
 * would never have loaded. Pinning `fromBlock` (config.ts) makes the RPC path
 * viable as a fallback; the indexers make the normal path instant. Every row
 * still carries its tx hash and links to the explorer, so nothing here has to
 * be taken on trust from either source.
 *
 * ─── The rule every adapter obeys ───────────────────────────────────────────
 * Return ALL the transfers, or return an error. Never return some of them.
 * A silently short list is the single worst failure this file can have: the
 * holder sees their pledge missing from a public ledger and concludes it was
 * taken. `getLogsRange` below is written around that rule.
 */
import { createPublicClient, http, parseAbiItem, getAddress } from "viem";
import { CHAINS, RECEIVING_WALLET, type ChainKey } from "./config";
import type { PledgeTx, SourceResult } from "./types";

const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

/** Hard ceilings. Hitting one sets `truncated`, which the UI renders loudly. */
const MAX_INDEXER_PAGES = 40;
const MAX_RPC_CALLS = 400;
const RPC_CHUNK = 9_500n;
const FETCH_TIMEOUT_MS = 12_000;

const BLOCKSCOUT_BASE =
  process.env.ROBINHOOD_BLOCKSCOUT_URL ||
  "https://robinhoodchain.blockscout.com";

const RECEIVING_LC = RECEIVING_WALLET.toLowerCase();

async function getJson<T>(url: string, headers?: Record<string, string>): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: ctl.signal, cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

const isoToUnix = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
};

// ─── Moralis (Base) ──────────────────────────────────────────────────────────

interface MoralisTransfer {
  from_address: string;
  to_address: string;
  address: string;
  block_number: string;
  block_timestamp: string;
  transaction_hash: string;
  value: string;
}

/**
 * Wallet-scoped ERC-20 transfer history for the receiving wallet on Base.
 *
 * The endpoint returns transfers in BOTH directions and (despite the
 * `contract_addresses` filter) is treated as untrusted here: every row is
 * re-checked against the token address and the receiving address before it
 * counts. A pledge ledger that credited an outbound transfer, or a transfer of
 * some other token, would be inventing pledges.
 */
export async function fetchBaseFromMoralis(): Promise<SourceResult> {
  const key = process.env.MORALIS_API_KEY;
  if (!key) return { ok: false, error: "MORALIS_API_KEY not set" };

  const token = CHAINS.base.token.address.toLowerCase();
  const txs: PledgeTx[] = [];
  let cursor = "";
  let truncated = false;

  try {
    for (let page = 0; ; page++) {
      if (page >= MAX_INDEXER_PAGES) {
        truncated = true;
        break;
      }
      const url =
        `https://deep-index.moralis.io/api/v2.2/${RECEIVING_WALLET}/erc20/transfers` +
        `?chain=base&limit=100&contract_addresses%5B0%5D=${token}` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");

      const body = await getJson<{ result?: MoralisTransfer[]; cursor?: string | null }>(
        url,
        { "X-API-Key": key, accept: "application/json" },
      );

      for (const t of body.result ?? []) {
        if (t.address?.toLowerCase() !== token) continue;
        if (t.to_address?.toLowerCase() !== RECEIVING_LC) continue;
        txs.push({
          wallet: getAddress(t.from_address),
          chain: "base",
          amount: t.value,
          txHash: t.transaction_hash,
          blockNumber: Number(t.block_number),
          timestamp: isoToUnix(t.block_timestamp),
        });
      }

      if (!body.cursor) break;
      cursor = body.cursor;
    }
    return { ok: true, txs, source: "indexer", truncated };
  } catch (e) {
    return { ok: false, error: `moralis: ${(e as Error).message}` };
  }
}

// ─── Blockscout (Robinhood Chain) ────────────────────────────────────────────

interface BlockscoutTransfer {
  block_number: number;
  transaction_hash: string;
  timestamp: string;
  from: { hash: string };
  to: { hash: string };
  token: { address_hash: string };
  total: { value: string; decimals: string };
}

export async function fetchRhFromBlockscout(): Promise<SourceResult> {
  const token = CHAINS.rh.token.address.toLowerCase();
  const txs: PledgeTx[] = [];
  let next: Record<string, unknown> | null = null;
  let truncated = false;

  try {
    for (let page = 0; ; page++) {
      if (page >= MAX_INDEXER_PAGES) {
        truncated = true;
        break;
      }
      const qs = new URLSearchParams({ type: "ERC-20", token: CHAINS.rh.token.address });
      if (next) {
        for (const [k, v] of Object.entries(next)) {
          if (v !== null && v !== undefined) qs.set(k, String(v));
        }
      }
      const url = `${BLOCKSCOUT_BASE}/api/v2/addresses/${RECEIVING_WALLET}/token-transfers?${qs}`;

      const body = await getJson<{
        items?: BlockscoutTransfer[];
        next_page_params?: Record<string, unknown> | null;
      }>(url, { accept: "application/json" });

      for (const t of body.items ?? []) {
        if (t.token?.address_hash?.toLowerCase() !== token) continue;
        if (t.to?.hash?.toLowerCase() !== RECEIVING_LC) continue;
        txs.push({
          wallet: getAddress(t.from.hash),
          chain: "rh",
          amount: t.total.value,
          txHash: t.transaction_hash,
          blockNumber: Number(t.block_number),
          timestamp: isoToUnix(t.timestamp),
        });
      }

      if (!body.next_page_params) break;
      next = body.next_page_params;
    }
    return { ok: true, txs, source: "indexer", truncated };
  } catch (e) {
    return { ok: false, error: `blockscout: ${(e as Error).message}` };
  }
}

// ─── RPC fallback (either chain) ─────────────────────────────────────────────

/**
 * Collect Transfer logs over [from, to], splitting on failure.
 *
 * The bisect is the whole point. The obvious version — catch, retry the first
 * half, move on — drops the SECOND half permanently and reports success, so a
 * single rate-limited range silently deletes pledges from a public ledger.
 * Here both halves are retried, and a range that cannot be split any further
 * THROWS rather than returning what it managed to read. Losing the data loudly
 * is recoverable; losing it quietly is not.
 *
 * Exported for `scripts/pledge-ledger-test.ts`, which drives it with a client
 * that fails on wide ranges and succeeds on narrow ones — the only way to prove
 * the recovery actually recovers, since a real RPC cannot be asked to fail on
 * demand and the empty ledger makes every live run of this path vacuous.
 */
export async function getLogsRange(
  client: ReturnType<typeof createPublicClient>,
  chain: ChainKey,
  from: bigint,
  to: bigint,
  out: PledgeTx[],
  budget: { calls: number },
): Promise<void> {
  if (budget.calls >= MAX_RPC_CALLS) throw new Error("rpc call budget exhausted");
  budget.calls++;

  const cfg = CHAINS[chain];
  try {
    const logs = await client.getLogs({
      address: cfg.token.address,
      event: TRANSFER_EVENT,
      args: { to: RECEIVING_WALLET },
      fromBlock: from,
      toBlock: to,
    });
    for (const log of logs) {
      out.push({
        wallet: getAddress(log.args.from as string),
        chain,
        amount: (log.args.value as bigint).toString(),
        txHash: log.transactionHash,
        blockNumber: Number(log.blockNumber),
        timestamp: null,
      });
    }
  } catch (e) {
    if (to <= from) throw e; // single block still failing — do not swallow
    const mid = from + (to - from) / 2n;
    await getLogsRange(client, chain, from, mid, out, budget);
    await getLogsRange(client, chain, mid + 1n, to, out, budget);
  }
}

export async function fetchFromRpc(chain: ChainKey): Promise<SourceResult> {
  const cfg = CHAINS[chain];
  const client = createPublicClient({ transport: http(cfg.rpcUrl) });
  const txs: PledgeTx[] = [];
  const budget = { calls: 0 };
  let truncated = false;

  try {
    const head = await client.getBlockNumber();
    let from = cfg.pinnedFromBlock;

    while (from <= head) {
      if (budget.calls >= MAX_RPC_CALLS) {
        truncated = true;
        break;
      }
      const to = from + RPC_CHUNK > head ? head : from + RPC_CHUNK;
      await getLogsRange(client, chain, from, to, txs, budget);
      from = to + 1n;
    }

    // Timestamps for the (small) set of blocks that actually had a pledge.
    const blocks = [...new Set(txs.map((t) => t.blockNumber))].slice(0, 100);
    const stamps = new Map<number, number>();
    await Promise.all(
      blocks.map(async (bn) => {
        try {
          const b = await client.getBlock({ blockNumber: BigInt(bn) });
          stamps.set(bn, Number(b.timestamp));
        } catch {
          /* timestamp is cosmetic — a missing one must not fail the ledger */
        }
      }),
    );
    for (const t of txs) t.timestamp = stamps.get(t.blockNumber) ?? null;

    return { ok: true, txs, source: "rpc", truncated };
  } catch (e) {
    return { ok: false, error: `rpc(${chain}): ${(e as Error).message}` };
  }
}

/**
 * Indexer first, RPC second. Returns the RPC error only if BOTH fail, since
 * that is the case the caller has to surface as degraded rather than empty.
 */
export async function fetchChainTransfers(chain: ChainKey): Promise<SourceResult> {
  const primary =
    chain === "base" ? await fetchBaseFromMoralis() : await fetchRhFromBlockscout();
  if (primary.ok) return primary;

  const fallback = await fetchFromRpc(chain);
  if (fallback.ok) return fallback;

  return { ok: false, error: `${primary.error}; ${fallback.error}` };
}
