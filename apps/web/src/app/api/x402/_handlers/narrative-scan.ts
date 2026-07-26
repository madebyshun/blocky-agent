/**
 * narrative-scan — LLM narrative detection + KV lifecycle tracking.
 *
 * Pipeline:
 *  1. Fetch real trending pools from GeckoTerminal (grounding data)
 *  2. Ask the LLM (no web search — grounded ONLY in the trending list) to
 *     identify 2-3 narratives running on Base
 *  3. Hard-filter: every returned narrative must have ≥1 token in the real list
 *  4. Load/update KV history → derive Emerging / Rising / Peak / Fading phases
 *  5. Return _noCard:true when 0 grounded narratives are detected
 *
 * KV key: feed:narratives
 *   Record<name, { first_seen, last_seen, scan_count, tokens }>
 */
import { callVeniceLLM, extractJsonObject } from "@/app/api/_lib/llm";
import { getBaseTrending }                   from "@/lib/market-data";
import { filterScamPools }                   from "./_scam-filter";
import { kvGet, kvSet }                      from "@/lib/kv";

const KV_KEY            = "feed:narratives";
const FADING_THRESHOLD  = 8  * 3_600_000; // 8 h
const PEAK_AGE          = 24 * 3_600_000; // 24 h

type NarrativeHistory = Record<string, {
  first_seen:  number;
  last_seen:   number;
  scan_count:  number;
  tokens:      string[];
}>;

function derivePhase(e: { first_seen: number; scan_count: number }): string {
  const age  = Date.now() - e.first_seen;
  const seen = e.scan_count;
  if (seen === 1)                       return "Emerging";
  if (seen <= 3 && age < PEAK_AGE)     return "Rising";
  return "Peak";
}

const SYSTEM = `You are a Base chain narrative tracker. Look at the real trending tokens on Base and identify 2-3 distinct investment narratives in play (e.g. "AI Agents", "RWA", "DePIN", "DeFi Yield", "Gaming", "Perps", "Memes", "Liquid Staking", etc).

Respond with ONLY raw JSON — no markdown, no explanation, no text before or after the JSON object:
{
  "narratives": [
    {
      "name": "Short label (2-3 words)",
      "tokens": ["SYM1", "SYM2"],
      "rationale": "One sentence explaining why these tokens = this narrative."
    }
  ]
}

Rules:
- ONLY include a narrative if ≥ 1 token from the real trending list supports it
- Maximum 3 narratives total
- If no clear narrative exists, return {"narratives": []}
- Never invent token symbols not in the list provided`;

export default async function handler(_req: Request): Promise<Response> {
  try {
    const raw   = await getBaseTrending(20);
    const pools = filterScamPools(raw);

    if (pools.length === 0) {
      return Response.json({
        tool:       "narrative-scan",
        narratives: [],
        _noCard:    true,
        reason:     "No trending data available from GeckoTerminal.",
        timestamp:  new Date().toISOString(),
      });
    }

    // Build real token set for grounding
    const realTokens = new Set(pools.map((p) => p.baseSymbol.toUpperCase()));
    const tokenList  = pools
      .map((p, i) => {
        const ch = p.change.h24;
        return `${i + 1}. ${p.baseSymbol} — 24h ${ch != null ? `${ch >= 0 ? "+" : ""}${ch.toFixed(1)}%` : "?"}, vol $${((p.volume24h ?? 0) / 1e6).toFixed(2)}M, liq $${((p.liquidityUsd ?? 0) / 1e6).toFixed(2)}M`;
      })
      .join("\n");

    const resp = await callVeniceLLM({
      system:      SYSTEM,
      user:        `Real trending tokens on Base right now:\n${tokenList}`,
      temperature: 0,
      maxTokens:   600,
      webSearch:   false, // token data already live; don't need extra web calls
    }).catch(() => null);

    const parsed = resp ? extractJsonObject(resp) : null;
    const rawNarratives: Array<{ name: string; tokens: string[]; rationale: string }> =
      Array.isArray(parsed?.narratives) ? parsed.narratives : [];

    // Hard filter: narrative must have ≥1 real token
    const grounded = rawNarratives.filter(
      (n) => Array.isArray(n.tokens) && n.tokens.some((t) => realTokens.has(t.toUpperCase()))
    );

    const now     = Date.now();
    const history = (await kvGet<NarrativeHistory>(KV_KEY)) ?? {};
    const seenNames = new Set(grounded.map((n) => n.name));

    // Update history for seen narratives
    for (const n of grounded) {
      const prev = history[n.name];
      history[n.name] = {
        first_seen:  prev?.first_seen ?? now,
        last_seen:   now,
        scan_count:  (prev?.scan_count ?? 0) + 1,
        tokens:      n.tokens,
      };
    }

    // Detect fading — not seen for ≥ 8h → emit once, then prune
    const fadingNarratives: Array<{ name: string; phase: string }> = [];
    for (const [name, entry] of Object.entries(history)) {
      if (!seenNames.has(name) && now - entry.last_seen >= FADING_THRESHOLD) {
        fadingNarratives.push({ name, phase: "Fading" });
        delete history[name];
      }
    }

    // Persist updated history (7-day TTL)
    await kvSet(KV_KEY, history, 7 * 24 * 3600);

    // Build output
    const narratives = grounded.map((n) => ({
      name:         n.name,
      phase:        derivePhase(history[n.name]),
      tokens:       n.tokens.filter((t) => realTokens.has(t.toUpperCase())),
      rationale:    n.rationale,
      scan_count:   history[n.name].scan_count,
      first_seen_ms:history[n.name].first_seen,
    }));

    const allNarratives = [...narratives, ...fadingNarratives];

    if (allNarratives.length === 0) {
      return Response.json({
        tool:       "narrative-scan",
        narratives: [],
        _noCard:    true,
        reason:     "No grounded narratives detected this scan.",
        scanned:    pools.length,
        timestamp:  new Date().toISOString(),
      });
    }

    return Response.json({
      tool:         "narrative-scan",
      narratives:   allNarratives,
      count:        narratives.length,
      fading:       fadingNarratives.length,
      top:          narratives[0]?.name ?? null,
      scanned_pools: pools.length,
      dataSource:   "GeckoTerminal + Venice LLM (narrative labelling)",
      timestamp:    new Date().toISOString(),
    });
  } catch (e) {
    return Response.json(
      { error: "narrative-scan failed", message: (e as Error).message },
      { status: 500 }
    );
  }
}
