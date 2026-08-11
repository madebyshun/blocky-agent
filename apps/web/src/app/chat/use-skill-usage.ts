"use client";

// useSkillUsage — real run counts for the skills catalog, read from /api/usage.
//
// The numbers are `usage:<id>` KV counters incremented by the surfaces that
// actually execute something (x402 paid runs, MCP hub-tool calls, hosted
// community tools, and the 5 console commands). A skill declares which counters
// belong to it via `meterIds`; we sum them.
//
// Two honesty rules the return type enforces:
//
//   1. A skill with NO `meterIds` has no instrumented backend, so its run count
//      is UNKNOWN — not zero. `runsOf` returns null for those and the UI renders
//      nothing. Printing "0 runs" would state a measurement we never took, and
//      it reads as "nobody uses this" rather than "we don't count this".
//   2. The counters are FORWARD-ONLY — each starts at the moment its surface was
//      instrumented, not at launch. So even a real 0 is not "never used". The UI
//      only shows a count once it is > 0 (matching the Hub's `runs > 0 ? … :
//      "new"` treatment).
//
// The fetch is shared module-wide: the panel mounts on /chat and again on the
// standalone /app/skills surface, and both want the same snapshot rather than
// two round-trips.

import { useEffect, useState } from "react";
import type { AgentSkill } from "./agent-skills";

export type UsageMap = Record<string, number>;

// One in-flight request for the whole tab. Nulled on failure so a later mount
// can retry rather than caching a permanent empty map.
let inflight: Promise<UsageMap> | null = null;

function loadUsage(): Promise<UsageMap> {
  if (!inflight) {
    inflight = fetch("/api/usage")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .catch(() => {
        inflight = null;
        return {} as UsageMap;
      });
  }
  return inflight;
}

export function useSkillUsage() {
  const [usage, setUsage] = useState<UsageMap | null>(null);

  useEffect(() => {
    let live = true;
    loadUsage().then((u) => { if (live) setUsage(u); });
    return () => { live = false; };
  }, []);

  /** Total recorded runs for a skill, or null when we don't measure it (no
   *  meterIds) or haven't loaded yet. Never returns a fabricated 0. */
  function runsOf(skill: AgentSkill): number | null {
    if (!usage || !skill.meterIds?.length) return null;
    return skill.meterIds.reduce((sum, id) => sum + (usage[id] ?? 0), 0);
  }

  return { usage, runsOf, loaded: usage !== null };
}
