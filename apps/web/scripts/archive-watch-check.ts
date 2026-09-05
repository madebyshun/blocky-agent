/**
 * Guard for the Base archive watchdog (#148).
 *
 * Run: `npx tsx scripts/archive-watch-check.ts` (from apps/web). Exit 0 = pass.
 *
 * The watchdog's entire job is to notice when the archive stops recording, so
 * every failure mode here is silent by nature: a broken watchdog and a healthy
 * archive look identical from outside. Nothing but an explicit check
 * distinguishes them, and the checks that matter most are the ones asserting
 * what the watchdog must NOT do:
 *
 *   • must not read a KV outage as an empty archive (`blind` ≠ `intact`,
 *     `blind` ≠ `gap`) — the #149/#150 bug family;
 *   • must not read an empty archive as a healthy one (`empty` ≠ `intact`).
 *     This is not hypothetical: the first runtime smoke test of this watchdog
 *     returned `intact` against a KV holding no Base data at all, because every
 *     day was a `miss`, interior-only `missing_days` was therefore empty, and
 *     with no hits there were no absent hours to count. The watchdog scored a
 *     dead archive as healthy — the very bug it was built to catch. Check 1.15
 *     is that regression, pinned;
 *   • must not alarm on the hour currently in progress, or on days before
 *     recording began — a false alarm is how a true one gets ignored;
 *   • must not sit inside the poll cycle, whose KV lock makes it unreachable
 *     during the very outage it watches for;
 *   • must not queue its alert through KV, which is what is broken.
 *
 * Structural checks read SOURCE because those last two are architecture, not
 * behaviour: no fixture can catch a future contributor "simplifying" the
 * watchdog back into the poller.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  classifyArchive,
  formatArchiveAlert,
  watchWindow,
  WATCH_WINDOW_DAYS,
  type ArchiveWatchReport,
} from "../src/lib/base-stocks/archive-watch";
import { BASE_SERIES_ARCHIVE_START } from "../src/lib/blue-hood/kv-keys";
import type { BaseSeriesDay, SeriesPoint } from "../src/lib/blue-hood/types";

let pass = 0;
const failures: string[] = [];

function check(name: string, cond: boolean) {
  if (cond) pass++;
  else failures.push(name);
}

const ROOT = process.cwd();
const libSrc = readFileSync(join(ROOT, "src/lib/base-stocks/archive-watch.ts"), "utf8");
const cronSrc = readFileSync(
  join(ROOT, "src/app/api/cron/blue-hood/archive-watch/route.ts"),
  "utf8",
);
const pollSrc = readFileSync(join(ROOT, "src/app/api/cron/blue-hood/poll/route.ts"), "utf8");
const vercelJson = readFileSync(join(ROOT, "vercel.json"), "utf8");

/**
 * Strip comments before any "this token must NOT appear" check.
 *
 * Not cosmetic. Check 7.9 ("the watchdog lib queues nothing in KV") first ran
 * against raw source and FAILED — its `kvSet` pattern matched the word
 * `kvSetNX` inside the lib's own header comment explaining why the poller's
 * lock makes an in-poller watchdog unreachable. The file was clean; the check
 * was reading prose about KV as evidence of KV. A negative source check that
 * sees comments tests the documentation, not the code.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}
const libCode = stripComments(libSrc);
const cronCode = stripComments(cronSrc);
const pollCode = stripComments(pollSrc);

// ── fixtures ─────────────────────────────────────────────────────────────────

/** A day holding points for the given hours. */
function day(d: string, hours: number[]): BaseSeriesDay {
  const points: SeriesPoint[] = hours.map((h) => ({
    hour: `${d}${String(h).padStart(2, "0")}`,
    rows: [
      {
        ticker: "NVDAc",
        oracle_usd: 100,
        dex_usd: 101,
        drift_pct: 1,
        oracle_updated_at: 1_700_000_000,
      },
    ],
  })) as unknown as SeriesPoint[];
  return {
    day: d,
    v: 2,
    chain: "base",
    cycles: hours.length,
    points,
    peaks: [],
  } as unknown as BaseSeriesDay;
}

