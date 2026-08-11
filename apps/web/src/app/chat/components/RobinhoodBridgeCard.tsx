"use client";
// Chat card for the `robinhood_bridge` tool. Bridges an ERC-20 (or native ETH)
// between Base (chainId 8453) and Robinhood Chain (chainId 4663) using Relay
// Protocol as the underlying router. Non-custodial:
//   1. POST /api/robinhood/router/bridge-prepare → { tx, approve?, meta }
//   2. If approve is present, the user signs it on the source chain first.
//   3. The user signs the primary deposit tx on the source chain.
//   4. Relay solvers fill the destination chain — we surface the tracker link.
// The server never signs, never holds keys, never touches the funds.

import { useEffect, useState } from "react";
import {
  useAccount, useSwitchChain, useSendTransaction, useReadContract, useBalance, useChainId,
  useWaitForTransactionReceipt,
} from "wagmi";
import { formatUnits, isAddress } from "viem";
import { ConnectButton } from "@/components/ConnectModal";

// Chain metadata — hard-coded rather than reused from viem, so this card has
// no cross-file coupling to the wagmi config. Base blue vs Robinhood green
// matches the accents used elsewhere in the chat (RobinhoodSend/SwapCard).
const CHAINS = {
  base: {
    id:       8453,
    label:    "Base",
    accent:   "#0052FF",
    explorer: "https://basescan.org",
  },
  robinhood: {
    id:       4663,
    label:    "Robinhood",
    accent:   "#34D399",
    explorer: "https://robinhoodchain.blockscout.com",
  },
} as const;
type ChainKey = keyof typeof CHAINS;

// Minimal ERC-20 balanceOf ABI — matches the shape RobinhoodSendCard uses.
const BALANCE_OF_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view",
    inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

/** Marker shape the /api/chat handler emits for `robinhood_bridge`. */
export interface RobinhoodBridgeResult {
  kind:         "robinhood_bridge";
  fromChain?:   "base" | "robinhood";
  toChain?:     "base" | "robinhood";
  fromAddress?: string;
  recipient?:   string;
  /** ERC-20 contract 0x… on `fromChain`, or "ETH" / "NATIVE" for native ETH. */
  token?:       string;
  /** Human-readable amount (decimal string) in whole units. */
  amount?:      string | number;
  /** Optional display hint from the LLM. Server verifies via the token contract. */
  tokenSymbol?: string;
  /** Server-side error to display inline (e.g. bad input, unresolved token). */
  error?:       string;
}

// Shape the /api/robinhood/router/bridge-prepare route returns on success.
type PrepareResponse = {
  ok?:    boolean;
  error?: { code: string; message: string };
  tx?:      { to: `0x${string}`; data: `0x${string}`; value: string; chainId: number };
  approve?: { to: `0x${string}`; data: `0x${string}`; value: string; chainId: number };
  meta?: {
    fromChain:  "base" | "robinhood";
    toChain:    "base" | "robinhood";
    token:      { address: `0x${string}`; symbol: string; decimals: number };
    amountIn:   string;
    amountOut:  string;
    feeBps:     number;
    estFillSeconds: number;
    trackerUrl: string;
    requestId:  string;
    recipient:  `0x${string}`;
    relayerFeeUsd?: string;
    relayerFeeFormatted?: string;
  };
};

