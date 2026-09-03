"use client";

/**
 * OverviewView — Dashboard "Overview" tab, bento-style grid.
 *
 * Layout intent: instead of a uniform vertical stack of identical cards,
 * different cards take different cell sizes so the page reads at a glance.
 * Mobile collapses to a clean 1-column flow; ≥sm steps up to a 2-col bento;
 * ≥lg the identity hero becomes the dominant cell and the remaining cells ride
 * alongside it. (A STAKE cell used to sit in that row; it went out with the
 * stake surface — see the comment where it stood.)
 */

import { useState, useEffect } from "react";
import Link from "next/link";
import { useAccount, useReadContracts } from "wagmi";
import { useWalletDisconnect } from "@/lib/walletSession";
import { formatUnits } from "viem";
import AppConnectPrompt from "@/components/app/AppConnectPrompt";
import { useBasename } from "@/lib/useBasename";

// ── Contracts (Base mainnet) ─────────────────────────────────────────────────

const BLUE_ADDRESS  = "0xf895783b2931c919955e18b5e3343e7c7c456ba3" as `0x${string}`;
const USDC_ADDRESS  = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as `0x${string}`;
const WETH_ADDRESS  = "0x4200000000000000000000000000000000000006" as `0x${string}`;
const CBBTC_ADDRESS = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf" as `0x${string}`;
const AERO_ADDRESS  = "0x940181a94A35A4569E4529A3CDfB74e38FD98631" as `0x${string}`;

const ERC20_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view",
    inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

// Staking reads and the Starter/Pro/Max tier table lived here. Both were
// removed with the stake surface: `lib/credits.ts` stopped honouring token
// tiers (every wallet gets the same flat daily bucket), so rendering a tier
// badge was asserting an entitlement the credit system no longer grants.
//
// The page accent used to be `tier.color`, which meant the whole dashboard
// changed colour with stake size — a visual claim about entitlement. It is a
// constant now, for the same reason the badge went.
const ACCENT = "#4FC3F7";

function fmtBlue(wei: bigint) {
  const n = Number(formatUnits(wei, 18));
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + "K";
  return n.toFixed(0);
}

function fmtAmt(n: number, decimals: number): string {
  if (n === 0) return "0";
  if (decimals <= 6) return n.toFixed(2);
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(3) + "M";
  if (n >= 1_000)     return (n / 1_000).toFixed(2) + "K";
  if (n >= 1)         return n.toFixed(4);
  return n.toFixed(6);
}

// ── localStorage data ─────────────────────────────────────────────────────────

interface ChatStats {
  totalSessions:   number;
  totalMessages:   number;
  totalCreditsUsed:number;
  toolsUsed:       { name: string; count: number }[];
  firstUsed:       number | null;
}

function loadChatStats(addr?: string): ChatStats {
  const empty: ChatStats = { totalSessions: 0, totalMessages: 0, totalCreditsUsed: 0, toolsUsed: [], firstUsed: null };
  if (typeof window === "undefined") return empty;
  try {
    const key = addr ? `blue_tasks_v1_${addr.toLowerCase()}` : "blue_tasks_v1_guest";
    const raw = localStorage.getItem(key);
    if (!raw) return empty;
    const tasks = JSON.parse(raw) as Array<{
      messages: Array<{ role: string; creditsUsed?: number; toolLogs?: Array<{ tool: string }> }>;
      createdAt: number;
    }>;
    let totalMessages = 0, totalCreditsUsed = 0, firstUsed: number | null = null;
    const toolMap: Record<string, number> = {};
    for (const task of tasks) {
      if (!firstUsed || task.createdAt < firstUsed) firstUsed = task.createdAt;
      for (const msg of task.messages) {
        if (msg.role === "assistant") {
          totalMessages++;
          if (msg.creditsUsed) totalCreditsUsed += msg.creditsUsed;
          for (const log of msg.toolLogs ?? []) {
            toolMap[log.tool] = (toolMap[log.tool] ?? 0) + 1;
          }
        }
      }
    }
    const toolsUsed = Object.entries(toolMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([name, count]) => ({ name, count }));
    const activeSessions = tasks.filter(t => t.messages.some((m: { role: string }) => m.role === "assistant")).length;
    return { totalSessions: activeSessions, totalMessages, totalCreditsUsed, toolsUsed, firstUsed };
  } catch { return empty; }
}

// ── Bento card primitives ────────────────────────────────────────────────────

/**
 * BentoCell — the unit of the bento grid. Accepts an `accent` colour and
 * `flavor` (solid / gradient / glass) so each cell can carry its own visual
 * identity without us writing one-off Tailwind soup each time.
 */
