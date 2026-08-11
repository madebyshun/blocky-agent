/**
 * /track — Blue Hood PUBLIC track record.
 *
 * The proof page. No wallet, no login, indexable — the opposite of the in-app
 * /hood/arrows twin (which lives behind the app shell). Server component reads
 * the SAME gated payload the 0.2 ACP endpoint returns (via the shared
 * `getPublicTrackRecord` assembler — one source of truth, no drift) and hands
 * it to the <TrackView> client island for filter/sort interactivity.
 *
 * HONESTY / GATE: the headline hit-rate passes through hit-rate-gate.ts. Below
 * the 30-sample threshold the page shows "warming up · N graded · M needed" and
 * NO percentage — not even a hits/misses tally a reader could divide. The
 * per-arrow evidence table (every HIT/MISS/VOID) is always shown: that's the
 * receipts, and showing misses is the whole differentiator.
 *
 * Canonical home is the main host (blueagent.dev/track); the app subdomain 301s
 * here (see middleware). ISR 60s — a track record is append-only and slow.
 */
import type { Metadata } from "next";
import Navbar from "@/components/Navbar";
import { getPublicTrackRecord } from "@/lib/blue-hood/track-record-public";
import TrackView from "./TrackView";

export const revalidate = 60;

const TITLE = "Blue Hood — public track record";
const DESC =
  "Every Chainlink-vs-DEX signal on Robinhood Chain, graded — misses included. Blue Hood publishes its full receipt book; the hit rate stays hidden until the sample earns it.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESC,
  // Unlike the /app surface, this page WANTS to be indexed — it's the proof.
  robots: { index: true, follow: true },
  alternates: { canonical: "https://blueagent.dev/track" },
  openGraph: {
    title: TITLE,
    description: "Every signal graded · misses included · verified on Robinhood Chain.",
    url: "https://blueagent.dev/track",
    siteName: "Blue Agent",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: "Every signal graded · misses included.",
  },
};

export default async function TrackPage() {
  const record = await getPublicTrackRecord(200);
  return (
    <div className="min-h-screen bg-[#050508] text-white">
      <Navbar />
      <TrackView record={record} />
    </div>
  );
}
