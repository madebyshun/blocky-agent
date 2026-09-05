/**
 * Archived surfaces must stay unreachable — and near-misses must stay reachable.
 *
 * Blue Bank, its public /pay payment surface, and Blue Feed are archived: their
 * pages are still in the tree, but `archivedRedirect()` 301s every one of their
 * paths to /chat as the FIRST statement of `middleware()`. That ordering is
 * load-bearing, and as of 2026-09-05 it is the ONLY thing keeping them closed.
 *
 * Until then there was a second, inert line of defence — `bankGate`, a preview-
 * token gate that had been unreachable ever since archivedRedirect was added.
 * It was deleted precisely because it read like a working control while doing
 * nothing, which is the more dangerous of the two states. Deleting it means the
 * remaining control has to be asserted rather than assumed, so this file exists.
 *
 * Why this matters more than a normal dead route: BlueBank never shipped GA, and
 * `src/app/app/bank/BankClient.tsx` is NOT dead code — it is the live body of
 * /app/wallet (#291). So the directory cannot simply be deleted, and if a future
 * edit reorders middleware() so archivedRedirect no longer runs first, a parked
 * never-GA'd surface would quietly go live with no gate in front of it. That is
 * the exact "stopped maintaining ≠ stopped exposing" gap CLAUDE.md is about.
 *
 * The near-miss half is the other failure mode: `startsWith("/pay")` instead of
 * `=== "/pay" || startsWith("/pay/")` would silently swallow /payments, and
 * /feed would swallow /feedback. Those pass today; this pins them.
 *
 * Hermetic: no network, no KV, no secrets — middleware imports only next/server.
 */
import { NextRequest } from "next/server";
import { middleware } from "../src/middleware";

const APP_HOST = "app.blueagent.dev";
const HOSTS = ["blueagent.dev", APP_HOST];

/** Every path that must 301 to /chat, on either host. */
const ARCHIVED = [
  // Blue Bank — parked, never GA. BankClient.tsx is live under /app/wallet.
  "/bank",
  "/bank/",
  "/bank/access",
  "/bank/anything/deeper",
  "/app/bank",
  "/app/bank/access",
  // /pay — BlueBank's public payment surface. QR codes with these URLs are in
  // the wild, so this redirect is also what keeps them from 404ing.
  "/pay",
  "/pay/0x02950ad38ada1d599375bd447e080cd404809205",
  // Blue Feed — retired 2026-09-02; it published share links to X before it was.
  "/feed",
  "/feed/some-id",
  "/app/feed",
];

/**
 * Paths that merely LOOK archived and must be left alone. Each one is a real
 * regression a plausible "simplification" of archivedRedirect would introduce.
 */
const NEAR_MISSES = ["/payments", "/banking", "/feedback", "/paymaster"];

let failures = 0;
let checks = 0;

function check(label: string, ok: boolean, detail: string) {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}${ok ? "" : `\n        ${detail}`}`);
}

function run(host: string, path: string) {
  return middleware(new NextRequest(`https://${host}${path}`, { headers: { host } }));
}

console.log("Archived surfaces must 301 to /chat\n");
for (const host of HOSTS) {
  for (const path of ARCHIVED) {
    const res = run(host, path);
    const loc = res.headers.get("location") ?? "";
    check(
      `${host}${path}`,
      res.status === 301 && loc === `https://${APP_HOST}/chat`,
      `expected 301 → https://${APP_HOST}/chat, got ${res.status} ${loc || "(no redirect)"}`,
    );
  }
}

console.log("\nNear-miss paths must NOT be swallowed by the archive matcher\n");
for (const host of HOSTS) {
  for (const path of NEAR_MISSES) {
    const res = run(host, path);
    const loc = res.headers.get("location") ?? "";
    check(
      `${host}${path}`,
      loc !== `https://${APP_HOST}/chat`,
      `archivedRedirect is over-matching — ${path} was sent to /chat`,
    );
  }
}

console.log("\nThe archived surfaces are still in the tree (so this guard is not vacuous)\n");
{
  // If these ever go away the redirect becomes belt-and-braces rather than the
  // only control, which is fine — this is a note, not a requirement, so it is
  // asserted as "either present and gated, or absent". It fails only if a file
  // is present AND reachable, which the block above already covers.
  const { existsSync } = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const WEB = path.resolve(path.dirname(process.argv[1]), "..");
  for (const f of ["src/app/app/bank/page.tsx", "src/app/app/bank/BankClient.tsx", "src/app/pay"]) {
    console.log(`  ${existsSync(path.join(WEB, f)) ? "present" : "absent "}  ${f}`);
  }
}

console.log("");
if (failures > 0) {
  console.log(`${failures} of ${checks} CHECK(S) FAILED`);
  process.exit(1);
}
console.log(`ALL ${checks} CHECKS PASSED`);
