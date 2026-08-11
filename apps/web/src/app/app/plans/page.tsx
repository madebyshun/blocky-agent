"use client";

// /app/plans — pricing comparison. Free daily allowance vs. the USDC credit
// packs. This is a PRICING PAGE ONLY — it introduces no new billing mechanism:
// every "Get credits" button opens the existing TopUpModal, which runs the same
// non-custodial USDC → credits flow (CREDIT_PACKS) used everywhere else.
//
// The Free-tier numbers are the REAL flat daily allowances (WALLET_DAILY /
// GUEST_DAILY from lib/credits) — not marketing figures.

import { useState } from "react";
import Link from "next/link";
import { useWallet } from "@/hooks/useWallet";
import { WalletPickerModal } from "@/components/WalletPicker";
import TopUpModal from "@/components/TopUpModal";
import { CREDIT_PACKS, CREDITS_PER_USDC } from "@/lib/payments";
import { WALLET_DAILY, GUEST_DAILY } from "@/lib/credits";

export default function PlansPage() {
  const { isConnected } = useWallet();
  const [picker, setPicker] = useState(false);
  const [topup, setTopup]   = useState(false);

  return (
    <div className="flex flex-col h-full bg-[#050508] overflow-hidden">
      {/* Header */}
      <div className="flex items-center px-5 sm:px-6 h-14 border-b border-[#1A1A2E] flex-shrink-0">
        <div className="min-w-0">
          <p className="font-mono text-xs text-[#4FC3F7] tracking-widest truncate">// PLANS</p>
          <p className="font-mono text-[10px] text-slate-700 mt-1 truncate">
            Credits power chat & tool runs · 1 USDC = {CREDITS_PER_USDC.toLocaleString()} credits
          </p>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-y-auto px-5 sm:px-6 py-6">
        <div className="max-w-3xl mx-auto space-y-6">
          {/* ── Free tier ──────────────────────────────────────────────── */}
          <div className="rounded-2xl border border-[#1A1A2E] bg-[#0A0A12] p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="font-mono text-[13px] font-bold text-white">Free</p>
                <p className="font-mono text-[11px] text-slate-500 mt-1 leading-relaxed">
                  A fresh daily allowance for everyone — no card, no token. Use-it-or-lose-it,
                  refreshes every 24h.
                </p>
              </div>
              <div className="text-right flex-shrink-0">
                <p className="font-mono text-2xl font-bold text-[#4FC3F7]">
                  {WALLET_DAILY.toLocaleString()}
                </p>
                <p className="font-mono text-[10px] text-slate-600">credits / day</p>
              </div>
            </div>
            <div className="mt-4 flex items-center justify-between">
              <p className="font-mono text-[10px] text-slate-600">
                {GUEST_DAILY.toLocaleString()} / day without a wallet · {WALLET_DAILY.toLocaleString()} / day once connected
              </p>
              {isConnected ? (
                <span className="font-mono text-[10px] text-[#34D399] font-bold px-2.5 py-1 rounded-md border border-[#34D399]/25">
                  ACTIVE
                </span>
              ) : (
                <button
                  onClick={() => setPicker(true)}
                  className="font-mono text-[11px] font-bold px-3.5 py-1.5 rounded-lg border border-[#1A1A2E] text-slate-300 hover:border-slate-600 transition-colors"
                >
                  Connect wallet
                </button>
              )}
            </div>
          </div>

          {/* ── Credit packs ───────────────────────────────────────────── */}
          <div>
            <p className="font-mono text-[10px] text-slate-600 tracking-widest uppercase mb-3">
              Top up with USDC on Base · non-custodial
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {CREDIT_PACKS.map((pack) => (
                <button
                  key={pack.usdc}
                  onClick={() => setTopup(true)}
                  className="relative text-left rounded-xl border border-[#1A1A2E] bg-[#0A0A12] p-4 hover:border-[#4FC3F7]/50 transition-colors"
                >
                  {pack.popular && (
                    <span
                      className="absolute -top-2 right-3 font-mono text-[8px] font-bold px-1.5 py-0.5 rounded"
                      style={{ background: "#4FC3F7", color: "#050508" }}
                    >
                      POPULAR
                    </span>
                  )}
                  <p className="font-mono text-[10px] text-slate-500">{pack.label}</p>
                  <p className="font-mono text-2xl font-bold text-white mt-1">${pack.usdc}</p>
                  <p className="font-mono text-[11px] text-[#4FC3F7] mt-1">
                    {pack.credits.toLocaleString()} cr
                  </p>
                  <p className="font-mono text-[9px] text-slate-700 mt-2">Get credits →</p>
                </button>
              ))}
            </div>
          </div>

          {/* ── Notes ──────────────────────────────────────────────────── */}
          <div className="rounded-xl border border-[#1A1A2E] bg-[#0A0A12] p-4 space-y-1.5">
            <p className="font-mono text-[10px] text-slate-500 leading-relaxed">
              · Top-up credits go into a cumulative pool — they never expire and are spent only
              after the daily allowance runs out.
            </p>
            <p className="font-mono text-[10px] text-slate-500 leading-relaxed">
              · You sign every transfer from your own wallet. Blue Agent never holds your keys.
            </p>
            <p className="font-mono text-[10px] text-slate-500 leading-relaxed">
              · Track your balance and spend on the{" "}
              <Link href="/usage" className="text-[#4FC3F7] hover:underline">Usage</Link> page.
            </p>
          </div>
        </div>
      </div>

      <WalletPickerModal open={picker} onClose={() => setPicker(false)} />
      <TopUpModal open={topup} onClose={() => setTopup(false)} />
    </div>
  );
}
