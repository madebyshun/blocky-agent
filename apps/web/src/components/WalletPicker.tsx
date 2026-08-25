"use client";

import { useState } from "react";
import { useWallet } from "@/hooks/useWallet";
import PrivyLoginButton from "./PrivyLoginButton";
import { PRIVY_ENABLED } from "@/lib/privy/config";

/**
 * WalletPickerModal — the standard wallet-selection modal.
 *
 * Full-screen fixed overlay (z-200) so it's never clipped by an
 * `overflow:hidden` ancestor. Renders the de-duped connector list from
 * `useWallet()`, so the wallet list + icons are identical on every surface
 * (chat settings, claim banner, /app pages).
 *
 * Two surfaces don't use this modal: BlueBank (`/app/bank`) and the payment
 * page (`/pay/[address]`) lead with a "create a free wallet" Coinbase CTA and
 * hide the rest behind a toggle — onboarding design, not drift. Both are
 * ARCHIVED as of 2026-07-24 (middleware 301s them to /chat), so their pickers
 * are currently unreachable; they still read `coinbase`/`others` from
 * `useWallet()` rather than re-deriving the connector plumbing, so they'd be
 * correct if the routes are ever un-archived. Nothing in the app derives a
 * connector list locally anymore — which is what lets a single fix in
 * `useWallet` repair every picker at once.
 */
export function WalletPickerModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { wallets } = useWallet();
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xs rounded-2xl border border-[#1A1A2E] bg-[#0D0D1A] shadow-2xl shadow-black/80 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Email → embedded wallet, above the external-wallet list. Renders only
            when NEXT_PUBLIC_PRIVY_APP_ID is set; otherwise the modal is
            byte-identical to the pre-Privy picker. */}
        {PRIVY_ENABLED && (
          <div className="px-4 pt-4">
            <PrivyLoginButton onDone={onClose} />
            <div className="flex items-center gap-2 mt-3 mb-1">
              <div className="h-px flex-1 bg-[#1A1A2E]" />
              <span className="font-mono text-[9px] text-slate-600 uppercase tracking-widest">or</span>
              <div className="h-px flex-1 bg-[#1A1A2E]" />
            </div>
          </div>
        )}
        <p className="font-mono text-[10px] text-slate-600 px-4 pt-4 pb-2 tracking-widest uppercase">
          Select Wallet
        </p>

        {wallets.length === 0 && (
          <p className="px-4 pb-3 font-mono text-[11px] text-slate-600 leading-relaxed">
            No wallet detected. Install MetaMask, Rabby, or Coinbase Wallet, then reload.
          </p>
        )}

        {wallets.map((w) => (
          <button
            key={w.key}
            onClick={() => { w.select(); onClose(); }}
            className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-[#1A1A2E] transition-colors"
          >
            <span className="w-7 h-7 rounded-lg bg-[#1A1A2E] flex items-center justify-center text-base shrink-0">
              {w.icon}
            </span>
            <div>
              <p className="font-mono text-xs text-white">{w.name}</p>
              <p className="font-mono text-[10px] text-slate-600">{w.subtitle}</p>
            </div>
          </button>
        ))}

        <div className="px-4 pb-4 pt-1">
          <button
            onClick={onClose}
            className="w-full font-mono text-[10px] text-slate-600 hover:text-slate-400 py-2 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * ConnectButton — the canonical connect control.
 *   - Not connected → opens the shared picker.
 *   - Connected     → shows Basename / short address, disconnects on click.
 *
 * Drop-in for the previous `ConnectModal.ConnectButton` (identical props), so
 * `AppConnectPrompt` and any other caller keep working unchanged.
 */
export function ConnectButton({
  label = "Connect Wallet",
  className,
  style,
}: {
  label?: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const { isConnected, label: walletLabel, disconnect, isPending } = useWallet();
  const [open, setOpen] = useState(false);

  if (isConnected) {
    return (
      <button
        onClick={() => disconnect()}
        className={className ?? "font-mono text-xs text-slate-400 hover:text-white border border-[#1A1A2E] hover:border-slate-600 px-3 py-1.5 rounded-lg transition-all"}
      >
        {walletLabel}
      </button>
    );
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        disabled={isPending}
        className={className ?? "font-mono text-xs font-semibold px-3 py-1.5 rounded-lg border transition-all disabled:opacity-50"}
        style={style ?? { borderColor: "#4FC3F7", color: "#4FC3F7", background: "#4FC3F710" }}
      >
        {isPending ? "Connecting…" : label}
      </button>
      <WalletPickerModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}
