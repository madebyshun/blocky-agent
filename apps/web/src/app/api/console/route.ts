import { NextRequest, NextResponse } from "next/server";
import { rateLimit, getIdentifier } from "@/lib/rate-limit";
import { CONSOLE_SYSTEMS, CONSOLE_MAX_TOKENS, groundConsolePrompt, type ConsoleCommand } from "@/lib/console-systems";
import { callLLM, NO_FABRICATION_RULE } from "@/app/api/_lib/llm";
import { kv } from "@/lib/kv";

export const runtime = "nodejs";
// 120s lets the upstream LLM's ~100s ceiling resolve before Vercel kills us.
// Headroom raised from 90s because `audit` runs on a larger token budget and
// can legitimately take longer than the old Haiku-only path. Persona 2 was
// hitting 504 because the upstream fetch was unbounded — when the LLM stalled,
// this function got killed at the old 60s with no error msg.
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  // Rate limit: 10 commands/min per IP
  const { success } = await rateLimit(getIdentifier(req), "console");
  if (!success) {
    return NextResponse.json({ error: "Too many requests. Slow down." }, { status: 429 });
  }

  let body: { command?: string; prompt?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { command, prompt } = body;
  if (!command || !prompt?.trim()) {
    return NextResponse.json({ error: "command and prompt are required." }, { status: 400 });
  }

  const cmd: ConsoleCommand = (command in CONSOLE_SYSTEMS ? command : "idea") as ConsoleCommand;
  const system = `${NO_FABRICATION_RULE}\n\n${CONSOLE_SYSTEMS[cmd]}`;
  const grounded = await groundConsolePrompt(cmd, prompt);

  // Migrated 2026-07-26 from a direct Bankr fetch to callLLM (Virtuals-only).
  // Bankr LLM was 403 banned in prod, killing all 5 console commands (idea /
  // build / audit / ship / raise) for both /api/console browser callers AND
  // every MCP client whose `blue_*` tool routes here. callLLM's typed
  // LLM_UNAVAILABLE error surfaces cleanly as a 502 with no charge.
  try {
    const r = await callLLM({
      system,
      user: grounded,
      maxTokens: CONSOLE_MAX_TOKENS[cmd],
    });
    if (!r.text) {
      return NextResponse.json({ error: "Empty LLM response." }, { status: 502 });
    }
    // Run counter — the ONLY measurement the 5 console commands have. Keyed
    // `usage:blue_<cmd>` to share the namespace the x402 + MCP hub-tool paths
    // already use, so /api/usage can read every surface through one key shape.
    // Counted here (after a non-empty result) rather than at entry, so a failed
    // or rate-limited call never inflates the number.
    //
    // Forward-only: this starts at deploy time, exactly like the x402 settlement
    // counters. It is NOT a lifetime-since-launch figure and must never be
    // presented as one — the UI only renders it once it is > 0.
    try { await kv.incr(`usage:blue_${cmd}`); } catch { /* counter is best-effort */ }

    return NextResponse.json({
      result:      r.text,
      provider:    r.provider,
      duration_ms: r.duration_ms,
    });
  } catch (e) {
    const err = e as Error & { code?: string };
    const isUnavailable = err.code === "LLM_UNAVAILABLE";
    return NextResponse.json(
      {
        error:  isUnavailable
          ? "LLM provider unavailable — this is upstream, retry shortly. DM @blueagent_ if it persists."
          : `Console command failed: ${err.message}`,
        code:   err.code ?? "UPSTREAM",
        detail: err.message.slice(0, 300),
      },
      { status: 502 }
    );
  }
}
