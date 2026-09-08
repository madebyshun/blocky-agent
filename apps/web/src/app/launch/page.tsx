// /launch → redirect to /app/b20, the only surface that actually launches.
// The old standalone wizard called a non-existent /api/tool/token-launch route
// (404) and showed a stale fee model.
//
// The Bankr launchpad path that replaced it is ALSO gone (retired 2026-09-06 —
// Bankr suspended the account, 403 on every deploy). This used to redirect to
// chat, because chat carried `hub_b20_launch`; that tool and its card were
// retired 2026-09-08, so chat now has NO deploy path and sending /launch there
// would land the user on a surface that can only tell them it cannot help.
// /app/b20 is where createB20 is signed, and it is the one that reads the
// on-chain ActivationRegistry first. This path is kept as a redirect only so
// the published /launch URL resolves.
import { redirect } from "next/navigation";

export default function LaunchRedirectPage() {
  redirect("/app/b20");
}
