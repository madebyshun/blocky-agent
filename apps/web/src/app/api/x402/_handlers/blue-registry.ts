// x402/blue-registry
// Blue Registry — discovery for the Blue Hub tool catalog.
// Lists every callable tool (first-party + community-submitted), filterable by
// query/category, with prices and how-to-call instructions. Pure data, no LLM —
// deterministic and always available (the registry IS the product surface here).
// Price: $0.05

import { AGENT_TOOLS } from "@/lib/agent-tools";
import { readRegisteredTools } from "@/lib/hub-registry";

type CatalogEntry = {
  id:          string;
  name:        string;
  description: string;
  category:    string;
  price:       string;
  source:      "first-party" | "community";
  endpoint:    string;
  mcp_name?:   string;
  call_count?: number;
};

// MCP exposes hub tools under hub_* / blue_* names. We can't perfectly reverse
// every mapping here, but the x402 endpoint is always /api/x402/<id>, which is
// the canonical call path an agent needs.
function toEntry(
  t: { id: string; name: string; description: string; category?: string; price?: string },
  source: CatalogEntry["source"],
  callCount?: number,
): CatalogEntry {
  return {
    id:          t.id,
    name:        t.name,
    description: t.description,
    category:    t.category ?? "other",
    price:       t.price ?? "—",
    source,
    endpoint:    `https://blueagent.dev/api/x402/${t.id}`,
    ...(callCount != null ? { call_count: callCount } : {}),
  };
}

export default async function handler(req: Request): Promise<Response> {
  try {
    let body: { query?: string; category?: string } = {};
    try { const t = await req.text(); if (t.trim().startsWith("{")) body = JSON.parse(t); } catch {}
    const url = new URL(req.url);
    const query    = (body.query    ?? url.searchParams.get("query")    ?? "").trim().toLowerCase();
    const category = (body.category ?? url.searchParams.get("category") ?? "").trim().toLowerCase();

    // First-party catalog (always available).
    const firstParty: CatalogEntry[] = AGENT_TOOLS
      .filter((t) => !!t.price) // only callable/paid tools
      .map((t) => toEntry(t, "first-party"));

    // Community registry (KV-backed).
    //
    // The `try/catch → community = []` this replaces was dead code twice over:
    // `listRegisteredTools` swallowed its own KV errors internally, so nothing
    // ever reached the catch, and the "graceful degradation" it promised was in
    // fact a SILENT one — this is a PAID tool whose whole product is a census
    // ("totals.community", "totals.all"), and a throttled Upstash read published
    // a smaller catalog under an unqualified `data_source` claim. The buyer had
    // no way to tell a quiet marketplace from an unreadable one.
    const registry = await readRegisteredTools();
    const community: CatalogEntry[] = registry.tools.map(
      (t) => toEntry(t, "community", t.callCount ?? 0),
    );

    // Community FIRST. The `slice(0, 60)` below is a hard payload cap and
    // AGENT_TOOLS is 112 priced tools, so with first-party leading, every
    // community tool fell off the end of an unfiltered response — permanently.
    // The old comment on that slice already claimed "community tools surface
    // first (discovery boost)"; the order never implemented it. That made this
    // paid tool answer "totals.community: N" with N of them in `tools`, and
    // close with "Builders: register your own x402 tool" pointing at a shelf
    // nothing reached. Ordering is the whole fix — no total changes.
    const all = [...community, ...firstParty];

    // Category breakdown (over the full catalog, pre-filter).
    const categories = all.reduce<Record<string, number>>((acc, t) => {
      acc[t.category] = (acc[t.category] ?? 0) + 1;
      return acc;
    }, {});

    // Apply filters.
    let matches = all;
    if (category) matches = matches.filter((t) => t.category.toLowerCase() === category);
    if (query) {
      matches = matches.filter((t) =>
        t.id.toLowerCase().includes(query) ||
        t.name.toLowerCase().includes(query) ||
        t.description.toLowerCase().includes(query) ||
        t.category.toLowerCase().includes(query)
      );
    }

    // Cap payload. `all` is ordered community-first (see above), so this cap can
    // no longer amputate the community half — but it DOES mean `tools.length` is
    // not a count of anything. Read `totals`, which is uncapped.
    const limited = matches.slice(0, 60);

    return Response.json({
      tool: "blue-registry",
      timestamp: new Date().toISOString(),
      data_source: "Blue Hub registry (first-party catalog + KV builder registry)",
      query: query || null,
      category: category || null,
      totals: {
        all:          all.length,
        first_party:  firstParty.length,   // AGENT_TOOLS — always exact
        community:    community.length,    // ⚠ a FLOOR unless registry_coverage === "complete"
        matched:      matches.length,
      },
      /**
       * How much of the COMMUNITY half we could actually read. The first-party
       * catalog is compiled in and never degrades, so only this half can be short.
       *   complete    — the community totals are exact.
       *   partial     — the index read but ≥1 tool behind it did not; totals are floors.
       *   unavailable — the index itself failed; `community: 0` means NOTHING was read.
       */
      registry_coverage: registry.coverage,
      ...(registry.coverage !== "complete" && {
        registry_note:
          registry.coverage === "unavailable"
            ? "The community registry could not be read. This is not an empty registry — community tools are missing from these totals and from `tools`."
            : `${registry.unreadableIds.length} community tool(s) could not be read and are missing from these totals and from \`tools\`.`,
      }),
      categories,
      /** ⚠ CAPPED at 60. `tools.length < totals.matched` means truncated, not
       *  filtered out — narrow with `query`/`category` to see the rest. */
      tools: limited,
      tools_truncated: matches.length > limited.length,
      how_to_call: {
        x402: "GET /api/x402/{id} for payment requirements, sign EIP-3009 USDC on Base (chain 8453), POST with X-Payment header.",
        mcp:  "Connect the Blue Agent MCP server (https://blueagent.dev/api/mcp) in Claude Desktop / Cursor and call the tool by name.",
        docs: "https://blueagent.dev/.well-known/openapi.json",
      },
      submit_a_tool: "Builders: register your own x402 tool at https://blueagent.dev/hub/submit (80/20 revenue split, USDC on Base).",
    });
  } catch (e) {
    return Response.json(
      { error: "Blue registry failed", message: (e as Error).message },
      { status: 500 }
    );
  }
}
