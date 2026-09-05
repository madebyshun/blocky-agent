"use client";

import { useEffect, useState } from "react";
import { useAccount, useSendTransaction, useSwitchChain } from "wagmi";
import { createPublicClient, http, encodeFunctionData, keccak256, encodeAbiParameters } from "viem";
import { base } from "wagmi/chains";
import { ConnectButton } from "@/components/ConnectModal";
import {
  B20HUB_HOOK,
  B20HUB_BUYBACK,
  WETH9_BASE,
  V4_FEE_TIERS,
} from "@/lib/b20hub/constants";

/**
 * B20HUB — Claim Creator Fees UI.
 *
 * Anyone can trigger the 80/15/5 split on any B20HUB pool. The split targets
 * are hard-coded in the hook (creator was written by launcher.setPending at
 * launch time; BuyBack + Treasury are hook immutables), so calling from a
 * random wallet doesn't misroute a single wei.
 *
 * Limitation: the currently-deployed hook only tracks Position A's tokenId
 * (see B20HUBHook.sol comment). Position B's fees stay stuck until the next
 * hook redeploy adds `lpTokenIdBOfPool` + iterates both. This page claims
 * Position A only. Position B fees will unlock when v4 hook ships.
 */

const HOOK_ABI = [
  {
    type: "function",
    name: "claimFees",
    stateMutability: "nonpayable",
    inputs: [
      { name: "poolId", type: "bytes32" },
      {
        name: "key",
        type: "tuple",
        components: [
          { name: "currency0",  type: "address" },
          { name: "currency1",  type: "address" },
          { name: "fee",        type: "uint24"  },
          { name: "tickSpacing",type: "int24"   },
          { name: "hooks",      type: "address" },
        ],
      },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "creatorOfPool",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [{ name: "creator", type: "address" }],
  },
  {
    type: "function",
    name: "lpTokenIdOfPool",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [{ name: "tokenId", type: "uint256" }],
  },
] as const;

const publicClient = createPublicClient({
  chain: base,
  transport: http("https://mainnet.base.org"),
});

type FeeTierKey = "MEDIUM" | "HIGH" | "3PCT";
const TIER_FEE: Record<FeeTierKey, number> = {
  MEDIUM: 3000,
  HIGH:   10000,
  "3PCT": 30000,
};
const TIER_SPACING: Record<FeeTierKey, number> = {
  MEDIUM: V4_FEE_TIERS.MEDIUM.tickSpacing,
  HIGH:   V4_FEE_TIERS.HIGH.tickSpacing,
  "3PCT": 200, // 3% tier tickSpacing lock-in from launcher
};

// PoolKey requires currency0 < currency1 sorted. Compute the correct pool key
// for a given token address (WETH is currency0 iff its address is smaller).
function buildPoolKey(token: `0x${string}`, tier: FeeTierKey) {
  const weth = WETH9_BASE;
  const tokenLC = token.toLowerCase();
  const wethLC  = weth.toLowerCase();
  const wethIsSmaller = wethLC < tokenLC;
  return {
    currency0:  (wethIsSmaller ? weth : token) as `0x${string}`,
    currency1:  (wethIsSmaller ? token : weth) as `0x${string}`,
    fee:        TIER_FEE[tier],
    tickSpacing:TIER_SPACING[tier],
    hooks:      B20HUB_HOOK as `0x${string}`,
  };
}

function computePoolId(key: ReturnType<typeof buildPoolKey>): `0x${string}` {
  // keccak256(abi.encode(PoolKey)) — same encoding V4 uses internally.
  const encoded = encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "currency0",  type: "address" },
          { name: "currency1",  type: "address" },
          { name: "fee",        type: "uint24"  },
          { name: "tickSpacing",type: "int24"   },
          { name: "hooks",      type: "address" },
        ],
      },
    ],
    [key],
  );
  return keccak256(encoded);
}

