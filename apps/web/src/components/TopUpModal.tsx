"use client";

// TopUpModal — the "Pay with USDC" credit top-up (Dot-style).
//
// Non-custodial: the user signs a DIRECT USDC transfer from their own wallet to
// the Blue treasury (Virtuals wallet). The client then hands the settled txHash
// to POST /api/credits/purchase, which READS the on-chain receipt, verifies the
// USDC → treasury transfer, and credits the off-chain ledger. Nothing here holds
// a key or moves funds on the user's behalf — they sign every transfer.
//
// Credits are derived server-side from the on-chain USDC amount; the number this
// modal shows before signing is only a preview (CREDITS_PER_USDC).

import { useState } from "react";
import { useAccount, useWriteContract, useSwitchChain } from "wagmi";
import { parseUnits } from "viem";
import { useWallet } from "@/hooks/useWallet";
import { WalletPickerModal } from "@/components/WalletPicker";
import {
  CREDIT_PACKS,
  USDC_BASE,
  TOPUP_TREASURY,
  BASE_CHAIN_ID,
  ERC20_TRANSFER_ABI,
  CREDITS_PER_USDC,
  type CreditPack,
} from "@/lib/payments";

type Phase = "idle" | "confirming" | "verifying" | "done" | "error";

// Map wallet / RPC errors to a short human line.
function friendlyError(msg: string): string {
  const m = (msg || "").toLowerCase();
  if (m.includes("user rejected") || m.includes("user denied") || m.includes("rejected the request")) return "Payment cancelled.";
  if (m.includes("insufficient")) return "Insufficient USDC balance on Base for this pack.";
  if (m.includes("chain") && m.includes("switch")) return "Switch your wallet to Base mainnet and try again.";
  return msg.length > 140 ? msg.slice(0, 140) + "…" : msg || "Something went wrong — try again.";
}

