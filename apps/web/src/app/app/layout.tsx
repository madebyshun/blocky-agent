// /app group layout — server component so it can export default OpenGraph
// metadata for every /app/* page. The interactive shell (sidebar, mobile
// drawer, AppChrome context) lives in the client AppShell component.
import type { Metadata } from "next";
import AppShell from "./AppShell";
import { TOOL_COUNT } from "@/lib/agent-tools";

const OG_IMAGE = "https://blueagent.dev/opengraph-image";

export const metadata: Metadata = {
  title: "BlueAgent — The onchain Agent OS",
  description: `${TOOL_COUNT} AI tools. Blue Chat. Blue Hub. Blue Feed. Build, launch, and scale on Base.`,
  openGraph: {
    title: "BlueAgent — The onchain Agent OS",
    description: `${TOOL_COUNT} AI tools. Blue Chat. Blue Hub. Blue Feed.`,
    url: "https://app.blueagent.dev",
    siteName: "BlueAgent",
    images: [{ url: OG_IMAGE, width: 1200, height: 630 }],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "BlueAgent — The onchain Agent OS",
    description: `${TOOL_COUNT} AI tools. Blue Chat. Blue Hub. Blue Feed.`,
    images: [OG_IMAGE],
  },
};

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
