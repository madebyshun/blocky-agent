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
import type { PrivyClientConfig, WalletListEntry } from "@privy-io/react-auth";
import { base, baseSepolia } from "wagmi/chains";
import { robinhoodMainnet } from "@/lib/robinhood/chains";

export const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
export const PRIVY_ENABLED = !!PRIVY_APP_ID;

export type LoginMethod = NonNullable<PrivyClientConfig["loginMethods"]>[number];

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
 * WHY ENV-DRIVEN instead of hardcoding: the dashboard toggle and this list are
 * two switches that must agree, so env-driven means one person flips both and a
 * rollback is an env edit rather than a redeploy.
 *
 * ⚠️ THE CLIENT LIST OVERRIDES THE DASHBOARD — it does NOT intersect with it.
 * (An earlier version of this comment claimed the opposite; corrected against
 * the SDK source, `@privy-io/react-auth/dist/esm/context-*.mjs`.) When
 * `loginMethods` is supplied, the SDK reads every flag off OUR array —
 * `t.loginMethods.includes("google")` and so on — and never consults the
 * dashboard's `google_oauth` / `twitter_oauth` values, which it falls back to
 * ONLY when the key is absent entirely. So naming a method the dashboard has
 * not enabled still renders its button; the failure lands later, on click,
 * when Privy starts an OAuth flow it has no credentials for. Enable the method
 * in the dashboard FIRST, then add it here.
 *
 * The one hard failure is an EMPTY resulting list: the SDK throws
 * "You must enable at least one login method". `parseLoginMethods` floors to
 * `["email"]` precisely so an env typo can never reach that throw.
 *
 * Default is `["email"]` — exactly the shipped behaviour — so an unset var
 * changes nothing.
 *
 * Unknown values are dropped for TYPE safety and stable ordering, not to dodge
 * a Privy rejection: an unrecognised string is simply never matched by the
 * SDK's `includes()` checks, so it is inert rather than fatal.
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

const LOGIN_METHOD_LABELS: Partial<Record<LoginMethod, string>> = {
  google: "Google",
  twitter: "X",
  apple: "Apple",
  github: "GitHub",
  discord: "Discord",
  farcaster: "Farcaster",
  telegram: "Telegram",
  passkey: "a passkey",
  email: "email",
  sms: "SMS",
};

// Socials first, email/SMS last — "Google, X, or email" reads better than
// "email, Google, or X", and this order is independent of KNOWN_LOGIN_METHODS
// (which governs the array we hand Privy, not the prose).
const LABEL_ORDER = [
  "google", "twitter", "apple", "github", "discord",
  "farcaster", "telegram", "passkey", "email", "sms",
] as const satisfies readonly LoginMethod[];

/**
 * Prose for the sign-in button, e.g. "Google, X, or email".
 *
 * DERIVED from the configured methods on purpose — never hardcode this string.
 * The button's promise has to match what the modal will actually offer, and
 * `PRIVY_LOGIN_METHODS` is env-driven, so a literal would silently drift the
 * moment someone edits `NEXT_PRIVY_LOGIN_METHODS`.
 *
 * This is the exact failure the wallet panel just shipped and had to undo: a
 * hardcoded "Create a free wallet / Face ID · no seed phrase" CTA kept its copy
 * while the call underneath it changed, so the button confidently promised a
 * passkey and opened something else. Copy that is computed from the config
 * cannot develop that gap.
 */
export function describeLoginMethods(
  methods: readonly LoginMethod[] = PRIVY_LOGIN_METHODS,
): string {
  const names = LABEL_ORDER.filter((m) => methods.includes(m)).map(
    (m) => LOGIN_METHOD_LABELS[m] ?? m,
  );
  if (names.length === 0) return "email";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} or ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, or ${names[names.length - 1]}`;
}

/**
 * One method's display name, for a per-provider button ("Continue with GitHub").
 *
 * Reads the SAME table `describeLoginMethods()` uses, so the sentence on one
 * surface and the button on another can never name a provider differently.
 * Every label is written to survive being dropped after "with", which is why
 * `passkey` is "a passkey" rather than "Passkey".
 *
 * Falls back to the raw method id instead of throwing: a value can only reach
 * here if it survived `KNOWN_LOGIN_METHODS`, and a missing label is a cosmetic
 * gap, not a reason to blank a working sign-in button.
 */
export function loginMethodLabel(method: LoginMethod): string {
  return LOGIN_METHOD_LABELS[method] ?? method;
}

/**
 * The external wallets offered when Privy is enabled — one picker row each.
 *
 * THIS LIST IS THE WHOLE EXTERNAL-WALLET SURFACE ON THE PRIVY TREE, not a
 * nicety. `@privy-io/wagmi` empties wagmi's connector array and force-disables
 * EIP-6963 discovery (see the header of `lib/privy/connect-bridge.tsx`), so
 * `useConnect()` reaches nothing here — a wallet that is not in this array has
 * no route into the app at all. That is exactly the bug this replaced: the
 * picker rendered `useConnect().connectors`, which under Privy is `[]`, so
 * "I already have a wallet" opened an empty menu.
 *
 * `detected_ethereum_wallets` is FIRST and is load-bearing: it surfaces whatever
 * EIP-6963 wallet the browser actually has (Rabby, Brave, OKX, a fresh
 * MetaMask fork…). Without it the list would silently cap the app at the six
 * hard-coded brands below, which is the same "unreachable wallet" failure in a
 * smaller costume.
 *
 * Order is the render order. `wallet_connect` sits last as the catch-all: it is
 * the only entry that reaches a wallet which is not an extension in THIS
 * browser (mobile-only wallets, and anyone on a phone browser).
 *
 * Entries are typed `WalletListEntry`, so a string Privy does not support is a
 * compile error rather than a row that does nothing when clicked.
 */
export const PRIVY_WALLET_LIST: { id: WalletListEntry; name: string; icon: string; subtitle: string }[] = [
  { id: "detected_ethereum_wallets", name: "Browser wallet", icon: "🧩", subtitle: "Detected extension" },
  { id: "metamask",        name: "MetaMask",        icon: "🦊", subtitle: "Browser extension" },
  { id: "coinbase_wallet", name: "Coinbase Wallet", icon: "🔵", subtitle: "Extension or Smart Wallet" },
  { id: "base_account",    name: "Base Account",    icon: "🔷", subtitle: "Passkey — no seed phrase" },
  { id: "phantom",         name: "Phantom",         icon: "👻", subtitle: "Browser extension" },
  { id: "rainbow",         name: "Rainbow",         icon: "🌈", subtitle: "Mobile wallet" },
  { id: "wallet_connect",  name: "WalletConnect",   icon: "🔗", subtitle: "QR code / mobile" },
];

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
  //   - `walletList: []`: keep the LOGIN modal social/email-only, so "Sign in
  //     with email" opens exactly one clean choice set. External wallets are a
  //     SEPARATE control (`connectWallet()`, driven by PRIVY_WALLET_LIST above)
  //     rather than a second column in the login modal — the same split Halo
  //     ships: "Connect Socials" vs "Connect Wallet".
  //
  //     ⚠️ THIS EMPTY ARRAY IS NOT A WAY TO DISABLE EXTERNAL WALLETS, and it
  //     used to be read that way. `appearance.walletList` governs the LOGIN
  //     modal only; the connect-wallet modal takes its own `walletList` per
  //     call. Emptying this one while ALSO routing the pickers through wagmi's
  //     connector list (which `@privy-io/wagmi` empties) is what left the app
  //     with zero ways to connect an external wallet — two independently
  //     reasonable-looking choices that combined into a lockout.
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
