// GET /api/wallet/spend?address=0x…
//
// The payer's own x402 receipts — what each USDC payment to the Blue Agent
// treasury actually BOUGHT. On Base a Hub tool call is indistinguishable from
// any other transfer (`0xUSER → 0x0295…, 0.05 USDC`); the tool id exists only in
// the request that triggered it. `lib/wallet/spend-log.ts` writes that join at
// settle time and this route hands it back so /wallet can render
// "Blue Hub · Honeypot Check · $0.05" where every other wallet shows hex.
//
// Tool ids are resolved to display names HERE, against the live AGENT_TOOLS
// catalog, for two reasons: the catalog is ~2k lines and has no business in a
// client bundle, and a name must be looked up rather than typed — a hand-kept
// id→label map in the UI is the exact defect class this wallet work has been
// removing. An id with no catalog entry (retired tool) returns `name: null`
// and the client prints the raw id. It never guesses a label.
//
// PUBLIC READ, deliberately, and worth stating plainly: anyone who knows an
// address can read which Hub tools that address bought. That is the same stance
// `/api/credits/balance/[address]` already takes for the credits rail, which
// publishes `reason: "tool:<id>"` per wallet. Gating one rail and not the other
// would be theatre, not privacy. If this should be owner-only, both rails need
// SIWE together — see the note in lib/wallet/spend-log.ts.

import { NextResponse } from "next/server";
import { getSpendLog } from "@/lib/wallet/spend-log";
import { AGENT_TOOLS } from "@/lib/agent-tools";

// Per-address read — never cache one wallet's receipts onto another's request.
export const dynamic = "force-dynamic";

const NAMES = new Map(AGENT_TOOLS.map(t => [t.id, t.name] as const));

export async function GET(req: Request) {
  const address = new URL(req.url).searchParams.get("address") ?? "";

  // A malformed address is a caller bug, not an outage: we know the answer is
  // "no receipts", so `known` stays true and the UI shows an empty drawer.
  if (!/^0x[a-fA-F0-9]{40}$/.test(address))
    return NextResponse.json({ receipts: [], known: true, error: "invalid address" });

  const rows = await getSpendLog(address);

  // `null` from getSpendLog means KV was unreachable — WE DO NOT KNOW, which is
  // not the same claim as "there are none". It travels to the client as
  // `known: false` so a KV outage cannot silently tell a paying user that none
  // of their payments ever bought anything.
  if (rows == null)
    return NextResponse.json({ receipts: [], known: false, error: "store unavailable" });

  return NextResponse.json({
    known: true,
    receipts: rows.map(r => ({
      ts:    r.ts,
      tool:  r.tool,
      // Community slugs are a DIFFERENT namespace and must not be looked up
      // here — a hosted tool slugged "token-price" would otherwise borrow the
      // first-party tool's name and tell the user they bought the wrong thing.
      // They render as their slug, which is already human-written.
      name:  r.src === "community" ? null : NAMES.get(r.tool) ?? null,
      units: r.units,
      usd:   r.units / 1_000_000,
      tx:    r.tx ?? null,
    })),
    ts: Date.now(),
  });
}
