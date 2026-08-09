/**
 * Public read of the Blue Hood cohort analysis — "does the signal work better
 * under some condition?", answered with the multiple-comparison correction
 * attached rather than omitted.
 *
 * WHY THIS ENDPOINT IS SHAPED LIKE THIS: the naive version of this feature
 * ("scan every condition, publish the best one") fires on 38.5% of pure-noise
 * records in our own control test. So the payload leads with `verdict` and
 * `validated`, and every cohort carries `survives_correction` inline — a
 * consumer cannot read a percentage here without also reading whether it
 * survived being judged as best-of-N.
 *
 * WINDOW: all-time by default, NOT the rolling 7d the public headline uses.
 * 7d currently holds ~72 graded arrows, so cohorts inside it are n≈10–20 —
 * below the gate, i.e. no percentages at all. `window_basis` is stamped on the
 * response so this number can never be silently compared against /track's.
 * `?window=7d` is accepted for callers that explicitly want the headline basis.
 *
 * COST: this reads the whole arrow feed from KV (~600 keys). The engine has
 * already been starved once by the Upstash request cap, so the response is
 * cached for 5 minutes — the all-time record moves by a couple of arrows per
 * hour, which no cohort verdict is sensitive to.
 */
import { NextRequest, NextResponse } from "next/server";
import { readPublicArrows } from "@/lib/blue-hood/public-feed";
import { analyzeCohorts, COHORT_FDR, COHORT_MIN_SAMPLE } from "@/lib/blue-hood/cohort-stats";
import { HIT_RATE_WINDOW_MS } from "@/lib/blue-hood/hit-rate-gate";

export const runtime = "nodejs";
export const revalidate = 300;

/** Match `getPublicArrowBySerial`'s scan depth — the feed is ~500 in practice. */
const FEED_DEPTH = 600;

export async function GET(req: NextRequest) {
  const wantRolling = new URL(req.url).searchParams.get("window") === "7d";

  const arrows = await readPublicArrows(FEED_DEPTH);
  const analysis = analyzeCohorts(arrows, {
    ...(wantRolling ? { windowMs: HIT_RATE_WINDOW_MS } : {}),
  });

  return NextResponse.json(
    {
      ok: true,
      ...analysis,
      method: {
        null_hypothesis: "hit rate = 50% (a signal with no edge closes half the time)",
        test: "exact two-sided binomial",
        interval: "Wilson score, 95%",
        correction: `Benjamini-Hochberg, FDR ${COHORT_FDR}`,
        min_sample: COHORT_MIN_SAMPLE,
        // Said plainly because the whole point of the endpoint is the caveat.
        note:
          "Cohorts are pre-declared in code, not mined per request — you cannot correct for tests you don't admit to running. `validated` is the only list any surface may call an edge; `exploratory` cohorts reach p<0.05 alone but not as best-of-N, and are published for steering, not for quoting. Cohorts that select an identical arrow set are collapsed to one hypothesis before correction and listed in `confounds`.",
      },
    },
    {
      headers: {
        "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600",
      },
    },
  );
}
