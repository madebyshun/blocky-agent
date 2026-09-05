"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { B20HUBFeedResponse } from "@/app/api/b20hub/tokens/route";
import { fmtPriceUsd, fmtUsdCompact, fmtPct, fmtAge } from "@/lib/b20hub/format";

type Token = B20HUBFeedResponse["tokens"][number];
type SortKey = "trending" | "new" | "mcap" | "vol";

export default function FeedGrid() {
  const [data, setData]       = useState<B20HUBFeedResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr]         = useState("");
  const [search, setSearch]   = useState("");
  const [sort,   setSort]     = useState<SortKey>("trending");

  useEffect(() => {
    let alive = true;
    fetch("/api/b20hub/tokens")
      .then((r) => r.json())
      .then((d: B20HUBFeedResponse) => { if (alive) { setData(d); setLoading(false); } })
      .catch(() => { if (alive) { setErr("Failed to load feed"); setLoading(false); } });
    // Auto-refresh every 30s so early adopters see new launches without reload.
    const int = setInterval(() => {
      fetch("/api/b20hub/tokens")
        .then((r) => r.json())
        .then((d: B20HUBFeedResponse) => { if (alive) setData(d); })
        .catch(() => {});
    }, 30_000);
    return () => { alive = false; clearInterval(int); };
  }, []);

  const filteredSorted = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    let list = data.tokens.filter((t) => {
      if (!q) return true;
      return (
        t.tokenName?.toLowerCase().includes(q) ||
        t.tokenSymbol?.toLowerCase().includes(q) ||
        t.tokenAddress.toLowerCase().includes(q)
      );
    });
    switch (sort) {
      case "new":
        list = [...list].sort((a, b) => b.launchedAt - a.launchedAt);
        break;
      case "mcap":
        list = [...list].sort((a, b) => (b.market?.marketCap ?? 0) - (a.market?.marketCap ?? 0));
        break;
      case "vol":
        list = [...list].sort((a, b) => (b.market?.volume24h ?? 0) - (a.market?.volume24h ?? 0));
        break;
      case "trending":
      default:
        // Trending = high 24h vol AND recent (within 24h weight).
        list = [...list].sort((a, b) => {
          const av = a.market?.volume24h ?? 0;
          const bv = b.market?.volume24h ?? 0;
          const aAgeH = Math.max(1, (Date.now() - a.launchedAt) / 3_600_000);
          const bAgeH = Math.max(1, (Date.now() - b.launchedAt) / 3_600_000);
          return bv / bAgeH - av / aAgeH;
        });
        break;
    }
    return list;
  }, [data, search, sort]);

  return (
    <section>
      <div className="flex items-baseline justify-between mb-4 flex-wrap gap-2">
        <h2 className="font-mono text-sm font-bold">Feed</h2>
        {data && (
          <div className="flex items-center gap-3 font-mono text-[10px] text-slate-600">
            <span><span className="text-slate-400">{data.count}</span> launched</span>
            <span><span className="text-slate-400">{fmtUsdCompact(data.stats.totalMarketCap)}</span> total mcap</span>
            <span><span className="text-slate-400">{fmtUsdCompact(data.stats.totalVolume24h)}</span> 24h vol</span>
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-[#1A1A2E] bg-[#0a0a0f] p-3 mb-4 flex flex-wrap gap-2 items-center">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="🔍 Search name, symbol or 0x address…"
          spellCheck={false}
          className="flex-1 min-w-[220px] bg-[#0a0a12] border border-[#1A1A2E] focus:border-[#4FC3F740] rounded-lg px-3 py-2 font-mono text-xs text-slate-200 placeholder:text-slate-700 outline-none transition-colors"
        />
        <div className="flex rounded-lg border border-[#1A1A2E] overflow-hidden">
          {(["trending", "new", "mcap", "vol"] as SortKey[]).map((k, i) => (
            <button
              key={k}
              onClick={() => setSort(k)}
              className="px-3 py-1.5 font-mono text-[10px] transition-all"
              style={sort === k
                ? { background: "#4FC3F715", color: "#4FC3F7", borderRight: i < 3 ? "1px solid #1A1A2E" : undefined }
                : { color: "#475569", borderRight: i < 3 ? "1px solid #1A1A2E" : undefined }}
            >
              {k === "trending" ? "🔥 Trending"
                : k === "new"  ? "New"
                : k === "mcap" ? "MCap ↓"
                : "24h Vol ↓"}
            </button>
          ))}
        </div>
      </div>

      {loading && (
        <div className="rounded-2xl border border-[#1A1A2E] bg-[#0a0a0f] py-16 text-center">
          <div className="inline-block w-2 h-2 rounded-full bg-[#4FC3F7] animate-pulse" />
          <p className="font-mono text-[10px] text-slate-600 mt-3">Loading feed…</p>
        </div>
      )}

      {err && (
        <div className="rounded-2xl border border-red-500/30 bg-red-500/5 py-8 text-center">
          <p className="font-mono text-xs text-red-400">{err}</p>
        </div>
      )}

      {!loading && !err && data && data.tokens.length === 0 && <EmptyState />}

      {!loading && !err && filteredSorted.length === 0 && data && data.tokens.length > 0 && (
        <div className="rounded-2xl border border-[#1A1A2E] bg-[#0a0a0f] py-12 text-center">
          <p className="font-mono text-xs text-slate-500">No matches for &quot;{search}&quot;.</p>
        </div>
      )}

      {!loading && !err && filteredSorted.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredSorted.map((t) => <TokenCard key={t.tokenAddress} t={t} />)}
        </div>
      )}
    </section>
  );
}

