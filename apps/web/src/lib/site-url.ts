/**
 * Canonical site URL builder (pre-merge task #9).
 *
 * Every server-emitted URL that leaves the request context — chat card
 * KV rows, push notification payloads, LLM tool results — should point
 * at the SAME base domain regardless of where the request was served.
 * A preview-deployment URL like
 * `blueagent-web-bqv937qca-…vercel.app` bakes into a persisted card
 * → the card outlives the preview → link 404s.
 *
 * Precedence:
 *   1. `NEXT_PUBLIC_SITE_URL` — explicit canonical, wins everything.
 *      Set this in the Vercel prod project env (e.g. `https://blueagent.dev`).
 *   2. `VERCEL_PROJECT_PRODUCTION_URL` — Vercel injects this on the
 *      Production deployment; it's the project's canonical prod host
 *      (no protocol scheme, so we prepend `https://`).
 *   3. `` (empty) — fall back to relative paths. Correct on localhost,
 *      correct on preview when the reader hits the SAME preview host.
 *
 * `absoluteUrl(path)` returns:
 *   - `${base}${path}` when base is non-empty
 *   - `path` unchanged otherwise
 * A leading `/` on path is preserved either way.
 */

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

/**
 * Server-only. Returns `""` in the browser (client should use its own
 * origin). Kept module-scope so a warm serverless instance memoizes on
 * first call.
 */
let _cached: string | null = null;
export function siteBase(): string {
  if (typeof window !== "undefined") return ""; // browser: origin-relative
  if (_cached !== null) return _cached;

  const explicit = (process.env.NEXT_PUBLIC_SITE_URL ?? "").trim();
  if (explicit) {
    _cached = trimTrailingSlash(explicit);
    return _cached;
  }

  const vercelProd = (process.env.VERCEL_PROJECT_PRODUCTION_URL ?? "").trim();
  if (vercelProd) {
    // Vercel injects host without scheme.
    _cached = `https://${trimTrailingSlash(vercelProd)}`;
    return _cached;
  }

  _cached = "";
  return _cached;
}

/**
 * Build a URL that survives being persisted (KV, DB, push payload):
 * absolute when a canonical base is configured, relative otherwise.
 *
 * The `path` should start with `/` (e.g. `/hood/inbox#abc`). Query
 * strings and fragments are preserved verbatim.
 */
export function absoluteUrl(path: string): string {
  const base = siteBase();
  if (!base) return path;
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}
