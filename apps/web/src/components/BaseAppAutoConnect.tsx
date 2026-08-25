"use client";

import { useEffect, useRef } from "react";
import { useConnect, useAccount } from "wagmi";
import { wasUserDisconnected } from "@/lib/walletSession";

/**
 * Auto-connects the wallet when BlueAgent is opened INSIDE Base App / Farcaster
 * (or the Coinbase in-app browser). In those hosts the wallet is the host frame
 * itself, so prompting the user to click "Connect" is pointless friction —
 * we silently bind to the host connector on mount.
 *
 * Deliberately inert in a normal browser tab: the detection below only fires in
 * an embedded Mini App frame / Coinbase browser, so desktop Chrome/Safari still
 * get the usual manual Connect button (ConnectModal) untouched.
 *
 * ⚠️ KNOWN GAP — THIS IS CURRENTLY A NO-OP WHEN PRIVY IS ENABLED, and it fails
 * silently (the `if (!host) return` below), which is why it went unnoticed.
 * `@privy-io/wagmi` empties wagmi's connector list (see the note on
 * `privyConfig` in Providers.tsx), so `connectors` here is `[]` and neither
 * `farcasterMiniApp` nor `coinbaseWalletSDK` can be found — Base App / Farcaster
 * users get no silent host bind and must connect manually.
 *
 * NOT fixed in the same PR as the picker repair on purpose. The obvious fix —
 * gate the Privy provider on `!inMiniAppFrame` — decides the PROVIDER TREE from
 * a client-only value (`window.top !== window.self`), which the server cannot
 * see, so SSR would render the Privy tree and the client would render the wagmi
 * one: a hydration mismatch on the app's outermost provider. Doing it properly
 * means detecting the frame server-side (`Sec-Fetch-Dest: iframe`) and passing
 * it down as a prop, and it needs testing inside a real Base App embed — its own
 * PR, not a rider on this one.
 */
export default function BaseAppAutoConnect() {
  const { isConnected } = useAccount();
  const { connect, connectors } = useConnect();
  // Guard so we only ever attempt the silent connect once per mount, even if
  // wagmi re-renders while the host is resolving the account.
  const tried = useRef(false);

  useEffect(() => {
    if (isConnected || tried.current) return;

    // Respect an explicit user disconnect: if the user tapped "Disconnect" this
    // session, do NOT silently re-bind the host wallet on the next mount. The
    // flag is cleared the moment they manually connect again.
    if (wasUserDisconnected()) return;

    // Host detection — only an embedded Mini App / Coinbase context qualifies.
    const w = window as unknown as { ethereum?: { isCoinbaseWallet?: boolean } };
    const inFrame = window.top !== window.self;
    const isCoinbaseBrowser =
      w.ethereum?.isCoinbaseWallet === true ||
      navigator.userAgent.includes("CoinbaseBrowser");
    const fromBaseApp =
      document.referrer.includes("base.app") ||
      document.referrer.includes("base.org");

    if (!inFrame && !isCoinbaseBrowser && !fromBaseApp) return;

    // Prefer the Mini App host connector (Farcaster / Base App embeds register
    // it only inside a frame); fall back to the Coinbase Smart Wallet SDK.
    const host =
      connectors.find(c => c.id === "farcasterMiniApp" || c.name.toLowerCase().includes("farcaster")) ??
      connectors.find(c => c.id === "coinbaseWalletSDK" || c.name.toLowerCase().includes("coinbase"));

    if (!host) return;
    tried.current = true;
    connect({ connector: host });
  }, [isConnected, connect, connectors]);

  return null;
}
