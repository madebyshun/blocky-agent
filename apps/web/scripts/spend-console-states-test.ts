/**
 * spend-console-states-test — the honesty matrix for AGENT SPEND.
 *
 *   npm run test:spend-console
 *
 * On 2026-08-27 Upstash suspended the production database for exceeding its
 * budget. Every KV rail went dark at once, and /wallet rendered this:
 *
 *     AGENT SPEND                              no activity recorded
 *     ┌──────────────────────────────────────────────────────────┐
 *     │  Both spend stores are unreachable right now.             │
 *     │  That is not the same as zero — nothing has been lost.    │
 *     └──────────────────────────────────────────────────────────┘
 *
 * The body was right and the header contradicted it in the same breath. Same
 * shape as "Stablecoin 0%" printed under "No assets yet" (#322) — a known-empty
 * claim next to an admission that we do not know — reintroduced one PR after
 * that one was fixed, because the render guard asked whether the FETCH had
 * succeeded and a 200 carrying two dead rails answers yes.
 *
 * The near-identical second instance was NOT on screen: `emptyState` was gated
 * on `bothDown`, a hole exactly one rail wide, so a single dark rail beside a
 * readable-and-empty one would have printed "No agent spending recorded yet".
 * It had simply never happened yet.
 *
 * Hence a matrix rather than a fix. Both bugs are one wrong term in a boolean
 * over rail status; neither is visible to a type-checker or a build, and neither
 * shows up in the common case where everything is up. The way this class of
 * error gets caught is by enumerating the states and asserting the sentence.
 *
 * Pure functions only — no React, no DOM, no network. It imports the two
 * decisions out of the component and leaves the markup alone.
 */
import { scopeLabel, emptyState, type SpendSummaryDTO, type RailStatus } from "../src/components/SpendConsole";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}\n        got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

const DAY = 86_400_000;

/** A DTO with everything zeroed; each case overrides only what it is about. */
function dto(over: {
  usdc?: RailStatus;
  credits?: RailStatus;
  oldestTs?: number | null;
  tools?: number;
  chatCalls?: number;
  otherCalls?: number;
  dayCalls?: number;
} = {}): SpendSummaryDTO {
  return {
    usdc:    { status: over.usdc ?? "ok", units: 0, calls: 0 },
    credits: {
      status: over.credits ?? "ok",
      spentInWindow: 0, callsInWindow: 0, paidAllTime: 0, truncated: false,
    },
    chat:  { credits: 0, calls: over.chatCalls ?? 0 },
    other: { credits: 0, calls: over.otherCalls ?? 0 },
    tools: Array.from({ length: over.tools ?? 0 }, (_, i) => ({
      tool: `tool-${i}`, name: null, src: "first-party" as const,
      usdcUnits: 50_000, usdcCalls: 1, credits: 0, creditCalls: 0, lastTs: Date.now(),
    })),
    days: [{ day: "2026-08-27", usdcUnits: 0, credits: 0, calls: over.dayCalls ?? 0 }],
    oldestTs: over.oldestTs === undefined ? null : over.oldestTs,
    partial: (over.usdc ?? "ok") === "unavailable" || (over.credits ?? "ok") === "unavailable",
    creditsPerUsdc: 2000,
    ts: Date.now(),
  };
}

console.log("── scopeLabel: the header may never out-claim the rails ──────────────\n");

// The live outage, exactly. This is the regression.
check(
  "both rails dark, no rows → header stays silent (was: 'no activity recorded')",
  scopeLabel(dto({ usdc: "unavailable", credits: "unavailable" })),
  null,
);

// One rail dark and the other genuinely empty. One rail's emptiness is not a
// statement about the wallet.
check(
  "x402 dark, credits empty → silent",
  scopeLabel(dto({ usdc: "unavailable" })),
  null,
);
check(
  "credits dark, x402 empty → silent",
  scopeLabel(dto({ credits: "unavailable" })),
  null,
);

// Everything answered and everything empty: now it is a fact, so say it.
check(
  "both rails up, no rows → 'no activity recorded' is a fact",
  scopeLabel(dto()),
  "no activity recorded",
);

