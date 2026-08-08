"use client";
import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import LanguageToggle from "@/components/LanguageToggle";
import { useLang } from "@/lib/i18n/context";

// `soul` was `skills` → `/skills` until 2026-08. The page is the SOUL.md
// identity spec, and /skills now belongs to the app's installed-skill catalog
// (app.blueagent.dev/skills), so both the label and the path moved.
const NAV_LINKS = [
  { key: "about", href: "/about" },
  { key: "soul",  href: "/soul" },
  { key: "docs",  href: "/docs" },
];

export default function Navbar() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const { t } = useLang();
  const isActive = (href: string) => pathname.startsWith(href);

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 border-b border-[#1A1A2E] bg-[#050508]/90 backdrop-blur-xl">
      <div className="relative flex items-center h-14 px-6 sm:px-10">

        {/* ── Logo ── */}
        <Link href="/" className="flex items-center gap-2.5 shrink-0 mr-8">
          <img src="/logomark.svg" alt="Blue Agent" className="h-6 w-6 rounded-md" />
          <span className="hidden sm:inline font-mono font-bold text-white tracking-widest text-[13px]">
            BLUE<span className="text-[#4FC3F7]">AGENT</span>
          </span>
        </Link>

        {/* ── Desktop nav — absolutely centered ── */}
        <div className="hidden md:flex items-center gap-0.5 absolute left-1/2 -translate-x-1/2">
          {NAV_LINKS.map((item) => {
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className="relative font-mono text-[13px] px-4 py-1.5 rounded-lg transition-all"
                style={active
                  ? { color: "#4FC3F7" }
                  : { color: "#64748b" }}
              >
                <span className="relative z-10 hover:text-slate-200 transition-colors">
                  {t(`nav_marketing.${item.key}`)}
                </span>
                {active && (
                  <span
                    className="absolute inset-0 rounded-lg"
                    style={{ background: "#4FC3F710", border: "1px solid #4FC3F720" }}
                  />
                )}
              </Link>
            );
          })}
        </div>

        {/* ── Right actions ── */}
        <div className="hidden md:flex items-center gap-3 ml-auto shrink-0">
          {/* Language toggle — EN | 中文 (shared cookie syncs marketing + app) */}
          <LanguageToggle />

          {/* X / Twitter */}
          <a
            href="https://x.com/blueagent_"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="X / Twitter"
            className="flex items-center justify-center w-8 h-8 rounded-lg text-slate-600 hover:text-slate-300 hover:bg-[#1A1A2E] transition-all"
          >
            <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.748l7.73-8.835L1.254 2.25H8.08l4.253 5.622zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
            </svg>
          </a>

          {/* Divider */}
          <div className="w-px h-4 bg-[#1A1A2E]" />

          {/* CTA */}
          <Link
            href="/app/chat"
            className="font-mono text-[12px] font-semibold px-4 py-1.5 rounded-lg transition-all hover:opacity-90 active:scale-95"
            style={{
              background: "linear-gradient(135deg, #4FC3F7, #29ABE2)",
              color: "#050508",
              boxShadow: "0 0 16px #4FC3F730",
            }}
          >
            {t("nav_marketing.launch_app")}
          </Link>
        </div>

        {/* ── Mobile hamburger ── */}
        <button
          className="md:hidden ml-auto text-slate-500 hover:text-white p-1.5 rounded-lg transition-colors"
          onClick={() => setOpen(!open)}
          aria-label="Toggle menu"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            {open
              ? <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              : <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />}
          </svg>
        </button>
      </div>

      {/* ── Mobile menu ── */}
      {open && (
        <div className="md:hidden border-t border-[#1A1A2E] bg-[#050508] px-4 py-3">
          <div className="flex flex-col gap-0.5 mb-3">
            {NAV_LINKS.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                className="font-mono text-sm px-4 py-2.5 rounded-lg transition-all"
                style={isActive(item.href)
                  ? { color: "#4FC3F7", background: "#4FC3F710" }
                  : { color: "#94a3b8" }}
              >
                {t(`nav_marketing.${item.key}`)}
              </Link>
            ))}
          </div>
          <div className="border-t border-[#1A1A2E] pt-3 flex items-center justify-between px-1 mb-3">
            <a
              href="https://x.com/blueagent_"
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-xs text-slate-600 hover:text-slate-400 transition-colors tracking-wider"
            >
              @blueagent_
            </a>
            <Link
              href="/app/chat"
              onClick={() => setOpen(false)}
              className="font-mono text-[12px] font-semibold px-4 py-1.5 rounded-lg"
              style={{
                background: "linear-gradient(135deg, #4FC3F7, #29ABE2)",
                color: "#050508",
              }}
            >
              {t("nav_marketing.launch_app")}
            </Link>
          </div>
          {/* Language toggle (mobile) */}
          <div className="flex justify-center pt-1">
            <LanguageToggle />
          </div>
        </div>
      )}
    </nav>
  );
}
