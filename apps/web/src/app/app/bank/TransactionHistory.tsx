"use client";

import { useEffect, useState } from "react";
import { useBasename, shortAddr } from "@/lib/useBasename";
import { TOPUP_TREASURY } from "@/lib/payments";

/**
 * Counterparties we can name from their ADDRESS ALONE.
 *
 * That qualifier is the whole rule. An address is a fact on Base and this map
 * is a fact we own, so the join is a lookup, not a guess. Nothing else in this
 * file may name a counterparty — no "amount looks like a tool price", no "this
 * happened around the time of that call". Those are inferences wearing a label.
 *
 * The treasury entries are why the timeline exists in this form: every Hub tool
 * call and every Blue Chat top-up settles USDC to `TOPUP_TREASURY`, and until
 * now the wallet rendered its own product as anonymous hex — `Sent to 0x0295…`,
 * indistinguishable from a payment to a stranger.
 *
 * The address is IMPORTED, not retyped. It is already hand-copied into eleven
 * files across this repo (one of which carries a comment saying it MUST match
 * another), and a twelfth copy that silently drifts would mislabel real money.
 */
const RETIRED_TREASURY = "0xb058a1e305d9c720aa5b1bf42b6f2f6294b03b5f";

const KNOWN: Record<string, string> = {
  "0xa238dd80c259a72e81d7e4664a9801593f98d1c5": "Aave v3",
  "0x4e65fe4dba92790696d040ac24aa414708f5c0ab": "Aave · aUSDC",
  "0xee8f4ec5672f09119b96ab6fb59c27e1b7e44b61": "Morpho",
  "0x0000000000001ff3684f28c67538d4d072c22734": "0x Swap",
  "0x8bab6d1b75f19e9ed9fce8b9bd338844ff79ae27": "Aave v3",
  "0x10f1a9d11cdf50041f3f8cb7191cbe2f31750acc": "Aave · aUSDC",
  [TOPUP_TREASURY.toLowerCase()]: "Blue Agent",
  // Retired 2026-08-18 in favour of the address above (provenance: CLAUDE.md).
  // Kept because the payments made to it are permanent and still in history —
  // a retired payee is still a known payee, and dropping it would turn real
  // past spending back into hex.
  [RETIRED_TREASURY]: "Blue Agent · old treasury",
};

/** True for the addresses that are US — the ones a receipt can explain. */
const isBlueTreasury = (addr?: string): boolean => {
  const a = addr?.toLowerCase();
  return a === TOPUP_TREASURY.toLowerCase() || a === RETIRED_TREASURY;
};

export type WalletTx = {
  hash: string; ts: number; category: string;
  kind: "received"|"sent"|"swap"|"contract";
  dir: "in"|"out"|"none";
  counterparty?: string; amount: number|null; asset?: string;
  status: "complete"|"pending"|"failed";
};

/** One x402 receipt as `/api/wallet/spend` returns it. `name` is null when the
 *  tool id is no longer in the catalog — the row then prints the raw id. */
export type Receipt = { ts: number; tool: string; name: string | null; units: number; usd: number; tx: string | null };

/**
 * Receipts for the connected wallet, keyed by settlement tx hash.
 *
 * Three states, not two. "loading" and "unavailable" are both NOT "there are
 * none": the first is temporary, the second means the receipt store could not
 * be reached. Collapsing either into an empty map would make this component
 * tell a paying user that their payments bought nothing — which is exactly the
 * failure `getSpendLog`'s null-vs-[] contract exists to prevent, so the
 * distinction is carried all the way to the pixels rather than dropped here.
 */
type ReceiptState = { status: "loading" | "ok" | "unavailable"; byTx: Map<string, Receipt> };

function useSpendReceipts(address?: string): ReceiptState {
  const [state, setState] = useState<ReceiptState>({ status: "loading", byTx: new Map() });
  useEffect(() => {
    if (!address) { setState({ status: "ok", byTx: new Map() }); return; }
    let alive = true;
    setState({ status: "loading", byTx: new Map() });
    fetch(`/api/wallet/spend?address=${address}`)
      .then(r => r.json())
      .then((j: { known?: boolean; receipts?: Receipt[] }) => {
        if (!alive) return;
        if (j.known === false) { setState({ status: "unavailable", byTx: new Map() }); return; }
        const byTx = new Map<string, Receipt>();
        // Only receipts that carry a settlement hash can be joined to a row.
        // A receipt without one is real but unmatchable, and guessing which
        // row it belongs to is the one thing this file must never do.
        for (const r of j.receipts ?? []) if (r.tx) byTx.set(r.tx.toLowerCase(), r);
        setState({ status: "ok", byTx });
      })
      .catch(() => { if (alive) setState({ status: "unavailable", byTx: new Map() }); });
    return () => { alive = false; };
  }, [address]);
  return state;
}

