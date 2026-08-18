/**
 * Machine-readable x402 pricing manifest
 * GET /.well-known/pricing
 *
 * Compatible with Tavily x402 pricing spec.
 * Agents use this to discover all tool prices without parsing the full catalog.
 */
import { NextResponse } from "next/server";
import { AGENT_TOOLS } from "@/lib/agent-tools";
import { HANDLERS } from "@/app/api/x402/_handlers";

const USDC_BASE  = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO     = "0x02950ad38ada1d599375bd447e080cd404809205";
const NETWORK    = "eip155:8453";
const BASE_URL   = "https://blueagent.dev";

export async function GET() {
  const routes = AGENT_TOOLS
    .filter(t => t.priceUSDC && HANDLERS[t.id])
    .map(t => ({
      path:             `/api/x402/${t.id}`,
      endpoint:         `${BASE_URL}/api/x402/${t.id}`,
      manifest:         `${BASE_URL}/.well-known/ai-tool/${t.id}.json`,
      name:             t.name,
      description:      t.description,
      category:         t.category,
      scheme:           "exact",
      network:          NETWORK,
      asset:            USDC_BASE,
      payTo:            PAY_TO,
      maxAmountRequired: String(t.priceUSDC),   // raw USDC units (6 decimals)
      priceUSD:         t.price ?? null,         // human-readable e.g. "$0.25"
    }));

  const manifest = {
    version:     2,
    description: "Blue Hub — 40 AI tools on Base, pay-per-call via x402 + USDC",
    network:     NETWORK,
    asset:       USDC_BASE,
    payTo:       PAY_TO,
    catalog:     `${BASE_URL}/api/catalog`,
    updated:     new Date().toISOString(),
    routes,
  };

  return NextResponse.json(manifest, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control":               "public, s-maxage=300",
      "Content-Type":                "application/json",
    },
  });
}
