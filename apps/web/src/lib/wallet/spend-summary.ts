/**
 * The agent's spend console — one answer across BOTH rails that pay for a tool.
 *
 * A Hub tool call can be paid two completely different ways, and until now each
 * had its own page that knew nothing about the other:
 *
 *   x402   → real USDC on Base, per call, settled via CDP. `spend:<addr>`.
 *   credits→ an off-chain metered balance, debited per call. `ledger:<addr>`.
 *
 * So "what did my agent spend" had two half-answers and no whole one. This file
 * is the whole one. It groups both rails by tool and by day so /wallet can show
 * the thing no block explorer can: not that money left, but what it bought.
 *
 * ─── The one number this file refuses to compute ────────────────────────────
 *
 * It NEVER adds credits to USDC, and never converts a single credit event into
 * dollars. There is a published rate (CREDITS_PER_USDC), so the arithmetic is
 * trivial and the result would be wrong:
 *
 *   `spend()` drains the FREE daily allowance first and only the overflow
 *   reaches the paid pool — but the event it writes records the TOTAL and never
 *   the split. A 50-credit event may have cost the user nothing at all.
 *
 * Multiply that by $0.0005 and you have told a user they spent money they did
 * not spend. The only honest dollar figure on the credit rail is
 * `credits.paidAllTime`, which `spend()` accumulates on the row itself — and it
 * is a lifetime aggregate, so it cannot be attributed to any single tool either.
 * Hence two columns, side by side, never one.
 *
 * ─── Windows, not lifetimes ─────────────────────────────────────────────────
 *
 * Both underlying rows are deliberately bounded (100 receipts / 90-day TTL;
 * HISTORY_CAP ledger events). Every per-tool and per-day figure here is
 * therefore a FLOOR over a recorded window, not an all-time total, and the
 * flags that say so travel with the data instead of being re-derived by
 * whoever renders it.
 *
 * ─── What is deliberately absent ────────────────────────────────────────────
 *
 * "Spend per session" was in the brief and is NOT here, because it is not in
 * the data: neither rail records a session or conversation id (`ref` is unset
 * on every chat debit). Grouping calls into "sessions" by clustering timestamps
 * would be a guess rendered as a fact — the same move as naming a payment from
 * "amount ≈ a catalog price", which this whole surface exists to not do.
 */
import { getSpendLog } from "@/lib/wallet/spend-log";
import { getLedgerHistory } from "@/lib/credit-ledger";

/** Per-rail, because the rails fail independently and one may be readable. */
export type RailStatus = "ok" | "unavailable";

export type ToolSrc = "first-party" | "community";

export interface ToolSpend {
  /** Catalog id (first-party) or Hub slug (community) — never a display name. */
  tool: string;
  src: ToolSrc;
  /** Exact money, from x402 receipts. USDC micro-units. */
  usdcUnits: number;
  usdcCalls: number;
  /** Metered units, from the credit ledger. NOT dollars. See the header. */
  credits: number;
  creditCalls: number;
  /** Most recent activity on either rail, ms epoch. */
  lastTs: number;
}

export interface DayBucket {
  /** YYYY-MM-DD, UTC — the same day key the ledger's daily allowance uses. */
  day: string;
  usdcUnits: number;
  credits: number;
  calls: number;
}

export interface SpendSummary {
  usdc: {
    status: RailStatus;
    /** Σ over the recorded receipt window. A floor, not a lifetime total. */
    units: number;
    calls: number;
  };
  credits: {
    status: RailStatus;
    /** Σ of spend events in the recorded window. A floor. */
    spentInWindow: number;
    callsInWindow: number;
    /**
     * Credits drained from the PAID pool, all-time. Survives the history cap,
     * and is the only credit figure that may be shown in dollars — in aggregate
     * only, never attributed to a tool.
     */
    paidAllTime: number;
    /** The event list hit its cap, so the window figures are certainly partial. */
    truncated: boolean;
  };
  /** Chat spend. Real, but not a tool — kept out of `tools` so it can't pose as one. */
  chat: { credits: number; calls: number };
  /**
   * Debits whose `reason` we could not classify. Counted in the totals but
   * attributed to nothing.
   *
   * These were dropped entirely at first, which was wrong in the direction that
   * matters: the credits WERE spent, so omitting them under-reports the user's
   * own spending and leaves the tool rows silently failing to add up to the
   * headline. "We know it was spent, we do not know on what" is the same shape
   * as a timeline row that names the payee but not the tool — it gets shown,
   * not hidden.
   */
  other: { credits: number; calls: number };
  /** Descending by USDC, then by credits. */
  tools: ToolSpend[];
  /** Dense, oldest → newest, one entry per UTC day including zero days. */
  days: DayBucket[];
  /** True when either rail could not be read — the totals are then incomplete. */
  partial: boolean;
  ts: number;
}

const DAY_WINDOW = 30;

const utcDay = (ts: number) => new Date(ts).toISOString().slice(0, 10);

/**
 * Merge key.
 *
 * Keyed on `src` AND `tool`, never `tool` alone. A community slug is free-form
 * and lives in a different namespace than AGENT_TOOLS, so a hosted tool slugged
 * "token-price" WILL collide with the first-party tool of that id. Keyed on the
 * id alone their spend would silently pool into one row, and the user would be
 * shown a single total for two unrelated products — the same class of mistake
 * as rendering one under the other's display name (see spend-log.ts).
 */
