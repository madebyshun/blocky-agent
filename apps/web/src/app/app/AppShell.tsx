"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { usePolling } from "@/hooks/usePolling";
import { AppChromeProvider, useAppChrome } from "./AppChrome";
import LanguageToggle from "@/components/LanguageToggle";
import { useLang } from "@/lib/i18n/context";

// T-D D1 — small self-contained client component. Polls
// `/api/hood/inbox/unread-count` every 30s and shows a red dot with the count
// on the Hood nav item. Only mounted for the Hood item so other nav items don't
// trigger the fetch.
//
// ⚠ This badge lives in the nav, so it runs on EVERY /app page — not just Hood.
// That made it the single most-amplified fetch in the app, and the largest
// contributor to the Upstash suspensions (#123, #148) back when one GET cost
// ~202 KV commands. #148 ② took the per-GET cost to 2; #148 ③ (below) stops
// the loop entirely while the tab is hidden.
const NAV_BADGE_POLL_MS = 30_000;

function HoodNavBadge() {
  const [n, setN] = useState<number | null>(null);

  const load = useCallback(async (signal: AbortSignal) => {
    try {
      const r = await fetch("/api/hood/inbox/unread-count", { cache: "no-store", signal });
      // 503 means "unread count UNKNOWN" (KV unreachable), not "zero unread".
      // Returning early keeps the last known count on screen; letting it fall
      // through to 0 would hide the badge and look exactly like "all caught
      // up", which is the one reading that is definitely wrong.
      if (!r.ok) return;
      const body = (await r.json()) as { unread?: number };
      if (typeof body.unread === "number") setN(body.unread);
    } catch { /* offline or aborted — both fine, keep the last count */ }
  }, []);

  // The `signal` replaces the old `alive` flag: it not only suppresses the
  // post-unmount setState, it cancels the request that is still on the wire.
  usePolling(load, NAV_BADGE_POLL_MS);
  if (!n) return null;
  const label = n > 99 ? "99+" : String(n);
  return (
    <span
      className="absolute -top-1 -right-2 min-w-[14px] h-[14px] px-1 rounded-full flex items-center justify-center font-mono text-[9px] font-bold"
      style={{ backgroundColor: "#ef4444", color: "#fff", boxShadow: "0 0 0 2px #050508" }}
      aria-label={`${n} unread`}
    >
      {label}
    </span>
  );
}

// ── Icons (Heroicons outline · 18px · strokeWidth 1.5) ──────────────────────────
const S = { width: 18, height: 18 } as const;
const svg = (d: ReactNode) => (
  <svg style={S} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>{d}</svg>
);

