"use client";

// Launch-airdrop banner — "Claim 1,000 free credits", first 300 wallets.
// Reads live slots-remaining from /api/credits/claim (scarcity counter), claims
// for the connected wallet, and refreshes the credit balance on success. Hidden
// once the user has claimed, dismissed it, or the campaign is full.

import { useEffect, useState } from "react";
import { useChat } from "../ChatContext";
import { WalletPickerModal } from "@/components/WalletPicker";

const DISMISS_KEY = "blueagent:claim-dismissed";

interface Status {
  amount: number;
  total: number;
  remaining: number;
  soldOut: boolean;
  claimed: boolean;
}

export default function ClaimBanner() {
  const { walletAddr, triggerWalletRefresh } = useChat();

  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [claimed, setClaimed] = useState(false);
  const [picker, setPicker] = useState(false);
  const [dismissed, setDismissed] = useState(true); // assume dismissed until we read storage (avoids flash)

  useEffect(() => {
    if (typeof window !== "undefined") setDismissed(localStorage.getItem(DISMISS_KEY) === "1");
  }, []);

  // Live status — re-fetch when the wallet changes so `claimed` is accurate.
  useEffect(() => {
    let off = false;
    const q = walletAddr ? `?address=${walletAddr}` : "";
    fetch(`/api/credits/claim${q}`)
      .then((r) => r.json())
      .then((d: Status) => { if (!off) { setStatus(d); if (d.claimed) setClaimed(true); } })
      .catch(() => {});
    return () => { off = true; };
  }, [walletAddr]);

  function dismiss() {
    setDismissed(true);
    try { localStorage.setItem(DISMISS_KEY, "1"); } catch {}
  }

  async function claim() {
    if (!walletAddr) { setPicker(true); return; }
    setBusy(true); setMsg("");
    try {
      const r = await fetch("/api/credits/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: walletAddr }),
      }).then((x) => x.json());

      if (r.ok && r.claimed) {
        setClaimed(true);
        setMsg(r.alreadyClaimed ? "You've already claimed your credits." : `✓ ${r.amount.toLocaleString()} credits added!`);
        triggerWalletRefresh();
      } else if (r.soldOut) {
        setMsg("Campaign is full — thanks for the interest!");
        setStatus((s) => (s ? { ...s, soldOut: true } : s));
      } else {
        setMsg(r.error || "Claim failed — try again.");
      }
    } catch {
      setMsg("Claim failed — try again.");
    } finally {
      setBusy(false);
    }
  }

  if (dismissed || !status) return null;
  if (status.soldOut && !claimed) return null;

  const showSuccess = claimed;

  return (
    <div className="shrink-0 px-3 sm:px-4 py-2 border-b border-[#1A1A2E]"
      style={{ background: "linear-gradient(90deg,#4FC3F710,#34D39908)" }}>
      <div className="flex items-center gap-3 max-w-3xl mx-auto">
        <span className="text-base shrink-0">{showSuccess ? "✓" : "🎁"}</span>
        <div className="min-w-0 flex-1">
          {showSuccess ? (
            <p className="font-mono text-[11px] text-[#34D399] truncate">
              {msg || `${status.amount.toLocaleString()} free credits are in your account.`}
            </p>
          ) : (
            <p className="font-mono text-[11px] text-slate-200 truncate">
              Claim <span className="text-[#4FC3F7] font-bold">{status.amount.toLocaleString()} free credits</span>
              <span className="text-slate-500"> · {status.remaining}/{status.total} left</span>
              {msg && <span className="text-amber-400"> · {msg}</span>}
            </p>
          )}
        </div>

        {!showSuccess && (
          <button onClick={claim} disabled={busy}
            className="shrink-0 font-mono text-[11px] font-bold px-3.5 py-1.5 rounded-lg disabled:opacity-60 transition-opacity hover:opacity-90"
            style={{ background: "#4FC3F7", color: "#050508" }}>
            {busy ? "…" : walletAddr ? "Claim" : "Connect & claim"}
          </button>
        )}

        <button onClick={dismiss} aria-label="Dismiss"
          className="shrink-0 w-6 h-6 rounded-md font-mono text-[12px] text-slate-600 hover:text-slate-300 hover:bg-[#1A1A2E] transition-colors">
          ✕
        </button>
      </div>

      {/* Shared wallet picker — same list/UX as every other connect surface. */}
      <WalletPickerModal open={picker} onClose={() => setPicker(false)} />
    </div>
  );
}
