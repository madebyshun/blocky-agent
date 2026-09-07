"use client";
// Chat card for the `robinhood_swap` tool. Executes a real, tiny-friendly swap
// on Robinhood Chain (chainId 4663) via the deployed RobinhoodSwapRouter
// (0x3bb0…d23D). Everything happens client-side under the user's own wallet:
//   1. GET /api/robinhood/swap/quote → pool detection + display-only estimate
//   2. POST /api/robinhood/router/swap-prepare → tx calldata + optional approve
//   3. User signs approve (sell only), then the swap tx.
// Non-custodial: server holds no keys, on-chain math bounds the final amount.

import { useEffect, useRef, useState } from "react";
import { useAccount, useSwitchChain, useSendTransaction, usePublicClient } from "wagmi";
import { parseUnits } from "viem";
import { ERC20_ABI } from "@/lib/yield-execution";
import { ConnectButton } from "@/components/ConnectModal";
import { TokenGlyph, ConfirmPreview, resolveQuantity } from "./ConfirmCardParts";
import { UnverifiedBalance } from "@/components/wallet/UnverifiedBalance";
import { useSpendableBalance } from "@/lib/wallet/useSpendableBalance";
import { resolveSpend } from "@/lib/wallet/read-state";
import { clampDecimals } from "@/lib/wallet/amount";

const RH_ROUTER = "0x3bb0e9E3dB75faDC5f1f8b7D7B9D761Ef15cd23D" as const;
const RH_CHAIN_ID = 4663;
const RH_EXPLORER = "https://robinhoodchain.blockscout.com";

/** Marker shape the /api/chat handler emits for `robinhood_swap`. */
export interface RobinhoodSwapResult {
  kind: "robinhood_swap";
  direction?: "buy" | "sell";
  token_address?: string;
  token_symbol?: string;
  token_name?: string;
  /** Human-readable amount: ETH for buy, token for sell. */
  amount?: string | number;
  /** Server-side resolution notes (e.g. "resolved via GeckoTerminal"). */
  note?: string;
  /** Server-side error to display inline (e.g. token not found). */
  error?: string;
  // ── Optional token→token fields (backwards-compat: absent = ETH↔token) ────
  /** ERC20 tokenIn address. When set, the card switches to token→token mode
   *  and treats `token_address` as tokenOut regardless of `direction`. */
  token_in_address?: string;
  token_in_symbol?: string;
}

type Quote = {
  ok?: boolean;
  hasPool?: boolean;
  note?: string;
  pool?: { address: `0x${string}`; fee: 100 | 500 | 3000 | 10000; liquidity: string; token0: `0x${string}`; token1: `0x${string}` };
  price?: { tokenUsd: number | null; ethUsd: number | null };
  estimate?: { amountIn: number; direction: "buy" | "sell"; amountOut: number | null };
  error?: string;
};

/** Token→token quote — priced off both tokens' GeckoTerminal USD prices. */
type T2TQuote = {
  ok?: boolean;
  /** "direct" | "via-weth" | "unknown". Actual on-chain route only decided at
   *  swap-prepare time; this is a best-guess for the preview label. */
  routeHint?: "direct" | "via-weth" | "unknown";
  priceInUsd?: number | null;
  priceOutUsd?: number | null;
  amountOut?: number | null;
  error?: string;
};

