"use client";
/**
 * Blue Hood — YOUR POSITIONS strip (v3 P2.4, 2026-07-24).
 *
 * Reads ERC-20 balances for every ticker on the drift board (plus USDG
 * + WETH) via wagmi's useReadContracts on Robinhood Chain. Prices come
 * from the shared `TickerSnapshot[]` the drift board already loads —
 * no extra network call for pricing.
 *
 * When the user has zero positions, renders NOTHING so the drift board
 * stays uncluttered for guests. When they hold at least one token, a
 * compact strip appears above the drift table: ticker · qty · $value ·
 * drift now · [Sell] quick-open.
 *
 * Cost basis / P&L are intentionally OMITTED — we don't have a canonical
 * "since first seen" tracker yet, and inventing an avg cost per user
 * spec ("KHÔNG bịa avg cost") is worse than showing nothing. Add later
 * once P2-skill can enumerate historical transfers on RH.
 *
 * Non-custodial: reads only. No signing. `onOpenTrade` hands off to the
 * existing ReviewSignPanel, which enforces all guards + P0 allowance-race
 * pre-checks.
 */
import { useMemo } from "react";
import { useAccount, useReadContracts } from "wagmi";
import type { TickerSnapshot } from "@/lib/blue-hood/types";
import { RWA_TOKENS } from "@/lib/robinhood/rwa-registry";

const RH_CHAIN_ID = 4663;
const RH_GREEN = "#34D399";
const RED = "#ef4444";
const AMBER = "#f5b342";
const MUTED = "#6a7080";
const BORDER = "#1a1e26";
const SURFACE = "#0b0d12";

const ERC20_BALANCE_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// USDG / WETH are always shown even if zero because they're the trade
// denominations — a user with $0 USDG needs to know before opening a
// buy panel. Every OTHER ticker only surfaces on non-zero balance.
const ALWAYS_SHOW = new Set(["USDG", "WETH"]);

interface Position {
  ticker: string;
  contract: string;
  decimals: number;
  balance: bigint;
  qty: number;
  priceUsd: number | null;
  valueUsd: number | null;
  driftPct: number | null;
  isDenom: boolean;
}

function formatQty(qty: number): string {
  if (qty === 0) return "0";
  if (qty >= 1000) return qty.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (qty >= 1) return qty.toFixed(2);
  if (qty >= 0.001) return qty.toFixed(4);
  return qty.toExponential(2);
}

function formatUsd(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n > 0) return `$${n.toFixed(4)}`;
  return "$0";
}

export function usePositions(tickers: TickerSnapshot[]): {
  positions: Position[];
  isLoading: boolean;
  totalValueUsd: number;
} {
  const { address, isConnected } = useAccount();

  // Map ticker → snapshot so we can attach live price + drift after
  // the balance multicall returns. Falls back to zero for tickers not
  // on the drift board (USDG stable + WETH).
  const snapByTicker = useMemo(() => {
    const m = new Map<string, TickerSnapshot>();
    for (const t of tickers) m.set(t.ticker, t);
    return m;
  }, [tickers]);

  // Universe = all RWA tokens + USDG + WETH from the registry. We
  // fold in whatever the drift board has (which excludes tokens
  // without a Chainlink feed like BE) so we don't miss a holding.
  const universe = useMemo(() => {
    return RWA_TOKENS.map((t) => ({
      ticker: t.ticker,
      contract: t.contract,
      decimals: t.decimals,
      isDenom: t.kind === "stable" || t.kind === "wrapped",
    }));
  }, []);

  const contracts = useMemo(() => {
    if (!isConnected || !address) return [];
    return universe.map((t) => ({
      address: t.contract as `0x${string}`,
      abi: ERC20_BALANCE_ABI,
      functionName: "balanceOf" as const,
      args: [address as `0x${string}`],
      chainId: RH_CHAIN_ID,
    }));
  }, [universe, address, isConnected]);

  const { data, isLoading } = useReadContracts({
    contracts,
    query: {
      enabled: isConnected && !!address && contracts.length > 0,
      refetchInterval: 30_000, // 30s — post-swap fresh state within one drift-board cycle
      staleTime: 15_000,
    },
  });

  const positions = useMemo<Position[]>(() => {
    if (!data) return [];
    const out: Position[] = [];
    for (let i = 0; i < universe.length; i++) {
      const t = universe[i];
      const result = data[i];
      // useReadContracts returns { status: "success" | "failure", result?, error? }
      const balance = result?.status === "success" && typeof result.result === "bigint"
        ? result.result
        : 0n;
      const qty = Number(balance) / Math.pow(10, t.decimals);
      const snap = snapByTicker.get(t.ticker);
      const priceUsd = snap?.dex_usd ?? snap?.oracle_usd ?? (t.ticker === "USDG" ? 1 : null);
      const valueUsd = priceUsd !== null && qty > 0 ? qty * priceUsd : null;
      const driftPct = snap?.drift_pct ?? null;

      // Filter: hide zero balances for non-denom tokens; keep USDG/WETH
      // visible even at zero so the user knows their trade budget.
      if (balance === 0n && !ALWAYS_SHOW.has(t.ticker)) continue;
      out.push({
        ticker: t.ticker,
        contract: t.contract,
        decimals: t.decimals,
        balance,
        qty,
        priceUsd,
        valueUsd,
        driftPct,
        isDenom: t.isDenom,
      });
    }
    // Sort: non-denom holdings (by value desc), then denoms (USDG, WETH).
    out.sort((a, b) => {
      if (a.isDenom !== b.isDenom) return a.isDenom ? 1 : -1;
      return (b.valueUsd ?? 0) - (a.valueUsd ?? 0);
    });
    return out;
  }, [data, universe, snapByTicker]);

  const totalValueUsd = useMemo(
    () => positions.reduce((sum, p) => sum + (p.valueUsd ?? 0), 0),
    [positions],
  );

  return { positions, isLoading, totalValueUsd };
}

