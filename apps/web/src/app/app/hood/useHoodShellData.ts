"use client";

/**
 * Blue Hood — shared shell data hook.
 *
 * Fetches the 3 data streams the shell's sidebar needs (snapshot for
 * watchlist + market clock, arrows for RECENT ARROWS strip, inbox
 * last-read for the unread badge). Each of /hood, /hood/inbox,
 * /hood/arrows calls this hook so the sidebar is always populated,
 * even on pages that don't otherwise care about the snapshot.
 *
 * Not a context: called by the leaf page component and the returned
 * bundle is passed to `<HoodShellFrame>` as props. Simpler than a
 * provider tree for the 3-page section.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Arrow, HoodSnapshot } from "@/lib/blue-hood/types";

const REFRESH_MS = 15_000;
const AMBER = "#f5b342";
const GREEN_TEXT = "#22c55e";
const MUTED = "#6b7280";

type SnapshotRes =
  | { ok: true; snapshot: HoodSnapshot }
  | { ok: false; error: string };

type ArrowsRes =
  | { ok: true; arrows: Arrow[] }
  | { ok: false; error: string };

type LastReadRes = { ok: true; last_read_at: string | null } | { ok: false };

export interface HoodShellData {
  snap: HoodSnapshot | null;
  arrows: Arrow[] | null;
  marketLabel: string;
  marketColor: string;
  inboxUnread: number;
  err: string | null;
}

export function useHoodShellData(): HoodShellData {
  const [snap, setSnap] = useState<HoodSnapshot | null>(null);
  const [arrows, setArrows] = useState<Arrow[] | null>(null);
  const [inboxLastRead, setInboxLastRead] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const [s, a, lr] = await Promise.all([
        fetch("/api/hood/snapshot", { cache: "no-store", signal }).then(
          (r) => r.json() as Promise<SnapshotRes>,
        ),
        fetch("/api/hood/arrows", { cache: "no-store", signal }).then(
          (r) => r.json() as Promise<ArrowsRes>,
        ),
        (async (): Promise<LastReadRes> => {
          try {
            const r = await fetch("/api/hood/inbox/last-read", {
              cache: "no-store",
              signal,
            });
            if (!r.ok) return { ok: false };
            return (await r.json()) as { ok: true; last_read_at: string | null };
          } catch {
            return { ok: false };
          }
        })(),
      ]);
      if (s.ok) {
        setSnap(s.snapshot);
        setErr(null);
      } else {
        setErr(s.error);
      }
      if (a.ok) setArrows(a.arrows);
      if (lr.ok) setInboxLastRead(lr.last_read_at);
    } catch (e) {
      if ((e as Error).name !== "AbortError") setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    const ctl = new AbortController();
    load(ctl.signal);
    const t = setInterval(() => load(ctl.signal), REFRESH_MS);
    return () => {
      ctl.abort();
      clearInterval(t);
    };
  }, [load]);

  const marketLabel = useMemo(() => {
    if (!snap) return "…";
    const { market_is_open, market_session } = snap.metrics;
    if (market_is_open) return "NYSE OPEN";
    if (market_session === "premarket") return "PREMARKET";
    if (market_session === "afterhours") return "AFTER HOURS";
    if (market_session === "weekend") return "WEEKEND · CLOSED";
    if (market_session === "holiday") return "HOLIDAY · CLOSED";
    return "MARKET CLOSED";
  }, [snap]);

  const marketColor = useMemo(() => {
    if (!snap) return MUTED;
    const { market_is_open, market_session } = snap.metrics;
    if (market_is_open) return GREEN_TEXT;
    if (market_session === "premarket") return AMBER;
    if (market_session === "afterhours") return AMBER;
    return MUTED;
  }, [snap]);

  const inboxUnread = useMemo(() => {
    if (!arrows) return 0;
    const cutoff = inboxLastRead ? new Date(inboxLastRead).getTime() : 0;
    return arrows.filter((a) => new Date(a.fired_at).getTime() > cutoff).length;
  }, [arrows, inboxLastRead]);

  return { snap, arrows, marketLabel, marketColor, inboxUnread, err };
}
