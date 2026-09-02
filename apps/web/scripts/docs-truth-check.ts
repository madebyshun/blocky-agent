/**
 * Docs truth — the numbers we publish are the numbers we measure.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every tool count on a public surface was hand-typed and then left behind.
 * At the time this was written the repo simultaneously told the world it had
 * 30+, 34, 69, 74 and 112 tools — README, llms.txt, plugin.md and the two
 * farcaster manifests each froze whatever the total happened to be the day
 * someone touched them. The real number is `TOOL_COUNT`, and it moves every
 * time a tool ships.
 *
 * Server-rendered TS can just interpolate `${TOOL_COUNT}`, and the route in
 * group 3 does. Static files cannot — a .md, .txt or .json served straight
 * off disk has no way to read a TypeScript constant. So they get the next
 * best thing: the number is written once and pinned here, which turns an
 * unowned literal into one CI compares against the source of truth.
 *
 * WHAT IT CHECKS
 * --------------
 * 1. Pinned sentences — each must appear VERBATIM, with the count (and the
 *    category list) built from the live catalog. Exact-match, because a
 *    reworded sentence should fail loudly rather than silently stop being
 *    covered.
 * 2. Scanner — anything shaped like "<n> … tools" must still be true. A bare
 *    "112 tools" must equal TOOL_COUNT; a floor claim like "100+ tools" only
 *    has to stay <= TOOL_COUNT, which is what makes it a cheap honest option
 *    for a page that should not import the catalog at all (see group 3).
 *    This is the net for claims added later that group 1 does not know about.
 *    It is deliberately narrow — only word characters, spaces and hyphens may
 *    sit between the digits and "tools" — so chain ids like "Robinhood Chain
 *    (4663) — the `rh-*` tools" are not misread as counts.
 * 3. Where the number may be derived, and where deriving it costs too much.
 *    `agent-tools.ts` is the whole 112-entry catalog; importing it into a
 *    "use client" tree pulls all of it into that page's bundle. Measured on
 *    this branch: doing so added 16 kB gzipped to First Load on BOTH
 *    /waitlist (106 → 122 kB) and /app/dashboard (527 → 543 kB), to render
 *    one decorative number. So the server route derives, and the two client
 *    pages are held to a floor claim or no claim at all.
 * 4. The Blue Hood cron table is pinned to vercel.json. Three of its
 *    schedules had drifted from the deployed value and two jobs were missing
 *    from the table entirely, so the doc described a cadence nothing ran at.
 * 5. The retired "3-agent consensus" claim stays retired.
 *
 * NOT EVERY COUNT IN THE REPO IS TOOL_COUNT, and this check deliberately does
 * not sweep for them. The MCP surface is a curated subset (57), the skill
 * bundle ships a different set, and the on-chain ToolRegistry holds more than
 * this catalog. A blanket sync-everything-to-112 would replace stale numbers
 * with wrong ones. Hence a whitelist.
 *
 * Run: npx tsx scripts/docs-truth-check.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_TOOLS, TOOL_COUNT } from "../src/lib/agent-tools";

const WEB = join(__dirname, "..");
const REPO = join(__dirname, "..", "..", ".."); // scripts → web → apps → repo root
const read = (p: string) => readFileSync(join(WEB, p), "utf8");
const readRepo = (p: string) => readFileSync(join(REPO, p), "utf8");

let failures = 0;
/** Counted, never hardcoded — a hand-maintained total goes stale the first
 *  time someone adds a check and forgets to bump it. */
let checks = 0;

function check(name: string, cond: boolean, detail = "") {
  checks++;
  if (cond) {
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// Order matters: the README prints the categories as a list, so this pins the
// names and their order too, not merely how many there are.
const CATEGORIES = [...new Set(AGENT_TOOLS.map((t) => t.category))];

const README = readRepo("README.md");
const LLMS = read("public/llms.txt");
const PLUGIN = read("public/plugin.md");
const FARCASTER_STATIC = read("public/.well-known/farcaster.json");
const WAITLIST = read("src/app/waitlist/page.tsx");
const OVERVIEW = read("src/app/app/dashboard/_views/OverviewView.tsx");
const FARCASTER_ROUTE = read("src/app/.well-known/farcaster.json/route.ts");

// ── 1. the pinned sentences ───────────────────────────────────────────────
console.log(`\n1. published counts equal TOOL_COUNT (${TOOL_COUNT})`);
const pinned: [string, string, string][] = [
  ["README heading", README, `## Blue Hub — ${TOOL_COUNT} AI Tools on Base`],
  ["README lead", README, `marketplace of ${TOOL_COUNT} pay-per-call AI tools`],
  [
    "README category line",
    README,
    `**${TOOL_COUNT} tools across ${CATEGORIES.length} categories** — ${CATEGORIES.join(" · ")}`,
  ],
  ["README chat section", README, `all ${TOOL_COUNT} Hub tools`],
  ["README cli example", README, `# list all ${TOOL_COUNT} tools`],
  ["llms.txt", LLMS, `Blue Hub exposes ${TOOL_COUNT} paid tools.`],
  ["plugin.md", PLUGIN, `${TOOL_COUNT} AI tools for Base builders`],
  ["farcaster.json (static copy)", FARCASTER_STATIC, `"${TOOL_COUNT} AI tools.`],
];
for (const [name, haystack, needle] of pinned) {
  check(name, haystack.includes(needle), `expected "${needle}"`);
}
check(
  "README names the script that pins it",
  README.includes("apps/web/scripts/docs-truth-check.ts"),
  "a reader who edits the number needs to know what will stop them",
);

// ── 2. the scanner, for claims added after this whitelist ─────────────────
console.log("\n2. every '<n> … tools' claim is still true");
// Negative lookbehind/lookahead on a dot keeps version strings ("0.1.0") out.
const COUNT_RE = /(?<![\d.])(\d+)(\+?)(?![\d.])(?=[\w -]{0,24}?\btools\b)/gi;
/** "112 tools" must be exact. "100+ tools" is a floor — true while we have at
 *  least that many, which is the point of writing it that way. */
const claimHolds = (n: number, plus: boolean) => (plus ? TOOL_COUNT >= n : TOOL_COUNT === n);

const scanned: [string, string][] = [
  ["README.md", README],
  ["public/llms.txt", LLMS],
  ["public/plugin.md", PLUGIN],
  ["public/.well-known/farcaster.json", FARCASTER_STATIC],
  ["src/app/waitlist/page.tsx", WAITLIST],
  ["src/app/app/dashboard/_views/OverviewView.tsx", OVERVIEW],
];
let scannedClaims = 0;
for (const [name, text] of scanned) {
  const bad: string[] = [];
  text.split("\n").forEach((line, i) => {
    COUNT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = COUNT_RE.exec(line))) {
      scannedClaims++;
      if (!claimHolds(Number(m[1]), m[2] === "+")) {
        bad.push(`L${i + 1}: ${m[1]}${m[2]} — ${line.trim().slice(0, 70)}`);
      }
    }
  });
  check(`${name}`, bad.length === 0, bad.join(" | ") || "all claims hold");
}
check(
  "the scanner actually found claims to check",
  scannedClaims >= pinned.length,
  `${scannedClaims} matched — a regex that silently stops matching passes vacuously`,
);

