/**
 * GET /api/hub/builders/[address]/dashboard — creator dashboard data for one wallet.
 *
 * Aggregates BOTH registries the wallet can own tools in:
 *   • external (hub-registry)  — builder self-hosts the endpoint; 95/5 split.
 *                                Per-tool revenue is tracked (hub:tools:revenue:<id>).
 *   • hosted   (hub-hosted)    — Blue Hub runs the tool; 90/10 split.
 *                                Earnings are POOLED per wallet (builder:earned:<wallet>),
 *                                not per-tool, so hosted items carry no per-tool figure —
 *                                the aggregate is returned once under earnings.hostedUnits.
 *
 * Secrets never leave the server: external tools omit no secret (endpoint is public),
 * hosted tools go through toPublicHostedTool() inside readBuilderHostedTools() so
 * systemPrompt / authValue are stripped. All USDC figures are micro-units (6 decimals).
 *
 * ── WHY THIS ROUTE CARRIES `coverage` (#150 group B) ─────────────────────────
 * This response is assembled from FOUR independently-collapsing KV reads: the
 * external owner index, the hosted owner index, every per-tool counter behind
 * them, and the pooled `builder:earned:<wallet>` figure. Each one used to
 * degrade to `?? 0` / `?? []` on a KV throw, and the route then SUMMED them —
 * so a single throttled read (routine during the Upstash cap windows #123/#148)
 * produced a confident `earnings.totalUnits: 0` and `counts.total: 0`. The
 * dashboard rendered that as "$0.0000" and "No tools registered yet".
 *
 * Nothing was destroyed; the balance and the tools sat intact in KV. But this
 * is the one screen in the product that makes a claim about someone's money,
 * and the counter IS the record — there is no receipt to check it against — so
 * "we could not read it" and "you have earned nothing" must not share a
 * rendering. Hence:
 *
 *   • every earnings figure is `number | null`; null means UNREADABLE, never 0.
 *   • `totalUnits` is null if EITHER component is null. A total that silently
 *     drops an unknown component is precisely the bug — the components are
 *     still there for anyone who wants the floor.
 *   • `coverage` is the WORST of the reads, so a caller cannot pick the
 *     optimistic one by accident.
 *
 * A partial read is still worth serving: the tools we CAN see are real, and a
 * builder mid-outage is better off with nine of ten tools plus a warning than
 * with an error page.
 */
import { NextRequest, NextResponse } from "next/server";
import { readBuilderTools, worstCoverage, type Coverage } from "@/lib/hub-registry";
import { readBuilderHostedTools, getBuilderEarnings } from "@/lib/hub-hosted";

export const runtime = "nodejs";

