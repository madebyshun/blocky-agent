import type { Metadata } from "next";
import StatsView from "@/app/hub/_components/StatsView";

// Unlisted, same as the marketing /hub/stats route: reachable by direct URL but
// excluded from search + AI/agent crawlers. noindex is set here (page metadata
// overrides the /app layout default).
export const metadata: Metadata = {
  title: "Stats · Blue Hub",
  robots: { index: false, follow: false, googleBot: { index: false, follow: false } },
};

// /app/hub/stats — the app-subdomain route. The middleware rewrites
// /hub/stats → /app/hub/stats on app.blueagent.dev, so this wrapper must exist
// or stats gets swallowed by /app/hub/[tool]. Renders inside the AppShell.
export default function AppHubStatsPage() {
  return <StatsView inShell />;
}
