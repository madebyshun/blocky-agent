import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const APP_HOST = "app.blueagent.dev";
const MAIN_HOST = "blueagent.dev";

// Root routes that legitimately live on the app subdomain even though they're
// outside the /app/* tree: public links generated with the app origin
// (/pay from BlueBank, /share from chat) and public embeds (/badge). Everything
// else outside APP_SEGMENTS is marketing — its canonical home is the main host,
// so on the app subdomain it 301s to blueagent.dev to avoid duplicate pages
// (e.g. app.blueagent.dev/docs was duplicating blueagent.dev/docs).
const APP_PUBLIC = new Set(["pay", "share", "badge"]);

// Top-level segments that belong to the in-app surface (src/app/app/*). On the
// app subdomain these are served from the internal /app/* tree while the URL
// stays clean (app.blueagent.dev/chat → renders src/app/app/chat). Everything
// else (/pay, /docs, public assets) is a real root route and is served as-is.
const APP_SEGMENTS = new Set([
  "alerts",
  "b20",
  // `bank` removed 2026-07-24 — BlueAgent Relaunch "Builder OS for Robinhood
  // Chain" hides Blue Bank. Bank + /pay/[address] now hard-redirect to /chat
  // via ARCHIVED_REDIRECTS below (b20 and launches stay accessible via
  // direct URL because task #78 B20HUB is still WIP; only their nav entry
  // was removed in AppShell.tsx).
  "chat",
  "dashboard",
  "feed",
  "hood",
  "hub",
  "launches",
  "profile",
  "rewards",
  "robinhood-router",
  // `terminal` removed 2026-07 (0.1 route consolidation) — the browser
  // terminal collapsed into Blue Chat. /terminal[/…] now 301s to /chat via
  // culledRedirect() below; the src/app/**/terminal files are kept as dead
  // code (smaller diff, mirrors the /bank precedent).
  //
  // Reserved product URLs (0.1) — clean paths that resolve today to an
  // in-shell "coming soon" panel (src/app/app/<seg>/page.tsx, noindex) so the
  // canonical URL is stable before its provider ships:
  //   radar  → WatchlistProvider (drift/arb discovery)
  //   wallet → WalletProvider (balances, $BLUE tier)
  //   trade  → ExecutionProvider (guarded swap engine; absorbs robinhood-router)
  //   bridge → bridge-flow entry (shares Wallet's bridge component)
  //   tasks  → automation (DCA / TP-SL / recurring via scoped session keys)
  "radar",
  "wallet",
  "trade",
  "bridge",
  "tasks",
]);

/**
 * BlueAgent Relaunch archived routes. On EITHER host these 301 to the app
 * home so:
 *   - Sidebar nav entry stays consistent with the redirect (no way to arrive
 *     at Bank UI accidentally).
 *   - Any external share link (/pay/<address> QR codes generated earlier)
 *     lands the visitor at Blue Chat instead of a 404.
 * Runs BEFORE host-specific rewrites so the semantic is identical on
 * blueagent.dev and app.blueagent.dev.
 */
function archivedRedirect(pathname: string, search: string): NextResponse | null {
  const isBank =
    pathname === "/bank" || pathname.startsWith("/bank/") ||
    pathname === "/app/bank" || pathname.startsWith("/app/bank/");
  const isPay =
    pathname === "/pay" || pathname.startsWith("/pay/");
  if (!isBank && !isPay) return null;
  return NextResponse.redirect(
    `https://${APP_HOST}/chat${search}`,
    { status: 301 },
  );
}

/**
 * BlueAgent Relaunch route consolidation (0.1). Dead top-level surfaces that
 * now live inside a canonical product tab. 301 on EITHER host (runs before the
 * host reshuffle, like archivedRedirect) so the redirect is identical on
 * blueagent.dev and app.blueagent.dev — and so external / legacy deep links
 * never 404 (the non-negotiable of 0.1). Files are kept as dead code rather
 * than deleted (smaller diff, mirrors the /bank precedent); only routing is cut.
 *   /code[/…]     → marketing /docs   (the code console folded into docs)
 *   /micro[/…]    → app Hub           (micro-apps were the ancestors of Hub tools)
 *   /terminal[/…] → Blue Chat         (the browser terminal folded into /chat)
 */
