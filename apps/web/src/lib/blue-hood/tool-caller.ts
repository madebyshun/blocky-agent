/**
 * Blue Hood — dual-mode x402 tool caller.
 *
 * The poller needs to hit x402 tools 26+ times per cycle. We support two
 * modes so localhost dev doesn't have to fight the prod internal-bypass:
 *
 *   • **local mode** (default in dev)  — import HANDLERS directly, no HTTP.
 *   • **http mode**  (set BH_TOOL_TARGET) — hit `${BH_TOOL_TARGET}/api/x402/<id>`
 *     with `X-Blue-Internal` + `X-Blue-Service: internal`. Same headers the
 *     semantic-smoke CI script uses, same headers the frontend cron will
 *     use when it wants to warm prod's cache.
 *
 * The default is local because prod itself will use local — Vercel functions
 * calling other Vercel functions over HTTP would burn extra $ + latency for
 * no gain. Http mode is there for out-of-band debugging.
 */

import { internalX402Headers, hasInternalKey } from "@/lib/x402-internal";

const TARGET = process.env.BH_TOOL_TARGET ?? "";
export const TOOL_CALLER_MODE: "http" | "local" = TARGET ? "http" : "local";

type ToolResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

let localHandlers: Record<string, (req: Request) => Promise<Response>> | null = null;
async function getLocalHandlers() {
  if (localHandlers) return localHandlers;
  const mod = await import("@/app/api/x402/_handlers");
  localHandlers = mod.HANDLERS;
  return localHandlers;
}

/**
 * Call an x402 tool by id and return its parsed JSON (or a normalized error).
 * Never throws — poller callers can `.map` over 26 tickers without a try/catch.
 */
export async function callTool<T = Record<string, unknown>>(
  tool: string,
  body: unknown,
  { timeoutMs = 15_000 }: { timeoutMs?: number } = {},
): Promise<ToolResult<T>> {
  try {
    if (TOOL_CALLER_MODE === "http") {
      if (!hasInternalKey()) return { ok: false, status: 500, error: "INTERNAL_SERVICE_KEY not set for http mode" };
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeoutMs);
      const r = await fetch(`${TARGET}/api/x402/${tool}`, {
        method: "POST",
        headers: internalX402Headers(),
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      clearTimeout(t);
      const data = (await r.json().catch(() => ({}))) as T;
      if (!r.ok) return { ok: false, status: r.status, error: (data as { error?: string }).error ?? `HTTP ${r.status}` };
      return { ok: true, data };
    }

    const HANDLERS = await getLocalHandlers();
    const h = HANDLERS[tool];
    if (!h) return { ok: false, status: 503, error: `No local handler for ${tool}` };
    // NOTE: local mode still hits real upstream data sources (GeckoTerminal,
    // Chainlink RPC, etc.) — it just skips HTTP + x402 payment/bypass.
    const req = new Request(`http://localhost/api/x402/${tool}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const res = await h(req);
    const data = (await res.json().catch(() => ({}))) as T;
    if (!res.ok) return { ok: false, status: res.status, error: (data as { error?: string }).error ?? `HTTP ${res.status}` };
    return { ok: true, data };
  } catch (e) {
    return { ok: false, status: 0, error: (e as Error).message };
  }
}
