"use client";

/**
 * Blue Hood — shared shell frame (sidebar + full-width main content).
 *
 * Before this: only /hood rendered <HoodSidebar>; /hood/inbox and
 * /hood/arrows were sidebar-less. The section felt inconsistent —
 * you'd get the WATCHLIST + RECENT ARROWS on the drift board but
 * lose them on the two views arrows actually LIVE in.
 *
 * Now every /hood/* page renders the same shell shape:
 *   [ 288px HoodSidebar ][ flex-1 full-width main ]
 *
 * The main content area uses `max-w-7xl` (not the old `max-w-5xl`)
 * so the drift board / inbox / track record tables use the width
 * that's actually there — matching the Virtuals-style full-width
 * data table look the user asked for (screenshot 34).
 *
 * State ownership: this component is a pure JSX shell. Callers own
 * the sidebar-driving data (snap, arrows, marketBadge, unread) and
 * pass them in. Fetching lives in `useHoodShellData()` so each page
 * can call it once and reuse for BOTH sidebar + main content.
 */

import type { ReactNode } from "react";
import type { Arrow, HoodSnapshot } from "@/lib/blue-hood/types";
import HoodSidebar from "./HoodSidebar";

const BG = "#050508";

export interface HoodShellProps {
  snap: HoodSnapshot | null;
  arrows: Arrow[] | null;
  marketLabel: string;
  marketColor: string;
  /** Callback for sidebar's WATCHLIST row click. On /hood this scrolls
   *  to the ticker's drift-board row; on /hood/inbox and /hood/arrows
   *  it should navigate to `/hood#{ticker}` (the sidebar-first UX). */
  onSelectTicker: (ticker: string) => void;
  /** Unread arrow count for the Inbox nav badge. Optional; 0 = no badge. */
  inboxUnread?: number;
  children: ReactNode;
}

export default function HoodShellFrame({
  snap,
  arrows,
  marketLabel,
  marketColor,
  onSelectTicker,
  inboxUnread = 0,
  children,
}: HoodShellProps) {
  return (
    <div
      // `h-full flex flex-row` — was `flex-1 min-h-0 flex flex-row` which
      // didn't fill height because the parent `.hood-section h-full` is
      // NOT a flex container. Effect: content overflowing the viewport
      // was clipped, not scrollable — user reported "no scroll on hood,
      // content below the fold unreadable" (2026-07-23). Now the shell
      // fills the AppShell main region and inner overflow-y-auto works.
      className="h-full flex flex-row"
      style={{ backgroundColor: BG, color: "#E7E9EE" }}
    >
      <HoodSidebar
        snap={snap}
        arrows={arrows}
        marketLabel={marketLabel}
        marketColor={marketColor}
        onSelectTicker={onSelectTicker}
        inboxUnread={inboxUnread}
      />
      <div className="flex-1 min-w-0 overflow-y-auto hood-scroll">
        {/* Full-width — no max-w cap. The drift board's 8-col table +
            Virtuals-style track record table are dense and want the
            full viewport width. Padding is generous on lg+ so it
            doesn't feel edge-to-edge on ultra-wide monitors. */}
        <div className="w-full px-4 py-6 md:px-8 md:py-8 xl:px-12">
          {children}
        </div>
      </div>
    </div>
  );
}
