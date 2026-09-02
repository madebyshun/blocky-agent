"use client";

/**
 * StakeView — extracted from the former /app/rewards page so it can render
 * inside /app/dashboard as a tab. Identical hooks + identical UX; only the
 * outer <AppPageHeader> + page-level <div> wrapper are dropped because the
 * dashboard shell already provides them.
 */

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { ConnectButton } from "@/components/ConnectModal";
import AppCard from "@/components/app/AppCard";
import {
  useAccount,
  useReadContract,
  useWriteContract,
  useWaitForTransactionReceipt,
} from "wagmi";
import { parseUnits, formatUnits } from "viem";

// ── Addresses ─────────────────────────────────────────────────────────────────

const STAKING_ADDRESS = (
  process.env.NEXT_PUBLIC_STAKING_CONTRACT ??
  "0x69e539684EE48F71eCDAd58618d8e8a2423E279d"
) as `0x${string}`;

const BLUE_ADDRESS = "0xf895783b2931c919955e18b5e3343e7c7c456ba3" as const;

// ── ABIs ──────────────────────────────────────────────────────────────────────

const ERC20_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view",
    inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "allowance", type: "function", stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }],
    outputs: [{ type: "uint256" }] },
  { name: "approve", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ type: "bool" }] },
] as const;

const STAKING_ABI = [
  { name: "stakeInfo", type: "function", stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [
      { name: "amount",       type: "uint256" },
      { name: "stakedAt",     type: "uint256" },
      { name: "dailyCredits", type: "uint256" },
      { name: "cooldown",     type: "uint256" },
      { name: "pendingUsdc",  type: "uint256" },
    ] },
  { name: "totalCreditsAccrued", type: "function", stateMutability: "view",
    inputs: [{ name: "user", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "totalStaked", type: "function", stateMutability: "view",
    inputs: [], outputs: [{ type: "uint256" }] },
  { name: "totalYieldDistributed", type: "function", stateMutability: "view",
    inputs: [], outputs: [{ type: "uint256" }] },
  { name: "stakes", type: "function", stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [
      { name: "amount",             type: "uint256" },
      { name: "stakedAt",           type: "uint256" },
      { name: "lastAccruedAt",      type: "uint256" },
      { name: "accruedCredits",     type: "uint256" },
      { name: "unstakeRequestedAt", type: "uint256" },
      { name: "yieldDebt",          type: "uint256" },
    ] },
  { name: "stake",          type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }], outputs: [] },
  { name: "requestUnstake", type: "function", stateMutability: "nonpayable",
    inputs: [], outputs: [] },
  { name: "cancelUnstake",  type: "function", stateMutability: "nonpayable",
    inputs: [], outputs: [] },
  { name: "unstake",        type: "function", stateMutability: "nonpayable",
    inputs: [], outputs: [] },
  { name: "claimYield",     type: "function", stateMutability: "nonpayable",
    inputs: [], outputs: [] },
] as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtBlue(wei: bigint): string {
  const n = Number(formatUnits(wei, 18));
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + "K";
  return n.toFixed(0);
}

