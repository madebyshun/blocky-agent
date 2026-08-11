/**
 * Turning raw Transfer events into the published ledger.
 *
 * Three jobs, in order of how badly each one can lie to a holder:
 *
 *   1. AGGREGATE — group transfers by (chain, wallet) and sum them in BigInt.
 *   2. DENOMINATE — read `totalSupply()` from the contract so every published
 *      percentage has a denominator that came from the chain, not from a
 *      constant that drifted.
 *   3. DEGRADE HONESTLY — when a read fails, serve the last good numbers and
 *      SAY they are old. Never serve zero. On this page "0 pledged" is not a
 *      neutral empty state; it is what theft looks like.
 *
 * ─── Why the cache is written the way it is ─────────────────────────────────
 * The snapshot is cached with a LONG TTL (7 days) but treated as fresh for only
 * 60 seconds. Those are different things and conflating them is the bug: a TTL
 * short enough to force refresh is also short enough that the one time an
 * indexer is down, the cache has already expired and there is nothing left to
 * fall back to. Long TTL + short freshness window means the fallback always
 * exists, and staleness is disclosed rather than prevented.
 */
import { createPublicClient, http, parseAbi, getAddress, isAddress } from "viem";
import {
  CHAINS,
  CHAIN_KEYS,
  RECEIVING_WALLET,
  PLEDGE_DEADLINE_ISO,
  ALLOCATION_ANNOUNCED,
  type ChainKey,
} from "./config";
import { fetchChainTransfers } from "./sources";
import { formatAmount, pctOfSupply } from "./format";
import type { PledgeTx, WalletPledge, ChainSummary, LedgerSnapshot } from "./types";
import { kvGetProbe, kvSet, kvSetNX } from "../kv";

const SNAPSHOT_KEY = "pledge:v1:snapshot";
const REFRESH_LOCK_KEY = "pledge:v1:refreshing";

/** How long a snapshot is served without re-reading the chain. */
const FRESH_MS = 60_000;
/** How long a snapshot survives in KV — the floor under every degraded read. */
const SNAPSHOT_TTL_S = 7 * 24 * 60 * 60;
/** Lock lifetime: longer than a build, short enough to self-heal after a crash. */
const REFRESH_LOCK_S = 45;

const ERC20_ABI = parseAbi(["function totalSupply() view returns (uint256)"]);

// ─── Supply ──────────────────────────────────────────────────────────────────

/**
 * Live `totalSupply()`, falling back to the pinned constant.
 *
 * Which one was used is REPORTED (`supplySource`) rather than hidden, because
 * every percentage on the page is divided by this number. A silent fallback to
 * a stale constant would skew every published share with no way to notice.
 */
async function readTotalSupply(
  chain: ChainKey,
): Promise<{ supply: bigint; source: "onchain" | "pinned" }> {
  const cfg = CHAINS[chain];
  try {
    const client = createPublicClient({ transport: http(cfg.rpcUrl) });
    const supply = await client.readContract({
      address: cfg.token.address,
      abi: ERC20_ABI,
      functionName: "totalSupply",
    });
    if (typeof supply === "bigint" && supply > 0n) return { supply, source: "onchain" };
  } catch {
    /* fall through to the pinned constant */
  }
  return { supply: cfg.token.totalSupply, source: "pinned" };
}

// ─── Aggregation ─────────────────────────────────────────────────────────────

/**
 * Group by wallet and sum. Exported so `scripts/pledge-ledger-test.ts` can
 * assert the invariant directly against synthetic transfers — the live ledger
 * is empty until someone pledges, and a suite that only passes on an empty set
 * proves nothing about the arithmetic.
 *
 * No de-duplication happens here, deliberately. The two producers can't emit
 * the same transfer twice — indexer pages advance by cursor, and the RPC
 * bisect splits into disjoint ranges (`from..mid`, `mid+1..to`) — while a
 * de-dupe key built from (hash, from, value) WOULD collapse two genuine
 * identical transfers made in a single transaction. Between a duplicate that
 * cannot occur and a real pledge silently halved, this is the safe side.
 */
