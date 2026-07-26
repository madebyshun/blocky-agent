/**
 * Shared helper for the 5 paid Console commands (idea / build / audit / ship / raise).
 * Each command is a thin handler that calls runConsoleCommand with its system
 * prompt; payment is handled upstream by /api/x402/[tool] (verify → run → settle).
 *
 * Migrated 2026-07-26 to callLLM (Virtuals-only). Old behavior split idea/raise
 * onto Venice (for real web search) and build/ship/audit onto Bankr directly.
 * Both providers are gone: Bankr is 403 banned in prod, Venice was removed by
 * the chain strip. Now all 5 commands run on Virtuals via callLLM and throw
 * LLM_UNAVAILABLE if that fails — the x402 route surfaces it as 502 with no
 * charge, same contract as before.
 *
 * `webSearch: true` used to unlock Venice's live search. Virtuals has no
 * search, so we swap in STATIC_KNOWLEDGE_DISCLAIMER on the system prompt for
 * those commands (idea / raise). The model still writes its answer, but the
 * caller gets a labelled low-confidence marker for anything fresh-fact-y.
 */
import { CONSOLE_SYSTEMS, CONSOLE_MAX_TOKENS, groundConsolePrompt, type ConsoleCommand } from "@/lib/console-systems";
import { callLLM, NO_FABRICATION_RULE, STATIC_KNOWLEDGE_DISCLAIMER } from "@/app/api/_lib/llm";

export async function runConsoleCommand(
  command: ConsoleCommand,
  prompt: string,
  opts: { webSearch?: boolean } = {}
): Promise<Response> {
  if (!prompt?.trim()) {
    return Response.json({ error: "prompt is required" }, { status: 400 });
  }
  try {
    const grounded = await groundConsolePrompt(command, prompt);

    // Fabrication guard always. When the caller wanted webSearch (idea/raise —
    // topics where fresh facts matter), also stamp the static-knowledge
    // disclaimer so the answer is labelled honestly instead of pretending
    // fresh grounding it doesn't have.
    const guardPreamble = opts.webSearch
      ? `${NO_FABRICATION_RULE}\n\n${STATIC_KNOWLEDGE_DISCLAIMER}`
      : NO_FABRICATION_RULE;
    const system = `${guardPreamble}\n\n${CONSOLE_SYSTEMS[command]}`;

    const r = await callLLM({
      system,
      user: grounded,
      maxTokens: CONSOLE_MAX_TOKENS[command],
    });
    const result = r.text;

    if (!result) {
      return Response.json({ error: "Empty LLM response" }, { status: 502 });
    }
    return Response.json({
      command,
      result,
      provider:      r.provider,
      web_search:    r.web_search_used,
      duration_ms:   r.duration_ms,
      timestamp:     new Date().toISOString(),
    });
  } catch (e) {
    const err = e as Error & { code?: string };
    // LLM_UNAVAILABLE (Virtuals down) → 502 no-charge. Any other exception
    // (network, unexpected shape) → 502 with the raw message.
    return Response.json(
      {
        error:   "Console command failed",
        code:    err.code ?? "UPSTREAM",
        message: err.message,
      },
      { status: 502 }
    );
  }
}
