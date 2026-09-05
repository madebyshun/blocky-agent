// GET /.well-known/farcaster.json
// Base App / Farcaster Mini App manifest. accountAssociation is signed later
// (Warpcast/Base App "Manifest" tool) — leave the three fields blank until then.
//
// A second copy lives at public/.well-known/farcaster.json. It is NOT a fallback:
// the two paths collide, so one shadows the other and only one is ever served.
// Keeping both is how the tool count drifted to a stale 69 in the first place —
// this copy derives it, and docs-truth-check.ts pins the static copy to match.

import { TOOL_COUNT } from "@/lib/agent-tools";

export const dynamic = "force-static";

export function GET() {
  return Response.json({
    accountAssociation: {
      header: "eyJmaWQiOjEwNTA2NTMsInR5cGUiOiJhdXRoIiwia2V5IjoiMHgwMGEyNWIwMzdjZTk2QzAxNjllNzc1ZTYzQjBkNTMwRDU5YTA4NzlhIn0",
      payload: "eyJkb21haW4iOiJibHVlYWdlbnQuZGV2In0",
      signature: "QZx+4nup3SwFsKneYIRmUMcgR+gdyydr4ku8VgIEZ4hRJdlOmfI8mT4J0Ks1d4g70wfU2pzp0NwBwj1i+VM/Sxs=",
    },
    miniapp: {
      version: "1",
      name: "BlueAgent",
      iconUrl: "https://blueagent.dev/icon.png",
      homeUrl: "https://blueagent.dev/app/chat",
      imageUrl: "https://blueagent.dev/og-chat.png",
      buttonTitle: "Open Blue Agent",
      splashImageUrl: "https://blueagent.dev/splash.png",
      splashBackgroundColor: "#050508",
      webhookUrl: "https://blueagent.dev/api/farcaster/webhook",
      primaryCategory: "finance",
      tags: ["base", "ai", "defi", "agents", "tools"],
      subtitle: "AI agent tools on Base",
      description: `${TOOL_COUNT} AI tools. Pay per call via x402 USDC on Base. No signup, no API key.`,
    },
  });
}
