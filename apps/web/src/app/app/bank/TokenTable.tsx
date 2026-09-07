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
      // `partial: true`, NOT false. This path knows nothing at all — no list was
      // obtained — and `partial: false` is the literal claim "this is the
      // complete set of tokens you hold", which is the one thing a failed fetch
      // cannot support. `error` is what the render actually keys off, but a
      // reader who only checks `partial` must not be able to conclude
      // completeness from a request that never returned.
      .catch(() => { if (!off) setData({ holdings: [], source: "rpc", partial: true, error: "load failed" }); })
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
  const addressUrl = data?.addressUrl ?? `${explorer}/address/${address}`;

  // ── How complete is this list? ──────────────────────────────────────────────
  //
  // THREE states, not two. The old code had rows-or-"No tokens … yet", and
  // computed its honesty note as `partial && holdings.length > 0` — which
  // suppressed the caveat in the ONE case where it changes what the screen
  // means: a degraded read that came back empty.
  //
  // MEASURED 2026-09-07 against production, on a real connected address:
  //   GET /api/wallet/holdings?address=0x2266…608E&network=base
  //   → {"holdings":[], "source":"rpc", "partial":true, …}
  // Moralis had not answered, so the route probed a curated-majors list only
  // (lib/wallet/holdings.ts:129) and said so in the payload. This table dropped
  // that and rendered "No tokens on Base yet" — stating as fact about the
  // user's wallet something the read could not establish.
  //
  // `error` is consulted as well as `partial`, because two other paths produce
  // a response that is NOT a complete read while carrying `partial: false`:
  // the route's own catch (api/wallet/holdings/route.ts:39) and its invalid-
  // address guard (:24). Deriving the state from everything the response
  // carries means neither of those, nor a future regression in either, can turn
  // "we could not check" back into "you hold nothing".
  //
  // This mirrors the sibling table, which already gets it right — see
  // RhTokenTable.tsx:63 and its "this is not an empty portfolio" banner. The
  // two chains disagreeing about how to report an outage was itself the bug.
  const readFailed  = !!data?.error;
  const readPartial = !!data?.partial;
  // ONE derivation, read in two places below. `listComplete` is the only thing
  // that licenses either of the screen's two unqualified assertions: "you have
  // no tokens" (the empty branch) and a bare dollar total (the header). Every
  // other state is "unknown", which is a different sentence and must look like
  // one. Deriving it once means the header and the body can never disagree
  // about whether the read succeeded.
  const listComplete = !readFailed && !readPartial;

  // `data === null` here means the effect has not run yet — the address exists
  // (guarded above) and the only other writer of `null` is the !address reset.
  // Without this, the first paint has loading=false and data=null, which lands
  // on the empty branch and flashes "No tokens on Base yet" before the request
  // has even been made.
  const pending  = loading || data === null;
  const showRows = holdings.length > 0;

  return (
    <div className="rounded-2xl border border-[#1A1A2E] bg-[#0a0a0f] p-4 mb-3">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[9px] text-slate-500 tracking-widest">TOKENS</span>
          <span className="font-mono text-[9px] px-1.5 py-0.5 rounded text-[#4FC3F7]"
            style={{ border: "1px solid #4FC3F730", background: "#4FC3F710" }}>{chainLabel}</span>
        </div>
        {showRows && (
          // On a degraded read this is the sum of the rows we could see, not the
          // value of the wallet — the same list that needs a caveat underneath
          // cannot produce an uncaveated total. "≥" is the entire claim being
          // made: the true figure cannot be lower than this, and we do not know
          // how much higher.
          <span className="font-mono text-[10px] text-slate-400 tabular-nums"
            title={listComplete ? undefined : "Partial read — at least this much; the full token list was not available"}>
            {listComplete ? "" : "≥ "}{fmtUsd(totalUsd)}
          </span>
        )}
      </div>

      {/* Column head — only over something it actually heads. The loading line
          keeps it (unchanged appearance while the request is in flight); the
          two "unknown" banners below do not, because column titles over a
          "could not read" notice render as a table that failed rather than as
          the sentence it is. */}
      {(pending || showRows) && (
        <div className={`grid ${gridCls} gap-3 px-1 pb-1.5 font-mono text-[9px] text-slate-600 border-b border-[#1A1A2E]`}>
          <span>Token</span>
          <span className="text-right">Balance</span>
          <span className="text-right">Value</span>
          {showSell && <span className="text-right">Sell</span>}
        </div>
      )}

      {/* Rows — or, when there are none, WHICH of the three no-row states it is.
          "empty", "we only checked part of it" and "we could not check" are
          three different facts about the user's wallet and only one of them is
          about the wallet at all. */}
      {pending ? (
        <div className="py-6 text-center font-mono text-[10px] text-slate-600">loading portfolio…</div>
      ) : !showRows && readFailed ? (
        <div className="mt-2 rounded-lg px-3 py-2.5 font-mono text-[9px] leading-relaxed text-amber-500/80"
          style={{ border: "1px solid #F59E0B30", background: "#F59E0B08" }}>
          {chainLabel} holdings could not be read. What this wallet holds there is unknown —
          this is not an empty portfolio.{" "}
          <a href={addressUrl} target="_blank" rel="noopener noreferrer"
            className="underline hover:text-amber-400">check on the explorer ↗</a>
        </div>
      ) : !showRows && readPartial ? (
        // The measured production case (see the note above): Moralis was
        // unavailable, so only the curated majors list was probed. Finding
        // nothing in a list of majors is not the same as holding nothing.
        <div className="mt-2 rounded-lg px-3 py-2.5 font-mono text-[9px] leading-relaxed text-amber-500/80"
          style={{ border: "1px solid #F59E0B30", background: "#F59E0B08" }}>
          Only major tokens could be checked — the full token list needs Moralis, which did not
          answer. Anything else in this wallet is unknown, not absent.{" "}
          <a href={addressUrl} target="_blank" rel="noopener noreferrer"
            className="underline hover:text-amber-400">full list on the explorer ↗</a>
        </div>
      ) : !showRows ? (
        // Reached only when listComplete — a complete read that found nothing.
        // This is the one branch entitled to speak about the wallet itself.
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

      {/* Partial / source note — the SAME caveat as the two banners above, in the
          form it takes when there are rows for it to qualify.
          The `showRows` conjunct here is the exact inverse of the bug this file
          fixes. The old code was `data?.partial && holdings.length > 0`, and the
          row count there SUPPRESSED the caveat entirely when the degraded read
          came back empty — leaving "No tokens on Base yet" standing unqualified,
          which is the case where the caveat mattered most. Here the count only
          ROUTES the caveat: no rows means it is not a footnote, it is the whole
          message, and the empty branch above says it in full. Removing this
          conjunct would print the caveat twice on one screen. */}
      {showRows && !listComplete && (
        <div className="mt-2 font-mono text-[9px] text-amber-500/80 leading-relaxed">
          {readFailed
            ? "This list is incomplete — part of the read failed. Other tokens may be held here."
            : "Showing majors only — the full token list needs Moralis. Other tokens may be held here."}{" "}
          <a href={addressUrl} target="_blank" rel="noopener noreferrer"
            className="underline hover:text-amber-400">full list on the explorer ↗</a>
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
