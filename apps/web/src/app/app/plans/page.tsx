"use client";

// /app/plans — pricing. This is a PRICING PAGE ONLY: it introduces no new
// billing mechanism. Every "Get credits" button opens the existing TopUpModal,
// which runs the same non-custodial USDC → credits flow (CREDIT_PACKS) used
// everywhere else.
//
// Every number on this page is imported, never typed out:
//   GUEST_DAILY / WALLET_DAILY   — lib/credits, the real daily allowances
//   preset.credits               — the per-message cost the ledger actually debits
//   CREDITS_PER_USDC             — the one anchor rate (1 cr = $0.0005)
// "How many messages does a day buy" is arithmetic on those, computed below.
// A hardcoded example here would drift the moment a preset is repriced, and a
// pricing page that disagrees with the ledger is worse than no pricing page.
//
// What this page must NOT imply: that a credit pack unlocks anything. It does
// not. Guest and Member reach the identical model list and the identical Hub
// catalog — the only differences are the size of the daily allowance and
// whether you can top up. Selling "tiers" that gate nothing would be the same
// class of defect as advertising a tool the model cannot call.

import { useEffect, useState } from "react";
import Link from "next/link";
import { useWallet } from "@/hooks/useWallet";
import { WalletPickerModal } from "@/components/WalletPicker";
import TopUpModal from "@/components/TopUpModal";
import { CREDIT_PACKS, CREDITS_PER_USDC } from "@/lib/payments";
import { WALLET_DAILY, GUEST_DAILY } from "@/lib/credits";
import {
  VIRTUALS_PRESETS_V1,
  formatContextTokens,
  type VirtualsPresetV1,
} from "@/app/chat/components/presets";

const ACCENT = "#4FC3F7";

/** Messages a `daily` allowance buys at `perMsg` credits. `null` = free model. */
function msgsPerDay(daily: number, perMsg: number): number | null {
  if (perMsg <= 0) return null;
  return Math.floor(daily / perMsg);
}

/** `null` → the model is free. `0` is a real answer: that tier cannot afford one. */
function msgsLabel(n: number | null): string {
  if (n == null) return "unlimited";
  return `${n.toLocaleString()} ${n === 1 ? "msg" : "msgs"}`;
}

/** USDC list price → credits, at the one anchor rate. */
function usdToCredits(usd: number): number {
  return Math.round(usd * CREDITS_PER_USDC);
}

// Worked examples of the tool-pricing RULE, not a claim about which prices are
// in the catalog. The rule (list price × CREDITS_PER_USDC) is exact and holds
// for any price; these three are just round numbers to read it against. The
// live per-tool prices live on /hub, which is why this links there instead of
// mirroring a 112-row table that would rot the day a tool is repriced.
const TOOL_PRICE_EXAMPLES = [0.05, 0.1, 0.25];

