"use client";

// PanelHost — shared shell for the "promoted panel" Control pages
// (/app/skills, /app/connectors, /app/cron). Those pages reuse the very same
// components that render as tabs inside Blue Chat, so they need what the chat
// surface provides: <ChatProvider>, because SkillsPanel + CronPanel call
// useChat() (setInput / crons CRUD). ConnectorsPanel doesn't, but wrapping it
// is harmless.
//
// There used to be a second requirement here — a hidden <WalletBar> mounted
// off-screen purely to fire `onWalletChange` so the provider would resolve the
// connected wallet and read the RIGHT wallet-scoped data (that wallet's
// Scheduled tasks). ChatProvider now reads `useWallet()` itself, so the wallet
// is resolved by being inside the wagmi tree rather than by a component being
// on screen. Do not reintroduce a detector: an invisible component that exists
// to keep a duplicate of someone else's state in sync is the bug, not the fix.
//
// It also renders the same title/subtitle header the chat tabs use, so a
// promoted panel looks like a first-class page rather than a bare embed.

import { ChatProvider } from "@/app/chat/ChatContext";

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
