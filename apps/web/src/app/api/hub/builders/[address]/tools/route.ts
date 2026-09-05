/**
 * /api/hub/builders/[address]/tools — tools owned by a wallet, with live stats.
 *
 * `count` is a COUNT OF WHAT WE COULD READ, not a census (#150 group B). The
 * previous version returned `getBuilderTools()`, which collapsed a KV throw
 * into `[]`, so a throttled Upstash window (#123/#148) published
 * `{tools: [], count: 0}` — a confident claim that a wallet owns nothing —
 * over the wire, where any consumer would reasonably cache and re-publish it.
 *
 * So the response now carries `coverage`, on the same lattice as the dashboard:
 *   complete    — `count` is the real number.
 *   partial     — the index read but ≥1 tool/counter behind it did not.
 *                 `count` is a FLOOR and `unreadableIds` names what is missing.
 *   unavailable — the index itself failed. `count: 0` means NOTHING WAS READ.
 * Serving the partial list is deliberate: the tools we can see are real, and a
 * caller is better off with nine of ten plus a flag than with a 500.
 */
import { NextRequest, NextResponse } from "next/server";
import { readBuilderTools } from "@/lib/hub-registry";

export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ address: string }> },
) {
  const { address } = await params;
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return NextResponse.json({ error: "Invalid address" }, { status: 400 });
  }
  const read = await readBuilderTools(address);
  return NextResponse.json(
    {
      tools:    read.tools,
      count:    read.tools.length,   // ⚠ a floor unless coverage === "complete"
      coverage: read.coverage,
      unreadableIds: read.unreadableIds,
    },
    { headers: { "Cache-Control": "private, no-cache" } },
  );
}