export function aggregate(txs: PledgeTx[], chain: ChainKey, supply: bigint): WalletPledge[] {
  const cfg = CHAINS[chain];
  const byWallet = new Map<string, PledgeTx[]>();

  for (const t of txs) {
    const key = t.wallet.toLowerCase();
    const list = byWallet.get(key);
    if (list) list.push(t);
    else byWallet.set(key, [t]);
  }

  const out: WalletPledge[] = [];
  for (const list of byWallet.values()) {
    const total = list.reduce((sum, t) => sum + BigInt(t.amount), 0n);
    out.push({
      wallet: list[0].wallet,
      chain,
      totalAmount: total.toString(),
      totalFormatted: formatAmount(total, cfg.token.decimals),
      pctOfSupply: pctOfSupply(total, supply),
      txCount: list.length,
      txs: list
        .slice()
        .sort((a, b) => b.blockNumber - a.blockNumber)
        .map((t) => ({ txHash: t.txHash, timestamp: t.timestamp, amount: t.amount })),
    });
  }

  // Largest first — the ledger is read top-down and the big pledges are the
  // ones people cross-check against the explorer.
  return out.sort((a, b) => (BigInt(b.totalAmount) > BigInt(a.totalAmount) ? 1 : -1));
}

function emptySummary(chain: ChainKey, supply: bigint, source: "onchain" | "pinned"): ChainSummary {
  const cfg = CHAINS[chain];
  return {
    chain,
    label: cfg.label,
    shortLabel: cfg.shortLabel,
    tokenAddress: cfg.token.address,
    symbol: cfg.token.symbol,
    decimals: cfg.token.decimals,
    totalSupply: supply.toString(),
    supplySource: source,
    totalPledged: "0",
    totalFormatted: "0",
    pctOfSupply: 0,
    walletCount: 0,
    txCount: 0,
    source: "none",
    status: "ok",
  };
}

// ─── Snapshot build ──────────────────────────────────────────────────────────

/**
 * Read both chains and assemble a snapshot.
 *
 * `prev` is the last good snapshot, and it is what makes a failed chain read
 * survivable: that chain keeps its previous numbers and previous wallet rows,
 * flipped to `status: "degraded"` with the error attached. The alternative —
 * zeroing a chain because an indexer timed out — publishes "your pledge is
 * gone" to every holder on it.
 *
 * Never throws. A total failure is expressed in the returned data, not by
 * blowing up the caller.
 */
export async function buildSnapshot(prev: LedgerSnapshot | null): Promise<LedgerSnapshot> {
  const chains = {} as Record<ChainKey, ChainSummary>;
  const wallets: WalletPledge[] = [];

  await Promise.all(
    CHAIN_KEYS.map(async (chain) => {
      const cfg = CHAINS[chain];
      const [{ supply, source: supplySource }, result] = await Promise.all([
        readTotalSupply(chain),
        fetchChainTransfers(chain),
      ]);

      if (!result.ok) {
        // Carry the last known numbers forward, labelled as old.
        const before = prev?.chains[chain];
        chains[chain] = before
          ? { ...before, supplySource, totalSupply: supply.toString(), status: "degraded", error: result.error }
          : { ...emptySummary(chain, supply, supplySource), status: "degraded", error: result.error };
        for (const w of prev?.wallets ?? []) if (w.chain === chain) wallets.push(w);
        return;
      }

      const chainWallets = aggregate(result.txs, chain, supply);
      const totalPledged = result.txs.reduce((sum, t) => sum + BigInt(t.amount), 0n);

      chains[chain] = {
        ...emptySummary(chain, supply, supplySource),
        totalPledged: totalPledged.toString(),
        totalFormatted: formatAmount(totalPledged, cfg.token.decimals),
        pctOfSupply: pctOfSupply(totalPledged, supply),
        walletCount: chainWallets.length,
        txCount: result.txs.length,
        source: result.source,
        status: "ok",
        truncated: result.truncated || undefined,
      };
      wallets.push(...chainWallets);
    }),
  );

  wallets.sort((a, b) => (BigInt(b.totalAmount) > BigInt(a.totalAmount) ? 1 : -1));

  return {
    updatedAt: Date.now(),
    degraded: CHAIN_KEYS.some((c) => chains[c].status === "degraded"),
    stale: false,
    staleAgeS: 0,
    receivingWallet: RECEIVING_WALLET,
    deadlineIso: PLEDGE_DEADLINE_ISO,
    allocationAnnounced: ALLOCATION_ANNOUNCED,
    chains,
    wallets,
  };
}

