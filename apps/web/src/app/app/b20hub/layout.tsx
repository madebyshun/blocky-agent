import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "B20HUB — Fair-launch B20 tokens on Base",
  description:
    "Launch a real B20 token on Base with an auto Uniswap V4 pool and permanent LP lock. Every swap routes 80% to creator, 15% to $BLUE buyback, 5% to treasury. Trustless, uniform opening price, no upfront fees.",
};

/**
 * Shell for all B20HUB pages. Kept as a plain layout — no chrome sidebar,
 * no auth wall, just a top bar + centered content. If we ever split B20HUB
 * off onto its own domain (e.g. b20hub.blue), copy this layout + the
 * pages under it verbatim; the only path change needed is stripping the
 * `/app/b20hub` prefix from internal Link hrefs.
 */
export default function B20HUBLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-[#050508] text-slate-200">
      <B20HUBHeader />
      <main className="max-w-6xl mx-auto px-4 py-8">{children}</main>
      <B20HUBFooter />
    </div>
  );
}

function B20HUBHeader() {
  return (
    <header className="border-b border-[#1A1A2E] bg-[#050508]/80 backdrop-blur-sm sticky top-0 z-20">
      <div className="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between">
        <Link href="/app/b20hub" className="flex items-center gap-2">
          <span
            className="w-6 h-6 rounded-md flex items-center justify-center text-[10px] font-bold"
            style={{ background: "#4FC3F715", color: "#4FC3F7", border: "1px solid #4FC3F740" }}
          >
            B
          </span>
          <span className="font-mono text-sm font-bold">B20HUB</span>
          <span className="font-mono text-[9px] text-slate-600 tracking-widest uppercase">
            · by BlueAgent
          </span>
        </Link>
        <nav className="flex items-center gap-1">
          <NavLink href="/app/b20hub">Feed</NavLink>
          <NavLink href="/app/b20hub/launch">Launch</NavLink>
          <NavLink href="/app/b20hub/claim">Claim</NavLink>
          <NavLink href="/app/b20hub/docs">Docs</NavLink>
        </nav>
      </div>
    </header>
  );
}

function NavLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="font-mono text-[11px] text-slate-400 hover:text-white px-2.5 py-1 rounded-lg hover:bg-[#0d0d16] transition-colors"
    >
      {children}
    </Link>
  );
}

function B20HUBFooter() {
  return (
    <footer className="border-t border-[#1A1A2E] mt-16">
      <div className="max-w-6xl mx-auto px-4 py-6 flex items-center justify-between font-mono text-[10px] text-slate-600">
        <span>B20HUB · trustless launchpad · Base mainnet</span>
        <div className="flex items-center gap-3">
          <Link href="/app/b20hub/docs" className="hover:text-slate-400 transition-colors">
            docs
          </Link>
          <a
            href="https://basescan.org/address/0xB20f000000000000000000000000000000000000"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-slate-400 transition-colors"
          >
            b20 factory ↗
          </a>
          <a
            href="https://x.com/blueagent_"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-slate-400 transition-colors"
          >
            @blueagent_ ↗
          </a>
        </div>
      </div>
    </footer>
  );
}
