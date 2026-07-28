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
 */
"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { useAccount } from "wagmi";
import type { Watchlist, WatchEntry, AlertKind } from "@/lib/blue-hood/watchlist";

/** Result of an add/remove — carries the server's reason so the UI can show a cap/validation message. */
export type WatchlistMutation = { ok: true } | { ok: false; error: string; code?: string };

type WatchlistState = {
  /** The connected wallet's list, or null when disconnected / before first load. */
  watchlist: Watchlist | null;
  /** true until the first fetch for the current address resolves. */
  loading: boolean;
  /** Convenience: is this ticker currently watched? */
  isWatching: (ticker: string) => boolean;
  add: (ticker: string, kinds?: AlertKind[]) => Promise<WatchlistMutation>;
  remove: (ticker: string) => Promise<WatchlistMutation>;
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
    async (ticker: string, kinds?: AlertKind[]): Promise<WatchlistMutation> => {
      if (!address) return { ok: false, error: "connect a wallet first" };
      try {
        const res = await fetch("/api/hood/watchlist", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ address, ticker, kinds }),
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
    async (ticker: string): Promise<WatchlistMutation> => {
      if (!address) return { ok: false, error: "connect a wallet first" };
      try {
        const res = await fetch("/api/hood/watchlist", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ address, ticker }),
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
    (ticker: string) => {
      const T = ticker.trim().toUpperCase();
      return !!watchlist?.entries.some((e: WatchEntry) => e.ticker === T);
    },
    [watchlist],
  );

  return (
    <WatchlistContext.Provider value={{ watchlist, loading, isWatching, add, remove, refresh }}>
      {children}
    </WatchlistContext.Provider>
  );
}
