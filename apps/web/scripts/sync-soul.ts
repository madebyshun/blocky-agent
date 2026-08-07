/**
 * sync-soul — regenerate the repo-root SOUL.md from src/lib/soul.ts.
 *
 * SOUL.md is a published artifact: /soul links people at the raw GitHub URL and
 * invites them to fork it, so it has to be a real file, not a pointer. But it
 * used to be hand-maintained alongside a second hand-maintained copy on the
 * /soul page, and the two drifted — the file kept listing surfaces that had been
 * deleted months earlier.
 *
 * src/lib/soul.ts is now the source of truth (it's what /api/chat actually
 * injects). This writes it out. Run after editing soul.ts:
 *
 *   npm run sync:soul
 *
 * `--check` exits non-zero if the root file is stale instead of writing, so CI
 * or a pre-commit hook can catch a soul.ts edit that forgot to sync.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { SOUL_MD } from "../src/lib/soul";

// scripts/ → apps/web → apps → repo root
const TARGET = resolve(__dirname, "../../../SOUL.md");
const check = process.argv.includes("--check");

const current = (() => {
  try { return readFileSync(TARGET, "utf8"); } catch { return null; }
})();

if (current === SOUL_MD) {
  console.log("SOUL.md is in sync.");
  process.exit(0);
}

if (check) {
  console.error(
    "SOUL.md is out of sync with apps/web/src/lib/soul.ts — run `npm run sync:soul`.",
  );
  process.exit(1);
}

writeFileSync(TARGET, SOUL_MD, "utf8");
console.log(`Wrote ${TARGET} (${SOUL_MD.length} bytes).`);
