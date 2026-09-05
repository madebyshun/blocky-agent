"use client";

// /app/usage — everything the connected wallet has CONSUMED from BlueAgent.
//
// Two rails, one page, because they answer one question:
//   • credits — the daily tier allowance and the USDC-topup pool, read from
//     GET /api/credits/balance/[address] (getBalance in the credit ledger)
//   • USDC — the per-tool agent spend console, which used to sit on /app/wallet
//
// 100% real data, no mock numbers. "Top up" opens the same TopUpModal used
// everywhere; the pricing table lives on /plans.
//
// This is the ONE page that breaks the credit arithmetic down. The dashboard
// used to reprint three of these four figures from the same endpoint, so the
// two could disagree — and did. It now shows the balance and links here.
//
// SpendConsole moved here for the same reason, one level up: the wallet showed
// "what did I spend on BlueAgent" in USDC while this page showed it in credits,
// both sourced from the same ledger, on two pages a user reaches separately.
// The split is now by SUBJECT, not by unit — /app/wallet is money you hold and
// move, /app/usage is what you consumed. The console keeps the two units in
// separate columns; see its own header for why they are never added.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useWallet } from "@/hooks/useWallet";
import { WalletPickerModal } from "@/components/WalletPicker";
import TopUpModal from "@/components/TopUpModal";
import SpendConsole from "@/components/SpendConsole";
import type { BalanceSummary, LedgerEvent } from "@/lib/credit-ledger";

