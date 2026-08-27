"use client";

/**
 * AGENT SPEND — the wallet's reason to exist.
 *
 * Every other wallet can show that 0.05 USDC left for `0x0295…`. None of them
 * can show WHAT IT BOUGHT, because the tool id only ever existed in the request
 * that triggered the payment. This panel is that join, aggregated: per tool,
 * per day, across both rails that pay for a Hub call.
 *
 * Mounted in TWO places, which is why it lives in `components/` and not under a
 * route folder: /wallet (the spend console proper) and the Blue Hub home, where
 * the money is actually spent. Hub gates it on a connected address so the
 * `disconnected` branch below is a /wallet-only state — but the branch has to
 * exist regardless, and getting it wrong is what made this file move at all.
 *
 * ─── Two columns, never one ─────────────────────────────────────────────────
 *
 * USDC and credits are NOT added together anywhere in this file, and no single
 * credit figure is printed in dollars. The reason is in spend-summary.ts and is
 * worth repeating where someone might "tidy this up": a credit debit drains the
 * FREE daily allowance first, and the event records only the total — so a
 * 50-credit call may have cost the user nothing. There is a published rate, so
 * the conversion is one multiplication away and would be a fabricated number.
 *
 * The single exception is `credits.paidAllTime`, which the ledger accumulates
 * separately and which therefore IS real money — shown once, as a lifetime
 * aggregate, never attributed to a tool.
 *
 * ─── The chart measures calls, not money ────────────────────────────────────
 *
 * Bar height is CALLS, which is the one unit both rails genuinely share. A
 * stacked money bar would require exactly the addition described above.
 *
 * ─── Floors, not totals ─────────────────────────────────────────────────────
 *
 * Both stores are bounded (100 receipts / 90-day TTL; HISTORY_CAP ledger
 * events). Everything here is a floor over a recorded window and says so. The
 * flags come from the API rather than being re-derived here — a component that
 * decides on its own when to print "all-time" is how a total starts lying.
 */

import { useEffect, useState } from "react";

export type RailStatus = "ok" | "unavailable";

export interface ToolSpendRow {
  tool: string;
  name: string | null;
  src: "first-party" | "community";
  usdcUnits: number;
  usdcCalls: number;
  credits: number;
  creditCalls: number;
  lastTs: number;
}

export interface DayBucket {
  day: string;
  usdcUnits: number;
  credits: number;
  calls: number;
}

export interface SpendSummaryDTO {
  usdc: { status: RailStatus; units: number; calls: number };
  credits: {
    status: RailStatus;
    spentInWindow: number;
    callsInWindow: number;
    paidAllTime: number;
    truncated: boolean;
  };
  chat: { credits: number; calls: number };
  /** Debits we could not attribute to a tool. Counted in the headline, named nowhere. */
  other: { credits: number; calls: number };
  tools: ToolSpendRow[];
  days: DayBucket[];
  /** Oldest row inside the totals, ms epoch — the scope label comes from this. */
  oldestTs: number | null;
  partial: boolean;
  creditsPerUsdc: number;
  ts: number;
}

/**
 * How far back the numbers on the rails actually reach.
 *
 * This header used to be a hard-coded "last 30 days" and that was wrong: 30 is
 * the length of the CHART, while the rails sum the entire recorded window (up
 * to 100 receipts / 90-day TTL on x402, HISTORY_CAP events with no time bound
 * on credits). A receipt from 60 days ago is inside the total and outside the
 * chart, so the label overstated nothing and understated the window — either
 * way it described a span the number did not have, which is the same mistake
 * as "NET WORTH" over a stablecoins-only figure (#322).
 *
 * Derived from the oldest row that was actually counted, so it cannot drift
 * from the data no matter which cap bites first.
 *
 * ⚠ Returns `null` for "no span can be stated", which is NOT the same as the
 * string "no activity recorded". `oldestTs` is null in two situations that look
 * identical from here and are opposites: nothing was spent, or nothing could be
 * read. The first shipped as the second on 2026-08-27, when Upstash suspended
 * the production database and /wallet printed "no activity recorded" in the
 * header directly above two rails that said "unavailable" — the exact adjacency
 * bug as "Stablecoin 0%" under "No assets yet" (#322), reintroduced one PR after
 * it was fixed, because the render guard checked whether the FETCH succeeded and
 * a 200 carrying two dead rails passes that test.
 *
 * So the statuses are read here, and read from the same two fields the rails
 * themselves render — not from the sibling `partial` flag, which is derived from
 * the same nulls but is a second copy of the fact. One source, so the header and
 * the rails under it cannot contradict each other.
 */