function BentoCell({
  accent  = "#1A1A2E",
  flavor  = "solid",
  className = "",
  children,
}: {
  accent?:    string;
  flavor?:    "solid" | "gradient" | "glass";
  className?: string;
  children:   React.ReactNode;
}) {
  const style: React.CSSProperties =
    flavor === "gradient"
      ? {
          background: `linear-gradient(135deg, ${accent}18 0%, #0d0d12 60%)`,
          borderColor: `${accent}30`,
        }
      : flavor === "glass"
      ? { background: `${accent}0a`, borderColor: `${accent}25`, backdropFilter: "blur(8px)" }
      : { background: "#0d0d12", borderColor: "#1A1A2E" };
  return (
    <div className={`rounded-2xl border ${className}`} style={style}>{children}</div>
  );
}

function StatChip({ label, value, sub, color }: { label: string; value: string; sub?: string; color: string }) {
  // Dynamic font size so long values (big credit counts, dollar amounts) don't
  // overflow the narrow card; truncate with a tooltip as a final guard.
  const len = value.length;
  const valueSize = len > 12 ? "text-[11px]" : len > 9 ? "text-[13px]" : "text-base";
  return (
    <div className="rounded-xl border border-[#1A1A2E] bg-[#0a0a0f]/60 px-3 py-2.5 relative overflow-hidden">
      <span aria-hidden className="absolute inset-x-0 top-0 h-px"
            style={{ background: `linear-gradient(90deg, transparent, ${color}50, transparent)` }} />
      <div className="text-[9px] text-slate-600 tracking-widest mb-1 truncate">{label}</div>
      <div className={`${valueSize} font-bold leading-tight truncate`} style={{ color }} title={value}>{value}</div>
      {sub && <div className="text-[9px] text-slate-700 mt-1 truncate">{sub}</div>}
    </div>
  );
}

// ── View ─────────────────────────────────────────────────────────────────────

