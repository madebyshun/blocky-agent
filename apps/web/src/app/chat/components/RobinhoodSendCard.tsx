"use client";
// Chat card for the `robinhood_send` tool. Sends ERC-20 or native ETH on
// Robinhood Chain (chainId 4663) from the connected wallet. Non-custodial:
//   1. POST /api/robinhood/router/send-prepare → { to, data, value, chainId }
//   2. User signs the tx in their own wallet (wagmi useSendTransaction).
//   3. useWaitForTransactionReceipt watches the RH RPC for the mined receipt.
// The server never signs, never holds keys, never touches the funds.

import { useEffect, useState } from "react";
import {
  useAccount, useSwitchChain, useSendTransaction,
  useWaitForTransactionReceipt,
} from "wagmi";
import { isAddress } from "viem";
import { ConnectButton } from "@/components/ConnectModal";
import { TokenGlyph, AddrGlyph, ConfirmPreview, resolveQuantity } from "./ConfirmCardParts";
import { UnverifiedBalance } from "@/components/wallet/UnverifiedBalance";
import { useSpendableBalance } from "@/lib/wallet/useSpendableBalance";
import { resolveSpend } from "@/lib/wallet/read-state";

const RH_CHAIN_ID = 4663;
const RH_EXPLORER = "https://robinhoodchain.blockscout.com";

/** Marker shape the /api/chat handler emits for `robinhood_send`. */
export interface RobinhoodSendResult {
  kind: "robinhood_send";
  fromAddress?: string;
  toAddress?: string;
  /** ERC-20 contract 0x…, or "ETH" / "NATIVE" for native ETH. */
  token?: string;
  /** Human-readable amount (decimal string). */
  amount?: string | number;
  /** Optional display hint from the LLM. Server verifies via the token contract. */
  tokenSymbol?: string;
  /** Server-side note, e.g. "resolved via …" (unused today, kept for parity with swap card). */
  note?: string;
  /** Server-side error to display inline (e.g. unresolved token). */
  error?: string;
}

// Shape the /api/robinhood/router/send-prepare route returns.
type PrepareResponse = {
  ok?: boolean;
  error?: string;
  tx?: { to: `0x${string}`; data: `0x${string}`; value: string; chainId: number };
  meta?: {
    kind:      "native" | "erc20";
    from:      `0x${string}`;
    recipient?:`0x${string}`;
    token?:    `0x${string}`;
    symbol:    string;
    decimals:  number;
    amount:    string;
    amountWei: string;
    chainId:   number;
  };
};

