"use client";

// Convert — in-app non-custodial swap on Base mainnet (ETH / WETH / USDC / cbBTC)
// routed via the 0x Swap API. BlueBank fetches the route from /api/swap/quote;
// the user approves (for ERC-20 sells) and signs the swap from their own wallet.
// Base mainnet only — 0x doesn't route testnet liquidity.
//
// ⚠️ NETWORK-BLIND BY DESIGN; THE CALLER MUST GATE — see BankClient.
// This component takes no `network` prop and reads none. Every address in
// `TOKENS` is Base mainnet, every balance read pins `chainId: base.id`, and
// `swap()` calls `switchChainAsync({ chainId: base.id })` BEFORE signing. So
// rendering it while the surrounding page is on a testnet does not produce a
// testnet swap — it silently yanks the wallet to MAINNET and spends REAL funds
// under a page captioned "no real value". BankClient is what stops that: its
// Convert panel refuses to mount this card when `isTestnet`.
//
// The hazard is a SECOND caller. Import this anywhere else and you inherit the
// mainnet-blindness without inheriting the guard, and nothing here will warn
// you — there is no runtime check, only that one call site. Add the gate at
// the new call site too, or give this component a `network` prop and make the
// refusal its own responsibility.

import { useState, useEffect, useRef } from "react";
import { useAccount, useBalance, useReadContract, useSwitchChain, useWriteContract, useSendTransaction } from "wagmi";
import { formatUnits, parseUnits } from "viem";
import { base } from "wagmi/chains";
import { ERC20_ABI } from "@/lib/yield-execution";
import { DATA_SUFFIX } from "@/constants/builderCode";
import { BASE_MAJORS, NATIVE_SENTINEL } from "@/lib/wallet/token-trust";

// The tradable majors come from `token-trust.ts`, which is also what decides
// whether a token in the portfolio may be sold at all. They used to be two
// hand-typed lists that happened to agree; now the list this card offers to buy
// IS the list the app vouches for, and adding a major in one place adds it in
// both. Looked up by symbol rather than index — an imported array can be
// reordered upstream, a local literal cannot.
const NATIVE = NATIVE_SENTINEL;
type Token = { sym: string; addr: string; decimals: number; native?: boolean };
const TOKENS: Token[] = BASE_MAJORS;
const ETH  = TOKENS.find(t => t.native)!;
const USDC = TOKENS.find(t => t.sym === "USDC")!;

// A quick-sell pre-fill pushed in from the portfolio token table: an arbitrary
// sell token (beyond the 4 majors) + a concrete amount. `nonce` bumps on every
// click so re-selling the same token re-applies.
export type SellPreset = { addr: string; sym: string; decimals: number; amount: string; nonce: number };

const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 6 });

type Quote = {
  needsKey?: boolean; error?: string;
  buyAmount?: string; minBuyAmount?: string;
  transaction?: { to: `0x${string}`; data: `0x${string}`; value?: string };
  issues?: { allowance?: { spender: `0x${string}` } | null };
};

