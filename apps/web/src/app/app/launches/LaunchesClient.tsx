"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import {
  useAccount, useSendTransaction, useSwitchChain, useWriteContract,
  useReadContract, useBalance,
} from "wagmi";
import { formatUnits, parseUnits } from "viem";
import { base } from "wagmi/chains";
import { ERC20_ABI } from "@/lib/yield-execution";
import { DATA_SUFFIX } from "@/constants/builderCode";
import { useLang } from "@/lib/i18n/context";
import { QRCodeSVG } from "qrcode.react";

const ACCENT = "#F59E0B";

// Pay-side tokens for the in-page swap (Base mainnet). The launched token is the
// other leg — added dynamically per-card.
const NATIVE_ETH = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
type PayToken = { sym: string; addr: string; decimals: number; native?: boolean };
const PAY_TOKENS: PayToken[] = [
  { sym: "ETH",  addr: NATIVE_ETH, decimals: 18, native: true },
  { sym: "USDC", addr: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
];

// ── Types (mirror /api/launches) ───────────────────────────────────────────────

type Market = {
  priceUsd: number | null;
  marketCap: number | null;
  volume24h: number | null;
  liquidityUsd: number | null;
  change24h: number | null;
};
type Launch = {
  tokenAddress: string;
  tokenName: string;
  tokenSymbol: string;
  image?: string | null;
  website?: string | null;
  description?: string | null;
  feeRecipient: { type: string; value: string };
  txHash?: string | null;
  launchedAt: number;
  market: Market | null;
  /** Which chain this token was deployed on. Absent = "base" (legacy records
   *  predate Robinhood Chain support). */
  chain?: "base" | "robinhood";
  /** EVM chain id — 4663 (Robinhood mainnet) or 46630 (Robinhood testnet) for
   *  chain === "robinhood" records; absent/8453 for Base. */
  chainId?: number;
};
type FeedResponse = {
  ok: boolean;
  count: number;
  stats: { tracked: number; totalMarketCap: number; totalVolume24h: number };
  launches: Launch[];
};

// ── Formatters ─────────────────────────────────────────────────────────────────

function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1_000_000_000) return "$" + (n / 1_000_000_000).toFixed(2) + "B";
  if (n >= 1_000_000) return "$" + (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return "$" + (n / 1_000).toFixed(1) + "K";
  if (n >= 1) return "$" + n.toFixed(2);
  return "$" + n.toFixed(4);
}
function fmtPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1) return "$" + n.toFixed(3);
  if (n >= 0.0001) return "$" + n.toFixed(6);
  return "$" + n.toExponential(2);
}
function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return (n >= 0 ? "+" : "") + n.toFixed(1) + "%";
}
function fmtAge(ts: number): string {
  const s = Math.max(0, Date.now() - ts) / 1000;
  if (s < 60) return Math.floor(s) + "s";
  if (s < 3600) return Math.floor(s / 60) + "m";
  if (s < 86400) return Math.floor(s / 3600) + "h";
  return Math.floor(s / 86400) + "d";
}
function truncAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

// A6 — Creator label helper
function fmtCreator(fee: { type: string; value: string }): string {
  if (fee.type === "x") return "@" + fee.value;
  return truncAddr(fee.value);
}

