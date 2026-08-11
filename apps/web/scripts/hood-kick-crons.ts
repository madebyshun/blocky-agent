/**
 * Blue Hood — kick crons manually (dev helper).
 *
 * On production, `vercel.json` schedules `/api/cron/blue-hood/poll`
 * (every 2 min) and `/api/cron/blue-hood/sparkline-refresh` (every 15
 * min) automatically. On localhost + preview URLs Vercel Cron does NOT
 * fire, so the sparkline cache stays empty and the drift board's 24h
 * column shows em-dash forever.
 *
 * Usage:
 *   cd apps/web && npm run hood:kick-crons
 *
 * Env:
 *   • CRON_SECRET (from .env.local, auto-loaded) — auth for both endpoints
 *   • BH_KICK_TARGET (default http://localhost:3005) — override for preview URLs
 */
import fs from "fs";
import path from "path";

// Load .env.local without pulling in dotenv (same pattern as blue-hood-smoke).
(function loadEnvLocal() {
  try {
    const p = path.resolve(__dirname, "../.env.local");
    if (!fs.existsSync(p)) return;
    const raw = fs.readFileSync(p, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s.startsWith("#")) continue;
      const eq = s.indexOf("=");
      if (eq < 0) continue;
      const key = s.slice(0, eq).trim();
      let value = s.slice(eq + 1).trim();
      if ((value.startsWith("\"") && value.endsWith("\"")) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch { /* keep going */ }
})();

const TARGET = (process.env.BH_KICK_TARGET ?? "http://localhost:3005").replace(/\/+$/, "");
const SECRET = process.env.CRON_SECRET ?? "";

if (!SECRET) {
  console.error("CRON_SECRET missing from apps/web/.env.local — cannot auth cron endpoints.");
  process.exit(2);
}

async function kick(name: string, path: string) {
  const url = `${TARGET}${path}`;
  const t0 = Date.now();
  console.log(`▸ ${name} · POST ${url}`);
  try {
    // Each cron takes 24 tokens × 3s stagger ≈ 72s baseline. Add worst-case
    // 429 retry waits (up to 15s × 24 tokens = 6 min) and Vercel's own
    // maxDuration=180s cap and we're looking at a 6-min tail. Give it 8
    // to leave headroom — the server-side cron will still stream KV
    // writes even if the fetch aborts before it finishes, so ideally we
    // wait for the JSON summary.
    const r = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}` },
      signal: AbortSignal.timeout(480_000),
    });
    const elapsed = Math.round((Date.now() - t0) / 1000);
    const body = await r.text();
    let json: Record<string, unknown> | null = null;
    try { json = JSON.parse(body); } catch { /* non-JSON */ }
    if (!r.ok) {
      console.error(`  ✗ HTTP ${r.status} · ${elapsed}s · ${body.slice(0, 200)}`);
      return false;
    }
    // Compact summary — only the useful fields.
    const summary: string[] = [];
    if (json?.duration_ms !== undefined) summary.push(`${json.duration_ms}ms`);
    if (json?.tokens_watched !== undefined) summary.push(`watched=${json.tokens_watched}`);
    if (json?.tokens_errored !== undefined) summary.push(`errored=${json.tokens_errored}`);
    if (json?.refreshed !== undefined) summary.push(`refreshed=${json.refreshed}`);
    if (json?.detail_warm) {
      const dw = json.detail_warm as { tradable?: number; refreshed?: number; errored?: number };
      summary.push(`detail_warm=${dw.refreshed}/${dw.tradable}`);
    }
    if (json?.engine) {
      const e = json.engine as { fired?: number; deduped?: number; skipped_dust?: number };
      summary.push(`engine{fired=${e.fired ?? 0} deduped=${e.deduped ?? 0} dust=${e.skipped_dust ?? 0}}`);
    }
    console.log(`  ✓ ${elapsed}s · ${summary.join(" · ") || "ok"}`);
    return true;
  } catch (e) {
    const elapsed = Math.round((Date.now() - t0) / 1000);
    const err = (e as Error).message;
    // A client-side timeout is NOT a hard failure — the server-side cron
    // may still be writing KV entries after we abort. Downgrade to warn,
    // and let the caller inspect the snapshot directly to confirm.
    if (err.includes("aborted") || err.includes("timeout")) {
      console.warn(`  ⚠  ${elapsed}s · client timeout; server may still be writing KV. Check /api/hood/snapshot.`);
      return true;
    }
    console.error(`  ✗ ${elapsed}s · ${err}`);
    return false;
  }
}

// P1.2 #3 — `--gap=<seconds>` (default 90) between sparkline-refresh and
// poll. GT's rate-limit window resets every ~60s; firing both crons
// back-to-back inside that window means the second one starts on an
// already-cooked GT and half its calls come back empty (14 fetch_failed
// on the previous kick). 90s gives the window a full cycle to reset.
function parseGap(): number {
  const arg = process.argv.find((a) => a.startsWith("--gap="));
  const fromArg = arg ? Number(arg.split("=")[1]) : NaN;
  const raw = Number.isFinite(fromArg) ? fromArg : 90;
  return Math.max(0, Math.min(600, Math.round(raw)));
}

async function pause(sec: number, why: string) {
  if (sec <= 0) return;
  console.log(`… waiting ${sec}s ${why}`);
  await new Promise((r) => setTimeout(r, sec * 1000));
}

async function main() {
  const gap = parseGap();
  console.log(`Target: ${TARGET}`);
  console.log(`Gap between crons: ${gap}s (override with --gap=<sec>)`);
  console.log(`(each cron staggers ~72s over 24 tokens — be patient)\n`);

  const spark = await kick("sparkline-refresh", "/api/cron/blue-hood/sparkline-refresh");
  await pause(gap, "to respect GT rate limit before firing the poll cron");
  const poll = await kick("poll (+ engine + grader)", "/api/cron/blue-hood/poll");
  // async-brief refactor: the poll cron now only enqueues briefs; we
  // kick the worker once right after so `npm run dev` shows attached
  // briefs without waiting up to 60s for Vercel's next minute-tick.
  // Failure here is a warning, not fatal — the two above are the real
  // gates for a warm dev deploy.
  const brief = await kick("brief-worker (drain queue)", "/api/cron/blue-hood/brief-worker");

  console.log("");
  if (spark && poll) {
    console.log("Done. /hood should now show sparkline candles + live snapshot.");
    if (!brief) {
      console.warn("Note: brief-worker didn't 200 — pending briefs will attach on the next cron tick (1 min).");
    }
    process.exit(0);
  } else {
    console.error("At least one required cron failed — see above for status.");
    process.exit(1);
  }
}

main();
