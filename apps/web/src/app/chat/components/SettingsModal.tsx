"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import SettingsPanel, { type SettingsSection } from "./SettingsPanel";

// Mobile-only quick links — kept out of the nav drawer so the drawer stays
// focused. Hidden on desktop (lg:hidden), so the web Settings experience is
// unchanged. Only Models is a tab jump now: Skills was promoted to its own
// shell page (/skills), so it navigates like Docs instead of switching a chat
// tab — otherwise the same catalog would sit behind two different controls.
type JumpTab = "models";
const QUICK_LINKS: { id: JumpTab; label: string; icon: string }[] = [
  { id: "models", label: "Models", icon: "🤖" },
];
const QUICK_ROUTES: { href: string; label: string; icon: string }[] = [
  { href: "/skills", label: "Skills", icon: "⚡" },
  { href: "/docs/blue-chat", label: "Docs", icon: "📄" },
];

/**
 * Account / Settings modal — Claude-style two-pane layout: a left category
 * rail (Account · Credits · Memory) and a right content pane that
 * renders the selected section. Replaces the old single-column long-scroll.
 * Opens from the sidebar account chip.
 */

const SECTIONS: { id: SettingsSection; label: string; icon: React.ReactNode }[] = [
  {
    id: "account",
    label: "Account",
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h18M7 15h2m6-9H6a3 3 0 00-3 3v6a3 3 0 003 3h12a3 3 0 003-3V9a3 3 0 00-3-3z" />
      </svg>
    ),
  },
  {
    id: "credits",
    label: "Credits",
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 9v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
  {
    id: "memory",
    label: "Memory",
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
      </svg>
    ),
  },
  {
    id: "about",
    label: "About",
    icon: (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
];

export default function SettingsModal({
  open,
  onClose,
  onJumpTab,
}: {
  open: boolean;
  onClose: () => void;
  onJumpTab?: (tab: JumpTab) => void;
}) {
  const [section, setSection] = useState<SettingsSection>("account");

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-3 sm:p-6">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />

      {/* Panel — one fixed size so the modal never resizes between sections;
          capped at the viewport on short screens. */}
      <div className="relative w-full max-w-2xl h-[600px] max-h-[90vh] flex flex-col rounded-2xl border border-[#1A1A2E] bg-[#050508] shadow-2xl overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-5 h-14 border-b border-[#1A1A2E] shrink-0">
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-[#4FC3F7] shrink-0" />
            <p className="font-mono text-[11px] text-[#4FC3F7] tracking-widest">// SETTINGS</p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-600 hover:text-slate-300 hover:bg-[#1A1A2E] transition-colors"
            title="Close (Esc)"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body — two panes (sm+) / stacked (mobile) */}
        <div className="flex-1 min-h-0 flex flex-col sm:flex-row">

          {/* Left rail — vertical on sm+, horizontal scroll on mobile */}
          <nav className="shrink-0 sm:w-48 border-b sm:border-b-0 sm:border-r border-[#1A1A2E] sm:py-3 sm:px-2 px-2 py-2 flex sm:flex-col gap-1 overflow-x-auto sm:overflow-x-visible sm:overflow-y-auto">
            {SECTIONS.map(s => {
              const active = section === s.id;
              return (
                <button
                  key={s.id}
                  onClick={() => setSection(s.id)}
                  className="flex items-center gap-2.5 px-3 py-2 rounded-lg transition-colors shrink-0 sm:w-full whitespace-nowrap"
                  style={active ? { background: "#4FC3F712" } : undefined}
                  onMouseEnter={e => { if (!active) e.currentTarget.style.background = "#ffffff06"; }}
                  onMouseLeave={e => { if (!active) e.currentTarget.style.background = "transparent"; }}
                >
                  <span className="shrink-0" style={{ color: active ? "#4FC3F7" : "#64748b" }}>{s.icon}</span>
                  <span className="font-mono text-[13px]" style={{ color: active ? "#4FC3F7" : "#cbd5e1" }}>{s.label}</span>
                </button>
              );
            })}
          </nav>

          {/* Right content pane */}
          <div className="flex-1 min-h-0 overflow-y-auto">
            {/* Mobile-only quick links (Models tab + Skills/Docs routes) —
                desktop has these in the chat sidebar / shell nav, so hidden lg+. */}
            <div className="lg:hidden px-5 pt-5">
              <p className="font-mono text-[10px] text-slate-500 tracking-widest mb-2">BLUE CHAT</p>
              <div className="grid grid-cols-2 gap-2">
                {QUICK_LINKS.map(q => (
                  <button
                    key={q.id}
                    onClick={() => onJumpTab?.(q.id)}
                    className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl border border-[#1A1A2E] bg-[#0A0A12] hover:bg-[#ffffff06] transition-colors"
                  >
                    <span className="text-sm leading-none shrink-0">{q.icon}</span>
                    <span className="font-mono text-[13px] text-slate-200">{q.label}</span>
                  </button>
                ))}
                {QUICK_ROUTES.map(r => (
                  <Link
                    key={r.href}
                    href={r.href}
                    onClick={onClose}
                    className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl border border-[#1A1A2E] bg-[#0A0A12] hover:bg-[#ffffff06] transition-colors"
                  >
                    <span className="text-sm leading-none shrink-0">{r.icon}</span>
                    <span className="font-mono text-[13px] text-slate-200">{r.label}</span>
                  </Link>
                ))}
              </div>
              <div className="border-t border-[#1A1A2E] mt-5" />
            </div>

            <SettingsPanel section={section} />
          </div>
        </div>
      </div>
    </div>
  );
}
