"use client";

// Wallet identity — WHAT the connected account actually is, DERIVED from the
// live wagmi connector plus on-chain bytecode.
//
// WHY THIS FILE EXISTS: the BlueBank health card used to render
//     <IdentityChip label="Smart Wallet" active={true} />
//     <IdentityChip label="Passkey"      active={true} />
// — two literals that were true of exactly one onboarding path (Coinbase Smart
// Wallet) and were shown to everybody. A MetaMask user, whose account is a
// plain secp256k1 EOA with a seed phrase, was told by the UI that they had a
// smart wallet secured by a passkey. Both claims were false, and no amount of
// care elsewhere could have caught it: a constant cannot drift back into
// agreement with reality, because it was never reading reality.
//
// This is the same rule `describeLoginMethods()` documents for sign-in copy —
// a claim must be COMPUTED from its source of truth, never typed out beside it.
// The sources here are:
//   1. `useAccount().connector` — which connector is connected RIGHT NOW.
//   2. `useBytecode()` at the account address — whether the chain says this
//      address is a contract.
//
// AND THE THIRD ANSWER IS "UNKNOWN". Neither source is total: bytecode reads
// are async and can fail, and an undeployed (counterfactual) smart account is
// byte-for-byte indistinguishable from an EOA until its first transaction. So
// every fact below is three-valued. Collapsing "unknown" into "no" would just
// be the original bug pointed the other way — see CLAUDE.md: missing data is
// "unknown", never an inferred negative.

import { useMemo } from "react";
import { useAccount, useBytecode } from "wagmi";

/** "we don't know yet" is a real answer here, not a failure to compute one. */
export type Tri = "yes" | "no" | "unknown";

export type WalletFamily =
  | "privy-embedded"
  | "coinbase"
  | "base-account"
  | "walletconnect"
  | "farcaster"
  | "injected"
  | "unknown";

export type AccountKind =
  /** Contract code at the address — an account-abstraction wallet. */
  | "smart"
  /** No code, and the connector is one that only ever holds EOAs. */
  | "eoa"
  /** EIP-7702 delegation designator (`0xef0100…`) — an EOA wearing a contract. */
  | "delegated-eoa"
  /** Read not finished, read failed, or a possibly-counterfactual smart account. */
  | "unknown";

export interface WalletIdentity {
  /** Display name of the live connection, e.g. "MetaMask", "Privy Wallet". */
  connectionLabel: string;
  /** Normalised connector family — the discriminator the rules below key on. */
  family: WalletFamily;
  accountKind: AccountKind;
  /** Chip text for the account kind, already resolved for the unknown case. */
  accountLabel: string;
  passkey: Tri;
  /** Chip text for the passkey fact, already resolved for the unknown case. */
  passkeyLabel: string;
}

/**
 * Connector → family.
 *
 * Matched on `id` AND `name` together, lowercased, by substring — deliberately
 * loose. On the DEFAULT tree these are wagmi's own ids (`coinbaseWalletSDK`,
 * `walletConnect`, an EIP-6963 rdns like `io.metamask`). On the PRIVY tree they
 * are something else entirely: `@privy-io/wagmi` rebuilds every wallet as
 * `injected({ target: { id: toWalletConnectorId(w), name: w.meta.name } })`, so
 * `type` is uselessly `"injected"` for ALL of them and the id is Privy's
 * `wallet.meta.id` (`io.privy.wallet.0x…` for the embedded wallet). One matcher
 * has to cover both spellings of the same wallet, hence substrings over
 * equality — an unrecognised wallet lands on "unknown", which is a valid state,
 * not a crash.
 */
export function walletFamily(id?: string, name?: string): WalletFamily {
  const s = `${id ?? ""} ${name ?? ""}`.toLowerCase();
  if (!s.trim()) return "unknown";
  // Privy's embedded wallet id is `io.privy.wallet.<address>` — prefix match.
  if (s.includes("io.privy.wallet")) return "privy-embedded";
  // Before "coinbase": Base Account is its own passkey wallet, and matching it
  // as Coinbase would be right by accident rather than by rule.
  if (s.includes("base_account") || s.includes("baseaccount") || s.includes("base account")) return "base-account";
  if (s.includes("coinbase")) return "coinbase";
  if (s.includes("walletconnect") || s.includes("wallet_connect")) return "walletconnect";
  if (s.includes("farcaster") || s.includes("mini app") || s.includes("miniapp")) return "farcaster";
  if (
    s.includes("metamask") || s.includes("rabby") || s.includes("phantom") ||
    s.includes("rainbow")  || s.includes("zerion") || s.includes("injected") ||
    s.includes("brave")    || s.includes("okx")    || s.includes("trust")
  ) return "injected";
  return "unknown";
}

