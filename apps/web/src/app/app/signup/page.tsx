"use client";

// /signup — the front door. One page that says who can sign in, with what, and
// what signing in actually changes.
//
// WHY IT EXISTS: there was no sign-up page at all. The only way in was a wallet
// picker modal reached from the sidebar, whose top row said "Sign in with email,
// Google, or X" and then opened a hosted modal to choose between them. That is a
// menu inside a menu, and it is unlinkable — you cannot send someone a URL that
// means "create an account".
//
// ── THE HONESTY CONSTRAINTS, all of them measured ───────────────────────────
//
// 1. THE BUTTONS ARE DERIVED, NEVER TYPED OUT. Every provider row comes from
//    `PRIVY_LOGIN_METHODS`, which is parsed from `NEXT_PRIVY_LOGIN_METHODS`.
//    Hardcoding "Google / GitHub / Discord" here would produce a button that
//    opens a modal without that provider the moment the env var is edited —
//    the exact defect `describeLoginMethods()` was written to prevent (see the
//    header of lib/privy/config.ts).
//
// 2. NO PROFILE PHOTO IS PROMISED FOR THE SOCIAL LOGINS THIS APP OFFERS.
//    Read off the installed `@privy-io/react-auth` types: Google, GitHub and
//    Discord return NO picture field. Only Twitter, Telegram and Farcaster do.
//    So the "you get an avatar" line says the avatar is DRAWN from the name,
//    and the preview below it renders the real `Avatar` component so the claim
//    and the artefact are the same thing.
//
// 3. WHEN PRIVY IS OFF, NOTHING SOCIAL IS SHOWN. `PRIVY_ENABLED` is false
//    whenever `NEXT_PUBLIC_PRIVY_APP_ID` is unset — which is every local dev
//    environment today. The page then offers the wallet path only and says so,
//    rather than rendering dead buttons that throw on click.
//
// 4. WHAT SIGNING UP GIVES YOU IS COMPUTED, NOT ASSERTED. The allowance numbers
//    and the multiplier come from `GUEST_DAILY`/`WALLET_DAILY` in lib/credits —
//    the same constants the ledger debits against. And the page states the
//    NEGATIVE too: signing in unlocks no model and no tool. It multiplies an
//    allowance. Selling anything more would be the "tiers that gate nothing"
//    defect the Plans rebuild just removed.
//
// ── WHY IT LIVES UNDER src/app/app/ ─────────────────────────────────────────
// `signup` is registered in `APP_SEGMENTS` (middleware.ts). It must be: on the
// app host, ANY first segment that is not an app segment 301s to the marketing
// host. A root `/signup` would therefore bounce a signed-in-progress user from
// app.blueagent.dev to blueagent.dev mid-flow, and the Privy session is
// per-origin — so the redirect would strand the very session the page exists to
// create.
//
// ── NO BRAND LOGOS, deliberately ────────────────────────────────────────────
// The reference design puts a coloured mark on each row. This app just finished
// a pass that removed decorative colour down to one accent, and seven OAuth
// brand palettes would undo it in a single component — plus each mark is a
// third-party asset with its own usage terms. Text rows, one accent.

import { useState } from "react";
import Link from "next/link";
import { useWallet } from "@/hooks/useWallet";
import { WalletPickerModal } from "@/components/WalletPicker";
import { usePrivyIdentity } from "@/lib/privy/identity-bridge";
import { resolveIdentity } from "@/lib/identity/account-identity";
import Avatar from "@/components/Avatar";
import {
  PRIVY_ENABLED,
  PRIVY_LOGIN_METHODS,
  loginMethodLabel,
  type LoginMethod,
} from "@/lib/privy/config";
import { GUEST_DAILY, WALLET_DAILY } from "@/lib/credits";

const ACCENT = "#4FC3F7";

// Email gets a text field instead of a button, so it is pulled out of the row
// list. Everything else — including `sms`, whose modal collects a phone number
// the same way — renders as one row.
const EMAIL_METHOD: LoginMethod = "email";

