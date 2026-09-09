"use client";
import { useState } from "react";
import Link from "next/link";
import { useChat } from "../ChatContext";
import { getMemory, clearMemory } from "@/lib/memory";
import WalletBar from "@/components/WalletBar";
import TopUpModal from "@/components/TopUpModal";

// The settings categories — Claude-style two-pane modal. The modal owns the
// left nav + active section; this panel renders the matching content.
export type SettingsSection = "account" | "credits" | "memory" | "about";

const LINKS: { label: string; sub: string; href: string }[] = [
  { label: "Website",     sub: "blueagent.dev",      href: "https://blueagent.dev" },
  { label: "X / Twitter", sub: "@blueagent_",        href: "https://x.com/blueagent_" },
  { label: "Telegram",    sub: "t.me/blueagent_hub", href: "https://t.me/blueagent_hub" },
];

// Credit ladder — mirrors lib/credits.ts GUEST_DAILY / WALLET_DAILY. Shown in
// the "How credits work" explainer. Token-free: a free daily bucket for everyone
// (bigger the moment you connect any wallet), then USDC credit packs for more.
const TIER_ROWS: { need: string; tier: string; perk: string; color: string }[] = [
  { need: "No wallet",    tier: "Guest",  perk: "100 cr/day",     color: "#64748b" },
  { need: "Any wallet",   tier: "Member", perk: "500 cr/day",     color: "#4FC3F7" },
  { need: "USDC on Base", tier: "Packs",  perk: "Top up anytime", color: "#F59E0B" },
];

// Section content header — mirrors Claude's right-pane title + subtitle.
function PaneHeader({ title, subtitle, right }: { title: string; subtitle?: string; right?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 mb-5">
      <div>
        <h3 className="font-mono text-sm text-white font-semibold tracking-wide">{title}</h3>
        {subtitle && <p className="font-mono text-[10px] text-slate-600 mt-1 leading-relaxed">{subtitle}</p>}
      </div>
      {right}
    </div>
  );
}

/**
 * Cross-device sync toggle.
 *
 * Every string here has to survive the question "is that literally true?".
 * Sync is off by default, needs a signature, and never deletes anything local —
 * so the copy says exactly that instead of a bare "Sync: on". The status line
 * reports the real phase, including the failure phases: a sync that could not
 * write must not render as a checkmark.
 */
function SyncCard() {
  const { sync } = useChat();
  const [busy, setBusy] = useState(false);

  const status = (() => {
    switch (sync.state.phase) {
      case "off":        return { text: "Off — this browser only",                    color: "#64748b" };
      case "signed-out": return { text: "Sign in again to resume syncing",            color: "#F59E0B" };
      case "hydrating":  return { text: "Loading your synced workspace…",             color: "#4FC3F7" };
      case "syncing":    return { text: "Saving…",                                    color: "#4FC3F7" };
      case "idle":       return { text: `Synced · ${new Date(sync.state.at).toLocaleTimeString()}`, color: "#22C55E" };
      case "error":      return { text: sync.state.message,                           color: "#EF4444" };
    }
  })();

  async function toggle() {
    setBusy(true);
    try { sync.enabled ? await sync.disable() : await sync.enable(); }
    finally { setBusy(false); }
  }

  return (
    <div className="mt-4 rounded-2xl bg-[#0A0A12] border border-[#1A1A2E] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-[11px] text-slate-300 font-semibold">Sync across devices</p>
          <p className="font-mono text-[10px] text-slate-600 mt-1 leading-relaxed">
            Off by default. Turning it on asks your wallet for one signature — it proves
            you own this address and moves no funds. Your conversations, scheduled prompts,
            skills and memory are then kept on our server so another device signed in with
            the same wallet sees them.
          </p>
        </div>
        <button
          onClick={toggle}
          disabled={busy}
          className="shrink-0 font-mono text-[10px] px-3 py-1.5 rounded-lg border transition-colors disabled:opacity-50"
          style={
            sync.enabled
              ? { color: "#EF4444", borderColor: "#EF444430", background: "#EF444410" }
              : { color: "#4FC3F7", borderColor: "#4FC3F730", background: "#4FC3F710" }
          }
        >
          {busy ? "…" : sync.enabled ? "Turn off" : "Turn on"}
        </button>
      </div>

      <div className="flex items-center gap-1.5 mt-3 pt-3 border-t border-[#13131f]">
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: status.color }} />
        <span className="font-mono text-[10px] truncate" style={{ color: status.color }}>{status.text}</span>
      </div>

      <p className="font-mono text-[9px] text-slate-700 mt-2.5 leading-relaxed">
        Not synced: credits (already tracked server-side) and MCP connectors (their rows hold
        access tokens, which stay in this browser until the secrets vault ships).
        Turning sync off ends the session but leaves this browser&apos;s copy untouched.
      </p>

      {sync.enabled && (
        <button
          onClick={() => sync.forget()}
          className="font-mono text-[10px] text-slate-600 hover:text-red-400 transition-colors mt-2.5"
        >
          Delete the synced copy from the server →
        </button>
      )}
    </div>
  );
}

