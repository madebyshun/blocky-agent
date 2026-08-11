// x402/ecosystem-digest
// Weekly Base ecosystem digest. Numbers are REAL — movers come from GeckoTerminal
// trending pools, TVL from DefiLlama. The LLM only writes prose (notes, narratives,
// community read) on top of real figures; it never invents a ticker or a %.
// Price: $0.20

import { getBaseTvl, getBaseTrending, poolsToPrompt, tvlToPrompt, type Pool } from "@/lib/market-data";
import { filterScamPools } from "./_scam-filter";
import { callLLM } from "@/app/api/_lib/llm";

type BankrMessage = { role: string; content: string };

// Bankr LLM (llm.bankr.bot) was 403-banned 2026-07-20 → route this local
// helper through callLLM (Virtuals). Signature kept so call sites are
// unchanged; the original 0.4 temperature default is preserved.
async function callBankrLLM(opts: {
  model?: string; system: string; messages: BankrMessage[];
  temperature?: number; maxTokens?: number;
}): Promise<string> {
  return (await callLLM({
    system: opts.system,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.4,
    maxTokens: opts.maxTokens ?? 1000,
  })).text;
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  let raw = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
  const s = raw.indexOf("{"), e = raw.lastIndexOf("}");
  if (s >= 0 && e > s) raw = raw.slice(s, e + 1);
  try { return JSON.parse(raw); } catch {}
  try { return JSON.parse(raw.replace(/[\x00-\x1F\x7F]/g, " ")); } catch {}
  return null;
}

const pct = (n: number | null) => (n == null ? "n/a" : `${n > 0 ? "+" : ""}${n.toFixed(1)}%`);

// Build the movers list straight from real pool data — never from the LLM.
function buildMovers(pools: Pool[]): { token: string; change: string; change24hRaw: number | null; url: string }[] {
  const named = pools.filter((p) => p.baseSymbol && p.change.h24 != null);
  const sorted = [...named].sort((a, b) => (b.change.h24 ?? 0) - (a.change.h24 ?? 0));
  const top = sorted.slice(0, 4);
  const bottom = sorted.slice(-2).filter((p) => !top.includes(p));
  return [...top, ...bottom].map((p) => ({
    token: p.baseSymbol,
    change: pct(p.change.h24),
    change24hRaw: p.change.h24,
    url: p.url,
  }));
}

export default async function handler(): Promise<Response> {
  try {
    const [tvl, trendingRaw] = await Promise.all([getBaseTvl(), getBaseTrending(12)]);
    const trending = filterScamPools(trendingRaw);

    if (!trending.length && !tvl) {
      return Response.json(
        { error: "Live market data sources are unavailable right now. Retry shortly." },
        { status: 503 }
      );
    }

    const movers = buildMovers(trending);
    const realContext = `${tvlToPrompt(tvl)}\n\nTop active Base pools (live, GeckoTerminal):\n${poolsToPrompt(trending)}`;

    // Single grounded synthesis pass. The LLM gets ONLY real tokens + real numbers
    // and is told to reference nothing else.
    const synthesisRaw = await callBankrLLM({
      system: `You are Blue Agent — intelligence for Base builders. You are given REAL, live Base market data.
Rules:
- Reference ONLY the tokens and numbers provided. Never invent a ticker, price, or percentage.
- "Base" is the chain; it has NO native token. Never list a "BASE" token.
- For each mover token I give you, write a one-line note explaining the move qualitatively.
Return ONLY raw JSON. No markdown.
Schema: {
  "headline": "<1 sentence digest headline grounded in the real data>",
  "mover_notes": {"<TOKEN_SYMBOL>": "<1 sentence note>"},
  "narratives": [{"name":"<narrative>","phase":"Emerging|Rising|Peak|Fading","key_point":"<1 sentence tied to the real tokens>"}],
  "community": {"temperature":"hot|warm|neutral|cool|cold","bull":<0-100>,"bear":<0-100>,"neutral":<0-100>},
  "what_moved": ["<key real event/trend>"],
  "what_matters": ["<actionable insight for a Base builder>"],
  "what_to_watch": ["<upcoming catalyst or risk>"],
  "builder_signal": "<1 sentence for builders>",
  "rating": <1-10>
}`,
      messages: [{ role: "user", content: `${realContext}\n\nMover tokens to annotate: ${movers.map((m) => `${m.token} (${m.change})`).join(", ") || "none"}` }],
      temperature: 0.35,
      maxTokens: 1100,
    });

    const synth = extractJsonObject(synthesisRaw) ?? {};
    const moverNotes = (synth.mover_notes as Record<string, string> | undefined) ?? {};

    const moversOut = movers.map((m) => ({
      token: m.token,
      change: m.change,
      note: moverNotes[m.token] ?? "",
      url: m.url,
    }));

    const community = (synth.community as Record<string, unknown> | undefined) ?? {
      temperature: "neutral", bull: 40, bear: 30, neutral: 30,
    };

    return Response.json({
      tool: "ecosystem-digest",
      timestamp: new Date().toISOString(),
      period: "daily",
      data_source: "DexScreener · GeckoTerminal · DefiLlama (live)",
      base_tvl: tvl
        ? { usd: tvl.tvlUsd, change_1d: pct(tvl.change1dPct), change_7d: pct(tvl.change7dPct) }
        : null,
      observer: {
        temperature: community.temperature ?? "neutral",
        bull: community.bull ?? 40,
        bear: community.bear ?? 30,
        neutral: community.neutral ?? 30,
        community_mood: synth.headline ?? "Base ecosystem activity",
        builder_activity: "live",
      },
      headline: synth.headline ?? "Base ecosystem daily digest",
      movers: moversOut,
      narratives: synth.narratives ?? [],
      community,
      what_moved: synth.what_moved ?? [],
      what_matters: synth.what_matters ?? [],
      what_to_watch: synth.what_to_watch ?? [],
      builder_signal: synth.builder_signal ?? "",
      rating: synth.rating ?? null,
    });
  } catch (error) {
    console.error("[EcosystemDigest]", error);
    return Response.json({ error: "Ecosystem digest failed", message: (error as Error).message }, { status: 500 });
  }
}