/**
 * Good enough to decide whether to PREFILL, and nothing more.
 *
 * Privy's modal is the authority on whether an address is real; it re-validates
 * and it is the thing that sends the code. This check only answers "is this
 * worth handing over", because prefilling a half-typed string would drop the
 * user into the modal with a value they then have to clear.
 */
function looksLikeEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

export default function SignUpPage() {
  const { isConnected, address, basename, label } = useWallet();
  // `null` on the Privy-off tree — then there is no social path at all.
  const privy = usePrivyIdentity();
  const [email, setEmail] = useState("");
  const [picker, setPicker] = useState(false);

  const identity = resolveIdentity({
    social: privy?.social ?? null,
    basename: basename ?? null,
    address: address ?? null,
    shortAddress: address ? (label ?? null) : null,
  });

  // Same rule as the account menu: a Privy-authenticated user always ends up
  // with a wallet, but the wallet can lag the session by a render, so treating
  // "authenticated" as signed-in avoids showing the sign-up form to someone who
  // has just finished using it.
  const signedIn = isConnected || !!privy?.authenticated;

  // Split once, here, so the two render paths below cannot disagree about which
  // methods exist. Both are empty when Privy is off.
  const social = PRIVY_ENABLED ? PRIVY_LOGIN_METHODS.filter((m) => m !== EMAIL_METHOD) : [];
  const hasEmail = PRIVY_ENABLED && PRIVY_LOGIN_METHODS.includes(EMAIL_METHOD);

  const allowanceMultiplier = Math.round(WALLET_DAILY / GUEST_DAILY);

  function continueWithEmail(e: React.FormEvent) {
    e.preventDefault();
    const value = email.trim();
    // `loginMethods` narrows Privy's hosted modal to one method, so this button
    // opens an email prompt rather than the full provider menu — the whole
    // reason the page can offer per-provider rows at all.
    privy?.login(
      looksLikeEmail(value)
        ? { loginMethods: [EMAIL_METHOD], prefill: { type: "email", value } }
        : { loginMethods: [EMAIL_METHOD] },
    );
  }

  return (
    <div className="flex flex-col h-full bg-[#050508] overflow-hidden">
      {/* Header — matches every other app page rather than inventing a second
          chrome for one route. */}
      <div className="flex items-center px-5 sm:px-6 h-14 border-b border-[#1A1A2E] flex-shrink-0">
        <div className="min-w-0">
          <p className="font-mono text-xs tracking-widest truncate" style={{ color: ACCENT }}>
            // SIGN UP
          </p>
          <p className="font-mono text-[10px] text-slate-700 mt-1 truncate">
            One account for Blue Chat, the Hub and your wallet
          </p>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-5 sm:px-6 py-8">
        <div className="max-w-md mx-auto">
          {signedIn ? (
            <SignedInCard
              identity={identity}
              /* Only the three photo-bearing providers ever set this. */
              viaSocial={!!privy?.social}
            />
          ) : (
            <>
              <h1 className="font-mono text-xl font-bold text-white">Sign up to Blue Agent</h1>
              {/* Privy has ONE door: the same call signs in an existing account
                  and creates a new one (we do not pass `disableSignup`). Saying
                  so removes the "wait, do I have an account already?" pause. */}
              <p className="font-mono text-[11px] text-slate-500 mt-2 leading-relaxed">
                New here or coming back — the same button does both. No password to pick,
                nothing to remember.
              </p>

              {/* ── Email ──────────────────────────────────────────────────── */}
              {hasEmail && (
                <form onSubmit={continueWithEmail} className="mt-6">
                  <label
                    htmlFor="signup-email"
                    className="font-mono text-[9px] text-slate-600 tracking-widest uppercase block mb-2"
                  >
                    Email
                  </label>
                  <input
                    id="signup-email"
                    type="email"
                    inputMode="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    className="w-full rounded-lg border border-[#1A1A2E] bg-[#0A0A12] px-3 py-2.5 font-mono text-[12px] text-white placeholder:text-slate-700 outline-none focus:border-[#4FC3F7]/50 transition-colors"
                  />
                  <button
                    type="submit"
                    className="mt-2 w-full rounded-lg px-3 py-2.5 font-mono text-[12px] font-bold transition-opacity hover:opacity-90"
                    style={{ background: ACCENT, color: "#050508" }}
                  >
                    Continue with email
                  </button>
                </form>
              )}

              {/* ── Socials ────────────────────────────────────────────────── */}
              {social.length > 0 && (
                <>
                  {hasEmail && (
                    <div className="flex items-center gap-2 my-5">
                      <div className="h-px flex-1 bg-[#1A1A2E]" />
                      <span className="font-mono text-[9px] text-slate-700 uppercase tracking-widest">or</span>
                      <div className="h-px flex-1 bg-[#1A1A2E]" />
                    </div>
                  )}
                  <div className={hasEmail ? "space-y-2" : "mt-6 space-y-2"}>
                    {social.map((m) => (
                      <button
                        key={m}
                        onClick={() => privy?.login({ loginMethods: [m] })}
                        className="w-full rounded-lg border border-[#1A1A2E] bg-[#0A0A12] px-3 py-2.5 text-left font-mono text-[12px] text-slate-300 transition-colors hover:border-slate-700 hover:text-white"
                      >
                        Continue with {loginMethodLabel(m)}
                      </button>
                    ))}
                  </div>
                </>
              )}

              {/* ── Wallet ─────────────────────────────────────────────────── */}
              <div className="flex items-center gap-2 my-5">
                <div className="h-px flex-1 bg-[#1A1A2E]" />
                <span className="font-mono text-[9px] text-slate-700 uppercase tracking-widest">
                  {PRIVY_ENABLED ? "or" : "wallet"}
                </span>
                <div className="h-px flex-1 bg-[#1A1A2E]" />
              </div>
              <button
                onClick={() => setPicker(true)}
                className="w-full rounded-lg border border-[#1A1A2E] bg-[#0A0A12] px-3 py-2.5 text-left font-mono text-[12px] text-slate-300 transition-colors hover:border-slate-700 hover:text-white"
              >
                Continue with a wallet you already own
              </button>

              {!PRIVY_ENABLED && (
                // Not a "coming soon". This build genuinely has no email or
                // social path — NEXT_PUBLIC_PRIVY_APP_ID is unset — and saying
                // so beats rendering buttons that would throw on click.
                <p className="font-mono text-[10px] text-slate-600 mt-3 leading-relaxed">
                  Email and social sign-in are not enabled on this deployment, so a wallet is the
                  only way in here.
                </p>
              )}

              {PRIVY_ENABLED && (
                <p className="font-mono text-[10px] text-slate-600 mt-3 leading-relaxed">
                  Signing in with email or a social account creates a wallet for you — no extension,
                  no seed phrase. You hold the keys; BlueAgent never does.
                </p>
              )}

              <WhatItChanges
                guest={GUEST_DAILY}
                member={WALLET_DAILY}
                multiplier={allowanceMultiplier}
              />
              <AvatarNote />
            </>
          )}
        </div>
      </div>

      <WalletPickerModal open={picker} onClose={() => setPicker(false)} />
    </div>
  );
}

// ── Bits ──────────────────────────────────────────────────────────────────────

/**
 * Shown instead of the form once there IS an account, rather than re-offering
 * sign-in to someone already signed in. Doubles as the honest demo of the
 * avatar: it is the same `Avatar` component the sidebar menu renders, fed by the
 * same `resolveIdentity` ladder, so what you see here is exactly what you get.
 */
function SignedInCard({
  identity,
  viaSocial,
}: {
  identity: ReturnType<typeof resolveIdentity>;
  viaSocial: boolean;
}) {
  return (
    <div>
      <h1 className="font-mono text-xl font-bold text-white">You&apos;re signed in</h1>
      <p className="font-mono text-[11px] text-slate-500 mt-2">
        Nothing left to do here.
      </p>

      <div className="mt-6 flex items-center gap-3 rounded-2xl border border-[#1A1A2E] bg-[#0A0A12] p-4">
        <Avatar
          photoUrl={identity.photoUrl}
          initials={identity.initials}
          colorSeed={identity.colorSeed}
          size={44}
        />
        <div className="min-w-0">
          <p className="font-mono text-[13px] text-white truncate">
            {identity.displayName ?? "Account"}
          </p>
          <p className="font-mono text-[10px] text-slate-600 truncate">
            {viaSocial ? "Social account" : "Wallet"}
            {identity.secondary ? ` · ${identity.secondary}` : ""}
          </p>
        </div>
      </div>

      <div className="mt-4 space-y-2">
        <Row href="/chat" label="Open Blue Chat" hint="Ask, and let it call tools" />
        <Row href="/wallet" label="Wallet" hint="Balances on Base and Robinhood Chain" />
        <Row href="/usage" label="Usage" hint="Credits and agent spend" />
      </div>

      <p className="font-mono text-[10px] text-slate-600 mt-4 leading-relaxed">
        Sign out from the account menu at the bottom of the sidebar.
      </p>
    </div>
  );
}

function Row({ href, label, hint }: { href: string; label: string; hint: string }) {
  return (
    <Link
      href={href}
      className="block rounded-lg border border-[#1A1A2E] bg-[#0A0A12] px-3 py-2.5 transition-colors hover:border-slate-700"
    >
      <span className="block font-mono text-[12px] text-slate-300">{label}</span>
      <span className="block font-mono text-[10px] text-slate-600">{hint}</span>
    </Link>
  );
}

/**
 * The part a sign-up page usually lies about.
 *
 * Both numbers are the ledger's own constants, and the multiplier is arithmetic
 * on them — so a repricing edits one file and this paragraph follows. The last
 * line is the one that matters: an account gates NOTHING. Same models, same
 * tools. Claiming otherwise is the defect class this codebase keeps finding.
 */
function WhatItChanges({
  guest,
  member,
  multiplier,
}: {
  guest: number;
  member: number;
  multiplier: number;
}) {
  return (
    <div className="mt-8 rounded-2xl border border-[#1A1A2E] bg-[#0A0A12] p-4">
      <p className="font-mono text-[9px] text-slate-600 tracking-widest uppercase mb-3">
        What an account actually changes
      </p>
      <ul className="space-y-1.5">
        <Bullet>
          <span className="text-slate-300">{member.toLocaleString()}</span> credits a day instead of{" "}
          <span className="text-slate-300">{guest.toLocaleString()}</span> — {multiplier}× the guest
          allowance, refreshed at 00:00 UTC.
        </Bullet>
        <Bullet>
          You can top up with USDC when the allowance runs out. Guests cannot.
        </Bullet>
        <Bullet>
          Optional cross-device sync for your conversations — off until you switch it on in Blue
          Chat, and it costs one extra signature.
        </Bullet>
        <Bullet>
          It unlocks <span className="text-slate-300">no model and no tool</span>. The picker and the
          Hub catalog are identical for guests — see{" "}
          <Link href="/plans" className="hover:underline" style={{ color: ACCENT }}>
            Plans
          </Link>
          .
        </Bullet>
      </ul>
    </div>
  );
}

/**
 * Says where the avatar comes from, because the obvious assumption is wrong.
 *
 * MEASURED against the installed `@privy-io/react-auth` types: `Google`,
 * `Github` and `Discord` carry no picture field at all — only `Twitter`
 * (`profilePictureUrl`), `Telegram` (`photoUrl`) and `Farcaster` (`pfp`) do. So
 * for most people here the avatar is drawn from the name, and this note exists
 * so nobody reads a blank-looking monogram as a bug.
 */
function AvatarNote() {
  return (
    <p className="font-mono text-[10px] text-slate-600 mt-4 leading-relaxed">
      Your avatar is drawn from your name and your address — Blue Agent does not upload a photo
      anywhere. If your provider gives us a real profile picture we use it; Google, GitHub and
      Discord do not give one out, so those accounts get initials on a colour taken from your
      wallet address.
    </p>
  );
}

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <li className="font-mono text-[10px] text-slate-500 flex gap-2 leading-relaxed">
      <span className="text-slate-700">·</span>
      <span>{children}</span>
    </li>
  );
}
