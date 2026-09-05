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
import { HANDLERS }    from "@/app/api/x402/_handlers";

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

/**
 * Which prompt personas actually run for a tool, read off the catalog's own
 * `agentName` field.
 *
 * This used to be `t.isComposite ? ["blue","aeon","miroshark"] : ...`, which
 * was wrong for 61 of the 65 composite tools — measured 2026-08-28 against
 * `agentName` in the SAME file. `isComposite` means "multi-STEP", not
 * "multi-AGENT": 31 composite tools are `agentName: "Blue Agent"` (one
 * persona, several chained calls) and were nonetheless advertising Aeon and
 * MiroShark to every directory that indexes this endpoint.
 *
 * Real distribution: Blue-only 78, +Aeon 26, +MiroShark 4, all three 4.
 *
 * ⚠ These are PERSONAS, not independent agents. Every one is a system-prompt
 * prefix plus an injected skill file on a single Virtuals endpoint
 * (`_lib/llm.ts`) — there is no separate model, no separate vendor, and no
 * voting protocol. Some handlers do weight several persona outputs into a
 * final verdict (launch-simulator-2/3); most do not. Keep this field
 * descriptive of which prompts run, and do not let it grow back into a
 * "consensus" claim.
 */
function agentsFor(agentName: string): string[] {
  const n = agentName.toLowerCase();
  const out = ["blue"];
  if (n.includes("aeon"))      out.push("aeon");
  if (n.includes("miroshark")) out.push("miroshark");
  return out;
}

export async function GET() {
  // `HANDLERS[t.id]` is a regression guard, not a fix: measured 2026-08-28 all
  // 112 catalog entries have a handler, so this changes nothing today. It is
  // here because the sibling `/api/v1` index DID drift into advertising two
  // ids with no handler (`allowance-audit`, `phishing-scan`), which answer 501.
  // A directory that indexes this endpoint cannot tell a real tool from a
  // ghost, so the filter has to.
  const tools = AGENT_TOOLS
    .filter(t => t.x402Url && HANDLERS[t.id])
    .map(t => ({
      id: t.id,
      name: t.name,
      description: t.description,
      category: t.category,
      agents: agentsFor(t.agentName),
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
      // Describes what a calling agent GETS, not how we brand it. The previous
      // text sold "3-agent consensus (Blue · Aeon · MiroShark)" as a blanket
      // property of the catalog; measured, 78 of 112 tools run a single Blue
      // persona and no tool involves a second model or vendor. The per-tool
      // `agents` field above now reports which personas actually run, which is
      // the checkable version of the same information.
      // Both chains are named because a ticker alone does not identify a token
      // here (CLAUDE.md rule 1) and ~30 rh-* tools are Robinhood-Chain-only.
      // `network` below is the PAYMENT rail (USDC on Base) and is unrelated to
      // which chain a given tool reads.
      description:
        "AI agent tools for builders and traders on Base (8453) and Robinhood Chain (4663) — on-chain data, security audits, DeFi and market signals. Pay per call in USDC over x402. No API key, no signup.",
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
