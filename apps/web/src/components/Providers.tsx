"use client";

import { createConfig as wagmiCreateConfig, WagmiProvider } from "wagmi";
import { base, baseSepolia } from "wagmi/chains";
import { http } from "viem";
import { robinhoodMainnet, robinhoodTestnet } from "@/lib/robinhood/chains";
import { coinbaseWallet, walletConnect } from "wagmi/connectors";
import { farcasterMiniApp } from "@farcaster/miniapp-wagmi-connector";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PrivyProvider } from "@privy-io/react-auth";
import { createConfig as privyCreateConfig, WagmiProvider as PrivyWagmiProvider } from "@privy-io/wagmi";
import { PRIVY_APP_ID, PRIVY_ENABLED, privyClientConfig } from "@/lib/privy/config";
import { PrivyConnectBridge } from "@/lib/privy/connect-bridge";
import { PrivyIdentityBridge } from "@/lib/privy/identity-bridge";
import MiniAppReady from "@/components/MiniAppReady";
import BaseAppAutoConnect from "@/components/BaseAppAutoConnect";
import { LanguageProvider } from "@/lib/i18n/context";

// The Farcaster / Base App Mini App connector talks to a host frame over
// postMessage. It is NOT inert in a normal browser tab: with no host to
// answer, including it made wagmi hang on "Connecting…" for injected wallets
// (MetaMask/Rabby) — only Coinbase, which uses its own SDK, still worked.
// Mini Apps always render embedded (iframe / webview), so only register the
// connector when we're inside a host frame; a normal top-level tab gets just
// Coinbase + injected, restoring desktop wallet connect.
const inMiniAppFrame = typeof window !== "undefined" && window.top !== window.self;

// Connectors + transports are shared by BOTH the default and the Privy wagmi
// config so the external-wallet list and RPCs can't drift between the two
// provider paths.
//
// We deliberately do NOT register a generic `injected()` connector.
// wagmi v3 has EIP-6963 multi-injected discovery ON by default, so every
// installed extension (MetaMask, Rabby, Phantom…) is surfaced as its own
// connector backed by that wallet's *isolated* provider.
//
// The generic `injected()` connector instead talks to the shared
// `window.ethereum`, which — when several extensions are installed — is a
// multiplexed proxy that frequently resolves to a non-responding provider.
// That made `connect()` hang on "Connecting…" for MetaMask/Rabby while only
// Coinbase (its own SDK) worked. Dropping it routes injected wallets through
// EIP-6963's per-wallet providers, fixing the hang.
// WalletConnect — the ONLY path for a wallet that is not a browser extension
// in this exact browser.
//
// WHY THIS EXISTS: before it, the registered connector list was Coinbase alone,
// and everything else arrived purely through EIP-6963 discovery. EIP-6963 is an
// extension-to-page handshake, so it can only ever surface wallets installed in
// the current desktop browser. That left a whole class of users with NO route
// in at all — anyone on a phone browser, and every mobile-only wallet (Rainbow,
// Trust, Zerion, MetaMask Mobile, Phantom Mobile). They were not "hard to
// connect"; they were unreachable. Coinbase's own QR fallback rescued exactly
// one wallet — its own.
//
// ENV-GATED on `NEXT_WALLETCONNECT_PROJECT_ID`, matching the existing
// `PRIVY_ENABLED` pattern: unset → the array spreads to nothing and the
// connector list is byte-identical to before, so a missing var degrades to
// today's behaviour instead of throwing at module scope (`walletConnect()`
// requires a projectId and will reject an empty string at connect time).
// The project id is a PUBLIC client identifier from cloud.reown.com — safe to
// inline in the bundle, not a secret.
//
// ⚠️ NOTE THE MISSING `NEXT_PUBLIC_` PREFIX, and do not "fix" it. This is a
// client module, so Next would normally inline nothing without that prefix —
// the value reaches the browser only because `next.config.ts` lists this key
// under `env`, which inlines at build time with no prefix rule. The Vercel
// variable cannot be named `NEXT_PUBLIC_*` on this project, hence the mapping.
// If you rename this, rename it in next.config.ts in the same commit or
// WalletConnect goes dark with no error anywhere.
//
// `@walletconnect/ethereum-provider` ships as a dependency of
// `@wagmi/connectors`, so this adds no new package; wagmi lazy-imports it on
// first connect, keeping it out of the initial bundle.
const WALLETCONNECT_PROJECT_ID = process.env.NEXT_WALLETCONNECT_PROJECT_ID;

const connectors = [
  // Only inside Base App / Farcaster — host wallet connects with no prompt.
  ...(inMiniAppFrame ? [farcasterMiniApp()] : []),
  coinbaseWallet({
    appName: "Blue Agent",
    preference: { options: "all" }, // extension + QR code fallback
  }),
  // CLIENT-ONLY, and that is load-bearing, not a nicety. `createConfig` runs on
  // the server too (`ssr: true`), and building the WC connector there drags in
  // `@walletconnect/ethereum-provider`'s keyvaluestorage, which reaches for
  // `indexedDB` — absent in Node. That surfaced as
  // `unhandledRejection: ReferenceError: indexedDB is not defined` on every
  // server render (measured: 0 occurrences without this connector, 3 with it,
  // same page loads). Gating on `window` keeps WC off the server entirely.
  //
  // A server/client connector-list difference is already the established shape
  // in this file — `inMiniAppFrame` above does exactly the same thing — because
  // the connector list is only ever read from client components
  // (`useWallet()` → `useConnect()`), never rendered during SSR.
  //
  // Mini App hosts carry their own wallet, so a QR modal inside an embedded
  // frame is a dead end — register WC for top-level tabs only.
  ...(typeof window !== "undefined" && WALLETCONNECT_PROJECT_ID && !inMiniAppFrame
    ? [
        walletConnect({
          projectId: WALLETCONNECT_PROJECT_ID,
          showQrModal: true,
          metadata: {
            name: "Blue Agent",
            description: "The onchain Agent OS — Blue Chat, Blue Hood, Blue Hub.",
            url: "https://blueagent.dev",
            icons: ["https://blueagent.dev/icon.png"],
          },
        }),
      ]
    : []),
];