export function scopeLabel(d: SpendSummaryDTO): string | null {
  const usdcDown = d.usdc.status === "unavailable";
  const crDown   = d.credits.status === "unavailable";

  // Neither rail readable → there is no window to describe. Silence, because
  // "no activity" is precisely the claim the rails below are refusing to make.
  if (usdcDown && crDown) return null;

  if (d.oldestTs == null) {
    // The readable rail is genuinely empty — a fact. But if the OTHER one is
    // unknown, the wallet as a whole still is, and one rail's emptiness must
    // not be promoted into a statement about both.
    return usdcDown || crDown ? null : "no activity recorded";
  }

  const days = Math.floor((Date.now() - d.oldestTs) / 86_400_000);
  const span = days <= 0 ? "today" : days === 1 ? "since yesterday" : `last ${days} days`;
  // A span measured over one rail while the other is unreadable is a floor, not
  // the window. Say so rather than let it read as the whole picture.
  return usdcDown || crDown ? `${span} · partial` : span;
}

/**
 * Which "there is nothing here" sentence the body may print.
 *
 * `"none"` — every rail answered and every rail is empty. A fact.
 * `"unreadable"` — the rails that answered are empty, and at least one did not.
 *                  Half a picture, and must not be worded as an empty wallet.
 * `"rows"` — there is something to draw.
 *
 * The distinction was previously `!bothDown`, a hole exactly one rail wide: with
 * x402 dark and credits readable-and-empty, every other term held and the page
 * printed "No agent spending recorded yet" beside a rail reading "unavailable".
 * That is the same adjacency lie as `scopeLabel`'s above and as "Stablecoin 0%"
 * under "No assets yet" (#322) — a known-empty claim sitting next to an
 * admission that we do not know.
 *
 * Exported for scripts/spend-console-states-test.ts, which walks the whole
 * rail × rail × rows matrix. This got to production twice; a build cannot see it
 * and neither could I, so the matrix is written down instead.
 */
export function emptyState(d: SpendSummaryDTO): "none" | "unreadable" | "rows" {
  const other = d.other ?? { credits: 0, calls: 0 };
  const noRows =
    d.tools.length === 0 &&
    d.chat.calls === 0 &&
    other.calls === 0 &&
    !d.days.some(x => x.calls > 0);
  if (!noRows) return "rows";
  return d.usdc.status === "unavailable" || d.credits.status === "unavailable"
    ? "unreadable"
    : "none";
}

/**
 * Four states — and the fourth is the one that was wrong.
 *
 * "loading", "failed" and "disconnected" are each NOT "zero", and they are not
 * each other either. `disconnected` means there is no address to ask about:
 * nothing is in flight, nothing failed, no answer is pending. This used to be
 * folded into `loading`, which was survivable on /wallet (where the page is
 * about a connected wallet) and is a visible lie on Hub, where most visitors
 * are not connected: a spinner that never resolves, for a request never made.
 */
type Load =
  | { s: "disconnected" }
  | { s: "loading" }
  | { s: "ok"; d: SpendSummaryDTO }
  | { s: "failed" };

function useSpendSummary(address?: string): Load {
  // Seeded from the address, not hard-coded to "loading" — the first paint of a
  // disconnected mount must already say so rather than flash a spinner.
  const [state, setState] = useState<Load>(address ? { s: "loading" } : { s: "disconnected" });
  useEffect(() => {
    if (!address) { setState({ s: "disconnected" }); return; }
    let alive = true;
    setState({ s: "loading" });
    fetch(`/api/wallet/spend-summary?address=${address}`)
      .then(r => r.json())
      .then((d: SpendSummaryDTO) => { if (alive) setState({ s: "ok", d }); })
      .catch(() => { if (alive) setState({ s: "failed" }); });
    return () => { alive = false; };
  }, [address]);
  return state;
}

