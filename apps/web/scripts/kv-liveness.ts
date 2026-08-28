/**
 * Refuse to let a local script draw conclusions from a KV it cannot prove is live.
 *
 * Run: `cd apps/web && npx tsx scripts/kv-liveness.ts`
 * Use: `import { assertKvLive } from "./kv-liveness";` at the top of any script
 *      whose OUTPUT IS AN ANALYTICAL CLAIM.
 *
 * ## The failure this exists to stop (#155)
 *
 * `.env.local` can point at a DIFFERENT Upstash instance than production — ours
 * did, silently, for 34 days after the database was replaced during #148/#123.
 * Every read against it succeeded. Nothing errored. Keys were PRESENT. The data
 * was simply frozen a month in the past.
 *
 * That is the worst possible failure mode for an analysis script, because it
 * does not look like a failure: you get a full result set, plausible numbers,
 * and a confident conclusion about a system you were never actually observing.
 * A connection error would have been kinder — it announces itself.
 *
 * This already burned us once: a health probe read `bh:snapshot:latest`, saw
 * PRESENT, and reported "cron ALIVE, Base-desk-specific failure" — a production
 * outage that did not exist. The record was 34 days old. PRESENT is not FRESH,
 * exactly as `feed_source:"cache"` is not "the code ran" and `x-vercel-cache:
 * HIT` is not "the deploy is live".
 *
 * ## Why this reports a STATE and not a CAUSE
 *
 * An absent heartbeat has two causes that CANNOT be told apart from here:
 *   (a) the poll cron has been dead for >24h (the key's TTL), or
 *   (b) this is not the database the cron writes to.
 *
 * Naming either one would be the same guess-dressed-as-fact this guard exists
 * to prevent. So the verdict is `unwitnessed` — "no evidence of life, cause
 * undetermined" — and the caller is told to check production's own
 * `/api/hood/health` before believing anything. Distinguishing (a) from (b)
 * requires a source of truth outside this connection, and there isn't one here.
 *
 * The HOST is printed on every run because it is the single fact that makes
 * this class of bug visible at a glance. The token is never printed.
 *
 * ## Prefer not needing this at all
 *
 * The safest analysis script does not open a KV connection. `gap-closure-dryrun.ts`
 * reads `https://blueagent.dev` over HTTP and is therefore structurally immune to
 * every failure above: it can only ever see what production sees. Direct KV is
 * worth it for bulk scans that would be thousands of HTTP calls — but it trades
 * a connection that cannot be wrong for one that can be wrong SILENTLY. Reach
 * for the endpoint first; gate with `assertKvLive()` when you cannot.
 *
 * ## Not for hermetic tests
 *
 * `kv-mutate-control-test.ts` and friends WANT the in-memory Map — a fixed,
 * empty store is the point of a unit test. Do not add this guard there. It
 * belongs only where the output is a CLAIM ABOUT PRODUCTION.
 */
import { kvGetProbe } from "@/lib/kv";
import { KV_POLL_HEARTBEAT } from "@/lib/blue-hood/kv-keys";

/** The poll cron runs every 5 minutes, so a live heartbeat is at most ~5 min
 *  old. 15 gives three missed cycles of slack before we stop vouching for the
 *  connection — wide enough not to cry wolf, far tighter than the key's 24h TTL,
 *  which is what let a month-old database keep answering. */
const FRESH_MAX_S = 900;

export type KvLiveness =
  /** Heartbeat present and recent. Reads from this connection describe a system
   *  that is currently running. */
  | { state: "live"; host: string; age_s: number; at: string }
  /** Heartbeat present but old. The connection works; what it describes may be
   *  a system that stopped, or a database nobody writes to any more. */
  | { state: "stale"; host: string; age_s: number; at: string }
  /** No credentials in the environment. `@/lib/kv` has therefore silently
   *  substituted an in-memory Map and there is NO DATABASE in the picture at
   *  all — see `describeKvLiveness`. Detected from env, so unlike `unwitnessed`
   *  this one IS certain. */
  | { state: "not_configured"; host: string }
  /** No heartbeat, but credentials are present. Dead cron or wrong database —
   *  not decidable from here. */
  | { state: "unwitnessed"; host: string }
  /** The read itself failed. Contents UNKNOWN, which is not "empty". */
  | { state: "unreachable"; host: string; message: string };

/**
 * Resolve the SAME env vars, in the SAME order, as `@/lib/kv` does at line ~95.
 * If this drifts from that, the guard reports on a connection other than the one
 * the script actually uses — a guard that lies about which database it checked
 * is worse than no guard, because it converts a caught bug into a certified one.
 *
 * Returns the host only. The URL identifies WHICH database — that is the whole
 * point of this guard. The token authenticates to it and is never printed, only
 * tested for presence.
 */
