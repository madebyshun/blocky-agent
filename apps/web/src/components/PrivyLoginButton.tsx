"use client";

// The email → embedded-wallet entry point (task #90). Renders ONLY inside the
// Privy provider tree (WalletPicker guards it behind `PRIVY_ENABLED`), so
// `usePrivy()` always has its provider — it can never throw the
// "must be used within PrivyProvider" error on the default (Privy-off) path.
//
// Not-authenticated → "Sign in with email"; Privy opens its own hosted modal,
// verifies the code, and (per privyClientConfig) provisions an embedded wallet
// for users without one. @privy-io/wagmi's WagmiProvider then makes that wallet
// the active `useAccount()` — the rest of the app (balances, swap, send) picks
// it up with no extra wiring.
//
// Authenticated → a sign-out control that logs out of Privy AND runs the app's
// own wallet-disconnect (records the explicit-disconnect intent so
// BaseAppAutoConnect won't silently re-bind), keeping the two in lock-step.
import { usePrivy } from "@privy-io/react-auth";
import { useWalletDisconnect } from "@/lib/walletSession";

export default function PrivyLoginButton({ onDone }: { onDone?: () => void }) {
  const { ready, authenticated, login, logout, user } = usePrivy();
  const disconnect = useWalletDisconnect();

  const base =
    "w-full flex items-center justify-center gap-2 font-mono text-xs font-semibold px-3 py-2.5 rounded-lg border transition-all disabled:opacity-50";

  if (!ready) {
    return (
      <button disabled className={base} style={{ borderColor: "#1A1A2E", color: "#64748b" }}>
        Loading…
      </button>
    );
  }

  if (authenticated) {
    const email = user?.email?.address;
    return (
      <button
        onClick={() => { logout(); disconnect(); onDone?.(); }}
        className={base}
        style={{ borderColor: "#1A1A2E", color: "#94a3b8" }}
      >
        Sign out{email ? ` · ${email}` : ""}
      </button>
    );
  }

  return (
    <button
      onClick={() => { login(); onDone?.(); }}
      className={base}
      style={{ borderColor: "#4FC3F7", color: "#4FC3F7", background: "#4FC3F710" }}
    >
      ✉️ Sign in with email — no wallet needed
    </button>
  );
}
