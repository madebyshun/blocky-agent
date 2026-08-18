import { NextResponse } from "next/server";


export const runtime = "nodejs";
// Vercel kills serverless functions at 60s by default — explicit budget
// so it fails loudly instead of silently 504-ing.
export const maxDuration = 10;

const TOOLS = [
  // Security
  { slug: "honeypot-check",       price: "$0.10", category: "security",      description: "Token honeypot detection on Base" },
  { slug: "contract-trust",       price: "$0.15", category: "security",      description: "Smart contract trust score" },
  { slug: "aml-screen",           price: "$0.20", category: "security",      description: "AML screening for wallet addresses" },
  { slug: "allowance-audit",      price: "$0.10", category: "security",      description: "Token allowance audit" },
  { slug: "phishing-scan",        price: "$0.10", category: "security",      description: "Phishing URL/handle detection" },
  { slug: "key-exposure",         price: "$0.15", category: "security",      description: "Private key exposure check" },
  { slug: "risk-gate",            price: "$0.20", category: "security",      description: "Transaction risk gate" },
  // Research
  { slug: "deep-analysis",        price: "$0.50", category: "research",      description: "Deep project DD — Aeon + MiroShark + Blue" },
  { slug: "whale-copy-signal",    price: "$0.35", category: "research",      description: "Smart money copy signal" },
  { slug: "token-pick-signal",    price: "$0.20", category: "research",      description: "One actionable token pick" },
  { slug: "narrative-position",   price: "$0.25", category: "research",      description: "Narrative map with position calls" },
  { slug: "token-momentum-scanner", price: "$0.25", category: "research",    description: "Pre-pump momentum scanner" },
  { slug: "whale-tracker",        price: "$0.20", category: "research",      description: "Whale wallet tracker" },
  { slug: "community-sentiment",  price: "$0.25", category: "research",      description: "Community sentiment analysis" },
  { slug: "ecosystem-digest",     price: "$0.20", category: "research",      description: "Weekly Base ecosystem digest" },
  // Builder
  { slug: "market-fit",           price: "$0.35", category: "builder",       description: "Market fit validator — GO/WAIT/PIVOT" },
  { slug: "repo-health",          price: "$0.35", category: "builder",       description: "GitHub repo health check" },
  { slug: "competitor-scan",      price: "$0.75", category: "builder",       description: "Competitive landscape scan" },
  { slug: "token-launch-readiness", price: "$0.50", category: "builder",     description: "Token launch readiness score" },
  { slug: "builder-deep-dd",      price: "$1.00", category: "builder",       description: "Builder due diligence" },
  { slug: "roadmap-validator",    price: "$0.50", category: "builder",       description: "Roadmap vs market timing — SHIP/REVISE/PIVOT" },
  { slug: "gtm-brief",            price: "$0.50", category: "builder",       description: "Go-to-market brief" },
  { slug: "investor-memo",        price: "$0.75", category: "builder",       description: "Full investor memo" },
  { slug: "pitch-intelligence",   price: "$0.35", category: "builder",       description: "Pitch deck intelligence" },
  { slug: "fundraise-timing",     price: "$0.50", category: "builder",       description: "Fundraise timing signal" },
  { slug: "base-grant-finder",    price: "$0.35", category: "builder",       description: "Base ecosystem grant matching" },
  { slug: "launch-simulator-1",   price: "$0.10", category: "builder",       description: "Launch Simulator Tier 1 — quick 3-agent signal" },
  { slug: "launch-simulator-2",   price: "$0.35", category: "builder",       description: "Launch Simulator Tier 2 — deep signal + live market data" },
  { slug: "launch-simulator-3",   price: "$0.50", category: "builder",       description: "Launch Simulator Tier 3 — full multi-agent report" },
  // Wallet
  { slug: "defi-opportunity",     price: "$0.35", category: "wallet",        description: "DeFi opportunity scan on Base" },
  { slug: "protocol-risk-monitor", price: "$0.35", category: "wallet",       description: "Protocol risk assessment" },
  // Multi-agent
  { slug: "multi-agent-workflow", price: "$0.50", category: "multi-agent",   description: "Multi-agent workflow design" },
  { slug: "agent-collab-match",   price: "$0.35", category: "multi-agent",   description: "Agent collaboration compatibility" },
  { slug: "agent-performance",    price: "$0.35", category: "multi-agent",   description: "AI agent performance audit" },
  // Community
  { slug: "community-growth-playbook", price: "$0.50", category: "community", description: "Community growth strategy" },
  { slug: "thread-intelligence",  price: "$0.35", category: "community",     description: "CT thread strategy" },
  { slug: "narrative-pulse",      price: "$0.25", category: "community",     description: "Narrative pulse — what's running on CT" },
];

export async function GET() {
  return NextResponse.json(
    {
      name:    "Blue Agent API",
      version: "v1",
      baseUrl: "https://blueagent.dev/api/v1",
      auth:    "x402 — X-Payment header (USDC on Base mainnet)",
      docs:    "https://blueagent.dev/.well-known/openapi.json",
      endpoints: TOOLS.map(t => ({
        method:      "POST",
        path:        `/api/v1/${t.slug}`,
        price:       t.price,
        category:    t.category,
        description: t.description,
      })),
    },
    {
      headers: {
        "Access-Control-Allow-Origin":  "*",
        "Cache-Control": "public, max-age=300",
      },
    }
  );
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin":  "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}
