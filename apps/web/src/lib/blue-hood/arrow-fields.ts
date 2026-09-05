/**
 * Arrow field projection — what the LIST response carries vs. what exists.
 *
 * WHY: `/api/hood/arrows?limit=200` is 49,771 B gzip (measured against
 * production 2026-08-28, n=200). Four fields are 26.3% of that and **no client
 * renders any of them** — verified by grep, not assumed: every reference to all
 * four lives in server code (grader, rule-engine, push, alerts, cron routes),
 * which reads arrow records from KV directly and never through this HTTP shape.
 * Zero `.tsx` references. `chat-card.ts` names `snapshot_refs` only in a comment
 * saying it deliberately excludes it.
 *
 *   grading_math       8,766 B  17.6%   (present on 175/200)
 *   ticker_confidence  1,920 B   3.9%   (135/200)
 *   brief_worker_at    1,657 B   3.3%   (200/200)
 *   snapshot_refs        828 B   1.7%   (200/200)
 *   ───────────────────────────────────
 *   all four          13,084 B  26.3%   49,771 → 36,687 B gzip
 *
 * Two surfaces poll that exact URL (Inbox, Track Record), so this is real
 * repeated bandwidth, not a one-off page weight.
 *
 * ⚠ THIS IS A PROJECTION, NOT A DELETION. The fields stay on the record, stay
 * in KV, stay in `Arrow`, and stay reachable over HTTP at `?fields=full`.
 * `grading_math` in particular is the ONLY thing that makes the "oracle catches
 * up vs DEX reverts" decomposition answerable — the 2026-08-12 attempt could
 * only decompose 9 of 112 arrows precisely because those close-side levels
 * weren't stored yet. Dropping it from the wire would re-create the exact
 * blindness that field was added to fix. Trimming a default is a perf change;
 * removing the data is destroying the audit trail, and they are not the same
 * change even though they look identical in a diff.
 *
 * The list response also NAMES what it omitted and how to get it back (see
 * `omittedFieldsNote`). An escape hatch nobody can discover is not an escape
 * hatch — it costs ~120 B once per response, not per arrow.
 *
 * NOT applied to `/api/acp/arrows`. ACP consumers are third-party agents that
 * store what we hand them, so its response shape is a contract with someone
 * else's system; and it isn't polled by our UI, so trimming it would buy
 * nothing while silently changing an audit surface. Deliberate asymmetry.
 */
import type { Arrow } from "./types";

/**
 * Single source of truth for the trim. The projection and the self-describing
 * `omitted_fields` in the response both read this, so they cannot drift into
 * a response that hides a field it doesn't admit to hiding.
 */
export const LIST_OMITTED_FIELDS = [
  "grading_math",
  "ticker_confidence",
  "snapshot_refs",
  "brief_worker_at",
] as const;

export type ListOmittedField = (typeof LIST_OMITTED_FIELDS)[number];

/** An arrow as it appears in a default list response. */
export type ListArrow = Omit<Arrow, ListOmittedField>;

export type ArrowFieldMode = "list" | "full";

/**
 * `?fields=full` → every field. Anything else (absent, empty, typo, "list")
 * → the trimmed default.
 *
 * Fails toward the SMALLER payload on a malformed value, which is the safe
 * direction: a typo costs a caller four fields they can retry for, whereas
 * defaulting to full on garbage input would let a stray query string quietly
 * restore the 26% and make the win unobservable in prod metrics.
 */
export function parseArrowFieldMode(params: URLSearchParams): ArrowFieldMode {
  return params.get("fields") === "full" ? "full" : "list";
}

/**
 * Copy without the four fields. Destructuring-rest, NOT `delete` — these
 * records come straight out of the hydrated blob cache (#148 ②), and mutating
 * them in place would strip the fields from the cached objects that other
 * routes (and the next request served from the same warm process) still read.
 * A projection that corrupts its input is a deletion with extra steps.
 */
export function projectArrowForList(arrow: Arrow): ListArrow {
  const {
    grading_math:      _gradingMath,
    ticker_confidence: _tickerConfidence,
    snapshot_refs:     _snapshotRefs,
    brief_worker_at:   _briefWorkerAt,
    ...rest
  } = arrow;
  return rest;
}

export function projectArrows(arrows: Arrow[], mode: ArrowFieldMode): Arrow[] | ListArrow[] {
  return mode === "full" ? arrows : arrows.map(projectArrowForList);
}

/**
 * The response's own description of what it left out. Present on BOTH modes:
 * on `full` it reports an empty list, so a consumer can tell "nothing was
 * trimmed" from "this endpoint doesn't trim" without reading our docs.
 */
export function omittedFieldsNote(mode: ArrowFieldMode) {
  return mode === "full"
    ? { fields: "full" as const, omitted_fields: [] as string[] }
    : {
        fields: "list" as const,
        omitted_fields: [...LIST_OMITTED_FIELDS],
        omitted_hint: "Audit/provenance fields, omitted from the default list to cut ~26% of payload. Add ?fields=full to get them — they are still stored and are NOT deleted.",
      };
}