function culledRedirect(pathname: string): NextResponse | null {
  if (pathname === "/code" || pathname.startsWith("/code/")) {
    return NextResponse.redirect(`https://${MAIN_HOST}/docs`, { status: 301 });
  }
  if (pathname === "/micro" || pathname.startsWith("/micro/")) {
    return NextResponse.redirect(`https://${APP_HOST}/hub`, { status: 301 });
  }
  if (pathname === "/terminal" || pathname.startsWith("/terminal/")) {
    return NextResponse.redirect(`https://${APP_HOST}/chat`, { status: 301 });
  }
  return null;
}

// BlueBank private preview gate. BlueBank and its public /pay payment surface
// aren't GA yet — on production they stay blocked EXCEPT for someone holding the
// preview token (?key=<BANK_PREVIEW_TOKEN> sets an unlock cookie). `accessUrl`
// is host-aware so we bounce to the right (clean vs /app) Early Access page.
// NOTE: this gate lives in middleware, not next.config redirects, because config
// redirects run BEFORE middleware and can't be conditionally bypassed.
function bankGate(
  request: NextRequest,
  isBankSurface: boolean,
  accessUrl: string,
): NextResponse | null {
  if (!isBankSurface || process.env.NODE_ENV !== "production") return null;
  const token = process.env.BANK_PREVIEW_TOKEN;
  const COOKIE = "bank_preview";
  const unlocked = !!token && request.cookies.get(COOKIE)?.value === token;
  const queryKey = request.nextUrl.searchParams.get("key");

  // Valid ?key=<token> → drop the unlock cookie, bounce to the clean URL.
  if (token && queryKey && queryKey === token) {
    const clean = request.nextUrl.clone();
    clean.searchParams.delete("key");
    const res = NextResponse.redirect(clean);
    res.cookies.set(COOKIE, token, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 30, // 30 days
    });
    return res;
  }
  // No valid cookie (or token not configured) → show Early Access page.
  if (!unlocked) {
    return NextResponse.redirect(new URL(accessUrl, request.url));
  }
  // Unlocked — fall through to the app.
  return null;
}

