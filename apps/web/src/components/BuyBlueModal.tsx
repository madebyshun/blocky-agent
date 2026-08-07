"use client";

/**
 * BuyBlueModal — In-app $BLUEAGENT swap on Base
 *
 * Flow: select tier → LiFi quote → approve USDC → swap via wagmi
 * Router: LiFi Diamond (0x1231...4EaE) — free, no API key, CORS *
 */

import { useState, useEffect, useCallback } from "react";
import {
  useAccount,
  useReadContract,
  useWriteContract,
  useSendTransaction,
  useWaitForTransactionReceipt,
} from "wagmi";
import { parseUnits, formatUnits } from "viem";

// ── Addresses (Base) ───────────────────────────────────────────────────────────

const USDC_ADDRESS  = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as `0x${string}`;
const BLUE_ADDRESS  = "0xf895783b2931c919955e18b5e3343e7c7c456ba3";
const LIFI_ROUTER   = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE" as `0x${string}`;

const ERC20_ABI = [
  { inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }],
    name: "allowance", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
    name: "approve", outputs: [{ name: "", type: "bool" }], stateMutability: "nonpayable", type: "function" },
] as const;

// ── Tiers ──────────────────────────────────────────────────────────────────────

const TIERS = [
  { name: "Starter", blue: 500_000,    cr: 500,  color: "#4FC3F7" },
  { name: "Pro",     blue: 2_000_000,  cr: 2_000, color: "#A78BFA" },
  { name: "Max",     blue: 10_000_000, cr: 10_000, color: "#F59E0B" },
] as const;

type TierName = typeof TIERS[number]["name"];

function fmtBlue(n: number) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(0) + "M";
  return (n / 1_000).toFixed(0) + "K";
}

// ── LiFi quote ─────────────────────────────────────────────────────────────────

interface LifiQuote {
  usdcAmount:  bigint;   // USDC to spend (6 decimals)
  blueAmount:  bigint;   // BLUE to receive (18 decimals)
  to:          `0x${string}`;
  data:        `0x${string}`;
  value:       bigint;
  gasLimit:    bigint;
}

async function fetchLifiQuote(blueTargetTokens: number, fromAddress: string): Promise<LifiQuote> {
  // Estimate USDC needed: target BLUE / (BLUE per USDC from LiFi)
  // Use 0.5 USDC as probe to get exchange rate
  const probeRes = await fetch(
    `https://li.quest/v1/quote?fromChain=8453&toChain=8453` +
    `&fromToken=${USDC_ADDRESS}&toToken=${BLUE_ADDRESS}` +
    `&fromAmount=500000&fromAddress=${fromAddress || "0x0000000000000000000000000000000000000001"}`,
    { signal: AbortSignal.timeout(8_000) }
  );
  const probe = await probeRes.json() as { estimate?: { toAmount: string; fromAmount: string } };
  if (!probe.estimate) throw new Error("No route found");

  // Rate: human BLUE per human USDC
  // toAmount (18 decimals) / fromAmount (6 decimals) / 1e12 = BLUE/USDC
  const bluePerUsdc = Number(probe.estimate.toAmount) / Number(probe.estimate.fromAmount) / 1e12;

  // USDC micros needed = target BLUE / (BLUE per USDC) * 1e6
  const usdcMicro = Math.ceil((blueTargetTokens / bluePerUsdc) * 1_000_000 * 1.01); // +1% slippage buffer

  // Actual quote with real amount
  const quoteRes = await fetch(
    `https://li.quest/v1/quote?fromChain=8453&toChain=8453` +
    `&fromToken=${USDC_ADDRESS}&toToken=${BLUE_ADDRESS}` +
    `&fromAmount=${usdcMicro}&fromAddress=${fromAddress || "0x0000000000000000000000000000000000000001"}`,
    { signal: AbortSignal.timeout(8_000) }
  );
  const quote = await quoteRes.json() as {
    estimate?: { fromAmount: string; toAmount: string; approvalAddress: string };
    transactionRequest?: { to: string; data: string; value: string; gasLimit: string };
  };

  if (!quote.estimate || !quote.transactionRequest) throw new Error("No route");

  return {
    usdcAmount: BigInt(quote.estimate.fromAmount),
    blueAmount: BigInt(quote.estimate.toAmount),
    to:         quote.transactionRequest.to as `0x${string}`,
    data:       quote.transactionRequest.data as `0x${string}`,
    value:      BigInt(quote.transactionRequest.value ?? "0"),
    gasLimit:   BigInt(quote.transactionRequest.gasLimit ?? "500000"),
  };
}