export type Group = "earn" | "swap" | "agent" | "send" | "receive" | "other";

/**
 * Everything the UI knows about one row, derived ONCE.
 *
 * `txMeta` and `matchFilter` each used to look up `KNOWN[...]` themselves. Two
 * independent derivations of one fact is the defect this wallet work keeps
 * finding (the allocation card printed "No assets yet" above "Stablecoin 0%"
 * for the same reason), so the lookup happens here, once, and the filter and
 * the label read the same object. They cannot disagree about what a row is.
 */
export interface TxClass {
  /** Name from the address alone, or null when we genuinely don't know it. */
  payee: string | null;
  /** The x402 receipt for THIS tx, matched BY HASH ONLY. */
  receipt: Receipt | null;
  group: Group;
  /** Resolve the counterparty via basename only when nothing else names it. */
  wantsBasename: boolean;
  icon: string; color: string; bg: string; dot: string;
}

/**
 * Exported, and not only for tests: P2's spend console needs "is this row the
 * agent spending, and on what?" for the same rows. If it answers that question
 * with its own `if`, the console and the timeline will eventually disagree
 * about the same transaction — the failure mode this file was just refactored
 * to remove. One classifier, imported, or it happens again.
 */
export function classify(tx: WalletTx, receipt: Receipt | null): TxClass {
  const payee = tx.counterparty ? KNOWN[tx.counterparty.toLowerCase()] ?? null : null;
  const base = { payee, receipt, wantsBasename: false };

  // Agent spending, by either of two independent proofs:
  //
  //   a receipt for THIS hash — our own server wrote it at settle time, which
  //   is a stronger fact than anything an indexer infers about the row. The
  //   settlement is an EIP-3009 `transferWithAuthorization` SUBMITTED BY THE
  //   CDP FACILITATOR, so the wallet is the token sender but not the tx sender;
  //   if Moralis ever reads that as a plain contract call with no direction,
  //   requiring `dir === "out"` here would silently drop the tool name on every
  //   real payment and make this whole feature a no-op that still typechecks.
  //
  //   or USDC leaving for our treasury — no receipt, but the payee is known, so
  //   these still group as agent spending. Absence of a receipt removes the
  //   tool NAME and nothing else; the row never falls back to hex.
  if (receipt || (tx.dir === "out" && isBlueTreasury(tx.counterparty)))
    return { ...base, group: "agent", icon: "🔵", color: "#4FC3F7", bg: "#4FC3F715", dot: "#4FC3F7" };

  if (payee?.startsWith("Aave") || payee?.startsWith("Morpho"))
    return tx.dir === "out"
      ? { ...base, group: "earn", icon: "🌾", color: "#34D399", bg: "#34D39915", dot: "#34D399" }
      : { ...base, group: "earn", icon: "🏦", color: "#A78BFA", bg: "#A78BFA15", dot: "#A78BFA" };

  if (payee?.includes("Swap") || tx.kind === "swap")
    return { ...base, group: "swap", icon: "⇄", color: "#4FC3F7", bg: "#4FC3F715", dot: "#4FC3F7" };

  if (tx.kind === "received")
    return { ...base, wantsBasename: !payee, group: "receive", icon: "↓", color: "#34D399", bg: "#34D39915", dot: "#34D399" };

  if (tx.kind === "sent")
    return { ...base, wantsBasename: !payee, group: "send", icon: "↑", color: "#EF4444", bg: "#EF444415", dot: "#EF4444" };

  return { ...base, group: "other", icon: "⚡", color: "#A78BFA", bg: "#A78BFA15", dot: "#A78BFA" };
}