export function middleware(request: NextRequest) {
  const host = request.headers.get("host") || "";
  const { pathname } = request.nextUrl;

  // BlueAgent Relaunch: archived routes (Blue Bank + /pay) → /chat, same
  // semantic on both hosts. Runs first so bankGate (below) is dead code —
  // kept for now to avoid a bigger diff, will remove in the About/Docs
  // follow-up PR.
  const archived = archivedRedirect(pathname, request.nextUrl.search);
  if (archived) return archived;

  // BlueAgent Relaunch 0.1: culled top-level routes (/code, /micro, /terminal)
  // → their canonical tab, same semantic on both hosts. Runs early so it beats
  // the host reshuffle and the non-prod passthrough below.
  const culled = culledRedirect(pathname);
  if (culled) return culled;

  // Redirect docs subdomain → Mintlify
  if (host.startsWith("docs.blueagent.dev")) {
    const url = request.nextUrl.clone();
    const path = url.pathname + url.search;
    return NextResponse.redirect(
      `https://mbs-001decf1.mintlify.app${path}`,
      { status: 301 }
    );
  }

  // The main↔app host reshuffle below only makes sense on the real production
  // hosts. Vercel preview URLs (*.vercel.app), localhost, and any other host
  // must serve /app/* as-is — otherwise a preview URL like
  // blueagent-web-new-git-dev-*.vercel.app/app/robinhood-router bounces off to
  // app.blueagent.dev (prod) which doesn't have the branch's code and 404s.
  const isProdHost = host === MAIN_HOST || host === APP_HOST;
  if (!isProdHost) {
    // Exception: Blue Hood's /hood + /hood/arrows share URLs need to work on
    // localhost + preview so the reviewer can verify the same URL that ships
    // to prod. Same rewrite rule as `app.blueagent.dev` — see APP_SEGMENTS
    // block below. Everything else on non-prod hosts still passes through.
    if (pathname === "/hood" || pathname.startsWith("/hood/")) {
      const url = request.nextUrl.clone();
      url.pathname = `/app${pathname}`;
      return NextResponse.rewrite(url);
    }
    return NextResponse.next();
  }

  const isAppHost = host.startsWith(APP_HOST);
  const firstSeg = pathname.split("/")[1] || "";

  // ── app.blueagent.dev ──────────────────────────────────────────────────────
  // Serve the in-app surface from a clean, /app-less URL on the subdomain.
  if (isAppHost) {
    // API + framework internals + static files (anything with a dot) pass through.
    if (
      pathname.startsWith("/api") ||
      pathname.startsWith("/_next") ||
      pathname.includes(".")
    ) {
      return NextResponse.next();
    }

    // Legacy /app/* links → strip the prefix so the canonical URL stays clean.
    if (pathname === "/app" || pathname.startsWith("/app/")) {
      const clean = request.nextUrl.clone();
      clean.pathname = pathname.replace(/^\/app/, "") || "/";
      return NextResponse.redirect(clean, { status: 301 });
    }

    // BlueBank preview gate (clean URL /bank == internal /app/bank).
    const isBankSurface =
      ((pathname === "/bank" || pathname.startsWith("/bank/")) &&
        pathname !== "/bank/access") ||
      pathname === "/pay" ||
      pathname.startsWith("/pay/");
    const gate = bankGate(request, isBankSurface, "/bank/access");
    if (gate) return gate;

    // Root of the app host → Blue Chat (product home). Rewrite straight to
    // /app/chat so the URL stays "/" with no redirect hop through /app.
    if (pathname === "/") {
      const url = request.nextUrl.clone();
      url.pathname = "/app/chat";
      return NextResponse.rewrite(url);
    }

    // Known app segment → render from the internal /app/* tree (URL stays clean).
    if (APP_SEGMENTS.has(firstSeg)) {
      const url = request.nextUrl.clone();
      url.pathname = `/app${pathname}`;
      return NextResponse.rewrite(url);
    }

    // Public app-origin routes (/pay, /share, /badge) genuinely live here — serve as-is.
    if (APP_PUBLIC.has(firstSeg)) {
      return NextResponse.next();
    }

    // Everything else is marketing — its canonical home is the main host. 301 it
    // over so the subdomain never duplicates /docs, /about, /skills, etc.
    return NextResponse.redirect(
      `https://${MAIN_HOST}${pathname}${request.nextUrl.search}`,
      { status: 301 }
    );
  }

  // ── blueagent.dev (main host) ───────────────────────────────────────────────
  // Move the in-app surface to the subdomain; keep old deep links alive via 301.
  if (pathname === "/app" || pathname.startsWith("/app/")) {
    const clean = pathname.replace(/^\/app/, "") || "/";
    return NextResponse.redirect(
      `https://${APP_HOST}${clean}${request.nextUrl.search}`,
      { status: 301 }
    );
  }

  // Public /hub → app Hub on the subdomain (preserve query, e.g. ?tool=blue-idea).
  if (pathname === "/hub" || pathname === "/hub/") {
    return NextResponse.redirect(
      `https://${APP_HOST}/hub${request.nextUrl.search}`,
      { status: 301 }
    );
  }

  // Blue Hood public share URLs — main host redirects EVERY /hood[/…] path
  // to the app subdomain. Unlike /hub above (exact match only), Blue Hood
  // has share-able sub-paths like /hood/arrows, /hood/arrows/<serial>, so
  // we honor the whole sub-tree. The app-host rewrite in APP_SEGMENTS
  // above finishes the job.
  if (pathname === "/hood" || pathname.startsWith("/hood/")) {
    return NextResponse.redirect(
      `https://${APP_HOST}${pathname}${request.nextUrl.search}`,
      { status: 301 },
    );
  }

  // BlueBank public /pay gate stays on the main host too (defensive).
  const isBankSurface = pathname === "/pay" || pathname.startsWith("/pay/");
  const gate = bankGate(request, isBankSurface, "/app/bank/access");
  if (gate) return gate;

  return NextResponse.next();
}

export const config = {
  matcher: "/((?!_next/static|_next/image|favicon.ico).*)",
};
