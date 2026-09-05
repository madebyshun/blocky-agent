import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const APP_HOST = "app.blueagent.dev";
const MAIN_HOST = "blueagent.dev";

// Root routes that legitimately live on the app subdomain even though they're
// outside the /app/* tree: public share links generated with the app origin
// (/share from chat), public embeds (/badge), and the /waitlist gate landing
// (served on the app host so appWaitlistGate can bounce to it same-origin
// instead of 301'ing off to marketing). Everything else outside APP_SEGMENTS is
// marketing — its canonical home is the main host, so on the app subdomain it
// 301s to blueagent.dev to avoid duplicate pages (e.g. app.blueagent.dev/docs
// was duplicating blueagent.dev/docs).
//
// `pay` left this set on 2026-09-05. archivedRedirect() is the first statement
// of middleware() and 301s /pay[/…] to /chat, so this branch could never be
// reached for it — measured, not assumed. src/app/pay/ is still in the tree; if
// BlueBank's public payment surface is un-archived, drop the isPay branch there
// and add `pay` back here, in that order.
const APP_PUBLIC = new Set(["share", "badge", "waitlist"]);

// Top-level segments that belong to the in-app surface (src/app/app/*). On the
// app subdomain these are served from the internal /app/* tree while the URL
// stays clean (app.blueagent.dev/chat → renders src/app/app/chat). Everything
// else (/pay, /docs, public assets) is a real root route and is served as-is.
const APP_SEGMENTS = new Set([
  "alerts",
  "b20",
  // `bank` removed 2026-07-24 — BlueAgent Relaunch ("onchain Agent OS"
  // positioning) hides Blue Bank. Bank + /pay/[address] now hard-redirect to /chat
  // via ARCHIVED_REDIRECTS below (b20 and launches stay accessible via
  // direct URL because task #78 B20HUB is still WIP; only their nav entry
  // was removed in AppShell.tsx).
  "chat",
  "dashboard",
  // `feed` removed 2026-09-02 — Blue Feed retired. Its pages are deleted and
  // /feed + /app/feed now 301 to /chat via archivedRedirect above.
  "hood",
  "hub",
  "launches",
  // AgentOS Control pages (2026-08) — promoted from Blue Chat tabs to
  // first-class /app pages, each backed by REAL data (installed skills, the
  // connector store, the wallet's crons, the credit ledger, CREDIT_PACKS).
  // Promotion is one-way: these are NO LONGER chat tabs, so this set is their
  // only home (the chat sub-nav has no tabs at all now — see chat/types.ts).
  // `skills` is unambiguous — the marketing SOUL.md page that used to own
  // /skills moved to /soul, and /skills 301s there on the main host.
  "skills",       // installed agent-skills catalog (SkillsPanel)
  // `models` joined them 2026-09. Picking a model is still a per-conversation
  // setting (`chatTier` is in-memory ChatContext state), so the page cannot set
  // it directly — it routes a pick through /chat?preset=<id> instead.
  //
  // ⚠️ This segment collides with `public/models/*.svg` (the provider marks).
  // Both rewrite branches below must skip paths containing a dot, or every
  // mark 404s. See the guard in the off-prod branch.
  "models",       // model catalog (ModelsPanel)
  "connectors",   // MCP servers / integrations gallery (ConnectorsPanel)
  "cron",         // the wallet's scheduled tasks (CronPanel)
  "usage",        // credit balance + ledger activity (getBalance)
  "plans",        // pricing comparison → TopUpModal (CREDIT_PACKS)
  "robinhood-router",
  // `rewards` is BACK in this set as of the stake retirement. It was culled in
  // 2026-07 and 301'd to `dashboard?tab=stake`; that tab no longer exists, so the
  // redirect pointed at a query param the dashboard silently ignores. It now
  // rewrites to /app/rewards — a static tombstone naming the BlueMarketStaking
  // contract — because the one visitor this URL still has is someone holding a
  // position who needs the address, and "hide the page" must not mean "strand
  // the holder". See the main-host /rewards 301 near the bottom of this file.
  "rewards",
  // `profile` and `terminal` removed 2026-07 (0.1 route consolidation) — both
  // 301 to their canonical home via culledRedirect() below (profile →
  // dashboard, terminal → chat), so they intentionally do NOT rewrite into
  // /app/* here. Their src/app/**/{profile,terminal} page stubs are kept as
  // dead code (smaller diff, mirrors the /bank precedent).
  //
  // `wallet` SHIPPED (#291) — the "Wallet support" pillar, live (noindex) at
  // /app/wallet. It reuses the fully-built BlueBank dashboard (real wagmi
  // balances, DefiLlama yield, Moralis tx, 0x swap, limit orders, Coinbase
  // on/off-ramp) and has a nav entry in AppShell's AGENT group — it is a real
  // page now, NOT a "coming soon" placeholder.
  "wallet",
  // `signup` is the front door, and it has to be an APP SEGMENT rather than a
  // root route. On the app host every first segment that is NOT in this set 301s
  // to the marketing host (see the bottom of the isAppHost branch). A root
  // /signup would therefore throw a user from app.blueagent.dev to
  // blueagent.dev in the middle of signing in — and the Privy session is
  // per-origin, so that hop strands the session the page exists to create.
  // Its main-host twin 301s the other way, near /hub and /hood below.
  "signup",
  //
  // Reserved product URLs (0.1) — clean paths that resolve today to an
  // in-shell "coming soon" panel (src/app/app/<seg>/page.tsx, noindex) so the
  // canonical URL is stable before its provider ships:
  //   radar  → WatchlistProvider (drift/arb discovery)
  //   trade  → ExecutionProvider (guarded swap engine; absorbs robinhood-router)
  //   bridge → bridge-flow entry (shares Wallet's bridge component)
  //   tasks  → automation (DCA / TP-SL / recurring via scoped session keys)
  "radar",
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
 *
 * Blue Feed joined this list when it was retired (2026-09-02). Its pages used
 * to answer 404 while "parked for a rebuild"; the rebuild is cancelled, so the
 * parked-404 becomes a permanent 301 like every other cull. This matters more
 * than for a normal dead route: the feed published its own share links to X
 * (app.blueagent.dev/feed/<id> from the card UI, blueagent.dev/app/feed in the
 * tweet text), so those URLs are in the wild and outlive the product.
 */
function archivedRedirect(pathname: string, search: string): NextResponse | null {
  const isBank =
    pathname === "/bank" || pathname.startsWith("/bank/") ||
    pathname === "/app/bank" || pathname.startsWith("/app/bank/");
  const isPay =
    pathname === "/pay" || pathname.startsWith("/pay/");
  const isFeed =
    pathname === "/feed" || pathname.startsWith("/feed/") ||
    pathname === "/app/feed" || pathname.startsWith("/app/feed/");
  if (!isBank && !isPay && !isFeed) return null;
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
 *   /code[/…]     → marketing /docs        (the code console folded into docs)
 *   /micro[/…]    → app Hub                (micro-apps were the ancestors of Hub tools)
 *   /terminal[/…] → Blue Chat              (the browser terminal folded into /chat)
 *   /profile[/…]  → app dashboard          (self-management folded into the dashboard)
 *
 * profile used to 307 from a page-level redirect() (temporary, and a 2-hop chain
 * through /app/dashboard). Handling it here makes it a single permanent 301
 * straight to the app host — the "every cull = 301, collapse the double-hop"
 * contract of 0.1.
 *
 * /rewards LEFT this list with the stake retirement. It used to 301 to
 * `dashboard?tab=stake`, and when the Stake tab was deleted that target became a
 * lie — the dashboard drops the unknown param and shows the overview, so a
 * staker following an old link got no signal that anything had changed. It is an
 * APP_SEGMENT again now, rewriting to the /app/rewards tombstone. It must NOT be
 * handled here: culledRedirect runs on every host, so a /rewards branch pointing
 * at the app host would redirect the app host to itself, forever.
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
  if (pathname === "/profile" || pathname.startsWith("/profile/")) {
    return NextResponse.redirect(`https://${APP_HOST}/dashboard`, { status: 301 });
  }
  return null;
}

// Public product surfaces that stay open even when the waitlist gate is armed:
// Blue Chat (also the farcaster / Base-App deep-link target, homeUrl=/app/chat),
// Blue Hood (public track record), Blue Hub (builder marketplace + publish
// flow) and Wallet. Everything else in APP_SEGMENTS is the private workspace
// and is walled.
//
// `wallet` joined the list when the spend console shipped, and it is a fix, not
// an expansion: the product is named as four things — Chat / Hood / Hub /
// Wallet — while this set shipped three, so the fourth pillar 307'd to the
// waitlist for everyone including the users whose USDC it accounts for. It is
// also the surface that makes the other three legible ("what did that tool call
// actually cost me"), which is worth nothing behind a gate.
//
// Nothing here is private-by-address: /api/wallet/spend, /api/wallet/spend-
// summary and /api/credits/balance/[address] are all unauthenticated GETs
// already, so this opens a page, not a dataset. If those should be gated, they
// get gated together behind one signature check — see the header of
// lib/wallet/spend-log.ts — not by leaving the page walled and calling it
// privacy.
//
// `signup` is exempt for a narrower reason: walling it would not stop a single
// sign-in. The account control in the sidebar opens the same Privy modal from
// /chat, /hood, /hub and /wallet, all of which are already public here — so
// gating the page would only break the one honest, linkable URL for the thing
// while leaving the button beside it working. A gate that blocks the door but
// not the window is not a gate; it is a bug report waiting to happen.
const WAITLIST_EXEMPT = new Set(["chat", "hood", "hub", "wallet", "signup"]);

/**
 * BlueAgent Agent-OS waitlist gate. OFF by default — arms only when
 * `APP_WAITLIST=1`, so merging this changes nothing live until the flag is
 * flipped. When armed it walls the private in-app workspace behind /waitlist,
 * while WAITLIST_EXEMPT surfaces (Chat/Hood/Hub) and the farcaster deep-link
 * stay public. `?key=<APP_WAITLIST_TOKEN>` on any in-app path drops a 30-day
 * unlock cookie so the team + invited testers pass. (This is now the only
 * ?key-unlock gate in the file — the BlueBank one it was modelled on is gone.)
 * Only ever fires on in-app segments; static files, /api and marketing routes
 * (firstSeg not in APP_SEGMENTS) fall straight through, so /waitlist itself
 * never loops.
 */
function appWaitlistGate(request: NextRequest, firstSeg: string): NextResponse | null {
  if (process.env.APP_WAITLIST !== "1") return null; // flag off → inert
  if (!APP_SEGMENTS.has(firstSeg)) return null;      // only gate in-app segments

  const token = process.env.APP_WAITLIST_TOKEN;
  const COOKIE = "app_waitlist";

  // Valid ?key=<token> on ANY in-app path (incl. exempt ones like /chat) → drop
  // the unlock cookie, bounce to the clean URL. Checked before the exempt short-
  // circuit so the waitlist page's "Have a code?" → /chat?key=… works.
  const queryKey = request.nextUrl.searchParams.get("key");
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

  if (WAITLIST_EXEMPT.has(firstSeg)) return null; // public surfaces stay open
  const unlocked = !!token && request.cookies.get(COOKIE)?.value === token;
  if (unlocked) return null; // invited → pass

  // Not invited → the waitlist. 307 (temporary) so flipping the flag off later
  // isn't defeated by a cached permanent redirect. Same-origin URL resolves to
  // app.blueagent.dev/waitlist on prod and /waitlist on localhost/preview.
  return NextResponse.redirect(new URL("/waitlist", request.url), { status: 307 });
}

export function middleware(request: NextRequest) {
  const host = request.headers.get("host") || "";
  const { pathname } = request.nextUrl;

  // BlueAgent Relaunch: archived routes (Blue Bank + /pay) → /chat, same
  // semantic on both hosts. Runs FIRST, and the rest of this file leans on
  // that: it is what made the old BlueBank preview gate unreachable, and why
  // that gate (plus its Early Access page and the BANK_PREVIEW_TOKEN env var)
  // could be deleted outright on 2026-09-05 rather than rewired. Anything that
  // needs to see a /bank or /pay path must run ABOVE this line.
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
  const firstSeg = pathname.split("/")[1] || "";

  if (!isProdHost) {
    // Localhost + Vercel preview serve marketing AND the app from ONE origin,
    // so there's no host to key the reshuffle off. Apply the same APP_SEGMENTS
    // rewrite the app host uses, so every clean in-app URL (/chat, /skills,
    // /cron, /usage, /plans, /hood, /hub, …) resolves to its /app/* twin and a
    // reviewer verifies the exact URL that ships to prod.
    //
    // This was a hardcoded /hood + /hub exception until 2026-08, which meant
    // every OTHER clean sidebar link was broken off-prod: /cron, /usage,
    // /plans, /connectors, /dashboard 404'd (no root route), and /skills
    // silently rendered the marketing SOUL page. Driving the rewrite off the
    // same set the app host uses means the two can no longer drift — adding a
    // segment above fixes both hosts at once. /skills is unambiguous now that
    // the marketing page moved to /soul.
    //
    // API routes and framework internals fall through on their own — their
    // first segment isn't in APP_SEGMENTS. Static files under public/ do NOT:
    // this matcher covers them, and `public/models/*.svg` (the provider marks)
    // sits under the `models` app segment. So skip anything with a dot, the
    // same guard the app-host branch below already applies. Without it every
    // provider mark 404s on localhost and on every Vercel preview URL.
    //
    // Waitlist gate (env-flagged; see appWaitlistGate). Runs before the rewrite
    // so a gated segment bounces to /waitlist instead of rendering.
    const wl = appWaitlistGate(request, firstSeg);
    if (wl) return wl;

    if (APP_SEGMENTS.has(firstSeg) && !pathname.includes(".")) {
      const url = request.nextUrl.clone();
      url.pathname = `/app${pathname}`;
      return NextResponse.rewrite(url);
    }
    return NextResponse.next();
  }

  const isAppHost = host.startsWith(APP_HOST);

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

    // Waitlist gate — walls the private workspace when APP_WAITLIST=1; Chat,
    // Hood, Hub (WAITLIST_EXEMPT) stay open, as does the ?key unlock path.
    const wl = appWaitlistGate(request, firstSeg);
    if (wl) return wl;

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
    // over so the subdomain never duplicates /docs, /about, etc. (/soul lands
    // here and bounces to blueagent.dev/soul; /skills does NOT, because it's an
    // APP segment above and renders the installed-skill catalog on this host.)
    return NextResponse.redirect(
      `https://${MAIN_HOST}${pathname}${request.nextUrl.search}`,
      { status: 301 }
    );
  }

  // ── blueagent.dev (main host) ───────────────────────────────────────────────

  // /skills → /soul (2026-08 rename). The SOUL.md identity page lived at
  // /skills, but "Skills" now means the app's installed-skill catalog on the
  // app host. Renaming freed the word AND unblocked localhost/preview, where a
  // single origin can only give /skills to one of the two pages. 301 (not a
  // silent rewrite) so the old URL's SEO transfers to the canonical /soul —
  // it's the only public marketing path being renamed, and the sitemap now
  // advertises /soul only.
  if (pathname === "/skills" || pathname.startsWith("/skills/")) {
    return NextResponse.redirect(
      `https://${MAIN_HOST}${pathname.replace(/^\/skills/, "/soul")}${request.nextUrl.search}`,
      { status: 301 },
    );
  }

  // Move the in-app surface to the subdomain; keep old deep links alive via 301.
  if (pathname === "/app" || pathname.startsWith("/app/")) {
    const clean = pathname.replace(/^\/app/, "") || "/";
    return NextResponse.redirect(
      `https://${APP_HOST}${clean}${request.nextUrl.search}`,
      { status: 301 }
    );
  }

  // Public /hub[/…] → app Hub on the subdomain. Whole sub-tree (mirrors /hood
  // below): the 0.1 Hub unify makes app.blueagent.dev the canonical Hub host, so
  // every marketing /hub path 301s over (preserves query, e.g. ?tool=blue-idea).
  // The APP_SEGMENTS rewrite on the app host finishes the job into /app/hub/*.
  // Same-path hop keeps share permalinks intact — /hub/tool/<slug>,
  // /hub/builders/<addr>, /hub/registry/<handle> each have an /app/hub/* twin,
  // so no 404s.
  if (pathname === "/hub" || pathname.startsWith("/hub/")) {
    return NextResponse.redirect(
      `https://${APP_HOST}${pathname}${request.nextUrl.search}`,
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

  // /signup → the app host, where APP_SEGMENTS rewrites it into /app/signup.
  // Same shape as /hub and /hood above, and it is not optional: /signup is a URL
  // people TYPE and paste, and without this branch blueagent.dev/signup falls
  // through to `NextResponse.next()` and 404s, because the page only exists in
  // the /app tree. Exact match only — the sign-up page has no sub-paths.
  if (pathname === "/signup") {
    return NextResponse.redirect(
      `https://${APP_HOST}/signup`,
      { status: 301 },
    );
  }

  // /rewards → the app host, where APP_SEGMENTS rewrites it into the
  // /app/rewards stake tombstone. Same shape as /hub and /hood above. This
  // replaces the old culledRedirect hop to `dashboard?tab=stake`, whose target
  // stopped existing when the Stake tab was retired.
  if (pathname === "/rewards" || pathname.startsWith("/rewards/")) {
    return NextResponse.redirect(
      `https://${APP_HOST}/rewards`,
      { status: 301 },
    );
  }

  return NextResponse.next();
}

export const config = {
  matcher: "/((?!_next/static|_next/image|favicon.ico).*)",
};