// Normalized row the dashboard renders — a superset that fits both registries.
interface DashboardItem {
  source:      "external" | "hosted";
  id:          string;             // external id | hosted slug
  name:        string;
  description: string;
  agentName?:  string;             // creator brand/handle (default = short owner addr)
  category:    string;
  price:       string;
  priceUSDC:   number;
  verified:    boolean;
  aiReady:     boolean;
  template?:   string;             // hosted only: ai_tool | api_wrapper
  submittedAt: number;
  /** Lifetime paid runs (usage:<id>). `null` = the counter was unreadable, NOT zero. */
  callCount:   number | null;
  /** External: this tool's 95% accrual, or null if unreadable. Hosted: always
   *  null — earnings are pooled per wallet. `earningsScope` disambiguates. */
  earnedUnits: number | null;
  /** Why `earnedUnits` may be null: "pooled" = not tracked per tool (hosted);
   *  "per_tool" = it IS tracked, so a null there means we failed to read it. */
  earningsScope: "per_tool" | "pooled";
  splitPct:    number;             // builder share: 95 (external) | 90 (hosted)
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ address: string }> },
) {
  const { address } = await params;
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return NextResponse.json({ error: "Invalid address" }, { status: 400 });
  }

  const [external, hosted, hostedEarnedUnits] = await Promise.all([
    readBuilderTools(address),
    readBuilderHostedTools(address),
    getBuilderEarnings(address),
  ]);

  const externalItems: DashboardItem[] = external.tools.map(t => ({
    source:        "external",
    id:            t.id,
    name:          t.name,
    description:   t.description,
    agentName:     t.agentName,
    category:      t.category,
    price:         t.price,
    priceUSDC:     t.priceUSDC,
    verified:      t.verified,
    aiReady:       t.aiReady,
    submittedAt:   t.submittedAt,
    callCount:     t.callCount ?? null,
    earnedUnits:   t.revenueTotal ?? null,   // per-tool 95% accrual is tracked
    earningsScope: "per_tool",
    splitPct:      95,
  }));

  const hostedItems: DashboardItem[] = hosted.tools.map(h => ({
    source:        "hosted",
    id:            h.slug,
    name:          h.name,
    description:   h.description,
    agentName:     h.agentName,
    category:      h.category,
    price:         h.price,
    priceUSDC:     h.priceUSDC,
    verified:      h.verified,
    aiReady:       h.template === "ai_tool",
    template:      h.template,
    submittedAt:   h.submittedAt,
    callCount:     h.callCount ?? null,
    earnedUnits:   null,                     // hosted earnings are pooled, not per-tool
    earningsScope: "pooled",
    splitPct:      90,
  }));

  // Sum the external accruals — but only if we read ALL of them. One unreadable
  // counter makes the sum a floor, and a floor rendered as a total is the lie.
  //
  // TWO ways a component can be unknown, and only one of them is visible in
  // `externalItems`:
  //   1. a COUNTER threw — the tool is here, its figure is null.
  //   2. the tool RECORD threw — the tool never became an item at all, so no
  //      amount of inspecting `externalItems` can notice it is missing.
  // Case 2 is why this reads `coverage !== "complete"` rather than
  // `=== "unavailable"`. The first cut of this route checked only case 1 and,
  // with one of three tools unreadable, published a confident total that was
  // short by exactly that tool's accrual — the same "silently drop an unknown
  // component" bug it was written to fix, one level up. (Caught by case E of
  // scripts/hub-dashboard-kv-test.ts, which is why that case exists.)
  const externalCountersUnknown = externalItems.some(t => t.earnedUnits === null);
  const externalUnknown = external.coverage !== "complete" || externalCountersUnknown;
  const externalUnits = externalUnknown
    ? null
    : externalItems.reduce((s, t) => s + (t.earnedUnits ?? 0), 0);

  const items = [...externalItems, ...hostedItems].sort((a, b) => b.submittedAt - a.submittedAt);

  // The pooled hosted counter has its own failure mode, independent of the
  // hosted index: the index can read fine while `builder:earned:<wallet>` throws.
  const earningsCoverage: Coverage = worstCoverage(
    externalUnknown ? "partial" : "complete",
    hostedEarnedUnits === null ? "partial" : "complete",
  );

  const coverage = worstCoverage(external.coverage, hosted.coverage, earningsCoverage);

  const warnings: string[] = [];
  if (external.coverage === "unavailable") warnings.push("Could not read your external tool list — this is not an empty list.");
  if (hosted.coverage === "unavailable")   warnings.push("Could not read your hosted tool list — this is not an empty list.");
  if (external.unreadableIds.length)       warnings.push(`${external.unreadableIds.length} external tool(s) could not be read and are missing from this page.`);
  if (hosted.unreadableSlugs.length)       warnings.push(`${hosted.unreadableSlugs.length} hosted tool(s) could not be read and are missing from this page.`);
  // Deliberately keyed off the counter-specific flag, not `externalUnknown`:
  // an unreadable tool RECORD is already reported by the `unreadableIds`
  // warning above, and saying "revenue counter" about it would misattribute
  // the failure.
  if (externalCountersUnknown)             warnings.push("At least one external revenue counter could not be read.");
  if (hostedEarnedUnits === null)          warnings.push("Your pooled hosted earnings counter could not be read.");

  return NextResponse.json(
    {
      address: address.toLowerCase(),
      items,
      // Counts of what we could READ. On `coverage !== "complete"` these are
      // floors — see the header.
      counts: { external: externalItems.length, hosted: hostedItems.length, total: items.length },
      earnings: {
        externalUnits,                          // sum of per-tool 95% accruals · null = unreadable
        hostedUnits: hostedEarnedUnits,         // pooled 90% accrual · null = unreadable
        totalUnits:
          externalUnits === null || hostedEarnedUnits === null
            ? null
            : externalUnits + hostedEarnedUnits,
      },
      coverage,
      warnings,
    },
    { headers: { "Cache-Control": "private, no-cache" } },
  );
}