// Compact "time ago" for ledger rows (ms epoch → "3m", "2h", "5d").
function ago(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function StatCard({ label, value, sub, accent }: {
  label: string; value: string; sub?: string; accent?: string;
}) {
  return (
    <div className="rounded-xl border border-[#1A1A2E] bg-[#0A0A12] p-4">
      <p className="font-mono text-[10px] text-slate-600 tracking-widest uppercase">{label}</p>
      <p className="font-mono text-2xl font-bold mt-1.5" style={{ color: accent ?? "#fff" }}>
        {value}
      </p>
      {sub && <p className="font-mono text-[10px] text-slate-600 mt-0.5">{sub}</p>}
    </div>
  );
}

function EventRow({ ev }: { ev: LedgerEvent }) {
  // Refunds move credits back IN, so they read like a top-up in the ledger —
  // but they are not one, and labelling them "chat:private" alone would show a
  // green line the user can't account for. Say what it was: a charge reversed.
  const isRefund   = ev.kind === "refund";
  const isIncoming = isRefund || ev.kind === "topup";
  return (
    <div className="flex items-center justify-between px-4 py-2.5 border-b border-[#141420] last:border-0">
      <div className="min-w-0">
        <p className="font-mono text-[11px] text-slate-300 truncate">
          {isRefund && <span className="text-slate-500">refund · </span>}
          {ev.reason || ev.kind}
        </p>
        <p className="font-mono text-[9px] text-slate-600 mt-0.5">
          {ago(ev.ts)} ago{isRefund ? " · no answer was returned" : ""}
        </p>
      </div>
      <p
        className="font-mono text-[12px] font-bold flex-shrink-0 ml-3"
        style={{ color: isIncoming ? "#34D399" : "#F87171" }}
      >
        {isIncoming ? "+" : "−"}{ev.amount.toLocaleString()}
      </p>
    </div>
  );
}

export default function UsagePage() {
  const { address, isConnected, label } = useWallet();
  const [data, setData]       = useState<BalanceSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr]         = useState("");
  const [picker, setPicker]   = useState(false);
  const [topup, setTopup]     = useState(false);

  const load = useCallback(async () => {
    if (!address) { setData(null); return; }
    setLoading(true); setErr("");
    try {
      const res = await fetch(`/api/credits/balance/${address}`);
      if (!res.ok) throw new Error(`Couldn't load balance (HTTP ${res.status}).`);
      setData((await res.json()) as BalanceSummary);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [address]);

  useEffect(() => { load(); }, [load]);

  const dailyCr   = data?.dailyCr ?? 0;
  const dailyLeft = data?.dailyRemaining ?? 0;
  const pool      = data?.pool ?? 0;

  // "Spent all-time" needs BOTH halves. `spent` is only what came out of the
  // paid pool — a debit drains the free daily bucket first and just the
  // overflow lands there — so on its own it reads 0 for ever for anyone living
  // inside their daily allowance, under a label claiming to count chat and tool
  // runs. `freeSpent` is the free half, and it has three states, not two:
  //   number, exact    → the wallet's whole history is counted
  //   number, partial  → counting began mid-life; the total is a FLOOR
  //   undefined        → never measured; say so instead of adding a 0
  const poolSpent = data?.spent ?? 0;
  const freeSpent = data?.freeSpent;
  const spentTotal = poolSpent + (freeSpent ?? 0);
  const spentSub =
    freeSpent === undefined      ? "from top-up pool · free use not counted"
    : data?.freeSpentPartial     ? "chat + tool runs · at least"
    :                              "chat + tool runs";

  return (
    <div className="flex flex-col h-full bg-[#050508] overflow-hidden">
      {/* Header — mirrors PanelHost so promoted pages look uniform. */}
      <div className="flex items-center justify-between px-5 sm:px-6 h-14 border-b border-[#1A1A2E] flex-shrink-0">
        <div className="min-w-0">
          <p className="font-mono text-xs text-[#4FC3F7] tracking-widest truncate">// USAGE</p>
          <p className="font-mono text-[10px] text-slate-700 mt-1 truncate">
            Credits & agent spend · {label ?? "no wallet"}
          </p>
        </div>
        {isConnected && (
          <button
            onClick={() => setTopup(true)}
            className="font-mono text-[11px] font-bold px-3.5 py-2 rounded-lg hover:opacity-90 transition-opacity flex-shrink-0"
            style={{ background: "#4FC3F7", color: "#050508" }}
          >
            Top up
          </button>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-y-auto px-5 sm:px-6 py-5">
        {!isConnected ? (
          // ── Connect gate ──────────────────────────────────────────────
          <div className="max-w-sm mx-auto mt-16 text-center">
            <p className="font-mono text-[13px] text-slate-300 font-bold">Connect a wallet</p>
            <p className="font-mono text-[11px] text-slate-600 mt-2 leading-relaxed">
              Your credit balance and usage history are scoped to your connected wallet.
            </p>
            <button
              onClick={() => setPicker(true)}
              className="mt-5 font-mono text-[12px] font-bold px-5 py-2.5 rounded-xl hover:opacity-90 transition-opacity"
              style={{ background: "#4FC3F7", color: "#050508" }}
            >
              Connect wallet
            </button>
          </div>
        ) : (
          <div className="max-w-2xl mx-auto space-y-5">
            {err && (
              <p className="font-mono text-[11px] text-red-400 border border-red-500/20 bg-red-500/5 rounded-lg px-3 py-2">
                {err}
              </p>
            )}

            {/* Balance buckets */}
            <div className="grid grid-cols-2 gap-3">
              <StatCard
                label="Spendable now"
                value={loading && !data ? "…" : (data?.balance ?? 0).toLocaleString()}
                sub="daily + pool"
                accent="#4FC3F7"
              />
              <StatCard
                label="Daily left"
                value={loading && !data ? "…" : dailyLeft.toLocaleString()}
                sub={`of ${dailyCr.toLocaleString()} · resets daily`}
              />
              <StatCard
                label="Top-up pool"
                value={loading && !data ? "…" : pool.toLocaleString()}
                sub="bought with USDC · no daily reset"
              />
              <StatCard
                label="Spent all-time"
                value={loading && !data ? "…" : spentTotal.toLocaleString()}
                sub={spentSub}
              />
            </div>

            {/* Top-up nudge → pricing table */}
            <div className="flex items-center justify-between rounded-xl border border-[#1A1A2E] bg-[#0A0A12] px-4 py-3">
              <p className="font-mono text-[11px] text-slate-500">
                Need more credits? Top up with USDC on Base.
              </p>
              <Link
                href="/plans"
                className="font-mono text-[11px] text-[#4FC3F7] hover:underline flex-shrink-0 ml-3"
              >
                View plans →
              </Link>
            </div>

            {/* Recent activity */}
            <div>
              <p className="font-mono text-[10px] text-slate-600 tracking-widest uppercase mb-2">
                Recent activity
              </p>
              <div className="rounded-xl border border-[#1A1A2E] bg-[#0A0A12] overflow-hidden">
                {loading && !data ? (
                  <p className="font-mono text-[11px] text-slate-600 px-4 py-6 text-center">Loading…</p>
                ) : (data?.recent?.length ?? 0) === 0 ? (
                  <p className="font-mono text-[11px] text-slate-600 px-4 py-6 text-center">
                    No activity yet. Credits spent on chat and tool runs show up here.
                  </p>
                ) : (
                  data!.recent.map((ev, i) => <EventRow key={`${ev.ts}-${i}`} ev={ev} />)
                )}
              </div>
            </div>

            {/* ── Rail two: the per-tool spend console ─────────────────────────
                Everything above is the credit rail — what you hold, and the raw
                events that moved it. This is both rails at once, aggregated by
                TOOL, which is the join no block explorer can make: the tool id
                only ever existed in the request that triggered the payment.

                Deliberately below the ledger, not interleaved with it. The two
                answer different questions at different scopes — the cards are
                lifetime, the console's rails are a bounded window and label
                themselves as such — and stacking a windowed figure next to a
                lifetime one invites the subtraction neither supports. */}
            <div>
              <p className="font-mono text-[10px] text-slate-600 tracking-widest uppercase mb-2">
                Per tool
              </p>
              <SpendConsole address={address} />
            </div>
          </div>
        )}
      </div>

      <WalletPickerModal open={picker} onClose={() => setPicker(false)} />
      <TopUpModal open={topup} onClose={() => setTopup(false)} onCredited={load} />
    </div>
  );
}
