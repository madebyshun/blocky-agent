"use client";

import { useEffect, useState } from "react";
import WalletBar     from "@/components/WalletBar";
import { ChatProvider, useChat } from "@/app/chat/ChatContext";
import { useAppChrome, type DrawerNavItem, type DrawerRecent } from "@/app/app/AppChrome";

import AppSidebar    from "@/app/chat/components/AppSidebar";
import SettingsModal from "@/app/chat/components/SettingsModal";
import ChatMessages  from "@/app/chat/components/ChatMessages";
import ChatInput     from "@/app/chat/components/ChatInput";
import ClaimBanner   from "@/app/chat/components/ClaimBanner";
import ArtifactsPanel from "@/app/chat/components/ArtifactsPanel";

// ── Shell ──────────────────────────────────────────────────────────────────────
// One surface, no tabs. Models was the last content tab and moved to /models
// (2026-09), following Skills and Connectors; see the note in chat/types.ts.
// Settings is a modal from the account chip, never a tab.
function ChatShell() {
  const {
    artifactsPanelOpen,
    onWalletChange, walletRefresh,
    createNewTask, tasks, selectTask, activeTaskId,
    setInput,
  } = useChat();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { setContextual } = useAppChrome();

  // Deep-link prefill: other surfaces (e.g. the /app/launches "Trade" button)
  // route here as /app/chat?prefill=<message> to seed — NOT auto-send — the
  // composer with a token-trade prompt. The user reviews/edits, then sends.
  // Runs once on mount; we strip the param afterwards so a refresh won't re-seed.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const prefill = url.searchParams.get("prefill");
    if (prefill) {
      setInput(prefill);
      url.searchParams.delete("prefill");
      window.history.replaceState({}, "", url.pathname + url.search);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Register Blue Chat's sub-nav + recents into the global mobile drawer.
  // Re-runs when the conversation list changes so highlights and the recents
  // list stay current; cleared on unmount (when leaving /app/chat).
  useEffect(() => {
    // New chat = primary action (compose button in top bar + prominent in
    // drawer). Models/Tools/Skills moved into Settings (mobile); the redundant
    // "Chat" row is dropped since you're already in the chat tab.
    const items: DrawerNavItem[] = [
      { id: "settings", label: "Settings",  icon: "⚙️", onSelect: () => setSettingsOpen(true) },
    ];
    const recents: DrawerRecent[] = [...tasks]
      .filter(t => t.messages.length > 0)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 12)
      .map(t => ({
        id: t.id,
        title: t.title || "New conversation",
        active: t.id === activeTaskId,
        onSelect: () => selectTask(t.id),
      }));
    setContextual({
      barTitle:   "Blue Chat",
      groupTitle: "Blue Chat",
      newChat:    createNewTask,
      items,
      recents,
    });
    return () => setContextual(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, activeTaskId]);

  return (
    <>
      {/* Hidden wallet detector — always mounted so onWalletChange fires on load */}
      <div className="hidden">
        <WalletBar onWalletChange={onWalletChange} refreshTrigger={walletRefresh} />
      </div>

      {/* No <Navbar /> — /app/layout.tsx provides the side navigation */}

      <div className="flex bg-[#050508] font-mono h-full overflow-hidden">

        {/* ── Sidebar (desktop) ── */}
        <AppSidebar onOpenSettings={() => setSettingsOpen(true)} />

        {/* ── Main content area ──
            The global mobile top bar + nav drawer (see /app/layout.tsx) own
            mobile navigation now, so there's no in-page mobile tab bar and no
            bottom-bar padding to clear. */}
        <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">
          <div className="flex-1 flex min-h-0 overflow-hidden">

            <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">
              <ClaimBanner />
              <ChatMessages />
              <ChatInput />
            </div>
            {artifactsPanelOpen && (
              <div className="hidden lg:flex flex-col w-96 shrink-0 border-l border-[#1A1A2E] h-full overflow-hidden">
                <ArtifactsPanel />
              </div>
            )}

          </div>
        </div>
      </div>

      {/* ⚙️ Settings — modal opened from the sidebar account chip. Its
          mobile-only quick links are all routes now (Models/Skills/Docs), so
          the modal no longer needs to drive this surface's tab state. */}
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />

    </>
  );
}

export default function AppChatPage() {
  return (
    <ChatProvider>
      <ChatShell />
    </ChatProvider>
  );
}
