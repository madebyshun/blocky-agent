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

// Email-first onboarding: a user signs in with an email code and Privy silently
// provisions an embedded wallet for anyone who arrives without one
// (`createOnLogin: "users-without-wallets"`). Users who already have an external
// wallet keep using it — the embedded wallet is an ADD, never a replacement.
// `@privy-io/wagmi`'s WagmiProvider then syncs that wallet into wagmi's
// `useAccount()`, so the existing balance / swap / send stack needs no changes.
export const privyClientConfig: PrivyClientConfig = {
  loginMethods: ["email"],
  embeddedWallets: {
    ethereum: { createOnLogin: "users-without-wallets" },
  },
  // Make Privy's hosted modal match the rest of the app's wallet UI.
  //   - `theme: "dark"` + our brand accent: Privy defaults to a LIGHT modal,
  //     which clashed with every other (dark) wallet surface — this is the fix
  //     for that visual mismatch.
  //   - `walletList: []`: suppress Privy's own external-wallet buttons
  //     (MetaMask / Coinbase / WalletConnect …). External wallets are already
  //     handled by our shared WalletPickerModal + the BankClient onboarding, so
  //     re-listing them here (with a WalletConnect option the app deliberately
  //     doesn't register elsewhere) was redundant and inconsistent. Privy's
  //     modal is now EMAIL-ONLY — the one thing it uniquely provides.
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
