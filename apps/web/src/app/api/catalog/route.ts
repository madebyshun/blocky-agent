/**
 * /api/catalog — machine-readable tool catalog for agents & x402 directories.
 *
 * Lists every Blue Hub tool with its x402 endpoint, price, network, asset and
 * input fields. Any x402-capable agent can discover a tool here, then call its
 * endpoint and pay per call in USDC — no API key, no signup.
 *
 * Public + CORS-open so browser agents and directories (Agentic Market, etc.)
 * can index it.
 */
import { NextResponse } from "next/server";
import { AGENT_TOOLS } from "@/lib/agent-tools";

export const runtime = "nodejs";
// Vercel kills serverless functions at 60s by default — explicit budget so
// it fails loudly instead of silently 504-ing.
export const maxDuration = 15;

const BASE = "https://blueagent.dev";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = "0x02950ad38ada1d599375bd447e080cd404809205";

function priceUnits(price?: string): number | null {
  if (!price) return null;
  const n = parseFloat(price.replace("$", "").trim());
  return Number.isNaN(n) ? null : Math.round(n * 1_000_000);
}

export async function GET() {
  const tools = AGENT_TOOLS
    .filter(t => t.x402Url)
    .map(t => ({
      id: t.id,
      name: t.name,
      description: t.description,
      category: t.category,
      agents: t.isComposite ? ["blue", "aeon", "miroshark"]
        : t.agentName === "Aeon" ? ["aeon"]
        : t.agentName === "MiroShark" ? ["miroshark"]
        : ["blue"],
      price: t.price ?? null,
      priceUsdcUnits: priceUnits(t.price),
      endpoint: `${BASE}/api/x402/${t.id}`,
      method: "POST",
      input: {
        type: "object",
        properties: Object.fromEntries(
          t.inputs.map(i => [i.key, { type: "string", description: i.label }])
        ),
        required: t.inputs.filter(i => i.required).map(i => i.key),
      },
    }));

  return NextResponse.json(
    {
      name: "Blue Hub",
      description:
        "AI agent tools for Base builders — analysis, audits, signals via 3-agent consensus (Blue · Aeon · MiroShark). Pay per call in USDC over x402. No API key, no signup.",
      url: `${BASE}/hub`,
      protocol: "x402",
      x402Version: 2,
      network: "eip155:8453",
      asset: USDC,
      payTo: PAY_TO,
      count: tools.length,
      tools,
    },
    {
      headers: {
        "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
      },
    }
  );
}

export function OPTIONS() {
  return new NextResponse(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}
