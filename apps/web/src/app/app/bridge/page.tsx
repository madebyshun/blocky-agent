import type { Metadata } from "next";
import ComingSoon from "../_ComingSoon";

// Reserved URL — clean entry point into the bridge flow. Per the shell
// blueprint Bridge is a component within Wallet + onboarding, but the clean
// /bridge URL is worth reserving as a deep-link target (shares the component).
// Noindex until it ships.
export const metadata: Metadata = {
  title: "Bridge — BlueAgent",
  robots: { index: false, follow: false },
};

export default function Page() {
  return (
    <ComingSoon
      label="BRIDGE"
      title="Bridge"
      blurb="Move USDC/USDG between Base and Robinhood Chain."
    />
  );
}
