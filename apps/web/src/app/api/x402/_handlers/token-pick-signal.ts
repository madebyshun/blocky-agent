// x402/token-pick-signal
// One actionable token pick chosen from REAL Base pools (GeckoTerminal trending +
// new). Candidates are hard-filtered for on-chain QUALITY (liquidity, volume,
// anti-pump, thin-liq-vs-mcap), then SCORED in code (liquidity health, turnover,
// momentum, divergence). The code selects the highest-quality pick and hard-maps
// verdict + confidence from the score — the LLM only writes the thesis. It can
// never invent a ticker, a number, or a cap label.
//
// Cap is a RESULT, not an input: the tool scans every size and returns the best
// by quality. A cap tier is applied ONLY when the user explicitly asks for one
// (e.g. "low-cap"); otherwise size is ignored.
// Price: $0.20

import { getBaseTrending, getBaseNewPools, type Pool } from "@/lib/market-data";
import { callLLM } from "@/app/api/_lib/llm";

type BankrMessage = { role: string; content: string };

// Delegates to the shared Virtuals → Venice → Bankr chain. Bankr was
// banned 2026-07-18; the direct-Bankr fetch this used to do is dead
// on prod. `callLLM` retries providers in order and returns text +
// provenance. Name/signature preserved so all call sites stay identical.
async function callBankrLLM(opts: {
  model?: string; system: string; messages: BankrMessage[];
  temperature?: number; maxTokens?: number;
}): Promise<string> {
  const r = await callLLM({
    system: opts.system,
    messages: opts.messages,
    temperature: opts.temperature,
    maxTokens: opts.maxTokens,
    model: opts.model,
  });
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

// ── Quality thresholds (FIX 1) ───────────────────────────────────────────────
const MIN_LIQ = 50_000; // filter out thin liquidity
const MIN_VOL = 20_000; // filter out dead tokens

// Denominator / blue-chip assets are NOT "picks" — they appear as the base
// symbol of quote pairs (e.g. WETH/USDC) and would always top a liquidity-
// weighted score. Exclude them so the tool surfaces real opportunity tokens.
const QUOTE_DENYLIST = new Set([
  "WETH", "ETH", "WBTC", "CBBTC", "CBETH", "WSTETH", "WEETH", "RETH", "EZETH",
  "USDC", "USDT", "DAI", "USDBC", "EURC", "GHO", "FRAX", "LUSD", "USDE", "SUSDE",
  "MIM", "CRVUSD", "USD+", "DOLA",
]);

// ── Cap tiers (FIX 5/6) — only applied when the user explicitly asks ──────────
const CAP_TIERS = { micro: 10_000_000, low: 50_000_000, small: 100_000_000 } as const;
type CapTier = keyof typeof CAP_TIERS;

function parseCapTier(ctx: string): { tier: CapTier; max: number } | null {
  const c = ctx.toLowerCase();
  if (/micro[\s-]?cap/.test(c)) return { tier: "micro", max: CAP_TIERS.micro };
  if (/low[\s-]?cap/.test(c))   return { tier: "low",   max: CAP_TIERS.low };
  if (/small[\s-]?cap/.test(c)) return { tier: "small", max: CAP_TIERS.small };
  return null;
}

function capLabel(mcap: number | null): string {
  if (mcap == null) return "unknown";
  if (mcap < CAP_TIERS.micro) return "micro";
  if (mcap < CAP_TIERS.low)   return "low";
  if (mcap < CAP_TIERS.small) return "small";
  if (mcap < 1_000_000_000)   return "mid";
  return "large";
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const fmtUsd = (n: number | null) =>
  n == null ? "?" : n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(2)}`;
const fmtPct = (n: number | null) => (n == null ? "?" : `${n > 0 ? "+" : ""}${n.toFixed(1)}%`);

// ── FIX 1 — hard quality filter (always applied) ─────────────────────────────
function passesQuality(p: Pool): boolean {
  const liq = p.liquidityUsd, vol = p.volume24h, mcap = p.marketCap;
  const h1 = p.change.h1, h24 = p.change.h24;
  if (liq == null || liq < MIN_LIQ) return false;            // thin liquidity
  if (vol == null || vol < MIN_VOL) return false;            // dead token
  // anti-pump: a sharp 1h spike that is ~the entire 24h move. The 5% floor
  // keeps genuinely flat tokens (divergence alpha) from being nuked.
  if (h1 != null && h24 != null && Math.abs(h1) >= 5 && Math.abs(h1) >= Math.abs(h24) * 0.95) return false;
  // thin liquidity vs mcap → exit risk
  if (mcap != null && mcap > 0 && liq < mcap * 0.02) return false;
  return true;
}

// ── FIX 2 — on-chain sub-scores (0..1), combined into a 0-100 quality score ───
function subScores(p: Pool) {
  const liq = p.liquidityUsd ?? 0;
  const vol = p.volume24h ?? 0;
  const mcap = p.marketCap;
  const h1 = p.change.h1 ?? 0, h6 = p.change.h6 ?? 0, h24 = p.change.h24 ?? 0;
  const turnover = liq > 0 ? vol / liq : 0;

  const liqHealth  = clamp01(Math.log10(Math.max(liq, 1) / MIN_LIQ) / Math.log10(200)); // $50K→0 .. $10M→1
  const volMom     = clamp01(turnover / 4);                                              // turnover 0..4x
  const liqMcap    = mcap && mcap > 0 ? clamp01((liq / mcap - 0.02) / 0.13) : 0.5;        // 2%..15% of mcap
  const accel      = h1 - h6 / 6;                                                         // 1h pace vs 6h pace
  const momentum   = clamp01(0.5 + h6 * 0.02 + accel * 0.03);                             // steady climb + acceleration
  const flat       = Math.abs(h24) <= 15 ? 1 : clamp01(1 - (Math.abs(h24) - 15) / 35);
  const divergence = clamp01((turnover - 0.5) / 2) * flat;                                // high turnover + flat price = accumulation

  return { turnover, liqHealth, volMom, liqMcap, momentum, divergence };
}

const FIXED_W = { liq: 0.25, vol: 0.25, lm: 0.20, mom: 0.15, div: 0.15 };

function qualityScore(s: ReturnType<typeof subScores>): number {
  return Math.round(100 * (
    FIXED_W.liq * s.liqHealth + FIXED_W.vol * s.volMom + FIXED_W.lm * s.liqMcap +
    FIXED_W.mom * s.momentum + FIXED_W.div * s.divergence
  ));
}

// Context-weighted rank (selection only; quality stays absolute for confidence).
function rankScore(s: ReturnType<typeof subScores>, ctx: string): number {
  const c = ctx.toLowerCase();
  const w = { ...FIXED_W };
  if (/volume|liquid|turnover|active/.test(c))                       w.vol += 0.15;
  if (/momentum|rising|breakout|trend|runner|pump|moving|climb/.test(c)) w.mom += 0.15;
  if (/divergence|accumulat|alpha|quiet|stealth|undervalued|radar/.test(c)) w.div += 0.15;
  const sum = w.liq + w.vol + w.lm + w.mom + w.div;
  return (w.liq * s.liqHealth + w.vol * s.volMom + w.lm * s.liqMcap + w.mom * s.momentum + w.div * s.divergence) / sum;
}

// ── FIX 3 — signal type assigned from data ────────────────────────────────────
function signalType(p: Pool, turnover: number): "building" | "spike" | "divergence" {
  const h1 = p.change.h1 ?? 0, h24 = p.change.h24 ?? 0;
  if (Math.abs(h1) >= 8) return "spike";                              // sharp 1h move — risky
  if (turnover >= 0.8 && Math.abs(h24) <= 12) return "divergence";    // vol high, price flat — alpha
  return "building";                                                  // steady vol+liq, price not bursting
}

// ── FIX 4 — automatic caution flags (transparency) ───────────────────────────
function cautionFlags(p: Pool): string[] {
  const out: string[] = [];
  const liq = p.liquidityUsd ?? 0, mcap = p.marketCap;
  const h1 = p.change.h1, h24 = p.change.h24;
  if (liq < 100_000) out.push("low_liquidity");
  if (h1 != null && h24 != null && Math.abs(h1) >= 3 && Math.abs(h1) >= Math.abs(h24) * 0.7) out.push("pump_pattern");
  if (mcap != null && mcap > 0 && liq / mcap < 0.03) out.push("thin_liq_to_mcap");
  if (h24 != null && Math.abs(h24) > 50) out.push("high_volatility");
  return out;
}

type Scored = {
  p: Pool;
  quality: number;
  rank: number;
  signal_type: "building" | "spike" | "divergence";
  caution: string[];
};

function scoredLine(s: Scored, i: number): string {
  const p = s.p;
  return `${i + 1}. ${p.baseSymbol} — score ${s.quality}/100, signal ${s.signal_type}, price ${p.priceUsd != null ? "$" + p.priceUsd : "?"}, 24h ${fmtPct(p.change.h24)}, 6h ${fmtPct(p.change.h6)}, 1h ${fmtPct(p.change.h1)}, vol24h ${fmtUsd(p.volume24h)}, liq ${fmtUsd(p.liquidityUsd)}, mcap ${fmtUsd(p.marketCap)} (${capLabel(p.marketCap)})${s.caution.length ? `, caution: ${s.caution.join("/")}` : ""}`;
}

export default async function handler(req: Request): Promise<Response> {
  try {
    let body: { min_mcap?: number; context?: string } = {};
    try { const t = await req.text(); if (t?.trim().startsWith("{")) body = JSON.parse(t); } catch {}
    const url = new URL(req.url);
    const minMcap = body.min_mcap ?? Number(url.searchParams.get("min_mcap") ?? "0");
    const context = (body.context ?? url.searchParams.get("context") ?? "").trim();
    const capTier = parseCapTier(context); // FIX 5 — only when explicitly asked

    const meta = {
      tool: "token-pick-signal",
      timestamp: new Date().toISOString(),
      chain: "base",
      data_source: "GeckoTerminal (live Base pools)",
    };

    const [trending, fresh] = await Promise.all([getBaseTrending(15), getBaseNewPools(10)]);
    // Dedupe by base symbol (trending + new can overlap)
    const seen = new Set<string>();
    const universe: Pool[] = [...trending, ...fresh].filter((p) => {
      if (!p.baseSymbol) return false;
      const k = p.baseSymbol.toUpperCase();
      if (QUOTE_DENYLIST.has(k)) return false; // skip denominator / blue-chip assets
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    if (!universe.length) {
      return Response.json(
        { ...meta, error: "Live Base pool data is unavailable right now. Retry shortly." },
        { status: 503 }
      );
    }

    const candidatesBefore = universe.length;

    // FIX 1 — hard quality filter (always). FIX 5 — cap filter (only if asked).
    // min_mcap kept as an optional numeric floor for API back-compat.
    let pool = universe.filter(passesQuality);
    if (capTier) pool = pool.filter((p) => p.marketCap != null && p.marketCap < capTier.max);
    if (minMcap) pool = pool.filter((p) => (p.marketCap ?? 0) >= minMcap);

    const filters_applied = {
      min_liquidity: MIN_LIQ,
      min_volume: MIN_VOL,
      cap_tier: capTier ? { tier: capTier.tier, max_mcap: capTier.max } : null,
      min_mcap: minMcap || null,
      candidates_before: candidatesBefore,
      candidates_after: pool.length,
    };

    // EDGE CASE — nothing qualifies → no_pick. NEVER fall back to a bigger token.
    if (!pool.length) {
      const why = capTier
        ? `No ${capTier.tier}-cap (marketCap < ${fmtUsd(capTier.max)}) Base token currently passes the liquidity / volume / anti-pump quality filters. Not forcing a larger pick.`
        : `No Base token currently passes the on-chain quality filters (liquidity ≥ ${fmtUsd(MIN_LIQ)}, volume ≥ ${fmtUsd(MIN_VOL)}, no pump pattern). Not forcing a pick.`;
      return Response.json({
        ...meta,
        no_pick: true,
        pick: null,
        near_misses: [],
        blue_verdict: "NO_PICK",
        confidence: 0,
        note: why,
        filters_applied,
        candidates_scanned: candidatesBefore,
      });
    }

    // FIX 2/3/4 — score + classify every survivor
    const scored: Scored[] = pool.map((p) => {
      const s = subScores(p);
      return { p, quality: qualityScore(s), rank: rankScore(s, context), signal_type: signalType(p, s.turnover), caution: cautionFlags(p) };
    });
    scored.sort((a, b) => b.rank - a.rank); // context-relevant order; quality stays absolute

    const top = scored[0];
    const others = scored.slice(1, 5);
    const validSymbols = scored.map((s) => s.p.baseSymbol);

    // FIX 6 — LLM writes the thesis ONLY for the code-selected pick. All numbers,
    // the signal type, caution and verdict are code-controlled (no fabrication).
    const capRule = capTier
      ? `The user asked for ${capTier.tier}-cap (marketCap < ${fmtUsd(capTier.max)}); only qualifying tokens are listed.`
      : `The user did NOT ask for a cap tier — pick by quality, ignore size.`;

    const system = `You are Blue Agent — token pick signal for Base. You receive REAL Base tokens that are ALREADY quality-filtered and scored on-chain (liquidity, turnover, momentum, divergence). The single best pick by score is "${top.p.baseSymbol}".
Cap tiers (by marketCap): micro <$10M, low <$50M, small <$100M, mid $50M-$1B, large >$1B.
Rules:
- Write the thesis for the SELECTED pick "${top.p.baseSymbol}" — chosen as the highest-quality opportunity by score (momentum, divergence, liquidity health), NOT by cap size. ${capRule}
- NEVER label a token low-cap/micro-cap/small-cap if its real marketCap exceeds the threshold. Respect the numbers — no "low-cap-adjacent" softening.
- The picks are pre-filtered and pre-scored on-chain. Use the given score / signal_type / caution. Confidence is derived from the score in code — do NOT invent a number.
- Anchor entry to the real current price. Quote real %-moves only. "Base" is the chain, not a token.
Return ONLY raw JSON. No markdown.
Schema: {"thesis":"<1-2 sentences, why this is the highest-quality setup>","entry":"<level vs current price>","kill_criterion":"<1 sentence>","horizon":"<hours/days/weeks>","note":"<1 sentence market context>"}`;

    const userContent = `SELECTED PICK: ${top.p.baseSymbol} (score ${top.quality}/100, signal ${top.signal_type}${top.caution.length ? `, caution ${top.caution.join("/")}` : ""})

Scored candidates (best first):
${scored.slice(0, 8).map(scoredLine).join("\n")}${context ? `\n\nUser focus: ${context}` : ""}`;

    let narrative: Record<string, unknown> = {};
    try {
      const out = await callBankrLLM({
        system,
        messages: [{ role: "user", content: userContent }],
        temperature: 0.3,
        maxTokens: 600,
      });
      narrative = extractJsonObject(out) ?? {};
    } catch (e) {
      console.error("[TokenPickSignal] LLM thesis failed", (e as Error).message);
    }

    const str = (v: unknown, fallback: string) =>
      typeof v === "string" && v.trim() ? v.trim() : fallback;

    // Hard-map verdict + confidence from the code score (deterministic).
    const blue_verdict = top.quality >= 70 ? "BUY" : top.quality >= 50 ? "WATCH" : "SKIP";
    void validSymbols; // pick is code-selected from the real list; symbols listed for audit

    const pick = {
      token: top.p.baseSymbol,
      price: top.p.priceUsd != null ? `$${top.p.priceUsd}` : "unknown",
      change_24h: fmtPct(top.p.change.h24),
      change_1h: fmtPct(top.p.change.h1),
      market_cap: fmtUsd(top.p.marketCap),
      cap_tier: capLabel(top.p.marketCap),
      liquidity: fmtUsd(top.p.liquidityUsd),
      volume_24h: fmtUsd(top.p.volume24h),
      score: top.quality,
      signal_type: top.signal_type,
      caution: top.caution,
      thesis: str(narrative.thesis, `Highest on-chain quality score (${top.quality}/100): healthy liquidity, real turnover, ${top.signal_type} signal.`),
      entry: str(narrative.entry, `Near current price ${top.p.priceUsd != null ? "$" + top.p.priceUsd : ""}`.trim()),
      kill_criterion: str(narrative.kill_criterion, "Liquidity drains or 24h trend breaks down."),
      horizon: str(narrative.horizon, "days"),
      url: top.p.url || null,
    };

    const near_misses = others.map((s) => ({
      token: s.p.baseSymbol,
      score: s.quality,
      signal_type: s.signal_type,
      cap_tier: capLabel(s.p.marketCap),
      caution: s.caution,
    }));

    return Response.json({
      ...meta,
      no_pick: false,
      pick,
      near_misses,
      blue_verdict,
      confidence: top.quality, // FIX 2 — confidence == code score, not LLM
      note: str(narrative.note, capTier
        ? `Best ${capTier.tier}-cap Base token by on-chain quality score.`
        : "Best Base token by on-chain quality score — size is a result, not a filter."),
      filters_applied,        // FIX 7
      candidates_scanned: candidatesBefore,
    });
  } catch (error) {
    console.error("[TokenPickSignal]", error);
    return Response.json({ error: "Token pick signal failed", message: (error as Error).message }, { status: 500 });
  }
}