export default function TopUpModal({
  open,
  onClose,
  onCredited,
}: {
  open: boolean;
  onClose: () => void;
  onCredited?: () => void; // called after the ledger is credited (refresh balance)
}) {
  const { address, isConnected } = useWallet();
  const { chainId } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const { switchChainAsync } = useSwitchChain();

  const [picker, setPicker]   = useState(false);
  const [phase, setPhase]     = useState<Phase>("idle");
  const [active, setActive]   = useState<number | null>(null); // usdc amount in-flight
  const [txHash, setTxHash]   = useState<string>("");
  const [credited, setCredited] = useState<number>(0);
  const [err, setErr]         = useState<string>("");

  if (!open) return null;

  const busy = phase === "confirming" || phase === "verifying";

  function reset() {
    setPhase("idle"); setActive(null); setTxHash(""); setCredited(0); setErr("");
  }

  function close() {
    if (busy) return; // don't let them close mid-signature/verify
    reset();
    onClose();
  }

  // POST the settled txHash to the verifier, retrying while the tx is still
  // being mined (the route returns 202 { pending } until the receipt exists).
  async function verify(hash: string, addr: string): Promise<void> {
    const MAX = 20;      // ~20 × 3s ≈ 60s of settlement wait
    for (let i = 0; i < MAX; i++) {
      let res: Response;
      try {
        res = await fetch("/api/credits/purchase", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ address: addr, txHash: hash }),
        });
      } catch {
        // network blip — wait and retry
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }

      const data = await res.json().catch(() => ({})) as {
        ok?: boolean; pending?: boolean; credits?: number; error?: string; alreadyCredited?: boolean;
      };

      if (res.ok && data.ok) {
        setCredited(Number(data.credits ?? 0));
        setPhase("done");
        onCredited?.();
        return;
      }
      if (res.status === 202 || data.pending) {
        await new Promise(r => setTimeout(r, 3000)); // still mining — keep waiting
        continue;
      }
      // 409 (another verify in-flight) — also just wait it out.
      if (res.status === 409) {
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }
      // Hard failure (reverted / no transfer / bad request).
      setErr(data.error || "Could not verify the payment.");
      setPhase("error");
      return;
    }
    // Ran out of retries — the tx exists but hasn't settled/verified yet.
    setErr("Payment is taking longer than expected to settle. It'll credit once it confirms — use “Check again”.");
    setPhase("error");
  }

  async function buy(pack: CreditPack) {
    if (!isConnected || !address) { setPicker(true); return; }
    setErr(""); setActive(pack.usdc); setPhase("confirming");
    try {
      // Chain guard — the transfer must land on Base mainnet (8453).
      if (chainId !== BASE_CHAIN_ID) {
        try { await switchChainAsync({ chainId: BASE_CHAIN_ID }); }
        catch { throw new Error("Switch your wallet to Base mainnet and try again."); }
      }

      const hash = await writeContractAsync({
        address: USDC_BASE,
        abi: ERC20_TRANSFER_ABI,
        functionName: "transfer",
        args: [TOPUP_TREASURY, parseUnits(String(pack.usdc), 6)],
        chainId: BASE_CHAIN_ID,
      });

      setTxHash(hash);
      setPhase("verifying");
      await verify(hash, address);
    } catch (e) {
      setErr(friendlyError((e as Error).message));
      setPhase("error");
    }
  }

  // Re-run verification against an already-sent tx (settlement was slow).
  async function checkAgain() {
    if (!txHash || !address) return;
    setErr(""); setPhase("verifying");
    await verify(txHash, address);
  }

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 p-4"
      onClick={close}
    >
      <div
        className="w-full max-w-sm rounded-2xl border border-[#1A1A2E] bg-[#0D0D1A] shadow-2xl shadow-black/80 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 pt-5 pb-3 border-b border-[#1A1A2E]">
          <div className="flex items-center justify-between">
            <p className="font-mono text-[13px] font-bold text-white">Top up credits</p>
            <button
              onClick={close}
              disabled={busy}
              aria-label="Close"
              className="w-6 h-6 rounded-md font-mono text-[12px] text-slate-600 hover:text-slate-300 hover:bg-[#1A1A2E] transition-colors disabled:opacity-40"
            >
              ✕
            </button>
          </div>
          <p className="font-mono text-[10px] text-slate-600 mt-1 leading-relaxed">
            Pay with USDC on Base · non-custodial. 1 USDC = {CREDITS_PER_USDC.toLocaleString()} credits.
          </p>
        </div>

        {/* ── Success ─────────────────────────────────────────────── */}
        {phase === "done" ? (
          <div className="px-5 py-8 text-center">
            <div className="text-2xl mb-2">✓</div>
            <p className="font-mono text-[13px] text-[#34D399] font-bold">
              {credited.toLocaleString()} credits added
            </p>
            {txHash && (
              <a
                href={`https://basescan.org/tx/${txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="block font-mono text-[10px] text-slate-600 hover:text-slate-400 mt-2"
              >
                view transaction ↗
              </a>
            )}
            <button
              onClick={close}
              className="mt-5 w-full font-mono text-[12px] font-bold py-2.5 rounded-xl hover:opacity-90 transition-opacity"
              style={{ background: "#34D399", color: "#050508" }}
            >
              Done
            </button>
          </div>
        ) : (
          <>
            {/* ── Pack grid ─────────────────────────────────────────── */}
            <div className="p-4 grid grid-cols-2 gap-2.5">
              {CREDIT_PACKS.map((pack) => {
                const inFlight = busy && active === pack.usdc;
                return (
                  <button
                    key={pack.usdc}
                    onClick={() => buy(pack)}
                    disabled={busy}
                    className="relative text-left rounded-xl border border-[#1A1A2E] bg-[#0A0A12] p-3 hover:border-[#4FC3F7]/50 transition-colors disabled:opacity-50 disabled:hover:border-[#1A1A2E]"
                  >
                    {pack.popular && (
                      <span
                        className="absolute -top-2 right-2 font-mono text-[8px] font-bold px-1.5 py-0.5 rounded"
                        style={{ background: "#4FC3F7", color: "#050508" }}
                      >
                        POPULAR
                      </span>
                    )}
                    <div className="font-mono text-[10px] text-slate-500">{pack.label}</div>
                    <div className="font-mono text-lg font-bold text-white mt-0.5">${pack.usdc}</div>
                    <div className="font-mono text-[10px] text-[#4FC3F7] mt-0.5">
                      {inFlight ? "confirm in wallet…" : `${pack.credits.toLocaleString()} cr`}
                    </div>
                  </button>
                );
              })}
            </div>

            {/* ── Status line ───────────────────────────────────────── */}
            <div className="px-5 pb-4">
              {phase === "verifying" && (
                <p className="font-mono text-[10px] text-amber-400 leading-relaxed">
                  Verifying payment on Base…
                  {txHash && (
                    <a href={`https://basescan.org/tx/${txHash}`} target="_blank" rel="noopener noreferrer" className="text-slate-500 hover:text-slate-300"> tx ↗</a>
                  )}
                </p>
              )}
              {phase === "error" && (
                <div className="space-y-2">
                  <p className="font-mono text-[10px] text-red-400 leading-relaxed">{err}</p>
                  {txHash && (
                    <button
                      onClick={checkAgain}
                      className="w-full font-mono text-[11px] font-semibold py-2 rounded-lg border border-[#1A1A2E] text-slate-300 hover:border-slate-600 transition-colors"
                    >
                      Check again
                    </button>
                  )}
                </div>
              )}
              {(phase === "idle" || phase === "confirming") && (
                <p className="font-mono text-[9px] text-slate-700 leading-relaxed">
                  You sign the transfer from your own wallet. Credits are added once the
                  transaction settles on Base — usually a few seconds.
                </p>
              )}
            </div>
          </>
        )}

        {/* Shared wallet picker — same list/UX as every other connect surface. */}
        <WalletPickerModal open={picker} onClose={() => setPicker(false)} />
      </div>
    </div>
  );
}
