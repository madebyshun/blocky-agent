import { redirect } from "next/navigation";

// Profile was collapsed into the dashboard (0.1 route consolidation, 2026-07).
// This is the MAIN-host stub (blueagent.dev/profile + localhost), so it
// redirects to the /app-prefixed internal path — middleware then 301s it over
// to app.blueagent.dev/dashboard. The former builder/agent search UI is kept
// as dead code in git history; public identity lookup lives at
// /agent/[handle] + /builder/[handle].
export default function ProfileRedirect() {
  redirect("/app/dashboard");
}
