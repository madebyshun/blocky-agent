"use client";

/**
 * The live half of the pledge page.
 *
 * Everything a holder needs to make the decision — the warning, the address,
 * the steps — is server-rendered next door and does not depend on this file
 * loading. What lives here is the part that has to talk to the chain: the
 * totals, the lookup, and the ledger itself.
 *
 * ─── The rule this component exists to obey ─────────────────────────────────
 * NEVER render a failed read as an empty ledger. A spinner that resolves into
 * "0 pledges" is, to someone who sent tokens an hour ago, indistinguishable
 * from being robbed. Every failure mode below therefore has its own visible
 * state: `error` (we could not read at all), `degraded` (this chain failed,
 * numbers are the last known ones), `stale` (numbers are older than they look),
 * `truncated` (we hit a page cap and this list is short). None of them are
 * allowed to look like success.
 *
 * ─── Which percentages appear, and which do not ─────────────────────────────
 * The distinction is aggregate vs personal, not "percentages are dangerous".
 *
 * A CHAIN total ("0.00325% of Base supply pledged") is migration progress. It
 * has a named denominator, it belongs to nobody, and it answers the question
 * the page is actually for: how much of the old token has moved. That renders
 * always.
 *
 * A WALLET share is a different object. Beside someone's own pledge a
 * percentage reads as an entitlement however it is labelled, and until
 * `ALLOCATION_ANNOUNCED` there is no published ratio for it to be a share OF —
 * the two old supplies differ by 100×. So per-wallet shares are withheld
 * entirely, and what renders instead is the pair that needs no ratio to be
 * true: the amount received, and the transaction that proves it.
 *
 * When the ratio is published, the per-wallet number comes back as an ESTIMATE
 * and says so in its own label — the denominator keeps moving while the window
 * is open, so a firm-looking share before it closes is a share that will be
 * wrong.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CHAINS,
  CHAIN_KEYS,
  ALLOCATION_ANNOUNCED,
  NEW_TOKEN_DECIMALS,
  type ChainKey,
} from "@/lib/pledge/config";
import {
  fmtPct,
  fmtWhen,
  fmtAge,
  shortAddr,
  shortHash,
  formatAmount,
  convertToNew,
} from "@/lib/pledge/format";
import type { LedgerSnapshot, WalletPledge } from "@/lib/pledge/types";

interface WalletLookup {
  address: string;
  found: boolean;
  entries: WalletPledge[];
  updatedAt: number;
  stale: boolean;
  degraded: boolean;
}

const ACCENT: Record<ChainKey, string> = { base: "#4FC3F7", rh: "#34D399" };

// ─── Shared bits ─────────────────────────────────────────────────────────────

function Notice({
  tone,
  title,
  children,
}: {
  tone: "warn" | "error" | "info";
  title: string;
  children?: React.ReactNode;
}) {
  const color = tone === "error" ? "#F87171" : tone === "warn" ? "#F59E0B" : "#4FC3F7";
  return (
    <div
      className="rounded-xl border p-4 mb-6"
      style={{ borderColor: `${color}40`, background: `${color}0D` }}
      role="status"
    >
      <div className="font-mono text-[11px] tracking-[0.18em] uppercase mb-1.5" style={{ color }}>
        {title}
      </div>
      {children ? <div className="text-sm text-slate-300 leading-relaxed">{children}</div> : null}
    </div>
  );
}

export function CopyAddress({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard blocked — the address is fully visible either way */
    }
  }, [address]);

  return (
    <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
      {/*
        The full address is printed, never truncated. A page asking someone to
        send tokens somewhere has to show exactly where, character for
        character — a shortened address is unverifiable, and unverifiable is
        what every drainer site looks like.
      */}
      <code className="flex-1 font-mono text-[12px] sm:text-[13px] break-all rounded-xl border border-[#1A1A2E] bg-[#0a0a10] px-4 py-3.5 text-white select-all">
        {address}
      </code>
      <button
        onClick={copy}
        className="shrink-0 px-5 py-3.5 rounded-xl font-mono text-xs font-bold transition-all hover:opacity-90"
        style={{ background: copied ? "#34D399" : "#4FC3F7", color: "#050508" }}
      >
        {copied ? "COPIED" : "COPY"}
      </button>
    </div>
  );
}

// ─── Chain totals ────────────────────────────────────────────────────────────