type Read = Awaited<ReturnType<typeof import("../src/lib/base-stocks/base-series").readBaseSeriesDays>>[number];

const hit = (d: string, hours: number[]): Read => ({ day: d, status: "hit", value: day(d, hours) });
const miss = (d: string): Read => ({ day: d, status: "miss" });
const err = (d: string): Read => ({ day: d, status: "error", message: "ECONNRESET" });
const pre = (d: string): Read => ({ day: d, status: "before_archive" });

const START = BASE_SERIES_ARCHIVE_START; // "20260828"
const D1 = START;
const D2 = "20260829";
const D3 = "20260830";
const D4 = "20260831";
/** 20260830T05:30Z — so hours 00–04 of D3 are "finished", 05 is in progress. */
const NOW = new Date(Date.UTC(2026, 7, 30, 5, 30));

const all = (h: number[]) => h;

// ── Group 1: the four states stay four ───────────────────────────────────────

{
  // Every day errored → blind. NOT intact, NOT gap.
  const r = classifyArchive([err(D1), err(D2), err(D3)], NOW);
  check("1.1 all-error window is `blind`", r.level === "blind");
  check("1.2 blind is not intact", r.level !== "intact");
  check("1.3 blind is not gap", r.level !== "gap");
  check("1.4 blind names the unreadable days", r.unreadable.length === 3);
  check(
    "1.5 blind reports NO absent hours (it saw nothing, so it claims nothing)",
    r.absent_hours.length === 0 && r.missing_days.length === 0,
  );
  check("1.6 blind reports stale_hours=null, not 0", r.stale_hours === null);
  check("1.7 blind reports days_with_data=0", r.days_with_data === 0);
}

{
  // One day errored among readable days → gap, not blind. Partial blindness
  // still permits statements about the days that WERE read.
  const r = classifyArchive([hit(D1, all([...Array(24).keys()])), err(D2)], NOW);
  check("1.8 partial error is `gap`, not `blind`", r.level === "gap");
  check("1.9 partial error still names the unreadable day", r.unreadable[0] === D2);
  check("1.10 partial error still counts the readable day", r.days_with_data === 1);
}

{
  // Fully readable, fully covered → intact.
  const r = classifyArchive(
    [hit(D1, [...Array(24).keys()]), hit(D2, [...Array(24).keys()]), hit(D3, [0, 1, 2, 3, 4, 5])],
    NOW,
  );
  check("1.11 complete window is `intact`", r.level === "intact");
  check("1.12 intact has no unreadable", r.unreadable.length === 0);
  check("1.13 intact has no absent hours", r.absent_hours.length === 0);
  check("1.14 intact has no missing days", r.missing_days.length === 0);
}

{
  // ── THE REGRESSION ─────────────────────────────────────────────────────────
  // Reads all SUCCEEDED and every one came back holding nothing. Before the
  // `empty` state existed this returned `intact` and the watchdog sent NOTHING:
  // interior-only `missing_days` is empty when there are no hits to be interior
  // to, and absent hours are only counted inside days that have data. A dead
  // archive therefore satisfied every "no problems found" test. This is the
  // single most important check in the file — it is the bug the watchdog exists
  // to catch, found inside the watchdog.
  const r = classifyArchive([miss(D1), miss(D2), miss(D3)], NOW);
  check("1.15 an all-miss window is `empty`, NOT `intact`", r.level === "empty");
  check("1.16 empty is not gap", r.level !== "gap");
  check("1.17 empty is not blind (miss ≠ error: we looked, and it was bare)", r.level !== "blind");
  check("1.18 empty reports no data", r.days_with_data === 0 && r.points === 0);
  check("1.19 empty reports stale_hours=null, not 0", r.stale_hours === null && r.last_hour === null);
  check("1.20 empty still names its window", r.window.days === 3 && r.window.from === D1);
}

