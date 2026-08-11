// x402/lp-analyzer
// LP Position Analyzer — grounded in REAL pool data when a `pool` address is given:
// live TVL + 24h volume + current price (GeckoTerminal). Impermanent loss is computed
// DETERMINISTICALLY (2√r/(1+r)−1) from the real price move (entry→current, or 24h),
// and fee yield is estimated from real volume/TVL × fee tier. The LLM only writes the
// rebalance verdict/narrative on top — it never invents IL, fees or APR.
// Resilient: graceful fallback, never 500.
// Price: $0.25

import { getBasePool, impermanentLoss, type PoolDetail } from "@/lib/market-data";
import { callLLM } from "@/app/api/_lib/llm";

type BankrMessage = { role: string; content: string };
// Delegates to the shared Virtuals → Venice → Bankr chain. Bankr was
// banned 2026-07-18; the direct-Bankr fetch this used to do is dead
// on prod. `callLLM` retries providers in order and returns text +
// provenance. Name/signature preserved so all call sites stay identical.
async function callBankrLLM(opts: { system: string; messages: BankrMessage[]; temperature?: number; maxTokens?: number }): Promise<string> {
  const r = await callLLM({ system: opts.system, messages: opts.messages, temperature: opts.temperature, maxTokens: opts.maxTokens });
  return r.text;
}
function extractJsonObject(text: string): Record<string, unknown> | null {
  let raw = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
  const s = raw.indexOf("{"), e = raw.lastIndexOf("}");
  if (s >= 0 && e > s) raw = raw.slice(s, e + 1);
  try { return JSON.parse(raw); } catch {}
  try { return JSON.parse(raw.replace(/[\x00-\x1F\x7F]/g, " ")); } catch {}
  return null;
}
const pct = (n: number | null) => (n == null ? null : +(n * 100).toFixed(2));
const usd = (n: number | null) => (n == null ? "?" : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(2)}`);

export default async function handler(req: Request): Promise<Response> {
  if (req.method === "GET") {
    return Response.json({
      service: "lp-analyzer",
      description: "LP position analysis — real pool TVL/volume (GeckoTerminal), deterministic impermanent loss, fee-yield estimate, rebalance signal",
      price: "$0.25",
      params: { pool: "Base pool address 0x... (grounds the analysis in real data)", entryPrice: "Pool price when you opened (for exact IL)", investedAmount: "Your position size in USD (for $ fee income)", feeTier: "Pool fee % e.g. 0.3 (optional)" },
    });
  }

  try {
    let body: { positionId?: string; pool?: string; token0?: string; token1?: string; entryPrice?: string; investedAmount?: string; feeTier?: string } = {};
    try { const t = await req.text(); if (t?.trim().startsWith("{")) body = JSON.parse(t); } catch {}
    const url = new URL(req.url);
    const pool = body.pool ?? url.searchParams.get("pool") ?? "";
    const token0 = body.token0 ?? url.searchParams.get("token0") ?? "";
    const token1 = body.token1 ?? url.searchParams.get("token1") ?? "";
    const positionId = body.positionId ?? url.searchParams.get("positionId") ?? "";
    const entryPrice = parseFloat(body.entryPrice ?? url.searchParams.get("entryPrice") ?? "");
    const investedAmount = parseFloat(body.investedAmount ?? url.searchParams.get("investedAmount") ?? "");
    const feeTierIn = parseFloat(body.feeTier ?? url.searchParams.get("feeTier") ?? "");
    if (!pool && !positionId && !token0) {
      return Response.json({ error: "Provide a pool address (0x...) to ground the analysis, or token0/token1" }, { status: 400 });
    }

    // ── Real pool data (GeckoTerminal) ────────────────────────────────────────
    const p: PoolDetail | null = pool ? await getBasePool(pool) : null;
    const grounded = !!p;

    // ── Deterministic impermanent loss ────────────────────────────────────────
    // Prefer entry→current ratio (exact since position opened); else 24h move.
    let ilFraction: number | null = null;
    let ilBasis = "n/a";
    if (p && Number.isFinite(entryPrice) && entryPrice > 0 && p.poolPrice != null) {
      ilFraction = impermanentLoss(p.poolPrice / entryPrice);
      ilBasis = "entry→current price";
    } else if (p && p.change24hPct != null) {
      ilFraction = impermanentLoss(1 + p.change24hPct / 100);
      ilBasis = "last 24h price move";
    }
    const ilPct = pct(ilFraction);

    // ── Fee-yield estimate from real volume/TVL × fee tier ────────────────────
    const feeRate = Number.isFinite(feeTierIn) && feeTierIn > 0 ? feeTierIn / 100 : (p?.feePct != null ? p.feePct / 100 : 0.003);
    let feeAprPct: number | null = null;
    let dailyFeesPoolUsd: number | null = null;
    if (p && p.volume24h != null && p.reserveUsd && p.reserveUsd > 0) {
      dailyFeesPoolUsd = p.volume24h * feeRate;
      feeAprPct = +((dailyFeesPoolUsd / p.reserveUsd) * 365 * 100).toFixed(2);
    }
    const myDailyFees = feeAprPct != null && Number.isFinite(investedAmount) && investedAmount > 0
      ? +((feeAprPct / 100 / 365) * investedAmount).toFixed(2) : null;

    const computed = {
      pool_data: p ? { name: p.name, tvl_usd: p.reserveUsd, volume_24h_usd: p.volume24h, current_price: p.poolPrice, change_24h_pct: p.change24hPct, fee_pct: p.feePct ?? feeRate * 100 } : null,
      impermanent_loss: { value_pct: ilPct, basis: ilBasis },
      fee_yield: { apr_pct: feeAprPct, fee_rate_pct: +(feeRate * 100).toFixed(4), my_daily_fees_usd: myDailyFees, assumed_fee_tier: !(p?.feePct != null) && !(Number.isFinite(feeTierIn) && feeTierIn > 0) },
      net_30d_pct: ilPct != null && feeAprPct != null ? +(feeAprPct / 12 + ilPct).toFixed(2) : null,
    };

    const ctx = grounded
      ? `REAL pool data (GeckoTerminal): ${p!.name} — TVL ${usd(p!.reserveUsd)}, 24h volume ${usd(p!.volume24h)}, current price ${p!.poolPrice ?? "?"} (24h ${p!.change24hPct ?? "?"}%), fee tier ${(p!.feePct ?? feeRate * 100)}%.
