"use client";

// Tokenized-stock holdings — the equity half of the Wallet, sitting under the
// crypto TokenTable. Data comes from /api/wallet/stocks (registry addresses +
// on-chain balances + Chainlink/DEX prices; see lib/wallet/stock-holdings.ts).
//
// The two venues are rendered as two labelled groups, never merged. NVDA on
// Base and NVDA on Robinhood Chain are different tokens at different addresses
// with different decimals, so a single "NVDA" row would be a lie about what the
// wallet holds — and the explorers are not interchangeable either, which is why
// each row links through its own leg's explorer.
//
// Three states are distinguished on purpose: holdings, "you hold none", and
// "we could not check". The last one is a leg the chain didn't answer for —
// rendering it as an empty portfolio is how a user concludes their position
// vanished.

import { useEffect, useState } from "react";
import type { StockPortfolio, StockLeg, StockHolding } from "@/lib/wallet/stock-holdings";

const fmtUsd = (n: number | null | undefined) =>
  n == null
    ? "—"
    : n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

function fmtAmount(s: string): string {
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return Math.round(n).toLocaleString("en-US");
  return s;
}

function Row({ h, isLast }: { h: StockHolding; isLast: boolean }) {
  return (
    <div className={`grid grid-cols-[1fr_auto_5.5rem] gap-3 items-center px-1 py-2 hover:bg-[#0d0d12] transition-colors ${isLast ? "" : "border-b border-[#1A1A2E]"}`}>
      <a href={h.explorerUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 min-w-0">
        <span className="w-6 h-6 rounded-full shrink-0 flex items-center justify-center font-mono text-[8px] text-slate-400"
          style={{ background: "#1A1A2E" }}>{h.ticker.slice(0, 4)}</span>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            {/* The on-chain SYMBOL, not the bare ticker — "NVDAc" is the Base
                token and "NVDA" is the RH one, and the difference is the point. */}
            <span className="font-mono text-[11px] font-bold text-slate-200 truncate">{h.symbol}</span>
            {h.kind === "etf" && <span className="font-mono text-[8px] px-1 rounded text-slate-500 shrink-0"
              style={{ border: "1px solid #1A1A2E" }}>ETF</span>}
          </div>
          <div className="font-mono text-[9px] text-slate-600 truncate">{h.name}</div>
        </div>
      </a>
      <span className="font-mono text-[10px] text-slate-300 text-right tabular-nums">{fmtAmount(h.amount)}</span>
      <div className="text-right">
        <div className="font-mono text-[10px] text-slate-300 tabular-nums">{fmtUsd(h.valueUsd)}</div>
        {/* Why the value is blank, spelled out rather than left as a dash the
            user has to interpret as either zero or unknown. */}
        {h.valueUsd == null
          ? <div className="font-mono text-[8px] text-slate-600 leading-tight">{h.unpricedReason ?? "unknown"}</div>
          : h.priceSource === "dex-spot"
            ? <div className="font-mono text-[8px] text-slate-600 leading-tight">pool price</div>
            : null}
      </div>
    </div>
  );
}

function Leg({ leg }: { leg: StockLeg }) {
  const priced = leg.holdings.filter(h => h.valueUsd != null);
  const total = priced.reduce((a, h) => a + (h.valueUsd ?? 0), 0);

  return (
    <div className="mb-3 last:mb-0">
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[9px] px-1.5 py-0.5 rounded text-[#4FC3F7]"
            style={{ border: "1px solid #4FC3F730", background: "#4FC3F710" }}>{leg.label}</span>
          <span className="font-mono text-[8px] text-slate-600">{leg.chainId}</span>
        </div>
        {/* Only totals what it could actually price — an unpriced holding is
            excluded from the sum and said so, never counted as $0. */}
        {priced.length > 0 && (
          <span className="font-mono text-[10px] text-slate-400 tabular-nums">
            {fmtUsd(total)}
            {priced.length < leg.holdings.length && (
              <span className="text-slate-600"> · {leg.holdings.length - priced.length} unpriced</span>
            )}
          </span>
        )}
      </div>

      {leg.status === "unavailable" ? (
        <div className="rounded-lg px-3 py-2.5 font-mono text-[9px] leading-relaxed text-amber-500/80"
          style={{ border: "1px solid #F59E0B30", background: "#F59E0B08" }}>
          {leg.note ?? "Could not reach this chain."} Your holdings are unknown here — this is not an empty portfolio.
        </div>
      ) : leg.holdings.length === 0 ? (
        <div className="py-3 text-center font-mono text-[9px] text-slate-600">
          No {leg.label} stock tokens · {leg.scanned} checked
        </div>
      ) : (
        <div>
          {leg.holdings.map((h, i) => (
            <Row key={h.contract} h={h} isLast={i === leg.holdings.length - 1} />
          ))}
        </div>
      )}

      {leg.status === "ok" && leg.note && (
        <div className="mt-1.5 font-mono text-[9px] text-amber-500/80">{leg.note}</div>
      )}
    </div>
  );
}

export default function StockTable({ address }: { address?: `0x${string}` }) {
  const [data, setData] = useState<StockPortfolio | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!address) { setData(null); return; }
    let off = false;
    setLoading(true);
    fetch(`/api/wallet/stocks?address=${address}`)
      .then(r => r.json())
      .then((d: StockPortfolio) => { if (!off) setData(d); })
      .catch(() => { if (!off) setData({ address, legs: [], ts: Date.now(), error: "load failed" }); })
      .finally(() => { if (!off) setLoading(false); });
    return () => { off = true; };
  }, [address]);

  if (!address) return null;

  const legs = data?.legs ?? [];
  const anyHeld = legs.some(l => l.holdings.length > 0);

  return (
    <div className="rounded-2xl border border-[#1A1A2E] bg-[#0a0a0f] p-4 mb-3">
      <div className="flex items-center justify-between mb-3">
        <span className="font-mono text-[9px] text-slate-500 tracking-widest">STOCKS</span>
        <span className="font-mono text-[8px] text-slate-600">tokenized equities</span>
      </div>

      {loading ? (
        <div className="py-6 text-center font-mono text-[10px] text-slate-600">reading both chains…</div>
      ) : data?.error ? (
        <div className="py-6 text-center font-mono text-[10px] text-amber-500/80">
          Couldn&apos;t load stock holdings — {data.error}
        </div>
      ) : legs.length === 0 ? (
        <div className="py-6 text-center font-mono text-[10px] text-slate-600">No data</div>
      ) : (
        <>
          <div className="grid grid-cols-[1fr_auto_5.5rem] gap-3 px-1 pb-1.5 font-mono text-[9px] text-slate-600 border-b border-[#1A1A2E] mb-2">
            <span>Token</span>
            <span className="text-right">Shares</span>
            <span className="text-right">Value</span>
          </div>
          {legs.map(l => <Leg key={l.venue} leg={l} />)}
          {!anyHeld && legs.every(l => l.status === "ok") && (
            <div className="mt-1 font-mono text-[9px] text-slate-600 leading-relaxed">
              Only tokens from the verified registries are checked — a share token at any
              other address is not counted here, and shows up in Tokens above instead.
            </div>
          )}
        </>
      )}
    </div>
  );
}