export default function PlansPage() {
  const { isConnected } = useWallet();
  const [picker, setPicker] = useState(false);
  const [topup, setTopup]   = useState(false);

  // Same catalog-trim the ChatInput picker does: the server filters the static
  // spec against the live Virtuals/Venice catalogs, so a de-listed model hides
  // its row instead of being quoted a price it can no longer be charged at.
  // Static list until it answers; static list again if it fails.
  const [presets, setPresets] = useState<VirtualsPresetV1[]>(VIRTUALS_PRESETS_V1);
  useEffect(() => {
    let off = false;
    fetch("/api/chat/presets")
      .then(r => (r.ok ? r.json() : null))
      .then((body: { ok?: boolean; presets?: VirtualsPresetV1[] } | null) => {
        if (off) return;
        if (body?.ok && Array.isArray(body.presets) && body.presets.length > 0) {
          setPresets(body.presets);
        }
      })
      .catch(() => {});
    return () => { off = true; };
  }, []);

  const rows = [...presets].sort((a, b) => a.credits - b.credits);

  // The pack cards answer "what does $20 actually buy" in messages, not just in
  // credits. Anchored to the cheapest PAID preset, because the free one costs
  // nothing and would make every pack read as infinite.
  const cheapestPaid = rows.find(p => p.credits > 0) ?? null;

  return (
    <div className="flex flex-col h-full bg-[#050508] overflow-hidden">
      {/* Header */}
      <div className="flex items-center px-5 sm:px-6 h-14 border-b border-[#1A1A2E] flex-shrink-0">
        <div className="min-w-0">
          <p className="font-mono text-xs tracking-widest truncate" style={{ color: ACCENT }}>// PLANS</p>
          <p className="font-mono text-[10px] text-slate-700 mt-1 truncate">
            Credits pay for chat messages and tool runs · 1 USDC = {CREDITS_PER_USDC.toLocaleString()} credits
          </p>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-y-auto px-5 sm:px-6 py-6">
        <div className="max-w-3xl mx-auto space-y-8">

          {/* ── 1. Access levels ───────────────────────────────────────────── */}
          <section>
            <p className="font-mono text-[10px] text-slate-600 tracking-widest uppercase mb-3">
              Access · there are two, and both are free
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <AccessCard
                name="Guest"
                daily={GUEST_DAILY}
                sub="No wallet, no signup."
                lines={[
                  "Every model in the picker",
                  "Every tool in the Hub",
                  "Allowance resets at 00:00 UTC",
                ]}
              />
              <AccessCard
                name="Member"
                daily={WALLET_DAILY}
                sub="Connect any wallet. No token to hold, nothing to lock."
                lines={[
                  "Every model in the picker",
                  "Every tool in the Hub",
                  "Allowance resets at 00:00 UTC",
                  "Can top up with USDC",
                ]}
                highlight
                action={
                  isConnected ? (
                    <span className="font-mono text-[10px] text-[#34D399] font-bold px-2.5 py-1 rounded-md border border-[#34D399]/25">
                      ACTIVE
                    </span>
                  ) : (
                    <button
                      onClick={() => setPicker(true)}
                      className="font-mono text-[11px] font-bold px-3.5 py-1.5 rounded-lg transition-colors"
                      style={{ background: `${ACCENT}12`, color: ACCENT, border: `1px solid ${ACCENT}40` }}
                    >
                      Connect wallet
                    </button>
                  )
                }
              />
            </div>
            <p className="font-mono text-[10px] text-slate-600 mt-3 leading-relaxed">
              Connecting a wallet does not unlock features — the model list and the tool catalog are
              identical either way. It multiplies the daily allowance by{" "}
              <span className="text-slate-300">{Math.round(WALLET_DAILY / GUEST_DAILY)}×</span> and lets you
              buy credits when the allowance runs out.
            </p>
          </section>

          {/* ── 2. What a day of credits buys ──────────────────────────────── */}
          <section>
            <p className="font-mono text-[10px] text-slate-600 tracking-widest uppercase mb-1">
              What the allowance buys
            </p>
            <p className="font-mono text-[10px] text-slate-600 mb-3 leading-relaxed">
              A credit is worth nothing on its own — this is the table that says what it does.
              Message counts are one full day&apos;s allowance divided by the model&apos;s cost.
            </p>

            <div className="rounded-2xl border border-[#1A1A2E] bg-[#0A0A12] overflow-hidden">
              {/* Column headers — hidden on mobile, where each row stacks */}
              <div className="hidden sm:grid grid-cols-[1fr_auto_auto_auto] gap-4 px-4 py-2.5 border-b border-[#1A1A2E]">
                <span className="font-mono text-[9px] text-slate-600 tracking-widest uppercase">Model</span>
                <span className="font-mono text-[9px] text-slate-600 tracking-widest uppercase text-right w-16">Per msg</span>
                <span className="font-mono text-[9px] text-slate-600 tracking-widest uppercase text-right w-20">Guest/day</span>
                <span className="font-mono text-[9px] text-slate-600 tracking-widest uppercase text-right w-20">Member/day</span>
              </div>

              {rows.map(p => {
                const guest  = msgsPerDay(GUEST_DAILY, p.credits);
                const member = msgsPerDay(WALLET_DAILY, p.credits);
                const isFree = p.credits <= 0;
                return (
                  <div
                    key={p.id}
                    className="grid grid-cols-2 sm:grid-cols-[1fr_auto_auto_auto] gap-x-4 gap-y-1 px-4 py-3 border-b border-[#13131f] last:border-0"
                  >
                    {/* Name + what it's for */}
                    <div className="col-span-2 sm:col-span-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono text-[12px] text-slate-200">{p.label}</span>
                        <span className="font-mono text-[9px] text-slate-700">
                          {formatContextTokens(p.contextTokens)} ctx
                        </span>
                        {isFree && (
                          <span
                            className="font-mono text-[8px] font-bold px-1.5 py-0.5 rounded"
                            style={{ background: `${ACCENT}12`, color: ACCENT }}
                          >
                            CHAT ONLY
                          </span>
                        )}
                        {p.webSearch && (
                          <span className="font-mono text-[8px] font-bold px-1.5 py-0.5 rounded bg-[#1A1A2E] text-slate-400">
                            WEB SEARCH
                          </span>
                        )}
                        {p.privacy && (
                          <span className="font-mono text-[8px] font-bold px-1.5 py-0.5 rounded bg-[#1A1A2E] text-slate-400">
                            E2EE
                          </span>
                        )}
                      </div>
                      <p className="font-mono text-[10px] text-slate-600 mt-0.5 truncate">{p.desc}</p>
                    </div>

                    <Cell label="Per msg"    w="sm:w-16" value={isFree ? "0 cr" : `${p.credits} cr`} accent={isFree} />
                    <Cell label="Guest/day"  w="sm:w-20" value={msgsLabel(guest)}  muted={guest === 0} />
                    <Cell label="Member/day" w="sm:w-20" value={msgsLabel(member)} muted={member === 0} />
                  </div>
                );
              })}
            </div>

            <p className="font-mono text-[10px] text-slate-600 mt-3 leading-relaxed">
              · The free model costs no credits, so the allowance never runs down on it — but it is
              chat only: it cannot call a Hub tool or read the live web. Every other model can.
            </p>
            <p className="font-mono text-[10px] text-slate-600 mt-1 leading-relaxed">
              · A shared ceiling of 30 messages per minute applies to every tier, free or paid.
            </p>
            {/* Points at /chat, NOT /app/models: on this branch the model
                catalog is still a tab inside Blue Chat and no /app/models route
                exists, so linking there would ship a 404. Repoint it when the
                Models page lands. */}
            <p className="font-mono text-[10px] text-slate-600 mt-1 leading-relaxed">
              · Pick a model from the picker in{" "}
              <Link href="/chat" className="hover:underline" style={{ color: ACCENT }}>Blue Chat</Link>.
            </p>
          </section>

          {/* ── 3. Hub tools ───────────────────────────────────────────────── */}
          <section>
            <p className="font-mono text-[10px] text-slate-600 tracking-widest uppercase mb-1">
              Hub tools
            </p>
            <p className="font-mono text-[10px] text-slate-600 mb-3 leading-relaxed">
              Tools are priced individually in USDC. Running one from chat spends credits at the same
              anchor rate, so a credit and a direct x402 payment settle the same value.
            </p>
            <div className="rounded-2xl border border-[#1A1A2E] bg-[#0A0A12] p-4">
              <p className="font-mono text-[11px] text-slate-300">
                tool list price × {CREDITS_PER_USDC.toLocaleString()} = credits per run
              </p>
              <div className="flex flex-wrap gap-x-5 gap-y-1.5 mt-3">
                {TOOL_PRICE_EXAMPLES.map(usd => (
                  <div key={usd} className="font-mono text-[10px] text-slate-600">
                    ${usd.toFixed(2)} tool <span className="text-slate-700">→</span>{" "}
                    <span style={{ color: ACCENT }}>{usdToCredits(usd).toLocaleString()} cr</span>
                  </div>
                ))}
              </div>
              <p className="font-mono text-[10px] text-slate-600 mt-3 leading-relaxed">
                Each tool lists its own price in the{" "}
                <Link href="/hub" className="hover:underline" style={{ color: ACCENT }}>Hub</Link>. You can
                also pay a tool directly in USDC over x402 and skip credits entirely.
              </p>
            </div>
          </section>

          {/* ── 4. Top up ──────────────────────────────────────────────────── */}
          <section>
            <p className="font-mono text-[10px] text-slate-600 tracking-widest uppercase mb-1">
              Top up with USDC on Base · non-custodial
            </p>
            <p className="font-mono text-[10px] text-slate-600 mb-3 leading-relaxed">
              Credits are spent only after the daily allowance runs out, and they never expire.
              Packs differ in size only — none of them unlocks a model or a tool the free allowance
              cannot already reach.
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {CREDIT_PACKS.map(pack => {
                const msgs = cheapestPaid ? msgsPerDay(pack.credits, cheapestPaid.credits) : null;
                return (
                  <button
                    key={pack.usdc}
                    onClick={() => setTopup(true)}
                    className="relative text-left rounded-xl border border-[#1A1A2E] bg-[#0A0A12] p-4 transition-colors hover:border-[#4FC3F7]/50"
                  >
                    {pack.popular && (
                      <span
                        className="absolute -top-2 right-3 font-mono text-[8px] font-bold px-1.5 py-0.5 rounded"
                        style={{ background: ACCENT, color: "#050508" }}
                      >
                        POPULAR
                      </span>
                    )}
                    <p className="font-mono text-[10px] text-slate-500">{pack.label}</p>
                    <p className="font-mono text-2xl font-bold text-white mt-1">${pack.usdc}</p>
                    <p className="font-mono text-[11px] mt-1" style={{ color: ACCENT }}>
                      {pack.credits.toLocaleString()} cr
                    </p>
                    {msgs != null && cheapestPaid && (
                      <p className="font-mono text-[9px] text-slate-600 mt-1.5 leading-snug">
                        ≈ {msgs.toLocaleString()} {cheapestPaid.label} messages
                      </p>
                    )}
                    <p className="font-mono text-[9px] text-slate-700 mt-2">Get credits →</p>
                  </button>
                );
              })}
            </div>
          </section>

          {/* ── 5. Notes ───────────────────────────────────────────────────── */}
          <div className="rounded-xl border border-[#1A1A2E] bg-[#0A0A12] p-4 space-y-1.5">
            {/* The ledger keys the daily bucket on the UTC calendar day
                (`utcDay()` in lib/credit-ledger), not on a rolling 24h window
                from your last message — so say the boundary, not "every 24h".
                A user who spends their allowance at 23:00 UTC gets a fresh one
                an hour later, and that is worth knowing before you top up. */}
            <p className="font-mono text-[10px] text-slate-500 leading-relaxed">
              · The daily allowance is use-it-or-lose-it and refreshes at 00:00 UTC.
              Top-up credits go into a separate pool that carries over and never expires.
            </p>
            <p className="font-mono text-[10px] text-slate-500 leading-relaxed">
              · You sign every transfer from your own wallet. Blue Agent never holds your keys and
              cannot move your funds.
            </p>
            <p className="font-mono text-[10px] text-slate-500 leading-relaxed">
              · Track your balance and per-tool spend on the{" "}
              <Link href="/usage" className="hover:underline" style={{ color: ACCENT }}>Usage</Link> page.
            </p>
          </div>
        </div>
      </div>

      <WalletPickerModal open={picker} onClose={() => setPicker(false)} />
      <TopUpModal open={topup} onClose={() => setTopup(false)} />
    </div>
  );
}

