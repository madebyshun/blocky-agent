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
// Four states are distinguished, per leg, via lib/wallet/read-state.ts: still
// reading, "we could not check", "we could only check part of it", and "you
// hold none". Only the last is a statement about the user. This file used to
// distinguish two of the four — it never read `leg.unread` at all, the field
// whose own doc comment says "the leg is incomplete by exactly this many
// tokens — never treat as zero" — so a leg with five failed balance reads and
// no holdings rendered "No Base stock tokens · 12 checked", asserting both the
// absence and a scan count larger than what had actually been read.

import { useEffect, useState } from "react";
import type { StockPortfolio, StockLeg, StockHolding, StockVenue } from "@/lib/wallet/stock-holdings";
import { resolveRead } from "@/lib/wallet/read-state";

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

  // A leg is its own read — the two venues fail independently, which is the
  // whole reason they render as two labelled groups. `loading`/`received` are
  // fixed here because a leg only exists once the parent's fetch resolved; the
  // parent owns those two signals and passes the resolved legs down.
  //
  // `unread` is the signal this file had been ignoring. It is NOT the same as
  // `status: "unavailable"`: the chain answered, we walked the registry, and N
  // individual balance calls failed. The list is short by exactly N, so the leg
  // is `partial` — never `complete`, and with no holdings never `empty`.
  //
  // NOT fed in: unpriced holdings. That is a different axis — the LIST is
  // complete, a PRICE is missing — and the header already says "· N unpriced"
  // next to a total that excludes them. Folding it in here would put a "could
  // not read your holdings" banner over holdings that were read perfectly well.
  const read = resolveRead({
    loading:  false,
    received: true,
    failed:   leg.status === "unavailable",
    partial:  leg.unread > 0,
    rowCount: leg.holdings.length,
  });

  return (
    <div className="mb-3 last:mb-0">
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[9px] px-1.5 py-0.5 rounded text-[#4FC3F7]"
            style={{ border: "1px solid #4FC3F730", background: "#4FC3F710" }}>{leg.label}</span>
          <span className="font-mono text-[8px] text-slate-600">{leg.chainId}</span>
        </div>
        {/* Only totals what it could actually price — an unpriced holding is
            excluded from the sum and said so, never counted as $0. The "≥" is
            the OTHER caveat: rows that were never read at all cannot be in this
            sum either, and unlike the unpriced ones they cannot be counted. */}
        {priced.length > 0 && (
          <span className="font-mono text-[10px] text-slate-400 tabular-nums"
            title={read.totalIsFloor ? `${leg.unread} balance read(s) failed — at least this much` : undefined}>
            {read.totalIsFloor ? "≥ " : ""}{fmtUsd(total)}
            {priced.length < leg.holdings.length && (
              <span className="text-slate-600"> · {leg.holdings.length - priced.length} unpriced</span>
            )}
          </span>
        )}
      </div>

      {read.body === "failed" ? (
        <div className="rounded-lg px-3 py-2.5 font-mono text-[9px] leading-relaxed text-amber-500/80"
          style={{ border: "1px solid #F59E0B30", background: "#F59E0B08" }}>
          {leg.note ?? "Could not reach this chain."} Your holdings are unknown here — this is not an empty portfolio.
        </div>
      ) : read.body === "partial" ? (
        // NEW state, and the one this file was getting wrong: the chain
        // answered but some balance reads did not, and nothing was found in
        // what did. That is not "you hold no stock tokens here". `leg.note`
        // already carries the count — it was being rendered UNDERNEATH the
        // sentence it contradicts.
        <div className="rounded-lg px-3 py-2.5 font-mono text-[9px] leading-relaxed text-amber-500/80"
          style={{ border: "1px solid #F59E0B30", background: "#F59E0B08" }}>
          {leg.note ?? `${leg.unread} balance read(s) failed.`} Nothing was found in the rest —
          but this leg is incomplete, not empty.
        </div>
      ) : read.body === "empty" ? (
        // Only from a complete leg, so `scanned` is now a count of rows that
        // were actually read. It used to print here on a partial leg too, where
        // it overstated the work by exactly `leg.unread`.
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

      {/* The same caveat as the partial banner, in the shape it takes when
          there are rows to qualify — `footnote` is true only in that case, so
          the two can never both be on screen. */}
      {read.footnote && leg.note && (
        <div className="mt-1.5 font-mono text-[9px] text-amber-500/80">{leg.note}</div>
      )}
    </div>
  );
}

/**
 * `venue` narrows the table to ONE chain — the wallet's network switcher now
 * covers Base and Robinhood, and a page showing "Base" above a table listing RH
 * equities is the ticker-string confusion this file's header warns about, made
 * visual. Omitting it keeps the both-venues rendering (still used anywhere the
 * question really is "everything you hold").
 *
 * The filter is applied to the LEGS, after the fetch, and deliberately not
 * pushed into the request: each leg carries its own `status` / `unread`, so
 * dropping one at render time cannot alter what the other one reports. Fetching
 * per-venue would have made the two legs' completeness depend on which tab the
 * user was looking at.
 */
export default function StockTable({ address, venue }: { address?: `0x${string}`; venue?: StockVenue }) {
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

  // Filtered BEFORE `resolveRead` below, so "how many venues did we get" is
  // asked of the venues actually on screen. Reading it off the unfiltered list
  // would report a Base-only table as complete on the strength of an RH leg the
  // user cannot see.
  const legs = (data?.legs ?? []).filter(l => venue == null || l.venue === venue);
  const anyHeld = legs.some(l => l.holdings.length > 0);

  // The OUTER read: did we get a portfolio at all? Its rows are the legs, not
  // the holdings — each leg then resolves its own state inside <Leg>. `partial`
  // is structurally false here because a portfolio is either returned or not;
  // partialness lives one level down, per venue, where the two chains fail
  // independently.
  const read = resolveRead({
    loading,
    received: data !== null,
    failed:   !!data?.error,
    partial:  false,
    rowCount: legs.length,
  });

  return (
    <div className="rounded-2xl border border-[#1A1A2E] bg-[#0a0a0f] p-4 mb-3">
      <div className="flex items-center justify-between mb-3">
        <span className="font-mono text-[9px] text-slate-500 tracking-widest">STOCKS</span>
        <span className="font-mono text-[8px] text-slate-600">tokenized equities</span>
      </div>

      {read.body === "pending" ? (
        <div className="py-6 text-center font-mono text-[10px] text-slate-600">
          reading {venue == null ? "both chains" : venue === "base" ? "Base" : "Robinhood Chain"}…
        </div>
      ) : read.body === "failed" ? (
        <div className="py-6 text-center font-mono text-[10px] text-amber-500/80">
          Couldn&apos;t load stock holdings — {data?.error}
        </div>
      ) : read.body === "empty" || read.body === "partial" ? (
        // Zero legs from a read that did not error. `readStockHoldings` always
        // returns both venues, so with no filter this stays unreachable — but
        // `venue` made it REACHABLE, for the case where the response is missing
        // the one leg being asked for. Either way it is worded as a gap in OUR
        // answer rather than as a fact about the wallet, because "No data" read
        // as if the user held nothing.
        <div className="py-6 text-center font-mono text-[10px] text-slate-600">
          {venue == null ? "No venues were checked" : "This venue was not in the response"} —
          this says nothing about what you hold.
        </div>
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