// ── 3. derived where it is free, floor-claimed where it is not ────────────
console.log("\n3. TOOL_COUNT is imported only where it costs nothing to ship");
// Comments are stripped before the literal scan: the farcaster route's header
// quotes the retired "stale 69" to explain what was removed, and a bare
// substring test would read that explanation as the bug itself.
const stripComments = (src: string) =>
  src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    })
    .join("\n");

const routeCode = stripComments(FARCASTER_ROUTE);
check("farcaster route imports TOOL_COUNT", /TOOL_COUNT/.test(routeCode));
COUNT_RE.lastIndex = 0;
check("farcaster route has no hardcoded count", !COUNT_RE.test(routeCode));
check(
  "the farcaster route explains why a second copy exists",
  FARCASTER_ROUTE.includes("docs-truth-check.ts"),
  "the two paths collide; whoever finds that needs to know which one is pinned",
);

// The bundle cost is the whole reason these two are held to group 2 instead.
// Re-adding the import is the regression this guards.
for (const [name, src] of [
  ["src/app/waitlist/page.tsx", WAITLIST],
  ["src/app/app/dashboard/_views/OverviewView.tsx", OVERVIEW],
] as const) {
  const code = stripComments(src);
  check(
    `${name} does not pull the catalog into its client bundle`,
    !/from "@\/lib\/agent-tools"/.test(code),
    "measured +16 kB gzipped First Load; use a floor claim or no number",
  );
}

// ── 4. the cron table is the deployed schedule ────────────────────────────
console.log("\n4. docs/blue-hood/crons.md matches vercel.json");
const vercel = JSON.parse(read("vercel.json")) as { crons?: { path: string; schedule: string }[] };
const deployed = new Map((vercel.crons ?? []).map((c) => [c.path, c.schedule]));
const cronsDoc = readRepo("docs/blue-hood/crons.md");
// Only the Vercel Cron section — the manual-only table below it lists paths
// that deliberately have no schedule, and must not be read as missing rows.
const section = cronsDoc.split("## Automatic (Vercel Cron)")[1]?.split("\n## ")[0] ?? "";
const documented = new Map<string, string>();
for (const line of section.split("\n")) {
  const m = /^\|\s*`(\/api\/[^`]+)`\s*\|\s*`([^`]+)`\s*\|/.exec(line);
  if (m) documented.set(m[1], m[2]);
}
check("the doc table was parsed at all", documented.size > 0, `${documented.size} rows`);
check(
  "every deployed cron is documented",
  [...deployed.keys()].every((p) => documented.has(p)),
  [...deployed.keys()].filter((p) => !documented.has(p)).join(", ") || "none missing",
);
check(
  "no documented cron is absent from vercel.json",
  [...documented.keys()].every((p) => deployed.has(p)),
  [...documented.keys()].filter((p) => !deployed.has(p)).join(", ") || "no phantom rows",
);
for (const [path, schedule] of deployed) {
  const doc = documented.get(path);
  check(`${path} schedule`, doc === schedule, `vercel.json \`${schedule}\` vs doc \`${doc ?? "—"}\``);
}
check(
  "the doc names the script that pins it",
  cronsDoc.includes("apps/web/scripts/docs-truth-check.ts"),
);

// ── 5. the retired blanket claim stays retired ────────────────────────────
console.log("\n5. no surface re-asserts Hub-wide '3-agent consensus'");
// api/catalog/route.ts already retired this with a counted figure: the three
// "agents" are system-prompt personas on ONE Virtuals endpoint, and 78 of 112
// tools run a single Blue persona. Per-tool multi-persona claims are fine and
// deliberately not matched here — only the Hub-wide phrasing is.
for (const [name, src] of scanned) {
  check(`${name}`, !/3-agent consensus/i.test(src), "personas on one endpoint, not agents");
}

console.log(
  failures === 0
    ? `\nALL ${checks} CHECKS PASSED\n`
    : `\n${failures} of ${checks} CHECK(S) FAILED\n`,
);
process.exit(failures === 0 ? 0 : 1);
