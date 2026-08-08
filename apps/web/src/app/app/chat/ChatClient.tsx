"use client";

import { useEffect, useState } from "react";
import WalletBar     from "@/components/WalletBar";
import { ChatProvider, useChat } from "@/app/chat/ChatContext";
import { useAppChrome, type DrawerNavItem, type DrawerRecent } from "@/app/app/AppChrome";

import AppSidebar    from "@/app/chat/components/AppSidebar";
import ModelsPanel   from "@/app/chat/components/ModelsPanel";
import SettingsModal from "@/app/chat/components/SettingsModal";
import ChatMessages  from "@/app/chat/components/ChatMessages";
import ChatInput     from "@/app/chat/components/ChatInput";
import ClaimBanner   from "@/app/chat/components/ClaimBanner";
import ArtifactsPanel from "@/app/chat/components/ArtifactsPanel";
import type { ActiveTab } from "@/app/chat/types";

// ── Tab metadata ───────────────────────────────────────────────────────────────
// Settings is intentionally absent — it opens as a modal from the account chip,
// not as a content tab. Skills + Connectors are gone too: they're shell pages
// (/skills, /connectors) now, so chat no longer duplicates their catalogs.
const TAB_META: Record<Exclude<ActiveTab, "chat" | "settings">, { title: string; subtitle: string }> = {
  models: { title: "Models", subtitle: "AI engines behind Blue Chat · pick by use-case" },
};

// ── Shell ──────────────────────────────────────────────────────────────────────
function ChatShell() {
  const {
    artifactsPanelOpen,
    onWalletChange, walletRefresh,
    createNewTask, tasks, selectTask, activeTaskId,
    setInput,
  } = useChat();
  const [activeTab, setActiveTab] = useState<ActiveTab>("chat");
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
      setActiveTab("chat");
      url.searchParams.delete("prefill");
      window.history.replaceState({}, "", url.pathname + url.search);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isChat = activeTab === "chat";
  const meta   = activeTab !== "chat" && activeTab !== "settings" ? TAB_META[activeTab] : null;

  // Register Blue Chat's sub-nav + recents into the global mobile drawer.
  // Re-runs when the active tab or conversation list changes so highlights and
  // the recents list stay current; cleared on unmount (when leaving /app/chat).
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
        active: t.id === activeTaskId && activeTab === "chat",
        onSelect: () => { selectTask(t.id); setActiveTab("chat"); },
      }));
    setContextual({
      barTitle:   isChat ? "Blue Chat" : (meta?.title ?? "Blue Chat"),
      groupTitle: "Blue Chat",
      newChat:    () => { createNewTask(); setActiveTab("chat"); },
      items,
      recents,
    });
    return () => setContextual(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, tasks, activeTaskId]);

  return (
    <>
      {/* Hidden wallet detector — always mounted so onWalletChange fires on load */}
      <div className="hidden">
        <WalletBar onWalletChange={onWalletChange} refreshTrigger={walletRefresh} />
      </div>

      {/* No <Navbar /> — /app/layout.tsx provides the side navigation */}

      <div className="flex bg-[#050508] font-mono h-full overflow-hidden">

        {/* ── Sidebar (desktop) ── */}
        <AppSidebar activeTab={activeTab} onSelect={setActiveTab} onOpenSettings={() => setSettingsOpen(true)} />

        {/* ── Main content area ──
            The global mobile top bar + nav drawer (see /app/layout.tsx) own
            mobile navigation now, so there's no in-page mobile tab bar and no
            bottom-bar padding to clear. */}
        <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">

          {/* Tab header (non-chat, desktop) */}
          {!isChat && meta && (
            <div className="hidden lg:flex items-center px-6 h-14 border-b border-[#1A1A2E] flex-shrink-0">
              <div>
                <p className="font-mono text-xs text-[#4FC3F7] tracking-widest">
                  // {meta.title.toUpperCase()}
                </p>
                <p className="font-mono text-[10px] text-slate-700 mt-1">{meta.subtitle}</p>
              </div>
            </div>
          )}

          {/* Content area */}
          <div className="flex-1 flex min-h-0 overflow-hidden">

            {/* 💬 Chat */}
            {isChat && (
              <>
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
              </>
            )}

            {/* 🤖 Models — the only non-chat tab left. Skills + Connectors moved
                out to /skills and /connectors in the shell's Control group. */}
            {activeTab === "models" && (
              <div className="flex-1 h-full overflow-hidden">
                <ModelsPanel onPick={() => setActiveTab("chat")} />
              </div>
            )}

          </div>
        </div>
      </div>

      {/* ⚙️ Settings — modal opened from the sidebar account chip. onJumpTab
          lets the mobile-only quick links (Models/Tools/Skills) jump to a chat
          tab and close the modal. */}
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onJumpTab={(tab) => { setActiveTab(tab); setSettingsOpen(false); }}
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
