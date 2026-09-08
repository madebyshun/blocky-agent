/**
 * Blue Hood — per-user alert watchlist context (task 1.7, the "Provider").
 *
 * A CLIENT-SIDE CACHE over the /api/hood/watchlist routes — never a second copy
 * of the rules. The server (lib/blue-hood/watchlist.ts) owns validation, the
 * cap policy, and the symmetric reverse-index write; this context just holds the
 * current wallet's list for the UI and forwards mutations. The Telegram bot and
 * the alert cron read the SAME KV via that lib, so web and bot never diverge.
 *
 * DELIBERATELY NO POLL LOOP. A wallet's watchlist only changes when THIS user
 * edits it, so we fetch once per connected address and then trust the list the
 * server echoes back on each mutation. That keeps 1.7 from adding a recurring
 * hot read — the exact KV-budget discipline the 2026-07-27 Upstash-cap outage
 * demanded (and that HealthProvider 1.3 now watches for).
 *
 * Not mounted by default: wire <WatchlistProvider> in only on a surface that
 * actually renders the list, so an idle /hood view never pays for a read it
 * doesn't use.
 *
 * ⚠️ EVERY METHOD TAKES A CHAIN, AND NONE OF THEM DEFAULTS IT. A watch is
 * (ticker, chain): the board lists NVDA twice — once on Robinhood Chain, once on
 * Base — as different contracts. While these took a bare ticker, ★ on the Base
 * NVDA row reported the RH star's state, wrote the RH subscription, and un-★
 * removed the RH one. Nothing errored; the user simply got a different desk's
 * alerts. The chain is right there in the row (`chainOf(r)`), so requiring it
 * costs a call site nothing and makes the silent version unwritable.
 */
"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { useAccount } from "wagmi";
import type { Watchlist, WatchEntry, AlertKind } from "@/lib/blue-hood/watchlist";
import { rowKey, type HoodChain } from "@/lib/blue-hood/types";

/** Result of an add/remove — carries the server's reason so the UI can show a cap/validation message. */
export type WatchlistMutation = { ok: true } | { ok: false; error: string; code?: string };

type WatchlistState = {
  /** The connected wallet's list, or null when disconnected / before first load. */
  watchlist: Watchlist | null;
  /** true until the first fetch for the current address resolves. */
  loading: boolean;
  /** Convenience: is this ticker watched ON THIS CHAIN? Both args required. */
  isWatching: (ticker: string, chain: HoodChain) => boolean;
  add: (ticker: string, chain: HoodChain, kinds?: AlertKind[]) => Promise<WatchlistMutation>;
  remove: (ticker: string, chain: HoodChain) => Promise<WatchlistMutation>;
  refresh: () => Promise<void>;
};

const noop = async (): Promise<WatchlistMutation> => ({ ok: false, error: "connect a wallet first" });

const WatchlistContext = createContext<WatchlistState>({
  watchlist: null,
  loading: false,
  isWatching: () => false,
  add: noop,
  remove: noop,
  refresh: async () => {},
});

/** Subscribe to the connected wallet's alert watchlist. */
export function useWatchlist(): WatchlistState {
  return useContext(WatchlistContext);
}

export function WatchlistProvider({ children }: { children: React.ReactNode }) {
  const { address } = useAccount();
  const [watchlist, setWatchlist] = useState<Watchlist | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!address) {
      setWatchlist(null);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/hood/watchlist?address=${address}`, { cache: "no-store" });
      const body = (await res.json()) as { ok: boolean; watchlist?: Watchlist };
      // A failed read leaves the last-known list rather than nuking the UI to
      // empty — an unreadable KV shouldn't look like "you watch nothing".
      if (body.ok && body.watchlist) setWatchlist(body.watchlist);
    } catch {
      /* keep last-known; a transient fetch failure is not "empty watchlist" */
    } finally {
      setLoading(false);
    }
  }, [address]);

  // Fetch once per connected address. No interval — see file header.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const add = useCallback(
    async (ticker: string, chain: HoodChain, kinds?: AlertKind[]): Promise<WatchlistMutation> => {
      if (!address) return { ok: false, error: "connect a wallet first" };
      try {
        const res = await fetch("/api/hood/watchlist", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ address, ticker, chain, kinds }),
        });
        const body = (await res.json()) as { ok: boolean; watchlist?: Watchlist; error?: string; code?: string };
        if (!body.ok) return { ok: false, error: body.error ?? "could not add", code: body.code };
        if (body.watchlist) setWatchlist(body.watchlist); // server echo = source of truth
        return { ok: true };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    [address],
  );

  const remove = useCallback(
    async (ticker: string, chain: HoodChain): Promise<WatchlistMutation> => {
      if (!address) return { ok: false, error: "connect a wallet first" };
      try {
        const res = await fetch("/api/hood/watchlist", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          // Same `chain` the add sent — an asymmetric remove leaves the reverse
          // set populated and the DMs keep coming after the ★ goes dark.
          body: JSON.stringify({ address, ticker, chain }),
        });
        const body = (await res.json()) as { ok: boolean; watchlist?: Watchlist; error?: string; code?: string };
        if (!body.ok) return { ok: false, error: body.error ?? "could not remove", code: body.code };
        if (body.watchlist) setWatchlist(body.watchlist);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    [address],
  );

  const isWatching = useCallback(
    (ticker: string, chain: HoodChain) => {
      // `rowKey` on BOTH sides — the stored entry's `chain` is absent on records
      // written before the Base desk, and `rowKey` runs `chainOf`, so those
      // resolve to the Robinhood key exactly as they always did.
      const key = rowKey({ ticker: ticker.trim().toUpperCase(), chain });
      return !!watchlist?.entries.some((e: WatchEntry) => rowKey(e) === key);
    },
    [watchlist],
  );

  return (
    <WatchlistContext.Provider value={{ watchlist, loading, isWatching, add, remove, refresh }}>
      {children}
    </WatchlistContext.Provider>
  );
}