/**
 * Micro-units → dollars. Sub-cent amounts keep four decimals rather than
 * rounding to `$0.01`: at x402 prices a rounded-up cent is a visible
 * overstatement of what the user actually paid.
 */
function usdc(units: number): string {
  const v = units / 1_000_000;
  if (v === 0) return "$0";
  return v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;
}

const nf = (n: number) => n.toLocaleString();

function relDay(day: string): string {
  return day.slice(5); // MM-DD — the year is noise at a 30-day window
}

/** One rail's headline. `sub` is the honest caveat, not decoration. */
function Rail({ label, value, unit, sub, accent, unavailable }: {
  label: string; value: string; unit?: string; sub?: string;
  accent: string; unavailable?: boolean;
}) {
  return (
    <div className="rounded-xl border border-[#1A1A2E] bg-[#0d0d12] p-3.5">
      <div className="font-mono text-[9px] text-slate-600 tracking-widest uppercase">{label}</div>
      {unavailable ? (
        <>
          <div className="font-mono text-[15px] font-bold text-slate-600 mt-1.5">—</div>
          <div className="font-mono text-[9px] text-[#F59E0B] mt-0.5">store unreachable</div>
        </>
      ) : (
        <>
          <div className="font-mono text-xl font-bold mt-1" style={{ color: accent }}>
            {value}
            {unit && <span className="text-[10px] font-normal text-slate-500 ml-1">{unit}</span>}
          </div>
          {sub && <div className="font-mono text-[9px] text-slate-600 mt-0.5">{sub}</div>}
        </>
      )}
    </div>
  );
}

export default function SpendConsole({ address }: { address?: string }) {
  const load = useSpendSummary(address);

  // Two gates, because there are two ways to have nothing worth saying. The
  // transport one (`s === "ok"`) rules out a spinner, an error and a wallet we
  // never asked about; `scopeLabel` returning null rules out a 200 whose rails
  // came back dead. Only the first was here, and the outage found the gap.
  const scope = load.s === "ok" ? scopeLabel(load.d) : null;

  return (
    <div className="rounded-2xl border border-[#1A1A2E] bg-[#0A0A12] p-4 sm:p-5">
      <div className="flex items-baseline justify-between mb-1">
        <div className="font-mono text-[9px] text-slate-500 tracking-widest">AGENT SPEND</div>
        {scope && <div className="font-mono text-[9px] text-slate-700">{scope}</div>}
      </div>
      <p className="font-mono text-[9px] text-slate-600 mb-4 leading-relaxed">
        What your payments actually bought — the part no block explorer can see.
      </p>

      {/* No address means no question was asked — say that, don't spin. */}
      {load.s === "disconnected" && (
        <div className="font-mono text-[10px] text-slate-600 py-8 text-center leading-relaxed">
          Connect a wallet to see what it has spent.<br />
          <span className="text-slate-700">Receipts are per address — there is nothing to look up yet.</span>
        </div>
      )}

      {load.s === "loading" && (
        <div className="font-mono text-[10px] text-slate-600 py-8 text-center">Loading…</div>
      )}

      {load.s === "failed" && (
        <div className="font-mono text-[10px] text-[#F59E0B] py-8 text-center">
          Couldn&apos;t load spending. This is a read failure, not a zero — your history is intact.
        </div>
      )}

      {load.s === "ok" && <Body d={load.d} />}
    </div>
  );
}

