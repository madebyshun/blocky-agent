// x402/quick-safety — fast contract safety check (DexScreener liquidity +
// Basescan verification + LLM read). Price: $0.05
import { callLLM, extractJsonObject } from "@/app/api/_lib/llm";
import { getBasescanSource } from "@/lib/moralis";

const DS = "https://api.dexscreener.com/latest/dex";

export default async function handler(req: Request): Promise<Response> {
  try {
    let body: { contract?: string } = {};
    try { const t = await req.text(); if (t?.trim().startsWith("{")) body = JSON.parse(t); } catch {}
    const url = new URL(req.url);
    const contract = (body.contract ?? url.searchParams.get("contract") ?? url.searchParams.get("address") ?? "").trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(contract)) return Response.json({ error: "Provide a contract address (0x…)" }, { status: 400 });

    type Pair = { chainId?: string; baseToken?: { symbol?: string }; liquidity?: { usd?: number } };
    const [dsRes, src] = await Promise.all([
      fetch(`${DS}/tokens/${contract}`, { signal: AbortSignal.timeout(8000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      getBasescanSource(contract),
    ]);
    const pairs = (((dsRes as { pairs?: Pair[] } | null)?.pairs ?? []).filter((p) => p.chainId === "base")).sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    const top = pairs[0];
    const liquidity = top?.liquidity?.usd ?? null;
    const symbol = top?.baseToken?.symbol ?? null;
    const verified = !!(src && src.SourceCode && String(src.SourceCode).length > 0);

    const data = { contract, symbol, liquidity_usd: liquidity, source_verified: verified, base_pairs: pairs.length };
    const system = `You are a Base chain analyst. Use ONLY the data provided. NEVER invent numbers, addresses, or token names not in the data. Return ONLY raw JSON starting with {. No markdown. If data unavailable, return field as null — never estimate.
Assess a token contract's safety from the real DexScreener liquidity + Basescan source verification. Risk rises with: unverified source, liquidity < $10k, zero Base pairs. Only state buy/sell tax if evident in the data, else null.
Schema: {"safe":boolean,"buy_tax_pct":number|null,"sell_tax_pct":number|null,"risk_score":<0-100>,"verdict":"SAFE|CAUTION|DANGER","flags":string[],"confidence":<0-100>}`;

    let r: Record<string, unknown> = {};
    try { r = extractJsonObject((await callLLM({ system, user: JSON.stringify(data, null, 2), temperature: 0.2, maxTokens: 500 })).text) ?? {}; }
    catch { /* degrade below */ }

    const rs = typeof r.risk_score === "number" ? r.risk_score : null;
    const verdict = rs == null ? (typeof r.verdict === "string" ? r.verdict : "CAUTION") : rs >= 66 ? "DANGER" : rs >= 33 ? "CAUTION" : "SAFE";
    return Response.json({
      tool: "quick-safety",
      contract,
      symbol,
      safe: typeof r.safe === "boolean" ? r.safe : rs != null ? rs < 33 : null,
      buy_tax_pct: typeof r.buy_tax_pct === "number" ? r.buy_tax_pct : null,
      sell_tax_pct: typeof r.sell_tax_pct === "number" ? r.sell_tax_pct : null,
      risk_score: rs,
      verdict,
      flags: Array.isArray(r.flags) ? r.flags : [],
      liquidity_usd: liquidity,
      verified,
      confidence: typeof r.confidence === "number" ? r.confidence : rs,
      data_source: "DexScreener + Basescan (live)",
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    return Response.json({ error: "quick-safety failed", message: (e as Error).message }, { status: 500 });
  }
}
