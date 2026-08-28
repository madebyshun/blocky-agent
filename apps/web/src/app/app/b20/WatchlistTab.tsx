"use client";

/**
 * B20 Watchlist tab — per-wallet multi-token compliance monitor.
 *
 * Pull-based change detection: on every load we re-inspect each watched token
 * live and diff against the snapshot captured at the last acknowledge. Surfaced
 * changes ("Transfers paused", "Supply cap lowered", "policy changed") are the
 * compliance signal. No cron, no push — zero new infra.
 *
 * Backend: ./watchlist-action.ts (KV-backed, keyed by connected wallet).
 */

import { useState, useEffect, useTransition, useCallback } from "react";
import { ConnectButton } from "@/components/ConnectModal";
import {
  listWatch,
  addWatch,
  removeWatch,
  ackWatch,
} from "./watchlist-action";
import type { WatchEntryStatus, WatchChange } from "@/lib/b20/watchlist";

type Network = "mainnet" | "sepolia";

const INPUT_CLS = [
  "w-full bg-[#0a0a12] border border-[#1A1A2E]",
  "focus:border-[#4FC3F740] rounded-xl px-3 py-2.5",
  "font-mono text-sm text-slate-200 placeholder:text-slate-700",
  "outline-none transition-colors",
].join(" ");

function isValidAddr(v: string) { return /^0x[a-fA-F0-9]{40}$/.test(v.trim()); }
function truncAddr(a: string, n = 6) { return `${a.slice(0, n)}…${a.slice(-4)}`; }
function relTime(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60)    return "just now";
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// ── Change badge ────────────────────────────────────────────────────────────────

function ChangeBadge({ change }: { change: WatchChange }) {
  const warn = change.tone === "warn";
  const color = warn ? "#F59E0B" : "#4FC3F7";
  return (
    <div className="flex items-start gap-2 px-3 py-2 rounded-lg"
      style={{ background: `${color}0a`, border: `1px solid ${color}25` }}>
      <span className="w-1.5 h-1.5 rounded-full shrink-0 mt-1.5"
        style={{ background: color, boxShadow: `0 0 4px ${color}80` }} />
      <span className="font-mono text-[11px] leading-relaxed" style={{ color }}>
        {change.text}
      </span>
    </div>
  );
}

// ── Single watched-token card ────────────────────────────────────────────────────

