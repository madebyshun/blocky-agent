// GET /api/wallet/spend-summary?address=0x…
//
// The spend console's data: both payment rails for one wallet, grouped by tool
// and by day. `/api/wallet/spend` answers "name THIS transaction"; this answers
// "where has the money gone" — hence a second route rather than a fatter one.
//
// Display names are resolved HERE, against the live AGENT_TOOLS catalog, for
// the same two reasons as the sibling route: the catalog is ~2k lines and has
// no business in a client bundle, and a name must be LOOKED UP rather than
// typed. An id with no catalog entry (a retired tool) returns `name: null` and
// the client prints the raw id — it never guesses a label.
//
// Community rows deliberately skip the lookup. A Hub slug is free-form and
// lives in a different namespace, so a hosted tool slugged "token-price" would
// otherwise borrow the first-party tool's name and tell the user they bought
// something they did not.
//
// `creditsPerUsdc` is SHIPPED IN THE PAYLOAD rather than hard-coded in the UI
// so the console cannot drift from the rate the top-up flow actually charges.
// It converts `credits.paidAllTime` and nothing else — see spend-summary.ts on
// why no single credit event has a dollar value.
//
// PUBLIC READ, deliberately, matching `/api/wallet/spend` and
// `/api/credits/balance/[address]`: anyone with an address can already read
// both rails. Gating this aggregate alone would be theatre — it derives from
// two sources that are themselves open. Making it private means making all
// three private behind one signature check, in its own PR.

import { NextResponse } from "next/server";
import { getSpendSummary } from "@/lib/wallet/spend-summary";
import { CREDITS_PER_USDC } from "@/lib/payments";
import { AGENT_TOOLS } from "@/lib/agent-tools";

// Per-address read — never cache one wallet's spending onto another's request.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NAMES = new Map(AGENT_TOOLS.map(t => [t.id, t.name] as const));

/** Shape-compatible zero, so a bad address never makes the client branch twice. */
const EMPTY = {
  usdc:    { status: "ok" as const, units: 0, calls: 0 },
  credits: { status: "ok" as const, spentInWindow: 0, callsInWindow: 0, paidAllTime: 0, truncated: false },
  chat:    { credits: 0, calls: 0 },
  other:   { credits: 0, calls: 0 },
  tools:   [] as never[],
  days:    [] as never[],
  partial: false,
  creditsPerUsdc: CREDITS_PER_USDC,
};

export async function GET(req: Request) {
  const address = new URL(req.url).searchParams.get("address") ?? "";

  // A malformed address is a caller bug, not an outage: we know the answer is
  // "nothing spent", so both rails report `ok` and the console renders empty.
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return NextResponse.json({ error: "invalid address", ...EMPTY, ts: Date.now() });
  }

  const s = await getSpendSummary(address);

  return NextResponse.json({
    ...s,
    creditsPerUsdc: CREDITS_PER_USDC,
    tools: s.tools.map(t => ({
      ...t,
      name: t.src === "community" ? null : NAMES.get(t.tool) ?? null,
    })),
  });
}
