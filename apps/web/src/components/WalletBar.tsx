"use client";

import { useState, useEffect } from "react";
import {
  fetchBlueBalance,
  getTierInfo,
  getCredits,
  GUEST_DAILY,
  TierInfo,
} from "@/lib/credits";
import { useWallet } from "@/hooks/useWallet";
import { WalletPickerModal } from "@/components/WalletPicker";

interface WalletBarProps {
  onWalletChange?: (address: string | undefined, tier: TierInfo) => void;
  refreshTrigger?: number; // increment to force balance re-fetch
}

function fmtCredits(n: number) {
  if (n >= 10_000) return (n / 1000).toFixed(1) + "k";
  return n.toLocaleString();
}

export default function WalletBar({ onWalletChange, refreshTrigger = 0 }: WalletBarProps) {
  // Single wallet surface — address/label/connect/disconnect all come from the
  // shared hook, so the picker + label match every other connect UI.
  const { address, isConnected, label, disconnect, isPending } = useWallet();

  const [tier,    setTier]    = useState<TierInfo>({ tier: "Guest", blueBalance: 0, dailyCr: GUEST_DAILY, discount: 0, color: "#4FC3F7" });
  const [credits, setCredits] = useState(0);
  // Ledger balance fetched from /api/credits/balance/[address] — same source
  // as the dashboard + settings card. Connected wallets render this number;
  // guests fall back to the localStorage daily quota.
  const [ledger,  setLedger]  = useState<{ balance: number } | null>(null);
  const [picker,  setPicker]  = useState(false);

  useEffect(() => {
    if (!address) {
      const t = { tier: "Guest" as const, blueBalance: 0, dailyCr: GUEST_DAILY, discount: 0, color: "#4FC3F7" };
      setTier(t);
      setCredits(getCredits(undefined) ?? 0);
      setLedger(null);
      onWalletChange?.(undefined, t);
      return;
    }
    (async () => {
      const balance = await fetchBlueBalance(address);
      const t       = getTierInfo(balance);
      setTier(t);
      setCredits(Math.max(0, getCredits(address) ?? 0));
      onWalletChange?.(address, t);

      try {
        const res = await fetch(`/api/credits/balance/${address}`);
        const d   = await res.json();
        const bal = Number(d?.balance);
        if (Number.isFinite(bal)) setLedger({ balance: bal });
      } catch { /* leave previous ledger in place */ }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, refreshTrigger]);

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

  // ── Connected — static chip + disconnect (no popup; full detail lives in the
  //    surrounding Settings card) ───────────────────────────────────────────
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 font-mono text-xs px-3 py-2 rounded-lg border border-[#1A1A2E] bg-[#0D0D14]">
        <span className="w-2 h-2 rounded-full shrink-0"
          style={{ background: tier.color, boxShadow: `0 0 6px ${tier.color}` }} />
        <span className="text-slate-300">{label}</span>
        <span className="text-slate-600">·</span>
        <span style={{ color: "#4FC3F7" }}>
          {fmtCredits(ledger?.balance ?? credits)} cr
        </span>
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
