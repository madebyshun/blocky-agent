"use client";

// Full live token holdings — the Bankr-style portfolio centerpiece of the Wallet
// surface. Columns: Token · Balance · Value · (Sell). Data comes from
// /api/wallet/holdings (Moralis, spam-filtered, usd_value already priced). Value
// renders "—" whenever Moralis has no price for a token — we NEVER fabricate one.
//
// Chain: Base mainnet by default (matches the connected wallet), or Base Sepolia
// when the wallet is on 84532. The per-row quick-sell (25/50/100%) only shows on
// Base mainnet (0x has no testnet liquidity) — it just pre-fills + opens the
// Convert panel via onQuickSell; the user still reviews and signs there.
//
// This table is Base-ONLY and its header chip says so, because Moralis does not
// index Robinhood Chain. RH crypto is a separate table (`RhTokenTable`, via
// Blockscout) rather than extra rows here: quick-sell is 0x-on-Base and the
// trust verdict is computed against Base's address book, so an RH row folded in
// would inherit a Sell button that cannot fill. A PnL column is still a
// follow-up — it needs a real cost-basis source, not a UI change.
//
// TRUST: every row also carries `h.trust`, derived in holdings.ts from the token
// ADDRESS (see lib/wallet/token-trust.ts). This table used to render whatever
// Moralis returned, with an identical live `Sell ▾` on each row — including on a
// token whose symbol said "USDC" and whose name said "United States of Doge
// CashCat". Two things follow from trust here and both are load-bearing:
// an impostor gets NO trade control, and it does not count toward the total.

import { useEffect, useState } from "react";
import { useChainId } from "wagmi";
import type { WalletHolding } from "@/lib/wallet/holdings";
import { canQuickSell, countsTowardTotal, TRUST_BADGE } from "@/lib/wallet/token-trust";

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

// Compact per-row quick-sell: 25/50/100% → opens the Convert panel pre-filled.
// A native <select> so it never nests inside the row's explorer <a>.
function SellControl({ h, onQuickSell }: { h: WalletHolding; onQuickSell: (h: WalletHolding, pct: number) => void }) {
  return (
    <select
      aria-label={`Sell ${h.symbol}`}
      defaultValue=""
      onChange={e => { const p = Number(e.target.value); e.currentTarget.selectedIndex = 0; if (p > 0) onQuickSell(h, p); }}
      className="justify-self-end bg-[#050508] border border-[#1A1A2E] rounded-lg pl-1.5 pr-0.5 py-1 font-mono text-[9px] text-[#4FC3F7] outline-none cursor-pointer hover:border-[#4FC3F7]/40">
      <option value="">Sell ▾</option>
      <option value="25">25%</option>
      <option value="50">50%</option>
      <option value="100">100%</option>
    </select>
  );
}