function WatchCard({
  entry, busy, onAck, onRemove,
}: {
  entry:    WatchEntryStatus;
  busy:     boolean;
  onAck:    () => void;
  onRemove: () => void;
}) {
  const { item, changes, isB20, unavailable, live, explorerUrl } = entry;
  const hasChanges = changes.length > 0;
  const title  = item.label || item.name || truncAddr(item.address, 8);
  const netTag = item.network === "mainnet" ? "Base" : "Sepolia";

  // Status dot: warn=changes, gray=unavailable/not-b20, green=in sync
  const status = unavailable
    ? { color: "#94A3B8", text: "Unavailable" }
    : !isB20
      ? { color: "#94A3B8", text: "Not a B20" }
      : hasChanges
        ? { color: "#F59E0B", text: `${changes.length} change${changes.length > 1 ? "s" : ""}` }
        : { color: "#22C55E", text: "In sync" };

  return (
    <div className="rounded-2xl border bg-[#0a0a0f] overflow-hidden"
      style={{ borderColor: hasChanges ? "#F59E0B30" : "#1A1A2E" }}>
      {/* Header */}
      <div className="px-4 py-3 border-b border-[#1A1A2E] flex items-center gap-3">
        <span className="w-1.5 h-1.5 rounded-full shrink-0"
          style={{ background: status.color, boxShadow: `0 0 4px ${status.color}80` }} />
        <div className="flex-1 min-w-0">
          <p className="font-mono text-xs text-white truncate">
            {title}{item.symbol ? <span className="text-slate-500"> ${item.symbol}</span> : null}
          </p>
          <p className="font-mono text-[9px] text-slate-600 truncate">
            {truncAddr(item.address, 10)} · {netTag}
          </p>
        </div>
        <span className="font-mono text-[9px] shrink-0" style={{ color: status.color }}>
          {status.text}
        </span>
      </div>

      {/* Changes */}
      {hasChanges && (
        <div className="px-4 py-3 space-y-1.5 border-b border-[#1A1A2E]">
          {changes.map((c, i) => <ChangeBadge key={i} change={c} />)}
        </div>
      )}

      {/* Live state line (when in sync / available) */}
      {!unavailable && isB20 && live && !hasChanges && (
        <div className="px-4 py-2.5 border-b border-[#1A1A2E] flex items-center gap-x-3 gap-y-1 flex-wrap">
          <span className="font-mono text-[9px] text-slate-600">{live.variant}</span>
          {live.currency && <span className="font-mono text-[9px] text-slate-600">· {live.currency}</span>}
          <span className="font-mono text-[9px] text-slate-600">· cap {live.supplyCap}</span>
          {(live.paused.transfer || live.paused.mint || live.paused.burn) && (
            <span className="font-mono text-[9px] text-[#F59E0B]">
              · paused: {[live.paused.transfer && "transfer", live.paused.mint && "mint", live.paused.burn && "burn"].filter(Boolean).join(", ")}
            </span>
          )}
        </div>
      )}

      {unavailable && (
        <div className="px-4 py-2.5 border-b border-[#1A1A2E]">
          <span className="font-mono text-[9px] text-slate-600">
            Live read failed — showing last-known. No change inferred.
          </span>
        </div>
      )}

      {/* Footer actions */}
      <div className="px-4 py-2.5 flex items-center gap-3">
        <span className="font-mono text-[9px] text-slate-700">
          baseline {relTime(item.snapshotAt)}
        </span>
        <div className="ml-auto flex items-center gap-3">
          <a href={explorerUrl} target="_blank" rel="noopener noreferrer"
            className="font-mono text-[9px] text-slate-600 hover:text-slate-400 transition-colors">
            Explorer ↗
          </a>
          {hasChanges && (
            <button onClick={onAck} disabled={busy}
              className="font-mono text-[9px] transition-colors"
              style={{ color: busy ? "#334155" : "#4FC3F7" }}>
              {busy ? "…" : "Acknowledge"}
            </button>
          )}
          <button onClick={onRemove} disabled={busy}
            className="font-mono text-[9px] text-slate-600 hover:text-[#EF4444] transition-colors">
            Remove
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main tab ──────────────────────────────────────────────────────────────────

export default function WatchlistTab({
  connectedAddress, network, setNetwork,
}: {
  connectedAddress: string | undefined;
  network:  Network;
  setNetwork: (n: Network) => void;
}) {
  const [list,    setList]    = useState<WatchEntryStatus[]>([]);
  const [loaded,  setLoaded]  = useState(false);
  const [addAddr, setAddAddr] = useState("");
  const [addLabel, setAddLabel] = useState("");
  const [error,   setError]   = useState("");
  const [busyKey, setBusyKey] = useState<string>("");   // "addr|network" being mutated
  const [pending, startTransition] = useTransition();

  const wallet = connectedAddress ?? "";

  const refresh = useCallback(() => {
    if (!isValidAddr(wallet)) { setList([]); setLoaded(true); return; }
    startTransition(async () => {
      const next = await listWatch(wallet);
      setList(next);
      setLoaded(true);
    });
  }, [wallet]);

  useEffect(() => { refresh(); }, [refresh]);

  const onAdd = () => {
    const token = addAddr.trim();
    if (!isValidAddr(token) || !isValidAddr(wallet)) return;
    setError("");
    startTransition(async () => {
      const res = await addWatch(wallet, token, network, addLabel.trim() || undefined);
      if (!res.ok) { setError(res.error ?? "Could not add token."); }
      else { setAddAddr(""); setAddLabel(""); }
      // `list: null` = the store could not be read. Keep what is on screen —
      // blanking it here would show the user an empty watchlist as if it were
      // a fact, which is the same lie this whole fix is about.
      if (res.list) { setList(res.list); setLoaded(true); }
    });
  };

  const onRemove = (addr: string, net: Network) => {
    setBusyKey(`${addr}|${net}`);
    startTransition(async () => {
      const next = await removeWatch(wallet, addr, net);
      setList(next);
      setBusyKey("");
    });
  };

  const onAck = (addr: string, net: Network) => {
    setBusyKey(`${addr}|${net}`);
    startTransition(async () => {
      const next = await ackWatch(wallet, addr, net);
      setList(next);
      setBusyKey("");
    });
  };

  const addrValid = isValidAddr(addAddr.trim());
  const changedCount = list.reduce((n, e) => n + (e.changes.length > 0 ? 1 : 0), 0);

  // ── Not connected ──
  if (!isValidAddr(wallet)) {
    return (
      <div className="rounded-2xl border border-[#F59E0B25] bg-[#F59E0B05] px-5 py-6 text-center">
        <p className="font-mono text-sm text-[#F59E0B] font-medium mb-1">Connect Wallet</p>
        <p className="font-mono text-xs text-slate-500 mb-4">
          Your watchlist is stored per wallet. Connect to monitor a set of B20 tokens
          for compliance-relevant changes.
        </p>
        <ConnectButton label="Connect Wallet" />
      </div>
    );
  }

  return (
    <div>
      {/* Add token */}
      <div className="mb-4">
        <label className="font-mono text-[9px] text-slate-600 tracking-widest uppercase block mb-1.5">
          Watch a B20 token
        </label>
        <div className="flex gap-2 mb-2">
          <input
            value={addAddr}
            onChange={e => setAddAddr(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && addrValid && !pending) onAdd(); }}
            placeholder="0x… B20 token address"
            spellCheck={false}
            className={`flex-1 min-w-0 ${INPUT_CLS}`}
          />
          {/* Network selector */}
          <div className="flex rounded-xl border border-[#1A1A2E] overflow-hidden shrink-0">
            {(["mainnet", "sepolia"] as Network[]).map(n => (
              <button key={n} onClick={() => setNetwork(n)}
                className="px-3 py-2.5 font-mono text-[10px] transition-colors"
                style={network === n
                  ? { background: "#4FC3F720", color: "#4FC3F7" }
                  : { background: "#0a0a12", color: "#475569" }}>
                {n === "mainnet" ? "Base" : "Sepolia"}
              </button>
            ))}
          </div>
        </div>
        <div className="flex gap-2">
          <input
            value={addLabel}
            onChange={e => setAddLabel(e.target.value.slice(0, 40))}
            onKeyDown={e => { if (e.key === "Enter" && addrValid && !pending) onAdd(); }}
            placeholder="Optional label (e.g. USDX treasury)"
            spellCheck={false}
            className={`flex-1 min-w-0 ${INPUT_CLS}`}
          />
          <button
            onClick={onAdd}
            disabled={!addrValid || pending}
            className="px-5 py-2.5 rounded-xl font-mono text-xs font-semibold transition-all shrink-0"
            style={addrValid && !pending
              ? { background: "#4FC3F720", color: "#4FC3F7", border: "1px solid #4FC3F740" }
              : { background: "#0d0d18", color: "#334155", border: "1px solid #1A1A2E", cursor: "not-allowed" }}>
            {pending ? "…" : "+ Watch"}
          </button>
        </div>
        {error && (
          <p className="font-mono text-[11px] text-[#EF4444] mt-2">{error}</p>
        )}
      </div>

      {/* Summary line */}
      {list.length > 0 && (
        <div className="flex items-center gap-3 mb-3">
          <span className="font-mono text-[9px] text-slate-600">
            {list.length} watched
          </span>
          {changedCount > 0 ? (
            <span className="font-mono text-[9px] text-[#F59E0B]">
              {changedCount} with changes
            </span>
          ) : (
            <span className="font-mono text-[9px] text-[#22C55E]">all in sync</span>
          )}
          <button onClick={refresh} disabled={pending}
            className="ml-auto font-mono text-[9px] text-slate-600 hover:text-slate-400 transition-colors">
            {pending ? "Refreshing…" : "↻ Re-check"}
          </button>
        </div>
      )}

      {/* List */}
      {!loaded ? (
        <div className="flex items-center gap-2 py-6">
          <span className="w-1.5 h-1.5 rounded-full bg-[#4FC3F7] animate-pulse" />
          <span className="font-mono text-xs text-slate-500">Re-inspecting watched tokens…</span>
        </div>
      ) : list.length === 0 ? (
        <div className="rounded-2xl border border-[#1A1A2E] bg-[#0a0a0f] px-5 py-6 text-center">
          <p className="font-mono text-sm text-slate-500 mb-1">No tokens watched yet</p>
          <p className="font-mono text-xs text-slate-700">
            Add a B20 token above to capture its baseline and start monitoring for
            pause, policy, and supply-cap changes.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {list.map(entry => {
            const k = `${entry.item.address}|${entry.item.network}`;
            return (
              <WatchCard
                key={k}
                entry={entry}
                busy={pending && busyKey === k}
                onAck={() => onAck(entry.item.address, entry.item.network)}
                onRemove={() => onRemove(entry.item.address, entry.item.network)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
