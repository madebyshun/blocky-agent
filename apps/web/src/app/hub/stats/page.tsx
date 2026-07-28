import StatsView from "@/app/hub/_components/StatsView";

// /hub/stats — public (marketing host) route. noindex metadata lives in the
// sibling layout.tsx (unlisted: reachable by direct URL, excluded from crawlers).
// The in-app twin lives at /app/hub/stats (<StatsView inShell />).
export default function StatsPage() {
  return <StatsView />;
}
