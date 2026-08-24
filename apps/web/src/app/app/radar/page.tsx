import type { Metadata } from "next";
import ComingSoon from "../_ComingSoon";

// Reserved URL — the WatchlistProvider surface (drift/arbitrage discovery)
// lands here. Noindex until it ships.
export const metadata: Metadata = {
  title: "Radar — BlueAgent",
  robots: { index: false, follow: false },
};

export default function Page() {
  return (
    <ComingSoon
      label="RADAR"
      title="Radar"
      blurb="Live watchlist + drift/arbitrage discovery across tokenized stocks on Base and Robinhood Chain."
    />
  );
}
