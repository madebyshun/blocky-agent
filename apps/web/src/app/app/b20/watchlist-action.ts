"use server";

/**
 * Server actions — B20 watchlist (per-wallet, KV-backed).
 *
 * Storage: `b20:watch:{wallet}` → WatchItem[] (one row per owner wallet).
 * Reads/writes run server-side so viem + KV creds stay in Node.js. Following the
 * existing per-wallet KV convention in this repo (see credit-ledger), the
 * watchlist is keyed by the connected wallet address without a signature — it is
 * low-stakes, read-only monitoring data.
 *
 * Change detection is pull-based: listWatch re-inspects every watched token live
 * and diffs against the stored snapshot. No cron, no push — zero new infra.
 */

import { kvGet, kvSet, kvMutate } from "@/lib/kv";
import { inspectB20 } from "@/lib/b20/inspect";
import {
  snapshotFromInspection,
  diffSnapshot,
  type WatchItem,
  type WatchEntryStatus,
} from "@/lib/b20/watchlist";

type Network = "mainnet" | "sepolia";

const MAX_WATCH = 25;                 // cap watched tokens per wallet
const ADDR_RE   = /^0x[a-fA-F0-9]{40}$/;

const EXPLORER: Record<Network, string> = {
  mainnet: "https://basescan.org",
  sepolia: "https://sepolia.basescan.org",
};

const key = (wallet: string) => `b20:watch:${wallet.toLowerCase()}`;

/**
 * Rows are written as a JSON string (see `save`), but @vercel/kv sometimes hands
 * one back already deserialized — so both shapes have to be tolerated on read.
 */
function parseItems(raw: WatchItem[] | string | null | undefined): WatchItem[] {
  if (!raw) return [];
  if (typeof raw === "string") {
    try { return JSON.parse(raw) as WatchItem[]; } catch { return []; }
  }
  return Array.isArray(raw) ? raw : [];
}

async function load(wallet: string): Promise<WatchItem[]> {
  return parseItems(await kvGet<WatchItem[] | string>(key(wallet)));
}

async function save(wallet: string, items: WatchItem[]): Promise<void> {
  await kvSet(key(wallet), JSON.stringify(items.slice(0, MAX_WATCH)));
}

function explorerUrl(network: Network, token: string): string {
  return `${EXPLORER[network]}/token/${token}`;
}

/**
 * Re-inspect every watched token and diff against its stored snapshot.
 * Inspect failures degrade gracefully (unavailable: true, last-known shown).
 */
export async function listWatch(wallet: string): Promise<WatchEntryStatus[]> {
  if (!ADDR_RE.test(wallet)) return [];
  const items = await load(wallet);
  if (items.length === 0) return [];

  return Promise.all(
    items.map(async (item): Promise<WatchEntryStatus> => {
      try {
        const info = await inspectB20(item.address, item.network);
        if (!info.isB20) {
          return { item, changes: [], isB20: false, explorerUrl: explorerUrl(item.network, item.address) };
        }
        const live    = snapshotFromInspection(info);
        const changes = diffSnapshot(item.snapshot, live);
        return { item, live, changes, isB20: true, explorerUrl: info.explorerUrl };
      } catch {
        return { item, changes: [], isB20: true, unavailable: true, explorerUrl: explorerUrl(item.network, item.address) };
      }
    }),
  );
}

/**
 * Add a token to the wallet's watchlist. Validates it is a real B20, captures
 * the baseline snapshot, dedups by address+network. Returns the refreshed list.
 *
 * `list: null` means "could not read the store" — the caller must keep whatever
 * it is already showing rather than render an empty watchlist.
 */
