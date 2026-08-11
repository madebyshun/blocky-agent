/**
 * Blue Hood — arrow brief fetcher.
 *
 * Wraps A4 (`rh-stock-agent-brief`) so the rule engine can attach a
 * 1-2 sentence "why" to every newly-fired arrow. Contract with the caller:
 *
 *   • Call happens EXACTLY ONCE per arrow, at fire time. The result is
 *     persisted on the arrow record. UI reads a static field, never re-hits
 *     the LLM.
 *   • A4 failure = arrow still fires with `brief: null`. The arrow's
 *     numbers stand on their own; the brief is purely narrative context.
 *   • A4's own `warnings` (feed_abnormally_stale, thin_dex_pool,
 *     llm_context_unavailable, …) are carried through verbatim.
 */
import { callTool } from "./tool-caller";
import type { ArrowBrief } from "./types";

// Subset of A4's response we care about — kept here so a change in the
// tool trips a compile error before we start silently persisting stale
// fields.
interface A4Response {
  verdict: string;
  verdict_note?: string;
  one_line_context?: string | null;
  warnings?: string[];
  facts?: {
    dex_price_usd?: number | null;
    oracle_price_usd?: number | null;
    dex_tvl_usd?: number | null;
    dex_volume_24h_usd?: number | null;
    dex_change_24h_pct?: number | null;
    chainlink_age_seconds?: number | null;
  };
  llm?: {
    provider?: string | null;
    attempts?: Array<{
      provider?: string;
      status?: "success" | "error";
      duration_ms?: number;
      error?: string;
    }>;
  };
}

/**
 * Fetch the brief for a ticker. Never throws; returns null on any failure
 * so the caller can persist `arrow.brief = null` and move on.
 */
export async function fetchArrowBrief(ticker: string): Promise<ArrowBrief | null> {
  // A4 runs the Virtuals → Venice → Bankr LLM chain internally. Give it
  // a generous timeout — Virtuals is usually 2-5s, Bankr fallback ~10s.
  const r = await callTool<A4Response>("rh-stock-agent-brief", { ticker }, { timeoutMs: 25_000 });
  if (!r.ok) {
    console.warn(`[brief] A4 call failed for ${ticker}: ${r.status} ${r.error}`);
    return null;
  }
  const d = r.data;
  if (!d || !d.verdict_note) {
    // If the LLM chain failed but the tool still 200'd, we may not have a
    // verdict_note — treat that as "no brief" rather than an empty shell.
    return null;
  }
  const attempts = Array.isArray(d.llm?.attempts) ? d.llm!.attempts : [];
  const normalized = attempts
    .map((a) => ({
      provider: String(a?.provider ?? ""),
      status: a?.status === "success" ? "success" : "error" as const,
      duration_ms: typeof a?.duration_ms === "number" ? a.duration_ms : 0,
      ...(a?.error ? { error: String(a.error) } : {}),
    }))
    .filter((a): a is { provider: string; status: "success" | "error"; duration_ms: number; error?: string } => Boolean(a.provider));
  const facts = d.facts ?? {};
  const facts_at_fire = {
    dex_price_usd: facts.dex_price_usd ?? null,
    oracle_price_usd: facts.oracle_price_usd ?? null,
    dex_tvl_usd: facts.dex_tvl_usd ?? null,
    dex_volume_24h_usd: facts.dex_volume_24h_usd ?? null,
    dex_change_24h_pct: facts.dex_change_24h_pct ?? null,
    chainlink_age_seconds: facts.chainlink_age_seconds ?? null,
  };

  // T-A.1 #2 — brief_number_drift guard. Extract every "X%" the LLM
  // one-liner cites and reconcile against facts_at_fire percentage
  // fields. Anything drifting > 0.1 pp gets a warning appended so a
  // viewer + prod alerting can catch confabulation without needing a
  // human eyeball. Silent on numbers that don't map to a known fact
  // (e.g. "50%" as a colloquial phrase) — better to under-flag than
  // false-positive.
  const driftWarnings = detectBriefNumberDrift(d.one_line_context ?? null, facts_at_fire);

  return {
    verdict_note: d.verdict_note,
    one_line_context: (typeof d.one_line_context === "string" ? d.one_line_context : null),
    warnings: [...(Array.isArray(d.warnings) ? d.warnings : []), ...driftWarnings],
    llm_provider: d.llm?.provider ?? null,
    llm_attempts: normalized,
    facts_at_fire,
    fetched_at: new Date().toISOString(),
  };
}

// ── brief_number_drift detector ────────────────────────────────────────────
// Regex captures signed percentage tokens: "+1.57%", "-1.42%", "1.57%".
// For every hit we search facts_at_fire.*_pct and warn when NONE lie
// within 0.1 pp. We do NOT try to match multiple pct fields (e.g. price
// change vs slippage); if the closest fact is within tolerance we're
// good, otherwise we flag.
export function detectBriefNumberDrift(
  text: string | null,
  facts: {
    dex_change_24h_pct: number | null;
    // Extend as we add more pct fields to the snapshot.
  },
): string[] {
  if (!text) return [];
  const factValues = Object.entries(facts)
    .filter(([, v]) => typeof v === "number")
    .map(([k, v]) => ({ key: k, value: v as number }));
  if (factValues.length === 0) return [];

  const warnings: string[] = [];
  const re = /([+-]?\d+(?:\.\d+)?)\s*%/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const cited = Number(m[1]);
    if (!Number.isFinite(cited)) continue;
    // Absolute-value comparison — LLM may drop the sign ("1.57% decline"
    // instead of "-1.57%"). We compare |cited| vs |fact| within tolerance.
    const closest = factValues.reduce<{ key: string; value: number; d: number }>(
      (best, f) => {
        const d = Math.abs(Math.abs(cited) - Math.abs(f.value));
        return d < best.d ? { key: f.key, value: f.value, d } : best;
      },
      { key: "", value: 0, d: Number.POSITIVE_INFINITY },
    );
    if (closest.d > 0.1) {
      warnings.push(
        `brief_number_drift: LLM cited ${cited}% but closest fact ${closest.key}=${closest.value.toFixed(2)}% (drift ${closest.d.toFixed(2)}pp > 0.1pp)`,
      );
    }
  }
  return warnings;
}