export default function SwapCard({ account, preset }: { account?: `0x${string}`; preset?: SellPreset | null }) {
  const { isConnected } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const { sendTransactionAsync } = useSendTransaction();

  const [sell, setSell] = useState<Token>(ETH);
  const [buy, setBuy]   = useState<Token>(USDC);
  const [amount, setAmount] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState<"idle" | "approving" | "swapping" | "done" | "error">("idle");
  const [err, setErr] = useState("");
  const [txHash, setTxHash] = useState("");

  // Balance of the sell token.
  const { data: nativeBal } = useBalance({ address: account, chainId: base.id, query: { enabled: !!account && !!sell.native } });
  const { data: erc20Bal }  = useReadContract({
    address: sell.addr as `0x${string}`, abi: ERC20_ABI, functionName: "balanceOf",
    args: account ? [account] : undefined, chainId: base.id,
    query: { enabled: !!account && !sell.native },
  });
  const balance = sell.native
    ? (nativeBal ? Number(formatUnits(nativeBal.value, 18)) : null)
    : (erc20Bal != null ? Number(formatUnits(erc20Bal as bigint, sell.decimals)) : null);

  const amt = parseFloat(amount);
  const sellBase = amount && amt > 0 ? (() => { try { return parseUnits(amount, sell.decimals).toString(); } catch { return ""; } })() : "";
  const overBalance = balance != null && amt > balance;

  // Debounced quote fetch.
  const reqId = useRef(0);
  useEffect(() => {
    if (!sellBase || sell.addr === buy.addr) { setQuote(null); return; }
    const id = ++reqId.current;
    setLoading(true);
    const t = setTimeout(() => {
      const qs = new URLSearchParams({ sellToken: sell.addr, buyToken: buy.addr, sellAmount: sellBase, ...(account ? { taker: account } : {}) });
      fetch(`/api/swap/quote?${qs}`).then(r => r.json()).then((j: Quote) => {
        if (id !== reqId.current) return;
        setQuote(j); setLoading(false);
      }).catch(() => { if (id === reqId.current) { setQuote({ error: "quote failed" }); setLoading(false); } });
    }, 450);
    return () => clearTimeout(t);
  }, [sellBase, sell.addr, buy.addr, account]);

  // Apply a quick-sell pre-fill from the token table: set the (possibly
  // non-major) sell token + amount and default the buy side to USDC — but sell
  // *to ETH* when the token being sold IS USDC. Keyed on nonce so repeat clicks
  // re-fill. The user still reviews and signs via the normal Convert button.
  useEffect(() => {
    if (!preset) return;
    setSell({ sym: preset.sym, addr: preset.addr, decimals: preset.decimals });
    setBuy(preset.addr.toLowerCase() === USDC.addr.toLowerCase() ? ETH : USDC);
    setAmount(preset.amount);
    setQuote(null); setStep("idle"); setErr("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset?.nonce]);

  const buyAmount = quote?.buyAmount ? Number(formatUnits(BigInt(quote.buyAmount), buy.decimals)) : null;
  const minBuy = quote?.minBuyAmount ? Number(formatUnits(BigInt(quote.minBuyAmount), buy.decimals)) : null;
  const rate = buyAmount != null && amt > 0 ? buyAmount / amt : null;

  function flip() { setSell(buy); setBuy(sell); setAmount(""); setQuote(null); }
  function setMax() {
    if (balance == null) return;
    setAmount(String(sell.native ? Math.max(0, balance - 0.00005) : balance));
  }
  function pick(side: "sell" | "buy", addr: string) {
    const tok = [sell, buy, ...TOKENS].find(t => t.addr.toLowerCase() === addr.toLowerCase());
    if (!tok) return;
    if (side === "sell") { if (tok.addr === buy.addr) setBuy(sell); setSell(tok); }
    else { if (tok.addr === sell.addr) setSell(buy); setBuy(tok); }
    setAmount(""); setQuote(null);
  }
  // Sell-side options include an injected non-major token so it renders + stays selectable.
  const inMajors = (t: Token) => TOKENS.some(x => x.addr.toLowerCase() === t.addr.toLowerCase());
  const sellOptions = inMajors(sell) ? TOKENS : [sell, ...TOKENS];

  const canSwap = !!account && !!quote?.transaction && amt > 0 && !overBalance && !loading;
  const busy = step === "approving" || step === "swapping";

  async function swap() {
    if (!account) { setErr("Connect your wallet"); setStep("error"); return; }
    if (quote?.needsKey) { setErr("Convert needs a 0x API key (ZEROX_API_KEY)"); setStep("error"); return; }
    if (!quote?.transaction) { setErr(quote?.error || "No route for this pair"); setStep("error"); return; }
    setErr(""); setTxHash("");
    try {
      // Unconditional jump to MAINNET, whatever chain the page thinks it is on
      // — network-blind by design; the caller MUST gate (see the file header
      // and BankClient's `isTestnet` refusal). Real funds move after this line.
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
        // Append the ERC-8021 builder-code suffix to the 0x swap calldata so the
        // tx is credited to BlueAgent on base.dev (0x… data + suffix without 0x).
        data: (quote.transaction.data + DATA_SUFFIX.slice(2)) as `0x${string}`,
        value: quote.transaction.value ? BigInt(quote.transaction.value) : undefined,
        chainId: base.id,
      });
      setTxHash(hash); setStep("done");
    } catch (e) {
      setErr(((e as Error).message || String(e)).slice(0, 160)); setStep("error");
    }
  }

  if (step === "done") {
    return (
      <div className="mt-2 rounded-xl border p-3.5" style={{ borderColor: "#22C55E40", background: "#22C55E08" }}>
        <div className="font-mono text-[11px] font-bold mb-1" style={{ color: "#22C55E" }}>
          ✓ Converted {fmt(amt)} {sell.sym} → {buyAmount != null ? fmt(buyAmount) : ""} {buy.sym}
        </div>
        {txHash && (
          <a href={`https://basescan.org/tx/${txHash}`} target="_blank" rel="noopener noreferrer"
             className="font-mono text-[10px] px-2.5 py-1 rounded-lg border border-[#4FC3F730] text-[#4FC3F7] inline-block mt-1">View tx ↗</a>
        )}
        <button onClick={() => { setStep("idle"); setAmount(""); setQuote(null); }}
          className="font-mono text-[10px] text-slate-500 hover:text-slate-300 ml-3">Convert again</button>
      </div>
    );
  }

  const TokenSelect = ({ side, value, options }: { side: "sell" | "buy"; value: Token; options: Token[] }) => (
    <select value={value.addr} onChange={e => pick(side, e.target.value)}
      className="bg-[#050508] border border-[#1A1A2E] rounded-lg px-2 py-1.5 font-mono text-[11px] text-slate-200 outline-none">
      {options.map(t => <option key={t.addr} value={t.addr}>{t.sym}</option>)}
    </select>
  );

  return (
    <div className="mt-2 rounded-xl border border-[#1A1A2E] bg-[#0a0a0f] p-3.5">
      <div className="flex items-center justify-between mb-3">
        <span className="font-mono text-[10px] text-slate-500 tracking-widest font-bold">CONVERT · BASE</span>
        <span className="font-mono text-[9px] text-slate-600">mainnet · via 0x</span>
      </div>

      {/* Sell */}
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
          <TokenSelect side="sell" value={sell} options={sellOptions} />
        </div>
        {overBalance && <div className="font-mono text-[9px] text-red-500 mt-1">Exceeds your {sell.sym} balance</div>}
      </div>

      {/* Flip */}
      <div className="flex justify-center -my-1 relative z-10">
        <button onClick={flip} className="w-7 h-7 rounded-lg border border-[#1A1A2E] bg-[#0d0d12] text-slate-400 hover:text-[#4FC3F7] hover:border-[#4FC3F7]/40 font-mono text-[12px]">⇅</button>
      </div>

      {/* Buy */}
      <div className="rounded-lg border border-[#1A1A2E] bg-[#050508] p-2.5 mt-1 mb-3">
        <div className="font-mono text-[9px] text-slate-600 mb-1">YOU RECEIVE</div>
        <div className="flex items-center gap-2">
          <div className="flex-1 font-mono text-[16px] text-white w-0 truncate">
            {loading ? <span className="text-slate-600">…</span> : buyAmount != null ? fmt(buyAmount) : <span className="text-slate-700">0.0</span>}
          </div>
          <TokenSelect side="buy" value={buy} options={TOKENS} />
        </div>
      </div>

      {rate != null && (
        <div className="font-mono text-[9px] text-slate-500 mb-2 flex items-center justify-between">
          <span>1 {sell.sym} ≈ {fmt(rate)} {buy.sym}</span>
          {minBuy != null && <span className="text-slate-600">min {fmt(minBuy)} {buy.sym}</span>}
        </div>
      )}

      {quote?.needsKey && <p className="font-mono text-[9px] text-amber-400 mb-2">Convert needs a free 0x API key — set <span className="text-slate-300">ZEROX_API_KEY</span>.</p>}
      {step === "error" && <p className="font-mono text-[10px] text-amber-400 mb-2">{err}</p>}

      <button onClick={swap} disabled={!canSwap || busy}
        className="w-full font-mono text-[12px] font-bold py-2 rounded-lg transition-all disabled:opacity-50"
        style={{ background: "#4FC3F715", color: "#4FC3F7", border: "1px solid #4FC3F740" }}>
        {!isConnected ? "Connect your wallet"
          : busy ? (step === "approving" ? "Approve in wallet…" : "Confirm swap…")
          : overBalance ? "Insufficient balance"
          : `Convert ${amt > 0 ? fmt(amt) : ""} ${sell.sym} → ${buy.sym}`}
      </button>
      <p className="font-mono text-[9px] text-slate-700 mt-1.5">Best route via 0x · you sign · non-custodial · Base mainnet.</p>
    </div>
  );
}