function TokenCard({ t }: { t: Token }) {
  const sym = (t.tokenSymbol || t.tokenName || "?").replace(/^\$/, "");
  const changeColor = t.market?.change24h == null
    ? "#64748B"
    : t.market.change24h >= 0 ? "#22C55E" : "#EF4444";

  return (
    <Link
      href={`/app/b20hub/token/${t.tokenAddress}`}
      className="rounded-2xl border border-[#1A1A2E] bg-[#0a0a0f] p-4 hover:border-[#4FC3F7]/40 transition-colors block"
    >
      <div className="flex items-start gap-3 mb-3">
        {t.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={t.image}
            alt={sym}
            className="w-11 h-11 rounded-lg object-cover bg-[#0d0d16] shrink-0"
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
          />
        ) : (
          <div
            className="w-11 h-11 rounded-lg flex items-center justify-center text-sm font-bold shrink-0"
            style={{ background: "#4FC3F715", border: "1px solid #4FC3F740", color: "#4FC3F7" }}
          >
            {sym.slice(0, 2).toUpperCase()}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="font-mono text-sm font-bold truncate">{t.tokenName || sym}</div>
          <div className="font-mono text-[10px] text-slate-500">
            ${sym}/ETH
          </div>
          <div className="flex gap-1 mt-1.5">
            <Badge label="ETH" color="#4FC3F7" />
            <Badge label="Immutable" color="#22C55E" />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 text-left">
        <Stat label="MARKET CAP" value={fmtUsdCompact(t.market?.marketCap)} />
        <Stat label="PRICE"      value={fmtPriceUsd(t.market?.priceUsd)} />
        <Stat label="VOLUME 24H" value={fmtUsdCompact(t.market?.volume24h)} />
        <Stat label="24H %"      value={fmtPct(t.market?.change24h)} color={changeColor} />
      </div>

      <div className="mt-3 pt-3 border-t border-[#1A1A2E] flex items-center justify-between font-mono text-[9px] text-slate-600">
        <span>⌚ {fmtAge(t.launchedAt)}</span>
        <span className="tracking-wider">{t.tokenAddress.slice(0, 6)}…{t.tokenAddress.slice(-4)}</span>
      </div>
    </Link>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <div className="font-mono text-[9px] text-slate-600 tracking-widest uppercase">{label}</div>
      <div
        className="font-mono text-xs font-bold tabular-nums"
        style={{ color: color ?? "#e2e8f0" }}
      >
        {value}
      </div>
    </div>
  );
}

function Badge({ label, color }: { label: string; color: string }) {
  return (
    <span
      className="font-mono text-[8px] tracking-wider uppercase px-1.5 py-0.5 rounded"
      style={{ background: `${color}15`, color, border: `1px solid ${color}40` }}
    >
      {label}
    </span>
  );
}

function EmptyState() {
  return (
    <div className="rounded-2xl border border-[#1A1A2E] bg-[#0a0a0f] py-12 text-center">
      <div className="text-2xl mb-2">🔷</div>
      <p className="font-mono text-sm text-slate-300 mb-1">No launches yet</p>
      <p className="font-mono text-[11px] text-slate-500 mb-4">
        Be the first to launch a B20HUB token.
      </p>
      <Link
        href="/app/b20hub/launch"
        className="inline-flex items-center font-mono text-xs font-bold px-4 py-2 rounded-lg transition-all"
        style={{ background: "#34D399", color: "#050508" }}
      >
        Launch first token →
      </Link>
    </div>
  );
}
