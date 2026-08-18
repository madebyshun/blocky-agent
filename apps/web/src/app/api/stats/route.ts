/**
 * /api/stats — operator dashboard data (gated).
 *
 * Per-tool paid-run counts + estimated revenue (runs × price) + live USDC
 * balance of the Club wallet. Gated by ?key= matching STATS_SECRET (falls
 * back to CRON_SECRET). If no secret is configured, access is open (dev).
 */
import { NextRequest, NextResponse } from "next/server";
import { kvGet } from "@/lib/kv";
import { AGENT_TOOLS } from "@/lib/agent-tools";

export const runtime = "nodejs";
// Vercel kills serverless functions at 60s by default — explicit budget so
// it fails loudly instead of silently 504-ing.
export const maxDuration = 15;

const PAY_TO = "0x02950ad38ada1d599375bd447e080cd404809205";
const USDC   = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

function priceNum(price?: string): number {
  if (!price) return 0;
  const n = parseFloat(price.replace("$", "").trim());
  return Number.isNaN(n) ? 0 : n;
}

async function usdcBalance(): Promise<number | null> {
  try {
    const r = await fetch("https://mainnet.base.org", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "eth_call",
        params: [{ to: USDC, data: "0x70a08231000000000000000000000000" + PAY_TO.slice(2) }, "latest"],
      }),
      signal: AbortSignal.timeout(8000),
    });
    const d = await r.json() as { result?: string };
    return d.result ? parseInt(d.result, 16) / 1e6 : null;
  } catch { return null; }
}

export async function GET(_req: NextRequest) {
  // Public access — page itself is unlisted (no nav link, robots noindex)
  const rows = (await Promise.all(
    AGENT_TOOLS.map(async t => {
      const runs = (await kvGet<number>(`usage:${t.id}`)) ?? 0;
      const price = priceNum(t.price);
      return {
        id: t.id,
        name: t.name,
        category: t.category,
        price: t.price ?? "",
        runs,
        revenueEst: +(runs * price).toFixed(4),
      };
    })
  )).sort((a, b) => b.runs - a.runs || b.revenueEst - a.revenueEst);

  const totalRuns       = rows.reduce((s, r) => s + r.runs, 0);
  const totalRevenueEst = +rows.reduce((s, r) => s + r.revenueEst, 0).toFixed(4);
  const usdcBal         = await usdcBalance();

  return NextResponse.json(
    {
      totals: {
        tools: rows.length,
        totalRuns,
        totalRevenueEst,
        usdcBalance: usdcBal,
        wallet: PAY_TO,
      },
      rows,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
