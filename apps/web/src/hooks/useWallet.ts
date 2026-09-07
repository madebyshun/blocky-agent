"use client";

import { useCallback, useMemo } from "react";
import { useAccount, useConnect } from "wagmi";
import { useWalletDisconnect, clearUserDisconnected } from "@/lib/walletSession";
import { useBasename, shortAddr } from "@/lib/useBasename";
import { usePrivyConnect } from "@/lib/privy/connect-bridge";
import { PRIVY_WALLET_LIST } from "@/lib/privy/config";

// One wallet row, enriched with the display metadata every picker used to
// re-derive on its own (WalletBar, ConnectModal, PayConnect, BankClient all had
// their own copy of walletIcon()/subtitle()). Centralised here so the wallet
// list looks identical everywhere.
//
// `select()` REPLACED the old `connector: Connector` field, and the swap is the
// point of this shape: the two provider trees reach a wallet by completely
// different means — wagmi's `connect({ connector })` on the default tree,
// Privy's `connectWallet({ walletList })` on the Privy tree, where wagmi's
// connector list is empty and no `Connector` object exists to hand back. Callers
// therefore get a closure that already knows how to connect THIS row, and can no
// longer accidentally couple themselves to a connector object that only exists
// on one of the two paths.
export interface WalletMeta {
  key:       string;   // stable React key (connector uid, or the Privy entry id)
  name:      string;
  icon:      string;   // emoji fallback (no connector logo dependency)
  subtitle:  string;
  select:    () => void;
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
 *
 * It also HIDES THE BIGGEST FOOTGUN IN THE WALLET STACK: which of the two
 * provider trees is mounted. On the default tree wallets come from wagmi's
 * connector list; on the Privy tree that list is empty and wallets come from
 * Privy's own modal. Every picker in the app reads `wallets`/`coinbase`/`others`
 * and calls `row.select()`, so none of them has to know — and none of them can
 * get it wrong the way they all did before (rendering an empty connector array
 * as an empty menu, with no error to explain it).
 */
export function useWallet() {
  const { address, isConnected, chainId, status } = useAccount();
  const { connectors, connect, isPending } = useConnect();
  const disconnect = useWalletDisconnect();
  const { name: basename } = useBasename(address);
  // `null` on the default tree. Non-null means `@privy-io/wagmi` owns the wagmi
  // config, and `connectors` above is therefore EMPTY — see connect-bridge.tsx.
  const privy = usePrivyConnect();

  // Connect + clear the explicit-disconnect intent so BaseAppAutoConnect resumes
  // silent host-binding next session. Shared by both branches below, so the
  // intent flag can't be cleared on one path and forgotten on the other.
  const clearThen = useCallback((run: () => void) => {
    clearUserDisconnected();
    run();
  }, []);

  const wallets = useMemo<WalletMeta[]>(() => {
    // ── Privy tree ────────────────────────────────────────────────────────
    // wagmi's connector list is empty here by construction, so the rows come
    // from our curated PRIVY_WALLET_LIST and each one opens Privy's modal
    // filtered to that single wallet. Rendering `connectors` instead is what
    // produced the empty "SELECT WALLET" menu.
    if (privy) {
      return PRIVY_WALLET_LIST.map((w) => ({
        key:      w.id,
        name:     w.name,
        icon:     w.icon,
        subtitle: w.subtitle,
        select:   () => clearThen(() => privy.connectWallet(w.id)),
      }));
    }

    // ── Default tree ──────────────────────────────────────────────────────
    // De-dup EIP-6963 discovery: the same wallet can surface twice — once as the
    // generic "Injected" entry, once by its real name. Keep the first by name.
    const seen = new Set<string>();
    return connectors
      .filter((c) => {
        const key = c.name.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((c) => ({
        key:      c.uid,
        name:     c.name,
        icon:     walletIcon(c.name),
        subtitle: walletSubtitle(c.name),
        select:   () => clearThen(() => connect({ connector: c })),
      }));
  }, [privy, connectors, connect, clearThen]);

  // Coinbase Smart Wallet gets split out because two surfaces (BlueBank, the
  // /pay page) lead with it as a "create a free wallet — no seed phrase, no app
  // to install" onboarding CTA and demote everything else behind an "I already
  // have a wallet" toggle. They each used to re-derive this split with their own
  // copy of the matcher; it lives here now so the funnel can't drift per page.
  //
  // Matched on the display NAME (not a connector id) so the same matcher works
  // on both trees — the Privy row has no wagmi connector to read an id from.
  const coinbase = useMemo(
    () => wallets.find((w) => w.name.toLowerCase().includes("coinbase")),
    [wallets],
  );
  const others = useMemo(() => wallets.filter((w) => w !== coinbase), [wallets, coinbase]);

  const label = basename ?? (address ? shortAddr(address) : undefined);

  // wagmi settles to "connected" | "disconnected" once it has finished restoring
  // a persisted session; until then it is "connecting"/"reconnecting". Callers
  // that gate a *number* on the wallet (credits, allowances) must wait for that,
  // or they render a guest allowance for the split second before the reconnect
  // lands and it reads as "my credits reset".
  const isReady = status !== "connecting" && status !== "reconnecting";

  return {
    address,
    isConnected: isConnected && !!address,
    chainId,
    status,
    isReady,      // wagmi has finished deciding — `address` is now trustworthy
    basename,
    label,        // Basename if present, else short 0x… (undefined when no wallet)
    wallets,      // wallet rows with icon + subtitle; call `w.select()` to connect
    coinbase,     // the Coinbase entry, if available (the "free wallet" CTA)
    others,       // `wallets` minus coinbase — the "I already have a wallet" list
    disconnect,   // records intent so auto-connect won't undo it
    isPending,    // a connect attempt is in flight (wagmi tree only — Privy
                  // drives its own modal spinner, so this stays false there)
  };
}
