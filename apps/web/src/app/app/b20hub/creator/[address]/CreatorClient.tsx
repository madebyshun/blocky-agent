"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { B20HUBFeedResponse } from "@/app/api/b20hub/tokens/route";

/**
 * Creator profile: filter the feed by launches whose recorded feeRecipient
 * (wallet type) matches the given address. This isn't a perfect proxy for
 * "the hook creator" — the hook stores the launch-time creator, which the
 * launcher takes from LaunchParams.creator. But for our KV registry
 * feeRecipient tracks the same wallet in practice for Base launches.
 *
 * Follow-up: index by hook.creatorOfPool directly by walking all pools
 * once we have >100 tokens.
 */
export default function CreatorClient({ address }: { address: `0x${string}` }) {
  const [feed,    setFeed]    = useState<B20HUBFeedResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/b20hub/tokens?limit=200")
      .then((r) => r.json())
      .then((d: B20HUBFeedResponse) => { setFeed(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const mine = (feed?.tokens ?? []).filter(
    (t) => t.feeRecipient?.value?.toLowerCase() === address.toLowerCase(),
  );

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-4">
        <div className="w-14 h-14 rounded-xl flex items-center justify-center text-lg font-bold shrink-0"
          style={{ background: "#4FC3F715", border: "1px solid #4FC3F740", color: "#4FC3F7" }}>
          {address.slice(2, 4).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[9px] text-slate-600 tracking-widest uppercase mb-1">
            b20hub creator
          </p>
          <h1 className="font-mono text-xl font-bold break-all">
            {address.slice(0, 10)}…{address.slice(-8)}
          </h1>
          <a href={`https://basescan.org/address/${address}`} target="_blank" rel="noopener noreferrer"
            className="font-mono text-[10px] text-[#4FC3F7] hover:underline">
            Basescan ↗
          </a>
        </div>
        <div className="text-right">
          <div className="font-mono text-2xl font-bold">{mine.length}</div>
          <div className="font-mono text-[9px] text-slate-600 tracking-widest uppercase">launches</div>
        </div>
      </div>

      {loading && (
        <div className="rounded-2xl border border-[#1A1A2E] bg-[#0a0a0f] py-12 text-center">
          <div className="inline-block w-2 h-2 rounded-full bg-[#4FC3F7] animate-pulse" />
          <p className="font-mono text-[10px] text-slate-600 mt-3">Loading launches…</p>
        </div>
      )}

      {!loading && mine.length === 0 && (
        <div className="rounded-2xl border border-[#1A1A2E] bg-[#0a0a0f] py-12 text-center">
          <p className="font-mono text-sm text-slate-300 mb-1">No B20HUB launches yet</p>
          <p className="font-mono text-[11px] text-slate-500 mb-4">
            This wallet hasn&apos;t deployed anything through B20HUB — or its
            launches haven&apos;t been indexed yet.
          </p>
          <Link href="/app/b20hub/launch"
            className="inline-flex items-center font-mono text-xs font-bold px-4 py-2 rounded-lg"
            style={{ background: "#34D399", color: "#050508" }}>
            Launch a token →
          </Link>
        </div>
      )}

      {!loading && mine.length > 0 && (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {mine.map((t) => (
            <Link key={t.tokenAddress} href={`/app/b20hub/token/${t.tokenAddress}`}
              className="rounded-2xl border border-[#1A1A2E] bg-[#0a0a0f] p-4 hover:border-[#4FC3F7]/40 transition-colors block">
              <div className="font-mono text-sm font-bold mb-1">{t.tokenName || t.tokenSymbol}</div>
              <div className="font-mono text-[10px] text-slate-500 mb-3">${t.tokenSymbol}</div>
              <div className="grid grid-cols-2 gap-2 text-[10px] font-mono">
                <div>
                  <div className="text-slate-600 tracking-wider uppercase">MCap</div>
                  <div className="text-slate-200 font-bold">
                    {t.market?.marketCap != null
                      ? "$" + (t.market.marketCap >= 1000 ? (t.market.marketCap / 1000).toFixed(1) + "K" : t.market.marketCap.toFixed(2))
                      : "—"}
                  </div>
                </div>
                <div>
                  <div className="text-slate-600 tracking-wider uppercase">24h Vol</div>
                  <div className="text-slate-200 font-bold">
                    {t.market?.volume24h != null
                      ? "$" + (t.market.volume24h >= 1000 ? (t.market.volume24h / 1000).toFixed(1) + "K" : t.market.volume24h.toFixed(2))
                      : "$0"}
                  </div>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
