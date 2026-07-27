import type { Metadata } from "next";
import ComingSoon from "../_ComingSoon";

// Reserved URL — the ExecutionProvider surface (guarded swap engine). Absorbs
// the old /robinhood-router flow. Noindex until it ships.
export const metadata: Metadata = {
  title: "Trade — BlueAgent",
  robots: { index: false, follow: false },
};

export default function Page() {
  return (
    <ComingSoon
      label="TRADE"
      title="Trade"
      blurb="Execute drift & arbitrage arrows with the same guarded engine Blue Hood grades in public."
    />
  );
}
