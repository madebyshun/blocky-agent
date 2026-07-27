import { redirect } from "next/navigation";

// Staking UI lives in the unified dashboard as the Stake tab. This is the
// MAIN-host stub (blueagent.dev/rewards + localhost), so it targets the
// /app-prefixed internal path and lets middleware 301 it over to
// app.blueagent.dev/dashboard — collapsing the old /rewards → /app/rewards →
// /dashboard double-hop (0.1 route consolidation).
export default function RewardsRedirect() {
  redirect("/app/dashboard?tab=stake");
}
