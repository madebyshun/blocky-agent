"use client";

// Public payment-request page — the shareable surface of BlueBank scan-to-pay.
// A payee turns a Receive request into a link (/pay/<address>?amount=&asset=&network=)
// and sends it over Telegram/Zalo/etc. The payer lands here, connects their own
// wallet, and signs the transfer through the same non-custodial SendCard the
// dashboard uses. No amount editing of the payee — the link fixes who gets paid.

import { Suspense, useState, type ReactNode } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { useAccount, useSendTransaction, useSwitchChain } from "wagmi";
import { useWallet } from "@/hooks/useWallet";
import { isAddress } from "viem";
import { QRCodeSVG } from "qrcode.react";
import { SendCard } from "@/app/chat/components/ToolCards";
import { useBasename, shortAddr } from "@/lib/useBasename";
import { buildPaymentUri } from "@/lib/payment-qr";
import { YIELD_NETWORKS, type YieldNetwork } from "@/lib/yield-execution";
import { isOrderId, findOrder, markPaid, B20_ENABLED, B20_USDC } from "@/lib/orders";
import { encodeTransferWithMemo } from "@/lib/b20/encode";

const isName = (s: string) => /^[a-z0-9-]+(\.[a-z0-9-]+)*\.(base|eth)$/i.test(s);

export default function PayPage() {
  return (
    <Suspense fallback={<PayShell><div className="font-mono text-[11px] text-slate-600 text-center">Loading payment request…</div></PayShell>}>
      <PayInner />
    </Suspense>
  );
}

function PayInner() {
  const params = useParams<{ address: string }>();
  const search = useSearchParams();

  const to = decodeURIComponent(params?.address ?? "").trim();
  const valid = isAddress(to) || isName(to);
  const toAddr = isAddress(to) ? (to as `0x${string}`) : undefined;

  const amount = search.get("amount") ?? undefined;
  const asset: "USDC" | "ETH" = (search.get("asset") ?? "USDC").toUpperCase() === "ETH" ? "ETH" : "USDC";
  const network: YieldNetwork = search.get("network") === "baseSepolia" ? "baseSepolia" : "base";
  const label = search.get("label") ?? search.get("for") ?? undefined;

  // Reverse-resolve a Basename for a nicer "you're paying" header (address links).
  const { name } = useBasename(toAddr);
  const payeeLabel = isName(to) ? to : (name || shortAddr(to));

  const { address, isConnected } = useAccount();
  const payer = address as `0x${string}` | undefined;

  const net = YIELD_NETWORKS[network];
  const hasAmount = !!amount && parseFloat(amount) > 0;

  // EIP-681 URI for the QR / "open in wallet" path. Only address links produce a
  // valid URI; name links fall back to the connect-and-pay path (SendCard resolves).
  const uri = toAddr ? buildPaymentUri({ to: toAddr, amount: amount ?? "", asset, network }) : "";
  const isDeepLink = uri.startsWith("ethereum:");

  const [copied, setCopied] = useState(false);
  function copyAddr() {
    navigator.clipboard?.writeText(to).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  }

  // Order / invoice payment link (/pay/order-… or /pay/INV-…) — settled in B20 USDC.
  if (isOrderId(to)) return <PayShell><OrderPay id={to} payToParam={search.get("to") ?? undefined} amountParam={amount} label={label} /></PayShell>;

  if (!valid) {
    return (
      <PayShell>
        <div className="text-center">
          <div className="font-mono text-[13px] text-red-400 mb-1">Invalid payment link</div>
          <div className="font-mono text-[10px] text-slate-600 break-all">&ldquo;{to || "(empty)"}&rdquo; isn&apos;t a Base address or name.base.</div>
        </div>
      </PayShell>
    );
  }

  return (
    <PayShell>
      {/* Payee + requested amount */}
      <div className="text-center mb-5">
        <div className="font-mono text-[10px] text-slate-500 tracking-widest mb-1">YOU&apos;RE PAYING</div>
        <div className="font-mono text-[18px] font-bold text-white">{payeeLabel}</div>
        {hasAmount && (
          <div className="font-mono text-[26px] font-bold text-[#34D399] mt-1.5">{amount} <span className="text-base text-slate-500">{asset}</span></div>
        )}
        {label && <div className="font-mono text-[11px] text-slate-400 mt-1.5">for &ldquo;{label}&rdquo;</div>}
        <div className="font-mono text-[9px] text-slate-600 mt-2 break-all px-2">{to}</div>
      </div>

      {/* Primary — connect & pay in-page (non-custodial; payer signs) */}
      {isConnected && payer
        ? <SendCard result={{ to, amount, asset, network }} account={payer} />
        : <PayConnect />}

      {/* Secondary — scan / open in any EIP-681 wallet (address links only) */}
      {uri && (
        <div className="mt-5 pt-4 border-t border-[#1A1A2E]">
          <div className="font-mono text-[9px] text-slate-600 tracking-widest mb-3 text-center">OR PAY WITH ANY WALLET</div>
          <div className="flex flex-col items-center">
            <div className="bg-white p-2.5 rounded-xl">
              <QRCodeSVG value={uri} size={150} bgColor="#ffffff" fgColor="#0a0a0f" level="M" />
            </div>
            <div className="flex items-center gap-2 mt-3">
              {isDeepLink && (
                <a href={uri} className="font-mono text-[11px] px-4 py-2 rounded-lg" style={{ background: "#4FC3F710", color: "#4FC3F7", border: "1px solid #4FC3F730" }}>
                  Open in wallet ↗
                </a>
              )}
              <button onClick={copyAddr} className="font-mono text-[11px] px-4 py-2 rounded-lg" style={{ background: "#0d0d12", color: "#94a3b8", border: "1px solid #1A1A2E" }}>
                {copied ? "✓ Copied" : "Copy address"}
              </button>
            </div>
            <div className="font-mono text-[9px] text-slate-600 mt-2">{net.label} · USDC / ETH on Base</div>
          </div>
        </div>
      )}
    </PayShell>
  );
}