/** The heading, from the class + whatever name the counterparty resolved to. */
export function headingFor(tx: WalletTx, c: TxClass, cpLabel: string): string {
  if (c.group === "agent")
    return c.receipt
      // The join only this app can make: a transfer to 0x0295… is, specifically,
      // this tool. `name ?? tool` degrades to the raw id for a retired tool —
      // an unfamiliar id is honest, an invented label would not be.
      ? `Blue Hub · ${c.receipt.name ?? c.receipt.tool}`
      // No receipt: we know who was paid, not what for. Both are true; only the
      // second is missing, and the row says exactly that much.
      : `Paid ${cpLabel}`;
  if (c.group === "earn")    return tx.dir === "out" ? `Deposit → ${cpLabel}` : `Withdraw ← ${cpLabel}`;
  if (c.group === "swap")    return "Token swap";
  if (c.group === "receive") return `Received from ${cpLabel}`;
  if (c.group === "send")    return `Sent to ${cpLabel}`;
  return c.payee ?? "Contract call";
}

export type Filter = "All"|"Agent"|"Earn"|"Send"|"Receive"|"Swap";
const FILTERS: Filter[] = ["All", "Agent", "Earn", "Send", "Receive", "Swap"];

/** Reads the class computed above — no second lookup, by construction. */
export function matches(c: TxClass, f: Filter): boolean {
  if (f === "All") return true;
  if (f === "Agent")   return c.group === "agent";
  if (f === "Earn")    return c.group === "earn";
  if (f === "Swap")    return c.group === "swap";
  if (f === "Send")    return c.group === "send";
  if (f === "Receive") return c.group === "receive";
  return true;
}

const fmtDay  = (ts: number) => new Date(ts).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });

type Row = { tx: WalletTx; c: TxClass };

function groupByDay(rows: Row[]): { day: string; items: Row[] }[] {
  const map = new Map<string, Row[]>();
  for (const row of rows) {
    const key = new Date(row.tx.ts).toDateString();
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(row);
  }
  return Array.from(map.entries()).map(([, items]) => ({ day: fmtDay(items[0].tx.ts), items }));
}

