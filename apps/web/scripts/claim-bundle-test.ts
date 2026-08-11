/**
 * scripts/claim-bundle-test.ts — `npm run test:bundle:claim`
 *
 * Asserts the one property of /claim that cannot be checked by reading the
 * source: while `NEXT_PUBLIC_CLAIM_LIVE` is off, the page ships NO wallet code
 * to the browser.
 *
 * Why this needs a test at all
 * ───────────────────────────
 * The obvious implementation is wrong, and wrong in the direction that looks
 * fine. `const ClaimClient = dynamic(() => import("./ClaimClient"))` at module
 * scope, rendered behind `{CLAIM_LIVE ? … : …}`, renders exactly the right
 * thing — static text, no button — while the browser downloads the entire
 * wagmi/coinbase bundle anyway. A route's <script> tags come from
 * `app-build-manifest.json`, which is built from the STATIC module graph, so a
 * `dynamic()` call webpack can still see drags every chunk it reaches into the
 * manifest regardless of whether the branch ever renders. Measured on the
 * commit before the fix: /claim shipped 278 kB First Load JS against /pledge's
 * 135 kB, and the served HTML referenced a 101 kB connector chunk.
 *
 * Nothing about that is visible in review, in `tsc`, or on the rendered page.
 * The only signal is the build output, so that is what this reads.
 *
 * The fix it guards is in `src/app/claim/page.tsx`: the env comparison is
 * written literally so webpack constant-folds it and deletes the `import()`
 * with the dead branch. A future refactor that "tidies" that literal into the
 * shared config constant reintroduces the bug silently — with the flag still
 * correctly off and the page still looking correct. Hence a test.
 *
 * This reads real build artifacts, so it needs a build first:
 *
 *     npm run verify:build && npm run test:bundle:claim
 *
 * It refuses to run against a missing or stale build rather than passing
 * vacuously, because a guard that green-lights on an absent artifact is worse
 * than no guard.
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, "..");

let pass = 0;
let fail = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`);
  }
}

function die(msg: string): never {
  console.log(`\nFAIL — ${msg}\n`);
  process.exit(1);
}

/* ── The build under inspection ──────────────────────────────────────────── */

// `verify:build` writes here; a plain `next build` writes to `.next`. Prefer
// the former because repo policy is that `.next` belongs to the dev server.
const DIST = [".next-verify", ".next"].map((d) => join(WEB, d)).find((d) => existsSync(join(d, "app-build-manifest.json")));

if (!DIST) {
  die(
    "no build to inspect — run `npm run verify:build` first.\n" +
      "       (This test asserts what the browser downloads, which only exists after a build.)",
  );
}

const MANIFEST = join(DIST, "app-build-manifest.json");

if (process.env.NEXT_PUBLIC_CLAIM_LIVE === "true") {
  die(
    "NEXT_PUBLIC_CLAIM_LIVE is \"true\" in this shell.\n" +
      "       This test asserts the FLAG-OFF build. Unset it, rebuild, and re-run.",
  );
}

// A stale build is the failure mode that makes this guard lie: it would pass
// against yesterday's artifacts while today's source reintroduces the bug.
const builtAt = statSync(MANIFEST).mtimeMs;
const sources = [
  "src/app/claim/ClaimGate.tsx", // the gate itself — the file this test exists for
  "src/app/claim/page.tsx",
  "src/app/claim/ClaimClient.tsx",
  "src/lib/claim/config.ts",
].map((p) => join(WEB, p));

const newer = sources.filter((p) => existsSync(p) && statSync(p).mtimeMs > builtAt);
if (newer.length) {
  die(
    `the build is older than ${newer.map((p) => p.replace(WEB + "/", "")).join(", ")}.\n` +
      "       Re-run `npm run verify:build` — this test is only meaningful against the current source.",
  );
}

console.log(`\nInspecting ${DIST.replace(WEB + "/", "")} (built ${new Date(builtAt).toISOString()})`);

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as { pages: Record<string, string[]> };

