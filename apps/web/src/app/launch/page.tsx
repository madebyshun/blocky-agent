// /launch → redirect to Blue Chat, the real launch surface.
// The old standalone wizard called a non-existent /api/tool/token-launch route
// (404) and showed a stale fee model.
//
// The Bankr launchpad path that replaced it is ALSO gone (retired 2026-09-06 —
// Bankr suspended the account, 403 on every deploy). The one launch flow left in
// chat is `hub_b20_launch` → B20LaunchCard, which is self-hosted: the user signs
// createB20 against the Factory in their own wallet, no third-party launchpad.
// This path is kept as a redirect only so the published /launch URL resolves.
import { redirect } from "next/navigation";

export default function LaunchRedirectPage() {
  redirect("/app/chat");
}
