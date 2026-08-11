/**
 * /hood — Blue Hood public terminal.
 *
 * 24/7 onchain copilot for Robinhood Chain RWA tokens. Public read-only —
 * no auth required. Wrapped by /app/layout AppShell so the sidebar +
 * mobile drawer render consistently with Chat / Hub / Launches.
 *
 * Data path: this page NEVER calls x402 tools directly. It reads from the
 * KV snapshot the poller writes (see /api/cron/blue-hood/poll). Zero cost
 * per page-view even under a Reddit hug.
 */
import type { Metadata } from "next";
import HoodClient from "./HoodClient";

export const metadata: Metadata = {
  title: "Blue Hood · 24/7 copilot for Robinhood Chain",
  description:
    "Live drift board for 24 tokenized-stock tokens on Robinhood Chain. Chainlink oracle vs DEX pool spot, market-hours aware, arrows every 60s. Non-custodial.",
  openGraph: {
    title: "Blue Hood · 24/7 copilot for Robinhood Chain",
    description:
      "Chainlink oracle vs DEX. 24 RWA tokens. 30 x402 skills under the hood.",
  },
};

// AppShell keeps the header + rail alive; this shell just declares the
// route as fully dynamic so the client's fetch loop reads fresh KV.
export const revalidate = 0;
export const dynamic = "force-dynamic";

export default function HoodPage() {
  return <HoodClient />;
}
