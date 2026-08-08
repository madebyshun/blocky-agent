"use client";

import type { ActiveTab } from "../types";
import { useChat } from "../ChatContext";

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

// ── Nav tabs ──────────────────────────────────────────────────────────────────
const NAV_TABS: { id: ActiveTab; label: string; icon: React.ReactNode }[] = [
  {
    id: "chat",
    label: "Chat",
    icon: (
      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75}
          d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
      </svg>
    ),
  },
  {
    id: "models",
    label: "Models",
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75}
          d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
      </svg>
    ),
  },
  // Skills + Connectors are NOT tabs here any more (2026-08, AgentOS Control).
  // Both were promoted to shell pages (/skills, /connectors) that render the
  // exact same panels, so listing them here too put one catalog behind two
  // different navs. The shell's Control group is now their single home.
  // Settings is also not a tab — it opens as a modal from the footer account
  // chip (ChatGPT/Claude pattern). See SettingsModal + onOpenSettings.
];

// The labeled action rows shown under "New chat". "chat" is excluded — the
// conversation list itself is the chat surface. Models stays because it is a
// per-conversation setting (the ChatInput dropdown is its primary control;
// this row opens the expanded comparison view), not a shared catalog.
const ACTION_ORDER: ActiveTab[] = ["models"];
const ACTION_ITEMS = ACTION_ORDER
  .map(id => NAV_TABS.find(t => t.id === id))
  .filter((t): t is (typeof NAV_TABS)[number] => Boolean(t));

// ── Component ─────────────────────────────────────────────────────────────────
export default function AppSidebar({
  activeTab,
  onSelect,
  onOpenSettings,
}: {
  activeTab: ActiveTab;
  onSelect: (id: ActiveTab) => void;
  onOpenSettings: () => void;
}) {
  const {
    tasks, activeTaskId, createNewTask, selectTask, deleteTask,
    credits, isUnlimited, holderTier, walletReady,
  } = useChat();

  // Only show real conversations — the active New Chat draft (empty messages)
  // stays out of history until its first message is sent.
  const sorted = [...tasks]
    .filter(t => t.messages.length > 0)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 40);

  // w-72 + px-5 h-14 header — the shared app-wide secondary-sidebar format,
  // matching Hub (HubView) and Hub registry so every /app page lines up.
  return (
    <aside className="hidden lg:flex flex-col w-72 shrink-0 h-full border-r border-[#1A1A2E] bg-[#050508]">

      {/* ── Identity ── aligned with main sidebar h-14 logo row */}
      <div className="px-5 h-14 flex items-center border-b border-[#1A1A2E] shrink-0">
        <span className="w-1.5 h-1.5 rounded-full bg-[#4FC3F7] animate-pulse shrink-0 mr-2" />
        <p className="font-mono text-xs text-[#4FC3F7] tracking-widest">// BLUE CHAT</p>
      </div>

      {/* ── Primary actions — labeled vertical rows ── */}
      <nav className="px-2 pt-2 pb-2 shrink-0 space-y-0.5">
        {/* New chat */}
        <button
          onClick={() => { createNewTask(); onSelect("chat"); }}
          className="w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-[#ffffff08] transition-colors group"
        >
          <svg className="w-4 h-4 text-[#4FC3F7] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          <span className="font-mono text-[13px] text-slate-200 font-medium flex-1 text-left">New chat</span>
          <span className="font-mono text-[9px] text-slate-700 group-hover:text-slate-500 transition-colors">⌘N</span>
        </button>

        {/* Skills · Tools · Scheduled */}
        {ACTION_ITEMS.map(item => {
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onSelect(item.id)}
              className="w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-colors"
              style={isActive ? { background: "#4FC3F712" } : undefined}
              onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = "#ffffff08"; }}
              onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = "transparent"; }}
            >
              <span className="shrink-0" style={{ color: isActive ? "#4FC3F7" : "#64748b" }}>
                {item.icon}
              </span>
              <span
                className="font-mono text-[13px] flex-1 text-left"
                style={{ color: isActive ? "#4FC3F7" : "#cbd5e1" }}
              >
                {item.label}
              </span>
            </button>
          );
        })}
      </nav>

      {/* ── Conversations — "Recents" section ── */}
      <div className="flex-1 overflow-hidden flex flex-col min-h-0 border-t border-[#1A1A2E]">
        <div className="flex items-center justify-between px-5 pt-3 pb-1 shrink-0">
          <p className="font-mono text-[9px] text-slate-600 tracking-widest uppercase">Recents</p>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto pb-2">
          {sorted.length === 0 ? (
            <div className="px-4 py-6 text-center">
              <div className="w-10 h-10 rounded-2xl border border-[#1A1A2E] bg-[#0d0d12] flex items-center justify-center mx-auto mb-3">
                <svg className="w-4 h-4 text-slate-700" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                    d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
              </div>
              <p className="font-mono text-[11px] text-slate-600">No conversations yet</p>
            </div>
          ) : (
            sorted.map(task => {
              const isActive = task.id === activeTaskId && activeTab === "chat";
              return (
                <div
                  key={task.id}
                  onClick={() => { selectTask(task.id); onSelect("chat"); }}
                  className={`group relative w-full text-left px-5 py-2 transition-all cursor-pointer flex items-center gap-2 ${
                    isActive ? "bg-[#4FC3F7]/8" : "hover:bg-[#ffffff05]"
                  }`}
                >
                  {/* Active indicator */}
                  {isActive && (
                    <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 rounded-r-full bg-[#4FC3F7]" />
                  )}
                  <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: isActive ? "#4FC3F7" : "#334155" }} />
                  <p className={`font-mono text-[12px] flex-1 truncate leading-snug ${
                    isActive ? "text-white" : "text-slate-400 group-hover:text-slate-200"
                  }`}>
                    {task.title || <span className="italic text-slate-700">New conversation</span>}
                  </p>
                  <span className="font-mono text-[9px] text-slate-700 shrink-0 group-hover:hidden">
                    {relativeTime(task.updatedAt)}
                  </span>
                  <button
                    onClick={e => { e.stopPropagation(); deleteTask(task.id); }}
                    className="hidden group-hover:flex shrink-0 p-0.5 text-slate-700 hover:text-red-400 transition-colors"
                    title="Delete"
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* ── Footer — credits ── */}
      <div className="px-5 py-3.5 border-t border-[#1A1A2E] shrink-0">
        <button
          className="w-full flex items-center gap-2.5 group"
          onClick={onOpenSettings}
        >
          {/* Credit indicator dot */}
          <span
            className="w-2 h-2 rounded-full shrink-0 transition-all"
            style={{
              background: !walletReady ? "#1e293b" : isUnlimited ? holderTier.color : credits <= 20 ? "#EF4444" : "#334155",
              boxShadow: isUnlimited && walletReady ? `0 0 6px ${holderTier.color}` : undefined,
            }}
          />
          <span
            className="font-mono text-[11px] flex-1 text-left"
            style={{ color: !walletReady ? "#475569" : isUnlimited ? holderTier.color : credits <= 20 ? "#EF4444" : "#64748b" }}
          >
            {!walletReady ? "…"
              : isUnlimited ? `∞ credits · ${holderTier.tier}`
              : credits >= 10_000 ? `${(credits / 1000).toFixed(1)}k credits`
              : `${credits.toLocaleString()} credits`}
          </span>
          <span className="font-mono text-[9px] text-slate-700 group-hover:text-slate-500 transition-colors">⚙</span>
        </button>
      </div>
    </aside>
  );
}