// A8 — Mini sparkline SVG (5-point simulated from change24h)
function Sparkline({ price, change24h }: { price: number; change24h: number | null }) {
  if (price <= 0 || change24h == null) return null;
  // Simulate 5 points: start at price/(1+change/100), end at price
  const end = price;
  const start = price / (1 + change24h / 100);
  // Interpolate with a slight curve in the middle
  const pts = [
    start,
    start + (end - start) * 0.15 + (end - start) * 0.05 * Math.sin(0.5),
    start + (end - start) * 0.4 + (end - start) * 0.08 * Math.sin(1.2),
    start + (end - start) * 0.75 + (end - start) * 0.04 * Math.sin(2.0),
    end,
  ];
  const minPt = Math.min(...pts);
  const maxPt = Math.max(...pts);
  const range = maxPt - minPt || 1;
  const W = 64;
  const H = 20;
  const coords = pts.map((v, i) => {
    const x = (i / (pts.length - 1)) * W;
    const y = H - ((v - minPt) / range) * H;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const polyline = coords.join(" ");
  const color = change24h >= 0 ? "#22C55E" : "#EF4444";
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="shrink-0">
      <polyline
        points={polyline}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        opacity="0.8"
      />
    </svg>
  );
}

// A5 — Hot badge
function HotBadge() {
  return (
    <span
      className="absolute top-2.5 right-2.5 font-mono text-[9px] font-bold px-1.5 py-0.5 rounded-md"
      style={{ background: "#F59E0B20", color: "#F59E0B", border: "1px solid #F59E0B40" }}
    >
      🔥 HOT
    </span>
  );
}

// ── In-app Trade button + swap modal ────────────────────────────────────────────
// Opens a Uniswap-style Buy/Sell swap modal IN the Launches page (no redirect).
// The user swaps their own connected wallet (non-custodial) via the 0x Swap API
// (/api/swap/quote) — they approve (for token sells) and sign from their wallet.
// Base mainnet only. Honest: no fake "Limit" orders (no infra) — Buy/Sell only.

function TradeButton({ l, compact, onTrade }: { l: Launch; compact?: boolean; onTrade: (l: Launch) => void }) {
  // Both chains route through the same onTrade callback — the modal itself
  // splits by chain: Base uses the 0x Swap API, Robinhood uses the custom
  // RobinhoodSwapRouter (see /api/robinhood/swap/quote + swap-prepare). Robinhood
  // direct-deploy ERC-20s often ship without a pool; the modal detects that
  // upfront and shows an honest "No pool yet" state instead of pretending.
  const isRobinhood = l.chain === "robinhood";
  return (
    <button
      onClick={() => onTrade(l)}
      title={isRobinhood ? "Swap on Robinhood Chain" : "Swap on Base"}
      className={compact
        ? "px-2 py-0.5 rounded border text-[9px] transition-colors hover:opacity-90"
        : "font-mono text-[10px] px-2 py-1 rounded-lg border transition-colors hover:opacity-90"}
      style={{ borderColor: `${ACCENT}30`, color: ACCENT }}
    >
      Trade →
    </button>
  );
}

type SwapQuote = {
  needsKey?: boolean; error?: string;
  buyAmount?: string; minBuyAmount?: string;
  transaction?: { to: `0x${string}`; data: `0x${string}`; value?: string };
  issues?: { allowance?: { spender: `0x${string}` } | null };
};

function fmtNum(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

function TradeModal({ l, onClose }: { l: Launch; onClose: () => void }) {
  const { address, isConnected } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const { sendTransactionAsync } = useSendTransaction();

  const tokenSym = (l.tokenSymbol || l.tokenName || "TOKEN").replace(/^\$/, "");

  const [mode, setMode] = useState<"buy" | "sell">("buy");
  const [pay, setPay] = useState<PayToken>(PAY_TOKENS[0]); // ETH
  const [amount, setAmount] = useState("");
  const [quote, setQuote] = useState<SwapQuote | null>(null);
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState<"idle" | "approving" | "swapping" | "done" | "error">("idle");
  const [err, setErr] = useState("");
  const [txHash, setTxHash] = useState("");

  // ⚠️ READ ON-CHAIN. This was `const tokenDecimals = 18` with a comment saying
  // "the 0x quote works in base units, so this only affects display". That was
  // WRONG, and wrong on the money path: `sell.decimals` feeds `parseUnits()` in
  // TWO places that become calldata — `sellBase` (the 0x quote's sellAmount,
  // which determines transaction.data) and the `approve()` args below. On a 6-dec
  // token a typed "100" would encode 1e20 instead of 1e8: a 10^12 error.
  //
  // Nothing in a LaunchRecord can be trusted to supply this — the type has NO
  // `decimals` field, and its two live writers can't add one: /api/b20hub/register
  // is unauthenticated and takes the address straight from the client, and
  // /api/robinhood/prepare accepts a caller-supplied `decimals` that
  // /api/robinhood/receipt then drops on the floor. The token contract is the
  // only source that cannot drift.
  //
  // `undefined` while loading or if the call reverts — NEVER silently 18. A
  // wrong scale is worse than a disabled button, so the UI gates on this below
  // rather than guessing (CLAUDE.md: missing data → "unknown", never infer).
  const { data: tokenDecRaw, isLoading: decLoading, isError: decError } = useReadContract({
    address: l.tokenAddress as `0x${string}`, abi: ERC20_ABI, functionName: "decimals",
    chainId: base.id,
  });
  const tokenDecimals = tokenDecRaw !== undefined ? Number(tokenDecRaw) : undefined;

  // Resolve the sell / buy legs from the Buy|Sell mode.
  // Buy  → spend `pay` token, receive the launched token.
  // Sell → spend the launched token, receive `pay` token.
  const sell = mode === "buy"
    ? { sym: pay.sym, addr: pay.addr, decimals: pay.decimals, native: !!pay.native }
    : { sym: tokenSym, addr: l.tokenAddress, decimals: tokenDecimals, native: false };
  const buy = mode === "buy"
    ? { sym: tokenSym, addr: l.tokenAddress, decimals: tokenDecimals, native: false }
    : { sym: pay.sym, addr: pay.addr, decimals: pay.decimals, native: !!pay.native };

  // Balance of the sell leg.
  const { data: nativeBal } = useBalance({
    address, chainId: base.id, query: { enabled: !!address && !!sell.native },
  });
  const { data: erc20Bal } = useReadContract({
    address: sell.addr as `0x${string}`, abi: ERC20_ABI, functionName: "balanceOf",
    args: address ? [address] : undefined, chainId: base.id,
    query: { enabled: !!address && !sell.native },
  });
  const balance = sell.native
    ? (nativeBal ? Number(formatUnits(nativeBal.value, 18)) : null)
    : (erc20Bal != null && sell.decimals !== undefined
        ? Number(formatUnits(erc20Bal as bigint, sell.decimals)) : null);

  const amt = parseFloat(amount);
  // No scale → no base-unit amount → no quote → no swap. The `undefined` guard
  // is the whole point: an unknown decimals must never fall through to 18.
  const sellBase = amount && amt > 0 && sell.decimals !== undefined
    ? (() => { try { return parseUnits(amount, sell.decimals!).toString(); } catch { return ""; } })()
    : "";
  const overBalance = balance != null && amt > balance;

  // Debounced 0x quote.
  const reqId = useRef(0);
  useEffect(() => {
    if (!sellBase || sell.addr.toLowerCase() === buy.addr.toLowerCase()) { setQuote(null); return; }
    const id = ++reqId.current;
    setLoading(true);
    const t = setTimeout(() => {
      const qs = new URLSearchParams({ sellToken: sell.addr, buyToken: buy.addr, sellAmount: sellBase, ...(address ? { taker: address } : {}) });
      fetch(`/api/swap/quote?${qs}`).then(r => r.json()).then((j: SwapQuote) => {
        if (id !== reqId.current) return;
        setQuote(j); setLoading(false);
      }).catch(() => { if (id === reqId.current) { setQuote({ error: "quote failed" }); setLoading(false); } });
    }, 450);
    return () => clearTimeout(t);
  }, [sellBase, sell.addr, buy.addr, address]);

  const buyAmount = quote?.buyAmount && buy.decimals !== undefined
    ? Number(formatUnits(BigInt(quote.buyAmount), buy.decimals)) : null;
  const minBuy = quote?.minBuyAmount && buy.decimals !== undefined
    ? Number(formatUnits(BigInt(quote.minBuyAmount), buy.decimals)) : null;
  const rate = buyAmount != null && amt > 0 ? buyAmount / amt : null;

  function switchMode(m: "buy" | "sell") { if (m === mode) return; setMode(m); setAmount(""); setQuote(null); setStep("idle"); setErr(""); }
  function setMax() {
    if (balance == null) return;
    setAmount(String(sell.native ? Math.max(0, balance - 0.00005) : balance));
  }

  // `tokenDecimals !== undefined` is a HARD precondition, not a nicety — every
  // parseUnits below turns a typed amount into calldata.
  const canSwap = !!address && !!quote?.transaction && amt > 0 && !overBalance
    && !loading && tokenDecimals !== undefined;
  const busy = step === "approving" || step === "swapping";

  async function doSwap() {
    if (!address) { setErr("Connect your wallet"); setStep("error"); return; }
    if (quote?.needsKey) { setErr("Swap needs a 0x API key (ZEROX_API_KEY)"); setStep("error"); return; }
    if (!quote?.transaction) { setErr(quote?.error || "No route for this pair"); setStep("error"); return; }
    // Belt-and-braces: canSwap already gates on this, but doSwap is what signs,
    // so it re-checks rather than trusting a prop upstream of it.
    if (sell.decimals === undefined || buy.decimals === undefined) {
      setErr("Could not read this token's decimals — refusing to build a transaction");
      setStep("error"); return;
    }
    setErr(""); setTxHash("");
    try {
      await switchChainAsync({ chainId: base.id });
      // ERC-20 sells need an allowance to the 0x AllowanceHolder first.
      if (!sell.native && quote.issues?.allowance?.spender) {
        setStep("approving");
        await writeContractAsync({
          address: sell.addr as `0x${string}`, abi: ERC20_ABI, functionName: "approve",
          args: [quote.issues.allowance.spender, parseUnits(amount, sell.decimals)], chainId: base.id,
        });
      }
      setStep("swapping");
      const hash = await sendTransactionAsync({
        to: quote.transaction.to,
        // Append the ERC-8021 builder-code suffix so the tx is credited to BlueAgent.
        data: (quote.transaction.data + DATA_SUFFIX.slice(2)) as `0x${string}`,
        value: quote.transaction.value ? BigInt(quote.transaction.value) : undefined,
        chainId: base.id,
      });
      setTxHash(hash); setStep("done");
    } catch (e) {
      const m = (e as Error).message || String(e);
      const cancelled = /user rejected|denied|cancell?ed/i.test(m);
      setErr(cancelled ? "Swap cancelled." : m.slice(0, 160)); setStep("error");
    }
  }

  const tokenLogo = l.image
    ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={l.image} alt={tokenSym} className="w-8 h-8 rounded-lg object-cover bg-[#0d0d12] shrink-0"
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
      )
    : (
        <div className="w-8 h-8 rounded-lg flex items-center justify-center font-mono text-[11px] font-bold shrink-0"
          style={{ background: `${ACCENT}15`, border: `1px solid ${ACCENT}30`, color: ACCENT }}>
          {tokenSym.slice(0, 2).toUpperCase()}
        </div>
      );

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={busy ? undefined : onClose} />
      <div className="relative w-full max-w-sm rounded-2xl border border-[#1A1A2E] bg-[#0a0a0f] p-5 max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center gap-2.5 mb-4">
          {tokenLogo}
          <div className="min-w-0 flex-1">
            <div className="font-mono text-sm font-bold text-white truncate">{l.tokenName || tokenSym}</div>
            <div className="font-mono text-[11px] text-slate-500">${tokenSym} · {fmtPrice(l.market?.priceUsd)}</div>
          </div>
          <button onClick={onClose} disabled={busy}
            className="font-mono text-slate-600 hover:text-white text-xl leading-none disabled:opacity-40">×</button>
        </div>

        {step === "done" ? (
          <div className="rounded-xl border p-4" style={{ borderColor: "#22C55E40", background: "#22C55E08" }}>
            <div className="font-mono text-[12px] font-bold mb-1" style={{ color: "#22C55E" }}>
              ✓ {mode === "buy" ? "Bought" : "Sold"} {fmtNum(amt)} {sell.sym} → {buyAmount != null ? fmtNum(buyAmount) : ""} {buy.sym}
            </div>
            {txHash && (
              <a href={`https://basescan.org/tx/${txHash}`} target="_blank" rel="noopener noreferrer"
                className="font-mono text-[10px] px-2.5 py-1 rounded-lg border border-[#4FC3F730] text-[#4FC3F7] inline-block mt-1">View tx ↗</a>
            )}
            <button onClick={() => { setStep("idle"); setAmount(""); setQuote(null); }}
              className="font-mono text-[10px] text-slate-500 hover:text-slate-300 ml-3">Swap again</button>
          </div>
        ) : (
          <>
            {/* Buy / Sell tabs */}
            <div className="flex items-center rounded-lg border border-[#1A1A2E] overflow-hidden mb-3">
              {(["buy", "sell"] as const).map((m) => (
                <button key={m} onClick={() => switchMode(m)}
                  className="flex-1 font-mono text-[11px] font-bold py-2 transition-colors"
                  style={{
                    background: mode === m ? (m === "buy" ? "#22C55E15" : "#EF444415") : "transparent",
                    color: mode === m ? (m === "buy" ? "#22C55E" : "#EF4444") : "#64748b",
                  }}>
                  {m === "buy" ? "Buy" : "Sell"}
                </button>
              ))}
            </div>

            {/* Sell (you pay) */}
            <div className="rounded-lg border border-[#1A1A2E] bg-[#050508] p-2.5 mb-1">
              <div className="flex items-center justify-between mb-1">
                <span className="font-mono text-[9px] text-slate-600">YOU PAY</span>
                {balance != null && (
                  <span className="font-mono text-[9px] text-slate-600">Bal {balance.toFixed(sell.decimals === 6 ? 2 : 5)}
                    <button type="button" onClick={setMax} className="text-[#4FC3F7] ml-1">Max</button></span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <input type="number" min="0" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.0"
                  className="flex-1 bg-transparent font-mono text-[16px] text-white outline-none placeholder:text-slate-700 w-0" />
                {mode === "buy" ? (
                  <select value={pay.sym} onChange={e => { setPay(PAY_TOKENS.find(p => p.sym === e.target.value)!); setAmount(""); setQuote(null); }}
                    className="bg-[#050508] border border-[#1A1A2E] rounded-lg px-2 py-1.5 font-mono text-[11px] text-slate-200 outline-none">
                    {PAY_TOKENS.map(p => <option key={p.sym} value={p.sym}>{p.sym}</option>)}
                  </select>
                ) : (
                  <span className="font-mono text-[11px] text-slate-200 px-2 py-1.5 border border-[#1A1A2E] rounded-lg">{tokenSym}</span>
                )}
              </div>
              {overBalance && <div className="font-mono text-[9px] text-red-500 mt-1">Exceeds your {sell.sym} balance</div>}
            </div>

            <div className="flex justify-center -my-1 relative z-10">
              <div className="w-7 h-7 rounded-lg border border-[#1A1A2E] bg-[#0d0d12] text-slate-500 font-mono text-[12px] flex items-center justify-center">↓</div>
            </div>

            {/* Buy (you receive) */}
            <div className="rounded-lg border border-[#1A1A2E] bg-[#050508] p-2.5 mt-1 mb-3">
              <div className="font-mono text-[9px] text-slate-600 mb-1">YOU RECEIVE</div>
              <div className="flex items-center gap-2">
                <div className="flex-1 font-mono text-[16px] text-white w-0 truncate">
                  {loading ? <span className="text-slate-600">…</span> : buyAmount != null ? fmtNum(buyAmount) : <span className="text-slate-700">0.0</span>}
                </div>
                {mode === "sell" ? (
                  <select value={pay.sym} onChange={e => { setPay(PAY_TOKENS.find(p => p.sym === e.target.value)!); setAmount(""); setQuote(null); }}
                    className="bg-[#050508] border border-[#1A1A2E] rounded-lg px-2 py-1.5 font-mono text-[11px] text-slate-200 outline-none">
                    {PAY_TOKENS.map(p => <option key={p.sym} value={p.sym}>{p.sym}</option>)}
                  </select>
                ) : (
                  <span className="font-mono text-[11px] text-slate-200 px-2 py-1.5 border border-[#1A1A2E] rounded-lg">{tokenSym}</span>
                )}
              </div>
            </div>

            {rate != null && (
              <div className="font-mono text-[9px] text-slate-500 mb-2 flex items-center justify-between">
                <span>1 {sell.sym} ≈ {fmtNum(rate)} {buy.sym}</span>
                {minBuy != null && <span className="text-slate-600">min {fmtNum(minBuy)} {buy.sym}</span>}
              </div>
            )}

            {quote?.needsKey && <p className="font-mono text-[9px] text-amber-400 mb-2">Swap needs a free 0x API key — set <span className="text-slate-300">ZEROX_API_KEY</span>.</p>}
            {quote?.error && !quote.needsKey && !loading && amt > 0 && <p className="font-mono text-[9px] text-amber-400 mb-2">No route: {quote.error}</p>}
            {step === "error" && <p className="font-mono text-[10px] text-amber-400 mb-2">{err}</p>}
            {decError && (
              <p className="font-mono text-[9px] text-amber-400 mb-2">
                Couldn&apos;t read <span className="text-slate-300">decimals()</span> on this
                contract — trading is disabled rather than guessing the token&apos;s scale.
              </p>
            )}

            <button onClick={doSwap} disabled={!canSwap || busy}
              className="w-full font-mono text-[12px] font-bold py-2.5 rounded-lg transition-all disabled:opacity-50"
              style={mode === "buy"
                ? { background: "#22C55E15", color: "#22C55E", border: "1px solid #22C55E40" }
                : { background: "#EF444415", color: "#EF4444", border: "1px solid #EF444440" }}>
              {!isConnected ? "Connect your wallet"
                : decError ? "Token decimals unavailable"
                : decLoading ? "Reading token decimals…"
                : busy ? (step === "approving" ? "Approve in wallet…" : "Confirm in wallet…")
                : overBalance ? "Insufficient balance"
                : mode === "buy"
                  ? `Buy ${tokenSym}${amt > 0 ? ` with ${fmtNum(amt)} ${sell.sym}` : ""}`
                  : `Sell ${amt > 0 ? fmtNum(amt) : ""} ${tokenSym}`}
            </button>
            <p className="font-mono text-[9px] text-slate-700 mt-1.5 text-center">Best route via 0x · you sign · non-custodial · Base mainnet.</p>
          </>
        )}
      </div>
    </div>
  );
}

// ── Robinhood Chain trade modal ────────────────────────────────────────────────
// Uses BlueAgent's own RobinhoodSwapRouter (0x3bb0…d23D on chainId 4663). Router
// is immutable, non-custodial, holds no funds between txs. Every hop goes
// through the user's own wallet:
//   1. GET /api/robinhood/swap/quote → detect pool (probe all 4 V3 fee tiers)
//      + fetch a display-only amountOut estimate from GeckoTerminal.
//   2. If sell direction, send an ERC-20 approve(router, amountIn) tx.
//   3. POST /api/robinhood/router/swap-prepare → get calldata for the router.
//   4. Send the swap tx from the user's wallet, honoring the amountOutMinimum
//      slippage floor computed from the estimate. On-chain math wins if the
//      GeckoTerminal estimate was off — the router either fills within the
//      floor or reverts, never at a bad price.
//
// If no pool exists on any tier the modal shows an honest "No trading pool
// yet" state (no fake numbers, no fallback to a wrong tier). The deployer has
// to seed a Uniswap V3 pool separately before this token becomes tradeable.

const RH_ROUTER = "0x3bb0e9E3dB75faDC5f1f8b7D7B9D761Ef15cd23D" as const;
const RH_EXPLORER = "https://robinhoodchain.blockscout.com";
const RH_CHAIN_ID = 4663;

type RhQuote = {
  ok?: boolean;
  hasPool?: boolean;
  note?: string;
  pool?: { address: `0x${string}`; fee: 100 | 500 | 3000 | 10000; liquidity: string; token0: `0x${string}`; token1: `0x${string}` };
  price?: { tokenUsd: number | null; ethUsd: number | null };
  estimate?: { amountIn: number; direction: "buy" | "sell"; amountOut: number | null };
  error?: string;
};

function RobinhoodTradeModal({ l, onClose }: { l: Launch; onClose: () => void }) {
  const { address, isConnected } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { sendTransactionAsync } = useSendTransaction();
  const { data: nativeBal } = useBalance({
    address, chainId: RH_CHAIN_ID, query: { enabled: !!address },
  });
  const { data: tokenBal } = useReadContract({
    address: l.tokenAddress as `0x${string}`, abi: ERC20_ABI, functionName: "balanceOf",
    args: address ? [address] : undefined, chainId: RH_CHAIN_ID,
    query: { enabled: !!address },
  });

  const tokenSym = (l.tokenSymbol || l.tokenName || "TOKEN").replace(/^\$/, "");

  // ⚠️ READ ON-CHAIN — was `const tokenDecimals = 18` justified by "Robinhood
  // direct-deploy launches use 18d ERC-20s". 18 is only the DEFAULT:
  // /api/robinhood/prepare takes `decimals` from the request body, so a caller
  // can deploy any scale, and /api/robinhood/receipt then writes the launch
  // record WITHOUT it (LaunchRecord has no such field). The assumption had no
  // enforcement behind it, and it feeds parseUnits() for both `amountInWei` and
  // `minOutBase` in doSwap — i.e. real swap calldata, not display.
  const { data: rhDecRaw, isLoading: decLoading, isError: decError } = useReadContract({
    address: l.tokenAddress as `0x${string}`, abi: ERC20_ABI, functionName: "decimals",
    chainId: RH_CHAIN_ID,
  });
  const tokenDecimals = rhDecRaw !== undefined ? Number(rhDecRaw) : undefined;

  const [mode, setMode] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [slippagePct, setSlippagePct] = useState(3); // 3% default — honest, editable.
  const [quote, setQuote] = useState<RhQuote | null>(null);
  const [loadingQuote, setLoadingQuote] = useState(false);
  const [step, setStep] = useState<"idle" | "approving" | "swapping" | "done" | "error">("idle");
  const [err, setErr] = useState("");
  const [txHash, setTxHash] = useState("");

  const nativeBalance = nativeBal ? Number(formatUnits(nativeBal.value, 18)) : null;
  const erc20Balance = tokenBal != null && tokenDecimals !== undefined
    ? Number(formatUnits(tokenBal as bigint, tokenDecimals)) : null;
  const sellBalance = mode === "buy" ? nativeBalance : erc20Balance;
  const amt = parseFloat(amount);
  const overBalance = sellBalance != null && amt > sellBalance;

  // Debounced quote fetch (server-side pool discovery + GeckoTerminal price).
  const reqId = useRef(0);
  useEffect(() => {
    if (!amount || !Number.isFinite(amt) || amt <= 0) { setQuote(null); return; }
    const id = ++reqId.current;
    setLoadingQuote(true);
    const t = setTimeout(() => {
      const qs = new URLSearchParams({ token: l.tokenAddress, direction: mode, amount: String(amt) });
      fetch(`/api/robinhood/swap/quote?${qs}`)
        .then(r => r.json())
        .then((j: RhQuote) => { if (id === reqId.current) { setQuote(j); setLoadingQuote(false); } })
        .catch(() => { if (id === reqId.current) { setQuote({ error: "quote failed" }); setLoadingQuote(false); } });
    }, 450);
    return () => clearTimeout(t);
  }, [amount, amt, mode, l.tokenAddress]);

  function switchMode(m: "buy" | "sell") { if (m === mode) return; setMode(m); setAmount(""); setQuote(null); setStep("idle"); setErr(""); }
  function setMax() {
    if (sellBalance == null) return;
    // Reserve some gas headroom on native ETH.
    setAmount(String(mode === "buy" ? Math.max(0, sellBalance - 0.00005) : sellBalance));
  }

  const hasPool = quote?.ok && quote?.hasPool;
  const estimatedOut = quote?.estimate?.amountOut ?? null;
  const inSym = mode === "buy" ? "ETH" : tokenSym;
  const outSym = mode === "buy" ? tokenSym : "ETH";
  const rate = estimatedOut != null && amt > 0 ? estimatedOut / amt : null;
  const minOut = estimatedOut != null ? estimatedOut * (1 - slippagePct / 100) : null;

  // tokenDecimals is a hard precondition — it feeds parseUnits() into calldata.
  const canSwap = !!address && hasPool && amt > 0 && !overBalance && !loadingQuote
    && tokenDecimals !== undefined && step !== "approving" && step !== "swapping";
  const busy = step === "approving" || step === "swapping";

  async function doSwap() {
    if (!address) { setErr("Connect your wallet"); setStep("error"); return; }
    if (!hasPool || !quote?.pool) { setErr("No pool available for this token"); setStep("error"); return; }
    if (!amt || amt <= 0) { setErr("Enter an amount"); setStep("error"); return; }
    // doSwap is what signs, so it re-checks the scale rather than trusting canSwap.
    if (tokenDecimals === undefined) {
      setErr("Could not read this token's decimals — refusing to build a transaction");
      setStep("error"); return;
    }
    setErr(""); setTxHash("");
    try {
      // Wallet may be on a different chain — prompt to switch.
      try { await switchChainAsync({ chainId: RH_CHAIN_ID }); } catch {
        throw new Error("Switch your wallet to Robinhood Chain (4663) and try again");
      }

      // Compute base-unit amounts + slippage floor.
      const amountInWei = mode === "buy"
        ? parseUnits(amount, 18)          // ETH → wei
        : parseUnits(amount, tokenDecimals); // token → base units
      const minOutBase = minOut != null
        ? parseUnits(minOut.toFixed(mode === "buy" ? tokenDecimals : 18), mode === "buy" ? tokenDecimals : 18)
        : 0n;

      // Ask the server for calldata (also returns approve calldata for sells).
      const prepRes = await fetch("/api/robinhood/router/swap-prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          router: RH_ROUTER,
          direction: mode,
          token: l.tokenAddress,
          fee: quote.pool.fee,
          amountIn: amountInWei.toString(),
          amountOutMinimum: minOutBase.toString(),
          recipient: address,
        }),
      });
      const prep = await prepRes.json();
      if (!prep.ok) throw new Error(prep.error || "Prepare failed");

      if (prep.approve) {
        setStep("approving");
        await sendTransactionAsync({
          to: prep.approve.to as `0x${string}`,
          data: prep.approve.data as `0x${string}`,
          value: 0n,
          chainId: RH_CHAIN_ID,
        });
      }

      setStep("swapping");
      const hash = await sendTransactionAsync({
        to: prep.swap.to as `0x${string}`,
        data: prep.swap.data as `0x${string}`,
        value: BigInt(prep.swap.value),
        chainId: RH_CHAIN_ID,
      });
      setTxHash(hash);
      setStep("done");
    } catch (e) {
      const m = (e as Error).message || String(e);
      const cancelled = /user rejected|denied|cancell?ed/i.test(m);
      setErr(cancelled ? "Swap cancelled." : m.slice(0, 200));
      setStep("error");
    }
  }

  const tokenLogo = l.image
    ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={l.image} alt={tokenSym} className="w-8 h-8 rounded-lg object-cover bg-[#0d0d12] shrink-0"
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
      )
    : (
        <div className="w-8 h-8 rounded-lg flex items-center justify-center font-mono text-[11px] font-bold shrink-0"
          style={{ background: `${ACCENT}15`, border: `1px solid ${ACCENT}30`, color: ACCENT }}>
          {tokenSym.slice(0, 2).toUpperCase()}
        </div>
      );

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={busy ? undefined : onClose} />
      <div className="relative w-full max-w-sm rounded-2xl border border-[#1A1A2E] bg-[#0a0a0f] p-5 max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center gap-2.5 mb-4">
          {tokenLogo}
          <div className="min-w-0 flex-1">
            <div className="font-mono text-sm font-bold text-white truncate">{l.tokenName || tokenSym}</div>
            <div className="font-mono text-[11px] text-slate-500">${tokenSym} · Robinhood Chain</div>
          </div>
          <button onClick={onClose} disabled={busy}
            className="font-mono text-slate-600 hover:text-white text-xl leading-none disabled:opacity-40">×</button>
        </div>

        {step === "done" ? (
          <div className="rounded-xl border p-4" style={{ borderColor: "#22C55E40", background: "#22C55E08" }}>
            <div className="font-mono text-[12px] font-bold mb-1" style={{ color: "#22C55E" }}>
              ✓ Swap sent to Robinhood Chain
            </div>
            {txHash && (
              <a href={`${RH_EXPLORER}/tx/${txHash}`} target="_blank" rel="noopener noreferrer"
                className="font-mono text-[10px] px-2.5 py-1 rounded-lg border border-[#4FC3F730] text-[#4FC3F7] inline-block mt-1">View tx ↗</a>
            )}
            <button onClick={() => { setStep("idle"); setAmount(""); setQuote(null); setTxHash(""); }}
              className="font-mono text-[10px] text-slate-500 hover:text-slate-300 ml-3">Swap again</button>
          </div>
        ) : (
          <>
            {/* Buy / Sell tabs */}
            <div className="flex items-center rounded-lg border border-[#1A1A2E] overflow-hidden mb-3">
              {(["buy", "sell"] as const).map((m) => (
                <button key={m} onClick={() => switchMode(m)}
                  className="flex-1 font-mono text-[11px] font-bold py-2 transition-colors"
                  style={{
                    background: mode === m ? (m === "buy" ? "#22C55E15" : "#EF444415") : "transparent",
                    color: mode === m ? (m === "buy" ? "#22C55E" : "#EF4444") : "#64748b",
                  }}>
                  {m === "buy" ? "Buy" : "Sell"}
                </button>
              ))}
            </div>

            {/* You pay */}
            <div className="rounded-lg border border-[#1A1A2E] bg-[#050508] p-2.5 mb-1">
              <div className="flex items-center justify-between mb-1">
                <span className="font-mono text-[9px] text-slate-600">YOU PAY</span>
                {sellBalance != null && (
                  <span className="font-mono text-[9px] text-slate-600">
                    Bal {sellBalance.toFixed(5)}
                    <button type="button" onClick={setMax} className="text-[#4FC3F7] ml-1">Max</button>
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <input type="number" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.0"
                  className="flex-1 bg-transparent font-mono text-[16px] text-white outline-none placeholder:text-slate-700 w-0" />
                <span className="font-mono text-[11px] text-slate-200 px-2 py-1.5 border border-[#1A1A2E] rounded-lg">{inSym}</span>
              </div>
              {overBalance && <div className="font-mono text-[9px] text-red-500 mt-1">Exceeds your {inSym} balance</div>}
            </div>

            <div className="flex justify-center -my-1 relative z-10">
              <div className="w-7 h-7 rounded-lg border border-[#1A1A2E] bg-[#0d0d12] text-slate-500 font-mono text-[12px] flex items-center justify-center">↓</div>
            </div>

            {/* You receive */}
            <div className="rounded-lg border border-[#1A1A2E] bg-[#050508] p-2.5 mt-1 mb-3">
              <div className="font-mono text-[9px] text-slate-600 mb-1">YOU RECEIVE (est.)</div>
              <div className="flex items-center gap-2">
                <div className="flex-1 font-mono text-[16px] text-white w-0 truncate">
                  {loadingQuote ? <span className="text-slate-600">…</span>
                    : estimatedOut != null ? fmtNum(estimatedOut)
                    : <span className="text-slate-700">0.0</span>}
                </div>
                <span className="font-mono text-[11px] text-slate-200 px-2 py-1.5 border border-[#1A1A2E] rounded-lg">{outSym}</span>
              </div>
            </div>

            {/* Rate + slippage */}
            {rate != null && (
              <div className="font-mono text-[9px] text-slate-500 mb-1 flex items-center justify-between">
                <span>1 {inSym} ≈ {fmtNum(rate)} {outSym}</span>
                {minOut != null && <span className="text-slate-600">min {fmtNum(minOut)} {outSym}</span>}
              </div>
            )}
            <div className="font-mono text-[9px] text-slate-600 mb-2 flex items-center justify-between">
              <span>Slippage</span>
              <span>
                {[1, 3, 5].map((p) => (
                  <button key={p} onClick={() => setSlippagePct(p)}
                    className="ml-1 px-1.5 py-0.5 rounded border transition-colors"
                    style={slippagePct === p
                      ? { background: `${ACCENT}20`, color: ACCENT, borderColor: `${ACCENT}40` }
                      : { color: "#64748b", borderColor: "#1A1A2E" }}>
                    {p}%
                  </button>
                ))}
              </span>
            </div>

            {/* Pool info */}
            {quote?.pool && (
              <div className="font-mono text-[9px] text-slate-600 mb-2">
                Pool <a href={`${RH_EXPLORER}/address/${quote.pool.address}`} target="_blank" rel="noopener noreferrer"
                  className="text-slate-400 hover:text-slate-200 underline">{quote.pool.address.slice(0, 6)}…{quote.pool.address.slice(-4)}</a>
                {" · "}fee {(quote.pool.fee / 10000).toFixed(2)}%
              </div>
            )}

            {/* States */}
            {loadingQuote && <p className="font-mono text-[9px] text-slate-600 mb-2">Checking pools + prices…</p>}
            {quote?.ok && quote.hasPool === false && (
              <p className="font-mono text-[10px] text-amber-400 mb-2">
                No Uniswap V3 pool for {tokenSym}/WETH exists on Robinhood Chain yet. The deployer needs to seed one before it becomes tradeable.
              </p>
            )}
            {quote?.error && <p className="font-mono text-[10px] text-amber-400 mb-2">Quote error: {quote.error}</p>}
            {step === "error" && <p className="font-mono text-[10px] text-amber-400 mb-2">{err}</p>}
            {decError && (
              <p className="font-mono text-[9px] text-amber-400 mb-2">
                Couldn&apos;t read <span className="text-slate-300">decimals()</span> on this
                contract — trading is disabled rather than guessing the token&apos;s scale.
              </p>
            )}

            <button onClick={doSwap} disabled={!canSwap || busy}
              className="w-full font-mono text-[12px] font-bold py-2.5 rounded-lg transition-all disabled:opacity-50"
              style={mode === "buy"
                ? { background: "#22C55E15", color: "#22C55E", border: "1px solid #22C55E40" }
                : { background: "#EF444415", color: "#EF4444", border: "1px solid #EF444440" }}>
              {!isConnected ? "Connect your wallet"
                : decError ? "Token decimals unavailable"
                : decLoading ? "Reading token decimals…"
                : busy ? (step === "approving" ? "Approve in wallet…" : "Confirm in wallet…")
                : quote?.hasPool === false ? "No pool yet"
                : overBalance ? "Insufficient balance"
                : mode === "buy"
                  ? `Buy ${tokenSym}${amt > 0 ? ` with ${fmtNum(amt)} ETH` : ""}`
                  : `Sell ${amt > 0 ? fmtNum(amt) : ""} ${tokenSym}`}
            </button>
            <p className="font-mono text-[9px] text-slate-700 mt-1.5 text-center">Via RobinhoodSwapRouter · you sign · non-custodial · chainId 4663.</p>
          </>
        )}
      </div>
    </div>
  );
}

