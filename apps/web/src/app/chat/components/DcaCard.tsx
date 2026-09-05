"use client";
// Chat card for the `blue_dca` tool. Sets up a recurring buy on Base.
// Two-step flow:
//   1. POST /api/dca/create → server persists schedule + returns { keeperAddress, totalAllowance }
//   2. User signs ONE approve(keeperAddress, totalAllowance) tx on sellToken in their own wallet
//   3. Cron takes over — runs each buy via 0x AllowanceHolder every `frequency` seconds
//
// Non-custodial: the server never holds keys for the user's funds. The keeper's
// authority is limited to the ERC-20 allowance the user grants and to the
// sellToken only. To revoke, the user can send approve(keeper, 0) themselves,
// or POST /api/dca/cancel.

import { useEffect, useMemo, useState } from "react";
import {
  useAccount,
  useSwitchChain,
  useChainId,
  useWriteContract,
  useWaitForTransactionReceipt,
  useReadContract,
} from "wagmi";
import { isAddress, parseUnits, formatUnits } from "viem";
import { ConnectButton } from "@/components/ConnectModal";

const BASE_CHAIN_ID = 8453;

const ERC20_APPROVE_ABI = [
  { name: "approve", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { name: "allowance", type: "function", stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "symbol", type: "function", stateMutability: "view",
    inputs: [], outputs: [{ type: "string" }] },
  { name: "decimals", type: "function", stateMutability: "view",
    inputs: [], outputs: [{ type: "uint8" }] },
] as const;

/** Marker shape emitted by the /api/chat handler for `blue_dca`. */
export interface DcaResult {
  kind:             "blue_dca";
  chainId?:         number;
  sellToken?:       string;
  buyToken?:        string;
  sellAmountPerRun?: string;
  frequency?:       "hourly" | "6h" | "12h" | "daily" | "weekly";
  totalRuns?:       number;
  slippageBps?:     number;
  error?:           string;
}

const FREQ_LABEL: Record<NonNullable<DcaResult["frequency"]>, string> = {
  hourly: "every hour",
  "6h":   "every 6 hours",
  "12h":  "every 12 hours",
  daily:  "every day",
  weekly: "every week",
};

type Step = "review" | "creating" | "approve" | "approving" | "done" | "error";

interface CreateResponse {
  ok: true;
  scheduleId: string;
  keeperAddress: `0x${string}`;
  totalAllowance: string;
  totalAllowanceHuman: string;
  sellTokenDecimals: number;
  feeBps: number;
  expiresAt: number;
  nextRunAt: number;
}

export default function DcaCard({ data }: { data: DcaResult }) {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChainAsync } = useSwitchChain();

  const {
    writeContractAsync,
    data: approveHash,
    error: writeError,
    isPending: writePending,
    reset: resetWrite,
  } = useWriteContract();

  const { isLoading: waitingReceipt, isSuccess: approveConfirmed } =
    useWaitForTransactionReceipt({ hash: approveHash, chainId: BASE_CHAIN_ID });

  const [step, setStep]       = useState<Step>("review");
  const [errMsg, setErrMsg]   = useState<string | null>(null);
  const [created, setCreated] = useState<CreateResponse | null>(null);

  // Validate the LLM's payload — the card refuses to POST until everything is present
  const sellToken        = (data.sellToken ?? "").trim();
  const buyToken         = (data.buyToken  ?? "").trim();
  const sellAmountPerRun = (data.sellAmountPerRun ?? "").trim();
  const frequency        = data.frequency ?? "daily";
  const totalRuns        = typeof data.totalRuns === "number" && data.totalRuns > 0
    ? Math.min(365, Math.floor(data.totalRuns))
    : 30;
  const slippageBps      = typeof data.slippageBps === "number" ? data.slippageBps : 100;

  const inputError = useMemo(() => {
    if (data.error) return data.error;
    if (!sellToken || !isAddress(sellToken)) return "Missing or invalid sellToken address.";
    if (!buyToken || !isAddress(buyToken))   return "Missing or invalid buyToken address.";
    if (sellToken.toLowerCase() === buyToken.toLowerCase()) return "sellToken and buyToken must differ.";
    if (!/^\d+(\.\d+)?$/.test(sellAmountPerRun) || Number(sellAmountPerRun) <= 0) return "Missing amount per run.";
    return null;
  }, [data.error, sellToken, buyToken, sellAmountPerRun]);

  // Preview: read sell + buy token symbols from chain so the UI shows real names
  const { data: sellSymbol } = useReadContract({
    address: (isAddress(sellToken) ? (sellToken as `0x${string}`) : undefined),
    abi:     ERC20_APPROVE_ABI,
    functionName: "symbol",
    chainId:  BASE_CHAIN_ID,
    query: { enabled: isAddress(sellToken) },
  });
  const { data: buySymbol } = useReadContract({
    address: (isAddress(buyToken) ? (buyToken as `0x${string}`) : undefined),
    abi:     ERC20_APPROVE_ABI,
    functionName: "symbol",
    chainId:  BASE_CHAIN_ID,
    query: { enabled: isAddress(buyToken) },
  });

  async function handleCreate() {
    if (!address) return;
    setErrMsg(null);
    setStep("creating");
    try {
      const res = await fetch("/api/dca/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userAddress: address,
          chainId: 8453,
          sellToken,
          buyToken,
          sellAmountPerRun,
          frequency,
          totalRuns,
          slippageBps,
        }),
      });
      const json = (await res.json()) as CreateResponse | { error?: string };
      if (!res.ok || !("ok" in json) || !json.ok) {
        throw new Error(("error" in json && json.error) || `HTTP ${res.status}`);
      }
      setCreated(json);
      setStep("approve");
    } catch (e) {
      setErrMsg((e as Error).message);
      setStep("error");
    }
  }

  async function handleApprove() {
    if (!address || !created) return;
    setErrMsg(null);
    resetWrite();

    try {
      // SANITY GUARD — recompute expected allowance client-side and refuse to
      // sign if the server's number is off by an order of magnitude. This
      // caught a real bug in dev where a silent RPC failure made the server
      // return decimals=18 for USDC (6-dec), inflating a $2 request into a
      // $2-trillion spending cap. Wagmi/MetaMask can't catch that themselves.
      const expected = parseUnits(sellAmountPerRun, created.sellTokenDecimals)
        * BigInt(10_000 + (created.feeBps ?? 50))
        / 10_000n
        * BigInt(totalRuns);
      const actual = BigInt(created.totalAllowance);
      if (actual > expected * 10n || actual < expected / 10n) {
        throw new Error(
          `Refusing to sign: server allowance (${actual}) differs from client-computed (${expected}) by >10×. ` +
          `Likely a token-decimals mismatch — do NOT approve.`,
        );
      }

      if (chainId !== BASE_CHAIN_ID) {
        await switchChainAsync({ chainId: BASE_CHAIN_ID });
      }
      setStep("approving");
      await writeContractAsync({
        address: sellToken as `0x${string}`,
        abi: ERC20_APPROVE_ABI,
        functionName: "approve",
        args: [created.keeperAddress, actual],
        chainId: BASE_CHAIN_ID,
      });
      // approveHash + receipt-wait handled by the wagmi hooks; useEffect below flips step
    } catch (e) {
      setErrMsg((e as Error).message);
      setStep("error");
    }
  }

  // Once the approve tx is confirmed, mark done
  useEffect(() => {
    if (step === "approving" && approveConfirmed) setStep("done");
  }, [step, approveConfirmed]);

  // Bubble wagmi write error up
  useEffect(() => {
    if (writeError && step === "approving") {
      const msg = writeError.message.includes("rejected") || writeError.message.includes("User denied")
        ? "Signature rejected in wallet."
        : writeError.message;
      setErrMsg(msg);
      setStep("error");
    }
  }, [writeError, step]);

  const sellSymbolStr = (sellSymbol as string | undefined) ?? "TOKEN";
  const buySymbolStr  = (buySymbol  as string | undefined) ?? "TOKEN";

  // For display — parseUnits with a guess of 18 decimals until create response gives us the real one
  const perRunDisplay = created
    ? formatUnits(parseUnits(sellAmountPerRun, created.sellTokenDecimals), created.sellTokenDecimals)
    : sellAmountPerRun;

  return (
    <div className="rounded-2xl bg-[#0a0a0f] border border-[#1A1A2E] p-5 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-[#4FC3F7] shadow-[0_0_6px_#4FC3F7]" />
            <span className="font-mono text-xs text-[#4FC3F7]">DCA · Base</span>
          </div>
          <h3 className="font-semibold text-white mt-1 text-lg">Recurring buy</h3>
        </div>
        <span className="font-mono text-[10px] text-slate-500 uppercase tracking-wider">
          {step === "done" ? "active" : step === "approve" || step === "approving" ? "approve" : "review"}
        </span>
      </div>

      {/* Summary */}
      <div className="bg-[#050508] border border-[#1A1A2E] rounded-xl p-4 space-y-2">
        <div className="flex justify-between text-xs">
          <span className="font-mono text-slate-500">Buy</span>
          <span className="font-mono text-slate-200">{buySymbolStr} <span className="text-slate-500">({shortAddr(buyToken)})</span></span>
        </div>
        <div className="flex justify-between text-xs">
          <span className="font-mono text-slate-500">Spend per run</span>
          <span className="font-mono text-slate-200">{perRunDisplay} {sellSymbolStr}</span>
        </div>
        <div className="flex justify-between text-xs">
          <span className="font-mono text-slate-500">Frequency</span>
          <span className="font-mono text-slate-200">{FREQ_LABEL[frequency]}</span>
        </div>
        <div className="flex justify-between text-xs">
          <span className="font-mono text-slate-500">Runs planned</span>
          <span className="font-mono text-slate-200">{totalRuns}</span>
        </div>
        <div className="flex justify-between text-xs">
          <span className="font-mono text-slate-500">Slippage</span>
          <span className="font-mono text-slate-200">{(slippageBps / 100).toFixed(2)}%</span>
        </div>
      </div>

      {/* Total approve summary (after create) */}
      {created && (
        <div className="bg-[#050508] border border-[#4FC3F7]/20 rounded-xl p-4 space-y-2">
          <div className="flex justify-between text-xs">
            <span className="font-mono text-slate-500">Total allowance to approve</span>
            <span className="font-mono text-[#4FC3F7]">{created.totalAllowanceHuman} {sellSymbolStr}</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="font-mono text-slate-500">Keeper wallet (spender)</span>
            <span className="font-mono text-slate-300">{shortAddr(created.keeperAddress)}</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="font-mono text-slate-500">Fee (keeper gas reimb.)</span>
            <span className="font-mono text-slate-300">{(created.feeBps / 100).toFixed(2)}%</span>
          </div>
          <div className="flex justify-between text-[10px] text-slate-500 pt-1 border-t border-[#1A1A2E]">
            <span className="font-mono">Schedule ID</span>
            <span className="font-mono">{created.scheduleId.slice(0, 8)}</span>
          </div>
        </div>
      )}

      {/* CTA */}
      {inputError ? (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3">
          <p className="font-mono text-xs text-red-400">{inputError}</p>
        </div>
      ) : !isConnected ? (
        <div className="pt-2 flex justify-center">
          <ConnectButton />
        </div>
      ) : step === "review" ? (
        <button
          onClick={handleCreate}
          className="w-full bg-[#4FC3F7] hover:bg-[#29ABE2] text-[#050508] font-mono font-semibold text-sm py-3 rounded-xl transition-colors"
        >
          Create schedule
        </button>
      ) : step === "creating" ? (
        <button disabled className="w-full bg-[#4FC3F7]/40 text-[#050508] font-mono font-semibold text-sm py-3 rounded-xl flex items-center justify-center gap-2">
          <Spinner /> Creating…
        </button>
      ) : step === "approve" ? (
        <button
          onClick={handleApprove}
          className="w-full bg-[#4FC3F7] hover:bg-[#29ABE2] text-[#050508] font-mono font-semibold text-sm py-3 rounded-xl transition-colors"
        >
          Sign approve — {created?.totalAllowanceHuman} {sellSymbolStr}
        </button>
      ) : step === "approving" ? (
        <button disabled className="w-full bg-[#4FC3F7]/40 text-[#050508] font-mono font-semibold text-sm py-3 rounded-xl flex items-center justify-center gap-2">
          <Spinner /> {writePending ? "Waiting for wallet…" : waitingReceipt ? "Confirming on Base…" : "Submitting…"}
        </button>
      ) : step === "done" ? (
        <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-xl px-4 py-3">
          <div className="flex items-center gap-2 mb-1">
            <div className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_6px_#34d399]" />
            <span className="font-mono text-xs text-emerald-400">Schedule active</span>
          </div>
          <p className="font-mono text-[11px] text-slate-400 leading-relaxed">
            First run in ~{created ? Math.max(1, Math.ceil((created.nextRunAt - Math.floor(Date.now() / 1000)) / 60)) : "?"}min. To cancel: <code className="text-slate-300">POST /api/dca/cancel</code> with your schedule ID.
          </p>
        </div>
      ) : null}

      {step === "error" && errMsg && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3">
          <p className="font-mono text-xs text-red-400 leading-relaxed">{errMsg}</p>
          <button
            onClick={() => { setStep(created ? "approve" : "review"); setErrMsg(null); }}
            className="mt-2 font-mono text-[10px] text-slate-400 underline hover:text-slate-200"
          >
            Retry
          </button>
        </div>
      )}
    </div>
  );
}

function shortAddr(a?: string): string {
  if (!a || a.length < 10) return a ?? "";
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function Spinner() {
  return (
    <svg className="w-4 h-4 animate-spin shrink-0" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}
