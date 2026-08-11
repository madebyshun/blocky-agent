/**
 * Blue Hood — ACP resource helpers.
 *
 * Small shared toolkit for the three GET endpoints under `/api/acp/*`:
 *   • CORS + preflight
 *   • Per-IP token-bucket rate limit (in-memory; per warm instance, sub-ip
 *     bucket, ~10 req/min — light per spec, not a security perimeter)
 *   • `powered_by` + `docs` envelope every response ships with
 *
 * These are free public URLs — no auth, no payment. The x402 handlers
 * they wrap are all free/cached (`rh-rwa-verify` price = $0.00, `/api/
 * hood/*` reads from KV snapshot). We NEVER wrap paid tools here.
 */

const WINDOW_MS = 60_000; // 1 minute
const MAX_REQS = 20;      // per window per IP
const bucket = new Map<string, { at: number; count: number }>();

/**
 * Very simple sliding-window per-IP rate limit. Warm instances share the
 * map; a cold start resets it. Not a security control — just a nudge to
 * discourage scraping loops.
 */
export function rateLimit(ip: string): { ok: true } | { ok: false; retry_after_s: number } {
  const now = Date.now();
  const b = bucket.get(ip);
  if (!b || now - b.at > WINDOW_MS) {
    bucket.set(ip, { at: now, count: 1 });
    return { ok: true };
  }
  if (b.count >= MAX_REQS) {
    return { ok: false, retry_after_s: Math.ceil((WINDOW_MS - (now - b.at)) / 1000) };
  }
  b.count++;
  return { ok: true };
}

export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

/**
 * CORS + no-store cache headers. Same across every ACP GET.
 */
export function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store, max-age=0",
  };
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

/**
 * Every ACP response gets the same trailer so a viewer knows where the
 * data came from without inspecting a bunch of URLs.
 */
export function acpEnvelope<T extends object>(data: T, docs: string, extra?: object): T & object {
  return {
    ...data,
    ...(extra ?? {}),
    powered_by: "BlueAgent · 30 Blue Hub skills",
    docs,
  } as T & object;
}