export async function addWatch(
  wallet:  string,
  token:   string,
  network: Network,
  label?:  string,
): Promise<{ ok: boolean; error?: string; list: WatchEntryStatus[] | null }> {
  if (!ADDR_RE.test(wallet)) return { ok: false, error: "Connect a wallet first.", list: [] };
  if (!ADDR_RE.test(token))  return { ok: false, error: "Invalid token address.", list: await listWatch(wallet) };

  const addr = token.toLowerCase();

  // On-chain validation runs BEFORE the KV read/write. The old order (read →
  // inspect → write) held a stale snapshot of the row across a slow RPC
  // round-trip, which is precisely the window another tab's add can be lost in.
  const info = await inspectB20(addr, network).catch(() => null);
  if (!info) {
    return { ok: false, error: "Could not read the token on-chain. Try again.", list: await listWatch(wallet) };
  }
  if (!info.isB20) {
    return { ok: false, error: `Not a B20 token on Base ${network}.`, list: await listWatch(wallet) };
  }

  // #150 A-part2 — the dedup/cap read and the write were the same key. A
  // throttled read returned `[]`, so the dedup found nothing, the cap check
  // passed, and the write replaced up to 24 other watched tokens with this one.
  // The user's only symptom is a watchlist that quietly got shorter.
  //
  // Dedup and cap now live INSIDE the mutate so they are decided against the
  // value actually being written, and kvMutate declines to write at all when
  // the read failed.
  let rejection: string | null = null;

  const res = await kvMutate<WatchItem[] | string>(key(wallet), [], (raw) => {
    const items = parseItems(raw);
    if (items.some(i => i.address === addr && i.network === network)) {
      rejection = "Already on your watchlist.";
      return null;
    }
    if (items.length >= MAX_WATCH) {
      rejection = `Watchlist is full (max ${MAX_WATCH}).`;
      return null;
    }
    const now: number = Date.now();
    const next: WatchItem[] = [
      {
        address:    addr,
        network,
        label:      label?.trim() ? label.trim().slice(0, 40) : undefined,
        name:       info.name,
        symbol:     info.symbol,
        addedAt:    now,
        snapshot:   snapshotFromInspection(info),
        snapshotAt: now,
      },
      ...items,
    ];
    return JSON.stringify(next.slice(0, MAX_WATCH));
  });

  if (res === "skipped" || res === "failed") {
    // Never say "added" for a write we may not have made, and never hand back
    // an empty list as if that were the user's watchlist.
    return { ok: false, error: "Watchlist store unavailable — nothing was added. Retry shortly.", list: null };
  }
  if (rejection) {
    return { ok: false, error: rejection, list: await listWatch(wallet) };
  }
  return { ok: true, list: await listWatch(wallet) };
}

/** Remove a token from the wallet's watchlist. Returns the refreshed list. */
export async function removeWatch(
  wallet:  string,
  token:   string,
  network: Network,
): Promise<WatchEntryStatus[]> {
  if (!ADDR_RE.test(wallet)) return [];
  const items = await load(wallet);
  const addr  = token.toLowerCase();
  const next  = items.filter(i => !(i.address === addr && i.network === network));
  if (next.length !== items.length) await save(wallet, next);
  return listWatch(wallet);
}

/**
 * Acknowledge a token's changes: re-capture the live state as the new baseline
 * so its diff resets to "in sync". Returns the refreshed list.
 */
export async function ackWatch(
  wallet:  string,
  token:   string,
  network: Network,
): Promise<WatchEntryStatus[]> {
  if (!ADDR_RE.test(wallet)) return [];
  const items = await load(wallet);
  const addr  = token.toLowerCase();
  const idx   = items.findIndex(i => i.address === addr && i.network === network);
  if (idx === -1) return listWatch(wallet);

  try {
    const info = await inspectB20(addr, network);
    if (info.isB20) {
      items[idx] = {
        ...items[idx],
        name:       info.name ?? items[idx].name,
        symbol:     info.symbol ?? items[idx].symbol,
        snapshot:   snapshotFromInspection(info),
        snapshotAt: Date.now(),
      };
      await save(wallet, items);
    }
  } catch {
    /* leave snapshot unchanged on failure — never ack to a state we couldn't read */
  }
  return listWatch(wallet);
}
