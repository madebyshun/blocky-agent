// Privy embedded-wallet config — the "no-MetaMask onboarding" surface (task #90).
//
// ENV-GATED, deliberately. `PRIVY_ENABLED` is derived from the build-time-inlined
// public env var `NEXT_PUBLIC_PRIVY_APP_ID`. When it is NOT set (local dev today,
// and any deploy that hasn't added the var), `PRIVY_ENABLED` folds to `false`,
// the Privy provider branch in Providers.tsx is dead-code-eliminated, and every
// wallet surface behaves EXACTLY as it does without Privy. Setting the var in
// Vercel is the single switch that turns the embedded-wallet option on — no code
// change, fully reversible.
//
// The App ID is a PUBLIC client identifier (safe to inline), not a secret. The
// server-side Privy secret (if ever needed for verification) would be a separate
// non-public env var and is NOT read here.
import type { PrivyClientConfig } from "@privy-io/react-auth";
import { base, baseSepolia } from "wagmi/chains";
import { robinhoodMainnet } from "@/lib/robinhood/chains";

export const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
export const PRIVY_ENABLED = !!PRIVY_APP_ID;

type LoginMethod = NonNullable<PrivyClientConfig["loginMethods"]>[number];

/**
 * Which Privy login methods to offer, as a comma-separated env var:
 *   NEXT_PRIVY_LOGIN_METHODS="email,google,twitter,discord,passkey"
 *
 * ⚠️ NO `NEXT_PUBLIC_` PREFIX, deliberately — do not "fix" it. This module is
 * pulled into the client bundle, where Next only inlines `NEXT_PUBLIC_*` on its
 * own. The value arrives because `next.config.ts` lists this key under `env`,
 * which inlines at build time with no prefix rule (the Vercel variable on this
 * project cannot carry "PUBLIC" in its name). Rename it here and you must
 * rename it there in the SAME commit, or this silently falls back to
 * `["email"]` with no error to tell you.
 *
 * WHY ENV-DRIVEN instead of just hardcoding the full list: Privy validates
 * `loginMethods` against what is enabled in the PRIVY DASHBOARD. Naming a
 * method here that the dashboard has not enabled is a configuration error, not
 * a graceful no-op — and this modal is the login path for real users with real
 * balances, so a bad deploy locks people OUT rather than merely looking wrong.
 * Env-driven means the dashboard toggle and the app agree because one person
 * flips both, and a rollback is an env edit rather than a redeploy.
 *
 * Default is `["email"]` — exactly the shipped behaviour — so an unset var
 * changes nothing.
 *
 * Unknown values are DROPPED rather than forwarded: Privy rejects the whole
 * array on a single bad entry, which would take email down with it. A typo
 * should cost you that one method, never the login screen.
 */
const KNOWN_LOGIN_METHODS = [
  "email",
  "sms",
  "google",
  "twitter",
  "discord",
  "github",
  "apple",
  "farcaster",
  "telegram",
  "passkey",
] as const satisfies readonly LoginMethod[];

function parseLoginMethods(raw: string | undefined): LoginMethod[] {
  if (!raw) return ["email"];
  const wanted = new Set(
    raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  );
  // Filter the KNOWN list (not the input) so order is ours and duplicates are
  // impossible — the modal's button order shouldn't depend on env spelling.
  const picked = KNOWN_LOGIN_METHODS.filter((m) => wanted.has(m));
  // Never hand Privy an empty array — it renders a modal with no way in.
  return picked.length ? [...picked] : ["email"];
}

export const PRIVY_LOGIN_METHODS = parseLoginMethods(
  process.env.NEXT_PRIVY_LOGIN_METHODS,
);

// Email-first onboarding: a user signs in with an email code and Privy silently
// provisions an embedded wallet for anyone who arrives without one
// (`createOnLogin: "users-without-wallets"`). Users who already have an external
// wallet keep using it — the embedded wallet is an ADD, never a replacement.
// `@privy-io/wagmi`'s WagmiProvider then syncs that wallet into wagmi's
// `useAccount()`, so the existing balance / swap / send stack needs no changes.
export const privyClientConfig: PrivyClientConfig = {
  loginMethods: PRIVY_LOGIN_METHODS,
  embeddedWallets: {
    ethereum: { createOnLogin: "users-without-wallets" },
  },
  // Make Privy's hosted modal match the rest of the app's wallet UI.
  //   - `theme: "dark"` + our brand accent: Privy defaults to a LIGHT modal,
  //     which clashed with every other (dark) wallet surface — this is the fix
  //     for that visual mismatch.
  //   - `walletList: []`: suppress Privy's own external-wallet buttons
  //     (MetaMask / Coinbase / WalletConnect …). External wallets are handled by
  //     our shared WalletPickerModal, which reads wagmi's connector list — the
  //     SAME list the rest of the app connects through. Letting Privy render a
  //     second, separately-configured wallet menu on top of it is how the two
  //     drift: a wallet could appear in one and not the other, and a user who
  //     connected via Privy's copy would not be the user `useWallet()` sees.
  //     Privy's modal stays SOCIAL/EMAIL-ONLY — the part it uniquely provides.
  //     (External wallets are governed by `walletList`, not `loginMethods`;
  //     the LoginMethod union has no "wallet" value.)
  appearance: {
    theme: "dark",
    accentColor: "#4FC3F7",
    showWalletLoginFirst: false,
    walletList: [],
  },
  // Base mainnet is the default target; testnet + Robinhood Chain registered so
  // the embedded wallet can operate on the same chains the app already supports.
  defaultChain: base,
  supportedChains: [base, baseSepolia, robinhoodMainnet],
};
