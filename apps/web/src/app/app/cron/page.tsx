"use client";

// /app/cron — Scheduled tasks promoted to a Control page. Reuses the same
// <CronPanel> the chat surface renders as a tab; it reads/writes crons through
// useChat(), so PanelHost supplies the ChatProvider AND a hidden WalletBar
// detector — the detector resolves the connected wallet so the panel shows THIS
// wallet's scheduled tasks (matching exactly what the chat tab shows).

import PanelHost from "../_PanelHost";
import CronPanel from "@/app/chat/components/CronPanel";

export default function CronPage() {
  return (
    <PanelHost
      title="Scheduled"
      subtitle="Recurring agent runs · your wallet's cron tasks"
    >
      <CronPanel />
    </PanelHost>
  );
}