function kvTarget(): { host: string; configured: boolean } {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    return { host: url ? `${safeHost(url)} (token missing)` : "<no KV env — in-memory Map>", configured: false };
  }
  return { host: safeHost(url), configured: true };
}

function safeHost(raw: string): string {
  try {
    return new URL(raw).host;
  } catch {
    return "<unparseable KV url>";
  }
}

export async function checkKvLiveness(now = new Date()): Promise<KvLiveness> {
  const { host, configured } = kvTarget();
  // Checked BEFORE reading: with no credentials the read cannot fail, it can
  // only return an empty Map's worth of nothing. Reading first would produce a
  // `miss` and hide the certain diagnosis behind an ambiguous one.
  if (!configured) return { state: "not_configured", host };

  const probe = await kvGetProbe<{ at?: string }>(KV_POLL_HEARTBEAT);

  if (probe.status === "error") return { state: "unreachable", host, message: probe.message };
  if (probe.status === "miss") return { state: "unwitnessed", host };

  const at = probe.value?.at;
  const t = at ? Date.parse(at) : NaN;
  // A heartbeat we cannot date is a heartbeat we cannot vouch for. Treating an
  // unparseable timestamp as "probably fine" would reintroduce the whole bug.
  if (!at || Number.isNaN(t)) return { state: "unwitnessed", host };

  const age_s = Math.round((now.getTime() - t) / 1000);
  return { state: age_s <= FRESH_MAX_S ? "live" : "stale", host, age_s, at };
}

/** Human-readable one-liner. Kept next to the type so a new state cannot be
 *  added without a line here explaining what it licenses the reader to believe. */
export function describeKvLiveness(r: KvLiveness): string {
  switch (r.state) {
    case "live":
      return `LIVE          ${r.host} — heartbeat ${r.age_s}s old (${r.at}). Reads describe a running system.`;
    case "stale":
      return (
        `STALE         ${r.host} — heartbeat ${r.age_s}s old (${r.at}).\n` +
        `              The connection works; what it DESCRIBES may not be running.\n` +
        `              Do NOT publish numbers from this connection without checking\n` +
        `              production's own /api/hood/health first.`
      );
    case "not_configured":
      return (
        `NOT CONFIGURED ${r.host}\n` +
        `              There is NO DATABASE here. \`@/lib/kv\` falls back to an\n` +
        `              in-memory Map when the KV env vars are absent, so every read\n` +
        `              returns empty and every write disappears at exit — silently,\n` +
        `              with no error. An analysis script run this way reports "no\n` +
        `              arrows", "no drift", "empty archive" about a Map created\n` +
        `              milliseconds ago.\n` +
        `              This is the DEFAULT for \`npx tsx\`: it does not load\n` +
        `              .env.local. Load it explicitly before drawing conclusions.`
      );
    case "unwitnessed":
      return (
        `UNWITNESSED   ${r.host} — no readable heartbeat.\n` +
        `              Cause UNDETERMINED: either the poll cron has been dead >24h\n` +
        `              (the key's TTL) or this is not the database it writes to.\n` +
        `              These are NOT distinguishable from here. Check production's\n` +
        `              /api/hood/health — if that says healthy, your .env.local is\n` +
        `              pointed somewhere else (#155).`
      );
    case "unreachable":
      return (
        `UNREACHABLE   ${r.host} — ${r.message}\n` +
        `              The read FAILED. Contents are UNKNOWN, which is not "empty".`
      );
  }
}

/**
 * Hard gate for any script whose output is an analytical claim.
 *
 * Throws on anything but `live`. That is deliberate: the alternative — printing
 * a warning and continuing — produces exactly the artefact this guard exists to
 * prevent, a confident analysis of the wrong database, with the warning scrolled
 * off the top of the terminal. A script that cannot prove what it is reading
 * should produce NO number, not a caveated one.
 */
export async function assertKvLive(now = new Date()): Promise<KvLiveness> {
  const r = await checkKvLiveness(now);
  console.log(`[kv] ${describeKvLiveness(r)}`);
  if (r.state !== "live") {
    throw new Error(
      `KV liveness is "${r.state}" (${r.host}) — refusing to produce analysis from a connection ` +
        `that cannot be shown to be reading the live system. See scripts/kv-liveness.ts (#155).`,
    );
  }
  return r;
}

async function main(): Promise<void> {
  const r = await checkKvLiveness();
  console.log(`\n${describeKvLiveness(r)}\n`);
  // Non-zero on anything but live, so this composes with `&&` in a shell:
  //   npx tsx scripts/kv-liveness.ts && npx tsx scripts/some-analysis.ts
  process.exit(r.state === "live" ? 0 : 1);
}

// Run only when invoked directly, so importing `assertKvLive` has no side effect.
if (process.argv[1]?.endsWith("kv-liveness.ts")) void main();
