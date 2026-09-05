"use client";

// The account control at the foot of the app sidebar: who you are, and the four
// places that are about YOU rather than about the product.
//
// WHY IT EXISTS: the shell had a nav group LABELLED "Account" that contained
// Plans and Docs — a pricing page and a manual. There was no route to your own
// profile, no way to see which identity was signed in, and no sign-out anywhere
// except buried inside the wallet picker modal. You could be signed in as one
// person, looking at another person's balance, with nothing on screen naming
// either.
//
// WHAT IT DELIBERATELY DOES NOT DO: it shows no balance, no credit count and no
// spend figure. Those live on /wallet and /usage, which this menu links to. A
// number rendered in two places is a number that can disagree with itself —
// that defect was just removed from the wallet page and is not being re-added
// one component over.

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useWallet } from "@/hooks/useWallet";
import { usePrivyIdentity } from "@/lib/privy/identity-bridge";
import { resolveIdentity, type IdentitySource } from "@/lib/identity/account-identity";
import { WalletPickerModal } from "@/components/WalletPicker";
import Avatar from "@/components/Avatar";

/** Provenance line — says HOW you are signed in, so two sessions aren't confused. */
const SOURCE_LABEL: Record<IdentitySource, string> = {
  twitter: "X account",
  telegram: "Telegram",
  farcaster: "Farcaster",
  google: "Google",
  github: "GitHub",
  discord: "Discord",
  email: "Email",
  basename: "Basename",
  address: "Wallet",
};

const ITEMS: { href: string; label: string; hint: string }[] = [
  { href: "/profile", label: "Profile", hint: "Identity & connected accounts" },
  { href: "/usage", label: "Usage", hint: "Credits & agent spend" },
  { href: "/plans", label: "Plans", hint: "Tiers & top-ups" },
];