// ── Modal ──────────────────────────────────────────────────────────────────────

type Step = "idle" | "quoting" | "ready" | "approving" | "swapping" | "success" | "error";

interface Props {
  onClose: () => void;
  onSuccess?: () => void;
}

export default function BuyBlueModal({ onClose, onSuccess }: Props) {
  const { address, isConnected } = useAccount();

  const [selectedTier, setSelectedTier] = useState<TierName>("Starter");
  const [step,         setStep]         = useState<Step>("idle");
  const [quote,        setQuote]        = useState<LifiQuote | null>(null);
  const [errMsg,       setErrMsg]       = useState("");
  const [approvalHash, setApprovalHash] = useState<`0x${string}` | undefined>();
  const [swapHash,     setSwapHash]     = useState<`0x${string}` | undefined>();

  const tier = TIERS.find(t => t.name === selectedTier)!;

  // ── Read allowance ───────────────────────────────────────────────────────────
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [address ?? "0x0000000000000000000000000000000000000000", LIFI_ROUTER],
    query: { enabled: !!address },
  });

  // ── Write: approve ───────────────────────────────────────────────────────────
  const { writeContract: writeApprove, isPending: approvePending } = useWriteContract({
    mutation: {
      onSuccess: (hash) => { setApprovalHash(hash); setStep("approving"); },
      onError: (e) => { setErrMsg(e.message.slice(0, 120)); setStep("error"); },
    },
  });

  // ── Wait for approval ─────────────────────────────────────────────────────────
  const { isSuccess: approvalConfirmed } = useWaitForTransactionReceipt({
    hash: approvalHash,
    query: { enabled: !!approvalHash },
  });

  // ── Write: swap ───────────────────────────────────────────────────────────────
  const { sendTransaction, isPending: swapPending } = useSendTransaction({
    mutation: {
      onSuccess: (hash) => { setSwapHash(hash); setStep("swapping"); },
      onError: (e) => { setErrMsg(e.message.slice(0, 120)); setStep("error"); },
    },
  });

  // ── Wait for swap ─────────────────────────────────────────────────────────────
  const { isSuccess: swapConfirmed } = useWaitForTransactionReceipt({
    hash: swapHash,
    query: { enabled: !!swapHash },
  });

  // After approval confirmed → execute swap
  useEffect(() => {
    if (approvalConfirmed && quote && step === "approving") {
      refetchAllowance();
      doSwap(quote);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approvalConfirmed]);

  // After swap confirmed
  useEffect(() => {
    if (swapConfirmed) {
      setStep("success");
      onSuccess?.();
    }
  }, [swapConfirmed, onSuccess]);

  // Auto-quote when tier changes
  useEffect(() => {
    if (!isConnected) return;
    getQuote();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTier, isConnected]);

  // ── Helpers ───────────────────────────────────────────────────────────────────

  const getQuote = useCallback(async () => {
    setStep("quoting");
    setErrMsg("");
    try {
      const q = await fetchLifiQuote(tier.blue, address ?? "");
      setQuote(q);
      setStep("ready");
    } catch (e) {
      setErrMsg((e as Error).message);
      setStep("error");
    }
  }, [tier.blue, address]);

  function doSwap(q: LifiQuote) {
    setStep("swapping");
    sendTransaction({ to: q.to, data: q.data, value: q.value, gas: q.gasLimit });
  }

  async function handleBuy() {
    if (!quote || !address) return;
    const needsApproval = !allowance || allowance < quote.usdcAmount;
    if (needsApproval) {
      writeApprove({
        address: USDC_ADDRESS,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [LIFI_ROUTER, quote.usdcAmount],
      });
      setStep("approving");
    } else {
      doSwap(quote);
    }
  }

  // ── UI ────────────────────────────────────────────────────────────────────────

  const usdcHuman   = quote ? Number(formatUnits(quote.usdcAmount, 6)).toFixed(3) : null;
  const blueHuman   = quote ? Number(formatUnits(quote.blueAmount, 18)).toLocaleString(undefined, { maximumFractionDigits: 0 }) : null;
  const needsApproval = !allowance || !quote || allowance < quote.usdcAmount;

  const isBusy = step === "quoting" || step === "approving" || step === "swapping" || approvePending || swapPending;

  function btnLabel() {
    if (step === "quoting")   return "Getting quote…";
    if (!isConnected)         return "Connect wallet first";
    if (step === "approving" || approvePending) return "Approving USDC…";
    if (step === "swapping"  || swapPending)    return "Swapping…";
    if (step === "success")   return "✓ Swap complete!";
    if (step === "error")     return "Retry";
    if (step === "ready" && needsApproval) return `Approve ${usdcHuman} USDC`;
    if (step === "ready") return `Buy ${fmtBlue(tier.blue)} BLUE`;
    return "Select tier";
  }

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/80 backdrop-blur-sm px-4"
      onClick={(e) => { if (e.target === e.currentTarget && !isBusy) onClose(); }}
    >
      <div className="bg-[#0D0D14] border border-[#2A2A4E] rounded-2xl w-full max-w-sm shadow-2xl">

        {/* ── Header ─────────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-[#1A1A2E]">
          <div>
            <p className="font-mono text-[10px] text-[#F59E0B] tracking-widest mb-0.5">$BLUEAGENT · BASE</p>
            <h2 className="font-mono text-base font-bold text-white">Buy $BLUEAGENT</h2>
            <p className="font-mono text-[10px] text-slate-600 mt-0.5">
              {isConnected ? "USDC → BLUE via Li.Fi" : "Connect wallet to swap"}
            </p>
          </div>
          <button
            onClick={() => { if (!isBusy) onClose(); }}
            className="w-7 h-7 flex items-center justify-center rounded-lg text-slate-500 hover:text-white hover:bg-[#1A1A2E] transition-all text-xl leading-none"
          >
            ×
          </button>
        </div>

        {/* ── Tier cards ─────────────────────────────────────────────────── */}
        {step !== "success" && (
          <div className="px-4 pt-4 pb-3">
            <p className="font-mono text-[9px] text-slate-600 tracking-widest mb-2.5">SELECT TIER</p>
            <div className="flex flex-col gap-2">
              {TIERS.map((t) => {
                const isActive = selectedTier === t.name;
                return (
                  <button
                    key={t.name}
                    onClick={() => { setSelectedTier(t.name); setQuote(null); }}
                    disabled={isBusy}
                    className="flex items-center justify-between px-4 py-3 rounded-xl border transition-all text-left disabled:opacity-60"
                    style={isActive
                      ? { borderColor: `${t.color}50`, background: `${t.color}08` }
                      : { borderColor: "#1A1A2E", background: "transparent" }}
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-2 h-2 rounded-full flex-shrink-0"
                        style={{ background: isActive ? t.color : "#374151" }} />
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-sm font-bold"
                            style={{ color: isActive ? t.color : "#94a3b8" }}>
                            {t.name}
                          </span>
                          <span className="font-mono text-[10px] text-slate-600">{fmtBlue(t.blue)} BLUE</span>
                        </div>
                        <div className="font-mono text-[10px] text-slate-600">
                          $BLUEAGENT · Base
                        </div>
                      </div>
                    </div>
                    {/* Quote for this tier */}
                    <div className="text-right flex-shrink-0">
                      {isActive && step === "quoting" ? (
                        <div className="font-mono text-[10px] text-slate-500 animate-pulse">pricing…</div>
                      ) : isActive && usdcHuman ? (
                        <>
                          <div className="font-mono text-sm font-bold text-white">${usdcHuman}</div>
                          <div className="font-mono text-[9px] text-slate-600">USDC</div>
                        </>
                      ) : null}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Quote details ───────────────────────────────────────────────── */}
        {step === "ready" && quote && (
          <div className="mx-4 mb-3 px-3 py-2.5 rounded-xl bg-[#050508] border border-[#1A1A2E]">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-mono text-[10px] text-slate-600 mb-0.5">You pay</div>
                <div className="font-mono text-sm text-white font-bold">{usdcHuman} USDC</div>
              </div>
              <div className="font-mono text-slate-600">→</div>
              <div className="text-right">
                <div className="font-mono text-[10px] text-slate-600 mb-0.5">You receive</div>
                <div className="font-mono text-sm font-bold" style={{ color: tier.color }}>{blueHuman} BLUE</div>
              </div>
            </div>
            {needsApproval && (
              <div className="font-mono text-[9px] text-slate-600 mt-1.5 pt-1.5 border-t border-[#1A1A2E]">
                Step 1: Approve USDC · Step 2: Swap — 2 transactions
              </div>
            )}
          </div>
        )}

        {/* ── Success ─────────────────────────────────────────────────────── */}
        {step === "success" && (
          <div className="px-5 py-8 text-center">
            <div className="text-4xl mb-3">🎉</div>
            <div className="font-mono text-lg font-bold text-white mb-1">Swap complete!</div>
            <div className="font-mono text-sm text-slate-400 mb-2">{blueHuman} BLUE received</div>
            <div className="font-mono text-[10px] text-slate-600 mb-4">$BLUEAGENT is now in your wallet · chat credits are separate</div>
            {swapHash && (
              <a
                href={`https://basescan.org/tx/${swapHash}`}
                target="_blank" rel="noopener noreferrer"
                className="font-mono text-[10px] text-[#4FC3F7] hover:underline"
              >
                View on Basescan →
              </a>
            )}
          </div>
        )}

        {/* ── Error ──────────────────────────────────────────────────────── */}
        {step === "error" && errMsg && (
          <div className="mx-4 mb-3 px-3 py-2 rounded-xl bg-[#EF444410] border border-[#EF444430]">
            <div className="font-mono text-[10px] text-red-400">{errMsg}</div>
          </div>
        )}

        {/* ── CTA ─────────────────────────────────────────────────────────── */}
        <div className="px-4 pb-5">
          {step === "success" ? (
            <button
              onClick={onClose}
              className="w-full py-3 rounded-xl font-mono text-sm font-bold bg-[#1A1A2E] text-slate-300 hover:text-white transition-all"
            >
              Close
            </button>
          ) : (
            <button
              onClick={step === "error" ? getQuote : handleBuy}
              disabled={isBusy || !isConnected || (step !== "ready" && step !== "error")}
              className="w-full py-3 rounded-xl font-mono text-sm font-bold transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              style={{ background: "#F59E0B", color: "#050508" }}
            >
              {isBusy && (
                <span className="w-3.5 h-3.5 border-2 border-[#050508] border-t-transparent rounded-full animate-spin" />
              )}
              {btnLabel()}
            </button>
          )}
          {!isConnected && (
            <p className="font-mono text-[9px] text-slate-700 text-center mt-2">
              Connect your wallet in the sidebar first
            </p>
          )}
          {isConnected && step === "ready" && (
            <p className="font-mono text-[9px] text-slate-700 text-center mt-2">
              Via LiFi · Base · {needsApproval ? "2 txs (approve + swap)" : "1 tx"}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
