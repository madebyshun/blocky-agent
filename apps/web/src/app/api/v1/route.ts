/**
 * /api/v1 — machine-readable index of the legacy API alias.
 *
 * Every id listed here is callable at POST /api/v1/<id>, which re-exports the
 * canonical /api/x402/<id> handler. This index is what an autonomous agent
 * reads to decide WHICH tool to call and HOW MUCH to budget for it.
 *
 * ⚠ DERIVED FROM `AGENT_TOOLS` ON PURPOSE — never hand-maintain this list.
 *
 * It used to be a hardcoded array of 37 entries, and by 2026-08-28 it had
 * rotted in all three possible directions at once (measured against the live
 * catalog, not estimated):
 *
 *   • 25 of 37 PRICES were wrong. Not rounding — `key-exposure` advertised
 *     $0.15 against a real $0.50 (3.3× under), `competitor-scan` $0.75 against
 *     $0.20 (3.75× over). An agent budgeting off this index either underfunds
 *     the call and gets a 402, or overpays. Prices are the one field a paying
 *     machine cannot sanity-check for itself.
 *   • 2 GHOST ids (`allowance-audit`, `phishing-scan`) were advertised but had
 *     no handler. Calling them returns 501 with the hint "the catalog listing
 *     will be removed shortly" — a promise this file never kept.
 *   • 77 of 112 real tools were MISSING, so 69% of the surface was
 *     undiscoverable to any agent that trusted this endpoint.
 *
 * Deriving makes all three unrepresentable: the price is the catalog's price,
 * a ghost cannot appear because the filter requires a live HANDLER entry, and
 * a new tool shows up the moment it is registered. Same single-source-of-truth
 * discipline `.well-known/openapi.json` already uses.
 */
import { NextResponse } from "next/server";
import { AGENT_TOOLS } from "@/lib/agent-tools";
import { HANDLERS }    from "@/app/api/x402/_handlers";

export const runtime = "nodejs";
// Vercel kills serverless functions at 60s by default — explicit budget
// so it fails loudly instead of silently 504-ing.
export const maxDuration = 10;

// `HANDLERS[t.id]` is the anti-ghost guard: a catalog entry with no handler is
// a 501 waiting to happen, so it must not be advertised as callable.
const TOOLS = AGENT_TOOLS
  .filter(t => HANDLERS[t.id] && t.price)
  .map(t => ({
    slug:        t.id,
    price:       t.price!,
    category:    t.category,
    description: t.description,
  }));


export async function GET() {
  return NextResponse.json(
    {
      name:    "Blue Agent API",
      version: "v1",
      baseUrl: "https://blueagent.dev/api/v1",
      auth:    "x402 — X-Payment header (USDC on Base mainnet)",
      docs:    "https://blueagent.dev/.well-known/openapi.json",
      count:   TOOLS.length,
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