function ChainCard({ snap, chain }: { snap: LedgerSnapshot; chain: ChainKey }) {
  const s = snap.chains[chain];
  const cfg = CHAINS[chain];
  const color = ACCENT[chain];
  const degraded = s.status === "degraded";

  return (
    <div
      className="rounded-2xl border p-6"
      style={{
        borderColor: degraded ? "#F8717140" : `${color}20`,
        background: degraded ? "#F871710A" : "#0a0a10",
      }}
    >
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full" style={{ background: degraded ? "#F87171" : color }} />
          <span className="font-mono text-[11px] tracking-[0.18em] uppercase" style={{ color: degraded ? "#F87171" : color }}>
            {s.label}
          </span>
        </div>
        <a
          href={cfg.explorerAddress(cfg.token.address)}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-[10px] text-slate-600 hover:text-slate-400 transition-colors"
        >
          token ↗
        </a>
      </div>

      {degraded ? (
        // The critical branch. `0` is never printed here — the numbers shown
        // are explicitly labelled as the last ones we managed to read.
        <div className="mb-4">
          <div className="text-[13px] text-[#F87171] font-medium mb-1">
            Could not read this chain right now.
          </div>
          <div className="text-[12px] text-slate-400 leading-relaxed">
            {s.txCount > 0
              ? "The figures below are the last successful read, not live. Your transaction is still on-chain — check it on the explorer."
              : "No figures are available yet. This does NOT mean nothing was pledged; it means the read failed."}
          </div>
          {s.error ? (
            <div className="mt-2 font-mono text-[10px] text-slate-600 break-all">{s.error}</div>
          ) : null}
        </div>
      ) : null}

      <div className="text-3xl font-bold text-white mb-1 tabular-nums">
        {degraded && s.txCount === 0 ? "—" : s.totalFormatted}
      </div>
      <div className="font-mono text-[11px] text-slate-500 mb-5">
        {/*
          The denominator is NAMED, and that is the whole point of this line.
          "of supply" unqualified was the original defect on this page: three
          supplies coexist here (Base 100B, RH 1B, $NEW 1B) and a bare
          percentage silently picks one, leaving the reader to assume the one
          they care about.

          This figure is migration PROGRESS — how much of this chain's old token
          has been pledged so far — not an allocation. That is why it is safe to
          publish while the conversion ratio is unannounced, and why it stays a
          chain-level aggregate: the same percentage printed on one person's row
          is read as their entitlement.
        */}
        {s.symbol} ·{" "}
        {degraded && s.txCount === 0 ? "—" : fmtPct(s.pctOfSupply)} of {s.label} supply pledged
      </div>

      <div className="grid grid-cols-2 gap-3 pt-4 border-t border-[#1A1A2E]">
        <div>
          <div className="text-lg font-bold text-white tabular-nums">
            {degraded && s.txCount === 0 ? "—" : s.walletCount}
          </div>
          <div className="font-mono text-[10px] text-slate-600 uppercase tracking-wider">wallets</div>
        </div>
        <div>
          <div className="text-lg font-bold text-white tabular-nums">
            {degraded && s.txCount === 0 ? "—" : s.txCount}
          </div>
          <div className="font-mono text-[10px] text-slate-600 uppercase tracking-wider">transfers</div>
        </div>
      </div>

      <div className="mt-4 font-mono text-[10px] text-slate-600 leading-relaxed">
        read via {s.source === "none" ? "—" : s.source}
        {s.supplySource === "pinned" ? " · supply from fallback constant, not the contract" : ""}
        {s.truncated ? " · LIST TRUNCATED at the page cap" : ""}
      </div>
    </div>
  );
}

// ─── Lookup ──────────────────────────────────────────────────────────────────