const transports = {
  [base.id]: http(),
  [baseSepolia.id]: http(),
  [robinhoodMainnet.id]: http(),
  [robinhoodTestnet.id]: http(),
};

// `chains` is kept INLINE in each createConfig call (not hoisted to a shared
// const) so TypeScript infers the non-empty tuple `[Chain, ...Chain[]]` wagmi
// requires — a shared `const chains = [...]` would widen to `Chain[]` and break
// the generic.
//
// base = mainnet (default). baseSepolia = testnet, enabled so the chat
// Move-to-Yield card can test Aave supply/withdraw safely before mainnet.
// robinhoodMainnet/Testnet registered so `useSwitchChain` can actually prompt
// wallets to add/switch to Robinhood Chain (chainId 4663/46630) for the
// direct-deploy launch flow — without this, switchChainAsync throws "chain not
// configured" for any chain not in this array.
//
// NOTE: wagmi 3.6 / viem 2.55 have no config-level `dataSuffix` — it was a
// silent no-op. ERC-8021 builder-code attribution is applied per-transaction
// instead: the EIP-5792 `dataSuffix` capability in the Smart Wallet send path
// (ToolCards SendCard) and a calldata suffix on the 0x swap (bank SwapCard).
const defaultConfig = wagmiCreateConfig({
  chains: [base, baseSepolia, robinhoodMainnet, robinhoodTestnet],
  connectors,
  multiInjectedProviderDiscovery: true,
  transports,
  ssr: true,
});

// Built ONLY when Privy is enabled (NEXT_PUBLIC_PRIVY_APP_ID set). Same
// chains/connectors/transports as the default config; @privy-io/wagmi's
// createConfig additionally lets Privy inject + sync the embedded wallet into
// wagmi state, so useAccount()/useBalance()/the swap+send stack pick it up with
// no further wiring.
//
// ⚠️ `connectors` and `multiInjectedProviderDiscovery` are DELIBERATELY ABSENT
// here, and re-adding them would be worse than useless. @privy-io/wagmi's
// createConfig does, AFTER spreading our options:
//     connectors: opts.connectors?.filter(c => c.type === "mock"),
//     multiInjectedProviderDiscovery: false,
// Creator fns carry no `.type`, so that filter returns [] for EVERY connector —
// passing them here silently produced an EMPTY wallet list while the code read
// as if it configured one. That is the bug this file's PR fixes: "I already have
// a wallet" opened a menu with no rows, and Coinbase's "create a free wallet"
// CTA vanished, because both render `useConnect().connectors`.
//
// External wallets on this tree go through Privy's own modal instead — see
// `lib/privy/connect-bridge.tsx` and `PRIVY_WALLET_LIST`. Leaving the keys out
// makes the truth visible at the call site rather than hiding it behind an
// override two node_modules deep.
const privyConfig = PRIVY_ENABLED
  ? privyCreateConfig({
      chains: [base, baseSepolia, robinhoodMainnet, robinhoodTestnet],
      transports,
      ssr: true,
    })
  : null;

const queryClient = new QueryClient();

// The inner tree is identical under either wagmi provider.
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <>
      {/* Dismisses the Base App / Farcaster splash once mounted. */}
      <MiniAppReady />
      {/* Silently binds the host wallet when embedded in Base App / Farcaster. */}
      <BaseAppAutoConnect />
      {/* EN / 中文 — wraps both marketing + app (root layout uses <Providers>). */}
      <LanguageProvider>{children}</LanguageProvider>
    </>
  );
}

export default function Providers({ children }: { children: React.ReactNode }) {
  // Privy path — active only when NEXT_PUBLIC_PRIVY_APP_ID is set. PrivyProvider
  // is outermost; @privy-io/wagmi's WagmiProvider replaces wagmi's own and keeps
  // the embedded wallet in lock-step with useAccount(). When the env var is
  // unset this whole branch folds to dead code and the app renders exactly the
  // default tree below.
  if (PRIVY_ENABLED && privyConfig) {
    return (
      <PrivyProvider appId={PRIVY_APP_ID!} config={privyClientConfig}>
        <QueryClientProvider client={queryClient}>
          <PrivyWagmiProvider config={privyConfig}>
            {/* Publishes Privy's connectWallet() to useWallet(). Without it the
                pickers have no route to an external wallet on this tree. */}
            <PrivyConnectBridge>
              {/* Publishes WHO is signed in (name / photo / logout) to the
                  account menu. Same context trick, separate question — see the
                  header of identity-bridge.tsx. On the default tree below,
                  neither bridge is mounted and both hooks read `null`. */}
              <PrivyIdentityBridge>
                <Shell>{children}</Shell>
              </PrivyIdentityBridge>
            </PrivyConnectBridge>
          </PrivyWagmiProvider>
        </QueryClientProvider>
      </PrivyProvider>
    );
  }

  // Default path — byte-identical to the pre-Privy provider tree.
  return (
    <WagmiProvider config={defaultConfig}>
      <QueryClientProvider client={queryClient}>
        <Shell>{children}</Shell>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
