/**
 * Blue Hood — LLM health probe.
 *
 * One cheap `callLLM` call, returns success/failure + the model that was
 * tried. Since the chain strip (2026-07-25) there is exactly one provider
 * (Virtuals) — the endpoint's contract preserves the `attempts` array shape
 * for API compatibility, but it always has zero or one entry.
 *
 * Blue Hood smoke still asserts `first_success_provider !== null` so a
 * broken Virtuals path doesn't ship silently.
 *
 * Auth: `X-Blue-Internal` bypass (same header the poller uses), so a
 * public caller can never poll Virtuals on our dime.
 */
import { NextRequest, NextResponse } from "next/server";
import { callLLM, VIRTUALS_DEFAULT_MODEL } from "@/app/api/_lib/llm";

export const runtime = "nodejs";
export const maxDuration = 60;

const INTERNAL_KEY = process.env.INTERNAL_SERVICE_KEY ?? "";

function isAuthorized(req: NextRequest): boolean {
  const xInternal = req.headers.get("x-blue-internal") ?? req.headers.get("X-Blue-Internal");
  if (INTERNAL_KEY) return xInternal === INTERNAL_KEY;
  // Local dev without a key: allow so smoke works out of the box.
  return process.env.NODE_ENV !== "production";
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const started = Date.now();
  // Trivial prompt — we're pinging health, not generating anything.
  const opts = {
    system: "Reply with a single word: ok.",
    user: "ping",
    temperature: 0,
    maxTokens: 4,
    // No web-search — cheapest and fastest across providers.
    webSearch: false,
  };
  // Single provider since 2026-07-25. Kept as an object so the response
  // shape doesn't churn for any dashboard that already parses `models.<x>`.
  const models = {
    virtuals: process.env.VIRTUALS_MODEL ?? VIRTUALS_DEFAULT_MODEL,
  };
  try {
    const r = await callLLM(opts);
    return NextResponse.json(
      {
        ok: true,
        first_success_provider: r.provider,
        first_success_model: models.virtuals,
        attempts: r.attempts,
        models,
        chain_duration_ms: Date.now() - started,
      },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  } catch (e) {
    const err = e as Error & { attempts?: unknown; code?: string };
    return NextResponse.json(
      {
        ok: false,
        first_success_provider: null,
        attempts: Array.isArray(err.attempts) ? err.attempts : [],
        models,
        code:  err.code ?? "LLM_UNAVAILABLE",
        error: err.message,
        chain_duration_ms: Date.now() - started,
      },
      { headers: { "Cache-Control": "no-store, max-age=0" }, status: 200 },
    );
  }
}