/**
 * Families whose accounts are ALWAYS externally-owned, so "no bytecode" is a
 * real answer rather than an inconclusive one.
 *
 * Everything else stays "unknown" on an empty read, because a smart account is
 * counterfactual until its first transaction — a fresh Coinbase Smart Wallet
 * has no code on Base yet still is one. Base App's host wallet is frequently a
 * Smart Wallet too, so `farcaster` does NOT belong here.
 *
 * `privy-embedded` qualifies only because this app never enables Privy's smart
 * -account connector (`privyClientConfig` configures `embeddedWallets` alone),
 * so a Privy wallet here is always a plain key. Turn that on and this array is
 * the line that has to change.
 */
const ALWAYS_EOA: readonly WalletFamily[] = ["privy-embedded", "injected"];

/** Families whose smart accounts are passkey-owned by construction. */
const PASSKEY_SMART: readonly WalletFamily[] = ["coinbase", "base-account"];

/** EIP-7702 delegation designator prefix (EOA pointing at a delegate). */
const EIP7702_PREFIX = "0xef0100";

export interface WalletIdentityInput {
  isConnected: boolean;
  connectorId?: string;
  connectorName?: string;
  /** `useBytecode().data` — `undefined` for an address with no code. */
  bytecode?: string;
  /** `useBytecode().status` — a pending/error read must not read as "EOA". */
  bytecodeStatus: "pending" | "error" | "success";
}

/** Pure — the whole derivation, so it can be reasoned about without React. */
export function deriveWalletIdentity(input: WalletIdentityInput): WalletIdentity {
  const { isConnected, connectorId, connectorName, bytecode, bytecodeStatus } = input;
  const family = isConnected ? walletFamily(connectorId, connectorName) : "unknown";

  const connectionLabel = !isConnected
    ? "Not connected"
    : connectorName?.trim() || FAMILY_LABELS[family];

  // ── Account kind ────────────────────────────────────────────────────────
  const hasCode = bytecodeStatus === "success" && !!bytecode && bytecode !== "0x";
  const accountKind: AccountKind =
    !isConnected                                  ? "unknown"
    : hasCode && bytecode!.toLowerCase().startsWith(EIP7702_PREFIX) ? "delegated-eoa"
    : hasCode                                     ? "smart"
    // An empty read only means EOA for families that cannot be anything else.
    : bytecodeStatus === "success" && ALWAYS_EOA.includes(family) ? "eoa"
    : "unknown";

  // ── Passkey ─────────────────────────────────────────────────────────────
  // "no" for an EOA is a DERIVATION, not a guess: a WebAuthn passkey signs
  // P-256, an Ethereum EOA is authorised by secp256k1, so a passkey cannot
  // control one. The positive case needs both halves — a Coinbase connector
  // alone can't distinguish the passkey Smart Wallet from the seed-phrase
  // browser extension, since `coinbaseWallet({ preference: "all" })` connects
  // either one under the same connector id.
  const passkey: Tri =
    accountKind === "eoa"                                                 ? "no"
    : accountKind === "smart" && PASSKEY_SMART.includes(family)           ? "yes"
    : "unknown";

  return {
    connectionLabel,
    family,
    accountKind,
    accountLabel: ACCOUNT_LABELS[accountKind],
    passkey,
    passkeyLabel: PASSKEY_LABELS[passkey],
  };
}

const FAMILY_LABELS: Record<WalletFamily, string> = {
  "privy-embedded": "Privy embedded",
  coinbase:         "Coinbase Wallet",
  "base-account":   "Base Account",
  walletconnect:    "WalletConnect",
  farcaster:        "Base App wallet",
  injected:         "Browser wallet",
  unknown:          "Unknown wallet",
};

// "?" suffixes are load-bearing: they are how the card admits it is guessing
// nothing. A chip reading "Smart Wallet" with no qualifier must mean the chain
// said so.
const ACCOUNT_LABELS: Record<AccountKind, string> = {
  smart:           "Smart Wallet",
  eoa:             "EOA",
  "delegated-eoa": "EOA · 7702",
  unknown:         "Wallet type ?",
};

const PASSKEY_LABELS: Record<Tri, string> = {
  yes:     "Passkey",
  no:      "No passkey",
  unknown: "Passkey ?",
};

/**
 * Live identity of the connected account on `chainId`.
 *
 * `chainId` is the network the surrounding UI is DISPLAYING, not necessarily
 * the one the wallet sits on — same convention as every balance read in
 * BankClient. That matters: a Smart Wallet deployed on Base has no code on
 * Base Sepolia, and reading the wrong chain would downgrade it to "unknown"
 * (never to a false "EOA", by the rule above).
 */
export function useWalletIdentity(chainId?: number): WalletIdentity {
  const { address, connector, isConnected } = useAccount();
  const { data: bytecode, status } = useBytecode({
    address,
    chainId,
    // Account code changes at most once (deploy / 7702 delegation), so this is
    // about as cacheable as an on-chain read gets.
    query: { enabled: !!address, staleTime: 60_000 },
  });

  const connectorId = connector?.id;
  const connectorName = connector?.name;

  return useMemo(
    () => deriveWalletIdentity({
      isConnected: isConnected && !!address,
      connectorId,
      connectorName,
      bytecode,
      bytecodeStatus: status,
    }),
    [isConnected, address, connectorId, connectorName, bytecode, status],
  );
}
