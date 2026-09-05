"use client";

// Robinhood Chain crypto holdings — the third table in the Portfolio view,
// under TokenTable (Base crypto) and beside StockTable (equities, both chains).
//
// WHY IT EXISTS: TokenTable is fed by Moralis, and Moralis does not index RH
// 4663. So the wallet used to show a holder's RH *stocks* and silently omit
// their RH *tokens* — USDG included, which is what that chain calls cash — with
// nothing on screen admitting a whole chain went unread. Blue Chat's wallet card
// has read both chains all along; this makes the wallet agree with it.
//
// It is a SEPARATE table rather than extra rows in TokenTable for the same
// reason StockTable renders its two venues as two labelled legs: these are
// different chains with different explorers, and the Base table's quick-sell
// (0x, Base-only) cannot settle here. A Sell button that cannot fill is worse
// than no button.
//
// Read-only on purpose. WALLET_CHAIN_ORDER deliberately omits Robinhood because
// the send/swap/onramp paths are still Base-shaped; this table shows what is
// held and links to Blockscout, and offers no control that would move funds.

import { useEffect, useState } from "react";
import type { RhHoldingsResult } from "@/lib/wallet/rh-holdings";
import { TRUST_BADGE } from "@/lib/wallet/token-trust";

const fmtUsd = (n?: number | null) =>
  n == null
    ? "—"
    : n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

function fmtAmount(s: string): string {
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return Math.round(n).toLocaleString("en-US");
  return s;
}

