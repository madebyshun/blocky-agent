// x402/protocol-health — TVL trend, anomaly & health verdict for a Base protocol
// Price: $0.25 — Real TVL/change/category from DefiLlama; LLM synthesis only.

import { callLLM } from "@/app/api/_lib/llm";
import { findBaseProtocol, protocolToPrompt } from "@/lib/market-data";

function extractJsonObject(text: string): Record<string, unknown> | null {
  let raw = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
  const s = raw.indexOf("{"), e = raw.lastIndexOf("}");
  if (s >= 0 && e > s) raw = raw.slice(s, e + 1);
  try { return JSON.parse(raw); } catch {}
  try { return JSON.parse(raw.replace(/[\x00-\x1F\x7F]/g, " ")); } catch {}
  return null;
}

const SYSTEM = `You are a Base chain analyst. Use ONLY the data provided. NEVER invent numbers, addresses, or token names not in the data. Return ONLY raw JSON starting with {. No markdown. If data unavailable, return field as null — never estimate.

Assess the health of the Base protocol from its real TVL, TVL change, and category. Do NOT invent fees or revenue — those are passed as null when unavailable; keep them null.

Return JSON with this exact shape:
{
  "health_score": number,
  "anomaly_detected": boolean,
  "risk_signals": ["string"],
  "verdict": "HEALTHY|WATCH|RISK",
  "recommendation": "string"
}`;

export default async function handler(req: Request): Promise<Response> {
  try {
    let body: { protocol?: string } = {};
    try {
      const text = await req.text();
      if (text?.trim().startsWith("{")) body = JSON.parse(text);
    } catch {}
    const url = new URL(req.url);
    if (!body.protocol) body.protocol = url.searchParams.get("protocol") || url.searchParams.get("name") || undefined;

    const { protocol } = body;
    if (!protocol) return Response.json({ error: "Provide a protocol name" }, { status: 400 });

    console.log(`[ProtocolHealth] Analyzing: ${protocol}`);

    const p = await findBaseProtocol(protocol).catch(() => null);

    // fees/revenue not exposed by the protocols list endpoint.
    const fees_24h: number | null = null;
    const revenue_24h: number | null = null;

    if (!p) {
      return Response.json({
        tool: "protocol-health",
        protocol,
        category: null,
        tvl_usd: null,
        tvl_change_1d: null,
        tvl_change_7d: null,
        fees_24h,
        revenue_24h,
        health_score: null,
        trend: null,
        anomaly_detected: false,
        risk_signals: ["Protocol not found on DefiLlama for Base"],
        verdict: "RISK",
        recommendation: `No DefiLlama Base record found for "${protocol}". Verify the name/slug — cannot assess health without real TVL data.`,
        dataSource: "DefiLlama (no match)",
        timestamp: new Date().toISOString(),
      });
    }

    // trend from the sign of tvl_change_7d (computed in code).
    const c7 = p.change7dPct;
    const trend: "growing" | "stable" | "declining" =
      c7 == null ? "stable" : c7 > 2 ? "growing" : c7 < -2 ? "declining" : "stable";

    const content = `Live DefiLlama data for the Base protocol — use ONLY these numbers.\n\n${protocolToPrompt(p, p.name)}\nTVL (USD): ${p.tvlUsd ?? "unknown"}\n1d change: ${p.change1dPct ?? "?"}%\n7d change: ${c7 ?? "?"}%\nCategory: ${p.category ?? "unknown"}\nFees 24h: unavailable\nRevenue 24h: unavailable\n\nAssess health (score 0-100), flag anomalies, and give a verdict.`;

    const llmResponse = (await callLLM({
      system: SYSTEM,
      messages: [{ role: "user", content }],
      temperature: 0.3,
      maxTokens: 800,
    })).text;

    const result = extractJsonObject(llmResponse) ?? { degraded: true, note: "Synthesis briefly unavailable - please retry." };

    return Response.json({
      tool: "protocol-health",
      protocol: p.name,
      category: p.category,
      tvl_usd: p.tvlUsd,
      tvl_change_1d: p.change1dPct,
      tvl_change_7d: c7,
      fees_24h,
      revenue_24h,
      trend,
      ...result,
      dataSource: "DefiLlama (live)",
      disclaimer: "Health assessment is model-generated from live TVL data — not financial advice.",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[ProtocolHealth] Error:", error);
    return Response.json({ error: "Protocol health analysis failed", message: (error as Error).message }, { status: 500 });
  }
}
