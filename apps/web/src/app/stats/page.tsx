/**
 * /stats — public traction page.
 *
 * Server component: reads the sanitized aggregate from buildPublicStats() (no
 * per-user data), then hands it to the <StatsView> client island which renders
 * the animated count-ups, scroll reveals, and bar charts. ISR: revalidate 60s.
 */

import Navbar from "@/components/Navbar";
import { buildPublicStats } from "@/lib/public-stats";
import { getBankrUsage } from "@/lib/bankr-usage";
import StatsView from "./StatsView";

export const revalidate = 60;

export const metadata = {
  title: "Traction — Blue Agent",
  description:
    "Live, on-chain-verifiable traction for Blue Agent on Base: tokens launched, tool runs, active wallets, and product surface.",
};

export default async function StatsPage() {
  const [stats, usage] = await Promise.all([buildPublicStats(), getBankrUsage()]);

  return (
    <div className="min-h-screen bg-[#050508] text-white">
      <Navbar />
      <StatsView stats={stats} usage={usage} />
    </div>
  );
}
