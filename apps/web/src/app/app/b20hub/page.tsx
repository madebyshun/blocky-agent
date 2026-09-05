import type { Metadata } from "next";
import Link from "next/link";
import FeedGrid from "./FeedGrid";

export const metadata: Metadata = {
  title: "B20HUB — Feed",
  description:
    "Every B20HUB launch: 100B supply, ~$6K opening market cap, LP permanently locked in the fee-splitter hook. 80% creator / 15% $BLUE buyback / 5% treasury forever.",
};

/**
 * Landing / feed page. Two columns:
 * - Hero + stats + how-it-works (compact, above the fold on desktop)
 * - Live grid of B20HUB launches below (streamed from /api/b20hub/tokens)
 */
export default function B20HUBLandingPage() {
  return (
    <div className="space-y-10">
      <HeroBlock />
      <FeedGrid />
    </div>
  );
}

function HeroBlock() {
  return (
    <section className="grid md:grid-cols-2 gap-6 items-start">
      <div>
        <p className="font-mono text-[9px] text-slate-600 tracking-widest uppercase mb-3">
          launch a real b20 · on base
        </p>
        <h1 className="font-mono text-3xl md:text-4xl font-bold leading-tight mb-3">
          Fixed-supply tokens on a permanently-locked Uniswap V4 pool.
        </h1>
        <p className="font-mono text-sm text-slate-400 leading-relaxed mb-5">
          Every launch: 100B tokens seeded into a V4 pool with a custom hook.
          The hook holds the LP NFTs forever and splits every swap fee
          <span className="text-[#34D399] font-bold"> 80% </span>creator /
          <span className="text-[#4FC3F7] font-bold"> 15% </span>$BLUE buyback /
          <span className="text-slate-300 font-bold"> 5% </span>treasury.
          Admin renounced at deploy. Trustless. No upfront fees. Just gas.
        </p>
        <div className="flex flex-wrap gap-2">
          <Link
            href="/app/b20hub/launch"
            className="inline-flex items-center font-mono text-sm font-bold px-4 py-2.5 rounded-xl transition-all"
            style={{ background: "#34D399", color: "#050508" }}
          >
            Launch a token →
          </Link>
          <Link
            href="/app/b20hub/docs"
            className="inline-flex items-center font-mono text-sm px-4 py-2.5 rounded-xl transition-colors"
            style={{ border: "1px solid #1A1A2E", color: "#94A3B8" }}
          >
            How it works
          </Link>
        </div>
      </div>
      <StatsPanel />
    </section>
  );
}

function StatsPanel() {
  // Static "protocol facts" — no fabricated numbers. Real per-token stats
  // live inside FeedGrid + token-detail pages.
  return (
    <div className="rounded-2xl border border-[#1A1A2E] bg-[#0a0a0f] p-5 space-y-4">
      <p className="font-mono text-[9px] text-slate-600 tracking-widest uppercase">
        protocol constants
      </p>
      <StatRow label="Supply per launch" value="100,000,000,000 tokens" />
      <StatRow label="Opening market cap" value="~$6K @ $1.8K ETH" hint="scales with ETH price · 3.333 ETH baked-in" />
      <StatRow label="Creator share" value="80% of every swap fee" accent="#34D399" />
      <StatRow label="BLUE buyback" value="15% → swap → burn/hold" accent="#4FC3F7" />
      <StatRow label="Treasury" value="5% → BlueAgent multisig" />
      <StatRow label="LP" value="Permanently locked in the hook" />
      <StatRow label="Admin" value="Renounced at deploy" />
      <StatRow label="Fee tiers" value="0.3% · 1% · 3% (V4 dynamic disabled)" />
    </div>
  );
}

function StatRow({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: string;
  hint?: string;
  accent?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="font-mono text-[10px] text-slate-600 tracking-wider uppercase mt-0.5">
        {label}
      </span>
      <div className="text-right">
        <div className="font-mono text-xs font-bold" style={{ color: accent ?? "#e2e8f0" }}>
          {value}
        </div>
        {hint && <div className="font-mono text-[9px] text-slate-600">{hint}</div>}
      </div>
    </div>
  );
}