// ── Explore modal (Robinhood Chain only) ────────────────────────────────────────
// Read-only — no wallet interaction, no fund risk. Pulls real holders/transfers
// straight from Blockscout (robinhoodchain.blockscout.com), the same explorer
// the "Explorer ↗" link points at, so nothing here is fabricated.

type ExploreData = {
  ok: boolean;
  error?: string;
  network?: "mainnet" | "testnet";
  explorerUrl?: string;
  info?: { holders_count: string | null; total_supply: string | null; exchange_rate: string | null };
  holders?: { address: { hash: string; is_contract: boolean }; value: string }[];
  holdersCount?: number;
  transfers?: {
    block_number: number; timestamp: string;
    from: { hash: string }; to: { hash: string };
    total?: { value?: string };
  }[];
};

function ExploreModal({ l, onClose }: { l: Launch; onClose: () => void }) {
  const [data, setData] = useState<ExploreData | null>(null);
  const [loading, setLoading] = useState(true);
  const tokenSym = (l.tokenSymbol || l.tokenName || "TOKEN").replace(/^\$/, "");
  const network = l.chainId === 46630 ? "testnet" : "mainnet";

  useEffect(() => {
    setLoading(true);
    fetch(`/api/robinhood/explore?address=${l.tokenAddress}&network=${network}`)
      .then((r) => r.json())
      .then((d: ExploreData) => setData(d))
      .catch(() => setData({ ok: false, error: "Failed to load explorer data" }))
      .finally(() => setLoading(false));
  }, [l.tokenAddress, network]);

  function fmtSupply(raw: string | null | undefined): string {
    if (!raw) return "—";
    try { return Number(formatUnits(BigInt(raw), 18)).toLocaleString("en-US", { maximumFractionDigits: 0 }); }
    catch { return raw; }
  }
  function fmtAgo(ts: string): string {
    const s = Math.max(0, Date.now() - new Date(ts).getTime()) / 1000;
    if (s < 60) return Math.floor(s) + "s ago";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    return Math.floor(s / 86400) + "d ago";
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-sm rounded-2xl border border-[#1A1A2E] bg-[#0a0a0f] p-5 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center gap-2.5 mb-4">
          <div className="min-w-0 flex-1">
            <div className="font-mono text-sm font-bold text-white truncate">{l.tokenName || tokenSym} <span className="text-slate-600 text-[10px]">· ${tokenSym}</span></div>
            <div className="font-mono text-[10px] text-slate-500">Live data from Blockscout · {network === "testnet" ? "Robinhood Testnet" : "Robinhood Chain"}</div>
          </div>
          <button onClick={onClose} className="font-mono text-slate-600 hover:text-white text-xl leading-none">×</button>
        </div>

        {loading ? (
          <div className="font-mono text-[11px] text-slate-600 py-8 text-center">Loading…</div>
        ) : !data?.ok ? (
          <div className="font-mono text-[11px] text-amber-400 py-8 text-center">{data?.error || "No data yet — still indexing."}</div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2 font-mono mb-4">
              <div className="rounded-lg border border-[#1A1A2E] p-2.5">
                <div className="text-[8px] text-slate-600 tracking-widest mb-0.5">HOLDERS</div>
                <div className="text-[13px] text-slate-200">{data.holdersCount ?? "—"}</div>
              </div>
              <div className="rounded-lg border border-[#1A1A2E] p-2.5">
                <div className="text-[8px] text-slate-600 tracking-widest mb-0.5">TOTAL SUPPLY</div>
                <div className="text-[13px] text-slate-200">{fmtSupply(data.info?.total_supply)}</div>
              </div>
            </div>

            <div className="font-mono text-[9px] text-slate-600 tracking-widest mb-1.5">TOP HOLDERS</div>
            <div className="space-y-1 mb-4">
              {(data.holders ?? []).length === 0 && <div className="font-mono text-[10px] text-slate-700">None yet.</div>}
              {(data.holders ?? []).map((h, i) => (
                <div key={h.address.hash + i} className="flex items-center justify-between font-mono text-[10px] text-slate-400">
                  <span>{truncAddr(h.address.hash)}{h.address.is_contract ? " (contract)" : ""}</span>
                  <span className="text-slate-300">{fmtSupply(h.value)}</span>
                </div>
              ))}
            </div>

            <div className="font-mono text-[9px] text-slate-600 tracking-widest mb-1.5">RECENT TRANSFERS</div>
            <div className="space-y-1 mb-4">
              {(data.transfers ?? []).length === 0 && <div className="font-mono text-[10px] text-slate-700">No transfers yet.</div>}
              {(data.transfers ?? []).map((tr, i) => (
                <div key={i} className="flex items-center justify-between font-mono text-[10px] text-slate-400">
                  <span>{truncAddr(tr.from.hash)} → {truncAddr(tr.to.hash)}</span>
                  <span className="text-slate-600">{fmtAgo(tr.timestamp)}</span>
                </div>
              ))}
            </div>

            <a href={data.explorerUrl} target="_blank" rel="noopener noreferrer"
              className="block w-full text-center font-mono text-[10px] px-2 py-2 rounded-lg border border-[#1A1A2E] text-slate-400 hover:text-white transition-colors">
              View full history on Blockscout ↗
            </a>
          </>
        )}
      </div>
    </div>
  );
}

// ── Token card ─────────────────────────────────────────────────────────────────

function LaunchCard({ l, onTrade, onExplore }: { l: Launch; onTrade: (l: Launch) => void; onExplore: (l: Launch) => void }) {
  const [copied, setCopied] = useState(false);
  const sym = (l.tokenSymbol || l.tokenName || "?").replace(/^\$/, "");
  const change = l.market?.change24h;
  const changeColor = change == null ? "#64748b" : change >= 0 ? "#22C55E" : "#EF4444";
  const isHot = (l.market?.volume24h ?? 0) > 10000;

  function copyAddr() {
    navigator.clipboard?.writeText(l.tokenAddress).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  }

  return (
    <div className="card-surface card-hover rounded-2xl p-4 flex flex-col gap-3 relative">
      {/* A5 */}
      {isHot && <HotBadge />}

      {/* Header: logo + name + age */}
      <div className="flex items-center gap-3">
        {l.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={l.image} alt={sym} className="w-10 h-10 rounded-xl object-cover shrink-0 bg-[#0d0d12]"
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
        ) : (
          <div className="w-10 h-10 rounded-xl flex items-center justify-center font-mono text-sm font-bold shrink-0"
            style={{ background: `${ACCENT}15`, border: `1px solid ${ACCENT}30`, color: ACCENT }}>
            {sym.slice(0, 2).toUpperCase()}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="font-mono text-sm font-bold text-white truncate">{l.tokenName || sym}</div>
          <div className="font-mono text-[11px] text-slate-500 flex items-center gap-1.5">
            <span>${sym}</span>
            <ChainBadge chain={l.chain} />
          </div>
        </div>
        <div className="font-mono text-[9px] text-slate-600 shrink-0 pr-1">{fmtAge(l.launchedAt)} ago</div>
      </div>

      {/* A8 — Sparkline */}
      {l.market?.priceUsd != null && (
        <div className="flex justify-end">
          <Sparkline price={l.market.priceUsd} change24h={l.market.change24h} />
        </div>
      )}

      {/* Stats grid */}
      <div className="grid grid-cols-3 gap-2 font-mono">
        <div>
          <div className="text-[8px] text-slate-600 tracking-widest mb-0.5">PRICE</div>
          <div className="text-[11px] text-slate-200">{fmtPrice(l.market?.priceUsd)}</div>
        </div>
        <div>
          <div className="text-[8px] text-slate-600 tracking-widest mb-0.5">MCAP</div>
          <div className="text-[11px] text-slate-200">{fmtUsd(l.market?.marketCap)}</div>
        </div>
        <div>
          <div className="text-[8px] text-slate-600 tracking-widest mb-0.5">24H</div>
          <div className="text-[11px]" style={{ color: changeColor }}>{fmtPct(change)}</div>
        </div>
        <div>
          <div className="text-[8px] text-slate-600 tracking-widest mb-0.5">VOL 24H</div>
          <div className="text-[11px] text-slate-200">{fmtUsd(l.market?.volume24h)}</div>
        </div>
        <div>
          <div className="text-[8px] text-slate-600 tracking-widest mb-0.5">LIQ</div>
          <div className="text-[11px] text-slate-200">{fmtUsd(l.market?.liquidityUsd)}</div>
        </div>
        {/* A6 — Creator */}
        <div>
          <div className="text-[8px] text-slate-600 tracking-widest mb-0.5">CREATOR</div>
          <div className="text-[11px] text-slate-400 truncate">
            {fmtCreator(l.feeRecipient)}
          </div>
        </div>
      </div>

      {/* Address + copy */}
      <button onClick={copyAddr}
        className="flex items-center gap-1.5 font-mono text-[10px] text-slate-600 hover:text-slate-400 transition-colors self-start"
        title="Copy token address">
        <span>{truncAddr(l.tokenAddress)}</span>
        <span style={{ color: copied ? "#22C55E" : undefined }}>{copied ? "✓ copied" : "⧉"}</span>
      </button>

      {/* Links */}
      <div className="flex flex-wrap gap-1.5 pt-1 border-t border-[#1A1A2E]">
        <TradeButton l={l} onTrade={onTrade} />
        {/* Bankr URL differs by chain: Base launches (Doppler) live at
            /launches/<addr>; Robinhood launches (via Bankr's Robinhood
            integration) live at /terminal/discover/<addr>. Both are
            Bankr-hosted so the label is the same. */}
        <a
          href={l.chain === "robinhood"
            ? `https://bankr.bot/terminal/discover/${l.tokenAddress}`
            : `https://bankr.bot/launches/${l.tokenAddress}`}
          target="_blank" rel="noopener noreferrer"
          className="font-mono text-[10px] px-2 py-1 rounded-lg border border-[#4FC3F730] text-[#4FC3F7] transition-colors">
          Bankr ↗
        </a>
        {l.chain !== "robinhood" && (
          <a href={`https://basescan.org/token/${l.tokenAddress}`}
            target="_blank" rel="noopener noreferrer"
            className="font-mono text-[10px] px-2 py-1 rounded-lg border border-[#1A1A2E] text-slate-400 hover:text-white transition-colors">
            Basescan ↗
          </a>
        )}
        {l.website && (
          <a href={l.website} target="_blank" rel="noopener noreferrer"
            className="font-mono text-[10px] px-2 py-1 rounded-lg border border-[#1A1A2E] text-slate-400 hover:text-white transition-colors">
            Site ↗
          </a>
        )}
      </div>
    </div>
  );
}

// ── List row (A1) ──────────────────────────────────────────────────────────────

function LaunchRow({ l, onTrade, onExplore }: { l: Launch; onTrade: (l: Launch) => void; onExplore: (l: Launch) => void }) {
  const [copied, setCopied] = useState(false);
  const sym = (l.tokenSymbol || l.tokenName || "?").replace(/^\$/, "");
  const change = l.market?.change24h;
  const changeColor = change == null ? "#64748b" : change >= 0 ? "#22C55E" : "#EF4444";
  const isHot = (l.market?.volume24h ?? 0) > 10000;

  function copyAddr() {
    navigator.clipboard?.writeText(l.tokenAddress).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  }

  return (
    <div className="grid items-center gap-3 px-4 py-2.5 border-b border-[#1A1A2E] hover:bg-[#0d0d16] transition-colors font-mono text-[11px]"
      style={{ gridTemplateColumns: "180px 90px 100px 70px 100px 50px 1fr" }}>
      {/* Logo + Name */}
      <div className="flex items-center gap-2 min-w-0">
        {l.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={l.image} alt={sym} className="w-6 h-6 rounded-md object-cover shrink-0 bg-[#0d0d12]"
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
        ) : (
          <div className="w-6 h-6 rounded-md flex items-center justify-center text-[9px] font-bold shrink-0"
            style={{ background: `${ACCENT}15`, border: `1px solid ${ACCENT}30`, color: ACCENT }}>
            {sym.slice(0, 2).toUpperCase()}
          </div>
        )}
        <div className="min-w-0">
          <div className="text-white font-bold truncate text-[11px] flex items-center gap-1">
            {l.tokenName || sym}
            {isHot && <span style={{ color: ACCENT }}>🔥</span>}
          </div>
          <div className="text-slate-600 text-[9px]">${sym}</div>
        </div>
      </div>
      {/* Price */}
      <div className="text-slate-200 tabular-nums">{fmtPrice(l.market?.priceUsd)}</div>
      {/* MCAP */}
      <div className="text-slate-200 tabular-nums">{fmtUsd(l.market?.marketCap)}</div>
      {/* 24H% */}
      <div style={{ color: changeColor }} className="tabular-nums">{fmtPct(change)}</div>
      {/* Volume */}
      <div className="text-slate-200 tabular-nums">{fmtUsd(l.market?.volume24h)}</div>
      {/* Age */}
      <div className="text-slate-600 tabular-nums">{fmtAge(l.launchedAt)}</div>
      {/* Actions */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <TradeButton l={l} compact onTrade={onTrade} />
        <a
          href={l.chain === "robinhood"
            ? `https://bankr.bot/terminal/discover/${l.tokenAddress}`
            : `https://bankr.bot/launches/${l.tokenAddress}`}
          target="_blank" rel="noopener noreferrer"
          className="px-2 py-0.5 rounded border border-[#4FC3F730] text-[#4FC3F7] text-[9px] transition-colors">
          Bankr ↗
        </a>
        <button onClick={copyAddr}
          className="px-2 py-0.5 rounded border border-[#1A1A2E] text-[9px] text-slate-600 hover:text-slate-300 transition-colors">
          {copied ? "✓" : truncAddr(l.tokenAddress)}
        </button>
      </div>
    </div>
  );
}

// ── List header (A1) ──────────────────────────────────────────────────────────

function ListHeader({
  sort,
  onSort,
}: {
  sort: SortKey;
  onSort: (k: SortKey) => void;
}) {
  const col = (label: string, key: SortKey | null, style?: string) => (
    <div
      className={`font-mono text-[8px] tracking-widest text-slate-600 select-none ${key ? "cursor-pointer hover:text-slate-400 transition-colors" : ""} ${style ?? ""}`}
      onClick={key ? () => onSort(key) : undefined}
    >
      {label}
      {key && sort === key && <span className="ml-0.5" style={{ color: ACCENT }}>▼</span>}
    </div>
  );
  return (
    <div className="grid items-center gap-3 px-4 py-2 border-b border-[#1A1A2E] bg-[#07070b]"
      style={{ gridTemplateColumns: "180px 90px 100px 70px 100px 50px 1fr" }}>
      {col("NAME", null)}
      {col("PRICE", "price")}
      {col("MCAP", "mcap")}
      {col("24H%", "change")}
      {col("VOLUME", "volume")}
      {col("AGE", "age")}
      {col("ACTIONS", null)}
    </div>
  );
}

// ── Sort / Filter / Search types ───────────────────────────────────────────────

type SortKey = "newest" | "volume" | "mcap" | "change" | "price" | "age";
type FilterTab = "all" | "live" | "new" | "hot" | "mine";
type ViewMode = "grid" | "list";
type ChainFilter = "all" | "base" | "robinhood";

const CHAIN_TABS: { label: string; key: ChainFilter }[] = [
  { label: "All chains", key: "all" },
  { label: "Base", key: "base" },
  { label: "Robinhood Chain", key: "robinhood" },
];

function applyChainFilter(launches: Launch[], chain: ChainFilter): Launch[] {
  if (chain === "all") return launches;
  return launches.filter((l) => (l.chain ?? "base") === chain);
}

function ChainBadge({ chain }: { chain?: "base" | "robinhood" }) {
  const isRobinhood = chain === "robinhood";
  return (
    <span
      className="font-mono text-[8px] px-1.5 py-0.5 rounded-full border tracking-wide"
      style={
        isRobinhood
          ? { background: "#22C55E15", color: "#22C55E", borderColor: "#22C55E30" }
          : { background: "#4FC3F715", color: "#4FC3F7", borderColor: "#4FC3F730" }
      }
    >
      {isRobinhood ? "ROBINHOOD" : "BASE"}
    </span>
  );
}

const SORT_OPTIONS: { label: string; key: SortKey }[] = [
  { label: "Newest", key: "newest" },
  { label: "Volume", key: "volume" },
  { label: "MCAP", key: "mcap" },
  { label: "24H%", key: "change" },
];

const FILTER_TABS: { label: string; key: FilterTab; tkey: string }[] = [
  { label: "All", key: "all", tkey: "all" },
  { label: "Live", key: "live", tkey: "live" },
  { label: "New", key: "new", tkey: "new" },
  { label: "Hot 🔥", key: "hot", tkey: "hot" },
  { label: "My Tokens 👤", key: "mine", tkey: "my_tokens" },
];

function applyFilter(launches: Launch[], tab: FilterTab): Launch[] {
  switch (tab) {
    case "live":
      return launches.filter((l) => l.market?.priceUsd != null);
    case "new":
      return launches.filter((l) => l.launchedAt > Date.now() - 86400000);
    case "hot":
      return launches.filter((l) => (l.market?.volume24h ?? 0) > 10000);
    default:
      return launches;
  }
}

function applySort(launches: Launch[], key: SortKey): Launch[] {
  const copy = [...launches];
  switch (key) {
    case "newest":
      return copy.sort((a, b) => b.launchedAt - a.launchedAt);
    case "volume":
      return copy.sort((a, b) => (b.market?.volume24h ?? 0) - (a.market?.volume24h ?? 0));
    case "mcap":
      return copy.sort((a, b) => (b.market?.marketCap ?? 0) - (a.market?.marketCap ?? 0));
    case "change":
      return copy.sort((a, b) => (b.market?.change24h ?? -Infinity) - (a.market?.change24h ?? -Infinity));
    case "price":
      return copy.sort((a, b) => (b.market?.priceUsd ?? 0) - (a.market?.priceUsd ?? 0));
    case "age":
      return copy.sort((a, b) => a.launchedAt - b.launchedAt);
  }
}

function applySearch(launches: Launch[], q: string): Launch[] {
  if (!q.trim()) return launches;
  const lower = q.toLowerCase();
  return launches.filter(
    (l) =>
      l.tokenName?.toLowerCase().includes(lower) ||
      l.tokenSymbol?.toLowerCase().includes(lower)
  );
}

// ── Auto-refresh countdown dot (A7) ───────────────────────────────────────────

function RefreshDot({ countdown }: { countdown: number }) {
  // countdown: 0-30, fill proportion
  const pct = countdown / 30;
  return (
    <span
      title={`Auto-refresh in ${countdown}s`}
      className="inline-flex items-center gap-1 font-mono text-[9px] text-slate-700 select-none"
    >
      <span
        className="inline-block w-1.5 h-1.5 rounded-full transition-colors"
        style={{
          background: pct > 0.5 ? "#22C55E" : pct > 0.15 ? ACCENT : "#EF4444",
          opacity: 0.7,
        }}
      />
      {countdown}s
    </span>
  );
}

// ── My Tokens (creator-fee dashboard) ───────────────────────────────────────────
// Lists tokens the CONNECTED wallet launched, with unclaimed creator fees pulled
// live from Bankr's public Doppler creator-fees endpoint (via /api/my-tokens).
// Claim Fees is an ONCHAIN tx: /api/claim-fees builds Bankr's calldata, the user
// signs it from their own wallet (wagmi). ZERO fabricated USD — raw amounts only.

type MyToken = {
  tokenAddress: string;
  name: string;
  symbol: string;
  share: string | null;
  token0Label: string | null;
  token1Label: string | null;
  claimable: { token0: string; token1: string };
  claimed: { token0: string; token1: string; count: number };
  hasClaimable: boolean;
  /** Authoritative per-row chain from Bankr's fee data (null = unrecognised).
   *  Preferred over the local KV launch record, which does not cover every
   *  fee-bearing token — a Bankr-launched token can have fees here and no row
   *  in `bluechat:launches` at all. */
  chain: "base" | "robinhood" | null;
  chainId: number | null;
};
type MyTokensResponse = { ok: boolean; address: string; tokens: MyToken[]; error?: string };
type ClaimTx = { to: string; data: string; chainId: number; gasEstimate?: string; description?: string };
type ClaimResponse = { ok: boolean; transactions: ClaimTx[]; error?: string };

// Compact amount formatter for raw token strings (no USD invented).
function fmtAmt(s: string): string {
  const n = parseFloat(s);
  if (!Number.isFinite(n) || n === 0) return "0";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(2) + "K";
  if (n >= 1) return n.toFixed(4);
  if (n >= 0.0001) return n.toFixed(6);
  return n.toExponential(2);
}

function MyTokenCard({ t, owner, onClaimed, chain, chainId, onExplore }: {
  t: MyToken;
  owner: string;
  onClaimed: () => void;
  chain?: "base" | "robinhood";
  chainId?: number;
  onExplore?: (address: string, chainId: number) => void;
}) {
  const { sendTransactionAsync } = useSendTransaction();
  const { switchChainAsync } = useSwitchChain();
  const [status, setStatus] = useState<"idle" | "building" | "signing" | "done" | "error">("idle");
  const [msg, setMsg] = useState("");
  const [txHash, setTxHash] = useState("");
  // Which chain the claim actually settled on — drives the explorer link. RH
  // tx hashes do not resolve on Basescan, so a fixed host silently 404s.
  const [txChainId, setTxChainId] = useState(0);
  const [copied, setCopied] = useState(false);

  const sym = (t.symbol || t.name || "?").replace(/^\$/, "");
  const busy = status === "building" || status === "signing";

  function copyAddr() {
    navigator.clipboard?.writeText(t.tokenAddress).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  }

  async function claim() {
    if (busy) return;
    setStatus("building"); setMsg(""); setTxHash("");
    try {
      const res = await fetch("/api/claim-fees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ beneficiaryAddress: owner, tokenAddress: t.tokenAddress }),
      });
      const d = (await res.json()) as ClaimResponse;
      if (!d.ok || d.transactions.length === 0) {
        setMsg(d.error || "Nothing to claim."); setStatus("error"); return;
      }
      setStatus("signing");
      let last = "";
      let lastChain = 0;
      // Sign each tx on ITS OWN chain. Bankr's build-claim returns the real
      // chainId per token (measured 2026-09-06: HOODUP → 4663), and creator
      // fees exist on both Base 8453 and Robinhood 4663. This used to hardcode
      // 8453 for the switch AND the send, which is why every Robinhood token
      // showed `claimed.count: 0` while Base showed 4 — the button could not
      // reach the chain the fees were on. A response can mix chains (multiple
      // tokenAddresses), so switch inside the loop, not before it.
      for (const tx of d.transactions) {
        try { await switchChainAsync({ chainId: tx.chainId }); } catch {
          throw new Error(`Switch your wallet to chain ${tx.chainId} to claim ${sym}`);
        }
        last = await sendTransactionAsync({
          to: tx.to as `0x${string}`,
          data: tx.data as `0x${string}`,
          chainId: tx.chainId,
        });
        lastChain = tx.chainId;
      }
      setTxHash(last);
      setTxChainId(lastChain);
      setStatus("done");
      setMsg("Fees claimed.");
      setTimeout(onClaimed, 2500); // refresh balances after the tx settles
    } catch (e) {
      const m = (e as Error).message || "Claim failed.";
      const cancelled = /user rejected|denied|cancell?ed/i.test(m);
      setMsg(cancelled ? "Claim cancelled." : m.slice(0, 120));
      setStatus("error");
    }
  }

  return (
    <div className="card-surface rounded-2xl p-4 flex flex-col gap-3">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center font-mono text-sm font-bold shrink-0"
          style={{ background: `${ACCENT}15`, border: `1px solid ${ACCENT}30`, color: ACCENT }}>
          {sym.slice(0, 2).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-mono text-sm font-bold text-white truncate">{t.name || sym}</div>
          <div className="font-mono text-[11px] text-slate-500">${sym}</div>
        </div>
        {t.share && (
          <span className="font-mono text-[9px] px-1.5 py-0.5 rounded-md shrink-0"
            style={{ background: `${ACCENT}15`, color: ACCENT, border: `1px solid ${ACCENT}30` }}>
            {t.share} fee
          </span>
        )}
      </div>

      {/* Unclaimed fees */}
      <div className="rounded-xl border border-[#1A1A2E] bg-[#0a0a0f] p-3">
        <div className="font-mono text-[8px] text-slate-600 tracking-widest mb-1.5">UNCLAIMED FEES</div>
        <div className="grid grid-cols-2 gap-2 font-mono">
          <div>
            <div className="text-[13px] font-bold text-slate-100 tabular-nums">{fmtAmt(t.claimable.token0)}</div>
            <div className="text-[9px] text-slate-600">{t.token0Label ?? "token0"}</div>
          </div>
          <div>
            <div className="text-[13px] font-bold text-slate-100 tabular-nums">{fmtAmt(t.claimable.token1)}</div>
            <div className="text-[9px] text-slate-600">{t.token1Label ?? "token1"}</div>
          </div>
        </div>
        {t.claimed.count > 0 && (
          <div className="font-mono text-[9px] text-slate-600 mt-2 pt-2 border-t border-[#1A1A2E]">
            Claimed {t.claimed.count}× already
          </div>
        )}
      </div>

      {/* Address */}
      <button onClick={copyAddr}
        className="flex items-center gap-1.5 font-mono text-[10px] text-slate-600 hover:text-slate-400 transition-colors self-start"
        title="Copy token address">
        <span>{truncAddr(t.tokenAddress)}</span>
        <span style={{ color: copied ? "#22C55E" : undefined }}>{copied ? "✓ copied" : "⧉"}</span>
      </button>

      {/* Claim status */}
      {status !== "idle" && (
        <div className="font-mono text-[10px]"
          style={{ color: status === "done" ? "#22C55E" : status === "error" ? "#EF4444" : ACCENT }}>
          {status === "building" && "Building claim…"}
          {status === "signing" && "Confirm in your wallet…"}
          {status === "done" && (
            <span>
              ✓ {msg}{" "}
              {txHash && (
                <a href={`${txChainId === RH_CHAIN_ID ? RH_EXPLORER : "https://basescan.org"}/tx/${txHash}`}
                  target="_blank" rel="noopener noreferrer"
                  className="underline hover:opacity-80">view tx ↗</a>
              )}
            </span>
          )}
          {status === "error" && `⚠ ${msg}`}
        </div>
      )}

      {/* Actions */}
      <div className="flex flex-wrap gap-1.5 pt-1 border-t border-[#1A1A2E]">
        <button
          onClick={claim}
          disabled={busy || !t.hasClaimable}
          className="font-mono text-[10px] px-2.5 py-1 rounded-lg border transition-colors disabled:opacity-40"
          style={{ borderColor: `${ACCENT}40`, color: ACCENT, background: `${ACCENT}10` }}
          title={t.hasClaimable ? "Claim creator fees" : "No unclaimed fees yet"}>
          {busy ? "Claiming…" : t.hasClaimable ? "Claim Fees" : "No fees yet"}
        </button>
        <a href={`/app/b20?address=${t.tokenAddress}`}
          className="font-mono text-[10px] px-2 py-1 rounded-lg border border-[#1A1A2E] text-slate-400 hover:text-white transition-colors">
          Scanner →
        </a>
        <a
          href={chain === "robinhood"
            ? `https://bankr.bot/terminal/discover/${t.tokenAddress}`
            : `https://bankr.bot/launches/${t.tokenAddress}`}
          target="_blank" rel="noopener noreferrer"
          className="font-mono text-[10px] px-2 py-1 rounded-lg border border-[#4FC3F730] text-[#4FC3F7] transition-colors">
          Bankr ↗
        </a>
        {chain !== "robinhood" && (
          <a href={`https://basescan.org/token/${t.tokenAddress}`}
            target="_blank" rel="noopener noreferrer"
            className="font-mono text-[10px] px-2 py-1 rounded-lg border border-[#1A1A2E] text-slate-400 hover:text-white transition-colors">
            Basescan ↗
          </a>
        )}
      </div>
    </div>
  );
}

function MyTokensView({ launches, onExplore }: {
  launches: Launch[];
  onExplore: (address: string, chainId: number) => void;
}) {
  // Lookup: tokenAddress (lower) → {chain, chainId}. Bankr's fees endpoint
  // doesn't tag which chain a token was deployed on, so we cross-reference
  // against our own /api/launches records to pick the right explorer link.
  const chainByAddress = useMemo(() => {
    const map = new Map<string, { chain: "base" | "robinhood"; chainId?: number }>();
    for (const l of launches) {
      if (l.tokenAddress) {
        map.set(l.tokenAddress.toLowerCase(), {
          chain: l.chain ?? "base",
          chainId: l.chainId,
        });
      }
    }
    return map;
  }, [launches]);
  const { address, isConnected } = useAccount();
  const [tokens, setTokens] = useState<MyToken[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  const load = useCallback(() => {
    if (!address) return;
    setLoading(true); setErr("");
    fetch(`/api/my-tokens?address=${address}`)
      .then((r) => r.json())
      .then((d: MyTokensResponse) => {
        if (d.ok) setTokens(d.tokens);
        else { setErr(d.error || "Failed to load your tokens."); setTokens([]); }
      })
      .catch(() => setErr("Failed to load your tokens."))
      .finally(() => setLoading(false));
  }, [address]);

  useEffect(() => { if (isConnected && address) load(); }, [isConnected, address, load]);

  // Not connected → connect gate.
  if (!isConnected || !address) {
    return (
      <div className="rounded-2xl border border-[#1A1A2E] bg-[#0a0a0f] p-10 text-center">
        <div className="text-3xl mb-3">👤</div>
        <p className="text-sm text-slate-400 mb-1">Connect your wallet</p>
        <p className="text-[11px] text-slate-600">
          See the tokens you&apos;ve launched and claim your creator fees.
        </p>
      </div>
    );
  }

  if (loading && !tokens) {
    return (
      <div className="flex items-center gap-2 py-10 justify-center">
        <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: ACCENT }} />
        <span className="text-xs text-slate-600">Loading your tokens…</span>
      </div>
    );
  }

  if (err && (!tokens || tokens.length === 0)) {
    return (
      <div className="rounded-2xl border border-red-500/20 bg-red-500/5 p-5 text-center">
        <p className="text-sm text-red-400 mb-3">{err}</p>
        <button onClick={load}
          className="font-mono text-[11px] px-3 py-1.5 rounded-lg border border-[#1A1A2E] text-slate-300 hover:text-white transition-colors">
          Retry
        </button>
      </div>
    );
  }

  if (tokens && tokens.length === 0) {
    return (
      <div className="rounded-2xl border border-[#1A1A2E] bg-[#0a0a0f] p-10 text-center">
        <div className="text-3xl mb-3">🚀</div>
        <p className="text-sm text-slate-400 mb-1">No tokens launched yet</p>
        <p className="text-[11px] text-slate-600">
          Tokens you deploy through Blue Agent show up here.
        </p>
      </div>
    );
  }

  return (
    <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
      {(tokens ?? []).map((t) => {
        // Bankr's own row wins; the local launch record is only a fallback for
        // rows where Bankr sent no chain.
        const meta = chainByAddress.get(t.tokenAddress.toLowerCase());
        return (
          <MyTokenCard key={t.tokenAddress} t={t} owner={address} onClaimed={load}
            chain={t.chain ?? meta?.chain}
            chainId={t.chainId ?? meta?.chainId}
            onExplore={onExplore} />
        );
      })}
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function LaunchesPage() {
  const { t } = useLang();
  const [data, setData] = useState<FeedResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // In-page swap modal: which token the user is trading (null = closed).
  const [tradeToken, setTradeToken] = useState<Launch | null>(null);

  // Explore modal (Robinhood Chain only) — read-only Blockscout data.
  const [exploreToken, setExploreToken] = useState<Launch | null>(null);

  // A1 — view mode
  const [viewMode, setViewMode] = useState<ViewMode>("grid");

  // A2 — sort
  const [sort, setSort] = useState<SortKey>("newest");

  // A3 — filter tab
  const [filterTab, setFilterTab] = useState<FilterTab>("all");

  // Chain filter — Base (Bankr launches) vs Robinhood Chain (own registry)
  const [chainFilter, setChainFilter] = useState<ChainFilter>("all");

  // A4 — search
  const [search, setSearch] = useState("");

  // A7 — auto-refresh countdown
  const [countdown, setCountdown] = useState(30);
  const countdownRef = useRef(30);

  const load = useCallback(() => {
    setLoading(true);
    fetch("/api/launches")
      .then((r) => r.json())
      .then((d: FeedResponse) => setData(d))
      .catch(() => setError("Failed to load launches"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  // A7 — 30s auto-refresh + countdown ticker
  useEffect(() => {
    const tick = setInterval(() => {
      countdownRef.current -= 1;
      setCountdown(countdownRef.current);
      if (countdownRef.current <= 0) {
        countdownRef.current = 30;
        setCountdown(30);
        load();
      }
    }, 1000);
    return () => clearInterval(tick);
  }, [load]);

  // Reset countdown on manual load
  const manualLoad = useCallback(() => {
    countdownRef.current = 30;
    setCountdown(30);
    load();
  }, [load]);

  // Derived list: filter tab → search → sort
  const allLaunches = data?.launches ?? [];
  const chained = applyChainFilter(allLaunches, chainFilter);
  const filtered = applyFilter(chained, filterTab);
  const searched = applySearch(filtered, search);
  const launches = applySort(searched, sort);

  return (
    <div className="flex flex-col h-full bg-[#050508] text-white font-mono overflow-hidden">
      {tradeToken && (tradeToken.chain === "robinhood"
        ? <RobinhoodTradeModal l={tradeToken} onClose={() => setTradeToken(null)} />
        : <TradeModal l={tradeToken} onClose={() => setTradeToken(null)} />)}
      {exploreToken && <ExploreModal l={exploreToken} onClose={() => setExploreToken(null)} />}

      {/* Header bar */}
      <div className="flex items-center justify-between gap-3 px-4 sm:px-6 h-14 border-b border-[#1A1A2E] shrink-0">
        <div className="min-w-0">
          <p className="font-mono text-xs text-[#4FC3F7] tracking-widest">// LAUNCHES</p>
          <p className="font-mono text-[10px] text-slate-700 truncate mt-1">Tokens launched through Blue Agent — Base + Robinhood Chain</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {/* A7 — refresh dot */}
          <RefreshDot countdown={countdown} />
          {/* A1 — view toggle */}
          <div className="flex items-center rounded-lg border border-[#1A1A2E] overflow-hidden">
            <button
              onClick={() => setViewMode("grid")}
              className="px-2 py-1.5 font-mono text-[10px] transition-colors"
              style={{
                background: viewMode === "grid" ? `${ACCENT}18` : "transparent",
                color: viewMode === "grid" ? ACCENT : "#64748b",
              }}
              title="Grid view"
            >
              ⊞
            </button>
            <button
              onClick={() => setViewMode("list")}
              className="px-2 py-1.5 font-mono text-[10px] transition-colors"
              style={{
                background: viewMode === "list" ? `${ACCENT}18` : "transparent",
                color: viewMode === "list" ? ACCENT : "#64748b",
              }}
              title="List view"
            >
              ≡
            </button>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto relative">
        {/* Ambient glow */}
        <div className="pointer-events-none overflow-hidden absolute inset-x-0 top-0 h-[300px]">
          <div className="absolute inset-0"
            style={{ background: `radial-gradient(ellipse 80% 50% at 50% -10%, ${ACCENT}0A 0%, transparent 70%)` }} />
        </div>

        <div className="relative px-4 sm:px-6 py-6">
          {/* Stats strip */}
          <div className="grid grid-cols-3 gap-3 mb-5">
            <StatChip label="TOKENS LAUNCHED" value={loading ? "…" : String(data?.count ?? 0)} />
            <StatChip label="TOTAL MCAP" value={loading ? "…" : fmtUsd(data?.stats.totalMarketCap)} />
            <StatChip label="24H VOLUME" value={loading ? "…" : fmtUsd(data?.stats.totalVolume24h)} />
          </div>

          {/* Chain tabs — Base (Bankr fair-launch) vs Robinhood Chain (own registry) */}
          <div className="flex items-center gap-1.5 mb-3 flex-wrap">
            {CHAIN_TABS.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setChainFilter(tab.key)}
                className="font-mono text-[10px] px-3 py-1 rounded-full border transition-colors"
                style={{
                  background: chainFilter === tab.key ? "#22C55E15" : "transparent",
                  color: chainFilter === tab.key ? "#22C55E" : "#64748b",
                  borderColor: chainFilter === tab.key ? "#22C55E40" : "#1A1A2E",
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* A3 — Filter tabs */}
          <div className="flex items-center gap-1.5 mb-4 flex-wrap">
            {FILTER_TABS.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setFilterTab(tab.key)}
                className="font-mono text-[10px] px-3 py-1 rounded-full border transition-colors"
                style={{
                  background: filterTab === tab.key ? `${ACCENT}15` : "transparent",
                  color: filterTab === tab.key ? ACCENT : "#64748b",
                  borderColor: filterTab === tab.key ? `${ACCENT}40` : "#1A1A2E",
                }}
              >
                {t(`launches.${tab.tkey}`)}
              </button>
            ))}
          </div>

          {/* A4 Search + A2 Sort row — hidden in My Tokens (operates on public feed) */}
          {filterTab !== "mine" && (
          <div className="flex items-center gap-2 mb-5 flex-wrap">
            {/* A4 — search */}
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("launches.search")}
              className="flex-1 min-w-[180px] bg-[#0a0a0f] border border-[#1A1A2E] focus:border-[#F59E0B]/30 rounded-lg px-3 py-1.5 font-mono text-[11px] text-slate-300 placeholder:text-slate-700 outline-none transition-colors"
            />
            {/* A2 — sort */}
            <div className="flex items-center gap-1 shrink-0">
              <span className="font-mono text-[9px] text-slate-700 mr-1">SORT</span>
              {SORT_OPTIONS.map((opt) => (
                <button
                  key={opt.key}
                  onClick={() => setSort(opt.key)}
                  className="font-mono text-[9px] px-2 py-1 rounded-md border transition-colors"
                  style={{
                    background: sort === opt.key ? `${ACCENT}15` : "transparent",
                    color: sort === opt.key ? ACCENT : "#64748b",
                    borderColor: sort === opt.key ? `${ACCENT}40` : "#1A1A2E",
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          )}

          {filterTab === "mine" ? (
            <MyTokensView
              launches={allLaunches}
              onExplore={(address, chainId) => {
                // Build a minimal Launch to open the Explore modal for a My-Tokens row.
                const found = allLaunches.find((l) => l.tokenAddress.toLowerCase() === address.toLowerCase());
                if (found) {
                  setExploreToken(found);
                } else {
                  setExploreToken({
                    tokenAddress: address,
                    tokenSymbol: null,
                    tokenName: null,
                    image: null,
                    launchedAt: 0,
                    chain: "robinhood",
                    chainId,
                  } as unknown as Launch);
                }
              }}
            />
          ) : loading ? (
            <div className="flex items-center gap-2 py-10 justify-center">
              <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: ACCENT }} />
              <span className="text-xs text-slate-600">Loading launches…</span>
            </div>
          ) : error ? (
            <div className="rounded-2xl border border-red-500/20 bg-red-500/5 p-5 text-center">
              <p className="text-sm text-red-400">{error}</p>
            </div>
          ) : launches.length === 0 ? (
            <div className="rounded-2xl border border-[#1A1A2E] bg-[#0a0a0f] p-10 text-center">
              <div className="text-3xl mb-3">🚀</div>
              <p className="text-sm text-slate-400 mb-1">
                {search || filterTab !== "all" ? "No tokens match your filters" : t("launches.no_tokens")}
              </p>
              <p className="text-[11px] text-slate-600 mb-4">
                {search || filterTab !== "all"
                  ? "Try adjusting your search or filter."
                  : "Nothing here yet."}
              </p>
            </div>
          ) : viewMode === "grid" ? (
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {launches.map((l) => <LaunchCard key={l.tokenAddress} l={l} onTrade={setTradeToken} onExplore={setExploreToken} />)}
            </div>
          ) : (
            /* List view */
            <div className="rounded-xl border border-[#1A1A2E] overflow-hidden">
              <ListHeader sort={sort} onSort={setSort} />
              <div>
                {launches.map((l) => <LaunchRow key={l.tokenAddress} l={l} onTrade={setTradeToken} onExplore={setExploreToken} />)}
              </div>
            </div>
          )}

          {/* Supply / pool / gas terms are NOT uniform across this feed — it mixes
              B20 launches, direct Robinhood Chain deploys, and legacy Doppler
              tokens, each with its own economics. This footer used to recite the
              Doppler launchpad's terms as if they described every row, including
              a sponsored-gas promise that stopped being true when that launchpad
              was retired (2026-09-06). Only the data source is common to all of
              them, so that is all it claims now. */}
          <p className="font-mono text-[9px] text-slate-700 text-center mt-6">
            Market data from DexScreener
          </p>
        </div>
      </div>
    </div>
  );
}

function StatChip({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-[#1A1A2E] bg-[#0a0a0f] px-4 py-3">
      <div className="font-mono text-[8px] text-slate-600 tracking-widest mb-1">{label}</div>
      <div className="font-mono text-lg font-bold" style={{ color: ACCENT }}>{value}</div>
    </div>
  );
}