function Body({ d }: { d: SpendSummaryDTO }) {
  const usdcDown = d.usdc.status === "unavailable";
  const crDown   = d.credits.status === "unavailable";
  const bothDown = usdcDown && crDown;

  // Real money on the credit rail: the ONE credit figure with a dollar value.
  const paidUsd = d.credits.paidAllTime / d.creditsPerUsdc;

  // Tolerated as absent because a deploy briefly serves this bundle against the
  // previous API. A missing field must degrade to "nothing to show", never to a
  // render crash that takes the whole wallet page down with it.
  const other = d.other ?? { credits: 0, calls: 0 };

  const maxCalls = Math.max(1, ...d.days.map(x => x.calls));
  const anyActivity = d.days.some(x => x.calls > 0);
  const empty = emptyState(d);

  if (bothDown) {
    return (
      <div className="font-mono text-[10px] text-[#F59E0B] py-8 text-center leading-relaxed">
        Both spend stores are unreachable right now.<br />
        <span className="text-slate-600">
          That is not the same as zero — nothing has been lost, retry in a moment.
        </span>
      </div>
    );
  }

  return (
    <>
      {/* ── The two rails, side by side and never summed ──────────────────── */}
      <div className="grid grid-cols-2 gap-3">
        <Rail
          label="USDC · x402"
          value={usdc(d.usdc.units)}
          accent="#4FC3F7"
          unavailable={usdcDown}
          sub={`${nf(d.usdc.calls)} paid call${d.usdc.calls === 1 ? "" : "s"} · on Base`}
        />
        <Rail
          label="Credits"
          value={nf(d.credits.spentInWindow)}
          unit="cr"
          accent="#A78BFA"
          unavailable={crDown}
          sub={`${nf(d.credits.callsInWindow)} call${d.credits.callsInWindow === 1 ? "" : "s"} · metered, not USDC`}
        />
      </div>

      {/* The only credits→dollars conversion in this component, and it is a
          lifetime aggregate. Hidden at zero rather than printing "$0.00 of
          credits were paid for", which reads like a claim about the window. */}
      {!crDown && d.credits.paidAllTime > 0 && (
        <p className="font-mono text-[9px] text-slate-600 mt-2">
          Of your credits ever spent, {nf(d.credits.paidAllTime)} came from paid top-ups
          {" "}(≈ ${paidUsd.toFixed(2)}). The rest came from the free daily allowance.
        </p>
      )}

      {empty === "none" ? (
        <p className="font-mono text-[10px] text-slate-600 py-8 text-center leading-relaxed">
          No agent spending recorded yet.<br />
          <span className="text-slate-700">Hub tool calls and chat runs show up here.</span>
        </p>
      ) : empty === "unreadable" ? (
        <p className="font-mono text-[10px] text-[#F59E0B] py-8 text-center leading-relaxed">
          Nothing on the rail we can read — and the other one is unreachable.<br />
          <span className="text-slate-600">Half the picture, not an empty wallet.</span>
        </p>
      ) : (
        <>
          {/* ── Activity, measured in calls — the one shared unit ──────────── */}
          {anyActivity && (
            <div className="mt-5">
              {/* The chart's own span, stated on the chart. It is DAY_WINDOW
                  long and the rails above are not — that difference is the
                  whole reason the header stopped hard-coding "30". */}
              <div className="font-mono text-[9px] text-slate-600 tracking-widest uppercase mb-2">
                Calls per day
                <span className="text-slate-700 normal-case tracking-normal"> · last {d.days.length} days</span>
              </div>
              <div className="flex items-end gap-[2px] h-14">
                {d.days.map(day => (
                  <div
                    key={day.day}
                    className="flex-1 rounded-sm transition-colors"
                    title={`${day.day} — ${day.calls} call${day.calls === 1 ? "" : "s"}${
                      day.usdcUnits ? ` · ${usdc(day.usdcUnits)}` : ""
                    }${day.credits ? ` · ${nf(day.credits)} cr` : ""}`}
                    style={{
                      height: day.calls ? `${Math.max(8, (day.calls / maxCalls) * 100)}%` : "2px",
                      background: day.calls ? "#4FC3F7" : "#1A1A2E",
                      opacity: day.calls ? 0.35 + 0.65 * (day.calls / maxCalls) : 1,
                    }}
                  />
                ))}
              </div>
              <div className="flex justify-between font-mono text-[8px] text-slate-700 mt-1">
                <span>{relDay(d.days[0].day)}</span>
                <span>peak {maxCalls}/day</span>
                <span>{relDay(d.days[d.days.length - 1].day)}</span>
              </div>
            </div>
          )}

          {/* ── Per tool ───────────────────────────────────────────────────── */}
          {d.tools.length > 0 && (
            <div className="mt-5">
              <div className="font-mono text-[9px] text-slate-600 tracking-widest uppercase mb-2">
                By tool
              </div>
              <div className="rounded-xl border border-[#1A1A2E] bg-[#0d0d12] overflow-hidden">
                {d.tools.map(t => (
                  <div
                    key={`${t.src}-${t.tool}`}
                    className="flex items-center justify-between gap-3 px-3.5 py-2.5 border-b border-[#141420] last:border-0"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        {/* A tool with no catalog entry prints its raw id. It
                            never borrows a name, and a community slug never
                            resolves against the first-party catalog at all. */}
                        <span className="font-mono text-[11px] text-slate-300 truncate">
                          {t.name ?? t.tool}
                        </span>
                        {t.src === "community" && (
                          <span
                            className="font-mono text-[8px] px-1 py-px rounded shrink-0"
                            style={{ background: "#A78BFA15", color: "#A78BFA" }}
                          >
                            community
                          </span>
                        )}
                      </div>
                      {t.name && (
                        <div className="font-mono text-[9px] text-slate-700 truncate">{t.tool}</div>
                      )}
                    </div>
                    <div className="flex items-center gap-3 shrink-0 font-mono text-[10px]">
                      {t.usdcUnits > 0 && (
                        <span className="text-[#4FC3F7]" title={`${t.usdcCalls} x402 call(s)`}>
                          {usdc(t.usdcUnits)}
                        </span>
                      )}
                      {t.credits > 0 && (
                        <span className="text-[#A78BFA]" title={`${t.creditCalls} credit call(s)`}>
                          {nf(t.credits)} cr
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Chat is real spending but is not a tool, so it sits outside the
              table rather than posing as one row among the Hub tools. */}
          {d.chat.calls > 0 && (
            <div className="flex items-center justify-between mt-2 px-3.5 py-2 rounded-xl border border-[#1A1A2E] bg-[#0d0d12]">
              <span className="font-mono text-[11px] text-slate-400">Blue Chat</span>
              <span className="font-mono text-[10px] text-[#A78BFA]">
                {nf(d.chat.credits)} cr
                <span className="text-slate-700"> · {nf(d.chat.calls)} msg</span>
              </span>
            </div>
          )}

          {/* Shown, not hidden. These credits WERE spent — we just can't say on
              what, because the debit's reason didn't name a tool. Dropping the
              row would make the columns above quietly fail to add up to the
              headline, which is a worse lie than admitting the gap. */}
          {other.calls > 0 && (
            <div className="flex items-center justify-between mt-2 px-3.5 py-2 rounded-xl border border-[#1A1A2E] bg-[#0d0d12]">
              <span className="font-mono text-[11px] text-slate-500">
                Unattributed
                <span className="text-slate-700"> · spent, but not tagged to a tool</span>
              </span>
              <span className="font-mono text-[10px] text-[#A78BFA]">
                {nf(other.credits)} cr
                <span className="text-slate-700"> · {nf(other.calls)} call{other.calls === 1 ? "" : "s"}</span>
              </span>
            </div>
          )}
        </>
      )}

      {/* ── Caveats. Each is a fact about the data, not boilerplate. ───────── */}
      <div className="mt-4 pt-3 border-t border-[#12121c] space-y-1">
        {usdcDown && (
          <p className="font-mono text-[9px] text-[#F59E0B]">
            USDC receipts unreachable — the credits column below is complete, the USDC one is missing entirely.
          </p>
        )}
        {crDown && (
          <p className="font-mono text-[9px] text-[#F59E0B]">
            Credit ledger unreachable — the USDC column is complete, the credits one is missing entirely.
          </p>
        )}
        {d.credits.truncated && (
          <p className="font-mono text-[9px] text-slate-600 leading-relaxed">
            Your credit history is at its stored limit, so the per-tool credit figures are a floor — older calls have aged out.
          </p>
        )}
        <p className="font-mono text-[9px] text-slate-700 leading-relaxed">
          USDC is settled on Base and exact. Credits are metered units, part free daily allowance and part paid — so the two columns are never added together.
        </p>
      </div>
    </>
  );
}