export default function TransactionHistory({
  transactions, loading, error, needsKey, onRetry, explorer, address,
}: {
  transactions: WalletTx[]; loading: boolean; error: boolean;
  needsKey?: boolean; onRetry: () => void; explorer: string; address?: string;
}) {
  const [filter, setFilter] = useState<Filter>("All");
  const receipts = useSpendReceipts(address);

  const rows: Row[] = transactions.map(tx => ({
    tx, c: classify(tx, receipts.byTx.get(tx.hash.toLowerCase()) ?? null),
  }));
  const filtered = rows.filter(r => matches(r.c, filter));
  const groups = groupByDay(filtered);

  // Agent payments we could not attach a tool to. Two very different reasons,
  // and the footnote must not merge them: the store was unreachable (we don't
  // know), or the payment predates receipts (nobody wrote it down). Silently
  // showing a bare payee for both would make an outage look like history.
  const unexplained = rows.filter(r => r.c.group === "agent" && !r.c.receipt).length;

  return (
    <div className="rounded-2xl border border-[#1A1A2E] bg-[#0a0a0f] p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="font-mono text-[9px] text-slate-500 tracking-widest">ONCHAIN TIMELINE</div>
        {address && (
          <a href={`${explorer}/address/${address}`} target="_blank" rel="noopener noreferrer"
            className="font-mono text-[9px] text-slate-600 hover:text-[#4FC3F7] transition-colors">
            Basescan ↗
          </a>
        )}
      </div>
      <div className="flex gap-1 mb-4 flex-wrap">
        {FILTERS.map(f => (
          <button key={f} onClick={() => setFilter(f)}
            className="font-mono text-[9px] px-2.5 py-1 rounded-full transition-colors"
            style={filter === f
              ? { background: "#4FC3F712", color: "#4FC3F7", border: "1px solid #4FC3F730" }
              : { color: "#475569", border: "1px solid #1A1A2E" }}>
            {f}
          </button>
        ))}
      </div>
      {loading ? <Skeleton /> : error ? (
        <div className="py-6 text-center">
          <div className="font-mono text-[11px] text-slate-500 mb-2">Could not load history</div>
          <button onClick={onRetry} className="font-mono text-[10px] px-3 py-1.5 rounded-lg"
            style={{ background: "#4FC3F710", color: "#4FC3F7", border: "1px solid #4FC3F730" }}>Retry</button>
        </div>
      ) : needsKey ? (
        <p className="font-mono text-[11px] text-slate-600 py-4">
          Live history needs a Moralis key (<span className="text-slate-400">MORALIS_API_KEY</span>).
          {address && <> View on <a href={`${explorer}/address/${address}`} target="_blank" rel="noopener noreferrer" className="text-[#4FC3F7]">Basescan ↗</a></>}
        </p>
      ) : filtered.length === 0 ? (
        <p className="font-mono text-[11px] text-slate-600 py-6 text-center">
          {filter === "Agent"
            ? "No agent spending on this wallet yet"
            : `No ${filter !== "All" ? filter.toLowerCase() + " " : ""}transactions yet`}
        </p>
      ) : (
        <div className="space-y-4">
          {groups.map(g => (
            <div key={g.day}>
              <div className="font-mono text-[9px] text-slate-600 mb-2 pl-1">{g.day}</div>
              <div className="relative">
                <div className="absolute left-3 top-2 bottom-2 w-px bg-[#1A1A2E]" />
                {g.items.map(({ tx, c }) => (
                  <TxRow key={`${tx.hash}-${tx.ts}-${tx.asset ?? ""}`} tx={tx} c={c} explorer={explorer} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      {unexplained > 0 && receipts.status !== "loading" && (
        <p className="font-mono text-[9px] text-slate-600 mt-3 pt-3 border-t border-[#12121c] leading-relaxed">
          {receipts.status === "unavailable"
            ? `${unexplained} payment${unexplained > 1 ? "s" : ""} to Blue Agent — couldn't reach the receipt store, so the tool isn't shown. Retry later.`
            : `${unexplained} payment${unexplained > 1 ? "s" : ""} to Blue Agent from before receipts existed. The payee is on-chain; which tool it bought was never recorded, so it isn't shown.`}
        </p>
      )}
    </div>
  );
}

function TxRow({ tx, c, explorer }: { tx: WalletTx; c: TxClass; explorer: string }) {
  const cp = tx.counterparty;
  const { name } = useBasename(c.wantsBasename ? cp : undefined);
  const cpLabel = c.payee ?? name ?? (cp ? shortAddr(cp) : "");
  const heading = headingFor(tx, c, cpLabel);
  const statusColor = tx.status === "pending" ? "#F59E0B" : tx.status === "failed" ? "#EF4444" : "#475569";
  return (
    <a href={`${explorer}/tx/${tx.hash}`} target="_blank" rel="noopener noreferrer"
      className="flex items-center gap-3 pl-7 py-2 -ml-1 rounded-lg hover:bg-[#0d0d12] transition-colors relative">
      <span className="absolute left-[9px] w-3 h-3 rounded-full border-2 border-[#050508] top-1/2 -translate-y-1/2"
        style={{ background: c.dot }} />
      <span className="w-7 h-7 rounded-lg flex items-center justify-center text-[12px] shrink-0"
        style={{ background: c.bg, color: c.color }}>{c.icon}</span>
      <div className="flex-1 min-w-0">
        <div className="font-mono text-[11px] text-slate-200 truncate">{heading}</div>
        <div className="font-mono text-[9px] flex items-center gap-1.5 mt-0.5">
          <span style={{ color: statusColor }}>{tx.status !== "complete" ? tx.status : fmtTime(tx.ts)}</span>
          {/* The catalog id behind the display name. Small, but it is the thing
              you paste into an x402 call — and it proves the row was matched to
              a real tool rather than captioned by a heuristic. */}
          {c.receipt && <span className="text-slate-700 truncate">{c.receipt.tool}</span>}
        </div>
      </div>
      {tx.amount != null && (
        <div className="font-mono text-[11px] shrink-0"
          style={{ color: tx.dir === "in" ? "#34D399" : tx.dir === "out" ? "#94a3b8" : "#64748b" }}>
          {tx.dir === "in" ? "+" : tx.dir === "out" ? "−" : ""}
          {tx.amount.toLocaleString("en-US", { maximumFractionDigits: tx.asset === "ETH" ? 5 : 2 })} {tx.asset ?? ""}
        </div>
      )}
    </a>
  );
}

function Skeleton() {
  return (
    <div className="space-y-2 pl-7">
      {[0, 1, 2, 3].map(i => (
        <div key={i} className="flex items-center gap-3 py-2">
          <div className="w-7 h-7 rounded-lg bg-[#13131f] animate-pulse shrink-0" />
          <div className="flex-1 space-y-1.5">
            <div className="h-2.5 w-36 rounded bg-[#13131f] animate-pulse" />
            <div className="h-2 w-16 rounded bg-[#13131f] animate-pulse" />
          </div>
          <div className="h-2.5 w-16 rounded bg-[#13131f] animate-pulse" />
        </div>
      ))}
    </div>
  );
}
