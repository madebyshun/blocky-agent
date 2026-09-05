/**
 * Dynamic OpenAPI 3.1 spec for all Blue Hub x402 tools.
 *
 * GET /.well-known/openapi.json
 *
 * Consumed by:
 *   - OpenAI / GPT plugin loader (via ai-plugin.json → api.url)
 *   - agentic.market & other AI agent directories
 *   - Any agent that reads OpenAPI specs to discover callable tools
 *
 * Each live tool gets its own POST endpoint with:
 *   - Input schema from AGENT_TOOLS[].inputs
 *   - x-x402 extension: price, network, payTo, asset
 *   - 200 response schema + 402 payment-required schema
 */
import { NextResponse } from "next/server";
import { AGENT_TOOLS } from "@/lib/agent-tools";
import { HANDLERS } from "@/app/api/x402/_handlers";

export const runtime = "nodejs";
export const revalidate = 3600; // cache 1 hour

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO    = "0x02950ad38ada1d599375bd447e080cd404809205";
const BASE_URL  = "https://blueagent.dev";

export async function GET() {
  // Only include tools that have a live handler + price
  const liveTools = AGENT_TOOLS.filter(t => HANDLERS[t.id] && t.price && t.priceUSDC);

  // Build OpenAPI paths — one per tool
  const paths: Record<string, unknown> = {};

  for (const tool of liveTools) {
    const inputProps: Record<string, unknown> = {};
    const required: string[] = [];

    for (const input of tool.inputs) {
      inputProps[input.key] = {
        type: "string",
        description: input.label,
        ...(input.placeholder ? { example: input.placeholder } : {}),
      };
      if (input.required) required.push(input.key);
    }

    const priceUSDC = (tool.priceUSDC! / 1_000_000).toFixed(2);

    paths[`/api/x402/${tool.id}`] = {
      post: {
        operationId: tool.id.replace(/-/g, "_"),
        summary: tool.name,
        description: `${tool.description}\n\n**Price:** $${priceUSDC} USDC | **Network:** Base mainnet (eip155:8453)\n\nPayment via x402 — include \`X-Payment\` header (EIP-3009 USDC transfer). Returns 402 with payment requirements if no valid payment is provided.`,
        tags: [tool.category ?? "tools"],
        requestBody: {
          required: required.length > 0,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: inputProps,
                ...(required.length > 0 ? { required } : {}),
                additionalProperties: false,
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Tool result (payment verified and settled)",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    result:   { type: "string", description: "AI-generated output" },
                    command:  { type: "string", description: "Tool name" },
                    _settle: {
                      type: "object",
                      description: "x402 settlement receipt",
                      properties: {
                        ok:     { type: "boolean" },
                        status: { type: "integer" },
                        tx:     { type: "string", description: "On-chain tx hash (Base)" },
                      },
                    },
                  },
                },
              },
            },
          },
          "402": {
            description: "Payment required — see x402 payment requirements in response body",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    x402Version: { type: "integer", example: 2 },
                    error:       { type: "string",  example: "Payment Required" },
                    accepts: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          scheme:  { type: "string", example: "exact" },
                          network: { type: "string", example: "eip155:8453" },
                          asset:   { type: "string", example: USDC_BASE },
                          amount:  { type: "string", example: String(tool.priceUSDC) },
                          payTo:   { type: "string", example: PAY_TO },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        // x402 payment extension — picked up by x402-aware agents
        "x-x402": {
          scheme:  "exact",
          network: "eip155:8453",
          asset:   USDC_BASE,
          amount:  String(tool.priceUSDC),
          payTo:   PAY_TO,
          maxTimeoutSeconds: 120,
        },
      },
    };
  }

  const spec = {
    openapi: "3.1.0",
    info: {
      title:       "Blue Hub",
      description: `${liveTools.length} pay-per-use AI tools for Base builders and investors. Each tool requires a micro-payment in USDC on Base mainnet via the x402 protocol. No API keys — pay per call.\n\n**Payment:** x402 v2 (EIP-3009 USDC on Base, eip155:8453)\n**payTo:** \`${PAY_TO}\`\n**Asset:** USDC \`${USDC_BASE}\``,
      version:     "1.0.0",
      contact: {
        name: "Blue Hub",
        url:  BASE_URL,
      },
      "x-logo": {
        url: `${BASE_URL}/icon.png`,
      },
    },
    externalDocs: {
      description: "Blue Hub on agentic.market",
      url: "https://agentic.market/services/blueagent-dev",
    },
    servers: [{ url: BASE_URL, description: "Blue Hub (Base mainnet)" }],
    paths,
    components: {
      schemas: {
        X402PaymentRequired: {
          type: "object",
          description: "x402 v2 Payment Required response",
          properties: {
            x402Version: { type: "integer", example: 2 },
            error:       { type: "string",  example: "Payment Required" },
            accepts: {
              type: "array",
              items: { type: "object" },
            },
          },
        },
      },
    },
    // x402 service-level metadata
    "x-x402-service": {
      name:        "Blue Hub",
      description: `${liveTools.length} AI tools for Base builders`,
      payTo:       PAY_TO,
      network:     "eip155:8453",
      asset:       USDC_BASE,
      catalogUrl:  "https://agentic.market/services/blueagent-dev",
    },
  };

  return NextResponse.json(spec, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, s-maxage=3600",
      "Content-Type": "application/json",
    },
  });
}