export function positionsHeldMap(positions: Position[]): Set<string> {
  const s = new Set<string>();
  for (const p of positions) {
    if (!p.isDenom && p.balance > 0n) s.add(p.ticker);
  }
  return s;
}

interface PositionsStripProps {
  tickers: TickerSnapshot[];
  /**
   * Set of tickers with a currently-OPEN arrow. The [Sell] button is
   * only enabled for these — the ReviewSignPanel is tightly coupled to
   * an Arrow object today, and opening it with a stale/graded arrow
   * would put the panel in read-only mode. Cleaner UX to show a tooltip
   * "no open signal — trade via that ticker's row" than to open a dead
   * modal. When (future) manual trading lands, drop this constraint.
   */
  tickersWithOpenArrow: Set<string>;
  onOpenTrade?: (ticker: string, side: "buy" | "sell") => void;
}

export default function PositionsStrip({ tickers, tickersWithOpenArrow, onOpenTrade }: PositionsStripProps) {
  const { isConnected } = useAccount();
  const { positions, isLoading, totalValueUsd } = usePositions(tickers);

  // Guest / cold state: render nothing so the drift board stays clean.
  if (!isConnected || positions.length === 0) return null;

  const heldCount = positions.filter((p) => !p.isDenom && p.balance > 0n).length;

  return (
    <div
      className="mb-6 rounded border"
      style={{ borderColor: BORDER, backgroundColor: SURFACE }}
    >
      <div className="flex items-center justify-between px-4 py-2.5 border-b" style={{ borderColor: BORDER }}>
        <div className="flex items-center gap-3">
          <span className="text-[11px] uppercase tracking-widest" style={{ color: MUTED }}>
            Your positions
          </span>
          {heldCount > 0 && (
            <span className="text-[10px]" style={{ color: RH_GREEN }}>
              {heldCount} held
            </span>
          )}
          {isLoading && (
            <span className="text-[10px]" style={{ color: MUTED }}>
              refreshing…
            </span>
          )}
        </div>
        <div className="tabular-nums text-[12px]" style={{ color: totalValueUsd > 0 ? "#e7e9ee" : MUTED }}>
          total {formatUsd(totalValueUsd)}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="text-[10px] uppercase" style={{ color: MUTED, letterSpacing: "0.08em" }}>
              <th className="px-3 py-1.5 text-left font-normal">ticker</th>
              <th className="px-3 py-1.5 text-right font-normal">qty</th>
              <th className="px-3 py-1.5 text-right font-normal">value</th>
              <th className="px-3 py-1.5 text-right font-normal">drift</th>
              <th className="px-3 py-1.5 text-right font-normal">action</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((p) => {
              const driftColor = p.driftPct === null
                ? MUTED
                : p.driftPct > 0
                  ? RH_GREEN
                  : p.driftPct < 0
                    ? RED
                    : MUTED;
              return (
                <tr key={p.ticker} className="border-t" style={{ borderColor: "#0f1218" }}>
                  <td className="px-3 py-1.5 text-left">
                    <div className="flex items-center gap-2">
                      <span className="text-white">{p.ticker}</span>
                      {p.isDenom && (
                        <span className="text-[9px] uppercase" style={{ color: MUTED }}>
                          denom
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums" style={{ color: "#9aa1ac" }}>
                    {formatQty(p.qty)}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums" style={{ color: p.valueUsd && p.valueUsd > 0 ? "#e7e9ee" : MUTED }}>
                    {formatUsd(p.valueUsd)}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums" style={{ color: driftColor }}>
                    {p.driftPct === null ? "—" : `${p.driftPct > 0 ? "+" : ""}${p.driftPct.toFixed(2)}%`}
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    {p.isDenom ? (
                      <span className="text-[10px]" style={{ color: MUTED }}>—</span>
                    ) : p.balance > 0n && onOpenTrade ? (
                      tickersWithOpenArrow.has(p.ticker) ? (
                        <button
                          onClick={() => onOpenTrade(p.ticker, "sell")}
                          className="rounded border px-2 py-0.5 text-[10px] hover:bg-black/40 transition-colors"
                          style={{ borderColor: AMBER, color: AMBER }}
                          title={`Open sell panel for ${p.ticker}`}
                        >
                          [Sell]
                        </button>
                      ) : (
                        <span
                          className="text-[9px]"
                          style={{ color: MUTED }}
                          title="No open signal on this ticker — hit the row on the drift board to see verdict, or wait for the next arrow."
                        >
                          no active signal
                        </span>
                      )
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="px-4 py-1.5 border-t text-[9px]" style={{ borderColor: BORDER, color: MUTED }}>
        Balances refresh every 30s · prices from drift-board snapshot · non-custodial · no cost basis stored (P&L requires historical transfer tracking, not yet wired)
      </div>
    </div>
  );
}
