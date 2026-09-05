"use client";

// Publishes "who is signed in" from Privy to the rest of the app.
//
// Same shape, and the same reason, as `connect-bridge.tsx` next door:
// `usePrivy()` THROWS outside `<PrivyProvider>`, and the account menu renders on
// both provider trees. Calling the hook behind `if (PRIVY_ENABLED)` would be a
// conditional hook — an ESLint `react-hooks/rules-of-hooks` error that fails
// `next build`. So the hook is called once here, inside the Privy tree, and
// published through a context the default tree simply never provides; consumers
// read it with one unconditional `useContext` and get `null` when Privy is off.
//
// Kept SEPARATE from the connect bridge on purpose. That one answers "how do I
// attach a wallet"; this one answers "whose account is this". They are wired to
// the same provider today but they are not the same question, and merging them
// would mean every future identity field lands in a file whose entire header is
// about wagmi's connector list.
import { createContext, useContext, useMemo } from "react";
import { usePrivy } from "@privy-io/react-auth";
import type { LoginModalOptions } from "@privy-io/react-auth";
import type { SocialAccount } from "@/lib/identity/account-identity";

export type PrivyIdentity = {
  /** `false` until Privy has restored its session — render a skeleton, not a guest. */
  ready: boolean;
  authenticated: boolean;
  /** The best linked account to show, or null when signed out. */
  social: SocialAccount | null;
  /**
   * Opens Privy's hosted login modal.
   *
   * Published here for the SAME reason `logout` is: the sign-up page renders on
   * both provider trees, so it cannot call `usePrivy()` itself without a
   * conditional hook. Going through the bridge means one component reads
   * `login` and the other tree gets `null` — no throw, no ESLint error.
   *
   * `options.loginMethods` NARROWS the modal to the named methods, which is what
   * lets the sign-up page render one button per provider instead of a single
   * "sign in" that opens a menu. Measured against the installed SDK: this is a
   * supported, NON-experimental option (`LoginModalOptions` extends
   * `RuntimeLoginOverridableOptions`, which documents `loginMethods` and
   * `prefill`). The alternative — `useLoginWithOAuth().initOAuth()` — is marked
   * `@experimental` in the same types AND does a full-page redirect, so it is
   * deliberately not used.
   *
   * Narrower type than the SDK's on purpose: Privy also accepts a React
   * `MouseEvent` here (so `onClick={login}` works), which is a footgun — pass it
   * a click event by accident and you silently get the un-narrowed modal.
   */
  login: (options?: LoginModalOptions) => void;
  logout: () => void;
};

const PrivyIdentityContext = createContext<PrivyIdentity | null>(null);

/**
 * Pick ONE linked account to represent the user.
 *
 * Ordered by how much they can actually see of themselves: the three providers
 * that hand over a real profile photo come first, then the three that give a
 * name but no image, then bare email. (See `account-identity.ts` for the
 * measured per-provider field list — Google, GitHub and Discord carry NO
 * picture URL in the installed SDK, which is why the photo tier is separate
 * from the "social login" tier rather than the same thing.)
 *
 * A user with several links gets the richest one, and it does not flicker
 * between them, because the order is fixed rather than "first key present".
 */
function pickSocial(user: ReturnType<typeof usePrivy>["user"]): SocialAccount | null {
  if (!user) return null;

  if (user.twitter) {
    return {
      provider: "twitter",
      name: user.twitter.name,
      handle: user.twitter.username,
      email: null,
      // Privy documents this URL as the 48px `_normal` variant; the menu renders
      // at 32px so it is already sharp enough and we do not rewrite the URL.
      photoUrl: user.twitter.profilePictureUrl,
      subject: user.twitter.subject,
    };
  }
  if (user.farcaster) {
    return {
      provider: "farcaster",
      name: user.farcaster.displayName,
      handle: user.farcaster.username,
      email: null,
      photoUrl: user.farcaster.pfp,
      subject: user.farcaster.fid != null ? String(user.farcaster.fid) : null,
    };
  }
  if (user.telegram) {
    const tg = user.telegram;
    const full = [tg.firstName, tg.lastName].filter(Boolean).join(" ");
    return {
      provider: "telegram",
      name: full || tg.username,
      handle: tg.username,
      email: null,
      photoUrl: tg.photoUrl,
      subject: tg.telegramUserId,
    };
  }
  if (user.google) {
    return {
      provider: "google",
      name: user.google.name,
      handle: null,
      email: user.google.email,
      photoUrl: null, // measured: the SDK's `Google` type has no picture field
      subject: user.google.subject,
    };
  }
  if (user.github) {
    return {
      provider: "github",
      name: user.github.name,
      handle: user.github.username,
      email: user.github.email,
      photoUrl: null, // measured: no picture field
      subject: user.github.subject,
    };
  }
  if (user.discord) {
    return {
      provider: "discord",
      name: user.discord.username,
      handle: user.discord.username,
      email: user.discord.email,
      photoUrl: null, // measured: no picture field
      subject: user.discord.subject,
    };
  }
  if (user.email) {
    return {
      provider: "email",
      name: null,
      handle: null,
      email: user.email.address,
      photoUrl: null,
      subject: user.email.address,
    };
  }
  return null;
}

/** Mounted inside the Privy provider tree only. */
export function PrivyIdentityBridge({ children }: { children: React.ReactNode }) {
  const { ready, authenticated, user, login, logout } = usePrivy();

  const social = useMemo(() => (authenticated ? pickSocial(user) : null), [authenticated, user]);

  const value = useMemo<PrivyIdentity>(
    () => ({ ready, authenticated, social, login, logout }),
    [ready, authenticated, social, login, logout],
  );

  return <PrivyIdentityContext.Provider value={value}>{children}</PrivyIdentityContext.Provider>;
}

/** `null` when Privy is disabled — callers then know the account is wallet-only. */
export function usePrivyIdentity(): PrivyIdentity | null {
  return useContext(PrivyIdentityContext);
}
