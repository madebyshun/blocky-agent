import type { Metadata, Viewport } from "next";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";
import Providers from "@/components/Providers";
import { TOOL_COUNT } from "@/lib/agent-tools";

const SITE = "https://blueagent.dev";
const TITLE = "BlueAgent — The onchain Agent OS";
const DESCRIPTION =
  `${TOOL_COUNT} AI tools. Build, launch, and scale on Base. AI agent chat, x402 tools, and live Base intelligence.`;

// Farcaster v2 mini-app embed — what Base App reads when blueagent.dev is
// shared in a feed. Tap the button → launches /app/chat inside the wallet's
// in-app browser with the splash card while it loads.
const fcFrame = JSON.stringify({
  version: "next",
  imageUrl: `${SITE}/opengraph-image`,
  button: {
    title: "Open Blue Agent",
    action: {
      type: "launch_frame",
      name: "Blue Agent",
      url: `${SITE}/app/chat`,
      splashImageUrl: `${SITE}/splash.png`,
      splashBackgroundColor: "#050508",
    },
  },
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#050508",
  // Prevent zoom-in on form focus inside Base App's in-app browser
  maximumScale: 5,
};

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  keywords: ["Blue Agent", "Base", "Blue Hub", "AI tools", "x402", "founder console", "Base builders", "BLUEAGENT", "Farcaster", "Base App"],
  metadataBase: new URL(SITE),
  applicationName: "Blue Agent",
  appleWebApp: {
    title: "Blue Agent",
    capable: true,
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: [
      { url: "/logo.svg", type: "image/svg+xml" },
      { url: "/icon.png", sizes: "512x512", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    type: "website",
    url: SITE,
    siteName: "Blue Agent",
    images: [{ url: "/og-chat.png", width: 1200, height: 630, alt: "Blue Agent" }],
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
    creator: "@blueagent_",
    site: "@blueagent_",
    images: ["/og-chat.png"],
  },
  other: {
    // Base App domain ownership verification (base.dev "Add Domain")
    "base:app_id": "69a6f7796b102959c7f25eaa",
    "fc:frame": fcFrame,
    // Legacy fallback for Farcaster v1 clients that haven't migrated to v2
    "fc:frame:image": `${SITE}/opengraph-image`,
    "fc:frame:button:1": "Open Blue Agent",
    "fc:frame:button:1:action": "launch_frame",
    "fc:frame:button:1:target": `${SITE}/app/chat`,
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body><Providers>{children}</Providers><Analytics /></body>
    </html>
  );
}