export default function OverviewView() {
  const { address, isConnected } = useAccount();
  const disconnect               = useWalletDisconnect();
  const { name: basename }       = useBasename(address);
  const [chatStats,    setChatStats]    = useState<ChatStats>({ totalSessions: 0, totalMessages: 0, totalCreditsUsed: 0, toolsUsed: [], firstUsed: null });
  const [copied,       setCopied]       = useState(false);
  const [builderScore, setBuilderScore] = useState<number | null>(null);
  const [scoreLoading, setScoreLoading] = useState(false);
  // Claimable credit balance from the ledger API: topup (off-chain USDC
  // top-ups) - spent (chat + tool runs). `accrued` is still in the payload
  // but is a 0-returning stub since the token-free rebuild, so it is no
  // longer surfaced — showing a permanent 0 read as "accrued" invites the
  // same misreading the stake tier ladder did.
  const [ledger, setLedger] = useState<{
    accrued: number; topup: number; spent: number; balance: number; dailyCr: number;
  } | null>(null);

  useEffect(() => { setChatStats(loadChatStats(address)); }, [address]);

  useEffect(() => {
    if (!address) { setBuilderScore(null); return; }
    setScoreLoading(true);
    fetch(`/api/builder-score?handle=${address}`)
      .then(r => r.json())
      .then(d => setBuilderScore(d?.score ?? d?.builder_score ?? null))
      .catch(() => null)
      .finally(() => setScoreLoading(false));
  }, [address]);

  const { data: contractData } = useReadContracts({
    contracts: [
      { address: BLUE_ADDRESS,    abi: ERC20_ABI,   functionName: "balanceOf",           args: address ? [address] : undefined },
      { address: USDC_ADDRESS,    abi: ERC20_ABI,   functionName: "balanceOf",           args: address ? [address] : undefined },
      { address: WETH_ADDRESS,    abi: ERC20_ABI,   functionName: "balanceOf",           args: address ? [address] : undefined },
      { address: CBBTC_ADDRESS,   abi: ERC20_ABI,   functionName: "balanceOf",           args: address ? [address] : undefined },
      { address: AERO_ADDRESS,    abi: ERC20_ABI,   functionName: "balanceOf",           args: address ? [address] : undefined },
    ],
    query: { enabled: !!address },
  });

  const BALANCE_TOKENS = [
    { sym: "BLUEAGENT", decimals: 18, color: "#4FC3F7" },
    { sym: "USDC",  decimals: 6,  color: "#22C55E" },
    { sym: "WETH",  decimals: 18, color: "#A78BFA" },
    { sym: "cbBTC", decimals: 8,  color: "#F59E0B" },
    { sym: "AERO",  decimals: 18, color: "#F472B6" },
  ];
  const balances = BALANCE_TOKENS.map((t, i) => {
    const raw = contractData?.[i]?.result as bigint | undefined;
    const n = raw !== undefined ? Number(formatUnits(raw, t.decimals)) : null;
    return { ...t, amount: n };
  });

  const memberSince = chatStats.firstUsed
    ? new Date(chatStats.firstUsed).toLocaleDateString("en-US", { month: "short", year: "numeric" })
    : null;

  function copyAddress() {
    if (!address) return;
    navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  // Fetch the unified credit ledger from /api/credits/balance/[address].
  // This single source of truth replaces the old localStorage daily-quota:
  // balance = accrued (on-chain stake-time) + topup (USDC purchases) - spent.
  useEffect(() => {
    if (!address) { setLedger(null); return; }
    let cancelled = false;
    fetch(`/api/credits/balance/${address}`)
      .then(r => r.json())
      .then(d => {
        if (cancelled) return;
        if (d?.balance === undefined) { setLedger(null); return; }
        setLedger({
          accrued: Number(d.accrued ?? 0),
          topup:   Number(d.topup   ?? 0),
          spent:   Number(d.spent   ?? 0),
          balance: Number(d.balance ?? 0),
          dailyCr: Number(d.dailyCr ?? 0),
        });
      })
      .catch(() => { if (!cancelled) setLedger(null); });
    return () => { cancelled = true; };
  }, [address]);

  const scoreColor = builderScore !== null
    ? builderScore >= 70 ? "#34D399" : builderScore >= 40 ? "#4FC3F7" : "#F59E0B"
    : "#1A1A2E";

  return (
    <div className="relative">
      {/* Ambient glow */}
      <div className="pointer-events-none overflow-hidden absolute inset-x-0 top-0 h-[320px]">
        <div className="absolute inset-0"
          style={{ background: `radial-gradient(ellipse 80% 60% at 50% -10%, ${ACCENT}12 0%, transparent 70%)` }} />
      </div>

      <div className="relative px-3 sm:px-5 py-5 max-w-5xl mx-auto">

        {!isConnected ? (
          <AppConnectPrompt
            accent={ACCENT}
            title="Connect to see your dashboard"
            subtitle="Wallet · holdings · activity — all in one place."
            icon={
              <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 0 1 0 3.75H5.625a1.875 1.875 0 0 1 0-3.75Z" />
              </svg>
            }
          />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">

            {/* ─── Identity hero (2 col on ≥sm) ─────────────────────────── */}
            <BentoCell flavor="gradient" accent={ACCENT} className="sm:col-span-2 p-5">
              <div className="flex items-start justify-between gap-3 mb-5">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="relative shrink-0">
                    <div className="w-14 h-14 rounded-2xl flex items-center justify-center text-lg font-bold"
                      style={{ background: `linear-gradient(135deg, ${ACCENT}25, ${ACCENT}08)`,
                               border: `1px solid ${ACCENT}40`,
                               color: ACCENT,
                               boxShadow: `0 0 24px ${ACCENT}20` }}>
                      {address?.slice(2, 4).toUpperCase()}
                    </div>
                  </div>
                  <div className="min-w-0">
                    <button onClick={copyAddress} className="flex items-center gap-2 hover:opacity-80 transition-opacity max-w-full">
                      <span className="text-sm font-bold text-white truncate">
                        {basename ?? `${address?.slice(0, 6)}…${address?.slice(-4)}`}
                      </span>
                      <span className="text-[9px] text-slate-600 shrink-0">{copied ? "✓" : "copy"}</span>
                    </button>
                    {/* Member-since only — the stake tier badge was removed
                        with the stake surface; it read a token ladder the
                        credit system no longer applies. */}
                    <div className="flex items-center gap-2 mt-1.5">
                      {memberSince && <span className="text-[9px] text-slate-600">since {memberSince}</span>}
                    </div>
                  </div>
                </div>

                {/* Right rail — builder score chip + disconnect underneath, so
                    the wallet-swap action lives away from the identity line. */}
                <div className="flex flex-col items-end gap-2 shrink-0">
                  <div className="text-right">
                    <div className="text-[9px] text-slate-600 tracking-widest mb-1">BUILDER</div>
                    <div className="inline-flex items-baseline gap-0.5 px-2.5 py-1 rounded-lg"
                         style={{ background: `${scoreColor}10`, border: `1px solid ${scoreColor}25` }}>
                      <span className="text-xl font-bold leading-none" style={{ color: scoreColor }}>
                        {scoreLoading ? "—" : builderScore !== null ? builderScore : "—"}
                      </span>
                      {builderScore !== null && !scoreLoading && (
                        <span className="text-[8px] text-slate-700">/100</span>
                      )}
                    </div>
                  </div>
                  <button onClick={() => disconnect()}
                    className="text-[9px] text-slate-600 hover:text-red-400 underline-offset-2 hover:underline transition-colors">
                    disconnect
                  </button>
                </div>
              </div>

              {/* 3 stat chips reading from the credit ledger. BALANCE is the
                  spendable number; TOP-UP and SPENT explain the arithmetic
                  behind it. The former STAKED and USDC YIELD chips went with
                  the stake surface — both read a mechanism that no longer
                  feeds credits or pays out. */}
              <div className="grid grid-cols-3 gap-2">
                <StatChip
                  label="BALANCE"
                  value={ledger ? ledger.balance.toLocaleString() : "—"}
                  sub="credits · spendable"
                  color="#4FC3F7" />
                <StatChip
                  label="TOP-UP"
                  value={ledger ? ledger.topup.toLocaleString() : "—"}
                  sub="credits · bought"
                  color="#22C55E" />
                <StatChip
                  label="SPENT"
                  value={ledger ? ledger.spent.toLocaleString() : "—"}
                  sub="chat · tool runs"
                  color="#A78BFA" />
              </div>

              {/* Ledger breakdown — surfaces the spent + top-up history so the
                  user understands the BALANCE arithmetic. Only renders once
                  the ledger has loaded so we don't flash a zero row. */}
              {ledger && (ledger.spent > 0 || ledger.topup > 0) && (
                <div className="mt-3 flex items-center gap-2 text-[10px] text-slate-600">
                  <svg className="w-3 h-3 shrink-0 text-slate-700" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" />
                  </svg>
                  <span>
                    <span className="text-[#22C55E]">{ledger.topup.toLocaleString()} top-up</span>
                    {ledger.spent > 0  && <> − <span className="text-[#A78BFA]">{ledger.spent.toLocaleString()} spent</span></>}
                    {" "}= <span className="text-slate-400 font-medium">{ledger.balance.toLocaleString()} balance</span>
                  </span>
                </div>
              )}
            </BentoCell>

            {/* The STAKE mini-cell stood here — staked total, pending USDC,
                Starter/Pro/Max ladder and a "Stake now" button into the stake
                tab. Removed with the $BLUEAGENT relaunch: the ladder promised
                credits that `lib/credits.ts` no longer grants, and the tab it
                linked to is gone. */}

            {/* ─── Balances row (full width) ───────────────────────────── */}
            <BentoCell className="sm:col-span-3 p-5">
              <div className="flex items-center justify-between mb-3">
                <div className="text-[10px] text-slate-500 tracking-widest font-bold">BALANCES · BASE</div>
                <span className="text-[9px] text-slate-700">5 tokens</span>
              </div>
              <div className="grid grid-cols-5 gap-2">
                {balances.map(t => {
                  const isZero = !t.amount || t.amount === 0;
                  return (
                    <div key={t.sym}
                      className={`rounded-xl border p-2.5 ${isZero ? "border-[#1A1A2E]/40 bg-[#0a0a0f]/40 opacity-50" : "border-[#1A1A2E] bg-[#0a0a0f]"}`}>
                      <div className="text-[9px] tracking-widest mb-1 font-bold" style={{ color: t.color }}>{t.sym}</div>
                      <div className="text-[12px] sm:text-sm font-bold text-white leading-none truncate">
                        {t.amount === null ? "—" : fmtAmt(t.amount, t.decimals)}
                      </div>
                    </div>
                  );
                })}
              </div>
            </BentoCell>

            {/* ─── Quick actions + Chat activity (merged, full width) ───────
                One card: a compact action strip on top, then chat-usage stats
                below a divider. Previously two stacked full-width cells. */}
            <BentoCell className="sm:col-span-3 p-5">
              {/* Quick actions strip — icon + label only, no "Open →" subtext */}
              <div className="text-[10px] text-slate-500 tracking-widest font-bold mb-3">QUICK ACTIONS</div>
              <div className="grid grid-cols-2 gap-2">
                {[
                  { label: "Chat",      icon: "💬", href: "/chat",   color: "#4FC3F7" },
                  { label: "Hub",       icon: "🧰", href: "/hub",    color: "#22C55E" },
                  // Was "Blue Bank" → /bank, but /bank 301s to /chat (Bank archived in
                  // the Agent-OS relaunch). Point at the Wallet pillar instead.
                  { label: "Wallet",    icon: "👛", href: "/wallet", color: "#818CF8" },
                ].map(a => (
                  <Link key={a.label} href={a.href}
                    className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl border border-[#1A1A2E] bg-[#0a0a0f] hover:border-[#2a2a3e] hover:bg-white/[0.02] transition-all">
                    <span className="w-8 h-8 rounded-lg flex items-center justify-center text-sm shrink-0"
                          style={{ background: `${a.color}15`, border: `1px solid ${a.color}25` }}>{a.icon}</span>
                    <span className="text-[11px] tracking-widest font-bold" style={{ color: a.color }}>{a.label.toUpperCase()}</span>
                  </Link>
                ))}
              </div>

              {/* Divider */}
              <div className="border-t border-[#1A1A2E] my-4" />

              {/* Chat activity */}
              <div className="flex items-center justify-between mb-3">
                <div className="text-[10px] text-slate-500 tracking-widest font-bold">BLUE CHAT ACTIVITY</div>
                {chatStats.totalSessions > 0 && (
                  <Link href="/chat" className="text-[10px] text-[#4FC3F7] hover:underline">Open chat →</Link>
                )}
              </div>
              {chatStats.totalSessions > 0 ? (
                <div className="grid grid-cols-1 sm:grid-cols-[180px_1fr] gap-4">
                  {/* 3-stat block */}
                  <div className="grid grid-cols-3 sm:grid-cols-1 gap-2.5">
                    <div className="rounded-xl border border-[#1A1A2E] bg-[#0a0a0f] px-3 py-2.5">
                      <div className="text-[9px] text-slate-600 tracking-widest mb-1">SESSIONS</div>
                      <div className="text-lg font-bold text-white leading-none">{chatStats.totalSessions.toLocaleString()}</div>
                    </div>
                    <div className="rounded-xl border border-[#1A1A2E] bg-[#0a0a0f] px-3 py-2.5">
                      <div className="text-[9px] text-slate-600 tracking-widest mb-1">RESPONSES</div>
                      <div className="text-lg font-bold text-white leading-none">{chatStats.totalMessages.toLocaleString()}</div>
                    </div>
                    <div className="rounded-xl border border-[#1A1A2E] bg-[#0a0a0f] px-3 py-2.5">
                      <div className="text-[9px] text-slate-600 tracking-widest mb-1">CREDITS</div>
                      <div className="text-lg font-bold text-[#4FC3F7] leading-none">{chatStats.totalCreditsUsed.toLocaleString()}</div>
                    </div>
                  </div>
                  {/* Top tools */}
                  {chatStats.toolsUsed.length > 0 && (
                    <div className="rounded-xl border border-[#1A1A2E] bg-[#0a0a0f] p-3.5">
                      <p className="text-[9px] text-slate-700 tracking-widest mb-2.5">TOP TOOLS</p>
                      <div className="space-y-1.5">
                        {chatStats.toolsUsed.map(t => {
                          const maxCount = chatStats.toolsUsed[0].count;
                          return (
                            <div key={t.name} className="flex items-center gap-2.5">
                              <span className="text-[10px] text-slate-400 w-28 sm:w-36 shrink-0 truncate">{t.name.replace(/_/g, " ")}</span>
                              <div className="flex-1 h-1 bg-[#1A1A2E] rounded-full overflow-hidden">
                                <div className="h-full rounded-full"
                                  style={{ width: `${(t.count / maxCount) * 100}%`,
                                           background: "linear-gradient(90deg, #4FC3F780, #4FC3F7)" }} />
                              </div>
                              <span className="text-[9px] text-slate-600 w-5 text-right shrink-0">{t.count}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-center py-5">
                  <div className="text-2xl mb-2">💬</div>
                  <p className="text-sm font-bold text-white mb-1">Start your first chat</p>
                  <p className="text-[11px] text-slate-600 mb-4">5 commands · pay per call in USDC</p>
                  <Link href="/chat"
                    className="inline-flex items-center justify-center gap-1.5 text-[11px] font-bold px-4 py-2 rounded-lg bg-[#4FC3F7] text-[#050508] hover:bg-[#29ABE2] transition-colors">
                    Open Blue Chat →
                  </Link>
                </div>
              )}
            </BentoCell>

            {/* ─── Footer links ─────────────────────────────────────────── */}
            <div className="sm:col-span-3 flex flex-wrap gap-3 text-[10px] text-slate-700 justify-center pt-2">
              <a href={`https://basescan.org/address/${address}`} target="_blank" rel="noopener noreferrer"
                className="hover:text-slate-500 transition-colors">Basescan ↗</a>
            </div>

          </div>
        )}
      </div>
    </div>
  );
}