// A real span, fully readable.
check(
  "both up, oldest 5 days ago → 'last 5 days'",
  scopeLabel(dto({ oldestTs: Date.now() - 5 * DAY })),
  "last 5 days",
);
check("both up, oldest today → 'today'", scopeLabel(dto({ oldestTs: Date.now() - 1000 })), "today");
check(
  "both up, oldest yesterday → 'since yesterday'",
  scopeLabel(dto({ oldestTs: Date.now() - 1.2 * DAY })),
  "since yesterday",
);

// A span measured over one rail while the other is dark is a floor, and the
// label has to carry that or it reads as the whole window.
check(
  "credits dark but x402 has 5 days → marked partial, not passed off as the window",
  scopeLabel(dto({ credits: "unavailable", oldestTs: Date.now() - 5 * DAY })),
  "last 5 days · partial",
);

console.log("\n── emptyState: which 'nothing here' sentence is allowed ──────────────\n");

check("both up, nothing recorded → 'none' (the plain empty state)", emptyState(dto()), "none");

// The one-rail hole. Never rendered in production, but only because this exact
// combination had not occurred yet.
check(
  "x402 dark, credits readable-and-empty → 'unreadable' (was: the empty state)",
  emptyState(dto({ usdc: "unavailable" })),
  "unreadable",
);
check(
  "credits dark, x402 readable-and-empty → 'unreadable'",
  emptyState(dto({ credits: "unavailable" })),
  "unreadable",
);
check(
  "both dark → 'unreadable'",
  emptyState(dto({ usdc: "unavailable", credits: "unavailable" })),
  "unreadable",
);

// Any one of the four row sources is enough to have something to draw. Each is
// checked alone, because an `&&` chain hides a wrong term until the one input
// that would expose it shows up — which is how the bug above survived.
check("a tool row → 'rows'",        emptyState(dto({ tools: 1 })),      "rows");
check("a chat call → 'rows'",       emptyState(dto({ chatCalls: 3 })),  "rows");
check("an unattributed call → 'rows'", emptyState(dto({ otherCalls: 2 })), "rows");
check("a day with calls → 'rows'",  emptyState(dto({ dayCalls: 7 })),   "rows");

// Rows win over a dark rail: there IS something to draw, and the rail component
// prints its own "unavailable" beside it.
check(
  "rows present but a rail is dark → still 'rows'",
  emptyState(dto({ tools: 1, credits: "unavailable" })),
  "rows",
);

console.log("\n── controls: the pre-fix logic, same inputs ──────────────────────────\n");

// These assert the WRONG answers, on purpose. Without them the file proves only
// that today's code is self-consistent, never that either bug was real — and one
// of the two was found on production, not here.

/** The header label as #324 shipped it: status-blind, `oldestTs` and nothing else. */
function scopeLabel_ORIGINAL(oldestTs: number | null): string {
  if (oldestTs == null) return "no activity recorded";
  const days = Math.floor((Date.now() - oldestTs) / DAY);
  if (days <= 0) return "today";
  if (days === 1) return "since yesterday";
  return `last ${days} days`;
}

/** The empty-state test as #324 shipped it, inline in Body: gated on `bothDown`. */
function nothingYet_ORIGINAL(d: SpendSummaryDTO): boolean {
  const bothDown = d.usdc.status === "unavailable" && d.credits.status === "unavailable";
  const other = d.other ?? { credits: 0, calls: 0 };
  return (
    !bothDown &&
    d.tools.length === 0 &&
    d.chat.calls === 0 &&
    other.calls === 0 &&
    !d.days.some(x => x.calls > 0)
  );
}

check(
  "ORIGINAL header, both rails dark → claimed 'no activity recorded' (the live bug)",
  scopeLabel_ORIGINAL(dto({ usdc: "unavailable", credits: "unavailable" }).oldestTs),
  "no activity recorded",
);
check(
  "ORIGINAL header, one rail dark with a 5-day span → claimed the full window",
  scopeLabel_ORIGINAL(dto({ credits: "unavailable", oldestTs: Date.now() - 5 * DAY }).oldestTs),
  "last 5 days",
);
check(
  "ORIGINAL empty-state, one rail dark → would have printed the empty state",
  nothingYet_ORIGINAL(dto({ usdc: "unavailable" })),
  true,
);
check(
  "ORIGINAL empty-state, both dark → correctly suppressed (why only half showed up)",
  nothingYet_ORIGINAL(dto({ usdc: "unavailable", credits: "unavailable" })),
  false,
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