// ── Bits ──────────────────────────────────────────────────────────────────────

/** One number in the model table. Carries its own label so the mobile stack
 *  stays readable once the shared column headers are hidden. `w` must match the
 *  width on the matching header cell, or the column drifts out of alignment. */
function Cell({ label, value, w, accent, muted }: {
  label: string; value: string; w: string; accent?: boolean; muted?: boolean;
}) {
  return (
    <div className={`sm:text-right ${w}`}>
      <span className="font-mono text-[9px] text-slate-700 sm:hidden block">{label}</span>
      <span
        className="font-mono text-[11px]"
        style={{ color: accent ? ACCENT : muted ? "#475569" : "#cbd5e1" }}
      >
        {value}
      </span>
    </div>
  );
}

function AccessCard({ name, daily, sub, lines, action, highlight }: {
  name: string;
  daily: number;
  sub: string;
  lines: string[];
  action?: React.ReactNode;
  highlight?: boolean;
}) {
  return (
    <div
      className="rounded-2xl border bg-[#0A0A12] p-5 flex flex-col"
      style={{ borderColor: highlight ? `${ACCENT}30` : "#1A1A2E" }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-[13px] font-bold text-white">{name}</p>
          <p className="font-mono text-[10px] text-slate-600 mt-1 leading-relaxed">{sub}</p>
        </div>
        <div className="text-right flex-shrink-0">
          <p className="font-mono text-2xl font-bold" style={{ color: ACCENT }}>
            {daily.toLocaleString()}
          </p>
          <p className="font-mono text-[10px] text-slate-600">credits / day</p>
        </div>
      </div>
      <ul className="mt-4 space-y-1 flex-1">
        {lines.map(l => (
          <li key={l} className="font-mono text-[10px] text-slate-500 flex gap-2">
            <span className="text-slate-700">·</span>
            <span>{l}</span>
          </li>
        ))}
      </ul>
      {action && <div className="mt-4 flex justify-end">{action}</div>}
    </div>
  );
}
