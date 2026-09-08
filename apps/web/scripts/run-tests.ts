/**
 * Suite runner for `npm test`.
 *
 * Discovery is opt-OUT, not opt-in. Every `scripts/*-test.ts` and `scripts/*-check.ts`
 * runs unless it is listed in NEEDS_NETWORK below. This is deliberate: 12 of the 20
 * suites in this directory had been written and then never wired to any npm script,
 * so they had never once run automatically. A hardcoded include-list would let the
 * next suite fall into the same hole; with opt-out, forgetting to wire a suite is
 * impossible and excluding one is a visible line in the diff.
 *
 * Suites here must be hermetic — no network, no KV, no secrets — because CI runs
 * them with an empty environment. Anything that talks to prod belongs in
 * rh-rwa-semantic-smoke.yml, which runs on a schedule against the live site.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, existsSync } from "node:fs";
import path from "node:path";

// Not `import.meta.dirname`: tsx loads this file as CJS, where it is undefined.
const SCRIPTS_DIR = path.dirname(path.resolve(process.argv[1]));
const WEB = path.resolve(SCRIPTS_DIR, "..");

/** Suites excluded from `npm test`, each with the reason it cannot run hermetically. */
const NEEDS_NETWORK: Record<string, string> = {
  "pledge-ledger-test.ts": "reads real pledges over RPC + indexer; run via `npm run test:pledge`",
  "workspace-sync-test.ts": "drives the HTTP surface end-to-end; needs `npm run dev` on :3000, run via `npm run test:workspace-sync`",
  // ~62 live DexScreener/GeckoTerminal calls at rate-limit spacing (>4 min, well
  // past PER_SUITE_TIMEOUT_MS). It cannot be made hermetic without destroying its
  // point: it asks the provider what pool production picked TODAY, and a fixture
  // would only certify a snapshot. Nor should it gate CI — the script itself
  // scores a 429 as `unverified` rather than a pass precisely because a throttled
  // run proves nothing, so a green CI here would be the least trustworthy green
  // in the repo.
  "dex-anchor-check.ts": "makes ~62 live DEX provider calls at rate-limit spacing; run via `npm run dex:anchor`",
};

/*
 * Suites that inspect BUILD ARTIFACTS rather than source.
 *
 * These are perfectly hermetic — no network, no KV — but they read the output of
 * `next build`, and CI deliberately does not produce one (see ci.yml: the Vercel
 * preview already builds every PR, so CI does not pay ~4min for a second copy of
 * the same answer). A build-reading suite therefore exits 1 in CI for a reason
 * that says nothing about the code.
 *
 * So the skip is CONDITIONAL, not permanent: with a build present the suite runs
 * normally, without one it is skipped by name. A permanent entry in
 * NEEDS_NETWORK would have been the easy fix and the wrong one — it would mean
 * `npm test` never exercises it again on any machine, which is precisely how a
 * guard stops guarding while still appearing in the directory listing.
 *
 * Found 2026-09-05: `claim-bundle-test.ts` was written on a branch that had no
 * CI workflow, so this combination had never once been executed.
 */
const NEEDS_BUILD: Record<string, string> = {
  "claim-bundle-test.ts": "reads `next build` output; run `npm run verify:build` first, then `npm test`",
};

const HAS_BUILD = [".next-verify", ".next"].some((d) => existsSync(path.join(WEB, d, "app-build-manifest.json")));

/** A hung suite must name itself rather than blow the whole job's timeout. */
const PER_SUITE_TIMEOUT_MS = 120_000;

const suites = readdirSync(SCRIPTS_DIR)
  .filter((f) => /-(test|check)\.ts$/.test(f))
  .sort();

/** Why a suite is being skipped, or null if it should run. */
function skipReason(f: string): string | null {
  if (f in NEEDS_NETWORK) return NEEDS_NETWORK[f];
  if (f in NEEDS_BUILD && !HAS_BUILD) return NEEDS_BUILD[f];
  return null;
}

const skipped = suites.filter((f) => skipReason(f) !== null);
const toRun = suites.filter((f) => skipReason(f) === null);

console.log(`Running ${toRun.length} hermetic suites (${skipped.length} skipped)\n`);

const failed: string[] = [];

for (const suite of toRun) {
  const started = Date.now();
  const res = spawnSync("npx", ["tsx", path.join(SCRIPTS_DIR, suite)], {
    encoding: "utf8",
    stdio: "pipe",
    timeout: PER_SUITE_TIMEOUT_MS,
  });
  const secs = ((Date.now() - started) / 1000).toFixed(1);

  if (res.error && (res.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
    failed.push(suite);
    console.log(`  HUNG  ${suite}  (killed after ${secs}s — hermetic suites must not block)`);
  } else if (res.status === 0) {
    console.log(`  PASS  ${suite}  (${secs}s)`);
  } else {
    failed.push(suite);
    console.log(`  FAIL  ${suite}  (${secs}s, exit ${res.status})`);
    const output = `${res.stdout ?? ""}${res.stderr ?? ""}`.trimEnd();
    for (const line of output.split("\n").slice(-25)) console.log(`        ${line}`);
  }
}

for (const suite of skipped) console.log(`  SKIP  ${suite}  — ${skipReason(suite)}`);

if (failed.length > 0) {
  console.log(`\n${failed.length}/${toRun.length} suites FAILED: ${failed.join(", ")}`);
  process.exit(1);
}

console.log(`\nAll ${toRun.length} suites passed.`);
