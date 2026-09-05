"use client";

// Bridge that makes Privy's `connectWallet` reachable from `useWallet()` —
// which runs on BOTH provider trees (Privy-on and Privy-off).
//
// WHY A CONTEXT AND NOT JUST CALLING THE HOOK:
// `useConnectWallet()` throws outside `<PrivyProvider>`, and `useWallet()` is
// rendered on the default (Privy-off) tree too. Calling it behind
// `if (PRIVY_ENABLED)` would be a conditional hook — an ESLint
// `react-hooks/rules-of-hooks` error, which fails `next build`. So the hook is
// called ONCE here, inside the Privy tree, and published through a context that
// the default tree simply never provides. `useWallet()` then reads it with a
// single unconditional `useContext`, getting `null` when Privy is off.
//
// WHY EXTERNAL WALLETS MUST GO THROUGH PRIVY AT ALL:
// `@privy-io/wagmi`'s `createConfig` does
//   connectors: opts.connectors?.filter(c => c.type === "mock")
//   multiInjectedProviderDiscovery: false
// AFTER spreading our options, so on the Privy tree wagmi's connector list is
// EMPTY — every connector we register is discarded (creator fns carry no
// `.type`, so nothing survives the filter), and EIP-6963 discovery is forced
// off. `useSyncPrivyWallets` then keeps calling
// `config._internal.connectors.setState(...)` at runtime with only the wallets
// Privy itself knows about. So `useConnect()` cannot reach MetaMask, Coinbase,
// WalletConnect or anything else here — `connectWallet()` is the only route in.
import { createContext, useContext, useMemo } from "react";
import { useConnectWallet, type WalletListEntry } from "@privy-io/react-auth";

export type PrivyConnect = {
  /**
   * Opens Privy's connect-wallet modal. Pass a single entry to jump straight to
   * one wallet (how the picker rows work); pass nothing for the full list.
   */
  connectWallet: (only?: WalletListEntry) => void;
};

const PrivyConnectContext = createContext<PrivyConnect | null>(null);

/** Mounted inside the Privy provider tree only. */
export function PrivyConnectBridge({ children }: { children: React.ReactNode }) {
  const { connectWallet } = useConnectWallet();

  const value = useMemo<PrivyConnect>(
    () => ({
      connectWallet: (only?: WalletListEntry) =>
        connectWallet(only ? { walletList: [only] } : {}),
    }),
    [connectWallet],
  );

  return <PrivyConnectContext.Provider value={value}>{children}</PrivyConnectContext.Provider>;
}

/** `null` when Privy is disabled — callers fall back to the wagmi connector list. */
export function usePrivyConnect(): PrivyConnect | null {
  return useContext(PrivyConnectContext);
}
