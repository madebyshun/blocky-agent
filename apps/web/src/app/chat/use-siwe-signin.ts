"use client";

/**
 * Blue Chat — SIWE sign-in (browser half).
 *
 * Three steps, in this order and no other:
 *   1. GET  /api/auth/nonce      → a nonce the SERVER minted and recorded
 *   2. sign `sessionSiweMessage(host, address, nonce)` in the wallet
 *   3. POST /api/auth/session    → server verifies, sets an httpOnly cookie
 *
 * Step 1 is not optional and cannot be replaced with a locally generated nonce:
 * the server would never have recorded issuing it, so it could never detect the
 * signed body being replayed. Since #172 the Hub submit and remove flows share
 * this rule and the same `fetchServerNonce` helper — this was the first flow to
 * get it right, not the only one that needs it.
 *
 * The message itself comes from the shared `lib/siwe-session-message` module —
 * imported, never re-typed, because the server verifies against the identical
 * string and a one-character drift produces a misleading "wrong signature".
 */

import { useCallback } from "react";
import { useSignMessage } from "wagmi";
import { sessionSiweMessage } from "@/lib/siwe-session-message";
import { fetchServerNonce } from "@/lib/siwe-nonce";

export function useSiweSignIn() {
  // Same hook the Hub's SubmitTool / DashboardView already sign with, so this
  // inherits the Privy-routed connector setup from #142 rather than adding a
  // second, differently-behaving signing path.
  const { signMessageAsync } = useSignMessage();

  /** Resolves to the signed-in wallet, or throws with a message fit for the UI. */
  return useCallback(async (address: string): Promise<string> => {
    const nonce     = await fetchServerNonce();
    const message   = sessionSiweMessage(window.location.host.toLowerCase(), address, nonce);
    const signature = await signMessageAsync({ message });

    const res  = await fetch("/api/auth/session", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ address, signature, nonce }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(String(body?.error ?? "Sign-in failed."));
    return String(body.wallet);
  }, [signMessageAsync]);
}
