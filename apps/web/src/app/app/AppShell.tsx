"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { AppChromeProvider, useAppChrome } from "./AppChrome";
import LanguageToggle from "@/components/LanguageToggle";
import { useLang } from "@/lib/i18n/context";

// T-D D1 — small self-contained client component. Polls
// `/api/hood/inbox/unread-count` every 30s and shows a red dot with the
// count on the Hood nav item. Only mounted when the Hood nav item
// renders, so other nav items don't trigger the fetch.
function HoodNavBadge() {
  const [n, setN] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch("/api/hood/inbox/unread-count", { cache: "no-store" });
        if (!r.ok) return;
        const body = (await r.json()) as { unread?: number };
        if (alive && typeof body.unread === "number") setN(body.unread);
      } catch { /* offline is fine */ }
    };
    load();
    const t = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(t); };
  }, []);
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

// ── Nav items ─────────────────────────────────────────────────────────────────

const APP_NAV = [
  {
    id: "chat",
    label: "Chat",
    href: "/chat",
    icon: (
      <svg style={{ width: 18, height: 18 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round"
          d="M8.625 9.75a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H8.25m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H12m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0h-.375m-13.5 3.01c0 1.6 1.123 2.994 2.707 3.227 1.087.16 2.185.283 3.293.369V21l4.184-4.183a1.14 1.14 0 0 1 .778-.332 48.294 48.294 0 0 0 5.83-.498c1.585-.233 2.708-1.626 2.708-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z" />
      </svg>
    ),
  },
  {
    id: "hub",
    label: "Hub",
    href: "/hub",
    icon: (
      <svg style={{ width: 18, height: 18 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round"
          d="M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6ZM3.75 15.75A2.25 2.25 0 0 1 6 13.5h2.25a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18v-2.25ZM13.5 6a2.25 2.25 0 0 1 2.25-2.25H18A2.25 2.25 0 0 1 20.25 6v2.25A2.25 2.25 0 0 1 18 10.5h-2.25a2.25 2.25 0 0 1-2.25-2.25V6ZM13.5 15.75a2.25 2.25 0 0 1 2.25-2.25H18a2.25 2.25 0 0 1 2.25 2.25V18A2.25 2.25 0 0 1 18 20.25h-2.25A2.25 2.25 0 0 1 13.5 18v-2.25Z" />
      </svg>
    ),
  },
  // Feed nav item removed — Blue Feed is hidden while it's rebuilt (route /feed
  // returns 404 + noindex). Restore this entry when the feed relaunches.
  //
  // BlueAgent Relaunch (Robinhood Chain "Builder OS" positioning, 2026-07-24):
  //   HIDDEN from primary nav: `bank`, `launches`, `b20`. Reasons:
  //   - Blue Bank: underdeveloped, no immediate roadmap → archive + redirect
  //     (see middleware.ts). All /bank + /pay/[address] routes redirect to /app.
  //   - Launches + B20: moved conceptually under Hub (task #78 B20HUB still
  //     WIP). Direct URL access preserved for dev, but hidden from sidebar
  //     to keep nav to the 9-item blueprint (See · Act · Automate · Build).
  //   Restore any of them by re-adding the object below the "id: hood" entry.
  {
    id: "hood",
    label: "Hood",
    href: "/hood",
    icon: (
      // Arrow-through-hood glyph — Blue Hood is the 24/7 Robinhood Chain
      // copilot; the arrow motif carries into every serial + inbox card.
      <svg style={{ width: 18, height: 18 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round"
          d="M3.75 12h16.5m0 0-6-6m6 6-6 6" />
        <path strokeLinecap="round" strokeLinejoin="round"
          d="M3.75 4.5v15" />
      </svg>
    ),
  },
  {
    id: "dashboard",
    label: "Dashboard",
    // Dashboard now hosts Overview + Stake + Alerts as tabs; the standalone
    // /app/rewards and /app/alerts entries are gone from the sidebar (they
    // redirect into the right tab for anyone hitting old links).
    href: "/dashboard",
    icon: (
      <svg style={{ width: 18, height: 18 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round"
          d="M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6ZM3.75 15.75A2.25 2.25 0 0 1 6 13.5h2.25a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18v-2.25ZM13.5 6a2.25 2.25 0 0 1 2.25-2.25H18A2.25 2.25 0 0 1 20.25 6v2.25A2.25 2.25 0 0 1 18 10.5h-2.25a2.25 2.25 0 0 1-2.25-2.25V6ZM13.5 15.75a2.25 2.25 0 0 1 2.25-2.25H18a2.25 2.25 0 0 1 2.25 2.25V18A2.25 2.25 0 0 1 18 20.25h-2.25A2.25 2.25 0 0 1 13.5 18v-2.25Z" />
      </svg>
    ),
  },
];

const APP_BOTTOM = [
  // Profile was collapsed into the dashboard (0.1 route consolidation, 2026-07):
  // "me looking at me" (wallet, holdings, stake, alerts) all live in
  // /app/dashboard now; the public identity card is /agent/[handle] +
  // /builder/[handle]. Both old /profile routes 301 → /dashboard, so there's no
  // Profile nav entry anymore.
  {
    id: "docs",
    label: "Docs",
    href: "/docs/blue-chat",
    icon: (
      <svg style={{ width: 18, height: 18 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round"
          d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
      </svg>
    ),
  },
];

// ── Sidebar ────────────────────────────────────────────────────────────────────

function AppSideNav() {
  const pathname = usePathname();
  const { t } = useLang();

  // The app surface is served on app.blueagent.dev under clean, /app-less URLs
  // (middleware rewrites /chat → /app/chat internally), so usePathname() returns
  // the clean path here — compare nav hrefs against that, not against /app/*.
  const isActive = (href: string) => {
    return pathname === href || pathname.startsWith(href + "/");
  };

  return (
    <aside className="hidden md:flex flex-col w-[72px] shrink-0 border-r border-[#1A1A2E] h-full bg-[#050508]">

      {/* Logo */}
      <div className="flex items-center justify-center h-14 border-b border-[#1A1A2E] shrink-0">
        <a href="https://blueagent.dev" title="blueagent.dev">
          <img
            src="/logomark.svg"
            alt="Blue Agent"
            className="h-7 w-7 rounded-lg hover:opacity-75 transition-opacity"
          />
        </a>
      </div>

      {/* Primary nav */}
      <nav className="flex flex-col items-center gap-0.5 pt-2 flex-1 px-2">
        {NAV_ITEMS.map((item) => {
          const active = isActive(item.href);
          const isExt = !!(item as { external?: boolean }).external;
          const navCls = "group relative flex flex-col items-center justify-center gap-0.5 w-full h-[50px] rounded-xl transition-all";
          const navInner = (
            <>
              <span className="group-hover:text-slate-300 transition-colors relative">
                {item.icon}
                {/* T-D D1 — unread badge for Blue Hood inbox. Only mounts
                    for the Hood nav item; other items skip the client fetch. */}
                {item.id === "hood" && <HoodNavBadge />}
              </span>
              <span
                className="font-mono text-[7px] tracking-wide transition-colors group-hover:text-slate-400 truncate max-w-[56px] text-center"
                style={{ color: active ? "#4FC3F7" : undefined }}
              >
                {t(`nav.${item.id}`)}
              </span>
              {/* Active left-bar indicator */}
              {active && (
                <span className="absolute -left-2 top-1/2 -translate-y-1/2 w-0.5 h-5 rounded-r-full bg-[#4FC3F7]"
                  style={{ boxShadow: "0 0 6px #4FC3F780" }} />
              )}
            </>
          );
          if (isExt) {
            return (
              <a key={item.id} href={item.href} target="_blank" rel="noopener noreferrer"
                className={navCls} style={{ color: "#334155" }}>
                {navInner}
              </a>
            );
          }
          return (
            <Link
              key={item.id}
              href={item.href}
              className={navCls}
              style={
                active
                  ? { color: "#4FC3F7", background: "#4FC3F712", boxShadow: "0 0 0 1px #4FC3F720" }
                  : { color: "#334155" }
              }
            >
              {navInner}
            </Link>
          );
        })}
      </nav>

      {/* Bottom items */}
      <div className="flex flex-col items-center gap-0.5 pb-3 px-2">

        {APP_BOTTOM.map((item) => {
          const active = isActive(item.href);
          return (
            <Link
              key={item.id}
              href={item.href}
              className="group relative flex flex-col items-center justify-center gap-0.5 w-full h-[46px] rounded-xl transition-all"
              style={
                active
                  ? { color: "#4FC3F7", background: "#4FC3F712" }
                  : { color: "#334155" }
              }
            >
              <span className="group-hover:text-slate-400 transition-colors">
                {item.icon}
              </span>
              <span className="font-mono text-[7px] tracking-wide text-slate-700 group-hover:text-slate-500 transition-colors">
                {t(`nav.${item.id}`)}
              </span>
            </Link>
          );
        })}

        {/* Divider */}
        <div className="w-8 h-px bg-[#1A1A2E] my-0.5" />

        {/* Language toggle — EN / 中文 (vertical to fit the 72px rail) */}
        <div className="px-1 w-full">
          <LanguageToggle vertical />
        </div>

        {/* Back to marketing site */}
        <a
          href="https://blueagent.dev"
          className="group relative flex flex-col items-center justify-center gap-0.5 w-full h-[46px] rounded-xl text-[#283040] hover:text-slate-500 transition-colors"
        >
          <svg style={{ width: 16, height: 16 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round"
              d="m2.25 12 8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25" />
          </svg>
          <span className="font-mono text-[7px] tracking-wide text-slate-700 group-hover:text-slate-500 transition-colors">
            {t("nav.home")}
          </span>
        </a>
      </div>
    </aside>
  );
}

// ── Mobile chrome (top bar + drawer) ────────────────────────────────────────────
// Replaces the old bottom tab bar. Claude-style: a hamburger top bar opens a
// slide-out drawer that holds BOTH the product destinations and (when a page
// registers it) that page's contextual sub-nav — e.g. Blue Chat's Models /
// Tools / Skills / Scheduled and recent conversations. Shown below lg so the
// tablet gap (md rail, no chat sidebar) keeps full nav access.

// BlueBank is live — show in sidebar on all environments.
// Access is gated by BANK_PREVIEW_TOKEN cookie in middleware.
const NAV_ITEMS = APP_NAV;

const PRODUCTS = [...NAV_ITEMS, ...APP_BOTTOM];

// Mobile drawer products — Docs lives in Settings (mobile), so it's dropped
// from the drawer's product list. (Profile was removed entirely in the 0.1
// route consolidation — it no longer appears in PRODUCTS.)
const DRAWER_PRODUCTS = PRODUCTS.filter(i => i.id !== "docs");

// Returns the nav id for the current path so the title can be translated via
// t(`nav.${id}`); falls back to null (→ generic "Blue Agent" brand label).
function navIdForPath(pathname: string): string | null {
  const match = PRODUCTS.find(i => pathname === i.href || pathname.startsWith(i.href + "/"));
  return match?.id ?? null;
}

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
      {/* Language toggle — EN | 中文 */}
      <LanguageToggle />
      {/* One-tap New chat (compose) — ChatGPT-style, no need to open the drawer. */}
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

          {/* Contextual utilities (Scheduled · Settings) + recents */}
          {hasContextual && (
            <div className="px-2 pb-2 border-t border-[#13131f] pt-2">
              {contextual!.items.map(item => (
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
                  {contextual!.recents.map(r => (
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

          {/* Products group */}
          <div className="px-2 pt-1 border-t border-[#13131f] mt-1">
            <p className="px-3 pt-3 pb-1 font-mono text-[9px] text-slate-600 tracking-widest uppercase">Products</p>
            {DRAWER_PRODUCTS.map(item => {
              const active = pathname === item.href || pathname.startsWith(item.href + "/");
              const isExt = !!(item as { external?: boolean }).external;
              const drawerCls = "w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-colors hover:bg-[#ffffff06]";
              const drawerInner = (
                <>
                  <span className="shrink-0" style={{ color: active ? "#4FC3F7" : "#64748b" }}>{item.icon}</span>
                  <span className="font-mono text-[13px]" style={{ color: active ? "#4FC3F7" : "#cbd5e1" }}>{t(`nav.${item.id}`)}</span>
                  {isExt && <span className="ml-auto font-mono text-[9px] text-slate-600">↗</span>}
                </>
              );
              if (isExt) {
                return (
                  <a key={item.id} href={item.href} target="_blank" rel="noopener noreferrer"
                    onClick={() => setDrawerOpen(false)}
                    className={drawerCls}>
                    {drawerInner}
                  </a>
                );
              }
              return (
                <Link
                  key={item.id}
                  href={item.href}
                  onClick={() => setDrawerOpen(false)}
                  className={drawerCls}
                  style={active ? { background: "#4FC3F712" } : undefined}
                >
                  {drawerInner}
                </Link>
              );
            })}
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
