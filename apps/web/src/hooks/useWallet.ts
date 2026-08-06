"use client";

import { useCallback, useMemo } from "react";
import { useAccount, useConnect, type Connector } from "wagmi";
import { useWalletDisconnect, clearUserDisconnected } from "@/lib/walletSession";
import { useBasename, shortAddr } from "@/lib/useBasename";

// One connector row, enriched with the display metadata every picker used to
// re-derive on its own (WalletBar, ConnectModal, PayConnect, BankClient all had
// their own copy of walletIcon()/subtitle()). Centralised here so the wallet
// list looks identical everywhere.
export interface WalletMeta {
  connector: Connector;
  name:      string;
  icon:      string;   // emoji fallback (no connector logo dependency)
  subtitle:  string;
}

function walletIcon(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("metamask"))      return "🦊";
  if (n.includes("coinbase"))      return "🔵";
  if (n.includes("rabby"))         return "🐰";
  if (n.includes("phantom"))       return "👻";
  if (n.includes("walletconnect")) return "🔗";
  return "💼";
}

function walletSubtitle(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("metamask"))      return "Browser extension";
  if (n.includes("coinbase"))      return "Extension or Smart Wallet";
  if (n.includes("rabby"))         return "Browser extension";
  if (n.includes("walletconnect")) return "QR code / mobile";
  if (n.includes("injected"))      return "Browser extension";
  return "Connect";
}

/**
 * useWallet — the single wallet read/act surface for the whole app.
 *
 * Wraps wagmi's `useAccount`/`useConnect`, the `walletSession` explicit-
 * disconnect flag, and Basename resolution so every connect UI shows the SAME
 * de-duped wallet list, the SAME label (Basename → short 0x…), and the SAME
 * disconnect behaviour. `address` here is exactly wagmi's `useAccount().address`
 * — read it from either; they cannot diverge. Prefer this hook over passing the
 * address down through props so surfaces stay in lock-step.
 */
export function useWallet() {
  const { address, isConnected, chainId } = useAccount();
  const { connectors, connect, isPending } = useConnect();
  const disconnect = useWalletDisconnect();
  const { name: basename } = useBasename(address);

  // De-dup EIP-6963 discovery: the same wallet can surface twice — once as the
  // generic "Injected" entry, once by its real name. Keep the first by name.
  const wallets = useMemo<WalletMeta[]>(() => {
    const seen = new Set<string>();
    return connectors
      .filter((c) => {
        const key = c.name.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((c) => ({
        connector: c,
        name:      c.name,
        icon:      walletIcon(c.name),
        subtitle:  walletSubtitle(c.name),
      }));
  }, [connectors]);

  // Connect + clear the explicit-disconnect intent so BaseAppAutoConnect resumes
  // silent host-binding next session.
  const connectWith = useCallback((c: Connector) => {
    clearUserDisconnected();
    connect({ connector: c });
  }, [connect]);

  const label = basename ?? (address ? shortAddr(address) : undefined);

  return {
    address,
    isConnected: isConnected && !!address,
    chainId,
    basename,
    label,        // Basename if present, else short 0x… (undefined when no wallet)
    wallets,      // de-duped connector list with icon + subtitle
    connectWith,  // connect({ connector }) + clear disconnect intent
    disconnect,   // records intent so auto-connect won't undo it
    isPending,    // a connect attempt is in flight
  };
}
