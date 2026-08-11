import type { Metadata } from "next";
import RegistryView from "@/app/hub/_components/RegistryView";

export const metadata: Metadata = {
  title: "Agent Registry — Blue Hub",
  description: "Discover Base AI agents. Submit your repo, get graded A–F by a 3-agent audit (Blue · Aeon · MiroShark).",
};

// /hub/registry — public (marketing host) route. Renders the shared RegistryView
// with the full marketing chrome (<Navbar/>). The in-app twin lives at
// /app/hub/registry (<RegistryView inShell />).
export default function RegistryPage() {
  return <RegistryView />;
}