function fmtNum(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

const SLIPPAGE_BPS_KEY = "robinhood-swap-slippage-bps";
function loadSlippageBps(): number {
  if (typeof window === "undefined") return 50;
  const raw = window.localStorage.getItem(SLIPPAGE_BPS_KEY);
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 && n <= 5000 ? n : 50;
}

export function RobinhoodSwapCard({ result }: { result: RobinhoodSwapResult }) {
  const { address, isConnected } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { sendTransactionAsync } = useSendTransaction();
  // Public client on RH — used to wait for prior tx to mine between calls
  // (approve → swap). Without this, MetaMask simulates the swap against
  // pre-approve state, sees allowance = 0, and warns "likely to fail".
  const rhPublicClient = usePublicClient({ chainId: RH_CHAIN_ID });

  const direction = result.direction === "sell" ? "sell" : "buy";
  const token = (result.token_address || "").trim() as `0x${string}` | "";
  const tokenSym = (result.token_symbol || "").replace(/^\$/, "") || "TOKEN";
  const initialAmt = result.amount != null ? String(result.amount) : "";

  // Token→token mode: activated when the caller passes a `token_in_address`.
  // Confirm-only (#107) — the tokenIn comes from the LLM, never edited in-card.
  // When absent, the card behaves EXACTLY as before (ETH↔token via `direction`).
  const tokenInAddr = (result.token_in_address || "").trim() as `0x${string}` | "";
  const isT2T = /^0x[a-fA-F0-9]{40}$/.test(tokenInAddr);
  const tokenInSym = (result.token_in_symbol || "").replace(/^\$/, "") || "TOKEN_IN";

  // Amount comes from the LLM marker and may be a quantity word ("all"/"max"/
  // "half"/"N%") — resolved against the live balance below (once we've read it).
  // Display-only either way: no in-card edit = no drift (Issue 1, #107).
  //
  // Slippage is shown as small text now, not an editable control. ETH↔token
  // uses a 3% default; token→token honours the trader's persisted bps pref.
  const [slippagePct] = useState(3);
  const [slippageBps, setSlippageBps] = useState<number>(50);
  useEffect(() => { setSlippageBps(loadSlippageBps()); }, []);

  const [quote, setQuote] = useState<Quote | null>(null);
  const [loadingQuote, setLoadingQuote] = useState(false);
  // Separate quote state for token→token: uses GeckoTerminal for both legs'
  // USD prices, doesn't hit /api/robinhood/swap/quote (which is WETH-only).
  const [t2tQuote, setT2tQuote] = useState<T2TQuote | null>(null);
  const [loadingT2T, setLoadingT2T] = useState(false);
  // Route info from /swap-prepare's `meta.route` — surfaced after prepare runs.
  const [prepRoute, setPrepRoute] = useState<"direct" | "multi-hop" | "none" | null>(null);
  const [noRouteMsg, setNoRouteMsg] = useState<string>("");

  const [step, setStep] = useState<"idle" | "approving" | "swapping" | "done" | "error">("idle");
  const [err, setErr] = useState("");
  const [txHash, setTxHash] = useState("");

  // The balance of whatever this swap SPENDS: native ETH on a buy, the token
  // on a sell, tokenIn on a token→token. One hook, so decimals are READ rather
  // than assumed and "still reading" stays distinct from "could not read".
  //
  // Deleted here, and worth naming because it was live on chain 4663:
  //
  //     formatUnits(tokenBal as bigint, 18)   ← three times, one per branch
  //
  // USDG is 6 decimals, so a wallet holding 1,000 USDG read as 0.000000000001:
  // "swap all my USDG" resolved to dust, and any real amount tripped the
  // over-balance guard so the confirm button said "Insufficient balance" and
  // was DISABLED on a wallet that held plenty. This same file already knew —
  // its readDecimals() comment ~90 lines below says so — and fixed only the
  // copy at prepare time. That is the whole argument for one shared read.
  const isNativeIn = !isT2T && direction === "buy";
  const bal = useSpendableBalance({
    holder:  address,
    native:  isNativeIn,
    token:   isT2T ? tokenInAddr : (direction === "sell" ? token : undefined),
    chainId: RH_CHAIN_ID,
  });
  const balance = bal.balance;

  // Resolve a symbolic amount against the balance we just read. On a BUY the
  // input is native ETH → keep a gas reserve; on sell / token→token the input
  // is the ERC-20 (gas is paid in ETH, separately), so no reserve.
  const q = resolveQuantity(initialAmt, balance, { isNative: isNativeIn });
  // Non-symbolic → keep the LLM's exact string (avoids exponential re-format of
  // tiny numbers like "0.0000001", which parseUnits/servers reject). Symbolic →
  // the resolved balance-fraction as a plain decimal string.
  const amount = q.symbolic ? (q.value != null ? String(q.value) : "") : initialAmt;
  const amt = q.value ?? NaN;
  // THREE outcomes, not two. The old guard was
  //     balance != null && Number.isFinite(amt) && amt > balance
  // which is false when the read FAILED — fail-open, so an unreadable balance
  // enabled the button and sent the user to pay gas for a doomed swap.
  const gate = resolveSpend({
    loading:  bal.loading,
    received: bal.received,
    failed:   bal.failed,
    over:     balance != null && Number.isFinite(amt) && amt > balance,
  });
  const overBalance = gate === "insufficient";

  // Debounced quote fetch — /api/robinhood/swap/quote for ETH↔token,
  // GeckoTerminal-only for token→token (that endpoint doesn't handle it).
  const reqId = useRef(0);
  useEffect(() => {
    if (isT2T) { setQuote(null); return; }
    if (!token || !amount || !Number.isFinite(amt) || amt <= 0) { setQuote(null); return; }
    const id = ++reqId.current;
    setLoadingQuote(true);
    const t = setTimeout(() => {
      const qs = new URLSearchParams({ token, direction, amount: String(amt) });
      fetch(`/api/robinhood/swap/quote?${qs}`)
        .then(r => r.json())
        .then((j: Quote) => { if (id === reqId.current) { setQuote(j); setLoadingQuote(false); } })
        .catch(() => { if (id === reqId.current) { setQuote({ error: "quote failed" }); setLoadingQuote(false); } });
    }, 400);
    return () => clearTimeout(t);
  }, [token, direction, amount, amt, isT2T]);

  // Token→token quote — GeckoTerminal USD prices for both tokens.
  const t2tReqId = useRef(0);
  useEffect(() => {
    if (!isT2T) { setT2tQuote(null); return; }
    if (!token || !tokenInAddr || !Number.isFinite(amt) || amt <= 0) { setT2tQuote(null); return; }
    const id = ++t2tReqId.current;
    setLoadingT2T(true);
    const t = setTimeout(() => {
      Promise.all([
        fetch(`https://api.geckoterminal.com/api/v2/networks/robinhood/tokens/${tokenInAddr}`, { cache: "no-store" }).then(r => r.ok ? r.json() : null).catch(() => null),
        fetch(`https://api.geckoterminal.com/api/v2/networks/robinhood/tokens/${token}`, { cache: "no-store" }).then(r => r.ok ? r.json() : null).catch(() => null),
      ]).then(([inJ, outJ]) => {
        if (id !== t2tReqId.current) return;
        const pIn = inJ?.data?.attributes?.price_usd ? parseFloat(inJ.data.attributes.price_usd) : null;
        const pOut = outJ?.data?.attributes?.price_usd ? parseFloat(outJ.data.attributes.price_usd) : null;
        const amountOut = pIn && pOut ? (amt * pIn) / pOut : null;
        setT2tQuote({ ok: true, routeHint: "unknown", priceInUsd: pIn, priceOutUsd: pOut, amountOut });
        setLoadingT2T(false);
      }).catch(() => {
        if (id === t2tReqId.current) { setT2tQuote({ error: "quote failed" }); setLoadingT2T(false); }
      });
    }, 400);
    return () => clearTimeout(t);
  }, [isT2T, token, tokenInAddr, amt]);

  const hasPool = isT2T
    // For T2T we can't cheaply verify pool existence client-side; the actual
    // route is decided at prepare-time (server-side, on-chain). Treat "has a
    // GeckoTerminal price" as a soft signal that a route probably exists.
    ? (t2tQuote?.ok === true)
    : (quote?.ok && quote?.hasPool);
  const estimatedOut = isT2T ? (t2tQuote?.amountOut ?? null) : (quote?.estimate?.amountOut ?? null);
  const inSym = isT2T ? tokenInSym : (direction === "buy" ? "ETH" : tokenSym);
  const outSym = isT2T ? tokenSym : (direction === "buy" ? tokenSym : "ETH");
  const rate = estimatedOut != null && amt > 0 ? estimatedOut / amt : null;
  // For T2T we honour the user's bps setting; for ETH↔token we keep the
  // existing pct picker (backwards-compat with pinned trader muscle memory).
  const slippageFrac = isT2T ? slippageBps / 10000 : slippagePct / 100;
  const minOut = estimatedOut != null ? estimatedOut * (1 - slippageFrac) : null;
  const anyLoading = isT2T ? loadingT2T : loadingQuote;
  // `gate === "ok"` replaces `!overBalance` — it additionally requires that the
  // balance was actually READ, so an unread balance blocks instead of passing.
  const canSwap = !!address && hasPool && amt > 0 && gate === "ok" && !anyLoading && step !== "approving" && step !== "swapping";
  const busy = step === "approving" || step === "swapping";

  async function doSwap() {
    if (!address) { setErr("Connect your wallet"); setStep("error"); return; }
    if (!token) { setErr("Missing token address"); setStep("error"); return; }
    if (!isT2T && (!hasPool || !quote?.pool)) { setErr("No pool available"); setStep("error"); return; }
    if (!amt || amt <= 0) { setErr("Enter an amount"); setStep("error"); return; }
    setErr(""); setTxHash(""); setPrepRoute(null); setNoRouteMsg("");
    try {
      try { await switchChainAsync({ chainId: RH_CHAIN_ID }); } catch {
        throw new Error("Switch to Robinhood Chain (4663) and try again");
      }
      // Decimals for BOTH sides — read, never assumed. Hardcoding 18 was a real
      // bug: USDG has 6 decimals, so any USDG side of a swap got the amount
      // scaled by 10^12 too large, the router reverted its amountOutMinimum
      // check, and MetaMask showed "likely to fail".
      //
      // This block used to fall back to `18` when the read errored and called
      // that "fail-soft". It is not soft. A wrong exponent is a wrong AMOUNT —
      // off by a factor of a million on USDG — so the swap that follows is not
      // a degraded swap, it is a doomed one that still costs gas. It now fails
      // CLOSED, the same rule the balance gate above follows: "we could not
      // check" is not "go ahead". A retry costs the user nothing.
      //
      // The INPUT side is not re-read here at all. useSpendableBalance already
      // read it on-chain — that read is what produced the balance this swap was
      // gated against, and `gate === "ok"` is what let us reach this line.
      // Reading the same value twice in one file is precisely how the two
      // copies drifted, and how the balance copy kept the bug this comment
      // describes for ninety lines above it.
      const nativeDec = rhPublicClient?.chain?.nativeCurrency?.decimals;
      const inDec = bal.decimals;
      if (inDec == null) throw new Error(`Could not read ${inSym} decimals on Robinhood Chain — try again.`);
      // Out side: the ERC-20 for a buy or a token→token, native ETH on a sell.
      const outTokenAddr = isT2T ? token : (direction === "buy" ? token : null);
      let outDec: number;
      if (outTokenAddr) {
        if (!rhPublicClient) throw new Error("No Robinhood Chain RPC — try again.");
        try {
          outDec = Number(await rhPublicClient.readContract({
            address: outTokenAddr as `0x${string}`, abi: ERC20_ABI, functionName: "decimals",
          }));
        } catch {
          throw new Error(`Could not read ${outSym} decimals on Robinhood Chain — try again.`);
        }
      } else {
        // Native ETH. Taken from the chain's own config rather than written
        // down, so this file holds no decimals literal that can drift.
        if (nativeDec == null) throw new Error("Could not read the chain's native decimals — try again.");
        outDec = nativeDec;
      }
      // Truncate to the token's own decimals — a resolved "half"/"N%" can carry
      // more fractional digits than the token supports, and parseUnits throws on
      // that. Floor (never round up) so we can't exceed the real balance.
      const amountInWei = parseUnits(clampDecimals(amount, inDec), inDec);
      // Clamp minOut precision to token's decimals (parseUnits throws on more
      // decimals than the token supports, e.g. parseUnits("0.014925", 6) is
      // fine but parseUnits("0.0000000000000000149", 6) is not).
      const minOutBase = minOut != null ? parseUnits(minOut.toFixed(outDec), outDec) : 0n;

      // ── Token→token branch ────────────────────────────────────────────────
      if (isT2T) {
        const prepRes = await fetch("/api/robinhood/router/swap-prepare", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            router: RH_ROUTER,
            tokenIn: tokenInAddr,
            token,                                    // = tokenOut
            amountIn: amountInWei.toString(),
            amountOutMinimum: minOutBase.toString(),
            recipient: address,
          }),
        });
        const prep = await prepRes.json();
        if (prep?.ok === false && prep?.error?.code === "NO_ROUTE") {
          setPrepRoute("none");
          setNoRouteMsg(prep.error.message || "no route on Robinhood Chain");
          setStep("error");
          setErr("No route available on Robinhood Chain for this pair.");
          return;
        }
        if (!prep.ok) throw new Error(prep.error?.message || prep.error || "Prepare failed");
        const route = (prep.meta?.route ?? "direct") as "direct" | "multi-hop";
        setPrepRoute(route);

        // The API returns a `meta.calls` array we walk in order. For "direct"
        // that's [approve, swap]; for "multi-hop" it's [approve, swap-leg1,
        // approve-weth, swap-leg2]. Sign each in sequence.
        const calls = (prep.meta?.calls ?? []) as Array<{
          kind: "approve" | "swap"; to: string; data: string; value: string; leg?: 1 | 2;
        }>;
        for (let i = 0; i < calls.length; i++) {
          const c = calls[i];
          setStep(c.kind === "approve" ? "approving" : "swapping");
          const hash = await sendTransactionAsync({
            to: c.to as `0x${string}`,
            data: c.data as `0x${string}`,
            value: BigInt(c.value),
            chainId: RH_CHAIN_ID,
          });
          if (c.kind === "swap") setTxHash(hash); // last swap tx wins as the "receipt" hash
          // Wait for THIS tx to mine before signing the next one. Without this
          // wait the next tx's MetaMask sim runs against pre-mine state (e.g.
          // approve not yet reflected in allowance() → swap reverts) and MM
          // shows "likely to fail" scaring the user off a valid flow.
          if (rhPublicClient && i < calls.length - 1) {
            await rhPublicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 60_000 });
          }
        }
        setStep("done");
        return;
      }

      // ── Existing ETH↔token branch (unchanged) ─────────────────────────────
      const prepRes = await fetch("/api/robinhood/router/swap-prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          router: RH_ROUTER,
          direction,
          token,
          fee: quote?.pool?.fee,
          amountIn: amountInWei.toString(),
          amountOutMinimum: minOutBase.toString(),
          recipient: address,
        }),
      });
      const prep = await prepRes.json();
      if (!prep.ok) throw new Error(prep.error?.message || prep.error || "Prepare failed");
      setPrepRoute((prep.meta?.route ?? "direct") as "direct" | "multi-hop");

      if (prep.approve) {
        setStep("approving");
        const approveHash = await sendTransactionAsync({
          to: prep.approve.to as `0x${string}`,
          data: prep.approve.data as `0x${string}`,
          value: 0n,
          chainId: RH_CHAIN_ID,
        });
        // Wait for approve to mine before submitting the swap — otherwise MM
        // sims the swap against pre-approve allowance (0) and reverts.
        if (rhPublicClient) {
          await rhPublicClient.waitForTransactionReceipt({ hash: approveHash, confirmations: 1, timeout: 60_000 });
        }
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

  // Server-side failure to resolve token → show plain error card.
  if (result.error) {
    return (
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 font-mono text-[11px] text-amber-300">
        <div className="font-bold mb-1">Can&apos;t prepare Robinhood swap</div>
        <div className="text-amber-200/80">{result.error}</div>
      </div>
    );
  }
  if (!token) {
    return (
      <div className="rounded-xl border border-slate-700 bg-slate-900/40 p-4 font-mono text-[11px] text-slate-400">
        Missing token address — ask again with the token contract or a symbol I can look up.
      </div>
    );
  }

  // Display-only derived values for the confirm-only layout (#107).
  const amtLabel = Number.isFinite(amt) && amt > 0 ? fmtNum(amt) : "0.0";
  const previewOut = anyLoading ? "…" : (estimatedOut != null ? `≈ ${fmtNum(estimatedOut)}` : "0.0");
  const slipLabel = isT2T ? `${(slippageBps / 100).toFixed(2)}%` : `${slippagePct}%`;
  // USD notional for the Confirm button — only when we have a real price
  // (never fabricate). buy = ETH in, sell = token in, T2T = tokenIn USD.
  const inUsd = isT2T
    ? (t2tQuote?.priceInUsd != null ? amt * t2tQuote.priceInUsd : null)
    : direction === "buy"
      ? (quote?.price?.ethUsd != null ? amt * quote.price.ethUsd : null)
      : (quote?.price?.tokenUsd != null ? amt * quote.price.tokenUsd : null);
  const usdLabel = inUsd != null && Number.isFinite(inUsd) && inUsd > 0
    ? `$${inUsd.toLocaleString("en-US", { maximumFractionDigits: 2 })}`
    : "";

  return (
    <div className="rounded-xl border border-[#1A1A2E] bg-[#0a0a0f] p-4 font-mono text-[11px] text-slate-300 max-w-md">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <TokenGlyph symbol={inSym} />
          <div className="min-w-0">
            <div className="text-white text-[12px] font-bold truncate">
              {isT2T
                ? `Swap ${tokenInSym} → ${tokenSym}`
                : `${direction === "buy" ? "Buy" : "Sell"} ${tokenSym}`} on Robinhood
            </div>
            <div className="text-slate-600 text-[10px]">
              RobinhoodSwapRouter · you sign · non-custodial · 4663
            </div>
          </div>
        </div>
        {!isConnected && <ConnectButton label="Connect" />}
      </div>

      {step === "done" ? (
        <div className="rounded-lg border p-3" style={{ borderColor: "#22C55E40", background: "#22C55E08" }}>
          <div className="font-bold mb-1" style={{ color: "#22C55E" }}>
            ✓ Swap sent to Robinhood Chain
          </div>
          {txHash && (
            <a href={`${RH_EXPLORER}/tx/${txHash}`} target="_blank" rel="noopener noreferrer"
              className="text-[10px] px-2 py-1 rounded-lg border border-[#4FC3F730] text-[#4FC3F7] inline-block mt-1">View tx ↗</a>
          )}
        </div>
      ) : (
        <>
          {/* Confirm-only preview: pay → receive (est). No editable field (#107). */}
          <ConfirmPreview
            left={{ glyph: <TokenGlyph symbol={inSym} />, top: amtLabel, bottom: inSym }}
            right={{ glyph: <TokenGlyph symbol={outSym} />, top: previewOut, bottom: outSym }}
          />

          {/* Quantity-word hint — shows what "all"/"max"/"half"/"N%" resolved to.
              Suppressed once the read has failed: "Resolving your balance…" is a
              promise that an answer is coming, and there is no longer one. The
              banner below says what actually happened and offers the way out. */}
          {q.symbolic && gate !== "unverified" && (
            <div className="text-[9px] text-[#4FC3F7] mb-2">
              {q.value != null ? `${q.word} → ${fmtNum(q.value)} ${inSym}` : "Resolving your balance…"}
            </div>
          )}

          {/* Small meta text: rate · route · slippage · min · balance. */}
          <div className="text-[9px] text-slate-500 mb-2 space-y-1">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate">
                {rate != null ? <>1 {inSym} ≈ {fmtNum(rate)} {outSym}</> : "rate —"}
                {prepRoute === "direct" && <span className="ml-1.5">· direct</span>}
                {prepRoute === "multi-hop" && <span className="ml-1.5">· via WETH</span>}
              </span>
              <span className="shrink-0">Slippage {slipLabel}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="truncate">{minOut != null ? `min ${fmtNum(minOut)} ${outSym}` : ""}</span>
              {balance != null && <span className="shrink-0">Bal {balance.toFixed(5)} {inSym}</span>}
            </div>
            {quote?.pool && (
              <div className="truncate">
                Pool <a href={`${RH_EXPLORER}/address/${quote.pool.address}`} target="_blank" rel="noopener noreferrer"
                  className="text-slate-400 hover:text-slate-200 underline">{quote.pool.address.slice(0, 6)}…{quote.pool.address.slice(-4)}</a>
                {" · "}fee {(quote.pool.fee / 10000).toFixed(2)}%
              </div>
            )}
          </div>

          {/* The balance read failed. Fail-closed: the button is already
              disabled by `gate === "ok"`, so this is the only thing that tells
              the user why — and the retry is the way out of the gate. */}
          {gate === "unverified" && (
            <UnverifiedBalance symbol={inSym} onRetry={() => { void bal.refetch(); }} busy={bal.refetching} />
          )}

          {anyLoading && <p className="text-[9px] text-slate-600 mb-2">Checking pools + prices…</p>}
          {overBalance && <p className="text-[10px] text-red-500 mb-2">Exceeds your {inSym} balance</p>}
          {!isT2T && quote?.ok && quote.hasPool === false && (
            <p className="text-[10px] text-amber-400 mb-2">
              No Uniswap V3 pool for {tokenSym}/WETH on Robinhood Chain yet. The deployer needs to seed one.
            </p>
          )}
          {quote?.error && <p className="text-[10px] text-amber-400 mb-2">Quote error: {quote.error}</p>}
          {isT2T && t2tQuote?.error && (
            <p className="text-[10px] text-amber-400 mb-2">Quote error: {t2tQuote.error}</p>
          )}
          {prepRoute === "none" && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5 mb-2 text-[10px] text-amber-300">
              <div className="font-bold mb-1">No route on Robinhood Chain</div>
              <div className="text-amber-200/80">
                {noRouteMsg || "no direct pool AND no WETH-hopped route for this pair"}
                {". "}
                Try bridging to Base first, or pick a different token.
              </div>
            </div>
          )}
          {step === "error" && prepRoute !== "none" && <p className="text-[10px] text-amber-400 mb-2">{err}</p>}

          <button onClick={doSwap} disabled={!canSwap || busy}
            className="w-full text-[12px] font-bold py-2.5 rounded-lg transition-all disabled:opacity-50"
            style={(!isT2T && direction === "buy") || isT2T
              ? { background: "#22C55E15", color: "#22C55E", border: "1px solid #22C55E40" }
              : { background: "#EF444415", color: "#EF4444", border: "1px solid #EF444440" }}>
            {!isConnected ? "Connect your wallet"
              : busy ? (step === "approving" ? "Approve in wallet…" : "Confirm in wallet…")
              : gate === "unverified" ? "Balance unread"
              : !isT2T && quote?.hasPool === false ? "No pool yet"
              : prepRoute === "none" ? "No route"
              : overBalance ? "Insufficient balance"
              : `Confirm · ${usdLabel || `${amtLabel} ${inSym}`}`}
          </button>
        </>
      )}
    </div>
  );
}
