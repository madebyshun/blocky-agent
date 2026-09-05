"use client";

/**
 * Blue Chat — SIWE sign-in (browser half).
 *
 * Three steps, in this order and no other:
 *   1. GET  /api/auth/nonce      → a nonce the SERVER minted and recorded
 *   2. sign `sessionSiweMessage(host, address, nonce)` in the wallet
 *   3. POST /api/auth/session    → server verifies, sets an httpOnly cookie
 *
 * Step 1 is not optional and cannot be replaced with a locally generated nonce.
 * The existing Hub submit flow does exactly that (`SubmitTool.tsx` calls
 * `crypto.randomUUID()` and posts it alongside the signature), which means the
 * server never recorded issuing it and can never detect it being replayed. Here
 * the nonce round-trips so the server can spend it exactly once.
 *
 * The message itself comes from the shared `lib/siwe-session-message` module —
 * imported, never re-typed, because the server verifies against the identical
 * string and a one-character drift produces a misleading "wrong signature".
 */

import { useCallback } from "react";
import { useSignMessage } from "wagmi";
import { sessionSiweMessage } from "@/lib/siwe-session-message";

export function useSiweSignIn() {
  // Same hook the Hub's SubmitTool / DashboardView already sign with, so this
  // inherits the Privy-routed connector setup from #142 rather than adding a
  // second, differently-behaving signing path.
  const { signMessageAsync } = useSignMessage();

  /** Resolves to the signed-in wallet, or throws with a message fit for the UI. */
  return useCallback(async (address: string): Promise<string> => {
    const nonceRes = await fetch("/api/auth/nonce", { cache: "no-store" });
    if (!nonceRes.ok) {
      const body = await nonceRes.json().catch(() => ({}));
      throw new Error(String(body?.error ?? "Could not start sign-in."));
    }
    const { nonce } = await nonceRes.json();
    if (typeof nonce !== "string" || !nonce) throw new Error("Could not start sign-in.");

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