function shortAddr(a: string): string {
  return a.length > 10 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

function fmtAmount(raw: string | number | undefined, decimals: number): string {
  if (raw == null || raw === "") return "";
  // If it's a base-units bigint-y string, format it; if it's already decimal, pass through.
  const asStr = String(raw);
  if (/^\d+$/.test(asStr) && asStr.length > 6) {
    try {
      const n = Number(formatUnits(BigInt(asStr), decimals));
      if (Number.isFinite(n)) return n.toLocaleString("en-US", { maximumFractionDigits: 6 });
    } catch { /* fall through */ }
  }
  const n = typeof raw === "number" ? raw : parseFloat(asStr);
  if (!Number.isFinite(n)) return String(raw);
  return n.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

export function RobinhoodBridgeCard({ result }: { result: RobinhoodBridgeResult }) {
  const { address: connected, isConnected } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { sendTransactionAsync } = useSendTransaction();
  const walletChainId = useChainId();

  // Initial state pulled from the marker; the user can swap the direction via
  // the arrow toggle (cosmetic only — a real swap re-fetches the quote).
  const [fromChain, setFromChain] = useState<ChainKey>(
    result.fromChain === "robinhood" ? "robinhood" : "base",
  );
  const [toChain, setToChain] = useState<ChainKey>(
    result.toChain === "base" ? "base" : "robinhood",
  );
  // Keep from/to opposite whenever one flips. The user's swap-direction button
  // is the only way to change either — no dropdowns to keep in sync.
  function toggleDirection() {
    setFromChain(toChain);
    setToChain(fromChain);
  }

  const fromCfg = CHAINS[fromChain];
  const toCfg   = CHAINS[toChain];

  const fromAddress = (result.fromAddress || connected || "") as `0x${string}` | "";
  const recipient   = (result.recipient   || "")           as `0x${string}` | "";
  const rawToken    = (result.token       || "").trim();
  const isNative    = /^(eth|native)$/i.test(rawToken);
  const tokenSymHint = (result.tokenSymbol || "").replace(/^\$/, "");
  const initialAmt   = result.amount != null ? String(result.amount) : "";

  // Editable amount — seeded from LLM's initial value but user can override.
  // The quote fetch effect below re-runs (debounced 250ms) as this changes.
  const [amount, setAmount] = useState(initialAmt);

  const [prep, setPrep]   = useState<PrepareResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [prepErr, setPrepErr] = useState("");
  // States walked in sequence — the button reflects whichever is active.
  const [step, setStep] = useState<
    "idle" | "switching" | "approving" | "sending" | "delivering" | "filled" | "error"
  >("idle");
  const [err, setErr]         = useState("");
  const [approveHash, setApproveHash] = useState<`0x${string}` | "">("");
  const [txHash, setTxHash]           = useState<`0x${string}` | "">("");

  // Balance for the sender on the SOURCE chain — used to show "insufficient
  // balance" before the user signs. ERC-20 for a token address, native for ETH.
  const { data: nativeBal } = useBalance({
    address: fromAddress || undefined,
    chainId: fromCfg.id,
    query:   { enabled: !!fromAddress && isNative },
  });
  const { data: erc20Bal } = useReadContract({
    address:      isNative ? undefined : (isAddress(rawToken) ? (rawToken as `0x${string}`) : undefined),
    abi:          BALANCE_OF_ABI,
    functionName: "balanceOf",
    args:         fromAddress ? [fromAddress] : undefined,
    chainId:      fromCfg.id,
    query:        { enabled: !!fromAddress && !isNative && isAddress(rawToken) },
  });

  const decimals = prep?.meta?.token.decimals ?? 18;
  const symbol   = (prep?.meta?.token.symbol || tokenSymHint || (isNative ? "ETH" : "TOKEN")).replace(/^\$/, "");
  const balance  = isNative
    ? (nativeBal ? Number(formatUnits(nativeBal.value, 18)) : null)
    : (erc20Bal != null ? Number(formatUnits(erc20Bal as bigint, decimals)) : null);
  // Use the EDITABLE amount, not the LLM's initial value — otherwise a user
  // who types 0.001 after LLM guessed "1 ETH" still sees "exceeds balance"
  // even when the new amount is fine.
  const amtNum = parseFloat(amount);
  const overBalance = balance != null && Number.isFinite(amtNum) && amtNum > balance;

  // Watch the primary tx until the SOURCE-chain RPC returns a receipt — that's
  // the point where the funds are handed off to the Relay solvers and the
  // "delivering" state begins on the destination chain.
  const { isSuccess: sentMined, isError: sentMinedErr } = useWaitForTransactionReceipt({
    hash:    txHash || undefined,
    chainId: fromCfg.id,
    query:   { enabled: !!txHash },
  });
  useEffect(() => {
    if (sentMined && step === "sending") setStep("delivering");
    if (sentMinedErr && step === "sending") { setStep("error"); setErr("Source-chain tx reverted."); }
  }, [sentMined, sentMinedErr, step]);

  // Same for the (optional) approve — we bump to "sending" once it's mined.
  const { isSuccess: approveMined, isError: approveMinedErr } = useWaitForTransactionReceipt({
    hash:    approveHash || undefined,
    chainId: fromCfg.id,
    query:   { enabled: !!approveHash },
  });
  useEffect(() => {
    if (approveMined && step === "approving") setStep("idle"); // ready to sign primary
    if (approveMinedErr && step === "approving") { setStep("error"); setErr("Approve tx reverted."); }
  }, [approveMined, approveMinedErr, step]);

  // Poll Relay's status API once we've broadcast the source-chain tx. Docs:
  // GET https://api.relay.link/intents/status/v2?requestId=… → { status: "success" | "pending" | … }
  // On success we flip to "filled". If polling errors, we keep "delivering" and
  // the user still has the tracker link.
  useEffect(() => {
    if (step !== "delivering" || !prep?.meta?.requestId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    async function poll() {
      try {
        const r = await fetch(
          `https://api.relay.link/intents/status/v2?requestId=${encodeURIComponent(prep!.meta!.requestId)}`,
          { cache: "no-store" },
        );
        if (!r.ok) throw new Error(`status ${r.status}`);
        const j = (await r.json()) as { status?: string };
        if (cancelled) return;
        if (j?.status === "success") { setStep("filled"); return; }
        // "waiting" | "pending" | "delayed" — keep polling every 3s.
        timer = setTimeout(poll, 3_000);
      } catch {
        // Silent — user still has the tracker link + explorer to check.
        if (!cancelled) timer = setTimeout(poll, 5_000);
      }
    }
    void poll();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [step, prep]);

  // Fetch a fresh quote whenever the key inputs change. Debounced — swap
  // direction toggles fire two state updates back-to-back and we don't want
  // two Relay requests for a single click.
  useEffect(() => {
    let cancelled = false;
    if (!fromAddress || !rawToken || !amount || fromChain === toChain) {
      setLoading(false);
      setPrepErr(!amount ? "Enter an amount" : "Missing required field — need from/to chain, address, token, amount.");
      return;
    }
    // Reject non-numeric / zero amounts early — no point round-tripping Relay.
    const amtN = Number(amount);
    if (!Number.isFinite(amtN) || amtN <= 0) {
      setLoading(false);
      setPrepErr("Amount must be a positive number.");
      return;
    }
    setLoading(true); setPrepErr(""); setPrep(null);
    const t = setTimeout(async () => {
      try {
        const r = await fetch("/api/robinhood/router/bridge-prepare", {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fromChain, toChain, fromAddress,
            recipient: recipient || fromAddress,
            token:  rawToken,
            amount,
          }),
        });
        const j = (await r.json()) as PrepareResponse;
        if (cancelled) return;
        if (!j.ok || !j.tx) {
          setPrepErr(j.error?.message || `Prepare failed (${r.status})`);
        } else {
          setPrep(j);
        }
      } catch (e) {
        if (!cancelled) setPrepErr((e as Error).message || "Prepare failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 350);
    return () => { cancelled = true; clearTimeout(t); };
  }, [fromChain, toChain, fromAddress, recipient, rawToken, amount]);

  const wrongChain = isConnected && walletChainId !== fromCfg.id;
  const needsApprove = !!prep?.approve && !approveHash;

  const canSign = !!prep?.tx && !prepErr && !loading && !overBalance
    && step !== "switching" && step !== "approving" && step !== "sending" && step !== "delivering";
  const busy = step === "switching" || step === "approving" || step === "sending" || step === "delivering";

  async function switchToFromChain() {
    setStep("switching"); setErr("");
    try {
      await switchChainAsync({ chainId: fromCfg.id });
      setStep("idle");
    } catch {
      setStep("error");
      setErr(`Switch to ${fromCfg.label} Chain (${fromCfg.id}) and try again`);
    }
  }

  async function doApprove() {
    if (!prep?.approve) return;
    setErr(""); setStep("approving");
    try {
      // If the wallet is on the wrong chain, this call throws — we catch it
      // and prompt for a switch instead of surfacing a raw wagmi error.
      if (walletChainId !== fromCfg.id) {
        try { await switchChainAsync({ chainId: fromCfg.id }); }
        catch { throw new Error(`Switch to ${fromCfg.label} Chain (${fromCfg.id}) and try again`); }
      }
      const hash = await sendTransactionAsync({
        to:      prep.approve.to,
        data:    prep.approve.data,
        value:   BigInt(prep.approve.value),
        chainId: prep.approve.chainId,
      });
      setApproveHash(hash);
      // Wait for the useWaitForTransactionReceipt effect to flip us back to idle.
    } catch (e) {
      const m = (e as Error).message || String(e);
      const cancelled = /user rejected|denied|cancell?ed/i.test(m);
      setErr(cancelled ? "Approve cancelled." : m.slice(0, 200));
      setStep("error");
    }
  }

  async function doSend() {
    if (!prep?.tx || !prep?.meta) { setErr("Nothing to send yet"); setStep("error"); return; }
    if (!isConnected || !connected) { setErr("Connect your wallet"); setStep("error"); return; }
    setErr(""); setStep("sending");
    try {
      if (walletChainId !== fromCfg.id) {
        try { await switchChainAsync({ chainId: fromCfg.id }); }
        catch { throw new Error(`Switch to ${fromCfg.label} Chain (${fromCfg.id}) and try again`); }
      }
      const hash = await sendTransactionAsync({
        to:      prep.tx.to,
        data:    prep.tx.data,
        value:   BigInt(prep.tx.value),
        chainId: prep.tx.chainId,
      });
      setTxHash(hash);
      // step flips to "delivering" once the source-chain receipt is mined.
    } catch (e) {
      const m = (e as Error).message || String(e);
      const cancelled = /user rejected|denied|cancell?ed/i.test(m);
      setErr(cancelled ? "Send cancelled." : m.slice(0, 200));
      setStep("error");
    }
  }

  // Server-side field-shape failure — render a plain amber card, matching the
  // sibling swap/send-card error styling exactly. Never invent a fix here.
  if (result.error) {
    return (
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 font-mono text-[11px] text-amber-300">
        <div className="font-bold mb-1">Can&apos;t prepare bridge</div>
        <div className="text-amber-200/80">{result.error}</div>
      </div>
    );
  }

  const amountOutDisplay = prep?.meta
    ? fmtAmount(prep.meta.amountOut, prep.meta.token.decimals || decimals)
    : "";
  const shortRecipient = (recipient || fromAddress) ? shortAddr(recipient || fromAddress) : "";

  return (
    <div className="rounded-xl border border-[#1A1A2E] bg-[#0a0a0f] p-4 font-mono text-[11px] text-slate-300 max-w-md">
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="text-white text-[12px] font-bold flex items-center gap-1.5">
            {/* From glyph */}
            <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: fromCfg.accent }} />
            <span>{fromCfg.label}</span>
            <span className="text-slate-500">→</span>
            <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: toCfg.accent }} />
            <span>{toCfg.label}</span>
            <button
              onClick={toggleDirection}
              disabled={busy}
              title="Swap direction"
              className="ml-2 px-1.5 py-0.5 text-[10px] rounded border border-[#1A1A2E] text-slate-400 hover:text-slate-200 disabled:opacity-40"
            >
              ⇅
            </button>
          </div>
          <div className="text-slate-600 text-[10px]">
            via Relay Protocol · you sign · non-custodial
          </div>
        </div>
        {!isConnected && <ConnectButton label="Connect" />}
      </div>

      {step === "filled" ? (
        <div className="rounded-lg border p-3" style={{ borderColor: "#34D39940", background: "#34D39908" }}>
          <div className="font-bold mb-1" style={{ color: "#34D399" }}>
            Bridged {fmtAmount(initialAmt, 18)} {symbol} to {toCfg.label}
          </div>
          <div className="flex gap-2 flex-wrap mt-1">
            {txHash && (
              <a href={`${fromCfg.explorer}/tx/${txHash}`} target="_blank" rel="noopener noreferrer"
                className="text-[10px] px-2 py-1 rounded-lg border border-[#34D39940] text-[#34D399] inline-block">
                Source tx ↗
              </a>
            )}
            {prep?.meta?.trackerUrl && (
              <a href={prep.meta.trackerUrl} target="_blank" rel="noopener noreferrer"
                className="text-[10px] px-2 py-1 rounded-lg border border-[#34D39940] text-[#34D399] inline-block">
                Relay tracker ↗
              </a>
            )}
          </div>
        </div>
      ) : (
        <>
          {/* Amount row */}
          <div className="rounded-lg border border-[#1A1A2E] bg-[#050508] p-2.5 mb-2">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[9px] text-slate-600">YOU PAY (on {fromCfg.label})</span>
              {balance != null && (
                <span className="text-[9px] text-slate-600">
                  Bal {balance.toFixed(5)} {symbol}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <input
                type="text"
                inputMode="decimal"
                value={amount}
                onChange={(e) => {
                  // Allow digits + one decimal point; strip anything else so a
                  // stray letter can't wedge the quote effect. Empty is fine —
                  // the effect will show "Enter an amount".
                  const cleaned = e.target.value.replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1");
                  setAmount(cleaned);
                }}
                disabled={busy}
                placeholder="0.0"
                className="flex-1 min-w-0 bg-transparent text-[15px] text-white outline-none placeholder:text-slate-700 disabled:opacity-60"
              />
              {balance != null && balance > 0 && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setAmount(balance.toString())}
                  className="px-1.5 py-0.5 text-[9px] rounded border border-[#7ED4C840] text-[#7ED4C8] hover:bg-[#7ED4C812] disabled:opacity-40"
                >
                  MAX
                </button>
              )}
              <span className="text-[10px] text-slate-200 px-2 py-1 border border-[#1A1A2E] rounded-lg">{symbol}</span>
            </div>
            {overBalance && (
              <div className="text-[9px] text-red-500 mt-1">Exceeds your {symbol} balance on {fromCfg.label}</div>
            )}
          </div>

          {/* Quote panel */}
          <div className="rounded-lg border border-[#1A1A2E] bg-[#050508] p-2.5 mb-2">
            <div className="text-[9px] text-slate-600 mb-1">EST. RECEIVE (on {toCfg.label})</div>
            <div className="flex items-center gap-2">
              <div className="flex-1 text-[15px] text-white w-0 truncate">
                {loading ? <span className="text-slate-600">…</span>
                  : amountOutDisplay || <span className="text-slate-700">0.0</span>}
              </div>
              <span className="text-[10px] text-slate-200 px-2 py-1 border border-[#1A1A2E] rounded-lg">{symbol}</span>
            </div>
            {prep?.meta && (
              <div className="text-[9px] text-slate-500 mt-1.5 flex items-center justify-between">
                {/* Show the actual relayer fee amount instead of a derived bps
                    figure — Relay's amountUsd field is often missing/unreliable
                    for volatile tokens and the bps calc was falling back to raw
                    ETH ratios (50%+ nonsense). Amount in the token is truthful. */}
                <span>
                  Relayer fee
                  {prep.meta.relayerFeeFormatted
                    ? <> ≈ {prep.meta.relayerFeeFormatted} {symbol}
                        {prep.meta.relayerFeeUsd && <span className="text-slate-600"> (${(+prep.meta.relayerFeeUsd).toFixed(2)})</span>}
                      </>
                    : <span className="text-slate-600"> — unknown</span>}
                </span>
                <span>Est. fill ~{prep.meta.estFillSeconds}s</span>
              </div>
            )}
          </div>

          {/* Recipient — shown when explicit or when it differs from sender */}
          {shortRecipient && recipient && recipient.toLowerCase() !== fromAddress.toLowerCase() && (
            <div className="rounded-lg border border-[#1A1A2E] bg-[#050508] p-2.5 mb-2">
              <div className="text-[9px] text-slate-600 mb-1">RECIPIENT (on {toCfg.label})</div>
              <div className="text-[12px] text-white truncate">{shortRecipient}</div>
            </div>
          )}

          {loading && <p className="text-[9px] text-slate-600 mb-2">Fetching Relay quote…</p>}
          {!loading && prepErr && <p className="text-[10px] text-amber-400 mb-2">{prepErr}</p>}
          {wrongChain && !busy && (
            <p className="text-[10px] text-amber-400 mb-2">
              Wallet is on chain {walletChainId} — bridge sends from {fromCfg.label} ({fromCfg.id}).
            </p>
          )}
          {step === "delivering" && (
            <p className="text-[10px] text-slate-400 mb-2">
              Source tx mined — waiting for Relay solvers to fill on {toCfg.label}…
            </p>
          )}
          {step === "error" && <p className="text-[10px] text-amber-400 mb-2">{err}</p>}

          {/* Primary button — three cascading actions:
              1. Switch chain (if wrong).
              2. Approve (if approve tx exists and not yet signed).
              3. Sign & Bridge (primary deposit tx).
              Only one is rendered — the earliest not-yet-done step. */}
          <button
            onClick={
              !isConnected  ? undefined
              : wrongChain  ? switchToFromChain
              : needsApprove ? doApprove
              : doSend
            }
            disabled={!isConnected ? false : (wrongChain ? busy : (!canSign || busy))}
            className="w-full text-[12px] font-bold py-2.5 rounded-lg transition-all disabled:opacity-50"
            style={{ background: "#34D39915", color: "#34D399", border: "1px solid #34D39940" }}
          >
            {!isConnected ? "Connect your wallet"
              : loading   ? "Fetching quote…"
              : prepErr   ? "Retry"
              : busy && step === "switching"  ? `Switching to ${fromCfg.label}…`
              : busy && step === "approving"  ? "Approving in wallet…"
              : busy && step === "sending"    ? "Confirm in wallet…"
              : busy && step === "delivering" ? "Delivering on destination…"
              : wrongChain    ? `Switch to ${fromCfg.label}`
              : overBalance   ? "Insufficient balance"
              : needsApprove  ? `Approve ${symbol}`
              : `Bridge ${fmtAmount(initialAmt, 18)} ${symbol} → ${toCfg.label}`}
          </button>

          {/* Tracker link is always available once the primary tx is broadcast,
              even if the polling logic can't reach Relay for some reason. In
              this branch TypeScript has already narrowed step ≠ "filled". */}
          {txHash && prep?.meta?.trackerUrl && (
            <div className="mt-2 flex justify-end">
              <a href={prep.meta.trackerUrl} target="_blank" rel="noopener noreferrer"
                className="text-[10px] text-slate-500 hover:text-slate-300 underline">
                open Relay tracker ↗
              </a>
            </div>
          )}
        </>
      )}
    </div>
  );
}