function fmtCooldown(secs: bigint): string {
  const s = Number(secs);
  if (s <= 0) return "Ready to unstake";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m remaining` : `${m}m remaining`;
}

// ── Tiers ─────────────────────────────────────────────────────────────────────

const TIERS = [
  { name: "None",    min: 0,          max: 500_000,    credits: 0,    color: "#475569" },
  { name: "Starter", min: 500_000,    max: 2_000_000,  credits: 500,  color: "#4FC3F7" },
  { name: "Pro",     min: 2_000_000,  max: 10_000_000, credits: 2000, color: "#A78BFA" },
  { name: "Max",     min: 10_000_000, max: Infinity,   credits: 10000, color: "#F59E0B" },
];

function getTier(blue: number) {
  if (blue >= 10_000_000) return TIERS[3];
  if (blue >= 2_000_000)  return TIERS[2];
  if (blue >= 500_000)    return TIERS[1];
  return TIERS[0];
}

function getNextTier(blue: number) {
  if (blue < 500_000)    return { tier: TIERS[1], need: 500_000 - blue };
  if (blue < 2_000_000)  return { tier: TIERS[2], need: 2_000_000 - blue };
  if (blue < 10_000_000) return { tier: TIERS[3], need: 10_000_000 - blue };
  return null;
}

function tierProgress(blue: number): number {
  if (blue >= 10_000_000) return 100;
  if (blue >= 2_000_000)  return ((blue - 2_000_000) / (10_000_000 - 2_000_000)) * 100;
  if (blue >= 500_000)    return ((blue - 500_000) / (2_000_000 - 500_000)) * 100;
  return (blue / 500_000) * 100;
}

// ── Action tab ────────────────────────────────────────────────────────────────

type ActionTab = "stake" | "unstake" | "claim";

// ── View ──────────────────────────────────────────────────────────────────────

export default function StakeView() {
  const { address, isConnected } = useAccount();
  const [tab, setTab]             = useState<ActionTab>("stake");
  const [input, setInput]         = useState("");
  const [txStatus, setTxStatus]   = useState<string | null>(null);
  const [lastAction, setLastAction] = useState<"approve" | "stake" | "other" | null>(null);

  const { data: blueBalance, refetch: refetchBal } = useReadContract({
    address: BLUE_ADDRESS, abi: ERC20_ABI, functionName: "balanceOf",
    args: address ? [address] : undefined, query: { enabled: !!address },
  });

  const { data: allowance, refetch: refetchAllow } = useReadContract({
    address: BLUE_ADDRESS, abi: ERC20_ABI, functionName: "allowance",
    args: address ? [address, STAKING_ADDRESS] : undefined, query: { enabled: !!address },
  });

  const { data: stakeInfo, refetch: refetchInfo } = useReadContract({
    address: STAKING_ADDRESS, abi: STAKING_ABI, functionName: "stakeInfo",
    args: address ? [address] : undefined, query: { enabled: !!address },
  });

  const { data: totalCredits, refetch: refetchCr } = useReadContract({
    address: STAKING_ADDRESS, abi: STAKING_ABI, functionName: "totalCreditsAccrued",
    args: address ? [address] : undefined, query: { enabled: !!address },
  });

  const { data: stakeRaw, refetch: refetchRaw } = useReadContract({
    address: STAKING_ADDRESS, abi: STAKING_ABI, functionName: "stakes",
    args: address ? [address] : undefined, query: { enabled: !!address },
  });

  const { data: globalStaked } = useReadContract({
    address: STAKING_ADDRESS, abi: STAKING_ABI, functionName: "totalStaked",
  });

  // Read the payout total instead of asserting one. A hardcoded "Live" here
  // survived ~156M BLUE being staked against a mechanism that has never paid
  // out; anything hardcoded rots the same way the moment reality diverges.
  const { data: yieldPaid } = useReadContract({
    address: STAKING_ADDRESS, abi: STAKING_ABI, functionName: "totalYieldDistributed",
  });

  const { writeContract, data: txHash, isPending: isWriting } = useWriteContract();
  const { isLoading: isConfirming, isSuccess: txSuccess } =
    useWaitForTransactionReceipt({ hash: txHash });

  const refetchAll = useCallback(() => {
    refetchBal(); refetchAllow(); refetchInfo(); refetchCr(); refetchRaw();
  }, [refetchBal, refetchAllow, refetchInfo, refetchCr, refetchRaw]);

  const stakedWei   = stakeInfo?.[0] ?? 0n;
  const dailyCr     = stakeInfo?.[2] ?? 0n;
  const cooldown    = stakeInfo?.[3] ?? 0n;
  const pendingUSDC = stakeInfo?.[4] ?? 0n;
  const unstakeReq  = stakeRaw?.[4] ?? 0n;
  const hasCooldown = unstakeReq > 0n;
  const canUnstake  = hasCooldown && cooldown === 0n;

  const staked     = Number(formatUnits(stakedWei, 18));
  const walletBal  = blueBalance ? Number(formatUnits(blueBalance, 18)) : 0;
  const tier       = getTier(staked);
  const nextTier   = getNextTier(staked);
  const progress   = tierProgress(staked);

  const amtWei = input
    ? (() => { try { return parseUnits(input, 18); } catch (_e) { return 0n; } })()
    : 0n;
  const needsApproval = amtWei > 0n && amtWei > (allowance ?? 0n);

  useEffect(() => {
    if (!txSuccess) return;
    refetchAll();
    if (lastAction === "approve") {
      setTxStatus("✅ Approved! Staking now...");
      setTimeout(() => {
        writeContract({ address: STAKING_ADDRESS, abi: STAKING_ABI,
          functionName: "stake", args: [amtWei] });
        setLastAction("stake");
        setTxStatus("Staking BLUE...");
      }, 600);
    } else {
      setTxStatus("✅ Done!");
      if (lastAction === "stake") setInput("");
      setLastAction(null);
      setTimeout(() => setTxStatus(null), 4000);
    }
  }, [txSuccess]); // eslint-disable-line react-hooks/exhaustive-deps

  const isBusy = isWriting || isConfirming;

  function doApprove() {
    setLastAction("approve"); setTxStatus("Approving BLUE...");
    writeContract({ address: BLUE_ADDRESS, abi: ERC20_ABI,
      functionName: "approve", args: [STAKING_ADDRESS, amtWei] });
  }
  function doStake() {
    setLastAction("stake"); setTxStatus("Staking BLUE...");
    writeContract({ address: STAKING_ADDRESS, abi: STAKING_ABI,
      functionName: "stake", args: [amtWei] });
  }
  function doRequestUnstake() {
    setLastAction("other"); setTxStatus("Requesting unstake...");
    writeContract({ address: STAKING_ADDRESS, abi: STAKING_ABI, functionName: "requestUnstake" });
  }
  function doCancelUnstake() {
    setLastAction("other"); setTxStatus("Cancelling...");
    writeContract({ address: STAKING_ADDRESS, abi: STAKING_ABI, functionName: "cancelUnstake" });
  }
  function doUnstake() {
    setLastAction("other"); setTxStatus("Unstaking...");
    writeContract({ address: STAKING_ADDRESS, abi: STAKING_ABI, functionName: "unstake" });
  }
  function doClaimYield() {
    setLastAction("other"); setTxStatus("Claiming yield...");
    writeContract({ address: STAKING_ADDRESS, abi: STAKING_ABI, functionName: "claimYield" });
  }

  return (
    <div className="relative">
      {/* Ambient glow */}
      <div className="pointer-events-none overflow-hidden absolute inset-x-0 top-0 h-[300px]">
        <div className="absolute inset-0"
          style={{ background: "radial-gradient(ellipse 80% 50% at 50% -10%, #4FC3F710 0%, transparent 70%)" }} />
      </div>
      <div className="relative max-w-3xl mx-auto px-4 sm:px-6 pt-5 pb-16">

        {/* Protocol stats — bento strip, each with its own accent gradient */}
        <div className="grid grid-cols-3 gap-2.5 mb-4">
          {[
            { label: "TOTAL STAKED", value: globalStaked ? fmtBlue(globalStaked) : "—", accent: "#4FC3F7" },
            { label: "USDC PAID",
              value: yieldPaid !== undefined ? `$${(Number(yieldPaid) / 1e6).toFixed(2)}` : "—",
              accent: Number(yieldPaid ?? 0n) > 0 ? "#22C55E" : "#64748B" },
            { label: "COOLDOWN",     value: "1 day",                                     accent: "#A78BFA" },
          ].map(s => (
            <div key={s.label} className="rounded-2xl border p-4 text-center relative overflow-hidden"
                 style={{ background: `linear-gradient(135deg, ${s.accent}12 0%, #0d0d12 60%)`,
                          borderColor: `${s.accent}25` }}>
              <span aria-hidden className="absolute inset-x-0 top-0 h-px"
                    style={{ background: `linear-gradient(90deg, transparent, ${s.accent}, transparent)` }} />
              <div className="font-mono text-xl font-bold leading-none" style={{ color: s.accent }}>{s.value}</div>
              <div className="font-mono text-[9px] text-slate-600 mt-1.5 tracking-widest">{s.label}</div>
            </div>
          ))}
        </div>

        {!isConnected ? (
          <AppCard className="max-w-[600px] mx-auto p-12 text-center">
            <div className="w-16 h-16 rounded-2xl bg-[#4FC3F710] border border-[#4FC3F720] flex items-center justify-center mx-auto mb-6">
              <span className="text-3xl">⚡</span>
            </div>
            <p className="text-slate-400 mb-8">
              Connect wallet to stake BLUE and earn credits
            </p>
            <ConnectButton label="Connect Wallet" />

            <div className="mt-10 grid grid-cols-3 gap-4">
              {TIERS.slice(1).map(t => (
                <div key={t.name} className="rounded-xl border border-[#1A1A2E] bg-[#0a0a0f] p-4 text-left">
                  <div className="font-mono text-[10px] tracking-widest mb-2" style={{ color: t.color }}>
                    {t.name.toUpperCase()}
                  </div>
                  <div className="font-mono text-base font-bold text-white">
                    {t.credits.toLocaleString()}
                    <span className="text-[11px] text-slate-600 ml-1">cr/day</span>
                  </div>
                  <div className="font-mono text-[11px] text-slate-600 mt-1.5">
                    {t.min >= 1_000_000 ? `${(t.min / 1_000_000).toFixed(0)}M` : `${(t.min / 1_000).toFixed(0)}K`} BLUE
                  </div>
                </div>
              ))}
            </div>
          </AppCard>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-[1fr_320px] gap-3 mb-4">

            {/* Position card — bento gradient bg tinted by current tier */}
            <div className="rounded-2xl border p-6 sm:p-8 relative overflow-hidden"
                 style={{
                   background: staked > 0
                     ? `linear-gradient(135deg, ${tier.color}14 0%, #0d0d12 55%)`
                     : "#0d0d12",
                   borderColor: staked > 0 ? `${tier.color}35` : "#1A1A2E",
                   boxShadow: staked > 0 ? `0 0 60px ${tier.color}0a` : undefined,
                 }}>
              <span aria-hidden className="absolute inset-x-0 top-0 h-px"
                    style={{ background: staked > 0 ? `linear-gradient(90deg, transparent, ${tier.color}, transparent)` : "transparent" }} />
              <div className="flex items-start justify-between mb-6">
                <div>
                  <div className="font-mono text-[10px] text-slate-600 tracking-widest mb-2">YOUR POSITION</div>
                  <div className="flex items-baseline gap-3 flex-wrap">
                    <span className="text-5xl sm:text-6xl font-bold tracking-tight leading-none"
                          style={{ color: staked > 0 ? tier.color : "#2a2a3e" }}>
                      {fmtBlue(stakedWei)}
                    </span>
                    <span className="font-mono text-base text-slate-600">BLUE</span>
                  </div>
                </div>
                <div className="px-3 py-1.5 rounded-xl border font-mono text-xs font-bold tracking-widest"
                  style={{ color: tier.color, background: `${tier.color}15`, borderColor: `${tier.color}40` }}>
                  {tier.name === "None" ? "NO TIER" : tier.name.toUpperCase()}
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3 mb-7">
                <div className="rounded-xl bg-[#0a0a0f] border border-[#1A1A2E] p-4">
                  <div className="font-mono text-[9px] text-slate-600 mb-2 tracking-widest">CREDITS/DAY</div>
                  <div className="font-mono text-2xl font-bold text-[#4FC3F7]">
                    {Number(dailyCr).toLocaleString()}
                  </div>
                </div>
                <div className="rounded-xl bg-[#0a0a0f] border border-[#1A1A2E] p-4">
                  <div className="font-mono text-[9px] text-slate-600 mb-2 tracking-widest">TOTAL EARNED</div>
                  <div className="font-mono text-2xl font-bold text-white">
                    {totalCredits !== undefined
                      ? Number(totalCredits) < 1
                        ? Number(totalCredits).toFixed(2)
                        : Number(totalCredits) >= 1000
                          ? (Number(totalCredits) / 1000).toFixed(1) + "K"
                          : Number(totalCredits).toFixed(0)
                      : "—"}
                  </div>
                </div>
                <div className="rounded-xl bg-[#0a0a0f] border border-[#1A1A2E] p-4">
                  <div className="font-mono text-[9px] text-slate-600 mb-2 tracking-widest">USDC YIELD</div>
                  <div className="font-mono text-2xl font-bold text-[#22C55E]">
                    ${(Number(pendingUSDC) / 1e6).toFixed(4)}
                  </div>
                </div>
              </div>

              {/* Tier progress bar */}
              <div>
                <div className="flex justify-between items-center mb-2">
                  <span className="font-mono text-[11px] text-slate-500">
                    {nextTier
                      ? <>{fmtBlue(BigInt(Math.round(nextTier.need * 1e18)))} more → <span style={{ color: nextTier.tier.color }}>{nextTier.tier.name}</span></>
                      : <span style={{ color: tier.color }}>Max tier reached 🏆</span>}
                  </span>
                  <span className="font-mono text-[11px]" style={{ color: tier.color }}>
                    {progress.toFixed(1)}%
                  </span>
                </div>
                <div className="h-1.5 bg-[#1A1A2E] rounded-full overflow-hidden">
                  <div className="h-full rounded-full transition-all duration-700"
                    style={{
                      width: `${Math.max(Math.min(progress, 100), staked > 0 ? 2 : 0)}%`,
                      background: `linear-gradient(90deg, ${tier.color}70, ${tier.color})`,
                      boxShadow: `0 0 8px ${tier.color}80`,
                    }} />
                </div>
                <div className="flex justify-between mt-1.5">
                  {["0", "500K", "2M", "10M"].map((label, i) => (
                    <span key={i} className="font-mono text-[10px] text-slate-700">{label}</span>
                  ))}
                </div>
              </div>
            </div>

            {/* Action panel — bento with cyan glass tint */}
            <div className="rounded-2xl border border-[#4FC3F7]/20 bg-[#4FC3F7]/[0.03] overflow-hidden flex flex-col">
              <div className="flex border-b border-[#1A1A2E] bg-[#0a0a0f]/50">
                {(["stake", "unstake", "claim"] as ActionTab[]).map(t => (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    className="flex-1 py-3 font-mono text-xs tracking-widest transition-all relative"
                    style={tab === t
                      ? { color: "#4FC3F7", background: "#4FC3F708" }
                      : { color: "#475569" }}
                  >
                    {t.toUpperCase()}
                    {tab === t && (
                      <span aria-hidden className="absolute inset-x-3 bottom-0 h-0.5 rounded-full"
                            style={{ background: "#4FC3F7", boxShadow: "0 0 8px #4FC3F7" }} />
                    )}
                  </button>
                ))}
              </div>

              <div className="p-5">
                {/* Stake tab */}
                {tab === "stake" && (
                  <div>
                    <div className="flex items-center justify-between mb-3">
                      <span className="font-mono text-[11px] text-slate-500">
                        Available: <span className="text-white">{walletBal >= 1000 ? fmtBlue(blueBalance ?? 0n) : walletBal.toFixed(0)} BLUE</span>
                      </span>
                      {hasCooldown && (
                        <span className="font-mono text-[10px] text-amber-500">Cancel unstake first</span>
                      )}
                    </div>

                    <div className="flex gap-2 mb-3">
                      <div className="relative flex-1">
                        <input
                          type="number"
                          placeholder="0"
                          value={input}
                          onChange={e => setInput(e.target.value)}
                          disabled={hasCooldown}
                          className="w-full h-11 px-4 pr-16 bg-[#0a0a0f] border border-[#1A1A2E] rounded-xl font-mono text-sm text-white placeholder-slate-700 outline-none focus:border-[#4FC3F740] transition-colors disabled:opacity-40"
                        />
                        {!hasCooldown && (blueBalance ?? 0n) > 0n && (
                          <button
                            onClick={() => setInput(formatUnits(blueBalance!, 18))}
                            className="absolute right-3 top-1/2 -translate-y-1/2 font-mono text-[10px] text-[#4FC3F7] hover:text-white transition-colors"
                          >
                            MAX
                          </button>
                        )}
                      </div>
                      <button
                        onClick={needsApproval ? doApprove : doStake}
                        disabled={isBusy || !input || amtWei === 0n || hasCooldown}
                        className="h-11 px-5 rounded-xl font-mono text-sm font-bold transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                        style={{
                          background: needsApproval
                            ? "linear-gradient(135deg, #F59E0B, #D97706)"
                            : "linear-gradient(135deg, #4FC3F7, #29ABE2)",
                          color: "#050508",
                          boxShadow: isBusy ? "none" : needsApproval
                            ? "0 0 16px #F59E0B30"
                            : "0 0 16px #4FC3F730",
                        }}
                      >
                        {isBusy ? "..." : needsApproval ? "Approve" : "Stake"}
                      </button>
                    </div>

                    <div className="flex gap-2">
                      {[{ l: "500K", v: "500000" }, { l: "2M", v: "2000000" }, { l: "10M", v: "10000000" }].map(p => (
                        <button
                          key={p.l}
                          onClick={() => setInput(p.v)}
                          disabled={hasCooldown}
                          className="px-3 py-1 rounded-lg font-mono text-[11px] border transition-all disabled:opacity-30"
                          style={input === p.v
                            ? { color: "#4FC3F7", background: "#4FC3F710", borderColor: "#4FC3F730" }
                            : { color: "#475569", background: "transparent", borderColor: "#1A1A2E" }}
                        >
                          {p.l}
                        </button>
                      ))}
                    </div>

                    {input && amtWei > 0n && !hasCooldown && (
                      <div className="mt-3 px-3 py-2 rounded-lg bg-[#0a0a0f] border border-[#1A1A2E]">
                        <div className="flex justify-between font-mono text-[11px]">
                          <span className="text-slate-600">Credits/day after stake</span>
                          <span className="text-[#4FC3F7]">
                            {Math.floor((staked + Number(formatUnits(amtWei, 18))) * 1e-3).toLocaleString()} cr
                          </span>
                        </div>
                        <div className="flex justify-between font-mono text-[11px] mt-1">
                          <span className="text-slate-600">New tier</span>
                          <span style={{ color: getTier(staked + Number(formatUnits(amtWei, 18))).color }}>
                            {getTier(staked + Number(formatUnits(amtWei, 18))).name}
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Unstake tab */}
                {tab === "unstake" && (
                  <div>
                    {stakedWei === 0n ? (
                      <p className="text-slate-600 font-mono text-sm text-center py-4">Nothing staked yet</p>
                    ) : !hasCooldown ? (
                      <div>
                        <div className="rounded-xl bg-[#0a0a0f] border border-[#1A1A2E] p-4 mb-4">
                          <div className="font-mono text-[10px] text-slate-600 mb-1">WILL UNSTAKE</div>
                          <div className="font-mono text-xl font-bold">{fmtBlue(stakedWei)} BLUE</div>
                        </div>
                        <button
                          onClick={doRequestUnstake}
                          disabled={isBusy}
                          className="w-full h-11 rounded-xl font-mono text-sm font-bold border border-red-500/30 text-red-400 bg-red-500/5 hover:bg-red-500/10 transition-all disabled:opacity-40"
                        >
                          {isBusy ? "..." : "Request Unstake"}
                        </button>
                        <p className="font-mono text-[10px] text-slate-700 text-center mt-2">
                          Credits stop accruing · 1-day cooldown begins
                        </p>
                      </div>
                    ) : canUnstake ? (
                      <div>
                        <div className="rounded-xl bg-[#22C55E08] border border-[#22C55E20] p-4 mb-4 text-center">
                          <div className="font-mono text-xs text-[#22C55E] mb-1">✅ Cooldown complete</div>
                          <div className="font-mono text-xl font-bold">{fmtBlue(stakedWei)} BLUE ready</div>
                        </div>
                        <div className="flex gap-2">
                          <button
                            onClick={doUnstake}
                            disabled={isBusy}
                            className="flex-1 h-11 rounded-xl font-mono text-sm font-bold bg-red-500/10 border border-red-500/30 text-red-400 hover:bg-red-500/20 transition-all disabled:opacity-40"
                          >
                            {isBusy ? "..." : "Unstake"}
                          </button>
                          <button
                            onClick={doCancelUnstake}
                            disabled={isBusy}
                            className="h-11 px-4 rounded-xl font-mono text-sm text-slate-500 border border-[#1A1A2E] hover:text-white hover:border-[#2a2a3e] transition-all disabled:opacity-40"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div>
                        <div className="rounded-xl bg-[#F59E0B08] border border-[#F59E0B20] p-4 mb-4 text-center">
                          <div className="font-mono text-xs text-[#F59E0B] mb-1">⏳ Cooldown active</div>
                          <div className="font-mono text-sm text-white">{fmtCooldown(cooldown)}</div>
                        </div>
                        <button
                          onClick={doCancelUnstake}
                          disabled={isBusy}
                          className="w-full h-11 rounded-xl font-mono text-sm text-slate-500 border border-[#1A1A2E] hover:text-white hover:border-[#2a2a3e] transition-all disabled:opacity-40"
                        >
                          {isBusy ? "..." : "Cancel Unstake"}
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {/* Claim tab */}
                {tab === "claim" && (
                  <div>
                    <div className="rounded-xl bg-[#0a0a0f] border border-[#1A1A2E] p-5 mb-4 text-center">
                      <div className="font-mono text-[10px] text-slate-600 mb-2">PENDING USDC YIELD</div>
                      <div className="font-mono text-3xl font-bold text-[#22C55E] mb-1">
                        ${(Number(pendingUSDC) / 1e6).toFixed(6)}
                      </div>
                      <div className="font-mono text-[10px] text-slate-600">real USDC, claimed onchain</div>
                    </div>

                    <button
                      onClick={doClaimYield}
                      disabled={isBusy || pendingUSDC === 0n}
                      className="w-full h-11 rounded-xl font-mono text-sm font-bold transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                      style={{
                        background: pendingUSDC > 0n
                          ? "linear-gradient(135deg, #22C55E, #16A34A)"
                          : "#1A1A2E",
                        color: pendingUSDC > 0n ? "#050508" : "#475569",
                        boxShadow: pendingUSDC > 0n && !isBusy ? "0 0 20px #22C55E25" : "none",
                      }}
                    >
                      {isBusy ? "..." : pendingUSDC === 0n ? "No yield yet" : "Claim USDC"}
                    </button>

                    <p className="font-mono text-[10px] text-slate-700 text-center mt-2">
                      USDC sent directly to your wallet on Base
                    </p>
                  </div>
                )}
              </div>
            </div>

            </div>

            {/* Tx status */}
            {(txStatus || isBusy) && (
              <div className="rounded-xl border border-[#4FC3F7]/40 bg-[#4FC3F7]/10 px-5 py-3.5 font-mono text-sm text-[#4FC3F7] mb-4 flex items-center gap-2">
                {isConfirming && <span className="w-1.5 h-1.5 rounded-full bg-[#4FC3F7] animate-pulse" />}
                {isConfirming ? "Confirming on Base…" : txStatus}
              </div>
            )}
          </>
        )}

        {/* Footer info — bento with feature pills */}
        <div className="rounded-2xl border border-[#1A1A2E] bg-[#0d0d12] mt-4 p-5">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2.5 mb-4">
            {[
              { icon: "📌", text: "Credits accrue on-chain",      color: "#4FC3F7" },
              { icon: "💬", text: "Unlock Blue Chat AI",          color: "#A78BFA" },
              { icon: "⏳", text: "1-day cooldown to unstake",    color: "#F59E0B" },
            ].map(item => (
              <div key={item.text} className="flex items-start gap-2.5 rounded-xl border border-[#1A1A2E] bg-[#0a0a0f] px-3 py-2.5"
                   style={{ borderColor: `${item.color}15` }}>
                <span className="text-sm shrink-0">{item.icon}</span>
                <span className="font-mono text-[10px] text-slate-500 leading-snug">{item.text}</span>
              </div>
            ))}
          </div>
          <div className="pt-3 border-t border-[#1A1A2E] flex items-center justify-between">
            <a href={`https://basescan.org/address/${STAKING_ADDRESS}`}
              target="_blank" rel="noopener noreferrer"
              className="font-mono text-[10px] text-slate-700 hover:text-slate-500 transition-colors">
              {STAKING_ADDRESS.slice(0, 10)}…{STAKING_ADDRESS.slice(-8)} ↗
            </a>
            <Link href="/chat" className="font-mono text-[11px] text-[#4FC3F7]/60 hover:text-[#4FC3F7] transition-colors">
              Blue Chat →
            </Link>
          </div>
        </div>

      </div>
    </div>
  );
}
