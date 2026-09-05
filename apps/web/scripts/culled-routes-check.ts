/**
 * culled-routes-check — the four 0.1-consolidation URLs must keep resolving.
 *
 * `culledRedirect()` in src/middleware.ts 301s four retired top-level surfaces
 * onto their canonical home. When that was written the original pages were left
 * in the tree as dead code, so a broken branch here would have been survivable:
 * Next would still have routed the request to a page that did its own redirect.
 *
 * That safety net is GONE. /code and /terminal lost their stubs at some
 * forgotten point, and /profile lost its page, its orphaned editor, its API
 * route and its lib on 2026-09-05 (#29). culledRedirect() is now the ONLY thing
 * standing between these URLs and a 404 — and they are published: /profile in
 * particular was linked from the /agent and /builder scorecards, which are
 * share-landing pages reached from Twitter, so the inbound links are on other
 * people's timelines and cannot be edited.
 *
 * "Every published URL must resolve" is a repo rule with a scar behind it
 * (blueagent.dev/market 404'd in production while two live senders kept mailing
 * it). This asserts the redirect rather than trusting it, in the same spirit as
 * the link-liveness check — the difference being that this one covers URLs whose
 * only definition lives in middleware, which link-liveness cannot see.
 *
 * Hermetic: drives the real exported `middleware()` with constructed
 * NextRequests. No network, no KV, no secrets. Auto-discovered by
 * scripts/run-tests.ts (opt-out discovery), so it runs in `npm test` and CI.
 */
import { NextRequest } from "next/server";
import { middleware } from "../src/middleware";

const MAIN_HOST = "blueagent.dev";
const APP_HOST = "app.blueagent.dev";
const HOSTS = [MAIN_HOST, APP_HOST];

/** Each culled prefix and the exact absolute URL it must 301 to, on EITHER host. */
const CULLED: Array<{ paths: string[]; target: string }> = [
  {
    paths: ["/code", "/code/", "/code/some/deep/path"],
    target: `https://${MAIN_HOST}/docs`,
  },
  {
    paths: ["/micro", "/micro/", "/micro/app-id"],
    target: `https://${APP_HOST}/hub`,
  },
  {
    paths: ["/terminal", "/terminal/", "/terminal/session/1"],
    target: `https://${APP_HOST}/chat`,
  },
  {
    paths: ["/profile", "/profile/", "/profile/0x02950ad38ada1d599375bd447e080cd404809205"],
    target: `https://${APP_HOST}/dashboard`,
  },
];

/*
 * Paths that merely SHARE A PREFIX with a culled route and must not be swept up.
 *
 * What makes these safe today is the trailing slash: each branch tests
 * `p === "/profile" || p.startsWith("/profile/")`, not `p.startsWith("/profile")`.
 * Dropping the slash reads like a harmless simplification and would silently
 * capture every one of these. `/profiles` is the pointed one — a builders/agents
 * directory at that name is a plausible future route, and it is exactly what the
 * old "← profiles" back-link promised before #29 re-pointed it at /hub/registry.
 */
const NEAR_MISSES = ["/profiles", "/codex", "/microphone", "/terminals"];
const CULLED_TARGETS = CULLED.map((c) => c.target);

function run(host: string, path: string) {
  return middleware(new NextRequest(`https://${host}${path}`, { headers: { host } })) as
    | { status?: number; headers?: { get(k: string): string | null } }
    | undefined;
}

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail: string) {
  if (ok) {
    passed++;
  } else {
    failures.push(`${name} — ${detail}`);
  }
}

// ─── 1. Every culled path 301s to its canonical home, on both hosts ──────────
for (const { paths, target } of CULLED) {
  for (const host of HOSTS) {
    for (const path of paths) {
      const res = run(host, path);
      const status = res?.status;
      const loc = res?.headers?.get("location") ?? null;
      check(
        `${host}${path}`,
        status === 301 && loc === target,
        `expected 301 → ${target}, got ${status ?? "(pass-through)"} → ${loc ?? "(none)"}`,
      );
    }
  }
}

// ─── 2. Prefix neighbours are NOT swallowed ──────────────────────────────────
for (const host of HOSTS) {
  for (const path of NEAR_MISSES) {
    const res = run(host, path);
    const loc = res?.headers?.get("location") ?? null;
    check(
      `${host}${path} (near-miss)`,
      loc === null || !CULLED_TARGETS.includes(loc),
      `must not be culled, but redirected to ${loc}`,
    );
  }
}

const total = passed + failures.length;
if (failures.length > 0) {
  console.log(`culled-routes-check: ${failures.length}/${total} FAILED`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  console.log(
    "\nculledRedirect() is the only thing keeping these URLs alive — the pages behind\n" +
      "them were deleted. A failure here is a live 404 on a published link.",
  );
  process.exit(1);
}

console.log(`culled-routes-check: ${total}/${total} passed`);