export default function SettingsPanel({ section }: { section: SettingsSection }) {
  const {
    holderTier,
    walletAddr, triggerWalletRefresh,
    credits, countdown, isUnlimited, daily,
  } = useChat();

  const [showHelp, setShowHelp]   = useState(false);
  const [topUpOpen, setTopUpOpen] = useState(false);

  const memory    = getMemory(walletAddr);
  const hasMemory = !!(memory.currentProject || memory.commandHistory.length > 0);

  return (
    <div className="px-5 sm:px-7 py-6">

      {/* ── Account ─────────────────────────────────────────────────────── */}
      {section === "account" && (
        <>
          {/* Subtitle says what the wallet IS here, not what connecting earns:
              WalletBar's own hint right below already reads "→ Connect any
              wallet for 500 credits/day — no token needed", and this header
              used to repeat that same sentence one line above it, minus the
              number. Two stacked copies of one offer read as a bug. */}
          <PaneHeader
            title="Account"
            subtitle="Your wallet is the identity behind credits, cross-device sync and on-chain actions."
          />
          <WalletBar />

          {/* Network + explorer — only meaningful once connected. */}
          {walletAddr && (
            <div className="mt-4 rounded-2xl bg-[#0A0A12] border border-[#1A1A2E] divide-y divide-[#13131f]">
              <div className="flex items-center justify-between px-3.5 py-2.5">
                <span className="font-mono text-[11px] text-slate-500">Network</span>
                <span className="font-mono text-[11px] text-slate-300 flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#4FC3F7]" />Base · 8453
                </span>
              </div>
              <a
                href={`https://basescan.org/address/${walletAddr}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-between px-3.5 py-2.5 hover:bg-[#ffffff05] transition-colors"
              >
                <span className="font-mono text-[11px] text-slate-500">Explorer</span>
                <span className="font-mono text-[11px] text-[#4FC3F7]">View on Basescan ↗</span>
              </a>
            </div>
          )}

          {walletAddr && <SyncCard />}
        </>
      )}

      {/* ── Credits ─────────────────────────────────────────────────────── */}
      {section === "credits" && (
        <>
          <PaneHeader
            title="Credits"
            subtitle="Every message spends credits. Connect any wallet for more each day, or top up with USDC."
            right={
              <span
                className="font-mono text-[10px] px-2 py-0.5 rounded border font-semibold shrink-0"
                style={{ color: holderTier.color, background: `${holderTier.color}12`, borderColor: `${holderTier.color}30` }}
              >
                {walletAddr ? holderTier.tier : "Guest"}
              </span>
            }
          />

          {/* Credit card — wallet → ledger balance; guest → daily quota. */}
          <div className="rounded-2xl bg-[#0A0A12] border border-[#1A1A2E] p-4 mb-4">
            {walletAddr ? (
              <>
                <div className="flex items-end justify-between mb-3">
                  <div>
                    <span
                      className="font-mono text-4xl font-bold tabular-nums leading-none"
                      style={{ color: isUnlimited ? holderTier.color : credits <= 20 ? "#EF4444" : "#4FC3F7" }}
                    >
                      {isUnlimited ? "∞" : credits.toLocaleString()}
                    </span>
                    <span className="font-mono text-sm text-slate-600 ml-2">spendable</span>
                  </div>
                  <span className="font-mono text-[10px] text-slate-600 mb-1">
                    {isUnlimited ? "Dev · unmetered" : daily > 0 ? `+${daily.toLocaleString()}/day` : "—"}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[10px] text-slate-600">
                    {isUnlimited ? "Dev mode · no metering" : "Daily allowance + USDC top-ups"}
                  </span>
                </div>
              </>
            ) : (
              <>
                <div className="flex items-end justify-between mb-3">
                  <div>
                    <span
                      className="font-mono text-4xl font-bold tabular-nums leading-none"
                      style={{ color: isUnlimited ? holderTier.color : credits <= 20 ? "#EF4444" : "#4FC3F7" }}
                    >
                      {isUnlimited ? "∞" : credits.toLocaleString()}
                    </span>
                    {!isUnlimited && (
                      <span className="font-mono text-sm text-slate-600 ml-2">/ {daily.toLocaleString()}</span>
                    )}
                  </div>
                  <span className="font-mono text-[10px] text-slate-600 mb-1">per day</span>
                </div>

                {!isUnlimited && daily > 0 && (
                  <div className="h-1 bg-[#1A1A2E] rounded-full overflow-hidden mb-3">
                    <div
                      className="h-full rounded-full transition-all"
                      style={{ width: `${Math.min(100, (credits / daily) * 100)}%`, background: holderTier.color }}
                    />
                  </div>
                )}

                <div className="flex items-center justify-between">
                  <span className="font-mono text-[10px] text-slate-600">resets in {countdown}</span>
                </div>
              </>
            )}
          </div>

          {/* Top up with USDC — opens the non-custodial pack picker */}
          <button
            onClick={() => setTopUpOpen(true)}
            className="w-full font-mono text-[12px] font-bold py-2.5 rounded-xl hover:opacity-90 transition-opacity"
            style={{ background: "#4FC3F7", color: "#050508" }}
          >
            Top up with USDC
          </button>

          <TopUpModal open={topUpOpen} onClose={() => setTopUpOpen(false)} onCredited={triggerWalletRefresh} />

          {/* How credits & tiers work — inline explainer */}
          <button
            onClick={() => setShowHelp(v => !v)}
            className="mt-3 w-full flex items-center justify-between font-mono text-[10px] text-slate-600 hover:text-slate-400 transition-colors"
          >
            <span>How credits &amp; tiers work</span>
            <span>{showHelp ? "▴" : "▾"}</span>
          </button>

          {showHelp && (
            <div className="mt-2 rounded-2xl bg-[#0A0A12] border border-[#1A1A2E] p-4 space-y-3">
              <p className="font-mono text-[10px] text-slate-500 leading-relaxed">
                With no wallet you get <span className="text-[#4FC3F7]">100 free credits/day</span> (~10 messages). Connect
                <span className="text-slate-300"> any wallet — no token needed</span> — for <span className="text-[#4FC3F7]">500 credits/day</span>.
                Need more than the daily bucket? Top up with a <span className="text-slate-300">USDC credit pack</span> on Base.
              </p>

              <div className="rounded-xl border border-[#1A1A2E] overflow-hidden">
                {TIER_ROWS.map((r, i) => (
                  <div
                    key={r.tier}
                    className={`flex items-center justify-between px-3 py-2 ${i > 0 ? "border-t border-[#13131f]" : ""}`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: r.color }} />
                      <span className="font-mono text-[11px] font-semibold shrink-0" style={{ color: r.color }}>{r.tier}</span>
                      <span className="font-mono text-[10px] text-slate-600 truncate">{r.need}</span>
                    </div>
                    <span className="font-mono text-[10px] text-slate-400 shrink-0">{r.perk}</span>
                  </div>
                ))}
              </div>

              <p className="font-mono text-[10px] text-slate-600 leading-relaxed">
                The daily bucket is <span className="text-slate-400">use-it-or-lose-it</span> and refreshes every 24h.
                A <span className="text-slate-400">USDC top-up</span> adds to a cumulative pool that carries over. Hub tools
                stay pay-per-call in USDC — no token, no subscription.
              </p>

              <Link
                href="/docs/credits"
                className="inline-flex items-center gap-1.5 font-mono text-[11px] font-semibold text-[#A78BFA] hover:opacity-80 transition-opacity"
              >
                How credits &amp; USDC packs work →
              </Link>
            </div>
          )}
        </>
      )}

      {/* ── Memory ──────────────────────────────────────────────────────── */}
      {section === "memory" && (
        <>
          <PaneHeader
            title="Memory"
            subtitle="What the agent remembers across chats — your current project and recent commands."
            right={
              hasMemory ? (
                <button
                  onClick={() => clearMemory(walletAddr)}
                  className="font-mono text-[10px] text-slate-600 hover:text-red-400 transition-colors shrink-0"
                >
                  clear
                </button>
              ) : undefined
            }
          />
          {hasMemory ? (
            <div className="rounded-2xl bg-[#0A0A12] border border-[#1A1A2E] p-4 space-y-2.5">
              {memory.currentProject && (
                <div className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#4FC3F7] shrink-0" />
                  <span className="font-mono text-[10px] text-slate-500 w-16 shrink-0">project</span>
                  <span className="font-mono text-[10px] text-[#4FC3F7] truncate">{memory.currentProject.name}</span>
                </div>
              )}
              {memory.commandHistory[0] && (
                <div className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-slate-700 shrink-0" />
                  <span className="font-mono text-[10px] text-slate-500 w-16 shrink-0">last cmd</span>
                  <span className="font-mono text-[10px] text-slate-400">blue {memory.commandHistory[0].command}</span>
                </div>
              )}
            </div>
          ) : (
            <div className="rounded-2xl bg-[#0A0A12] border border-[#1A1A2E] p-6 text-center">
              <p className="font-mono text-[11px] text-slate-600">Nothing remembered yet</p>
              <p className="font-mono text-[10px] text-slate-700 mt-1">Start a project or run a command and it’ll show here.</p>
            </div>
          )}
        </>
      )}

      {/* ── About ───────────────────────────────────────────────────────── */}
      {section === "about" && (
        <>
          <PaneHeader
            title="About"
            subtitle="Blue Agent — the AI agent layer on Base."
          />

          {/* What Blue Chat is — token-free */}
          <div className="rounded-2xl bg-[#0A0A12] border border-[#1A1A2E] p-4 mb-3">
            <p className="font-mono text-[11px] text-slate-300 leading-relaxed">
              The onchain agent console. Free daily credits — connect any wallet for more.
              Pay-per-use with <span className="text-[#4FC3F7]">USDC on Base</span> for Hub tools and top-ups.
            </p>
            <p className="font-mono text-[10px] text-slate-600 mt-2">No token to hold · nothing to stake · no subscription.</p>
          </div>

          {/* Links */}
          <div className="rounded-2xl bg-[#0A0A12] border border-[#1A1A2E] divide-y divide-[#13131f]">
            {LINKS.map(l => (
              <a
                key={l.href}
                href={l.href}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-between px-3.5 py-2.5 hover:bg-[#ffffff05] transition-colors"
              >
                <span className="font-mono text-[11px] text-slate-300">{l.label}</span>
                <span className="font-mono text-[10px] text-slate-600">{l.sub} ↗</span>
              </a>
            ))}
          </div>

          <p className="font-mono text-[9px] text-slate-700 mt-4 text-center">Blue Chat · built on Base (8453)</p>
        </>
      )}
    </div>
  );
}