export default function ClaimClient() {
  const { address, isConnected } = useAccount();
  const { sendTransactionAsync } = useSendTransaction();
  const { switchChainAsync } = useSwitchChain();

  const [token,      setToken]      = useState("");
  const [tier,       setTier]       = useState<FeeTierKey>("MEDIUM");
  const [status,     setStatus]     = useState<"idle"|"loading"|"ready"|"claiming"|"done"|"error">("idle");
  const [error,      setError]      = useState("");
  const [txHash,     setTxHash]     = useState("");
  const [creator,    setCreator]    = useState<`0x${string}` | null>(null);
  const [lpTokenId,  setLpTokenId]  = useState<bigint | null>(null);
  const [poolId,     setPoolId]     = useState<`0x${string}` | null>(null);

  // Reset lookup state when the input changes.
  useEffect(() => { setStatus("idle"); setError(""); setCreator(null); setLpTokenId(null); setPoolId(null); }, [token, tier]);

  const tokenValid = /^0x[a-fA-F0-9]{40}$/.test(token.trim());

  async function lookup() {
    if (!tokenValid) {
      setError("Enter a valid B20HUB token address (0x…)"); setStatus("error"); return;
    }
    setStatus("loading"); setError("");
    try {
      const key = buildPoolKey(token.trim() as `0x${string}`, tier);
      const id  = computePoolId(key);
      const [c, tid] = await Promise.all([
        publicClient.readContract({
          address: B20HUB_HOOK as `0x${string}`,
          abi:     HOOK_ABI,
          functionName: "creatorOfPool",
          args: [id],
        }),
        publicClient.readContract({
          address: B20HUB_HOOK as `0x${string}`,
          abi:     HOOK_ABI,
          functionName: "lpTokenIdOfPool",
          args: [id],
        }),
      ]);
      if (c === "0x0000000000000000000000000000000000000000") {
        setError("Not a B20HUB pool at this fee tier. Try another tier or double-check the token address.");
        setStatus("error"); return;
      }
      setCreator(c as `0x${string}`);
      setLpTokenId(tid as bigint);
      setPoolId(id);
      setStatus("ready");
    } catch (e) {
      setError((e as Error).message); setStatus("error");
    }
  }

  async function claim() {
    if (!poolId) return;
    setStatus("claiming"); setError(""); setTxHash("");
    try {
      const key = buildPoolKey(token.trim() as `0x${string}`, tier);
      const data = encodeFunctionData({
        abi: HOOK_ABI,
        functionName: "claimFees",
        args: [poolId, key],
      });
      try { await switchChainAsync({ chainId: 8453 }); }
      catch { throw new Error("Switch wallet to Base mainnet (chain 8453) and retry"); }
      const hash = await sendTransactionAsync({
        to: B20HUB_HOOK as `0x${string}`,
        data,
        chainId: 8453,
      });
      setTxHash(hash);
      setStatus("done");
    } catch (e) {
      setError((e as Error).message || "Claim failed"); setStatus("error");
    }
  }

  const isCreator = !!(creator && address && creator.toLowerCase() === address.toLowerCase());

  return (
    <div className="min-h-screen bg-[#050508] text-slate-200 pb-20">
      <div className="max-w-2xl mx-auto px-4 pt-10">
        <div className="mb-6">
          <p className="font-mono text-[9px] text-slate-600 tracking-widest uppercase mb-1">B20HUB</p>
          <h1 className="font-mono text-2xl font-bold text-slate-100">Claim Creator Fees</h1>
          <p className="font-mono text-xs text-slate-500 mt-2 leading-relaxed">
            Trigger the <span className="text-[#34D399]">80</span>/<span className="text-[#4FC3F7]">15</span>/<span className="text-slate-400">5</span> split
            on any B20HUB pool. Permissionless: anyone can trigger, recipients are hard-coded
            in the hook (creator was locked in at launch; BuyBack + Treasury are hook immutables).
          </p>
        </div>

        <div className="rounded-2xl border border-[#1A1A2E] bg-[#0a0a0f] p-5 space-y-4">
          <div>
            <label className="font-mono text-[9px] text-slate-600 tracking-widest uppercase block mb-1.5">
              B20HUB Token Address
            </label>
            <input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="0xb200…"
              spellCheck={false}
              className="w-full bg-[#0a0a12] border border-[#1A1A2E] focus:border-[#4FC3F740] rounded-xl px-3 py-2.5 font-mono text-xs text-slate-200 placeholder:text-slate-700 outline-none transition-colors"
            />
          </div>

          <div>
            <label className="font-mono text-[9px] text-slate-600 tracking-widest uppercase block mb-1.5">
              Fee Tier
            </label>
            <div className="flex rounded-xl border border-[#1A1A2E] overflow-hidden">
              {(["MEDIUM", "HIGH", "3PCT"] as const).map((t, i) => (
                <button
                  key={t}
                  onClick={() => setTier(t)}
                  className="flex-1 py-2 font-mono text-[10px] transition-all"
                  style={tier === t
                    ? { background: "#4FC3F715", color: "#4FC3F7", borderRight: i < 2 ? "1px solid #1A1A2E" : undefined }
                    : { color: "#475569", borderRight: i < 2 ? "1px solid #1A1A2E" : undefined }}
                >
                  {t === "MEDIUM" ? "0.3%" : t === "HIGH" ? "1%" : "3%"}
                </button>
              ))}
            </div>
          </div>

          <button
            onClick={lookup}
            disabled={!tokenValid || status === "loading" || status === "claiming"}
            className="w-full font-mono text-xs font-bold py-2.5 rounded-xl transition-all disabled:opacity-40"
            style={{ background: "#0d0d16", border: "1px solid #4FC3F740", color: "#4FC3F7" }}
          >
            {status === "loading" ? "Checking on-chain…" : "Check claimable"}
          </button>

          {status === "ready" && creator && lpTokenId !== null && (
            <div className="rounded-xl border border-[#4FC3F7]/20 bg-[#4FC3F7]/[0.03] p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[10px] text-slate-500">Creator</span>
                <span className="font-mono text-xs text-slate-200">
                  {creator.slice(0, 8)}…{creator.slice(-6)}
                  {isCreator && <span className="ml-2 text-[9px] text-[#34D399]">(you)</span>}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="font-mono text-[10px] text-slate-500">Position A tokenId</span>
                <span className="font-mono text-xs text-slate-200">#{lpTokenId.toString()}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="font-mono text-[10px] text-slate-500">BuyBack</span>
                <span className="font-mono text-xs text-slate-200">
                  {B20HUB_BUYBACK.slice(0, 8)}…{B20HUB_BUYBACK.slice(-6)}
                </span>
              </div>

              <div className="pt-3 border-t border-[#4FC3F7]/10 space-y-2">
                <p className="font-mono text-[10px] text-slate-500 leading-relaxed">
                  On claim, ANY accumulated Position A fees (WETH + token) split:
                </p>
                <div className="grid grid-cols-3 gap-2 text-center font-mono text-[10px]">
                  <div className="rounded-lg border border-[#34D399]/20 py-2">
                    <div className="text-[#34D399] font-bold">80%</div>
                    <div className="text-slate-600 mt-0.5">creator</div>
                  </div>
                  <div className="rounded-lg border border-[#4FC3F7]/20 py-2">
                    <div className="text-[#4FC3F7] font-bold">15%</div>
                    <div className="text-slate-600 mt-0.5">BuyBack</div>
                  </div>
                  <div className="rounded-lg border border-[#1A1A2E] py-2">
                    <div className="text-slate-400 font-bold">5%</div>
                    <div className="text-slate-600 mt-0.5">treasury</div>
                  </div>
                </div>
              </div>

              {!isConnected ? (
                <ConnectButton label="Connect Wallet to Claim" />
              ) : (
                <button
                  onClick={claim}
                  className="w-full font-mono text-sm font-bold py-3 rounded-xl transition-all"
                  style={{ background: "#34D399", color: "#050508" }}
                >
                  🔷 Claim fees (anyone can trigger)
                </button>
              )}

              <p className="font-mono text-[9px] text-amber-400/60 leading-relaxed mt-2">
                ⚠ v3 hook only tracks Position A (wide). Position B (narrow, tighter concentration)
                fees are stuck until v4 hook ships with dual-position support. This claims wide-position
                fees only.
              </p>
            </div>
          )}

          {status === "done" && txHash && (
            <div className="rounded-xl border border-[#34D399]/30 bg-[#34D399]/5 p-4">
              <p className="font-mono text-sm text-[#34D399] font-bold mb-1">✓ Claim sent</p>
              <a
                href={`https://basescan.org/tx/${txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-[10px] text-[#4FC3F7] hover:underline break-all"
              >
                {txHash.slice(0, 16)}…{txHash.slice(-8)} ↗
              </a>
              <p className="font-mono text-[9px] text-slate-600 mt-2">
                Check creator + BuyBack + Treasury balances on Basescan after ~2s.
              </p>
            </div>
          )}

          {(status === "error" || error) && (
            <div className="rounded-xl border border-[#EF444430] bg-[#EF4444]/5 p-4">
              <p className="font-mono text-xs text-[#EF4444] break-words">{error}</p>
            </div>
          )}
        </div>

        <div className="mt-6 rounded-2xl border border-[#1A1A2E] bg-[#0a0a0f] p-5">
          <h2 className="font-mono text-sm font-bold text-slate-200 mb-3">How the split works</h2>
          <ul className="font-mono text-[11px] text-slate-500 space-y-2 leading-relaxed">
            <li>
              <span className="text-[#34D399]">80%</span> — you (or whoever launched the token). Locked
              at launch via <code className="text-slate-300">setPending</code>; cannot be reassigned.
            </li>
            <li>
              <span className="text-[#4FC3F7]">15%</span> — BlueBuyBack contract. Accumulates WETH here,
              then anyone can call <code className="text-slate-300">distribute()</code> once ≥ 0.001 WETH
              is queued. That swap sends BUY pressure into the BLUE/WETH pool and rewards the caller with
              a 0.1% keeper cut.
            </li>
            <li>
              <span className="text-slate-400">5%</span> — BlueAgent treasury multisig.
              Covers infra + community.
            </li>
            <li>
              This page is permissionless. If you&apos;re not the creator you can still trigger the claim
              — the creator still gets their 80%, you just paid the gas.
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
