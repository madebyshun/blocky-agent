/**
 * Blue Chat — Cron Task Runner
 *
 * Executes a stored cron prompt through the SAME real-data pipeline the live
 * chat uses (`/api/chat`), then returns the final plain-text result.
 *
 * WHY proxy through /api/chat instead of calling the LLM directly:
 *   The previous version POSTed the prompt straight to the Bankr LLM with NO
 *   tools attached. That meant scheduled tasks like `/pick` produced
 *   FABRICATED output — the model free-associated a token pick with no live
 *   data behind it. /api/chat gives the model the full HUB_TOOLS set
 *   (hub_token_pick → token-pick-signal, hub_ecosystem → ecosystem-digest,
 *   hub_narrative → narrative-position, …), each backed by real on-chain /
 *   market data. Routing through it keeps cron results grounded in real data
 *   and avoids duplicating (and drifting) the tool catalog.
 *
 * Rule: real-data, the LLM must NOT fabricate data.
 *
 * PRIVILEGE: none. This route is reachable by anyone — it is the "Run now"
 * button, called straight from the browser — so it must never hold authority
 * the caller doesn't already have. It used to attach INTERNAL_SERVICE_KEY while
 * forwarding no wallet, which is precisely the combination `/api/chat` reads as
 * "authorized server job with no end-user" and answers by free-bypassing the
 * x402 paywall on every paid Hub tool. Anyone who could POST here could spend
 * the operator's tool budget anonymously. Forwarding the caller's own address
 * instead makes a scheduled run cost exactly what typing the same prompt into
 * the composer costs, which is the only defensible price for it.
 */
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://blueagent.dev";

// Expand bare slash commands into an explicit, tool-grounded ask so the model
// reliably calls the backing Hub tool instead of answering from memory.
const SLASH_EXPANSION: Record<string, string> = {
  "/pick":
    "Give me today's best token pick on Base. Use the hub_token_pick tool — base the thesis, entry, sizing and kill-criterion on its live data. Do not invent numbers.",
  "/scan":
    "Scan the current Base narratives. Use the hub_narrative tool and report the live mindshare/velocity/phase. Do not invent numbers.",
  "/digest":
    "Give me today's Base ecosystem digest. Use the hub_ecosystem tool for live launches/protocol/builder activity. Do not invent numbers.",
};

function expandPrompt(raw: string): string {
  const trimmed = raw.trim();
  const head = trimmed.split(/\s+/)[0]?.toLowerCase() ?? "";
  if (SLASH_EXPANSION[head]) {
    const rest = trimmed.slice(head.length).trim();
    return rest ? `${SLASH_EXPANSION[head]} Context: ${rest}` : SLASH_EXPANSION[head];
  }
  return trimmed;
}

/**
 * Read the chat route's SSE stream and accumulate the assistant text.
 * Handles both event shapes the chat route emits:
 *   - synthetic / Bankr:  { delta: { text } }
 *   - raw Anthropic:      { type: "content_block_delta", delta: { type: "text_delta", text } }
 * Both expose the chunk at `delta.text`, so reading that covers every case.
 * Tool-chip events (tool_start / tool_done / web_search_used) and
 * thinking_delta carry no `delta.text` and are skipped.
 */
async function collectSSEText(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let out = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });

    let idx: number;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data: ")) continue;
      const raw = line.slice(6).trim();
      if (raw === "[DONE]" || raw === "") continue;
      try {
        const ev = JSON.parse(raw) as { delta?: { text?: string } };
        if (typeof ev.delta?.text === "string") out += ev.delta.text;
      } catch {
        /* ignore non-JSON keepalive lines */
      }
    }
  }
  return out.trim();
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { prompt?: string; tier?: string; address?: string };
    const prompt = (body.prompt ?? "").trim();
    // Pass `tier` through untouched. This route used to keep its own
    // `fast | pro | max` allow-list and coerce everything else to `pro`, which
    // silently ran Deep/Private/Grok tasks on the default model — a third copy
    // of the tier table, drifting exactly the way the chat price tables did.
    // /api/chat already resolves tiers (and prices them); one owner is enough.
    const tier = (body.tier ?? "").trim() || "pro";
    const address = (body.address ?? "").trim();

    if (!prompt) {
      return NextResponse.json({ error: "prompt required" }, { status: 400 });
    }

    // Route through the live chat pipeline so the model has the real-data Hub
    // tools available — as the CALLER, with no borrowed authority. Forwarding
    // the wallet lets /api/chat set X-Blue-User on its x402 calls, so paid Hub
    // tools still run and are billed to the person who asked for them.
    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: expandPrompt(prompt) }],
        tier,
        // Only forward a well-formed address; junk here would be sent onward as
        // a ledger key. Absent/invalid → the run is treated as a guest chat.
        ...(/^0x[a-fA-F0-9]{40}$/.test(address) ? { address } : {}),
      }),
      signal: AbortSignal.timeout(90_000),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => res.statusText);
      return NextResponse.json(
        { error: `chat pipeline error ${res.status}: ${err.slice(0, 200)}` },
        { status: 502 },
      );
    }

    const result = await collectSSEText(res);
    return NextResponse.json({ result });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
