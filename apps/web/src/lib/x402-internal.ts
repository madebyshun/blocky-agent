/**
 * Headers for server-to-server calls to /api/x402/:tool.
 *
 * WHY THIS EXISTS
 * ---------------
 * The x402 route accepts an "internal bypass" for authorized callers so the
 * poller, crons, MCP, and other in-house code can execute paid tools without
 * transacting USDC on every call. The bypass requires TWO headers:
 *
 *   X-Blue-Internal: <INTERNAL_SERVICE_KEY>   // proves the caller is our server
 *   X-Blue-Service:  internal                 // proves this isn't a browser
 *                                             //   guest replaying a stolen key
 *
 * See apps/web/src/app/api/x402/[tool]/route.ts:188 (key check) and 229-241
 * (guard that returns 402 WALLET_REQUIRED for paid tools when the second
 * header is missing — the guard that MCP tripped over from Jul → now).
 *
 * Historically each caller assembled these headers inline, and the MCP route
 * shipped the first header but not the second when the guard was added.
 * Result: every paid MCP tool returned a text stub telling the LLM to "set
 * INTERNAL_SERVICE_KEY" — silently, with HTTP 200. Route the headers through
 * this module so the next caller can't drift.
 *
 * If INTERNAL_SERVICE_KEY is unset, the bypass headers are OMITTED — the
 * request falls through to normal x402 payment. Callers stay responsible for
 * handling the resulting 402 (MCP surfaces it as an isError; crons should
 * abort with a clear log).
 */

/** Returns true when the runtime has a real internal-service key. */
export function hasInternalKey(): boolean {
  return !!process.env.INTERNAL_SERVICE_KEY;
}

/**
 * Base headers for JSON bodies. Callers that need internal x402 bypass should
 * use {@link internalX402Headers} instead — this one is here so a caller
 * that intentionally wants the paid path (with X-Payment) doesn't get
 * bypass headers by accident.
 */
export function jsonHeaders(extra?: Record<string, string>): Record<string, string> {
  return { "Content-Type": "application/json", ...(extra ?? {}) };
}

/**
 * JSON headers PLUS the two x402 bypass headers required for server-to-server
 * calls to the internal endpoint.
 *
 * Usage:
 *   const res = await fetch(`${BASE}/api/x402/${tool}`, {
 *     method: "POST",
 *     headers: internalX402Headers(),
 *     body: JSON.stringify(body),
 *   });
 *
 * If INTERNAL_SERVICE_KEY is unset, only Content-Type is returned — the caller
 * will then get a normal 402 from the x402 route.
 */
export function internalX402Headers(extra?: Record<string, string>): Record<string, string> {
  const h = jsonHeaders(extra);
  const key = process.env.INTERNAL_SERVICE_KEY ?? "";
  if (key) {
    h["X-Blue-Internal"] = key;
    h["X-Blue-Service"]  = "internal";
  }
  return h;
}
