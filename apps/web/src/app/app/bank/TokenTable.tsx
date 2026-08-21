"use client";

// Full live token holdings — the Bankr-style portfolio centerpiece of the Wallet
// surface. Columns: Token · Balance · Value. Data comes from /api/wallet/holdings
// (Moralis, spam-filtered, usd_value already priced). Value renders "—" whenever
// Moralis has no price for a token — we NEVER fabricate a number.
//
// Chain: Base mainnet by default (matches the connected wallet), or Base Sepolia
// when the wallet is on 84532. Robinhood-Chain tokens, a PnL column, and inline
// quick-sell / swap actions are deliberate follow-ups (Moralis is Base-only, and
// PnL needs a real cost-basis source).

import { useEffect, useState } from "react";
import { useChainId } from "wagmi";
import type { WalletHolding } from "@/lib/wallet/holdings";

interface HoldingsResp {
  holdings:   WalletHolding[];
  source:     "moralis" | "rpc";
  partial:    boolean;
  explorer?:  string;
  addressUrl?: string;
  network?:   string;
  error?:     string;
}

const fmtUsd = (n?: number) =>
  n == null
    ? "—"
    : n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Compact large balances (1_700_000 → "1.7M") but leave already-trimmed small
// amounts as-is — checkWallet() has already trimmed trailing zeros server-side.
function fmtAmount(s: string): string {
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return Math.round(n).toLocaleString("en-US");
  return s;
}

export default function TokenTable({ address }: { address?: `0x${string}` }) {
  const chainId = useChainId();
  const [data, setData] = useState<HoldingsResp | null>(null);
  const [loading, setLoading] = useState(false);

  // Base mainnet portfolio unless the wallet is explicitly on Base Sepolia.
  const network    = chainId === 84532 ? "baseSepolia" : "base";
  const chainLabel = network === "baseSepolia" ? "Base Sepolia" : "Base";

  useEffect(() => {
    if (!address) { setData(null); return; }
    let off = false;
    setLoading(true);
    fetch(`/api/wallet/holdings?address=${address}&network=${network}`)
      .then(r => r.json())
      .then((d: HoldingsResp) => { if (!off) setData(d); })
      .catch(() => { if (!off) setData({ holdings: [], source: "rpc", partial: false, error: "load failed" }); })
      .finally(() => { if (!off) setLoading(false); });
    return () => { off = true; };
  }, [address, network]);

  if (!address) return null;

  const holdings = data?.holdings ?? [];
  const totalUsd = holdings.reduce((a, h) => a + (h.usdValue ?? 0), 0);
  const explorer = data?.explorer ?? "https://basescan.org";

  return (
    <div className="rounded-2xl border border-[#1A1A2E] bg-[#0a0a0f] p-4 mb-3">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[9px] text-slate-500 tracking-widest">TOKENS</span>
          <span className="font-mono text-[9px] px-1.5 py-0.5 rounded text-[#4FC3F7]"
            style={{ border: "1px solid #4FC3F730", background: "#4FC3F710" }}>{chainLabel}</span>
        </div>
        {holdings.length > 0 && (
          <span className="font-mono text-[10px] text-slate-400">{fmtUsd(totalUsd)}</span>
        )}
      </div>

      {/* Column head */}
      <div className="grid grid-cols-[1fr_auto_5rem] gap-3 px-1 pb-1.5 font-mono text-[9px] text-slate-600 border-b border-[#1A1A2E]">
        <span>Token</span>
        <span className="text-right">Balance</span>
        <span className="text-right">Value</span>
      </div>

      {/* Rows */}
      {loading ? (
        <div className="py-6 text-center font-mono text-[10px] text-slate-600">loading portfolio…</div>
      ) : holdings.length === 0 ? (
        <div className="py-6 text-center font-mono text-[10px] text-slate-600">No tokens on {chainLabel} yet</div>
      ) : (
        <div className="divide-y divide-[#1A1A2E]">
          {holdings.map(h => (
            <a key={h.address || h.symbol}
              href={`${explorer}/token/${h.address}?a=${address}`}
              target="_blank" rel="noopener noreferrer"
              className="grid grid-cols-[1fr_auto_5rem] gap-3 items-center px-1 py-2 hover:bg-[#0d0d12] transition-colors">
              {/* Token */}
              <div className="flex items-center gap-2 min-w-0">
                {h.logo
                  ? // eslint-disable-next-line @next/next/no-img-element
                    <img src={h.logo} alt="" className="w-6 h-6 rounded-full shrink-0"
                      onError={e => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
                  : <span className="w-6 h-6 rounded-full shrink-0 flex items-center justify-center font-mono text-[9px] text-slate-400"
                      style={{ background: "#1A1A2E" }}>{h.symbol.slice(0, 3).toUpperCase()}</span>}
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-[11px] text-slate-200 font-bold truncate">{h.symbol}</span>
                    {h.isB20 && <span className="font-mono text-[8px] px-1 rounded text-[#4FC3F7] shrink-0"
                      style={{ border: "1px solid #4FC3F730" }}>B20</span>}
                    {h.isNative && <span className="font-mono text-[8px] px-1 rounded text-slate-500 shrink-0"
                      style={{ border: "1px solid #1A1A2E" }}>native</span>}
                  </div>
                  {h.name && <div className="font-mono text-[9px] text-slate-600 truncate">{h.name}</div>}
                </div>
              </div>
              {/* Balance */}
              <span className="font-mono text-[10px] text-slate-300 text-right tabular-nums">{fmtAmount(h.amount)}</span>
              {/* Value */}
              <span className="font-mono text-[10px] text-right tabular-nums w-20"
                style={{ color: h.usdValue != null ? "#34D399" : "#64748b" }}>{fmtUsd(h.usdValue)}</span>
            </a>
          ))}
        </div>
      )}

      {/* Partial / source note — honest about a degraded read */}
      {data?.partial && holdings.length > 0 && (
        <div className="mt-2 font-mono text-[9px] text-amber-500/80">
          Showing majors only — full token list needs Moralis.
        </div>
      )}
    </div>
  );
}