function Lookup() {
  const [input, setInput] = useState("");
  const [state, setState] = useState<
    { s: "idle" } | { s: "loading" } | { s: "done"; r: WalletLookup } | { s: "error"; m: string }
  >({ s: "idle" });

  const run = useCallback(async () => {
    const addr = input.trim();
    if (!addr) return;
    setState({ s: "loading" });
    try {
      const res = await fetch(`/api/pledge/lookup?address=${encodeURIComponent(addr)}`);
      const body = await res.json();
      if (!res.ok) {
        setState({ s: "error", m: body?.error ?? `HTTP ${res.status}` });
        return;
      }
      setState({ s: "done", r: body as WalletLookup });
    } catch (e) {
      setState({ s: "error", m: (e as Error).message });
    }
  }, [input]);

  return (
    <div className="rounded-2xl border border-[#1A1A2E] bg-[#0a0a10] p-6">
      <div className="font-mono text-[11px] text-slate-500 tracking-[0.18em] uppercase mb-4">
        Check an address
      </div>
      <div className="flex flex-col sm:flex-row gap-3">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && run()}
          placeholder="0x…"
          spellCheck={false}
          className="flex-1 font-mono text-[13px] rounded-xl border border-[#1A1A2E] bg-[#050508] px-4 py-3 text-white placeholder:text-slate-700 focus:outline-none focus:border-[#4FC3F740]"
        />
        <button
          onClick={run}
          disabled={state.s === "loading"}
          className="shrink-0 px-6 py-3 rounded-xl font-mono text-xs font-bold text-[#050508] bg-[#4FC3F7] disabled:opacity-40 transition-all hover:opacity-90"
        >
          {state.s === "loading" ? "CHECKING…" : "CHECK"}
        </button>
      </div>

      {state.s === "error" ? (
        <div className="mt-4 text-[13px] text-[#F87171]">{state.m}</div>
      ) : null}

      {state.s === "done" ? (
        <div className="mt-5">
          {/*
            "Not found" and "we couldn't read the chain" are the same sentence
            to a worried holder unless they are told apart, so a degraded or
            stale ledger says so BEFORE the result.
          */}
          {state.r.degraded ? (
            <Notice tone="error" title="Result may be incomplete">
              At least one chain could not be read on this refresh. If your pledge is missing here,
              check the receiving wallet on the block explorer before concluding anything.
            </Notice>
          ) : null}

          {state.r.found ? (
            <div className="space-y-3">
              {state.r.entries.map((e) => (
                <div
                  key={`${e.chain}:${e.wallet}`}
                  className="rounded-xl border p-4"
                  style={{ borderColor: `${ACCENT[e.chain]}30`, background: `${ACCENT[e.chain]}08` }}
                >
                  <div className="flex items-baseline justify-between gap-3 flex-wrap">
                    <span className="font-mono text-[11px] tracking-[0.18em] uppercase" style={{ color: ACCENT[e.chain] }}>
                      {CHAINS[e.chain].label}
                    </span>
                    <span className="font-mono text-[11px] text-slate-500">
                      {e.txCount} transfer{e.txCount === 1 ? "" : "s"}
                    </span>
                  </div>
                  <div className="text-2xl font-bold text-white mt-2 tabular-nums">{e.totalFormatted}</div>
                  <div className="font-mono text-[11px] text-slate-500 mt-1">
                    {CHAINS[e.chain].token.symbol} · received
                  </div>

                  {/*
                    The received amount above is a MEASUREMENT — it is on-chain
                    and cannot move. Everything below it is a projection, and
                    the two must not share a typeface or sit in the same block,
                    because a holder screenshots this and reads whatever is
                    largest as the promise. Hence the rule: the estimate is
                    smaller than the fact it is derived from, is separated by a
                    rule, and carries its own amber label rather than a
                    parenthetical someone can crop out.

                    It also never says "final". The denominator is still moving:
                    every pledge that lands after this one changes what any
                    given wallet's share works out to, so a firm-looking number
                    before the window closes is a number that will be wrong.
                  */}
                  {ALLOCATION_ANNOUNCED ? (
                    <div
                      className="mt-3 pt-3 border-t"
                      style={{ borderColor: `${ACCENT[e.chain]}20` }}
                    >
                      <div className="font-mono text-[12px] text-slate-300 tabular-nums">
                        ≈{" "}
                        {formatAmount(
                          BigInt(convertToNew(e.totalAmount, CHAINS[e.chain].oldPerNew)),
                          NEW_TOKEN_DECIMALS,
                        )}{" "}
                        $NEW · {fmtPct(e.pctOfSupply)}
                      </div>
                      <div className="font-mono text-[10px] text-[#F59E0B] mt-1.5 leading-relaxed">
                        Estimate — finalised after the pledge window closes. Converted at{" "}
                        {CHAINS[e.chain].oldPerNew.toString()}:1 on {CHAINS[e.chain].label}.
                      </div>
                    </div>
                  ) : null}
                </div>
              ))}
              {/*
                Still no combined total across chains, for the original reason
                (different denominators) and now a second one: until the ratio
                is announced there is no share to combine.
              */}
              <div className="font-mono text-[10px] text-slate-600 leading-relaxed">
                {ALLOCATION_ANNOUNCED
                  ? "Shown per chain and never added together — the two old supplies differ by 100×, so each is converted at its own ratio. No figure here is final until the pledge window closes; every pledge that lands after yours changes what the share works out to."
                  : "This is what the receiving wallet has recorded from this address — an amount and a transaction, nothing more. The conversion ratio to the new token has not been announced, so no share is published here yet."}
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-[#1A1A2E] bg-[#050508] p-4 text-[13px] text-slate-400">
              No transfer from <span className="font-mono text-slate-300">{shortAddr(state.r.address)}</span> into
              the receiving wallet has been indexed yet.
              {state.r.stale ? " This ledger is a cached copy — a very recent transfer may not be in it." : ""}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

// ─── Ledger table ────────────────────────────────────────────────────────────

/**
 * "Share" is absent, not blank. An empty column under a header people are
 * looking for reads as data that failed to load, which is the one impression
 * this table must never give.
 */
const COLUMNS = ALLOCATION_ANNOUNCED
  ? // "(est.)" is in the header, not a footnote, because a column of tidy
    // percentages is the part of this page most likely to be screenshotted
    // away from its caption.
    ["#", "Wallet", "Chain", "Pledged", "Share of $NEW (est.)", "Transfers", "Latest"]
  : ["#", "Wallet", "Chain", "Pledged", "Transfers", "Latest"];

function Ledger({ snap }: { snap: LedgerSnapshot }) {
  const [query, setQuery] = useState("");
  const [chainFilter, setChainFilter] = useState<ChainKey | "all">("all");

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return snap.wallets.filter((w) => {
      if (chainFilter !== "all" && w.chain !== chainFilter) return false;
      if (!q) return true;
      if (w.wallet.toLowerCase().includes(q)) return true;
      return w.txs.some((t) => t.txHash.toLowerCase().includes(q));
    });
  }, [snap.wallets, query, chainFilter]);

  return (
    <div>
      <div className="flex flex-col sm:flex-row gap-3 mb-5">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by wallet or transaction hash…"
          spellCheck={false}
          className="flex-1 font-mono text-[13px] rounded-xl border border-[#1A1A2E] bg-[#0a0a10] px-4 py-3 text-white placeholder:text-slate-700 focus:outline-none focus:border-[#4FC3F740]"
        />
        <div className="flex gap-2">
          {(["all", ...CHAIN_KEYS] as const).map((c) => (
            <button
              key={c}
              onClick={() => setChainFilter(c)}
              className="px-4 py-3 rounded-xl font-mono text-[11px] uppercase tracking-wider border transition-all"
              style={
                chainFilter === c
                  ? { borderColor: "#4FC3F740", background: "#4FC3F714", color: "#4FC3F7" }
                  : { borderColor: "#1A1A2E", color: "#64748b" }
              }
            >
              {c === "all" ? "All" : CHAINS[c].shortLabel}
            </button>
          ))}
          <a
            href="/api/pledge?format=csv"
            className="px-4 py-3 rounded-xl font-mono text-[11px] uppercase tracking-wider border border-[#1A1A2E] text-slate-500 hover:text-white hover:border-[#4FC3F740] transition-all"
          >
            CSV
          </a>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-xl border border-[#1A1A2E] bg-[#0a0a10] p-8 text-center text-sm text-slate-500">
          {snap.wallets.length === 0
            ? snap.degraded
              ? "The ledger could not be read. This is a read failure, not an empty ledger — nothing here should be taken as a statement about what was pledged."
              : "No pledges recorded yet."
            : "No rows match that filter."}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-[#1A1A2E]">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-[#0a0a10]">
                {COLUMNS.map((h) => (
                  <th
                    key={h}
                    className="font-mono text-[10px] uppercase tracking-[0.15em] text-slate-600 px-4 py-3 whitespace-nowrap font-normal"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((w, i) => {
                const cfg = CHAINS[w.chain];
                const latest = w.txs[0];
                return (
                  <tr key={`${w.chain}:${w.wallet}`} className="border-t border-[#1A1A2E] hover:bg-[#0a0a10]">
                    <td className="px-4 py-3 font-mono text-[11px] text-slate-600 tabular-nums">{i + 1}</td>
                    <td className="px-4 py-3">
                      <a
                        href={cfg.explorerAddress(w.wallet)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-mono text-[12px] text-slate-300 hover:text-[#4FC3F7] transition-colors"
                        title={w.wallet}
                      >
                        {shortAddr(w.wallet)}
                      </a>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className="font-mono text-[10px] px-2 py-1 rounded-md"
                        style={{ background: `${ACCENT[w.chain]}14`, color: ACCENT[w.chain] }}
                      >
                        {cfg.shortLabel}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-[12px] text-white tabular-nums whitespace-nowrap">
                      {w.totalFormatted}
                    </td>
                    {ALLOCATION_ANNOUNCED ? (
                      <td className="px-4 py-3 font-mono text-[12px] text-slate-400 tabular-nums whitespace-nowrap">
                        {fmtPct(w.pctOfSupply)}
                      </td>
                    ) : null}
                    <td className="px-4 py-3">
                      {/* Every row links to its own receipt — that is what makes the list checkable. */}
                      <a
                        href={cfg.explorerTx(latest.txHash)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-mono text-[11px] text-slate-500 hover:text-[#4FC3F7] transition-colors"
                        title={latest.txHash}
                      >
                        {w.txCount > 1 ? `${w.txCount} ↗` : shortHash(latest.txHash)}
                      </a>
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px] text-slate-600 whitespace-nowrap">
                      {fmtWhen(latest.timestamp)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Root ────────────────────────────────────────────────────────────────────

export default function PledgeClient() {
  const [snap, setSnap] = useState<LedgerSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/pledge", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSnap((await res.json()) as LedgerSnapshot);
      setError(null);
    } catch (e) {
      // Keep whatever we already showed. Replacing a rendered ledger with an
      // empty one because a refresh failed is the exact failure this page
      // cannot have.
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [load]);

  if (!snap) {
    return (
      <div className="rounded-2xl border border-[#1A1A2E] bg-[#0a0a10] p-10 text-center">
        <div className="font-mono text-[11px] tracking-[0.18em] uppercase text-slate-600">
          {error ? "Ledger unavailable" : "Reading the chain…"}
        </div>
        {error ? (
          <p className="mt-3 text-sm text-slate-400 max-w-md mx-auto leading-relaxed">
            The ledger could not be loaded ({error}). This is a problem with this page, not with your
            transfer — the receiving wallet and every transfer into it are visible on the block
            explorer regardless.
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div>
      {error ? (
        <Notice tone="warn" title="Live refresh failing">
          Showing the last ledger that loaded successfully ({error}). Figures may have moved since.
        </Notice>
      ) : null}

      {snap.stale ? (
        <Notice tone="warn" title={`Cached copy · ${fmtAge(snap.staleAgeS)} old`}>
          A fresh read did not complete, so these are the last confirmed figures. A transfer sent in
          the last few minutes may not appear yet.
        </Notice>
      ) : null}

      {snap.degraded ? (
        <Notice tone="error" title="Incomplete read">
          At least one chain could not be read on this refresh. Anything missing below is missing
          from OUR view of the chain, not from the chain. Verify against{" "}
          <a
            href={CHAINS.base.explorerAddress(snap.receivingWallet)}
            target="_blank"
            rel="noopener noreferrer"
            className="underline text-[#4FC3F7]"
          >
            the receiving wallet on Basescan
          </a>{" "}
          or{" "}
          <a
            href={CHAINS.rh.explorerAddress(snap.receivingWallet)}
            target="_blank"
            rel="noopener noreferrer"
            className="underline text-[#34D399]"
          >
            on the Robinhood Chain explorer
          </a>
          .
        </Notice>
      ) : null}

      {CHAIN_KEYS.some((c) => snap.chains[c].truncated) ? (
        <Notice tone="warn" title="List truncated">
          The number of transfers exceeded the per-request page cap, so this list is not the whole
          set. Use the CSV export or the block explorer for the complete record.
        </Notice>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 mb-10">
        {CHAIN_KEYS.map((c) => (
          <ChainCard key={c} snap={snap} chain={c} />
        ))}
      </div>

      <div className="mb-10">
        <Lookup />
      </div>

      <div className="flex items-baseline justify-between gap-4 flex-wrap mb-5">
        <h2 className="text-xl font-bold text-white">Public ledger</h2>
        <span className="font-mono text-[10px] text-slate-600">
          updated {fmtAge((Date.now() - snap.updatedAt) / 1000)} ago
        </span>
      </div>
      <Ledger snap={snap} />
    </div>
  );
}