{
  // Partial blindness must NOT be upgraded to `empty`. We did not see the whole
  // window, so "the archive is empty" is a claim we have no standing to make —
  // it would exonerate KV (the actual suspect) and send the operator to the
  // writer instead. Falls through to `gap`, which names the day it could not read.
  const r = classifyArchive([miss(D1), err(D2), miss(D3)], NOW);
  check("1.21 miss+error is `gap`, not `empty` (we did not see all of it)", r.level === "gap");
  check("1.22 the mixed window still names the unreadable day", r.unreadable[0] === D2);
}

{
  // One point anywhere is enough to disprove emptiness.
  const r = classifyArchive([miss(D1), miss(D2), hit(D3, [0, 1, 2, 3, 4])], NOW);
  check("1.23 a single day of data disproves `empty`", r.level !== "empty");
}

// ── Group 2: absent hours — the permanent-loss signal ────────────────────────

{
  // D3 is TODAY at 05:30Z. Hours 00–04 are finished; 05 is in progress.
  // Holding only 00,01 means 02,03,04 are absent — and 05 must NOT be.
  const r = classifyArchive([hit(D3, [0, 1])], NOW);
  check("2.1 absent hours are detected", r.level === "gap");
  check(
    "2.2 exactly the finished-but-missing hours are named",
    JSON.stringify(r.absent_hours) === JSON.stringify([`${D3}02`, `${D3}03`, `${D3}04`]),
  );
  check(
    "2.3 the hour IN PROGRESS is never called absent",
    !r.absent_hours.includes(`${D3}05`),
  );
  check("2.4 future hours are never called absent", !r.absent_hours.includes(`${D3}06`));
}

{
  // The archive's FIRST day started mid-morning. Hours before the first point
  // were never promised and must not be reported — this is the exact phantom
  // gap `baseSeriesCoverage` exists to avoid.
  const r = classifyArchive([hit(D1, [9, 10, 11]), hit(D2, [...Array(24).keys()]), hit(D3, [0, 1, 2, 3, 4, 5])], NOW);
  check(
    "2.5 hours before the archive's first point are not gaps",
    !r.absent_hours.some((h) => h < `${D1}09`),
  );
  check(
    "2.6 but hours AFTER the first point on day 1 still are",
    r.absent_hours.includes(`${D1}12`) && r.absent_hours.includes(`${D1}23`),
  );
}

// ── Group 3: missing days — interior only ────────────────────────────────────

{
  const r = classifyArchive([hit(D1, [9]), miss(D2), hit(D3, [0, 1, 2, 3, 4])], NOW);
  check("3.1 an interior missing day is a gap", r.missing_days.includes(D2));
}

{
  // Leading misses: the window reaches back before anything was recorded.
  const r = classifyArchive([miss(D1), miss(D2), hit(D3, [0, 1, 2, 3, 4])], NOW);
  check("3.2 leading misses are NOT gaps", r.missing_days.length === 0);
}

{
  // Trailing miss: a day the archive has not reached yet.
  const r = classifyArchive([hit(D1, [9]), miss(D2)], NOW);
  check("3.3 trailing misses are NOT gaps", r.missing_days.length === 0);
}

{
  const r = classifyArchive([miss(D1), miss(D2), miss(D3)], NOW);
  check("3.4 an all-miss window reports no gaps and no data", r.missing_days.length === 0 && r.days_with_data === 0);
  check("3.5 an all-miss window is not `blind` (miss ≠ error)", r.level !== "blind");
}

// ── Group 4: staleness ───────────────────────────────────────────────────────

{
  const r = classifyArchive([hit(D3, [0, 1, 2, 3, 4])], NOW);
  check("4.1 last_hour is the newest hour on record", r.last_hour === `${D3}04`);
  check("4.2 stale_hours counts from last_hour to now", r.stale_hours === 1);
}

{
  const r = classifyArchive([hit(D1, [9])], NOW);
  // D1 09:00 → D3 05:00 = 44h
  check("4.3 staleness spans days correctly", r.stale_hours === 44);
}

{
  const r = classifyArchive([err(D1), miss(D2)], NOW);
  check("4.4 unknown staleness is null, never 0", r.stale_hours === null);
}

// ── Group 5: the window ──────────────────────────────────────────────────────

