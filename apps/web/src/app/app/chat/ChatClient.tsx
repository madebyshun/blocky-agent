"use client";

import { useEffect, useState } from "react";
import { ChatProvider, useChat } from "@/app/chat/ChatContext";
import { useAppChrome, type DrawerNavItem, type DrawerRecent } from "@/app/app/AppChrome";

import SettingsModal from "@/app/chat/components/SettingsModal";
import ChatMessages  from "@/app/chat/components/ChatMessages";
import ChatInput     from "@/app/chat/components/ChatInput";
import ClaimBanner   from "@/app/chat/components/ClaimBanner";
import ArtifactsPanel from "@/app/chat/components/ArtifactsPanel";

// ── Helpers ───────────────────────────────────────────────────────────────────
function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const m = Math.floor(diff / 60_000);
  if (m < 1)  return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// ── Shell ──────────────────────────────────────────────────────────────────────
// One surface, no tabs. Models was the last content tab and moved to /models
// (2026-09), following Skills and Connectors; see the note in chat/types.ts.
// Settings is a modal from the account chip, never a tab.
//
// This page has no sidebar of its own either. It used to render a second 288px
// aside beside the shell's 212px one — 500px of chrome to hold New chat, the
// recents list and a credit chip. All three now go to the shell through
// `setContextual`, which already fed the mobile drawer, so one registration
// drives both breakpoints.
function ChatShell() {
  const {
    artifactsPanelOpen,
    createNewTask, tasks, selectTask, deleteTask, activeTaskId,
    setInput,
    credits, isUnlimited, holderTier, walletReady,
  } = useChat();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { setContextual } = useAppChrome();

  // Deep-link prefill: other surfaces route here as
  // /app/chat?prefill=<message> to seed — NOT auto-send — the
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

  // Register Blue Chat's sub-nav, recents and credit chip into the shell —
  // desktop sidebar and mobile drawer both read this. Re-runs when the
  // conversation list or the balance changes so the list and the chip stay
  // current; cleared on unmount (when leaving /app/chat).
  useEffect(() => {
    // No rows here: Settings is reached from the credit chip below (`footer`),
    // the same single affordance the old chat sidebar footer had. A "Settings"
    // row would render it twice on desktop.
    const items: DrawerNavItem[] = [];

    // Only real conversations — the active New Chat draft stays out of history
    // until its first message is sent.
    const recents: DrawerRecent[] = [...tasks]
      .filter(t => t.messages.length > 0)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 40)
      .map(t => ({
        id: t.id,
        title: t.title || "New conversation",
        active: t.id === activeTaskId,
        meta: relativeTime(t.updatedAt),
        onSelect: () => selectTask(t.id),
        onDelete: () => deleteTask(t.id),
      }));

    // Credit chip — doubles as the Settings opener, the same affordance the old
    // chat sidebar footer had. `isUnlimited` is local-dev only (ChatContext
    // reads NODE_ENV), so the ∞ branch never renders in production. The tier
    // colour is not read: getTierInfo() returns the primary for every wallet
    // since the token-free move, so a variable here would only imply otherwise.
    const footer = (
      <button className="w-full flex items-center gap-2.5 group" onClick={() => setSettingsOpen(true)}>
        <span
          className="w-2 h-2 rounded-full shrink-0 transition-all"
          style={{ background: !walletReady ? "#1e293b" : credits <= 20 && !isUnlimited ? "#EF4444" : "#4FC3F7" }}
        />
        <span
          className="font-mono text-[11px] flex-1 text-left"
          style={{ color: !walletReady ? "#475569" : credits <= 20 && !isUnlimited ? "#EF4444" : "#64748b" }}
        >
          {!walletReady ? "…"
            : isUnlimited ? `∞ credits · ${holderTier.tier}`
            : credits >= 10_000 ? `${(credits / 1000).toFixed(1)}k credits`
            : `${credits.toLocaleString()} credits`}
        </span>
        <span className="font-mono text-[9px] text-slate-700 group-hover:text-slate-500 transition-colors">⚙</span>
      </button>
    );

    setContextual({
      barTitle:   "Blue Chat",
      groupTitle: "Blue Chat",
      newChat:    createNewTask,
      items,
      recents,
      footer,
    });
    return () => setContextual(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, activeTaskId, credits, isUnlimited, walletReady]);

  return (
    <>
      {/* No hidden wallet detector. A <WalletBar> used to be mounted here
          off-screen for the sole purpose of firing `onWalletChange` into
          ChatContext on load; the provider reads `useWallet()` itself now, so
          the connected wallet no longer depends on an invisible component
          being rendered. */}

      {/* No <Navbar /> — /app/layout.tsx provides the side navigation */}

      <div className="flex bg-[#050508] font-mono h-full overflow-hidden">

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
