import type { Metadata } from "next";
import ComingSoon from "../_ComingSoon";

// Reserved URL — the automation surface (DCA, TP/SL, recurring buys via scoped
// session keys). Noindex until it ships.
export const metadata: Metadata = {
  title: "Tasks — BlueAgent",
  robots: { index: false, follow: false },
};

export default function Page() {
  return (
    <ComingSoon
      label="TASKS"
      title="Tasks"
      blurb="Automated strategies — DCA, TP/SL, recurring buys — via scoped session keys."
    />
  );
}
