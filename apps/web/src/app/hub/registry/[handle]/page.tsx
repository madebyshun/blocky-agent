import RegistryProfileView from "@/app/hub/_components/RegistryProfileView";

// /hub/registry/[handle] — public (marketing host) route. Renders the shared
// RegistryProfileView with full marketing chrome. The in-app twin lives at
// /app/hub/registry/[handle] (<RegistryProfileView inShell />). The handle is
// read from the URL inside the view via useParams, so no params plumbing here.
export default function AgentProfilePage() {
  return <RegistryProfileView />;
}
