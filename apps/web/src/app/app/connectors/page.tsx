"use client";

// /app/connectors — the MCP Servers / Connectors gallery promoted to a Control
// page. Reuses the same <ConnectorsPanel> the chat surface renders as a tab; it
// reads the connector store from localStorage (via useConnectors) and has no
// ChatContext dependency, so PanelHost's provider is just harmless symmetry with
// the other promoted panels.

import PanelHost from "../_PanelHost";
import ConnectorsPanel from "@/app/chat/components/ConnectorsPanel";

export default function ConnectorsPage() {
  return (
    <PanelHost
      title="Connectors"
      subtitle="MCP servers & integrations · connect external tools to your agent"
    >
      <ConnectorsPanel />
    </PanelHost>
  );
}
