"use client";

// Makes "signed in" mean "has a wallet" again on the Privy tree.
//
// THE BUG THIS FIXES
// ------------------
// A user signs in with X/Google/email. Privy provisions (or already holds) a
// wallet for them. The account menu correctly shows their name and avatar. And
// yet every credit surface reads them as an anonymous guest:
//
//   /app/usage        "Credits & agent spend · no wallet"  + a Connect gate
//   Blue Chat         "100 credits"  (GUEST_DAILY, not the 500 a wallet gets)
//   Settings ▸ Account "Connect Wallet"
//
// Clicking Connect inside chat fixes it — which is what makes the whole thing
// look like a display bug rather than what it is: `useAccount()` genuinely has
// no address, so every surface downstream of `useWallet()` is telling the truth
// about a wagmi state that should not have been empty.
//
// WHY WAGMI IS EMPTY (measured against @privy-io/wagmi 4.0.16)
// ------------------------------------------------------------
// `useSyncPrivyWallets` (dist/esm/useSyncPrivyWallets.mjs) builds one injected
// connector per Privy wallet and then auto-reconnects — but the reconnect is
// skipped when wagmi's persisted `<connectorId>.disconnected` flag is set:
//
//     const recent = await config.storage?.getItem("recentConnectorId");
//     (recent && await config.storage?.getItem(`${recent}.disconnected`)) || reconnect();
//
// That flag is written by wagmi's own `disconnect()` — i.e. by our "Disconnect
// wallet" button (`useWalletDisconnect`) — and it lives in **localStorage**, so
// it outlives the tab. The package clears it in exactly three callbacks:
// `useConnectWallet`, `useConnectOrCreateWallet`, and `useLogin({onComplete})`.
//
// All three are EVENTS. A restored session is not one of them. So:
//
//   disconnect once  →  flag set for ever
//   reopen the app   →  Privy restores the session (no `login` event fires)
//                    →  flag still set  →  no reconnect  →  "no wallet"
//   click Connect    →  `connectWallet` fires  →  flag cleared  →  works
//
// which is precisely the reported shape: signed in everywhere, wallet-less in
// the credit path, and repairable only by connecting again from inside chat.
//
// `lib/walletSession.ts` was supposed to own this decision, but its
// `clearUserDisconnected()` only clears OUR sessionStorage intent key — it has
// never touched wagmi's persistent per-connector flag, so the two disagreed and
// the persistent one won.
//
// WHY THIS AND NOT A SECOND ADDRESS SOURCE
// ----------------------------------------
// The tempting fix is to read `user.wallet.address` out of Privy and feed it to
// the credits code directly. That would light up the numbers and quietly create
// a wallet the app cannot sign with: `useWallet().address` also feeds SIWE,
// send, swap and bridge. Activating the wallet in wagmi instead means ONE
// address everywhere, with a real signer behind it, and no surface has to learn
// which identity system it is talking to.
//
// WHAT IT DELIBERATELY DOES NOT DO
// --------------------------------
//   - No wallet in `wallets` → nothing happens. A user who genuinely has no
//     wallet keeps seeing "Connect Wallet", which is the honest answer.
//   - An explicit disconnect THIS SESSION is honoured via `wasUserDisconnected()`
//     — same guard, same reasoning as `BaseAppAutoConnect`. Per that file's
//     contract the intent is per-tab: reopening the app is a fresh intent and
//     auto-connect resumes, which is what makes a stale flag stop being permanent.
//   - It never overrides a live connection: it only runs while `address` is
//     undefined, so an external wallet already connected is left alone.
import { useEffect, useRef } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { useSetActiveWallet } from "@privy-io/wagmi";
import { useAccount, useConnect } from "wagmi";
import { wasUserDisconnected } from "@/lib/walletSession";

/** Mounted inside the Privy provider tree only — `usePrivy()` throws elsewhere. */
export default function PrivyWalletActivate() {
  const { ready, authenticated } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const { setActiveWallet } = useSetActiveWallet();
  const { address } = useAccount();
  // `useSyncPrivyWallets` installs the per-wallet connectors in an effect, so on
  // the first pass `config.connectors` can still be empty and `setActiveWallet`
  // finds nothing to attach to. Reading the list here re-runs us the moment it
  // is populated, instead of leaving the user connected-less until a re-render
  // happens to arrive.
  const { connectors } = useConnect();

  // One attempt per (wallet, connector-list) pair. Without this a connector
  // that exists but refuses to attach would be retried on every render; with it
  // a genuine retry still happens as soon as either side actually changes.
  const attempted = useRef<string | null>(null);

  useEffect(() => {
    if (!ready || !walletsReady || !authenticated) return;
    if (address) { attempted.current = null; return; }  // already connected
    if (wasUserDisconnected()) return;                  // honour an explicit disconnect

    // Prefer the embedded wallet: it is the one a social/email signup owns and
    // the one that is provisioned without the user ever seeing a wallet UI.
    const wallet = wallets.find((w) => w.walletClientType === "privy") ?? wallets[0];
    if (!wallet) return;

    const key = `${wallet.address}:${connectors.length}`;
    if (attempted.current === key) return;
    attempted.current = key;

    // Resolves to a no-op when no matching connector is registered yet — the
    // `connectors.length` half of the key brings us back when one appears.
    void setActiveWallet(wallet);
  }, [ready, walletsReady, authenticated, address, wallets, connectors.length, setActiveWallet]);

  return null;
}
