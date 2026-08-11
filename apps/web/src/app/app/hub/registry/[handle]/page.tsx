import RegistryProfileView from "@/app/hub/_components/RegistryProfileView";

// /app/hub/registry/[handle] — the app-subdomain route. The middleware rewrites
// /hub/registry/[handle] → /app/hub/registry/[handle] on app.blueagent.dev, so
// this wrapper must exist or the profile gets swallowed by /app/hub/[tool].
// The handle is read from the URL inside the view via useParams. Renders inside
// the AppShell (nav rail kept).
export default function AppHubRegistryProfilePage() {
  return <RegistryProfileView inShell />;
}
