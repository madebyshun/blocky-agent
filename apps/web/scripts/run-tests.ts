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
import { readdirSync } from "node:fs";
import path from "node:path";

// Not `import.meta.dirname`: tsx loads this file as CJS, where it is undefined.
const SCRIPTS_DIR = path.dirname(path.resolve(process.argv[1]));

/** Suites excluded from `npm test`, each with the reason it cannot run hermetically. */
const NEEDS_NETWORK: Record<string, string> = {
  "pledge-ledger-test.ts": "reads real pledges over RPC + indexer; run via `npm run test:pledge`",
};

/** A hung suite must name itself rather than blow the whole job's timeout. */
const PER_SUITE_TIMEOUT_MS = 120_000;

const suites = readdirSync(SCRIPTS_DIR)
  .filter((f) => /-(test|check)\.ts$/.test(f))
  .sort();

const skipped = suites.filter((f) => f in NEEDS_NETWORK);
const toRun = suites.filter((f) => !(f in NEEDS_NETWORK));

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

for (const suite of skipped) console.log(`  SKIP  ${suite}  — ${NEEDS_NETWORK[suite]}`);

if (failed.length > 0) {
  console.log(`\n${failed.length}/${toRun.length} suites FAILED: ${failed.join(", ")}`);
  process.exit(1);
}

console.log(`\nAll ${toRun.length} suites passed.`);