{
  const w = watchWindow(NOW, WATCH_WINDOW_DAYS);
  check("5.1 window never reaches before the archive start", w.every((d) => d >= START));
  check("5.2 window ends today", w[w.length - 1] === "20260830");
  check("5.3 window is ascending and unique", JSON.stringify(w) === JSON.stringify([...new Set(w)].sort()));
  check("5.4 window is capped at WATCH_WINDOW_DAYS", w.length <= WATCH_WINDOW_DAYS);
  check("5.5 today the window is short, not padded with pre-archive days", w.length === 3);
}

{
  // Far future: the window is a rolling 14 days, not "everything since start".
  const w = watchWindow(new Date(Date.UTC(2027, 0, 1, 12, 0)), WATCH_WINDOW_DAYS);
  check("5.6 a mature window is exactly WATCH_WINDOW_DAYS", w.length === WATCH_WINDOW_DAYS);
  check("5.7 mature window ends today", w[w.length - 1] === "20270101");
}

{
  check("5.8 the window is 14 days — what #152 reads", WATCH_WINDOW_DAYS === 14);
}

{
  // `before_archive` reads cost no KV request and must not be classified.
  const r = classifyArchive([pre("20260101"), pre("20260102"), hit(D1, [9])], NOW);
  check("5.9 before_archive days are excluded from the window count", r.window.days === 1);
  check("5.10 before_archive days are not missing days", r.missing_days.length === 0);
  check("5.11 a window of only before_archive days is not `blind`", classifyArchive([pre("20260101")], NOW).level === "intact");
}

// ── Group 6: the message ─────────────────────────────────────────────────────

{
  const intact = classifyArchive(
    [hit(D1, [...Array(24).keys()]), hit(D2, [...Array(24).keys()]), hit(D3, [0, 1, 2, 3, 4, 5])],
    NOW,
  );
  check("6.1a the intact fixture really is intact", intact.level === "intact");
  check("6.1b intact sends nothing", formatArchiveAlert(intact) === null);
}