// ─── Cached read ─────────────────────────────────────────────────────────────

/**
 * `allocationAnnounced` is re-stamped from config on every read, never trusted
 * from the cached copy. It is a policy flag, not a measurement: a snapshot
 * written a week ago must not keep publishing shares after the flag is turned
 * off, nor keep hiding them for a week after it is turned on.
 */
function withStaleness(snap: LedgerSnapshot, stale: boolean): LedgerSnapshot {
  const ageS = Math.max(0, Math.round((Date.now() - snap.updatedAt) / 1000));
  return { ...snap, stale, staleAgeS: ageS, allocationAnnounced: ALLOCATION_ANNOUNCED };
}

/**
 * The ledger, cached.
 *
 * Order of preference, and each fallback is disclosed rather than silent:
 *   1. a snapshot younger than 60s → serve as-is
 *   2. otherwise rebuild — but only one request at a time (`kvSetNX` lock), so
 *      a burst of traffic does not fan out into N identical indexer scans
 *   3. a rebuild we didn't win the lock for → serve the old snapshot, `stale`
 *   4. nothing cached at all → build regardless of the lock, because a first
 *      visitor must not be shown an empty ledger just to save a duplicate read
 */
export async function getLedger(opts?: { force?: boolean }): Promise<LedgerSnapshot> {
  const probe = await kvGetProbe<LedgerSnapshot>(SNAPSHOT_KEY);
  const cached = probe.status === "hit" ? probe.value : null;
  const fresh = cached !== null && Date.now() - cached.updatedAt < FRESH_MS;

  if (cached && fresh && !opts?.force) return withStaleness(cached, false);

  // Only one builder at a time — unless there is nothing to serve, in which
  // case correctness of the first render beats deduplicating the work.
  const wonLock = await kvSetNX(REFRESH_LOCK_KEY, Date.now(), REFRESH_LOCK_S);
  if (!wonLock && cached) return withStaleness(cached, true);

  const snap = await buildSnapshot(cached);

  // A build where every chain failed is worse than the snapshot we already had:
  // it carries the same numbers but loses the record of when they were true.
  const allFailed = CHAIN_KEYS.every((c) => snap.chains[c].status === "degraded");
  if (allFailed && cached) return withStaleness({ ...cached, degraded: true }, true);

  await kvSet(SNAPSHOT_KEY, snap, SNAPSHOT_TTL_S);
  return withStaleness(snap, false);
}

// ─── Lookup ──────────────────────────────────────────────────────────────────

export interface WalletLookup {
  address: string;
  found: boolean;
  /** One entry per chain the wallet pledged on. Percentages are NOT summed. */
  entries: WalletPledge[];
  updatedAt: number;
  stale: boolean;
  degraded: boolean;
}

/**
 * Everything one address pledged, per chain.
 *
 * Deliberately returns no combined "total share" number. The source app added
 * `pctOfSupply` across chains into a single `totalSharePct`, which adds two
 * fractions with different denominators (100e9 vs 1e9 tokens) — a holder with
 * 1% of each chain would be told they hold 2% of something that doesn't exist.
 * Per-chain rows are the only honest presentation until the two supplies are
 * reconciled into one allocation table.
 */
export function lookupWallet(snap: LedgerSnapshot, address: string): WalletLookup {
  const normalized = isAddress(address) ? getAddress(address) : address;
  const target = normalized.toLowerCase();
  const entries = snap.wallets.filter((w) => w.wallet.toLowerCase() === target);
  return {
    address: normalized,
    found: entries.length > 0,
    entries,
    updatedAt: snap.updatedAt,
    stale: snap.stale,
    degraded: snap.degraded,
  };
}
