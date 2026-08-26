"use client";

/**
 * AGENT SPEND — the wallet's reason to exist.
 *
 * Every other wallet can show that 0.05 USDC left for `0x0295…`. None of them
 * can show WHAT IT BOUGHT, because the tool id only ever existed in the request
 * that triggered the payment. This panel is that join, aggregated: per tool,
 * per day, across both rails that pay for a Hub call.
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
  partial: boolean;
  creditsPerUsdc: number;
  ts: number;
}

/** Three states, as everywhere in this wallet: "loading" and "failed" are both NOT "zero". */
type Load =
  | { s: "loading" }
  | { s: "ok"; d: SpendSummaryDTO }
  | { s: "failed" };

function useSpendSummary(address?: string): Load {
  const [state, setState] = useState<Load>({ s: "loading" });
  useEffect(() => {
    if (!address) { setState({ s: "loading" }); return; }
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

  return (
    <div className="rounded-2xl border border-[#1A1A2E] bg-[#0A0A12] p-4 sm:p-5">
      <div className="flex items-baseline justify-between mb-1">
        <div className="font-mono text-[9px] text-slate-500 tracking-widest">AGENT SPEND</div>
        <div className="font-mono text-[9px] text-slate-700">last 30 days</div>
      </div>
      <p className="font-mono text-[9px] text-slate-600 mb-4 leading-relaxed">
        What your payments actually bought — the part no block explorer can see.
      </p>

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
  const nothingYet =
    !bothDown && d.tools.length === 0 && d.chat.calls === 0 && other.calls === 0 && !anyActivity;

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

      {nothingYet ? (
        <p className="font-mono text-[10px] text-slate-600 py-8 text-center leading-relaxed">
          No agent spending recorded yet.<br />
          <span className="text-slate-700">Hub tool calls and chat runs show up here.</span>
        </p>
      ) : (
        <>
          {/* ── Activity, measured in calls — the one shared unit ──────────── */}
          {anyActivity && (
            <div className="mt-5">
              <div className="font-mono text-[9px] text-slate-600 tracking-widest uppercase mb-2">
                Calls per day
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