Computed (do not change these numbers): impermanent loss ${ilPct ?? "?"}% (${ilBasis}); estimated fee APR ${feeAprPct ?? "?"}% (volume×fee/TVL); net 30d ≈ ${computed.net_30d_pct ?? "?"}%.${myDailyFees != null ? ` Your est. fee income ${usd(myDailyFees)}/day on ${usd(investedAmount)} invested.` : ""}`
      : `No pool address resolved on GeckoTerminal — provide a Base pool 0x... for real numbers. Give a clearly-labelled qualitative estimate; do not present precise IL/fee figures as measured.`;

    const system = `You are Blue Agent — LP position analyst for Base (chain 8453).
${grounded ? "You are given REAL pool metrics and DETERMINISTICALLY COMPUTED impermanent loss + fee-yield. Reference those exact numbers; NEVER change or invent them. Only judge the rebalance signal and write the narrative." : "No live pool data — clearly frame the output as an estimate, not measured."}
Return ONLY raw JSON. No markdown.
Schema: {
  "rebalanceSignal": "HOLD | REBALANCE | EXIT",
  "rebalanceReason": "<reference the real IL vs fee APR>",
  "ilSeverity": "LOW | MEDIUM | HIGH | CRITICAL",
  "recommendation": "<1-2 sentences>",
  "riskFactors": ["<factor>", "<factor>"]
}`;

    let narrative: Record<string, unknown> | null = null;
    for (let attempt = 0; attempt < 2 && !narrative; attempt++) {
      try { narrative = extractJsonObject(await callBankrLLM({ system, messages: [{ role: "user", content: `${ctx}\nPair: ${token0 || p?.baseSymbol || "?"}/${token1 || p?.quoteSymbol || "?"}` }] })); } catch { /* retry */ }
    }
    if (!narrative) {
      const severe = ilPct != null && ilPct <= -5;
      narrative = {
        rebalanceSignal: severe ? "REBALANCE" : "HOLD",
        rebalanceReason: grounded ? "Narrative synthesis briefly unavailable — IL/fee figures below are computed from real pool data. Re-run for the full read." : "Re-run, or supply a pool address for real numbers.",
        ilSeverity: ilPct == null ? "LOW" : ilPct <= -10 ? "CRITICAL" : ilPct <= -5 ? "HIGH" : ilPct <= -1 ? "MEDIUM" : "LOW",
        recommendation: grounded ? "Compare the computed fee APR against impermanent loss before adding/removing liquidity." : "Provide a pool address for a grounded analysis.",
        riskFactors: ["Price divergence increases IL", "Fee APR estimate assumes constant volume"],
        degraded: true,
      };
    }

    return Response.json({
      tool: "lp-analyzer",
      timestamp: new Date().toISOString(),
      data_source: grounded ? "GeckoTerminal (live pool) + deterministic IL/fee math" : "estimate (no pool resolved on GeckoTerminal)",
      pool: pool || null,
      position_id: positionId || null,
      ...computed,
      ...narrative,
    });
  } catch (error) {
    return Response.json({ error: "LP analysis failed", message: (error as Error).message }, { status: 500 });
  }
}
