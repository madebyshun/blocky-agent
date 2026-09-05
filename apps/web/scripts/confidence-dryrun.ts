/**
 * Offline dry-run for Drift Statistics v0. Pulls the LIVE public track record
 * and runs the exact `computeTickerConfidence` the engine will run, so the
 * "matches zero tickers today" claim is measured rather than asserted.
 *
 * Read-only: touches no KV, fires nothing, writes nothing.
 *   npx tsx scripts/confidence-dryrun.ts
 */
import { computeTickerConfidence, CONFIDENCE_MIN_SAMPLE, CONFIDENCE_MAX_WILSON_UPPER } from "../src/lib/blue-hood/ticker-confidence";
import { wilsonInterval } from "../src/lib/blue-hood/cohort-stats";
import type { Arrow } from "../src/lib/blue-hood/types";

const URL = "https://blueagent.dev/api/acp/track-record?limit=200";

async function main() {
  const res = await fetch(URL);
  const body = await res.json();
  const arrows: Arrow[] = body?.receipts?.arrows ?? [];
  console.log(`fetched arrows: ${arrows.length}`);

  const t = computeTickerConfidence(arrows);
  console.log(
    `sample_total=${t.sample_total} entries=${Object.keys(t.entries).length}` +
      ` low_count=${t.low_count} min_sample=${t.min_sample} max_wilson_upper=${t.max_wilson_upper}`,
  );

  const rows = Object.values(t.entries)
    .filter((e) => e.type === null) // ticker-wide only, for readability
    .sort((a, b) => b.n - a.n || a.pct - b.pct);

  console.log("\nticker   n  hits   pct   wilson_lo  wilson_hi  level");
  for (const e of rows) {
    console.log(
      `${e.ticker.padEnd(7)} ${String(e.n).padStart(2)}  ${String(e.hits).padStart(4)}  ${String(e.pct).padStart(3)}%` +
        `      ${e.wilson_low.toFixed(3)}      ${e.wilson_high.toFixed(3)}  ${e.level}`,
    );
  }

  const eligible = Object.values(t.entries).filter((e) => e.level !== "insufficient");
  const low = Object.values(t.entries).filter((e) => e.level === "low");
  console.log(`\neligible (n >= ${CONFIDENCE_MIN_SAMPLE}): ${eligible.length}`);
  console.log(`low (wilson_high < ${CONFIDENCE_MAX_WILSON_UPPER}): ${low.length}`, low.map((e) => e.key));

  // How far the closest candidate is from biting — the number that says when
  // this gate stops being inert.
  const closest = [...rows].sort((a, b) => b.n - a.n)[0];
  if (closest) console.log(`deepest ticker: ${closest.ticker} n=${closest.n} (needs ${Math.max(0, CONFIDENCE_MIN_SAMPLE - closest.n)} more)`);

  // Projection: at exactly n = CONFIDENCE_MIN_SAMPLE, which hit counts would
  // trip the gate? This is the honest answer to "when does this start biting",
  // and it shows the bar is reachable rather than theatrical.
  console.log(`\nat n=${CONFIDENCE_MIN_SAMPLE}, wilson_high by hit count:`);
  for (let h = 0; h <= CONFIDENCE_MIN_SAMPLE; h++) {
    const { hi } = wilsonInterval(h, CONFIDENCE_MIN_SAMPLE);
    const trips = hi < CONFIDENCE_MAX_WILSON_UPPER;
    console.log(`  ${String(h).padStart(2)}/${CONFIDENCE_MIN_SAMPLE}  hi=${hi.toFixed(3)}  ${trips ? "→ LOW" : ""}`);
    if (!trips && h > 0) break; // stop at the first count that no longer trips
  }

  // Which tickers are on track to trip it if their current rate holds.
  console.log(`\non-track (current rate held to n=${CONFIDENCE_MIN_SAMPLE}):`);
  for (const e of rows) {
    if (e.n < 6) continue;
    const projHits = Math.round((e.hits / e.n) * CONFIDENCE_MIN_SAMPLE);
    const { hi } = wilsonInterval(projHits, CONFIDENCE_MIN_SAMPLE);
    if (hi < CONFIDENCE_MAX_WILSON_UPPER) {
      console.log(`  ${e.ticker.padEnd(6)} ${e.hits}/${e.n} (${e.pct}%) → ~${projHits}/${CONFIDENCE_MIN_SAMPLE}, hi=${hi.toFixed(3)} — would flag in ${CONFIDENCE_MIN_SAMPLE - e.n} more graded`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
