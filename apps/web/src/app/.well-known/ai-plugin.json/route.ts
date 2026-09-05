/**
 * OpenAI Plugin Manifest — /.well-known/ai-plugin.json
 *
 * Standard format consumed by:
 *   - OpenAI / ChatGPT plugin loader
 *   - agentic.market
 *   - Claude, Cursor, and other AI agents that discover tools via this spec
 *   - Any agent following the OpenAI plugin discovery standard
 *
 * Points to /.well-known/openapi.json for the full per-tool API spec.
 */
import { NextResponse } from "next/server";
import { AGENT_TOOLS } from "@/lib/agent-tools";
import { HANDLERS } from "@/app/api/x402/_handlers";

export const runtime = "nodejs";
export const revalidate = 3600;

const BASE_URL = "https://blueagent.dev";

export async function GET() {
  const liveCount = AGENT_TOOLS.filter(t => HANDLERS[t.id] && t.price).length;

  const manifest = {
    schema_version: "v1",
    name_for_human: "Blue Hub",
    name_for_model: "blue_hub",
    description_for_human: `${liveCount} pay-per-use AI tools for Base builders — idea briefs, market fit, token signals, smart contract audit, pitch decks, and more. No API keys. Pay per call in USDC on Base via x402.`,
    description_for_model: `Blue Hub is a collection of ${liveCount} AI tools for Base blockchain builders and investors. Each tool is a paid API endpoint using the x402 micropayment protocol (USDC on Base mainnet, eip155:8453). To call any tool: (1) GET /api/x402/{tool} to receive payment requirements, (2) sign an EIP-3009 USDC TransferWithAuthorization, (3) POST with X-Payment header. Key tools: blue-idea ($0.05) for startup idea briefs, blue-build ($0.50) for architecture plans, blue-audit ($1.00) for smart contract security review, blue-raise ($0.20) for pitch narratives, token-pick-signal ($0.20) for asymmetric token setups on Base, market-fit ($0.25) for PMF scoring, ecosystem-digest ($0.20) for Base ecosystem intelligence. See the OpenAPI spec for all ${liveCount} tools with full input schemas.`,
    auth: {
      type: "none",
    },
    api: {
      type: "openapi",
      url: `${BASE_URL}/.well-known/openapi.json`,
      is_user_authenticated: false,
    },
    logo_url: `${BASE_URL}/icon.png`,
    contact_email: "contact@blueagent.dev",
    legal_info_url: BASE_URL,
    // x402 extension — non-standard but picked up by x402-aware agents
    "x-x402": {
      payTo:    "0x02950ad38ada1d599375bd447e080cd404809205",
      network:  "eip155:8453",
      asset:    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      catalog:  "https://agentic.market/services/blueagent-dev",
      tools:    liveCount,
    },
  };

  return NextResponse.json(manifest, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, s-maxage=3600",
      "Content-Type": "application/json",
    },
  });
}