/* ── Fingerprints ────────────────────────────────────────────────────────── */

/**
 * Strings that only appear if a wallet CONNECTOR was bundled.
 *
 * Deliberately not the bare token "wagmi": a shared chunk carrying that string
 * is on every route including /pledge, which has no wallet UI at all, so it
 * would fail on a page that is behaving perfectly. These three are the
 * connector list itself — coinbase, walletconnect, and the EIP-6963 injected
 * provider discovery — which reach a route only via `ConnectButton`.
 */
const WALLET_CODE: Array<[string, RegExp]> = [
  ["coinbaseWallet", /coinbaseWallet/],
  ["WalletConnect", /WalletConnect/i],
  ["EIP-6963 discovery", /eip6963|EIP-6963/],
];

/** Strings unique to ClaimClient — present only if the module itself shipped. */
const CLAIM_UI: Array<[string, string]> = [
  ["the not-found message", "No allocation for this wallet"],
  ["the claimed state", "Claimed ✓"],
  ["the AlreadyClaimed revert copy", "already been claimed"],
];

const chunksFor = (route: string): string[] => manifest.pages[route] ?? [];

function readChunk(rel: string): string | null {
  const p = join(DIST!, rel);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

function scan(route: string) {
  const offenders: Array<{ chunk: string; found: string }> = [];
  let bytes = 0;
  for (const c of chunksFor(route)) {
    const src = readChunk(c);
    if (src === null) continue;
    bytes += src.length;
    for (const [label, re] of WALLET_CODE) if (re.test(src)) offenders.push({ chunk: c, found: label });
    for (const [label, s] of CLAIM_UI) if (src.includes(s)) offenders.push({ chunk: c, found: label });
  }
  return { offenders, bytes, count: chunksFor(route).length };
}

/* ── 1. The module graph ─────────────────────────────────────────────────── */

console.log("\n1. MODULE GRAPH — what the route's manifest pulls in");

check("/claim/page exists in the build manifest", () => {
  if (!manifest.pages["/claim/page"]) throw new Error("route missing — did the page fail to build?");
});

const claim = scan("/claim/page");
const pledge = scan("/pledge/page");

check("no wallet connector code in any chunk /claim loads", () => {
  const w = claim.offenders.filter((o) => WALLET_CODE.some(([l]) => l === o.found));
  if (w.length) {
    throw new Error(
      `${w.length} hit(s) — the gated-off page ships the wallet bundle:\n` +
        w.map((o) => `        ${o.found} in ${o.chunk}`).join("\n") +
        "\n        Cause is almost certainly that page.tsx stopped comparing" +
        "\n        process.env.NEXT_PUBLIC_CLAIM_LIVE literally, so the import() survived.",
    );
  }
});

check("ClaimClient's own UI strings are absent", () => {
  const u = claim.offenders.filter((o) => CLAIM_UI.some(([l]) => l === o.found));
  if (u.length)
    throw new Error(
      `ClaimClient shipped:\n` + u.map((o) => `        ${o.found} in ${o.chunk}`).join("\n"),
    );
});

check("/claim weighs about the same as /pledge, not double", () => {
  const cKb = Math.round(claim.bytes / 1024);
  const pKb = Math.round(pledge.bytes / 1024);
  console.log(`      /claim  ${claim.count} chunks, ${cKb} kB`);
  console.log(`      /pledge ${pledge.count} chunks, ${pKb} kB`);
  // /pledge is the reference: same shell, same navbar, no wallet. A 1.25x
  // ceiling catches a re-added connector bundle (which was +100%) while
  // leaving room for /claim's own markup.
  if (cKb > pKb * 1.25)
    throw new Error(`/claim is ${(cKb / pKb).toFixed(2)}x /pledge (${cKb} kB vs ${pKb} kB) — something large came back`);
});

/* ── 2. The delivered HTML ───────────────────────────────────────────────── */

/*
 * The manifest is the mechanism; this is the outcome. Next prerenders both
 * routes to static HTML, and those files' <script> tags are literally what a
 * browser fetches — so this answers "did a user download wallet code" with no
 * inference about how the module graph was built.
 *
 * It is a COMPARISON against /pledge rather than an absolute check, and that is
 * not a weakened assertion — it is the only correct one. The root layout wraps
 * the whole site in the wagmi providers, so /pledge, /about and every other
 * page already serve the connector chunks. Asserting "/claim serves no wallet
 * code" would fail on a perfectly gated page and could only be satisfied by
 * moving the providers out of the root layout — a site-wide change, out of
 * scope here. What /claim must not do is add anything on top of that floor.
 *
 * (That floor is worth revisiting on its own: it is ~100 kB of connector code
 * on every page of the site, including ones with no wallet UI at all.)
 */
console.log("\n2. DELIVERED HTML — what a browser actually fetches");

const HTML = join(DIST, "server/app/claim.html");
const PLEDGE_HTML = join(DIST, "server/app/pledge.html");

check("the page prerendered to static HTML", () => {
  if (!existsSync(HTML)) throw new Error(`${HTML.replace(WEB + "/", "")} missing — /claim is no longer static`);
  if (!existsSync(PLEDGE_HTML)) throw new Error("pledge.html missing — no baseline to compare against");
});

const html = existsSync(HTML) ? readFileSync(HTML, "utf8") : "";

check("the static gated-off copy is the copy that ships", () => {
  if (!html.includes("Claiming is not open"))
    throw new Error("the flag-off notice is not in the prerendered HTML — is this a flag-ON build?");
  if (!html.includes("no wallet connection on this page yet"))
    throw new Error("the anti-scam 'no wallet connection yet' line is missing from the shipped HTML");
});

/** Chunk paths a prerendered page references, that carry connector code. */
function walletChunksIn(htmlPath: string): Set<string> {
  const src = existsSync(htmlPath) ? readFileSync(htmlPath, "utf8") : "";
  // Chunk names are content-hashed and change every build, so match the shape.
  const refs = new Set([...src.matchAll(/static\/chunks\/[\w./-]+\.js/g)].map((m) => m[0]));
  const out = new Set<string>();
  for (const rel of refs) {
    const js = readChunk(rel);
    if (js !== null && WALLET_CODE.some(([, re]) => re.test(js))) out.add(rel);
  }
  return out;
}

check("/claim serves no wallet chunk that /pledge does not already serve", () => {
  const onClaim = walletChunksIn(HTML);
  const onPledge = walletChunksIn(PLEDGE_HTML);
  const extra = [...onClaim].filter((c) => !onPledge.has(c));
  console.log(`      site-wide floor (also on /pledge): ${onPledge.size} wallet-carrying chunk(s)`);
  if (extra.length)
    throw new Error(
      `${extra.length} wallet chunk(s) served ONLY on the gated-off claim page:\n` +
        extra.map((c) => `        ${c}`).join("\n"),
    );
});

check("no chunk unique to /claim contains ClaimClient", () => {
  const claimRefs = new Set([...html.matchAll(/static\/chunks\/[\w./-]+\.js/g)].map((m) => m[0]));
  const bad: string[] = [];
  for (const rel of claimRefs) {
    const js = readChunk(rel);
    if (js === null) continue;
    for (const [label, s] of CLAIM_UI) if (js.includes(s)) bad.push(`${label} in ${rel}`);
  }
  if (bad.length) throw new Error(`ClaimClient is served:\n` + bad.map((b) => `        ${b}`).join("\n"));
  if (claimRefs.size === 0) throw new Error("no chunks referenced at all — the HTML looks wrong, not clean");
});

check("no wallet UI strings in the HTML itself", () => {
  for (const probe of ["Connect Wallet", "Select Wallet", "Claim my $NEW"])
    if (html.includes(probe)) throw new Error(`"${probe}" is rendered on the gated-off page`);
});

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