// Public order/invoice payment screen. Settles in B20 USDC via transferWithMemo
// (memo = the order id) once B20 mainnet is live; the indexed Memo event lets the
// merchant's dashboard flip the request to Paid when the matching payment lands.
function OrderPay({ id, payToParam, amountParam, label }: {
  id: string;
  payToParam?: string;
  amountParam?: string;
  label?: string;
}) {
  const order = findOrder(id); // present when opened on the merchant's device
  const kind = id.toUpperCase().startsWith("INV") ? "Invoice" : "Order";

  // Local order copy wins; otherwise fall back to the self-contained link params.
  const payTo  = order?.payTo ?? payToParam;
  const amount = order?.amount ?? (amountParam ? Number(amountParam) : undefined);
  const desc   = order?.description ?? label;

  const { address, isConnected, chainId } = useAccount();
  const { sendTransactionAsync } = useSendTransaction();
  const { switchChainAsync } = useSwitchChain();

  const [sending, setSending] = useState(false);
  const [err, setErr] = useState("");
  const [txHash, setTxHash] = useState("");

  const paid    = order?.status === "paid" || !!txHash;
  const finalTx = txHash || order?.txHash;

  const tokenReady     = isAddress(B20_USDC);
  const recipientReady = !!payTo && isAddress(payTo);
  const amountReady    = typeof amount === "number" && amount > 0;

  async function pay() {
    if (!B20_ENABLED || !tokenReady || !payTo || !amountReady || amount === undefined) return;
    setSending(true); setErr("");
    try {
      if (chainId !== 8453) {
        try { await switchChainAsync({ chainId: 8453 }); }
        catch { throw new Error("Switch your wallet to Base mainnet and try again."); }
      }
      const data = encodeTransferWithMemo({ to: payTo, amount, decimals: 6, memo: id });
      const hash = await sendTransactionAsync({
        to: B20_USDC as `0x${string}`, data, value: 0n, chainId: 8453,
      });
      markPaid(id, hash); // flips the local copy; cross-device flips via the Memo watcher
      setTxHash(hash);
    } catch (e) {
      setErr(friendlyB20Error((e as Error).message));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="text-center">
      <div className="font-mono text-[10px] text-slate-500 tracking-widest mb-1">{kind.toUpperCase()} PAYMENT</div>
      <div className="font-mono text-[14px] font-bold text-white break-all">#{id}</div>

      {amountReady ? (
        <>
          <div className="font-mono text-[26px] font-bold text-[#34D399] mt-2">${amount?.toLocaleString()} <span className="text-base text-slate-500">USDC</span></div>
          {desc && <div className="font-mono text-[11px] text-slate-400 mt-1.5">{desc}</div>}
          {order?.client && <div className="font-mono text-[10px] text-slate-600 mt-1">Billed to {order.client}</div>}
          {order?.dueDate && <div className="font-mono text-[10px] text-slate-600 mt-0.5">Due {order.dueDate}</div>}
        </>
      ) : (
        <div className="font-mono text-[11px] text-slate-500 mt-3 leading-relaxed">This request was created on another device — the amount is set by the merchant.</div>
      )}

      <div className="mt-5">
        {paid ? (
          <div className="rounded-xl p-3 font-mono text-[12px] text-[#34D399]" style={{ border: "1px solid #34D39930", background: "#34D3990d" }}>
            {kind} paid ✓
            {finalTx && <a href={`https://basescan.org/tx/${finalTx}`} target="_blank" rel="noopener noreferrer" className="block font-mono text-[10px] text-slate-500 mt-1">tx ↗</a>}
          </div>
        ) : !B20_ENABLED ? (
          <button disabled className="w-full font-mono text-[12px] font-bold py-2.5 rounded-xl opacity-60 cursor-not-allowed"
            style={{ background: "#1A1A2E", color: "#94a3b8" }}>
            B20 payments go live June 25
          </button>
        ) : !tokenReady ? (
          <div className="font-mono text-[10px] text-slate-500 leading-relaxed rounded-xl p-3" style={{ border: "1px solid #1A1A2E", background: "#0d0d12" }}>
            B20 USDC token address is not configured yet. Check back shortly.
          </div>
        ) : !recipientReady ? (
          <div className="font-mono text-[10px] text-slate-500 leading-relaxed rounded-xl p-3" style={{ border: "1px solid #1A1A2E", background: "#0d0d12" }}>
            This payment link is missing the merchant payout address.
          </div>
        ) : !amountReady ? (
          <div className="font-mono text-[10px] text-slate-500 leading-relaxed rounded-xl p-3" style={{ border: "1px solid #1A1A2E", background: "#0d0d12" }}>
            The amount is unavailable on this device — reopen the original pay link.
          </div>
        ) : !isConnected || !address ? (
          <PayConnect />
        ) : (
          <>
            <button onClick={pay} disabled={sending}
              className="w-full font-mono text-[12px] font-bold py-2.5 rounded-xl hover:opacity-90 transition-opacity disabled:opacity-60"
              style={{ background: "#4FC3F7", color: "#050508" }}>
              {sending ? "Confirm in wallet…" : `Pay ${amount?.toLocaleString()} USDC`}
            </button>
            <p className="font-mono text-[9px] text-slate-600 mt-2">B20 USDC on Base · memo ties this payment to #{id}</p>
          </>
        )}
        {err && <p className="font-mono text-[10px] text-red-400 mt-2 leading-relaxed">{err}</p>}
      </div>
    </div>
  );
}

// Map common B20 transfer reverts / wallet errors to a human message.
function friendlyB20Error(msg: string): string {
  const m = (msg || "").toLowerCase();
  if (m.includes("user rejected") || m.includes("user denied") || m.includes("rejected the request")) return "Payment cancelled.";
  if (m.includes("policyforbids") || m.includes("policy")) return "This token's transfer policy blocked the payment (allowlist/blocklist). Contact the merchant.";
  if (m.includes("paused") || m.includes("enforcedpause")) return "Transfers are paused on this token right now. Try again later.";
  if (m.includes("insufficient")) return "Insufficient B20 USDC balance for this payment.";
  return msg.length > 140 ? msg.slice(0, 140) + "…" : msg;
}

// Compact connect control — Coinbase Smart Wallet first, EIP-6963 injected second.
//
// Sources the split from useWallet rather than re-deriving it. Beyond killing
// the duplicate matcher, this fixes a real bug: connecting here went straight to
// wagmi's connect() and never cleared the explicit-disconnect flag, so a user
// who had tapped Disconnect earlier in the tab left it set for the rest of the
// session and BaseAppAutoConnect kept skipping its silent re-bind. `select()`
// clears it.
function PayConnect() {
  const { coinbase, others, isPending } = useWallet();
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-xl border border-[#1A1A2E] bg-[#0a0a0f] p-4">
      <div className="font-mono text-[11px] text-slate-300 mb-3 text-center">Connect a wallet to pay — you sign, non-custodial.</div>
      {coinbase && (
        <button onClick={() => coinbase.select()} disabled={isPending}
          className="w-full font-mono text-[12px] font-bold py-2.5 rounded-xl disabled:opacity-60 flex items-center justify-center gap-2"
          style={{ background: "#4FC3F7", color: "#050508" }}>
          {isPending ? "Connecting…" : <>🔵 Coinbase / Smart Wallet</>}
        </button>
      )}
      <button onClick={() => setOpen(o => !o)} disabled={isPending}
        className="w-full font-mono text-[11px] text-slate-400 hover:text-slate-200 py-2 mt-2 rounded-xl border border-[#1A1A2E] transition-colors disabled:opacity-60">
        I have another wallet
      </button>
      {open && (
        <div className="mt-2 rounded-xl border border-[#1A1A2E] overflow-hidden">
          {others.length ? others.map(w => (
            <button key={w.key} onClick={() => { w.select(); setOpen(false); }}
              className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-[#1A1A2E] transition-colors">
              <span className="font-mono text-xs text-slate-200">{w.name}</span>
            </button>
          )) : <div className="px-3 py-2.5 font-mono text-[10px] text-slate-600">No other wallet detected</div>}
        </div>
      )}
    </div>
  );
}

// Page chrome — centered card with BlueBank branding + non-custodial footer.
function PayShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-[#050508] text-slate-200 flex items-center justify-center p-5">
      <div className="w-full max-w-sm">
        <div className="text-center mb-4">
          <div className="font-mono text-[13px] tracking-widest text-[#4FC3F7] font-bold">🔵 BLUEBANK</div>
          <div className="font-mono text-[9px] text-slate-600 mt-0.5">Non-custodial payments on Base</div>
        </div>
        <div className="rounded-2xl border border-[#1A1A2E] bg-[#0a0a0f] p-5 shadow-2xl">
          {children}
        </div>
        <div className="text-center mt-4 font-mono text-[9px] text-slate-700 leading-relaxed">
          You sign from your own wallet · BlueBank never holds your funds
        </div>
      </div>
    </div>
  );
}
