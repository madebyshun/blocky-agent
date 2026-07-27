import type { Metadata } from "next";
import ComingSoon from "../_ComingSoon";

// Reserved URL — the WalletProvider surface (balances, $BLUE tier, bridge).
// Noindex until it ships.
export const metadata: Metadata = {
  title: "Wallet — BlueAgent",
  robots: { index: false, follow: false },
};

export default function Page() {
  return (
    <ComingSoon
      label="WALLET"
      title="Wallet"
      blurb="Non-custodial balances, $BLUE tier, and one-tap bridge — Base ↔ Robinhood Chain."
    />
  );
}
