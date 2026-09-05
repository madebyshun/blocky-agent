import type { Metadata } from "next";
import ClaimClient from "./ClaimClient";

export const metadata: Metadata = {
  title: "B20HUB — Claim Creator Fees",
  description:
    "Claim your 80% creator fees from any B20HUB pool. Permissionless — anyone can trigger the split; the 80/15/5 recipients are hard-coded.",
};

export default function B20HUBClaimPage() {
  return <ClaimClient />;
}