export default function RhTokenTable({ address }: { address?: `0x${string}` }) {
  const [data, setData] = useState<RhHoldingsResult | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!address) { setData(null); return; }
    let off = false;
    setLoading(true);
    fetch(`/api/wallet/rh-holdings?address=${address}`)
      .then(r => r.json())
      .then((d: RhHoldingsResult) => { if (!off) setData(d); })
      // A failed fetch is "we could not check", never an empty portfolio.
      .catch(() => { if (!off) setData(null); })
      .finally(() => { if (!off) setLoading(false); });
    return () => { off = true; };
  }, [address]);

  if (!address) return null;

  const holdings = data?.holdings ?? [];
  const nFlagged = holdings.filter(h => h.trust === "impostor").length;
  // `data === null` covers a thrown fetch; the route itself always answers with
  // a status, so both paths land on the same honest banner.
  const unavailable = !loading && (data === null || data.status !== "ok");

  return (
    <div className="rounded-2xl border border-[#1A1A2E] bg-[#0a0a0f] p-4 mb-3">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[9px] text-slate-500 tracking-widest">TOKENS</span>
          <span className="font-mono text-[9px] px-1.5 py-0.5 rounded text-[#4FC3F7]"
            style={{ border: "1px solid #4FC3F730", background: "#4FC3F710" }}>Robinhood Chain</span>
          <span className="font-mono text-[8px] text-slate-600">4663</span>
        </div>
        {holdings.length > 0 && data?.status === "ok" && (
          <span className="font-mono text-[10px] text-slate-400 tabular-nums">{fmtUsd(data.totalUsd)}</span>
        )}
      </div>

      {loading ? (
        <div className="py-6 text-center font-mono text-[10px] text-slate-600">reading Robinhood Chain…</div>
      ) : unavailable ? (
        // The one state this table exists to be able to say. An RH holder seeing
        // an empty list would conclude their tokens are gone.
        <div className="rounded-lg px-3 py-2.5 font-mono text-[9px] leading-relaxed text-amber-500/80"
          style={{ border: "1px solid #F59E0B30", background: "#F59E0B08" }}>
          Robinhood Chain explorer did not answer. Your holdings there are unknown — this is
          not an empty portfolio.
        </div>
      ) : holdings.length === 0 ? (
        <div className="py-6 text-center font-mono text-[10px] text-slate-600">No tokens on Robinhood Chain</div>
      ) : (
        <>
          <div className="grid grid-cols-[1fr_auto_5rem] gap-3 px-1 pb-1.5 font-mono text-[9px] text-slate-600 border-b border-[#1A1A2E]">
            <span>Token</span>
            <span className="text-right">Balance</span>
            <span className="text-right">Value</span>
          </div>
          <div className="divide-y divide-[#1A1A2E]">
            {holdings.map(h => {
              const badge    = TRUST_BADGE[h.trust];
              const impostor = h.trust === "impostor";
              return (
                <div key={h.address}
                  className={`grid grid-cols-[1fr_auto_5rem] gap-3 items-center px-1 py-2 hover:bg-[#0d0d12] transition-colors ${impostor ? "opacity-60" : ""}`}>
                  {/* Blockscout, not Basescan — the two chains share no state, so
                      a Basescan link for a 4663 address resolves to nothing. */}
                  <a href={h.explorerUrl} target="_blank" rel="noopener noreferrer"
                    className="flex items-center gap-2 min-w-0">
                    <span className="w-6 h-6 rounded-full shrink-0 flex items-center justify-center font-mono text-[9px] text-slate-400"
                      style={{ background: "#1A1A2E" }}>{h.symbol.slice(0, 3).toUpperCase()}</span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-[11px] font-bold truncate"
                          style={{ color: impostor ? "#94a3b8" : "#e2e8f0" }}>{h.symbol}</span>
                        {h.isNative && <span className="font-mono text-[8px] px-1 rounded text-slate-500 shrink-0"
                          style={{ border: "1px solid #1A1A2E" }}>native</span>}
                        {badge && <span className="font-mono text-[8px] px-1 rounded shrink-0"
                          style={{ color: badge.color, border: `1px solid ${badge.color}55` }}>{badge.label}</span>}
                      </div>
                      {h.name && <div className="font-mono text-[9px] text-slate-600 truncate">{h.name}</div>}
                    </div>
                  </a>
                  <span className="font-mono text-[10px] text-slate-300 text-right tabular-nums">{fmtAmount(h.amount)}</span>
                  {/* An impostor's price is its own claim, quoted through its own
                      pool — same withholding as the Base table. */}
                  <span className="font-mono text-[10px] text-right tabular-nums"
                    style={{ color: impostor ? "#64748b" : h.usdValue != null ? "#34D399" : "#64748b" }}>
                    {impostor ? "—" : fmtUsd(h.usdValue)}
                  </span>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Notes — each one says a thing the rows above cannot. */}
      {data?.status === "ok" && data.nativeUnread && (
        <div className="mt-2 font-mono text-[9px] text-amber-500/80">
          Native ETH balance could not be read — this list is short by up to one row.
        </div>
      )}
      {/* Blockscout pages this address 50 rows at a time, highest value first,
          and the walk stopped at the cap. Says "the list is short" and NOT "the
          total is wrong", because those are different claims and only the first
          one is true — see RH_MAX_TOKEN_PAGES for the measurement. */}
      {data?.status === "ok" && data.truncated && (
        <div className="mt-2 font-mono text-[9px] text-slate-600 leading-relaxed">
          This address holds more tokens than shown. These are the highest-valued ones —{" "}
          <a href={`${data.explorer}/address/${address}?tab=tokens`}
            target="_blank" rel="noopener noreferrer" className="underline hover:text-slate-400">
            full list on Blockscout ↗
          </a>
        </div>
      )}
      {nFlagged > 0 && (
        <div className="mt-2 font-mono text-[9px] text-red-400/80 leading-relaxed">
          {nFlagged} token{nFlagged > 1 ? "s" : ""} use{nFlagged > 1 ? "" : "s"} the ticker of a
          Robinhood-issued token at a different contract address. Not counted in the total.
        </div>
      )}
      {data?.status === "ok" && data.equitiesHidden > 0 && (
        <div className="mt-2 font-mono text-[9px] text-slate-600 leading-relaxed">
          {data.equitiesHidden} tokenized {data.equitiesHidden > 1 ? "equities are" : "equity is"} held
          here too — shown in Stocks below, not counted twice.
        </div>
      )}
    </div>
  );
}
