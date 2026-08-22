"use client";

import { createConfig as wagmiCreateConfig, WagmiProvider } from "wagmi";
import { base, baseSepolia } from "wagmi/chains";
import { http } from "viem";
import { robinhoodMainnet, robinhoodTestnet } from "@/lib/robinhood/chains";
import { coinbaseWallet } from "wagmi/connectors";
import { farcasterMiniApp } from "@farcaster/miniapp-wagmi-connector";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PrivyProvider } from "@privy-io/react-auth";
import { createConfig as privyCreateConfig, WagmiProvider as PrivyWagmiProvider } from "@privy-io/wagmi";
import { PRIVY_APP_ID, PRIVY_ENABLED, privyClientConfig } from "@/lib/privy/config";
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
const connectors = [
  // Only inside Base App / Farcaster — host wallet connects with no prompt.
  ...(inMiniAppFrame ? [farcasterMiniApp()] : []),
  coinbaseWallet({
    appName: "Blue Agent",
    preference: { options: "all" }, // extension + QR code fallback
  }),
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
const privyConfig = PRIVY_ENABLED
  ? privyCreateConfig({
      chains: [base, baseSepolia, robinhoodMainnet, robinhoodTestnet],
      connectors,
      multiInjectedProviderDiscovery: true,
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
            <Shell>{children}</Shell>
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