export default function AccountMenu({
  collapsed = false,
  /**
   * Fired after the menu takes the user somewhere (a link, or sign-out) — NOT
   * when the menu merely opens. The mobile drawer passes its own close here.
   * Wrapping this component in an `onClick` that closes the drawer instead
   * would close it on the very click that opens the dropdown, so the menu could
   * never be seen at that breakpoint.
   */
  onNavigate,
}: {
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  const { address, isConnected, basename, label, disconnect } = useWallet();
  // `null` on the Privy-off tree — then the account is wallet-only by definition.
  const privy = usePrivyIdentity();
  const [open, setOpen] = useState(false);
  const [picker, setPicker] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const identity = resolveIdentity({
    social: privy?.social ?? null,
    basename: basename ?? null,
    address: address ?? null,
    shortAddress: address ? (label ?? null) : null,
  });

  // Signed in on EITHER rail. Privy-authenticated users always have a wallet,
  // but the wallet can lag the session by a tick, so treating "authenticated"
  // as signed-in avoids flashing the connect button at someone who just logged in.
  const signedIn = isConnected || !!privy?.authenticated;

  const close = useCallback(() => setOpen(false), []);

  // Escape closes. Registered only while open so the shell isn't listening for
  // keys on every page for a menu nobody has touched.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  const signOut = useCallback(() => {
    // Both rails, always, in this order. `logout()` ends the Privy session;
    // `disconnect()` additionally RECORDS the explicit-disconnect intent, which
    // is what stops BaseAppAutoConnect silently re-binding the host wallet on
    // the next render. Calling only one of them leaves the user signed out of a
    // thing they can watch reconnect itself.
    privy?.logout();
    disconnect();
    close();
    onNavigate?.();
  }, [privy, disconnect, close, onNavigate]);

  // ── Signed out ────────────────────────────────────────────────────────────
  if (!signedIn) {
    return (
      <>
        <button
          onClick={() => setPicker(true)}
          title={collapsed ? "Sign in" : undefined}
          className={`group flex items-center rounded-lg h-9 w-full transition-colors hover:bg-[#ffffff06] ${
            collapsed ? "justify-center" : "gap-3 px-3"
          }`}
        >
          <span
            className="shrink-0 w-[22px] h-[22px] rounded-full border border-dashed border-[#283040] flex items-center justify-center text-[#4FC3F7]"
            aria-hidden
          >
            <svg style={{ width: 12, height: 12 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
          </span>
          {!collapsed && (
            <span className="font-mono text-[12px] tracking-wide text-slate-500 group-hover:text-slate-300 transition-colors">
              Sign in
            </span>
          )}
        </button>
        <WalletPickerModal open={picker} onClose={() => setPicker(false)} />
      </>
    );
  }

  // ── Signed in ─────────────────────────────────────────────────────────────
  return (
    <div className="relative" ref={rootRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        title={collapsed ? (identity.displayName ?? "Account") : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`group flex items-center rounded-lg h-11 w-full transition-colors hover:bg-[#ffffff06] ${
          collapsed ? "justify-center" : "gap-2.5 px-2"
        } ${open ? "bg-[#ffffff08]" : ""}`}
      >
        <Avatar
          photoUrl={identity.photoUrl}
          initials={identity.initials}
          colorSeed={identity.colorSeed}
          size={collapsed ? 24 : 28}
        />
        {!collapsed && (
          <>
            <span className="min-w-0 flex-1 text-left">
              <span className="block font-mono text-[12px] text-slate-300 truncate group-hover:text-white transition-colors">
                {identity.displayName ?? "Account"}
              </span>
              {identity.secondary && (
                <span className="block font-mono text-[9px] text-slate-600 truncate">
                  {identity.secondary}
                </span>
              )}
            </span>
            <svg
              style={{ width: 14, height: 14 }}
              className="shrink-0 text-slate-600 transition-transform"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
              aria-hidden
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 15 3.75 3.75L15.75 15m-7.5-6L12 5.25 15.75 9" />
            </svg>
          </>
        )}
      </button>

      {open && (
        <>
          {/* Backdrop first in the DOM but below the panel — one click anywhere
              closes, and it also swallows the click so the page underneath does
              not act on it. */}
          <div className="fixed inset-0 z-40" onClick={close} aria-hidden />
          <div
            role="menu"
            className={`absolute z-50 bottom-full mb-2 rounded-xl border border-[#1A1A2E] bg-[#0A0A12] shadow-2xl overflow-hidden ${
              collapsed ? "left-0 w-[220px]" : "left-0 right-0"
            }`}
          >
            {/* Identity header — repeats the name on purpose. When collapsed, the
                button shows only a swatch, so without this the menu would be
                four links belonging to nobody in particular. */}
            <div className="flex items-center gap-2.5 px-3 py-3 border-b border-[#141420]">
              <Avatar
                photoUrl={identity.photoUrl}
                initials={identity.initials}
                colorSeed={identity.colorSeed}
                size={32}
              />
              <div className="min-w-0">
                <p className="font-mono text-[12px] text-white truncate">
                  {identity.displayName ?? "Account"}
                </p>
                <p className="font-mono text-[9px] text-slate-600 truncate">
                  {identity.source ? SOURCE_LABEL[identity.source] : "Signed in"}
                  {identity.secondary ? ` · ${identity.secondary}` : ""}
                </p>
              </div>
            </div>

            <div className="py-1">
              {ITEMS.map((it) => (
                <Link
                  key={it.href}
                  href={it.href}
                  role="menuitem"
                  onClick={() => { close(); onNavigate?.(); }}
                  className="block px-3 py-2 hover:bg-[#1A1A2E] transition-colors"
                >
                  <span className="block font-mono text-[12px] text-slate-300">{it.label}</span>
                  <span className="block font-mono text-[9px] text-slate-600">{it.hint}</span>
                </Link>
              ))}
            </div>

            <div className="border-t border-[#141420]">
              <button
                role="menuitem"
                onClick={signOut}
                className="w-full text-left px-3 py-2.5 hover:bg-[#1A1A2E] transition-colors font-mono text-[12px] text-slate-500 hover:text-slate-300"
              >
                Sign out
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
