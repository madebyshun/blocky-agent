import type { Metadata } from "next";
import RegistryView from "@/app/hub/_components/RegistryView";

export const metadata: Metadata = {
  title: "Agent Registry — Blue Hub",
  description: "Discover Base AI agents. Submit your repo, get graded A–F by a 3-agent audit (Blue · Aeon · MiroShark).",
};

// /app/hub/registry — the app-subdomain route. The middleware rewrites
// /hub/registry → /app/hub/registry on app.blueagent.dev, so this wrapper must
// exist or the registry gets swallowed by the sibling /app/hub/[tool] dynamic
// route. Renders the shared RegistryView inside the AppShell (nav rail kept).
export default function AppHubRegistryPage() {
  return <RegistryView inShell />;
}
