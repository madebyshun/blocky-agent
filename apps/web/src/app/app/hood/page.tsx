/**
 * /hood — Blue Hood public terminal.
 *
 * Oracle-vs-DEX drift signals for tokenized stocks on Base (Coinbase B20)
 * and Robinhood Chain — every call graded in public. Public read-only —
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
  title: "Blue Hood · Oracle-vs-DEX signals for tokenized stocks",
  description:
    "Live drift board for tokenized stocks on Base (Coinbase B20) and Robinhood Chain. Chainlink oracle vs DEX pool spot, market-hours aware, every call graded in public — misses included. Non-custodial.",
  openGraph: {
    title: "Blue Hood · Oracle-vs-DEX signals for tokenized stocks",
    description:
      "Chainlink oracle vs DEX drift on Base & Robinhood Chain. Every call graded in public — misses included.",
  },
};

// AppShell keeps the header + rail alive; this shell just declares the
// route as fully dynamic so the client's fetch loop reads fresh KV.
export const revalidate = 0;
export const dynamic = "force-dynamic";

export default function HoodPage() {
  return <HoodClient />;
}