// `\u001F` (ASCII unit separator), not a space: it is the character designated
// for exactly this and cannot occur in a catalog id or a free-form Hub slug.
const mergeKey = (src: ToolSrc, tool: string) => `${src}\u001F${tool}`;

/**
 * Parse a ledger `reason` into what it actually refers to.
 *
 * Shapes in the wild: `tool:<catalog-id>` (x402 route, credits path),
 * `chat:<tier>` (chat route), `topup:<pack>` (top-ups, filtered out earlier).
 * The internal /api/credits/spend route accepts a free-form reason, so anything
 * unrecognised is classified `other` and dropped rather than guessed at.
 *
 * The credits rail is first-party by construction — the community/hosted rail
 * is x402-only and never debits credits — so a `tool:` reason resolves against
 * the catalog. That is an invariant of today's call sites, not a law, which is
 * why unknown ids still degrade to a raw string downstream instead of a name.
 */
function parseReason(reason: string): { kind: "tool"; id: string } | { kind: "chat" } | { kind: "other" } {
  if (typeof reason !== "string") return { kind: "other" };
  if (reason.startsWith("tool:")) {
    const id = reason.slice(5).trim();
    return id ? { kind: "tool", id } : { kind: "other" };
  }
  if (reason.startsWith("chat:")) return { kind: "chat" };
  return { kind: "other" };
}

/**
 * Build the console for one wallet.
 *
 * Never throws and never reports a rail as empty when it is merely unreadable —
 * a spend console that renders a KV outage as "you have spent nothing" tells a
 * paying user a falsehood about their own money.
 */
export async function getSpendSummary(address: string): Promise<SpendSummary> {
  const [receipts, ledger] = await Promise.all([
    getSpendLog(address),
    getLedgerHistory(address),
  ]);

  const byTool = new Map<string, ToolSpend>();
  const byDay = new Map<string, DayBucket>();

  const bump = (ts: number, patch: Partial<DayBucket>) => {
    const day = utcDay(ts);
    const cur = byDay.get(day) ?? { day, usdcUnits: 0, credits: 0, calls: 0 };
    cur.usdcUnits += patch.usdcUnits ?? 0;
    cur.credits   += patch.credits ?? 0;
    cur.calls     += patch.calls ?? 0;
    byDay.set(day, cur);
  };

  const touch = (src: ToolSrc, tool: string, ts: number): ToolSpend => {
    const k = mergeKey(src, tool);
    const cur = byTool.get(k)
      ?? { tool, src, usdcUnits: 0, usdcCalls: 0, credits: 0, creditCalls: 0, lastTs: 0 };
    cur.lastTs = Math.max(cur.lastTs, ts);
    byTool.set(k, cur);
    return cur;
  };

  // ── x402 rail: real money, exact, per call ────────────────────────────────
  let usdcUnits = 0;
  let usdcCalls = 0;
  for (const r of receipts ?? []) {
    const src: ToolSrc = r.src === "community" ? "community" : "first-party";
    const row = touch(src, r.tool, r.ts);
    row.usdcUnits += r.units;
    row.usdcCalls += 1;
    usdcUnits += r.units;
    usdcCalls += 1;
    bump(r.ts, { usdcUnits: r.units, calls: 1 });
  }

  // ── credits rail: metered units, NOT money (see header) ───────────────────
  let creditsInWindow = 0;
  let creditCalls = 0;
  let chatCredits = 0;
  let chatCalls = 0;
  let otherCredits = 0;
  let otherCalls = 0;
  for (const e of ledger?.history ?? []) {
    if (e.kind !== "spend") continue;              // top-ups are not spending
    const amount = Number.isFinite(e.amount) ? e.amount : 0;
    if (amount <= 0) continue;
    const what = parseReason(e.reason);

    if (what.kind === "chat") {
      chatCredits += amount;
      chatCalls += 1;
    } else if (what.kind === "tool") {
      const row = touch("first-party", what.id, e.ts);
      row.credits += amount;
      row.creditCalls += 1;
    } else {
      // Unattributable, NOT ignored: it still counts toward the total below, it
      // just never gets a tool name invented for it.
      otherCredits += amount;
      otherCalls += 1;
    }

    creditsInWindow += amount;
    creditCalls += 1;
    bump(e.ts, { credits: amount, calls: 1 });
  }

  // Dense day series so a chart cannot imply activity in a gap it never had.
  const today = Date.now();
  const days: DayBucket[] = [];
  for (let i = DAY_WINDOW - 1; i >= 0; i--) {
    const day = utcDay(today - i * 86_400_000);
    days.push(byDay.get(day) ?? { day, usdcUnits: 0, credits: 0, calls: 0 });
  }

  const tools = [...byTool.values()].sort(
    (a, b) => b.usdcUnits - a.usdcUnits || b.credits - a.credits || b.lastTs - a.lastTs,
  );

  return {
    usdc: {
      status: receipts == null ? "unavailable" : "ok",
      units: usdcUnits,
      calls: usdcCalls,
    },
    credits: {
      status: ledger == null ? "unavailable" : "ok",
      spentInWindow: creditsInWindow,
      callsInWindow: creditCalls,
      paidAllTime: ledger?.spentFromPool ?? 0,
      truncated: ledger?.truncated ?? false,
    },
    chat: { credits: chatCredits, calls: chatCalls },
    other: { credits: otherCredits, calls: otherCalls },
    tools,
    days,
    partial: receipts == null || ledger == null,
    ts: Date.now(),
  };
}
