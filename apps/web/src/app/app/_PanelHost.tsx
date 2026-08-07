"use client";

// PanelHost — shared shell for the "promoted panel" Control pages
// (/app/skills, /app/connectors, /app/cron). Those pages reuse the very same
// components that render as tabs inside Blue Chat, so they need the same two
// things the chat surface provides:
//
//   1. <ChatProvider> — SkillsPanel + CronPanel call useChat() (setInput /
//      crons CRUD). ConnectorsPanel doesn't, but wrapping it is harmless.
//   2. A hidden <WalletBar> detector — drives onWalletChange so the provider
//      resolves the connected wallet and reads the RIGHT wallet-scoped data
//      (e.g. that wallet's Scheduled tasks), matching what chat shows.
//
// It also renders the same title/subtitle header the chat tabs use, so a
// promoted panel looks like a first-class page rather than a bare embed.

import { ChatProvider, useChat } from "@/app/chat/ChatContext";
import WalletBar from "@/components/WalletBar";

// Mounts inside ChatProvider so it can feed the connected wallet back into the
// context (kept off-screen — it's a detector, not UI).
function WalletDetector() {
  const { onWalletChange, walletRefresh } = useChat();
  return (
    <div className="hidden">
      <WalletBar onWalletChange={onWalletChange} refreshTrigger={walletRefresh} />
    </div>
  );
}

export default function PanelHost({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <ChatProvider>
      <WalletDetector />
      <div className="flex flex-col h-full bg-[#050508] overflow-hidden">
        {/* Page header — mirrors ChatClient's non-chat tab header. */}
        <div className="flex items-center px-5 sm:px-6 h-14 border-b border-[#1A1A2E] flex-shrink-0">
          <div className="min-w-0">
            <p className="font-mono text-xs text-[#4FC3F7] tracking-widest truncate">
              // {title.toUpperCase()}
            </p>
            <p className="font-mono text-[10px] text-slate-700 mt-1 truncate">{subtitle}</p>
          </div>
        </div>
        {/* Body — the promoted panel fills the remaining height and owns its
            own scroll (each panel is `flex flex-col h-full`). */}
        <div className="flex-1 min-h-0 overflow-hidden">{children}</div>
      </div>
    </ChatProvider>
  );
}
