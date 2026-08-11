import { redirect } from "next/navigation";

// Profile was collapsed into the dashboard (0.1 route consolidation, 2026-07).
// "me looking at me" — wallet, holdings, stake, alerts — all live in
// /app/dashboard now; the public identity card is /agent/[handle] +
// /builder/[handle]. This app-host stub keeps old /profile links alive.
// (The former ProfileClient UI is kept as dead code alongside this file.)
export default function ProfileRedirect() {
  redirect("/dashboard");
}