export default function TokenTable({ address, onQuickSell }: {
  address?: `0x${string}`;
  onQuickSell?: (h: WalletHolding, pct: number) => void;
}) {
  const chainId = useChainId();
  const [data, setData] = useState<HoldingsResp | null>(null);
  const [loading, setLoading] = useState(false);

  // Base mainnet portfolio unless the wallet is explicitly on Base Sepolia.
  const network    = chainId === 84532 ? "baseSepolia" : "base";
  const chainLabel = network === "baseSepolia" ? "Base Sepolia" : "Base";
  // Quick-sell only on Base mainnet (0x has no testnet liquidity).
  const showSell = !!onQuickSell && network === "base";
  const gridCls  = showSell ? "grid-cols-[1fr_auto_4.5rem_auto]" : "grid-cols-[1fr_auto_5rem]";

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
  // Impostors are excluded from the headline total. A scam token can quote any
  // price it likes through a pool it controls, so counting it would let the
  // impostor set the number this card presents as the user's portfolio value.
  const totalUsd  = holdings.reduce((a, h) => a + (countsTowardTotal(h.trust) ? (h.usdValue ?? 0) : 0), 0);
  const nFlagged  = holdings.filter(h => h.trust === "impostor").length;
  const explorer  = data?.explorer ?? "https://basescan.org";

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
      <div className={`grid ${gridCls} gap-3 px-1 pb-1.5 font-mono text-[9px] text-slate-600 border-b border-[#1A1A2E]`}>
        <span>Token</span>
        <span className="text-right">Balance</span>
        <span className="text-right">Value</span>
        {showSell && <span className="text-right">Sell</span>}
      </div>

      {/* Rows */}
      {loading ? (
        <div className="py-6 text-center font-mono text-[10px] text-slate-600">loading portfolio…</div>
      ) : holdings.length === 0 ? (
        <div className="py-6 text-center font-mono text-[10px] text-slate-600">No tokens on {chainLabel} yet</div>
      ) : (
        <div className="divide-y divide-[#1A1A2E]">
          {holdings.map(h => {
            const badge    = TRUST_BADGE[h.trust];
            const impostor = h.trust === "impostor";
            return (
            <div key={h.address || h.symbol}
              className={`grid ${gridCls} gap-3 items-center px-1 py-2 hover:bg-[#0d0d12] transition-colors ${impostor ? "opacity-60" : ""}`}>
              {/* Token — links to explorer */}
              <a href={`${explorer}/token/${h.address}?a=${address}`}
                target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-2 min-w-0">
                {h.logo
                  ? // eslint-disable-next-line @next/next/no-img-element
                    <img src={h.logo} alt="" className="w-6 h-6 rounded-full shrink-0"
                      onError={e => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
                  : <span className="w-6 h-6 rounded-full shrink-0 flex items-center justify-center font-mono text-[9px] text-slate-400"
                      style={{ background: "#1A1A2E" }}>{h.symbol.slice(0, 3).toUpperCase()}</span>}
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-[11px] font-bold truncate"
                      style={{ color: impostor ? "#94a3b8" : "#e2e8f0" }}>{h.symbol}</span>
                    {h.isB20 && <span className="font-mono text-[8px] px-1 rounded text-[#4FC3F7] shrink-0"
                      style={{ border: "1px solid #4FC3F730" }}>B20</span>}
                    {h.isNative && <span className="font-mono text-[8px] px-1 rounded text-slate-500 shrink-0"
                      style={{ border: "1px solid #1A1A2E" }}>native</span>}
                    {badge && <span className="font-mono text-[8px] px-1 rounded shrink-0"
                      style={{ color: badge.color, border: `1px solid ${badge.color}55` }}>{badge.label}</span>}
                  </div>
                  {h.name && <div className="font-mono text-[9px] text-slate-600 truncate">{h.name}</div>}
                </div>
              </a>
              {/* Balance */}
              <span className="font-mono text-[10px] text-slate-300 text-right tabular-nums">{fmtAmount(h.amount)}</span>
              {/* Value — an impostor's price is its own claim, so it isn't shown */}
              <span className="font-mono text-[10px] text-right tabular-nums"
                style={{ color: impostor ? "#64748b" : h.usdValue != null ? "#34D399" : "#64748b" }}>
                {impostor ? "—" : fmtUsd(h.usdValue)}
              </span>
              {/* Sell — pre-fills the Convert panel; user reviews + signs there.
                  Withheld on an impostor: being mistaken for another token is the
                  whole point of that token, and a trade button is the payoff.
                  The empty <span> keeps the row's grid slot so columns stay
                  aligned — the CONTROL is absent from the DOM, not hidden. */}
              {showSell && (canQuickSell(h.trust)
                ? <SellControl h={h} onQuickSell={onQuickSell!} />
                : <span className="justify-self-end font-mono text-[9px] text-slate-700" title="Name does not match this contract — trading disabled here">—</span>)}
            </div>
            );
          })}
        </div>
      )}

      {/* Partial / source note — honest about a degraded read */}
      {data?.partial && holdings.length > 0 && (
        <div className="mt-2 font-mono text-[9px] text-amber-500/80">
          Showing majors only — full token list needs Moralis.
        </div>
      )}

      {/* Say WHY a row is flagged, once, instead of leaving the badge to be guessed at. */}
      {nFlagged > 0 && (
        <div className="mt-2 font-mono text-[9px] text-red-400/80 leading-relaxed">
          {nFlagged} token{nFlagged > 1 ? "s" : ""} use{nFlagged > 1 ? "" : "s"} the name of a real
          asset at a different contract address. Not counted in the total, and not tradable here.
        </div>
      )}
    </div>
  );
}