function shortAddr(a: string): string {
  return a.length > 10 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

function fmtAmount(raw: string | number | undefined): string {
  if (raw == null || raw === "") return "";
  const n = typeof raw === "number" ? raw : parseFloat(raw);
  if (!Number.isFinite(n)) return String(raw);
  return n.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

export function RobinhoodSendCard({ result }: { result: RobinhoodSendResult }) {
  const { address: connected, isConnected } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { sendTransactionAsync } = useSendTransaction();

  // Prefer the address the LLM handed us — it's the intent's "from" — but fall
  // back to whatever wallet the user has connected. Every path validates that
  // the signer address matches meta.from before we hand off to the wallet.
  const fromAddress = (result.fromAddress || connected || "") as `0x${string}` | "";
  const toAddress   = (result.toAddress   || "")           as `0x${string}` | "";
  const token       = (result.token       || "").trim();
  const isNative    = /^(eth|native)$/i.test(token);
  const tokenSymHint = (result.tokenSymbol || "").replace(/^\$/, "");
  const initialAmt = result.amount != null ? String(result.amount) : "";

  const [prep, setPrep]   = useState<PrepareResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [prepErr, setPrepErr] = useState("");
  const [step, setStep]   = useState<"idle" | "signing" | "broadcasting" | "mined" | "error">("idle");
  const [err, setErr]     = useState("");
  const [txHash, setTxHash] = useState<`0x${string}` | "">("");

  // Balance for the sender — ETH for native, ERC-20 balanceOf otherwise. Used
  // to show "insufficient balance" before the user signs and pays gas for a
  // guaranteed-fail tx.
  //
  // The read lives in `useSpendableBalance` rather than here because this card
  // was one of three that hand-rolled it and one of three that got it wrong the
  // same way. It also reads `decimals` ON-CHAIN, which is the fix to what stood
  // on this line:
  //
  //     const decimals = prep?.meta?.decimals ?? (isNative ? 18 : 18);
  //
  // — a ternary whose two branches are the same number, deferring to a `prep`
  // that cannot possibly have arrived: prepare is gated on `amount`, and for a
  // quantity word `amount` is resolved FROM this balance. Circular, so the
  // "fallback" was the value every time, and USDG (6 decimals, the chain's
  // cash) read 1e12× short.
  const bal = useSpendableBalance({ holder: fromAddress, native: isNative, token, chainId: RH_CHAIN_ID });
  const balance = bal.balance;

  const symbol = (prep?.meta?.symbol || tokenSymHint || (isNative ? "ETH" : "TOKEN")).replace(/^\$/, "");

  // The amount may be a quantity word ("all"/"max"/"half"/"N%") — resolve it
  // against the balance we just read (#138). Native ETH keeps a small gas
  // reserve; ERC-20 uses the full balance (gas is paid in ETH, separately).
  // While a word is still resolving (balance loading) `amount` is "" and we
  // WAIT rather than firing prepare with an unresolvable value.
  const q = resolveQuantity(initialAmt, balance, { isNative });
  // Non-symbolic → the LLM's exact string (the server's amount regex rejects an
  // exponential re-format like "1e-7", so never round-trip a plain number). The
  // send-prepare route converts to base units with the token's own decimals.
  const amount = q.symbolic ? (q.value != null ? String(q.value) : "") : initialAmt;
  const amtDisplay = q.value != null
    ? fmtAmount(q.value)
    : (q.symbolic ? "…" : fmtAmount(initialAmt));
  // ── May this card let the user sign? ───────────────────────────────────────
  //
  // THREE outcomes, not two. What used to stand here was
  //
  //     const overBalance = balance != null && q.value != null && q.value > balance;
  //
  // which is fail-OPEN: `balance` is null both while the read is in flight and
  // when it failed outright, so a failed read made the guard false, enabled the
  // button, and sent the user to pay gas for a tx that cannot settle — the exact
  // thing the comment above says this read is for. `unverified` is fail-closed
  // and comes with a Retry; see `resolveSpend` in lib/wallet/read-state.ts.
  const gate = resolveSpend({
    loading:  bal.loading,
    received: bal.received,
    failed:   bal.failed,
    over:     balance != null && q.value != null && q.value > balance,
  });
  const overBalance = gate === "insufficient";

  // Kick off the prepare fetch on mount. We only re-run when the incoming
  // marker changes, not on every render — the LLM emits the result once per
  // tool call and the card lifecycle owns the tx flow from there.
  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!fromAddress || !toAddress || !token) {
        setLoading(false);
        setPrepErr("Missing required field — need from, to, and token.");
        return;
      }
      if (!amount) {
        // A quantity word ("all"/"max"/…) that has not resolved. Two reasons,
        // and they are not the same: the balance is still loading (wait — an
        // answer is coming), or the balance read FAILED (stop — it is not).
        // Waiting on the second left the card on "Preparing…" forever with no
        // error and no way out, which is the permanent-spinner defect this
        // codebase has now fixed in four places.
        setLoading(gate === "reading");
        setPrepErr("");
        return;
      }
      setLoading(true);
      setPrepErr("");
      try {
        const r = await fetch("/api/robinhood/router/send-prepare", {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fromAddress, toAddress, token,
            amount: String(amount),
          }),
        });
        const j = (await r.json()) as PrepareResponse;
        if (cancelled) return;
        if (!r.ok || !j.ok || !j.tx) {
          setPrepErr(j.error || `Prepare failed (${r.status})`);
        } else {
          setPrep(j);
        }
      } catch (e) {
        if (!cancelled) setPrepErr((e as Error).message || "Prepare failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void run();
    return () => { cancelled = true; };
    // `gate` is a dep because the unresolved-amount branch above now reads it:
    // a Retry that turns a failed read into a good one must clear the spinner.
  }, [fromAddress, toAddress, token, amount, gate]);

  // Watch the tx until the RPC returns a receipt. `isSuccess` flips to true
  // once mined; we transition the card to the final state at that point.
  const { isSuccess: mined, isError: minedErr } = useWaitForTransactionReceipt({
    hash:    txHash || undefined,
    chainId: RH_CHAIN_ID,
    query:   { enabled: !!txHash },
  });
  useEffect(() => {
    if (mined && step === "broadcasting") setStep("mined");
    if (minedErr && step === "broadcasting") { setStep("error"); setErr("Transaction reverted on-chain."); }
  }, [mined, minedErr, step]);

  // `gate === "ok"` subsumes the old `!overBalance` AND closes the hole beside
  // it: "unverified" no longer falls through to enabled.
  const canSend = !!prep?.tx && !prepErr && !loading && gate === "ok" && step !== "signing" && step !== "broadcasting";
  const busy    = step === "signing" || step === "broadcasting";

  async function doSend() {
    if (!isConnected || !connected) { setErr("Connect your wallet"); setStep("error"); return; }
    if (!prep?.tx || !prep?.meta) { setErr("Nothing to send yet"); setStep("error"); return; }
    // Make sure the wallet's active address matches the intent's from — if the
    // user connected a different wallet than the one the message referenced,
    // fail loudly instead of silently sending from the wrong account.
    if (connected.toLowerCase() !== prep.meta.from.toLowerCase()) {
      setErr(`Connected wallet ${shortAddr(connected)} doesn't match the sender ${shortAddr(prep.meta.from)}.`);
      setStep("error");
      return;
    }
    setErr(""); setTxHash("");
    try {
      try {
        await switchChainAsync({ chainId: RH_CHAIN_ID });
      } catch {
        throw new Error("Switch to Robinhood Chain (4663) and try again");
      }
      setStep("signing");
      const hash = await sendTransactionAsync({
        to:      prep.tx.to,
        data:    prep.tx.data,
        value:   BigInt(prep.tx.value),
        chainId: RH_CHAIN_ID,
      });
      setTxHash(hash);
      setStep("broadcasting");
    } catch (e) {
      const m = (e as Error).message || String(e);
      const cancelled = /user rejected|denied|cancell?ed/i.test(m);
      setErr(cancelled ? "Send cancelled." : m.slice(0, 200));
      setStep("error");
    }
  }

  // Server-side or field-shape failure — render a plain amber card, matching
  // the swap-card's error styling exactly. Never invent a fix here.
  if (result.error) {
    return (
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 font-mono text-[11px] text-amber-300">
        <div className="font-bold mb-1">Can&apos;t prepare Robinhood send</div>
        <div className="text-amber-200/80">{result.error}</div>
      </div>
    );
  }

  const shortTo = toAddress ? shortAddr(toAddress) : "";

  return (
    <div className="rounded-xl border border-[#1A1A2E] bg-[#0a0a0f] p-4 font-mono text-[11px] text-slate-300 max-w-md">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <TokenGlyph symbol={symbol} />
          <div className="min-w-0">
            <div className="text-white text-[12px] font-bold truncate">
              Send {amtDisplay} {symbol}
            </div>
            <div className="text-slate-600 text-[10px]">
              Robinhood Chain · you sign · non-custodial · 4663
            </div>
          </div>
        </div>
        {!isConnected && <ConnectButton label="Connect" />}
      </div>

      {step === "mined" ? (
        <div className="rounded-lg border p-3" style={{ borderColor: "#34D39940", background: "#34D39908" }}>
          <div className="font-bold mb-1" style={{ color: "#34D399" }}>
            Sent {amtDisplay} {symbol} to {shortTo}
          </div>
          {txHash && (
            <a href={`${RH_EXPLORER}/tx/${txHash}`} target="_blank" rel="noopener noreferrer"
              className="text-[10px] px-2 py-1 rounded-lg border border-[#34D39940] text-[#34D399] inline-block mt-1">
              View tx ↗
            </a>
          )}
        </div>
      ) : (
        <>
          {/* Confirm-only preview: amount → recipient. No editable field (#107). */}
          <ConfirmPreview
            left={{
              glyph: <TokenGlyph symbol={symbol} />,
              top: amtDisplay || "0.0",
              bottom: symbol,
            }}
            right={{
              glyph: <AddrGlyph address={toAddress} />,
              top: shortTo || "—",
              bottom: "recipient",
            }}
          />

          {/* Quantity-word hint — shows what "all"/"max"/"half"/"N%" resolved to.
              "Resolving…" is now only claimed while a read is actually running;
              on a failed read the banner below says so instead of promising an
              answer that is not coming. */}
          {q.symbolic && gate !== "unverified" && (
            <div className="text-[9px] text-[#34D399] mb-2">
              {q.value != null ? `${q.word} → ${fmtAmount(q.value)} ${symbol}` : "Resolving your balance…"}
            </div>
          )}

          {/* Small meta: sender + balance. */}
          <div className="text-[9px] text-slate-500 mb-2 flex items-center justify-between gap-2">
            <span className="truncate">From {fromAddress ? shortAddr(fromAddress) : "—"}</span>
            {balance != null && <span className="shrink-0">Bal {balance.toFixed(5)} {symbol}</span>}
          </div>

          {/* The third gate outcome, and the way out of it. */}
          {gate === "unverified" && (
            <UnverifiedBalance symbol={symbol} onRetry={() => { void bal.refetch(); }} busy={bal.refetching} />
          )}
          {overBalance && <p className="text-[10px] text-red-500 mb-2">Exceeds your {symbol} balance</p>}
          {loading && <p className="text-[9px] text-slate-600 mb-2">Preparing transaction…</p>}
          {!loading && prepErr && <p className="text-[10px] text-amber-400 mb-2">{prepErr}</p>}
          {step === "broadcasting" && (
            <p className="text-[10px] text-slate-400 mb-2">Broadcasting… waiting for the block.</p>
          )}
          {step === "error" && <p className="text-[10px] text-amber-400 mb-2">{err}</p>}

          <button onClick={doSend} disabled={!canSend || busy}
            className="w-full text-[12px] font-bold py-2.5 rounded-lg transition-all disabled:opacity-50"
            style={{ background: "#34D39915", color: "#34D399", border: "1px solid #34D39940" }}>
            {!isConnected
              ? "Connect your wallet"
              // `busy` outranks the gate: once a signature is sitting in the
              // wallet, the most specific true thing is that a tx is in flight,
              // and a background re-read that flips to `failed` must not
              // relabel a live broadcast as a balance problem.
              : busy
                ? (step === "signing" ? "Confirm in wallet…" : "Broadcasting…")
                : gate === "unverified"
                  ? "Balance unread"
                  : loading
                    ? "Preparing…"
                    : prepErr
                      ? "Retry"
                      : overBalance
                        ? "Insufficient balance"
                        : `Confirm · Send ${amtDisplay} ${symbol}`}
          </button>
        </>
      )}
    </div>
  );
}