const IconChat = svg(<path strokeLinecap="round" strokeLinejoin="round" d="M8.625 9.75a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H8.25m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H12m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0h-.375m-13.5 3.01c0 1.6 1.123 2.994 2.707 3.227 1.087.16 2.185.283 3.293.369V21l4.184-4.183a1.14 1.14 0 0 1 .778-.332 48.294 48.294 0 0 0 5.83-.498c1.585-.233 2.708-1.626 2.708-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z" />);
const IconHub = svg(<path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6ZM3.75 15.75A2.25 2.25 0 0 1 6 13.5h2.25a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18v-2.25ZM13.5 6a2.25 2.25 0 0 1 2.25-2.25H18A2.25 2.25 0 0 1 20.25 6v2.25A2.25 2.25 0 0 1 18 10.5h-2.25a2.25 2.25 0 0 1-2.25-2.25V6ZM13.5 15.75a2.25 2.25 0 0 1 2.25-2.25H18a2.25 2.25 0 0 1 2.25 2.25V18A2.25 2.25 0 0 1 18 20.25h-2.25A2.25 2.25 0 0 1 13.5 18v-2.25Z" />);
const IconHood = svg(<><path strokeLinecap="round" strokeLinejoin="round" d="M3.75 12h16.5m0 0-6-6m6 6-6 6" /><path strokeLinecap="round" strokeLinejoin="round" d="M3.75 4.5v15" /></>);
// Wallet — billfold body + fold flap + rounded coin pocket (distinct from the credit-card Plans icon).
const IconWallet = svg(<><path strokeLinecap="round" strokeLinejoin="round" d="M2.25 9.75A2.25 2.25 0 0 1 4.5 7.5h15a2.25 2.25 0 0 1 2.25 2.25v7.5A2.25 2.25 0 0 1 19.5 19.5h-15a2.25 2.25 0 0 1-2.25-2.25v-7.5Z" /><path strokeLinecap="round" strokeLinejoin="round" d="M18 7.5V6.75A2.25 2.25 0 0 0 15.75 4.5H5.25" /><path strokeLinecap="round" strokeLinejoin="round" d="M21.75 12.75h-3a1.875 1.875 0 0 0 0 3.75h3" /></>);
// Overview — chart-pie (distinct from Hub's grid).
const IconOverview = svg(<><path strokeLinecap="round" strokeLinejoin="round" d="M10.5 6a7.5 7.5 0 1 0 7.5 7.5h-7.5V6Z" /><path strokeLinecap="round" strokeLinejoin="round" d="M13.5 10.5H21A7.5 7.5 0 0 0 13.5 3v7.5Z" /></>);
// Skills — sparkles.
const IconSkills = svg(<path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456Z" />);
// Connectors — squares-plus.
const IconConnectors = svg(<path strokeLinecap="round" strokeLinejoin="round" d="M13.5 16.875h3.375m0 0h3.375m-3.375 0V13.5m0 3.375v3.375M6 10.5h2.25a2.25 2.25 0 0 0 2.25-2.25V6a2.25 2.25 0 0 0-2.25-2.25H6A2.25 2.25 0 0 0 3.75 6v2.25A2.25 2.25 0 0 0 6 10.5Zm0 9.75h2.25A2.25 2.25 0 0 0 10.5 18v-2.25a2.25 2.25 0 0 0-2.25-2.25H6a2.25 2.25 0 0 0-2.25 2.25V18A2.25 2.25 0 0 0 6 20.25Zm9.75-9.75H18a2.25 2.25 0 0 0 2.25-2.25V6A2.25 2.25 0 0 0 18 3.75h-2.25A2.25 2.25 0 0 0 13.5 6v2.25a2.25 2.25 0 0 0 2.25 2.25Z" />);
// Cron — clock.
const IconCron = svg(<path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />);
// Usage — chart-bar.
const IconUsage = svg(<path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 0 1 3 19.875v-6.75ZM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V8.625ZM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V4.125Z" />);
// Plans — credit-card.
const IconPlans = svg(<path strokeLinecap="round" strokeLinejoin="round" d="M2.25 8.25h19.5M2.25 9h19.5m-16.5 5.25h6m-6 2.25h3m-3.75 3h15a2.25 2.25 0 0 0 2.25-2.25V6.75A2.25 2.25 0 0 0 19.5 4.5h-15a2.25 2.25 0 0 0-2.25 2.25v10.5A2.25 2.25 0 0 0 4.5 19.5Z" />);
// Docs — document.
const IconDocs = svg(<path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />);
const IconHome = (
  <svg style={{ width: 16, height: 16 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="m2.25 12 8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25" />
  </svg>
);

const IconModels = (
  <svg style={{ width: 16, height: 16 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 17 9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2Z" />
  </svg>
);

// ── Nav model ───────────────────────────────────────────────────────────────────
// Grouped sidebar mirroring the "onchain Agent OS" framing — three product
// pillars + an account band. Every destination is backed by REAL data (no
// fabricated Health / Sessions / Agents pages):
//   AGENT   — the agent you operate: Chat + Wallet, plus its control pages
//             (Overview, Connectors, Scheduled, Usage — all promoted Blue Chat
//             tabs; see src/app/app/{dashboard,connectors,cron,usage}).
//   EXPLORE — Blue Hood's public signals + receipted track record.
//   HUB     — the Blue Hub marketplace + your installed agent-skills catalog.
//   ACCOUNT — billing + help (Plans, Docs) — unchanged.
// This is a relabel/regroup only: every href below is identical to before, so
// no route, redirect, or deep link changes — only how items are grouped/named.
type NavItem = { id: string; href: string; icon: ReactNode; badge?: "hood" };
type NavGroup = { id: string; items: NavItem[] };

const NAV_GROUPS: NavGroup[] = [
  {
    id: "group_agent",
    items: [
      { id: "chat", href: "/chat", icon: IconChat },
      { id: "models", href: "/models", icon: IconModels },
      { id: "wallet", href: "/wallet", icon: IconWallet },
      { id: "dashboard", href: "/dashboard", icon: IconOverview },
      { id: "connectors", href: "/connectors", icon: IconConnectors },
      { id: "cron", href: "/cron", icon: IconCron },
      { id: "usage", href: "/usage", icon: IconUsage },
    ],
  },
  {
    id: "group_explore",
    items: [
      { id: "hood", href: "/hood", icon: IconHood, badge: "hood" },
    ],
  },
  {
    id: "group_hub",
    items: [
      { id: "hub", href: "/hub", icon: IconHub },
      { id: "skills", href: "/skills", icon: IconSkills },
    ],
  },
  {
    id: "group_account",
    items: [
      { id: "plans", href: "/plans", icon: IconPlans },
      { id: "docs", href: "/docs/blue-chat", icon: IconDocs },
    ],
  },
];

const ALL_ITEMS = NAV_GROUPS.flatMap((g) => g.items);

// The app surface is served on app.blueagent.dev under clean, /app-less URLs
// (middleware rewrites /chat → /app/chat), so on prod usePathname() already
// returns the clean path. On localhost/preview you visit /app/chat directly, so
// strip a leading /app here too — that keeps the active highlight correct in
// BOTH environments. The app root ("/") is Blue Chat, so map it to /chat.
function cleanPath(pathname: string): string {
  const p = pathname.replace(/^\/app(?=\/|$)/, "") || "/";
  return p === "/" ? "/chat" : p;
}

// Returns the nav id for the current path so the mobile title can be translated
// via t(`nav.${id}`); falls back to null (→ generic "Blue Agent" brand label).
function navIdForPath(pathname: string): string | null {
  const clean = cleanPath(pathname);
  const match = ALL_ITEMS.find((i) => clean === i.href || clean.startsWith(i.href + "/"));
  return match?.id ?? null;
}

// ── Desktop sidebar (grouped · collapsible) ─────────────────────────────────────

const COLLAPSE_KEY = "blue.sidebar.collapsed";

function AppSideNav() {
  const pathname = usePathname();
  const { t } = useLang();
  const clean = cleanPath(pathname);
  const isActive = (href: string) => clean === href || clean.startsWith(href + "/");

  // Collapse state persists across sessions. Default expanded; hydrate from
  // localStorage after mount (avoids an SSR/client mismatch).
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try { setCollapsed(localStorage.getItem(COLLAPSE_KEY) === "1"); } catch { /* ignore */ }
  }, []);
  const toggle = () =>
    setCollapsed((v) => {
      const next = !v;
      try { localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0"); } catch { /* ignore */ }
      return next;
    });

  const renderItem = (item: NavItem) => {
    const active = isActive(item.href);
    return (
      <Link
        key={item.id}
        href={item.href}
        title={collapsed ? t(`nav.${item.id}`) : undefined}
        className={`group relative flex items-center rounded-lg h-9 transition-colors ${
          collapsed ? "justify-center" : "gap-3 px-3"
        }`}
        style={active ? { background: "#4FC3F712" } : undefined}
      >
        {active && (
          <span
            className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 rounded-r-full bg-[#4FC3F7]"
            style={{ boxShadow: "0 0 6px #4FC3F780" }}
          />
        )}
        <span
          className="relative shrink-0 transition-colors"
          style={{ color: active ? "#4FC3F7" : "#64748b" }}
        >
          {item.icon}
          {item.badge === "hood" && <HoodNavBadge />}
        </span>
        {!collapsed && (
          <span
            className="font-mono text-[12px] tracking-wide truncate transition-colors"
            style={{ color: active ? "#4FC3F7" : "#cbd5e1" }}
          >
            {t(`nav.${item.id}`)}
          </span>
        )}
      </Link>
    );
  };

  return (
    <aside
      className="hidden md:flex flex-col shrink-0 border-r border-[#1A1A2E] h-full bg-[#050508] transition-[width] duration-200 ease-out"
      style={{ width: collapsed ? 64 : 212 }}
    >
      {/* Logo / wordmark */}
      <div
        className={`flex items-center h-14 border-b border-[#1A1A2E] shrink-0 ${
          collapsed ? "justify-center" : "px-3"
        }`}
      >
        <a
          href="https://blueagent.dev"
          title="blueagent.dev"
          className="flex items-center gap-2 min-w-0"
        >
          <img
            src="/logomark.svg"
            alt="Blue Agent"
            className="h-7 w-7 rounded-lg shrink-0 hover:opacity-75 transition-opacity"
          />
          {!collapsed && (
            <span className="font-mono text-[12px] text-white tracking-wide truncate">
              BLUE<span className="text-[#4FC3F7]">AGENT</span>
            </span>
          )}
        </a>
      </div>

      {/* Grouped nav */}
      <nav className="flex-1 overflow-y-auto py-2">
        {NAV_GROUPS.map((group, gi) => (
          <div key={group.id} className={gi > 0 ? "mt-1" : ""}>
            {collapsed
              ? gi > 0 && <div className="mx-auto my-2 w-6 h-px bg-[#1A1A2E]" />
              : (
                <p className="px-3 pt-4 pb-1 font-mono text-[9px] text-slate-600 tracking-widest uppercase">
                  {t(`nav.${group.id}`)}
                </p>
              )}
            <div className="flex flex-col gap-0.5 px-2">
              {group.items.map(renderItem)}
            </div>
          </div>
        ))}
      </nav>

      {/* Footer — Home · language · collapse toggle */}
      <div className="border-t border-[#1A1A2E] shrink-0 flex flex-col gap-1 py-2 px-2">
        <a
          href="https://blueagent.dev"
          title={collapsed ? t("nav.home") : undefined}
          className={`group flex items-center rounded-lg h-9 text-[#283040] hover:text-slate-400 transition-colors ${
            collapsed ? "justify-center" : "gap-3 px-3"
          }`}
        >
          <span className="shrink-0">{IconHome}</span>
          {!collapsed && (
            <span className="font-mono text-[12px] tracking-wide text-slate-500 group-hover:text-slate-300 transition-colors">
              {t("nav.home")}
            </span>
          )}
        </a>

        <div className={collapsed ? "flex justify-center" : "px-1"}>
          <LanguageToggle vertical={collapsed} />
        </div>

        <button
          onClick={toggle}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className={`group flex items-center rounded-lg h-9 text-slate-600 hover:text-slate-300 hover:bg-[#ffffff06] transition-colors ${
            collapsed ? "justify-center" : "gap-3 px-3"
          }`}
        >
          <span
            className="shrink-0 transition-transform"
            style={{ transform: collapsed ? "rotate(180deg)" : undefined }}
          >
            <svg style={{ width: 16, height: 16 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
            </svg>
          </span>
          {!collapsed && (
            <span className="font-mono text-[11px] tracking-wide">Collapse</span>
          )}
        </button>
      </div>
    </aside>
  );
}

// ── Mobile chrome (top bar + drawer) ────────────────────────────────────────────
// A hamburger top bar opens a slide-out drawer holding BOTH the product
// destinations (same three groups as desktop) and — when a page registers it —
// that page's contextual sub-nav (e.g. Blue Chat's recents / New chat).

function MobileTopBar() {
  const { setDrawerOpen, contextual } = useAppChrome();
  const pathname = usePathname();
  const { t } = useLang();
  const navId = navIdForPath(pathname);
  const title = contextual?.barTitle ?? (navId ? t(`nav.${navId}`) : "Blue Agent");

  return (
    <header className="lg:hidden flex items-center gap-3 h-12 px-3 border-b border-[#1A1A2E] bg-[#050508] shrink-0">
      <button
        aria-label="Open menu"
        onClick={() => setDrawerOpen(true)}
        className="p-1.5 -ml-1 rounded-lg text-slate-300 hover:bg-[#ffffff0a] transition-colors"
      >
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>
      <span className="font-mono text-[11px] text-[#4FC3F7] tracking-widest truncate flex-1">
        // {title.toUpperCase()}
      </span>
      <LanguageToggle />
      {contextual?.newChat && (
        <button
          aria-label="New chat"
          onClick={() => contextual.newChat?.()}
          className="p-1.5 -mr-1 rounded-lg text-slate-300 hover:bg-[#ffffff0a] transition-colors"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
          </svg>
        </button>
      )}
    </header>
  );
}

function MobileDrawer() {
  const { drawerOpen, setDrawerOpen, contextual } = useAppChrome();
  const pathname = usePathname();
  const { t } = useLang();
  const clean = cleanPath(pathname);

  // Close the drawer whenever the route changes (e.g. after tapping a product).
  useEffect(() => { setDrawerOpen(false); }, [pathname, setDrawerOpen]);

  // Escape closes.
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setDrawerOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen, setDrawerOpen]);

  if (!drawerOpen) return null;

  const hasContextual = contextual && (contextual.items.length > 0 || (contextual.recents?.length ?? 0) > 0);

  return (
    <div className="lg:hidden fixed inset-0 z-[90]">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setDrawerOpen(false)} />

      <aside className="absolute left-0 top-0 h-full w-[300px] max-w-[86vw] bg-[#070710] border-r border-[#1A1A2E] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between h-14 px-4 border-b border-[#1A1A2E] shrink-0">
          <div className="flex items-center gap-2">
            <img src="/logomark.svg" alt="" className="h-6 w-6 rounded-md" />
            <span className="font-mono text-[12px] text-white tracking-wide">
              BLUE<span className="text-[#4FC3F7]">AGENT</span>
            </span>
          </div>
          <button
            aria-label="Close menu"
            onClick={() => setDrawerOpen(false)}
            className="p-1.5 rounded-lg text-slate-500 hover:text-slate-200 hover:bg-[#ffffff0a] transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto py-2">
          {/* New chat — primary action, prominent + easy to tap. */}
          {contextual?.newChat && (
            <div className="px-2 pt-1 pb-2">
              <button
                onClick={() => { contextual.newChat?.(); setDrawerOpen(false); }}
                className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl transition-colors active:scale-[0.99]"
                style={{ background: "#4FC3F715", border: "1px solid #4FC3F730" }}
              >
                <svg className="w-4 h-4 text-[#4FC3F7] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                </svg>
                <span className="font-mono text-[13px] font-semibold text-[#4FC3F7]">New chat</span>
              </button>
            </div>
          )}

          {/* Contextual utilities + recents (chat sub-nav, etc.) */}
          {hasContextual && (
            <div className="px-2 pb-2 border-t border-[#13131f] pt-2">
              {contextual!.items.map((item) => (
                <button
                  key={item.id}
                  onClick={() => { item.onSelect(); setDrawerOpen(false); }}
                  className="w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-colors hover:bg-[#ffffff06]"
                  style={item.active ? { background: "#4FC3F712" } : undefined}
                >
                  {item.icon && <span className="w-4 text-center shrink-0 text-sm leading-none">{item.icon}</span>}
                  <span className="font-mono text-[13px]" style={{ color: item.active ? "#4FC3F7" : "#cbd5e1" }}>
                    {item.label}
                  </span>
                </button>
              ))}

              {contextual!.recents && contextual!.recents.length > 0 && (
                <>
                  <p className="px-3 pt-3 pb-1 font-mono text-[9px] text-slate-600 tracking-widest uppercase">Recents</p>
                  {contextual!.recents.map((r) => (
                    <button
                      key={r.id}
                      onClick={() => { r.onSelect(); setDrawerOpen(false); }}
                      className="w-full text-left flex items-center gap-2 px-3 py-1.5 rounded-lg transition-colors hover:bg-[#ffffff06]"
                    >
                      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: r.active ? "#4FC3F7" : "#334155" }} />
                      <span className="font-mono text-[12px] truncate" style={{ color: r.active ? "#ffffff" : "#94a3b8" }}>
                        {r.title}
                      </span>
                    </button>
                  ))}
                </>
              )}
            </div>
          )}

          {/* Product groups — same three groups as desktop. */}
          {NAV_GROUPS.map((group) => (
            <div key={group.id} className="px-2 pt-1 border-t border-[#13131f] mt-1">
              <p className="px-3 pt-3 pb-1 font-mono text-[9px] text-slate-600 tracking-widest uppercase">
                {t(`nav.${group.id}`)}
              </p>
              {group.items.map((item) => {
                const active = clean === item.href || clean.startsWith(item.href + "/");
                return (
                  <Link
                    key={item.id}
                    href={item.href}
                    onClick={() => setDrawerOpen(false)}
                    className="w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-colors hover:bg-[#ffffff06]"
                    style={active ? { background: "#4FC3F712" } : undefined}
                  >
                    <span className="relative shrink-0" style={{ color: active ? "#4FC3F7" : "#64748b" }}>
                      {item.icon}
                      {item.badge === "hood" && <HoodNavBadge />}
                    </span>
                    <span className="font-mono text-[13px]" style={{ color: active ? "#4FC3F7" : "#cbd5e1" }}>
                      {t(`nav.${item.id}`)}
                    </span>
                  </Link>
                );
              })}
            </div>
          ))}

          {/* Back to marketing */}
          <div className="px-2 pt-1 border-t border-[#13131f] mt-1">
            <a
              href="https://blueagent.dev"
              className="w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-colors hover:bg-[#ffffff06] text-slate-500"
            >
              <span className="shrink-0">{IconHome}</span>
              <span className="font-mono text-[13px]">{t("nav.home")}</span>
            </a>
          </div>
        </div>
      </aside>
    </div>
  );
}

// ── Layout ─────────────────────────────────────────────────────────────────────

export default function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <AppChromeProvider>
      <div className="flex h-screen w-screen overflow-hidden bg-[#050508]">
        <AppSideNav />
        <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
          <MobileTopBar />
          <main className="flex-1 min-h-0 overflow-hidden flex flex-col">
            {children}
          </main>
        </div>
        <MobileDrawer />
      </div>
    </AppChromeProvider>
  );
}