{
  const msg = formatArchiveAlert(classifyArchive([err(D1), err(D2)], NOW))!;
  check("6.2 blind produces a message", typeof msg === "string" && msg.length > 0);
  check(
    "6.3 the blind message says UNKNOWN, not empty",
    /UNKNOWN/.test(msg) && /not empty/i.test(msg),
  );
  // NOT `/Upstash/` alone. That was the first draft and mutation M12 SURVIVED
  // it: the word also appears earlier, in the sentence explaining the poll
  // lock, so deleting the actionable remedy line entirely still passed. Same
  // read-a-neighbour blindness as the `v`-legend miss in #159. Pin the remedy
  // itself — where to look, and the evidence that it is the right place.
  check("6.4a the blind message names where to look FIRST", /Upstash plan\/usage/i.test(msg));
  check("6.4b the blind message cites the prior incidents", /#123/.test(msg));
}

{
  // The `empty` message must make the OPPOSITE diagnosis to `blind` and send
  // the operator somewhere else. If the two are interchangeable prose, the
  // fourth state buys nothing — the whole point is that KV is exonerated here.
  const r = classifyArchive([miss(D1), miss(D2), miss(D3)], NOW);
  const msg = formatArchiveAlert(r)!;
  check("6.11 empty produces a message (a dead archive is never silent)", typeof msg === "string" && msg.length > 0);
  check("6.12a the empty message says the reads SUCCEEDED", /read CLEANLY/.test(msg));
  check("6.12b the empty message exonerates KV explicitly", /KV answered/i.test(msg));
  check("6.13 the empty message blames the writer", /<b>writer<\/b>/.test(msg));
  // Pin blind's exact claim as ABSENT, not the bare word "unknown" — the empty
  // message legitimately contains "not unknown", so a `/unknown/` check would
  // fail on correct code while a `/UNKNOWN, not empty/` check catches the real
  // error: the two messages saying the same thing.
  check("6.14 the empty message does NOT make blind's UNKNOWN claim", !/UNKNOWN, not empty/i.test(msg));
  check(
    "6.15 the empty message names where to look — the poll cron, not Upstash",
    /blue-hood\/poll/.test(msg) && !/Upstash plan\/usage/.test(msg),
  );
  check("6.16 the empty message says the ongoing loss is permanent", /permanent/i.test(msg));
}

{
  // Guard-the-guard for the pair above: the two alarms must not be able to
  // collapse into one another by headline either.
  const blindMsg = formatArchiveAlert(classifyArchive([err(D1), err(D2)], NOW))!;
  const emptyMsg = formatArchiveAlert(classifyArchive([miss(D1), miss(D2)], NOW))!;
  check("6.17a blind and empty are different messages", blindMsg !== emptyMsg);
  check(
    "6.17b neither headline appears in the other",
    /UNREADABLE/.test(blindMsg) &&
      !/UNREADABLE/.test(emptyMsg) &&
      /EMPTY/.test(emptyMsg) &&
      !/EMPTY/.test(blindMsg),
  );
}

{
  const msg = formatArchiveAlert(classifyArchive([hit(D3, [0, 1])], NOW))!;
  check("6.5 gap produces a message", typeof msg === "string" && msg.length > 0);
  check("6.6 the gap message counts the absent hours", /3 hour\(s\) absent/.test(msg));
  check("6.7 the gap message says the loss is permanent", /permanent/i.test(msg));
}

{
  // A long outage must not produce an unreadable wall of hours.
  const r = classifyArchive([hit(D1, [9]), hit(D2, []), hit(D3, [])], NOW);
  const msg = formatArchiveAlert(r)!;
  check("6.8 many absent hours are summarised, not dumped", /\+\d+ more/.test(msg));
  check("6.9 the summarised message stays short", msg.length < 1200);
}

{
  const r = classifyArchive([hit(D1, [9]), err(D2), hit(D3, [0, 1, 2, 3, 4])], NOW);
  const msg = formatArchiveAlert(r)!;
  check(
    "6.10 a mixed message keeps unreadable separate from absent",
    /unreadable/i.test(msg) && /unknown, not empty/i.test(msg),
  );
}

// ── Group 7: structure — the watchdog must not share fate with the poller ────

{
  check(
    "7.1 the poll route still short-circuits on a failed lock (the reason this cron is separate)",
    /if\s*\(\s*!gotLock\s*\)/.test(pollCode),
  );
  check(
    "7.2 the poller does NOT own the archive watchdog",
    !/archive-watch/.test(pollCode),
  );
  check(
    "7.3 the watchdog cron exists as its own route",
    /export async function GET/.test(cronCode) && /checkArchive/.test(cronCode),
  );
  check("7.4 the watchdog is registered in vercel.json", /archive-watch/.test(vercelJson));
  check(
    "7.5 the watchdog runs hourly, not on the poll cadence",
    /"path":\s*"\/api\/cron\/blue-hood\/archive-watch",\s*"schedule":\s*"\d+ \* \* \* \*"/.test(
      vercelJson.replace(/\s+/g, " "),
    ),
  );
}

{
  // Delivery must survive a KV suspend. `telegram/bot.ts` is a bare fetch; the
  // KV-queued alert path would be dead in the outage it reports.
  check("7.6 the cron delivers through telegram/bot.ts", /from "@\/lib\/telegram\/bot"/.test(cronCode));
  check(
    "7.7 the cron does NOT import the KV-queued alert engine",
    !/blue-hood\/alerts/.test(cronCode),
  );
  check("7.8 the cron imports no KV module directly", !/from "@\/lib\/kv"/.test(cronCode));
  check(
    "7.9 the watchdog lib queues nothing in KV",
    !/kvSet|kvSAdd|kvLPush|from "@\/lib\/kv"/.test(libCode),
  );
  check(
    "7.10 an unset TELEGRAM_CHAT_ID is reported, not silently skipped",
    /telegram_chat_id_unset/.test(cronCode),
  );
  check("7.11 the cron is authorized like the other Blue Hood crons", /CRON_SECRET/.test(cronCode));
}

// ── Group 10: the comment-stripper itself ────────────────────────────────────
//
// Group 7's negative checks are only as good as `stripComments`. If it ever
// returned its input unchanged, 7.2/7.7/7.8/7.9 would quietly go back to
// reading prose — the exact failure that made 7.9 fail on first run.

{
  check("10.1 block comments are stripped", stripComments("/* kvSet */ const a=1;") === " const a=1;");
  check("10.2 line comments are stripped", stripComments("// kvSet\nconst a=1;").trim() === "const a=1;");
  check(
    "10.3 code is NOT stripped",
    stripComments('import { kvSet } from "@/lib/kv";').includes("kvSet"),
  );
  check(
    "10.4 the stripper actually removed something from the lib",
    libCode.length < libSrc.length - 500,
  );
  check(
    "10.5 the lib's header really does discuss kvSetNX (so 7.9 would fail unstripped)",
    /kvSetNX/.test(libSrc) && !/kvSetNX/.test(libCode),
  );
}

// ── Group 8: guard-the-guard ─────────────────────────────────────────────────
//
// A source-regex check passes for free if its subject moved. These pin the
// checks above to something real, so a renamed file fails loudly rather than
// silently making Group 7 vacuous.

{
  check("8.1 poll route source was actually loaded", pollSrc.length > 2000);
  check("8.2 cron route source was actually loaded", cronSrc.length > 1000);
  check("8.3 watchdog lib source was actually loaded", libSrc.length > 2000);
  check("8.4 vercel.json was actually loaded", /"crons"/.test(vercelJson));
  check(
    "8.5 the classifier is exercised, not just imported",
    typeof classifyArchive === "function" && typeof formatArchiveAlert === "function",
  );
}

{
  // The fixture helper must genuinely produce the shape being asserted on —
  // otherwise Group 2's "absent hours" checks could pass against empty days.
  const d = day(D3, [0, 1]);
  check("8.6 fixture builds real points", d.points.length === 2 && d.points[0].hour === `${D3}00`);
  check("8.7 fixture days carry the base chain discriminator", d.chain === "base");
}

// ── Group 11: the watchdog and the endpoint share ONE definition of "hole" ───
//
// `/api/hood/base-series` publishes the same two arrays as `gaps`. They used to
// be derived twice — once here, once inline in the route. Two texts for one rule
// is bad enough; here it is worse, because a watchdog that disagrees with the
// endpoint it watches is WORSE than no watchdog. Either the operator is paged
// about a window the endpoint calls contiguous, or the endpoint reports gaps
// nobody is paged about — and whichever one is consulted first looks
// authoritative. Groups 2 and 3 above still test the behaviour end-to-end
// through `classifyArchive`; these pin that it is not a second implementation
// quietly agreeing for now.

{
  check(
    "11.1 the classifier delegates to the shared derivation",
    /archiveHoles\(/.test(libCode),
  );
  check(
    "11.2 the classifier does not re-derive the interior-miss filter",
    !/status\s*===\s*"miss"/.test(libCode),
  );
  check(
    "11.3 the classifier does not re-derive absent hours",
    !/baseSeriesCoverage\(/.test(libCode),
  );
  // Guard-the-guard: 11.2/11.3 would pass for free against an empty string.
  check(
    "11.4 the lib code really was loaded and is non-trivial",
    libCode.length > 1500 && /classifyArchive/.test(libCode),
  );
}

// ── Group 9: conservation ────────────────────────────────────────────────────

{
  // Every considered day lands in exactly one bucket. A day that is silently
  // dropped is a gap nobody hears about.
  const reads = [hit(D1, [9]), miss(D2), err(D3), hit(D4, [0])];
  const r: ArchiveWatchReport = classifyArchive(reads, new Date(Date.UTC(2026, 7, 31, 5, 30)));
  check("9.1 every non-pre-archive day is counted in the window", r.window.days === 4);
  check(
    "9.2 hits + unreadable ≤ window (misses make up the rest)",
    r.days_with_data + r.unreadable.length <= r.window.days,
  );
  check("9.3 window bounds are the real first/last day", r.window.from === D1 && r.window.to === D4);
}

// ── report ───────────────────────────────────────────────────────────────────

console.log(`\narchive-watch guard: ${pass} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL  ${f}`);
process.exit(failures.length === 0 ? 0 : 1);
