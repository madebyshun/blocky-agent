"use client";

import { useState } from "react";
import { useWallet } from "@/hooks/useWallet";
import { WalletPickerModal } from "@/components/WalletPicker";

/**
 * WalletBar — "who is connected", and the connect/disconnect control.
 *
 * DELIBERATELY NOT A BALANCE. This used to render `<credits> cr` beside the
 * address, fetched from `/api/credits/balance/[address]` on its own. That put
 * the same number on screen three times from two independent fetches — the
 * sidebar chip and the Settings ▸ Credits pane both read ChatContext's copy,
 * while this one read its own — so the two could disagree while both claimed to
 * be your balance, and a failed fetch here silently fell back to a *different*
 * rail (the legacy localStorage daily quota) without saying so. Settings ▸
 * Credits is the one place that owns the number; this component owns identity.
 *
 * It also no longer reports the wallet upward. There was an `onWalletChange`
 * prop that ChatContext used as its ONLY route to the connected address, which
 * meant two invisible copies of this component had to stay mounted for chat to
 * know who you were. ChatContext reads `useWallet()` directly now.
 */
export default function WalletBar() {
  // Single wallet surface — address/label/connect/disconnect all come from the
  // shared hook, so the picker + label match every other connect UI.
  const { address, isConnected, label, disconnect, isPending } = useWallet();
  const [picker, setPicker] = useState(false);

  // ── Not connected — connect button opens the shared picker ──────────────────
  if (!isConnected || !address) {
    return (
      <div className="relative">
        <button
          onClick={() => setPicker(true)}
          disabled={isPending}
          className="w-full font-mono text-xs font-semibold px-3 py-2 rounded-lg border transition-all disabled:opacity-60"
          style={{ borderColor: "#4FC3F7", color: "#4FC3F7", background: "#4FC3F718" }}
        >
          {isPending ? "Connecting…" : "Connect Wallet"}
        </button>
        <span className="block font-mono text-[10px] text-slate-600 mt-1 px-0.5">→ Connect any wallet for 500 credits/day — no token needed</span>
        <WalletPickerModal open={picker} onClose={() => setPicker(false)} />
      </div>
    );
  }

  // ── Connected — address chip + disconnect ───────────────────────────────────
  // The dot is a literal, not `tier.color`: getTierInfo() has returned the same
  // primary for every wallet since the token-free move, so a variable here would
  // imply a distinction the app no longer makes.
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 font-mono text-xs px-3 py-2 rounded-lg border border-[#1A1A2E] bg-[#0D0D14]">
        <span
          className="w-2 h-2 rounded-full shrink-0"
          style={{ background: "#4FC3F7", boxShadow: "0 0 6px #4FC3F7" }}
        />
        <span className="text-slate-300 truncate">{label}</span>
      </div>
      <button
        onClick={() => disconnect()}
        className="self-start font-mono text-[11px] text-slate-400 hover:text-red-400 hover:border-red-400/30 border border-[#1A1A2E] rounded-lg px-3 py-1.5 transition-colors"
      >
        Disconnect wallet
      </button>
    </div>
  );
}
