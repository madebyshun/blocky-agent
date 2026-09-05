"use client";

import { useState, useTransition, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { useAccount, useSendTransaction, useSwitchChain } from "wagmi";
import { useAppChrome } from "@/app/app/AppChrome";
import { ConnectButton } from "@/components/ConnectModal";
import { useLang } from "@/lib/i18n/context";
import { runB20Inspect }  from "./inspect-action";
import { runB20Roles }    from "./roles-action";
import { runB20Registry, runB20Activity, runB20Activation, runB20AdminRenounced } from "./registry-action";
import { runB20ManageLoad, type ManageData } from "./manage-action";
import ManagePanel from "./ManagePanel";
import WatchlistTab from "./WatchlistTab";
import type { B20Inspection, PolicyInfo } from "@/lib/b20/inspect";
import type { B20RolesResult }            from "@/lib/b20/roles";
import type { B20RegistryResult }         from "@/lib/b20/registry-logs";
import type { B20ActivityResult, B20ActivityCategory, B20AdminRenounceResult } from "@/lib/b20/activity-cdp";
import type { B20Activation }             from "@/lib/b20/activation";

// ── Types ─────────────────────────────────────────────────────────────────────

type Tab     = "scanner" | "roles" | "registry" | "launch" | "manage" | "watchlist" | "methodology";
type Network = "mainnet" | "sepolia";

// ── localStorage helpers ──────────────────────────────────────────────────────

const LS_RECENT    = "b20:recent-scans";
const LS_MY_TOKENS = "b20:my-tokens";

type RecentScan = { address: string; name: string; symbol: string; network: Network; timestamp: number };
type MyToken    = { address: string; name: string; symbol: string; network: Network; deployer: string; timestamp: number };

function lsGet<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try { const raw = localStorage.getItem(key); if (!raw) return fallback; return JSON.parse(raw) as T; }
  catch { return fallback; }
}
function lsSet<T>(key: string, value: T): void {
  if (typeof window === "undefined") return;
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

// ── Shared input style ────────────────────────────────────────────────────────

const INPUT_CLS = [
  "w-full bg-[#0a0a12] border border-[#1A1A2E]",
  "focus:border-[#4FC3F740] rounded-xl px-3 py-2.5",
  "font-mono text-sm text-slate-200 placeholder:text-slate-700",
  "outline-none transition-colors",
].join(" ");

// ── Icons ─────────────────────────────────────────────────────────────────────

const TabIcons: Record<Tab, React.ReactNode> = {
  scanner: (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
      <path strokeLinecap="round" strokeLinejoin="round"
        d="M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285Z" />
    </svg>
  ),
  roles: (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
      <path strokeLinecap="round" strokeLinejoin="round"
        d="M15.75 5.25a3 3 0 0 1 3 3m3 0a6 6 0 0 1-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1 1 21.75 8.25Z" />
    </svg>
  ),
  registry: (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
      <path strokeLinecap="round" strokeLinejoin="round"
        d="M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.007v.008H3.75V6.75Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0ZM3.75 12h.007v.008H3.75V12Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm-.375 5.25h.007v.008H3.75v-.008Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" />
    </svg>
  ),
  launch: (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
      <path strokeLinecap="round" strokeLinejoin="round"
        d="M15.59 14.37a6 6 0 0 1-5.84 7.38v-4.8m5.84-2.58a14.98 14.98 0 0 0 6.16-12.12A14.98 14.98 0 0 0 9.631 8.41m5.96 5.96a14.926 14.926 0 0 1-5.841 2.58m-.119-8.54a6 6 0 0 0-7.381 5.84h4.8m2.581-5.84a14.927 14.927 0 0 0-2.58 5.84m2.699 2.7c-.103.021-.207.041-.311.06a15.09 15.09 0 0 1-2.448-2.448 14.9 14.9 0 0 1 .06-.312m-2.24 2.39a4.493 4.493 0 0 0-1.757 4.306 4.493 4.493 0 0 0 4.306-1.758M16.5 9a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Z" />
    </svg>
  ),
  manage: (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
      <path strokeLinecap="round" strokeLinejoin="round"
        d="M10.343 3.94c.09-.542.56-.94 1.11-.94h1.093c.55 0 1.02.398 1.11.94l.149.894c.07.424.384.764.78.93.398.164.855.142 1.205-.108l.737-.527a1.125 1.125 0 0 1 1.45.12l.773.774c.39.389.44 1.002.12 1.45l-.527.737c-.25.35-.272.806-.107 1.204.165.397.505.71.93.78l.893.15c.543.09.94.56.94 1.109v1.094c0 .55-.397 1.02-.94 1.11l-.893.149c-.425.07-.765.383-.93.78-.165.398-.143.854.107 1.204l.527.738c.32.447.269 1.06-.12 1.45l-.774.773a1.125 1.125 0 0 1-1.449.12l-.738-.527c-.35-.25-.806-.272-1.203-.107-.397.165-.71.505-.781.929l-.149.894c-.09.542-.56.94-1.11.94h-1.094c-.55 0-1.019-.398-1.11-.94l-.148-.894c-.071-.424-.384-.764-.781-.93-.398-.164-.854-.142-1.204.108l-.738.527c-.447.32-1.06.269-1.45-.12l-.773-.774a1.125 1.125 0 0 1-.12-1.45l.527-.737c.25-.35.273-.806.108-1.204-.165-.397-.505-.71-.93-.78l-.894-.15c-.542-.09-.94-.56-.94-1.109v-1.094c0-.55.398-1.02.94-1.11l.894-.149c.424-.07.765-.383.93-.78.165-.398.143-.854-.108-1.204l-.526-.738a1.125 1.125 0 0 1 .12-1.45l.773-.773a1.125 1.125 0 0 1 1.45-.12l.737.527c.35.25.807.272 1.204.107.397-.165.71-.505.78-.929l.15-.894Z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
    </svg>
  ),
  watchlist: (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
      <path strokeLinecap="round" strokeLinejoin="round"
        d="M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0" />
    </svg>
  ),
  methodology: (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
      <path strokeLinecap="round" strokeLinejoin="round"
        d="M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0-6 2.292m0-14.25v14.25" />
    </svg>
  ),
};

const DocsIcon = (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
    <path strokeLinecap="round" strokeLinejoin="round"
      d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
  </svg>
);

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "scanner",  label: "Scanner"  },
  { id: "roles",    label: "Roles"    },
  { id: "registry", label: "Registry" },
  { id: "launch",   label: "Launch"   },
  { id: "manage",   label: "Manage"   },
  { id: "watchlist", label: "Watchlist" },
  { id: "methodology", label: "Methodology" },
];

// ── Utilities ─────────────────────────────────────────────────────────────────

function isValidAddr(v: string) { return /^0x[a-fA-F0-9]{40}$/.test(v.trim()); }
function truncAddr(a: string, n = 6) { return `${a.slice(0, n)}…${a.slice(-4)}`; }

// ── Recent Activity (control events) — color map + relative time ──────────────
// pause=amber · policy=blue · cap=gray · role=purple · burnBlocked=red · admin=magenta
const ACTIVITY_COLOR: Record<B20ActivityCategory, string> = {
  pause:       "#F59E0B",
  policy:      "#4FC3F7",
  cap:         "#94A3B8",
  role:        "#A78BFA",
  burnBlocked: "#EF4444",
  admin:       "#D946EF",
};
const ACTIVITY_LABEL: Record<B20ActivityCategory, string> = {
  pause:       "PAUSE",
  policy:      "POLICY",
  cap:         "CAP",
  role:        "ROLE",
  burnBlocked: "FREEZE",
  admin:       "ADMIN",
};
// ── Compliance CSV export (control events) ────────────────────────────────────
// Client-side only — serializes the activity events already loaded from CDP into
// a CSV a compliance/regulator audit can ingest. No new fetch, no server call.

/** RFC-4180 escape: wrap in quotes and double any embedded quotes. */
function csvCell(v: string): string {
  const s = (v ?? "").replace(/\r?\n/g, " ");
  return `"${s.replace(/"/g, '""')}"`;
}

function activityToCsv(events: B20ActivityResult["events"]): string {
  const header = ["timestamp", "event_type", "category", "token", "detail", "tx_hash", "explorer_url"];
  const rows = events.map(e => [
    e.timestamp ?? "",
    e.eventName ?? "",
    e.category ?? "",
    e.token ?? "",
    e.text ?? "",
    e.txHash ?? "",
    e.explorerUrl ?? "",
  ].map(csvCell).join(","));
  return [header.map(csvCell).join(","), ...rows].join("\r\n");
}

function downloadActivityCsv(result: B20ActivityResult): void {
  if (typeof window === "undefined" || !result.events.length) return;
  const csv  = activityToCsv(result.events);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  const day  = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `b20-control-events-${result.network}-${day}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function timeAgo(iso: string): string {
  const t = Date.parse(iso);
  if (!iso || Number.isNaN(t)) return "";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60)     return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60)     return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24)     return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30)     return `${d}d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

interface VerdictLine { kind: "danger" | "warn" | "info" | "ok"; text: string }

const WAD = 1_000_000_000_000_000_000n; // 1e18 — multiplier base (no rebase)

/** Format a WAD-precision rebase multiplier (1e18) → "1.05×". "1.00×" = no rebase. */
function formatMultiplier(raw?: string): string | null {
  if (!raw) return null;
  let v: bigint;
  try { v = BigInt(raw); } catch { return null; }
  // 2-decimal fixed: (v * 100) / 1e18, then insert the decimal point.
  const scaled = (v * 100n) / WAD;
  const whole  = scaled / 100n;
  const frac   = (scaled % 100n).toString().padStart(2, "0");
  return `${whole}.${frac}×`;
}

/** True when the multiplier is anything other than exactly 1e18 (rebase active). */
function hasRebase(raw?: string): boolean {
  if (!raw) return false;
  try { return BigInt(raw) !== WAD; } catch { return false; }
}

function computeVerdict(info: B20Inspection): VerdictLine[] {
  const lines: VerdictLine[] = [];
  // Initialization gate — a B20 can exist (factory registered it) before its
  // initCalls finished, so roles / supply cap / policies may not be set yet.
  if (info.isB20 && info.initialized === false)
    lines.push({ kind: "warn", text: "B20 exists but is not fully initialized — roles, supply cap, or policies may not be set yet. Treat its config as incomplete." });
  if (info.paused?.transfer) lines.push({ kind: "warn", text: "Transfers are paused by the issuer." });
  if (info.paused?.mint)     lines.push({ kind: "warn", text: "Minting is paused." });
  if (info.paused?.burn)     lines.push({ kind: "warn", text: "Burns are paused." });
  const sl: Record<string, string> = {
    transferSender: "transfer sender", transferReceiver: "transfer receiver",
    transferExecutor: "transfer executor", mintReceiver: "mint receiver",
  };
  if (info.policies) {
    for (const [scope, policy] of Object.entries(info.policies) as [string, PolicyInfo][]) {
      if (policy.kind === "blocked")
        lines.push({ kind: "danger", text: `One or more transfer scopes are completely blocked — ${sl[scope] ?? scope} uses ALWAYS_BLOCK (denies everyone).` });
      else if (policy.kind === "custom")
        lines.push({ kind: "warn", text: `Policy-gated on ${sl[scope] ?? scope} scope (custom policy #${policy.policyId}).` });
    }
  }
  if (info.supplyCapUncapped) lines.push({ kind: "warn", text: "Uncapped supply — issuer can mint unlimited tokens." });
  // Rebase multiplier is informational, not a warning — balances are scaled by it.
  if (info.variant === "ASSET" && hasRebase(info.multiplier))
    lines.push({ kind: "info", text: `Token uses a rebase multiplier (${formatMultiplier(info.multiplier)}) — displayed balance may differ from the raw minted amount.` });
  // Admin status — only what we can verify for the connected wallet.
  if (info.admin?.checkedAccount) {
    if (info.admin.connectedIsAdmin)
      lines.push({ kind: "info", text: "Your connected wallet holds DEFAULT_ADMIN on this token." });
    else
      lines.push({ kind: "info", text: "Your connected wallet does not hold DEFAULT_ADMIN. Other holders can't be listed (B20 omits role enumeration)." });
  }
  const noPause = !info.paused?.transfer && !info.paused?.mint && !info.paused?.burn;
  const noGate  = !info.policies || Object.values(info.policies).every(p => p.kind === "open");
  if (noPause && noGate) lines.push({ kind: "ok", text: "No issuer-side transfer restrictions detected." });
  if (!info.supplyCapUncapped && info.supplyCapFormatted && info.supplyCapFormatted !== "uncapped")
    lines.push({ kind: "ok", text: `Supply capped at ${info.supplyCapFormatted} ${info.symbol ?? "tokens"}.` });
  return lines;
}

// ── Shared UI pieces ──────────────────────────────────────────────────────────

function VariantBadge({ variant, currency }: { variant?: string; currency?: string }) {
  const colors: Record<string, { bg: string; text: string; border: string }> = {
    ASSET:      { bg: "#4FC3F718", text: "#4FC3F7", border: "#4FC3F730" },
    STABLECOIN: { bg: "#22C55E18", text: "#22C55E", border: "#22C55E30" },
    UNKNOWN:    { bg: "#64748b18", text: "#94a3b8", border: "#64748b30" },
  };
  const c = colors[variant ?? "UNKNOWN"] ?? colors.UNKNOWN;
  const label = variant === "STABLECOIN" && currency
    ? `STABLECOIN · ${currency}`
    : (variant ?? "UNKNOWN");
  return (
    <span className="font-mono text-[10px] px-2 py-0.5 rounded-full border"
      style={{ background: c.bg, color: c.text, borderColor: c.border }}>
      {label}
    </span>
  );
}

function StatusDot({ active, label }: { active: boolean; label: string }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl border"
      style={{ borderColor: active ? "#22C55E30" : "#EF444430", background: active ? "#22C55E08" : "#EF444408" }}>
      <span className="w-2 h-2 rounded-full shrink-0"
        style={{ background: active ? "#22C55E" : "#EF4444", boxShadow: active ? "0 0 5px #22C55E80" : "0 0 5px #EF444480" }} />
      <span className="font-mono text-xs font-medium" style={{ color: active ? "#22C55E" : "#EF4444" }}>{label}</span>
      <span className="font-mono text-[9px] text-slate-700 ml-auto">{active ? "active" : "paused"}</span>
    </div>
  );
}

function PolicyRow({ label, policy }: { label: string; policy: PolicyInfo }) {
  return (
    <div className="flex items-center justify-between py-2.5 border-b border-[#0d0d18] last:border-0">
      <span className="font-mono text-xs text-slate-400">{label}</span>
      {policy.kind === "blocked" ? (
        <span className="font-mono text-[10px] px-2 py-0.5 rounded-full border"
          style={{ background: "#EF444418", color: "#EF4444", borderColor: "#EF444440" }}>
          ALWAYS_BLOCK ⛔
        </span>
      ) : policy.kind === "custom" ? (
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] px-2 py-0.5 rounded-full border"
            style={{ background: "#F59E0B15", color: "#F59E0B", borderColor: "#F59E0B30" }}>
            CUSTOM #{policy.policyId}
          </span>
        </div>
      ) : (
        <span className="font-mono text-xs" style={{ color: "#22C55E" }}>ALWAYS_ALLOW</span>
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="font-mono text-[9px] text-slate-600 tracking-widest uppercase mb-2">{children}</p>;
}

function InfoChip({ children, color = "#4FC3F7" }: { children: React.ReactNode; color?: string }) {
  return (
    <span className="font-mono text-[10px] px-2.5 py-0.5 rounded-full border"
      style={{ color, borderColor: `${color}35`, background: `${color}0a` }}>
      {children}
    </span>
  );
}

function SideCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-[#1A1A2E] overflow-hidden">
      <div className="px-4 py-3 bg-[#0a0a0f] border-b border-[#1A1A2E]">
        <p className="font-mono text-[9px] text-slate-600 tracking-widest uppercase">{title}</p>
      </div>
      {children}
    </div>
  );
}

// ── Methodology tab ───────────────────────────────────────────────────────────
// Facts here MUST match computeVerdict() + inspectB20(). Do not invent steps.

const METHOD_FLOW: string[] = [
  "Validate the address format.",
  "Check isB20 against the B20Factory — confirm it is a real B20, not arbitrary EVM bytecode.",
  "Read core state: name, symbol, decimals, total supply, supply cap, and variant.",
  "Read pause status per feature: transfer, mint, and burn.",
  "Read the policy ID per scope: transfer sender, receiver, executor, and mint receiver.",
  "Read variant detail: the rebase multiplier (Asset) or the currency code (Stablecoin).",
];

const METHOD_VERDICT: { kind: "warn" | "ok"; text: string }[] = [
  { kind: "warn", text: "Transfers, mint, or burn are paused — the issuer can freeze that operation." },
  { kind: "warn", text: "A transfer or mint scope is policy-gated by an allowlist or blocklist, not open." },
  { kind: "warn", text: "Supply is uncapped — the issuer can mint without limit." },
  { kind: "ok",   text: "No pauses, no restrictive policies, and a capped supply — no issuer-side transfer restrictions detected at read time." },
];

const METHOD_LIMITS: string[] = [
  "B20 omits AccessControlEnumerable, so role holders cannot be listed — each role is only checked per wallet via hasRole.",
  "Reads reflect on-chain state at the moment of the scan. Roles and policies can change afterward.",
  "Advisory only — verify independently before trusting or trading a token.",
];

function MethodologyMain({ onScan }: { onScan: () => void }) {
  return (
    <div className="max-w-2xl">
      <h2 className="font-mono text-base font-semibold text-white mb-1.5">How the B20 scanner works</h2>
      <p className="font-mono text-xs text-slate-400 leading-relaxed mb-6">
        Every result in the Scanner is read live from Base RPC via multicall — zero LLM, zero guessing.
        The numbers and flags come straight from on-chain state, never from a model.
      </p>

      {/* Inspection flow */}
      <SectionLabel>Inspection flow</SectionLabel>
      <ol className="space-y-2 mb-7 mt-1">
        {METHOD_FLOW.map((step, i) => (
          <li key={i} className="flex gap-3 items-start">
            <span className="font-mono text-[11px] text-[#4FC3F7] shrink-0 mt-px w-4">{i + 1}.</span>
            <span className="font-mono text-[11px] text-slate-400 leading-relaxed">{step}</span>
          </li>
        ))}
      </ol>

      {/* Trust verdict */}
      <SectionLabel>Trust verdict — deterministic, not a score</SectionLabel>
      <p className="font-mono text-[11px] text-slate-500 leading-relaxed mb-3 mt-1">
        We surface concrete flags, never a single pass/fail number that would overstate certainty. The verdict
        is computed in code from the reads above, so the same on-chain state always yields the same flags.
      </p>
      <div className="rounded-2xl border border-[#1A1A2E] bg-[#0a0a12] divide-y divide-[#0d0d18] mb-7">
        {METHOD_VERDICT.map(({ kind, text }, i) => (
          <div key={i} className="flex items-start gap-3 px-4 py-3">
            <span className="font-mono text-sm shrink-0 mt-px" style={{ color: kind === "warn" ? "#F59E0B" : "#22C55E" }}>
              {kind === "warn" ? "!" : "✓"}
            </span>
            <span className="font-mono text-[11px] leading-relaxed" style={{ color: kind === "warn" ? "#FCD34D" : "#86efac" }}>
              {text}
            </span>
          </div>
        ))}
      </div>

      {/* Limitations */}
      <SectionLabel>Limitations</SectionLabel>
      <ul className="space-y-2 mb-7 mt-1">
        {METHOD_LIMITS.map((text, i) => (
          <li key={i} className="flex gap-3 items-start">
            <span className="font-mono text-[11px] text-slate-600 shrink-0 mt-px">—</span>
            <span className="font-mono text-[11px] text-slate-400 leading-relaxed">{text}</span>
          </li>
        ))}
      </ul>

      <button onClick={onScan}
        className="font-mono text-xs px-4 py-2 rounded-xl transition-all"
        style={{ background: "#4FC3F720", color: "#4FC3F7", border: "1px solid #4FC3F740" }}>
        Scan a token →
      </button>
    </div>
  );
}

function MethodologySide() {
  const sources: { name: string; reads: string }[] = [
    { name: "B20Factory",     reads: "isB20 · isB20Initialized" },
    { name: "Token contract", reads: "name · symbol · decimals · totalSupply · supplyCap · isPaused · policyId" },
    { name: "PolicyRegistry", reads: "policyAdmin (per restricted policy)" },
  ];
  return (
    <>
      <SideCard title="Data Sources">
        <div className="divide-y divide-[#0d0d18]">
          {sources.map(s => (
            <div key={s.name} className="px-4 py-3">
              <code className="font-mono text-[10px] text-[#4FC3F7] block mb-0.5">{s.name}</code>
              <span className="font-mono text-[9px] text-slate-500 leading-relaxed break-words">{s.reads}</span>
            </div>
          ))}
        </div>
      </SideCard>

      <SideCard title="Guarantees">
        <div className="px-4 py-3 space-y-2.5">
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-[#22C55E] shrink-0" style={{ boxShadow: "0 0 4px #22C55E60" }} />
            <span className="font-mono text-[10px] text-slate-400">No LLM in the read path</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-[#22C55E] shrink-0" style={{ boxShadow: "0 0 4px #22C55E60" }} />
            <span className="font-mono text-[10px] text-slate-400">Same state → same verdict</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-[#22C55E] shrink-0" style={{ boxShadow: "0 0 4px #22C55E60" }} />
            <span className="font-mono text-[10px] text-slate-400">All reads on Base, on-chain</span>
          </div>
        </div>
      </SideCard>

      <SideCard title="Full Spec">
        <div className="px-4 py-3">
          <p className="font-mono text-[10px] text-slate-500 leading-relaxed mb-2">
            Roles, policy system, variants, and key addresses in the Beryl / B20 docs.
          </p>
          <a href="/docs/beryl#methodology"
            className="font-mono text-[10px] text-[#4FC3F7] hover:opacity-80 transition-opacity">
            Read the B20 docs ↗
          </a>
        </div>
      </SideCard>
    </>
  );
}

// ── Scanner result card ───────────────────────────────────────────────────────

function ResultCard({ info, renounce, onScanAnother, onHowItWorks }: { info: B20Inspection; renounce?: B20AdminRenounceResult | null; onScanAnother: () => void; onHowItWorks?: () => void }) {
  const { t } = useLang();
  const [copied, setCopied] = useState(false);
  const verdict   = computeVerdict(info);
  const hasDanger = verdict.some(v => v.kind === "danger");
  const hasWarns  = verdict.some(v => v.kind === "warn");
  const trustColor = hasDanger ? "#EF4444" : hasWarns ? "#F59E0B" : "#22C55E";

  if (!info.isB20) {
    return (
      <div className="rounded-2xl border border-[#1A1A2E] overflow-hidden mt-5">
        <div className="px-5 py-4 bg-[#0a0a0f] border-b border-[#1A1A2E] flex items-center gap-3">
          <span className="font-mono text-xl text-slate-500">✕</span>
          <div>
            <p className="font-mono text-sm font-bold text-white">Not a B20 Token</p>
            <p className="font-mono text-xs text-slate-500 mt-0.5">This address is not a B20 token on {info.network}.</p>
          </div>
        </div>
        <div className="px-5 py-4">
          <p className="font-mono text-[10px] text-slate-600 break-all mb-2">{info.address}</p>
          {info._note && <p className="font-mono text-xs text-slate-500 mb-4">{info._note}</p>}
          <div className="flex gap-2 flex-wrap">
            <a href={info.explorerUrl} target="_blank" rel="noopener noreferrer"
              className="font-mono text-xs px-3 py-1.5 rounded-xl border border-[#1A1A2E] text-slate-400 hover:text-white transition-colors">
              View on Basescan ↗
            </a>
            <button onClick={onScanAnother}
              className="font-mono text-xs px-3 py-1.5 rounded-xl border text-[#4FC3F7] transition-colors"
              style={{ borderColor: "#4FC3F730" }}>
              Scan another →
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border overflow-hidden mt-5" style={{ borderColor: `${trustColor}35` }}>
      {/* Header */}
      <div className="px-5 py-4 border-b border-[#1A1A2E]" style={{ background: `${trustColor}06` }}>
        <div className="flex flex-wrap items-start justify-between gap-2 mb-2">
          <div>
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <span className="font-mono text-lg font-bold text-white">{info.name ?? "—"}</span>
              {info.symbol && <span className="font-mono text-sm text-slate-400">${info.symbol}</span>}
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-mono text-[10px] px-2 py-0.5 rounded-full border"
                style={{ background: "#22C55E18", color: "#22C55E", borderColor: "#22C55E30" }}>✓ B20</span>
              {info.initialized === false && (
                <span className="font-mono text-[10px] px-2 py-0.5 rounded-full border"
                  style={{ background: "#F59E0B18", color: "#F59E0B", borderColor: "#F59E0B30" }}>⚠ Not initialized</span>
              )}
              <VariantBadge variant={info.variant} currency={info.currency} />
              {/* Immutability — shown ONLY when a LastAdminRenounced event is
                  confirmed on-chain for this exact token. Absence ⟹ no badge
                  (we never claim immutability we can't prove). */}
              {renounce?.renounced && (
                <a
                  href={renounce.explorerUrl ?? info.explorerUrl}
                  target="_blank" rel="noopener noreferrer"
                  title="DEFAULT_ADMIN_ROLE was permanently renounced (renounceLastAdmin). Roles & policies can no longer be reassigned. Verified on-chain via LastAdminRenounced."
                  className="font-mono text-[10px] px-2 py-0.5 rounded-full border transition-opacity hover:opacity-80"
                  style={{ background: "#22C55E18", color: "#22C55E", borderColor: "#22C55E40" }}>
                  🔒 Admin renounced
                </a>
              )}
              <span className="font-mono text-[10px] text-slate-500">
                {info.network === "mainnet" ? "Base Mainnet" : "Base Sepolia"}
              </span>
              <span className="font-mono text-[9px] text-slate-600">
                {(info.rpcLatencyMs / 1000).toFixed(2)}s
              </span>
            </div>
          </div>
          <span className="font-mono text-xs px-2.5 py-1 rounded-full border shrink-0"
            style={{ background: `${trustColor}12`, color: trustColor, borderColor: `${trustColor}40` }}>
            {hasDanger ? "Transfers blocked" : hasWarns ? "Restrictions found" : "No restrictions"}
          </span>
        </div>
        <a href={info.explorerUrl} target="_blank" rel="noopener noreferrer"
          className="font-mono text-[9px] text-slate-600 hover:text-[#4FC3F7] transition-colors break-all">
          {info.address}
        </a>
      </div>

      <div className="p-5 space-y-5">
        {/* Stablecoin peg banner — surfaces the currency peg prominently so a
            B20 stablecoin reads clearly as "pegged to X", not buried in the
            generic facts grid like an Asset token. */}
        {info.variant === "STABLECOIN" && (
          <div className="flex items-center gap-3 rounded-2xl border px-4 py-3"
            style={{ background: "#22C55E0a", borderColor: "#22C55E30" }}>
            <span className="w-9 h-9 rounded-xl flex items-center justify-center text-lg shrink-0"
              style={{ background: "#22C55E18" }}>💵</span>
            <div className="min-w-0">
              <p className="font-mono text-sm font-semibold" style={{ color: "#22C55E" }}>
                B20 Stablecoin{info.currency ? ` · pegged to ${info.currency}` : ""}
              </p>
              <p className="font-mono text-[10px] text-slate-500 mt-0.5">
                {info.currency
                  ? `Issuer-declared currency peg: ${info.currency}. Backing & redemption are off-chain — verify with the issuer.`
                  : "Stablecoin variant — currency code not set on-chain."}
              </p>
            </div>
          </div>
        )}

        {/* Key Facts */}
        <div>
          <SectionLabel>Token Info</SectionLabel>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {[
              { label: "Decimals",     value: info.decimals?.toString() ?? "—" },
              { label: "Total Supply", value: info.totalSupplyFormatted ?? "—" },
              { label: "Supply Cap",   value: info.supplyCapFormatted ?? "—" },
              ...(info.variant === "STABLECOIN" && info.currency
                ? [{ label: "Currency", value: info.currency }] : []),
              ...(info.variant === "ASSET" && info.multiplier
                ? [{ label: "Multiplier", value: hasRebase(info.multiplier)
                      ? `${formatMultiplier(info.multiplier)} (rebase active)`
                      : "No rebase (1.00×)" }] : []),
              ...(info.admin?.checkedAccount
                ? [{ label: "Admin (your wallet)", value: info.admin.connectedIsAdmin ? t("scanner.you_hold_admin") : t("scanner.not_admin") }]
                : [{ label: "Admin", value: t("scanner.unknown_admin") }]),
            ].map(({ label, value }) => (
              <div key={label} className="rounded-xl bg-[#0a0a12] border border-[#1A1A2E] px-3 py-2.5">
                <p className="font-mono text-[9px] text-slate-600 mb-0.5">{label}</p>
                <p className="font-mono text-xs text-slate-200">{value}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Pause Status */}
        {info.paused && (
          <div>
            <SectionLabel>Pause Status</SectionLabel>
            <div className="grid grid-cols-3 gap-2">
              <StatusDot active={!info.paused.transfer} label="Transfer" />
              <StatusDot active={!info.paused.mint}     label="Mint"     />
              <StatusDot active={!info.paused.burn}     label="Burn"     />
            </div>
          </div>
        )}

        {/* Transfer Policies */}
        {info.policies && (
          <div>
            <SectionLabel>Transfer Policies</SectionLabel>
            <div className="rounded-xl border border-[#1A1A2E] bg-[#0a0a12] px-4 py-1">
              <PolicyRow label="Transfer Sender"   policy={info.policies.transferSender} />
              <PolicyRow label="Transfer Receiver" policy={info.policies.transferReceiver} />
              <PolicyRow label="Transfer Executor" policy={info.policies.transferExecutor} />
              <PolicyRow label="Mint Receiver"     policy={info.policies.mintReceiver} />
            </div>
          </div>
        )}

        {/* Trust Verdict */}
        <div>
          <SectionLabel>{t("scanner.trust_verdict")}</SectionLabel>
          <div className="rounded-xl border px-4 py-3 space-y-2.5"
            style={{ borderColor: `${trustColor}25`, background: `${trustColor}05` }}>
            {verdict.map((line, i) => {
              const icon  = line.kind === "danger" ? "⛔" : line.kind === "warn" ? "!" : line.kind === "info" ? "ℹ" : "✓";
              const iconC = line.kind === "danger" ? "#EF4444" : line.kind === "warn" ? "#F59E0B" : line.kind === "info" ? "#4FC3F7" : "#22C55E";
              const textC = line.kind === "danger" ? "#FCA5A5" : line.kind === "warn" ? "#FCD34D" : line.kind === "info" ? "#7DD3FC" : "#86efac";
              return (
                <div key={i} className="flex items-start gap-2.5">
                  <span className="font-mono text-sm shrink-0 mt-px" style={{ color: iconC }}>{icon}</span>
                  <span className="font-mono text-xs leading-relaxed" style={{ color: textC }}>{line.text}</span>
                </div>
              );
            })}
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 pt-2 border-t border-[#1A1A2E]">
              <p className="font-mono text-[9px] text-slate-600">
                Reflects on-chain config at read time. Roles and policies can be changed by the issuer.
              </p>
              <button onClick={onHowItWorks}
                className="font-mono text-[9px] text-[#4FC3F7] hover:opacity-80 transition-opacity shrink-0">
                How this works ↗
              </button>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-wrap gap-2 pt-1">
          <button onClick={() => {
              navigator.clipboard.writeText(info.address)
                .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
            }}
            className="font-mono text-xs px-3 py-1.5 rounded-xl border border-[#1A1A2E] text-slate-400 hover:text-white transition-colors">
            {copied ? "Copied ✓" : "Copy address"}
          </button>
          <button onClick={() => {
              const p = new URLSearchParams({ address: info.address, network: info.network });
              navigator.clipboard.writeText(`${window.location.origin}/b20?${p}`);
            }}
            className="font-mono text-xs px-3 py-1.5 rounded-xl border border-[#1A1A2E] text-slate-400 hover:text-white transition-colors">
            Share link
          </button>
          <a href={info.explorerUrl} target="_blank" rel="noopener noreferrer"
            className="font-mono text-xs px-3 py-1.5 rounded-xl border border-[#1A1A2E] text-slate-400 hover:text-white transition-colors">
            Basescan ↗
          </a>
          <button onClick={onScanAnother}
            className="font-mono text-xs px-3 py-1.5 rounded-xl border text-[#4FC3F7] hover:border-[#4FC3F750] transition-colors"
            style={{ borderColor: "#4FC3F730" }}>
            Scan another →
          </button>
        </div>
      </div>
    </div>
  );
}

// ── LaunchMyTokens ────────────────────────────────────────────────────────────

function LaunchMyTokens() {
  const { address } = useAccount();
  const [myTokens, setMyTokens] = useState<MyToken[]>([]);
  const [copiedAddr, setCopiedAddr] = useState<string | null>(null);

  useEffect(() => {
    const all = lsGet<MyToken[]>(LS_MY_TOKENS, []);
    setMyTokens(address ? all.filter(t => t.deployer.toLowerCase() === address.toLowerCase()) : []);
  }, [address]);

  const copyAddr = (addr: string) => {
    navigator.clipboard.writeText(addr)
      .then(() => { setCopiedAddr(addr); setTimeout(() => setCopiedAddr(c => (c === addr ? null : c)), 1500); })
      .catch(() => {});
  };

  return (
    <SideCard title="Your Deployed Tokens">
      {!address ? (
        <div className="px-4 py-5 text-center space-y-3">
          <p className="font-mono text-xs text-slate-600">Connect wallet to see your tokens</p>
          <ConnectButton label="Connect Wallet" />
        </div>
      ) : myTokens.length === 0 ? (
        <div className="px-4 py-5 text-center">
          <p className="font-mono text-xs text-slate-600">No tokens deployed yet</p>
          <p className="font-mono text-[9px] text-slate-700 mt-1">Deploy a B20 above to see it here</p>
        </div>
      ) : (
        <div className="divide-y divide-[#0d0d18]">
          {myTokens.map(t => (
            <div key={t.address} className="flex items-center gap-3 px-4 py-3">
              <div className="w-7 h-7 rounded-lg flex items-center justify-center font-mono text-[10px] font-bold shrink-0"
                style={{ background: "#4FC3F715", border: "1px solid #4FC3F730", color: "#4FC3F7" }}>
                {(t.symbol || t.name).slice(0, 2).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-mono text-xs text-white truncate">
                  {t.name} <span className="text-slate-500">${t.symbol}</span>
                </p>
                <button onClick={() => copyAddr(t.address)} title={`Copy ${t.address}`}
                  className="font-mono text-[9px] text-slate-700 hover:text-[#4FC3F7] transition-colors max-w-full truncate block text-left">
                  {copiedAddr === t.address
                    ? "Copied full address ✓"
                    : `${t.address.slice(0, 14)}… · ${t.network === "mainnet" ? "Main" : "Sepolia"}`}
                </button>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button onClick={() => copyAddr(t.address)} title="Copy contract address"
                  className="text-slate-600 hover:text-[#4FC3F7] transition-colors p-0.5">
                  {copiedAddr === t.address ? (
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="#22C55E" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                    </svg>
                  ) : (
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
                      <path strokeLinecap="round" strokeLinejoin="round"
                        d="M15.666 3.888A2.25 2.25 0 0 0 13.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 0 1-.75.75H9a.75.75 0 0 1-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 0 1-2.25 2.25H6.75A2.25 2.25 0 0 1 4.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 0 1 1.927-.184" />
                    </svg>
                  )}
                </button>
                <a href={`https://${t.network === "mainnet" ? "" : "sepolia."}basescan.org/token/${t.address}`}
                  target="_blank" rel="noopener noreferrer" title="View on Basescan"
                  className="font-mono text-[9px] text-slate-600 hover:text-[#4FC3F7] transition-colors">
                  ↗
                </a>
              </div>
            </div>
          ))}
        </div>
      )}
    </SideCard>
  );
}

// ── Launch tab ────────────────────────────────────────────────────────────────

const LAUNCH_NETS = {
  sepolia: { chainId: 84532, label: "Sepolia",  explorer: "https://sepolia.basescan.org" },
  mainnet: { chainId: 8453,  label: "Mainnet",  explorer: "https://basescan.org"         },
} as const;

function LaunchTab({ onScanToken, network, setNetwork }: { onScanToken: (addr: string, net: Network) => void; network: Network; setNetwork: (n: Network) => void }) {
  const { t } = useLang();
  const [name,       setName]       = useState("");
  const [symbol,     setSymbol]     = useState("");
  const [variant,    setVariant]    = useState<"asset" | "stablecoin">("asset");
  const [decimals,   setDecimals]   = useState(18);
  const [decManual,  setDecManual]  = useState(false);
  const [supplyCap,  setSupplyCap]  = useState("");
  const [initSupply, setInitSupply] = useState("");
  const [currCode,   setCurrCode]   = useState("USD");

  const [deploying,     setDeploying]     = useState(false);
  const [polling,       setPolling]       = useState(false);
  const [deployErr,     setDeployErr]     = useState("");
  const [deployTxHash,  setDeployTxHash]  = useState("");
  const [deployedToken, setDeployedToken] = useState("");

  // B20HUB "Auto-pool + $BLUE flywheel" opt-in — when the checkbox is on, the
  // deploy() function routes through /api/b20hub/prepare which builds a
  // B20HUBLauncher.launch() tx. That deploys B20 + inits a Uniswap V4 pool +
  // locks the LP in our hook, all in one signature. The hook then routes
  // every swap fee 80% creator / 15% $BLUE buyback / 5% treasury forever.
  //
  // Until the launcher contract is deployed on-chain, the API returns 503
  // { notDeployed: true } and we surface a friendly "Coming soon" state
  // instead of silently 500'ing.
  const [autoPool,     setAutoPool]     = useState(false);
  const [hubFeeTier,   setHubFeeTier]   = useState<"MEDIUM" | "HIGH" | "3PCT">("MEDIUM");
  // hubMarketCap removed — opening price is now a protocol-level constant
  // in the launcher contract (OPENING_SQRT_PRICE_X96). Every launch opens
  // at the same tick, matching the pump.fun / o1.exchange pattern.

  // ActivationRegistry gate — read on-chain isActivated for this network so we can
  // block Deploy BEFORE the wallet hits a confusing "Unable to estimate fee"
  // (createB20 reverts FeatureNotActivated until the registry enables B20).
  // Re-runs on mount + every network switch → auto-detects mainnet going live.
  const [activation, setActivation] = useState<B20Activation | null>(null);
  useEffect(() => {
    let cancelled = false;
    setActivation(null);
    runB20Activation(network)
      .then(a => { if (!cancelled) setActivation(a); })
      .catch(() => { if (!cancelled) setActivation(null); });
    return () => { cancelled = true; };
  }, [network]);

  const { address, chainId: currentChainId } = useAccount();
  const { sendTransactionAsync }             = useSendTransaction();
  const { switchChainAsync }                 = useSwitchChain();

  // Save to localStorage on successful deploy
  useEffect(() => {
    if (deployedToken && address) {
      const entry: MyToken = {
        address:   deployedToken,
        name:      name.trim(),
        symbol:    symbol.replace(/^\$/, "").trim(),
        network:   network,
        deployer:  address.toLowerCase(),
        timestamp: Date.now(),
      };
      const prev = lsGet<MyToken[]>(LS_MY_TOKENS, []);
      lsSet(LS_MY_TOKENS, [entry, ...prev.filter(t => t.address !== deployedToken)].slice(0, 50));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deployedToken]);

  function switchVariant(v: "asset" | "stablecoin") {
    setVariant(v);
    if (!decManual) setDecimals(v === "stablecoin" ? 6 : 18);
  }

  const n      = name.trim();
  const s      = symbol.replace(/^\$/, "").trim();
  const cap    = supplyCap.trim();
  const seed   = initSupply.trim();
  const cur    = currCode.trim() || "USD";
  const net    = LAUNCH_NETS[network];
  // Local guard mirroring buildB20Calldata: seed-mint can't exceed the cap.
  const seedOverCap = !!cap && !!seed && Number(seed) > Number(cap);
  // Only block when the on-chain read succeeded (ok) AND the selected variant is
  // not yet activated. Unknown reads (ok:false) or still-loading → don't block.
  const notActivated = !!activation && activation.ok && !activation[variant];
  const canDeploy = !!n && !!s && !notActivated && !seedOverCap;

  async function deploy() {
    if (!address || !canDeploy) return;
    setDeploying(true); setDeployErr(""); setDeployTxHash(""); setDeployedToken("");
    try {
      // Auto-pool branch: single-tx deploy via B20HUBLauncher (B20 + V4 pool +
      // LP lock + fee-splitter hook). Returns 503 { notDeployed: true } until
      // the launcher contract is on-chain.
      if (autoPool) {
        if (network !== "mainnet") {
          throw new Error("Auto-pool flywheel is mainnet-only for now (Sepolia lacks BLUE/WETH pool)");
        }

        // Auto-pool + $BLUE flywheel is fixed-supply AND fixed-opening-price
        // by design (task #78 lock-in). Every launch = 100B tokens, same
        // OPENING_SQRT_PRICE_X96 constant baked into the launcher contract.
        // At $3000 ETH that's ~$4K opening market cap; the USD figure floats
        // with ETH price. No user-picked opening market cap → matches
        // pump.fun / o1.exchange pattern.
        const AUTO_POOL_SUPPLY_WHOLE = "100000000000"; // 100B
        const feeTierMap = { MEDIUM: 3000, HIGH: 10000, "3PCT": 30000 } as const;

        const hubRes = await fetch("/api/b20hub/prepare", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: n, symbol: s, variant, decimals,
            totalSupply: AUTO_POOL_SUPPLY_WHOLE,
            feeTier: feeTierMap[hubFeeTier],
            ...(variant === "stablecoin" ? { currencyCode: cur } : {}),
            creator: address,
            chain: "base",
          }),
        });
        const hubJson = await hubRes.json();
        if (!hubRes.ok) {
          if (hubJson?.notDeployed) {
            throw new Error("Auto-pool launcher not deployed yet — coming soon. Uncheck for a plain B20 launch.");
          }
          throw new Error(hubJson?.error || "B20HUB prepare failed");
        }

        if (currentChainId !== 8453) {
          try { await switchChainAsync({ chainId: 8453 }); }
          catch { throw new Error("Switch wallet to Base mainnet and try again"); }
        }
        const hubHash = await sendTransactionAsync({
          to:      hubJson.tx.to as `0x${string}`,
          data:    hubJson.tx.data as `0x${string}`,
          value:   0n,
          chainId: 8453,
        });
        setDeployTxHash(hubHash);
        setPolling(true);

        // Poll receipt via the same /api/b20/receipt route — it handles
        // both direct-createB20 and launcher-emitted B20 addresses.
        for (let i = 0; i < 20; i++) {
          await new Promise((r) => setTimeout(r, 3000));
          const rec = await fetch("/api/b20/receipt", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tx_hash: hubHash, network: "mainnet" }),
          }).then((r) => r.json());
          if (rec.ok && rec.status === "success" && rec.tokenAddress) {
            setDeployedToken(rec.tokenAddress);
            break;
          }
          if (rec.ok && rec.status === "reverted") throw new Error("Transaction reverted");
        }
        setPolling(false);
        return;
      }

      // Standard branch: direct createB20 call, no pool.
      const prepRes = await fetch("/api/b20/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: n, symbol: s, variant, decimals,
          supply_cap:     cap || undefined,
          initial_supply: seed || undefined,
          currency_code:  variant === "stablecoin" ? cur : undefined,
          admin: address,
          network: network,
        }),
      });
      const prep = await prepRes.json();
      if (!prep.ok) throw new Error(prep.error || "Prepare failed");
      if (!prep.berylLive) {
        throw new Error(
          network === "mainnet"
            ? "Mainnet Beryl activates June 25, 2026 18:00 UTC"
            : "B20 factory not active on this network yet",
        );
      }

      if (currentChainId !== net.chainId) {
        try { await switchChainAsync({ chainId: net.chainId }); }
        catch { throw new Error(`Switch wallet to Base ${net.label} and try again`); }
      }

      const hash = await sendTransactionAsync({
        to:      prep.tx.to as `0x${string}`,
        data:    prep.tx.data as `0x${string}`,
        value:   0n,
        chainId: net.chainId,
      });
      setDeployTxHash(hash);
      setPolling(true);

      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 3000));
        const rec = await fetch("/api/b20/receipt", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tx_hash: hash, network: network }),
        }).then(r => r.json());
        if (rec.ok && rec.status === "success" && rec.tokenAddress) {
          setDeployedToken(rec.tokenAddress);
          break;
        }
        if (rec.ok && rec.status === "reverted") throw new Error("Transaction reverted");
      }
      setPolling(false);
    } catch (e) {
      setDeployErr((e as Error).message);
    } finally {
      setDeploying(false);
      setPolling(false);
    }
  }

  return (
    <div>
      {/* Main deploy card */}
      <div className="rounded-2xl border border-[#1A1A2E] overflow-hidden mb-5">

        {/* Token preview header */}
        <div className="px-5 py-4 bg-[#0a0a0f] border-b border-[#1A1A2E] flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center font-mono text-sm font-bold shrink-0"
            style={{ background: "#4FC3F715", border: "1px solid #4FC3F730", color: "#4FC3F7" }}>
            {(s || n).slice(0, 2).toUpperCase() || "B2"}
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-mono text-sm font-bold text-white truncate">{n || "Token Name"}</p>
            <p className="font-mono text-xs text-slate-500">${s || "SYMBOL"} · {variant} · B20</p>
          </div>
          {/* Network toggle */}
          <div className="flex rounded-lg border border-[#1A1A2E] overflow-hidden shrink-0">
            {(["sepolia", "mainnet"] as const).map(nk => (
              <button key={nk} onClick={() => setNetwork(nk)}
                className="px-3 py-1.5 font-mono text-xs transition-colors"
                style={network === nk
                  ? { background: "#4FC3F715", color: "#4FC3F7" }
                  : { color: "#475569" }}>
                {LAUNCH_NETS[nk].label}
              </button>
            ))}
          </div>
        </div>

        {/* Form */}
        <div className="p-5 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="font-mono text-[9px] text-slate-600 tracking-widest uppercase block mb-1.5">
                {t("launch.token_name")} *
              </label>
              <input value={name} onChange={e => setName(e.target.value)}
                placeholder="My Token" spellCheck={false} className={INPUT_CLS} />
            </div>
            <div>
              <label className="font-mono text-[9px] text-slate-600 tracking-widest uppercase block mb-1.5">
                {t("launch.token_symbol")} *
              </label>
              <input value={symbol} onChange={e => setSymbol(e.target.value.toUpperCase())}
                placeholder="MTK" spellCheck={false} className={INPUT_CLS} />
            </div>
          </div>

          {/* Variant */}
          <div>
            <label className="font-mono text-[9px] text-slate-600 tracking-widest uppercase block mb-1.5">
              Variant
            </label>
            <div className="flex rounded-xl border border-[#1A1A2E] overflow-hidden">
              {(["asset", "stablecoin"] as const).map(v => (
                <button key={v} onClick={() => switchVariant(v)}
                  className="flex-1 py-2.5 font-mono text-xs transition-all capitalize"
                  style={variant === v
                    ? v === "asset"
                      ? { background: "#4FC3F715", color: "#4FC3F7", borderRight: "1px solid #1A1A2E" }
                      : { background: "#22C55E15", color: "#22C55E" }
                    : v === "asset"
                      ? { color: "#475569", borderRight: "1px solid #1A1A2E" }
                      : { color: "#475569" }}>
                  {v}
                </button>
              ))}
            </div>
          </div>

          <div className={autoPool ? "" : "grid grid-cols-2 gap-3"}>
            <div>
              <label className="font-mono text-[9px] text-slate-600 tracking-widest uppercase block mb-1.5">
                {t("launch.decimals")} <span className="text-slate-700 font-normal normal-case">(6–18)</span>
              </label>
              <input type="number" min={6} max={18} value={decimals}
                disabled={variant === "stablecoin"}
                onChange={e => { setDecManual(true); setDecimals(Number(e.target.value)); }}
                className="w-full bg-[#0a0a12] border border-[#1A1A2E] focus:border-[#4FC3F740] rounded-xl px-3 py-2.5 font-mono text-sm text-slate-200 outline-none transition-colors disabled:opacity-40 disabled:cursor-not-allowed" />
            </div>
            {/* Auto-pool locks supply at 100B (task #78 spec) so hide the
                Supply Cap + Initial Supply fields — they'd silently override
                the launcher's fixed-supply flow and starve the pool of
                liquidity. */}
            {!autoPool && (
              <div>
                <label className="font-mono text-[9px] text-slate-600 tracking-widest uppercase block mb-1.5">
                  Supply Cap <span className="text-slate-700 font-normal normal-case">(optional)</span>
                </label>
                <input value={supplyCap} onChange={e => setSupplyCap(e.target.value)}
                  placeholder="e.g. 1000000" spellCheck={false} className={INPUT_CLS} />
              </div>
            )}
          </div>

          {/* Initial Supply — optional seed-mint to admin, minted atomically in the
              same createB20 tx (deploy + grant MINT_ROLE + set cap + seed = 1 tx). */}
          {!autoPool && (
            <div>
              <label className="font-mono text-[9px] text-slate-600 tracking-widest uppercase block mb-1.5">
                Initial Supply <span className="text-slate-700 font-normal normal-case">(optional · minted to you at deploy)</span>
              </label>
              <input value={initSupply} onChange={e => setInitSupply(e.target.value)}
                placeholder="e.g. 1000000" spellCheck={false} className={INPUT_CLS} />
              {seedOverCap && (
                <p className="font-mono text-[9px] text-[#EF4444] mt-1.5">
                  Initial supply can&apos;t exceed the supply cap.
                </p>
              )}
            </div>
          )}

          {variant === "stablecoin" && (
            <div>
              <label className="font-mono text-[9px] text-slate-600 tracking-widest uppercase block mb-1.5">
                Currency Code
              </label>
              <input value={currCode} onChange={e => setCurrCode(e.target.value.toUpperCase())}
                placeholder="USD" spellCheck={false}
                className="w-full bg-[#0a0a12] border border-[#1A1A2E] focus:border-[#22C55E40] rounded-xl px-3 py-2.5 font-mono text-sm text-slate-200 placeholder:text-slate-700 outline-none transition-colors" />
            </div>
          )}

          {/* B20HUB Auto-pool + $BLUE flywheel opt-in */}
          <div className="rounded-xl border border-[#4FC3F7]/20 bg-[#4FC3F7]/[0.03] p-4 space-y-3">
            <label className="flex items-start gap-3 cursor-pointer">
              <input type="checkbox" checked={autoPool}
                onChange={e => setAutoPool(e.target.checked)}
                disabled={network !== "mainnet"}
                className="mt-0.5 w-4 h-4 accent-[#4FC3F7] cursor-pointer disabled:cursor-not-allowed" />
              <div className="flex-1">
                <p className="font-mono text-xs text-slate-200 font-bold">
                  🔷 Auto-pool + $BLUE buyback flywheel
                </p>
                <p className="font-mono text-[10px] text-slate-500 mt-1 leading-relaxed">
                  Deploy + init Uniswap V4 pool + lock LP in one signature.
                  Fixed <span className="text-slate-300">100B</span> supply,
                  all seeded into the pool. Every swap routes{" "}
                  <span className="text-[#34D399]">80%</span> to you (creator),{" "}
                  <span className="text-[#4FC3F7]">15%</span> to $BLUE buyback,{" "}
                  <span className="text-slate-400">5%</span> to treasury — forever.
                  Admin renounced, LP permanent.
                </p>
                {network !== "mainnet" && (
                  <p className="font-mono text-[9px] text-amber-400/70 mt-1.5">
                    Mainnet-only (Sepolia lacks BLUE/WETH pool).
                  </p>
                )}
              </div>
            </label>

            {autoPool && (
              <div className="space-y-3 pt-2 border-t border-[#4FC3F7]/10">
                <div>
                  <label className="font-mono text-[9px] text-slate-600 tracking-widest uppercase block mb-1.5">
                    Swap Fee Tier
                  </label>
                  <div className="flex rounded-xl border border-[#1A1A2E] overflow-hidden">
                    {(["MEDIUM", "HIGH", "3PCT"] as const).map((tier, i) => (
                      <button key={tier} onClick={() => setHubFeeTier(tier)}
                        className="flex-1 py-2 font-mono text-[10px] transition-all"
                        style={hubFeeTier === tier
                          ? { background: "#4FC3F715", color: "#4FC3F7", borderRight: i < 2 ? "1px solid #1A1A2E" : undefined }
                          : { color: "#475569", borderRight: i < 2 ? "1px solid #1A1A2E" : undefined }}>
                        {tier === "MEDIUM" ? "0.3%" : tier === "HIGH" ? "1%" : "3%"}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="font-mono text-[9px] text-slate-600 tracking-widest uppercase block mb-1.5">
                    Opening Market Cap
                  </label>
                  <div className="rounded-xl border border-[#1A1A2E] bg-[#0a0a12] px-3 py-2.5 flex items-center justify-between">
                    <span className="font-mono text-sm text-slate-200">~$4K</span>
                    <span className="font-mono text-[9px] text-slate-600">protocol-level constant</span>
                  </div>
                  <p className="font-mono text-[9px] text-slate-600 mt-1">
                    Every B20HUB launch opens at the same tick (pump.fun style).
                    USD figure floats with ETH price.
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Deploy section */}
        <div className="px-5 pb-5">
          {!deployedToken ? (
            <>
              {!address ? (
                <ConnectButton label="Connect Wallet to Deploy" />
              ) : (
                <button onClick={deploy}
                  disabled={!canDeploy || deploying}
                  className="w-full font-mono text-sm font-bold py-3 rounded-xl transition-all disabled:opacity-40"
                  style={{ background: "#34D399", color: "#050508" }}>
                  {deploying
                    ? (polling ? "Confirming on-chain…" : "Preparing transaction…")
                    : notActivated
                      ? `B20 not active on ${net.label} yet`
                      : autoPool
                        ? `Launch B20 + auto-pool + LP lock →`
                        : `Deploy B20 on ${net.label} →`}
                </button>
              )}

              {/* ActivationRegistry gate — block + explain before the wallet sees a
                  FeatureNotActivated revert as a confusing "Unable to estimate fee". */}
              {notActivated && (
                <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 mt-3">
                  <p className="font-mono text-xs text-amber-400/90 leading-relaxed">
                    B20 isn&apos;t active on {net.label} yet. The Activation Registry
                    hasn&apos;t been enabled (can take ~1h after the Beryl hardfork).
                    {network === "mainnet" && (
                      <>
                        {" "}
                        <button onClick={() => setNetwork("sepolia")}
                          className="text-[#4FC3F7] hover:opacity-80 underline">
                          Use Base Sepolia
                        </button>
                        {" "}to deploy and test now.
                      </>
                    )}
                  </p>
                </div>
              )}

              {network === "sepolia" && !notActivated && (
                <p className="font-mono text-[9px] text-slate-600 mt-2 text-center">
                  Sepolia testnet · free to test.{" "}
                  <a href="https://portal.cdp.coinbase.com/products/faucet"
                    target="_blank" rel="noopener noreferrer"
                    className="text-[#4FC3F7] hover:opacity-80">Get test ETH →</a>
                </p>
              )}
              {network === "mainnet" && !notActivated && (
                <p className="font-mono text-[9px] text-amber-400/70 mt-2 text-center">
                  Beryl is live on Mainnet. Real ETH required for gas.
                </p>
              )}

              {deployErr && (
                <div className="rounded-xl border border-[#EF444430] px-4 py-2.5 mt-3">
                  <p className="font-mono text-xs text-[#EF4444]">{deployErr}</p>
                </div>
              )}
              {deployTxHash && !deployedToken && (
                <p className="font-mono text-[9px] text-slate-600 mt-2 text-center break-all">
                  tx: {deployTxHash.slice(0, 16)}…{deployTxHash.slice(-8)}
                </p>
              )}
            </>
          ) : (
            <div className="rounded-2xl border border-[#34D399]/30 bg-[#34D399]/5 p-4">
              <p className="font-mono text-sm text-[#34D399] font-bold mb-1">✓ B20 Deployed</p>
              <p className="font-mono text-xs text-white break-all mb-3">{deployedToken}</p>
              <div className="flex gap-2 flex-wrap">
                <button
                  onClick={() => onScanToken(deployedToken, network as Network)}
                  className="font-mono text-xs px-3 py-1.5 rounded-xl transition-all"
                  style={{ background: "#4FC3F715", color: "#4FC3F7", border: "1px solid #4FC3F730" }}>
                  Scan in Scanner →
                </button>
                <a href={`${net.explorer}/token/${deployedToken}`}
                  target="_blank" rel="noopener noreferrer"
                  className="font-mono text-xs px-3 py-1.5 rounded-xl border border-[#1A1A2E] text-slate-400 hover:text-white transition-colors">
                  Basescan ↗
                </a>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* After deployment guide */}
      <div className="rounded-2xl border border-[#1A1A2E] overflow-hidden">
        <div className="px-4 py-3 bg-[#0a0a0f] border-b border-[#1A1A2E]">
          <p className="font-mono text-[9px] text-slate-600 tracking-widest uppercase">After Deployment</p>
        </div>
        <div className="divide-y divide-[#0d0d18]">
          {[
            { n: "1", title: "Assign roles",      desc: "Grant MINT_ROLE, PAUSE_ROLE, BURN_ROLE, etc. via grantRole(role, address) from DEFAULT_ADMIN_ROLE." },
            { n: "2", title: "Set supply cap",    desc: "Call updateSupplyCap(amount) to enforce a hard ceiling. Omit (or set uint128.max) for uncapped." },
            { n: "3", title: "Configure policy",  desc: "Create an ALLOWLIST or BLOCKLIST on PolicyRegistry, then apply with token.updatePolicy(scope, policyId)." },
            { n: "4", title: "Verify in Scanner", desc: "Paste your token address into the Scanner tab to confirm all on-chain config is correct before going live." },
          ].map(({ n: step, title, desc }) => (
            <div key={step} className="flex items-start gap-4 px-5 py-4">
              <span className="font-mono text-sm text-slate-600 w-5 shrink-0 pt-0.5">{step}.</span>
              <div>
                <p className="font-mono text-sm text-slate-300 font-medium mb-0.5">{title}</p>
                <p className="font-mono text-xs text-slate-600 leading-relaxed">{desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

interface B20ClientProps {
  initialAddress?: string;
  initialNetwork?: "mainnet" | "sepolia";
}

export default function B20Client({ initialAddress = "", initialNetwork = "mainnet" }: B20ClientProps) {
  const router = useRouter();
  const { t } = useLang();

  // ── Shared ────────────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<Tab>("scanner");
  const [network,   setNetwork]   = useState<Network>(initialNetwork);
  const { setContextual } = useAppChrome();
  // Connected wallet — fed to the scanner so it can run the per-wallet admin check.
  const { address: scanWallet } = useAccount();

  // Beryl badge (client-only to avoid hydration mismatch)
  const [berylLabel, setBerylLabel] = useState<{ active: boolean; text: string } | null>(null);
  useEffect(() => {
    const BERYL_TS = new Date("2026-06-25T18:00:00Z").getTime();
    const now = Date.now();
    if (network === "sepolia") {
      setBerylLabel({ active: true, text: "Active on Sepolia" });
    } else if (now >= BERYL_TS) {
      setBerylLabel({ active: true, text: "Beryl live on Mainnet" });
    } else {
      const diff  = BERYL_TS - now;
      const hours = Math.floor(diff / 3_600_000);
      const mins  = Math.floor((diff % 3_600_000) / 60_000);
      setBerylLabel({ active: false, text: `Mainnet in ${hours}h ${mins}m` });
    }
  }, [network]);

  // Register mobile contextual nav
  useEffect(() => {
    setContextual({
      barTitle:   "B20 Hub",
      groupTitle: "B20 Hub",
      items: [
        ...TABS.map(tab => ({
          id:       tab.id,
          label:    tab.label,
          icon:     TabIcons[tab.id],
          active:   activeTab === tab.id,
          onSelect: () => setActiveTab(tab.id),
        })),
        {
          id:       "docs",
          label:    "Docs",
          icon:     DocsIcon,
          active:   false,
          onSelect: () => router.push("/docs/beryl"),
        },
      ],
    });
    return () => setContextual(null);
  }, [activeTab, setContextual, router]);

  // ── Scanner ───────────────────────────────────────────────────────────────
  const [scanAddr,    setScanAddr]    = useState(initialAddress);
  const [scanResult,  setScanResult]  = useState<B20Inspection | null>(null);
  const [scanError,   setScanError]   = useState("");
  const [scanPending, startScan]      = useTransition();
  const [recentScans, setRecentScans] = useState<RecentScan[]>([]);

  // Load recent scans from localStorage on mount
  useEffect(() => { setRecentScans(lsGet<RecentScan[]>(LS_RECENT, [])); }, []);

  const addrClean = scanAddr.trim();
  const addrValid = isValidAddr(addrClean);

  const doScan = useCallback((overrideAddr?: string) => {
    const clean = (overrideAddr ?? addrClean).trim();
    if (!isValidAddr(clean)) return;
    setScanError(""); setScanResult(null);
    startScan(async () => {
      try {
        const result = await runB20Inspect(clean, network, scanWallet);
        // Auto-detect: if not found on this network, try the other
        if (!result.isB20) {
          const other: Network = network === "mainnet" ? "sepolia" : "mainnet";
          try {
            const alt = await runB20Inspect(clean, other, scanWallet);
            if (alt.isB20) {
              setNetwork(other);
              setScanResult(alt);
              if (alt.name) {
                setRecentScans(p => {
                  const next = [{ address: clean, name: alt.name!, symbol: alt.symbol ?? "", network: other, timestamp: Date.now() }, ...p.filter(r => r.address !== clean)].slice(0, 10);
                  lsSet(LS_RECENT, next);
                  return next;
                });
              }
              window.history.replaceState({}, "", `/b20?${new URLSearchParams({ address: clean, network: other })}`);
              return;
            }
          } catch { /* ignore */ }
        }
        setScanResult(result);
        if (result.isB20 && result.name) {
          setRecentScans(p => {
            const next = [{ address: clean, name: result.name!, symbol: result.symbol ?? "", network, timestamp: Date.now() }, ...p.filter(r => r.address !== clean)].slice(0, 10);
            lsSet(LS_RECENT, next);
            return next;
          });
        }
        window.history.replaceState({}, "", `/b20?${new URLSearchParams({ address: clean, network })}`);
      } catch (e) {
        setScanError((e as Error).message ?? "Inspection failed.");
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addrClean, addrValid, network, scanWallet]);

  // Auto-trigger on mount (share link)
  useEffect(() => {
    if (initialAddress && isValidAddr(initialAddress)) doScan(initialAddress);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Roles ─────────────────────────────────────────────────────────────────
  const [roleToken,    setRoleToken]   = useState("");
  const [roleWallet,   setRoleWallet]  = useState("");
  const [rolesResult,  setRolesResult] = useState<B20RolesResult | null>(null);
  const [rolesError,   setRolesError]  = useState("");
  const [rolesPending, startRoles]     = useTransition();

  function doRoles() {
    if (!isValidAddr(roleToken) || !isValidAddr(roleWallet)) return;
    setRolesError(""); setRolesResult(null);
    startRoles(async () => {
      try { setRolesResult(await runB20Roles(roleToken.trim(), roleWallet.trim(), network)); }
      catch (e) { setRolesError((e as Error).message ?? "Role check failed."); }
    });
  }

  // ── Registry ──────────────────────────────────────────────────────────────
  const [registryResult, setRegistryResult] = useState<B20RegistryResult | null>(null);
  const [registryError,  setRegistryError]  = useState("");
  const [regPending,     startReg]          = useTransition();
  const regLoadedFor = useRef<Network | null>(null);

  // Filter / search / sort state
  const [regFilter, setRegFilter] = useState<"all" | "asset" | "stablecoin">("all");
  const [regSearch, setRegSearch] = useState("");
  const [regSort,   setRegSort]   = useState<"newest" | "oldest">("newest");

  // Computed stats (no extra RPC)
  const regStats = registryResult ? (() => {
    const entries      = registryResult.entries;
    // Use full-history counts from registry (accurate even when total > 100 entries shown)
    const assetCount   = registryResult.assetCount  ?? entries.filter(e => e.variant === 0).length;
    const stableCount  = registryResult.stablecoinCount ?? entries.filter(e => e.variant === 1).length;
    const latestBlock  = Number(registryResult.toBlock);
    const recentCount  = entries.filter(e => Number(e.blockNumber) > latestBlock - 172_800).length;
    return { assetCount, stableCount, recentCount, total: registryResult.total };
  })() : null;

  // Computed filtered+sorted entries (client-side, no RPC)
  const filteredEntries = (registryResult?.entries ?? [])
    .filter(e => {
      if (regFilter === "asset"      && e.variant !== 0) return false;
      if (regFilter === "stablecoin" && e.variant !== 1) return false;
      if (regSearch) {
        const q = regSearch.toLowerCase();
        return e.name.toLowerCase().includes(q) || e.symbol.toLowerCase().includes(q);
      }
      return true;
    })
    .sort((a, b) => {
      const diff = Number(b.blockNumber) - Number(a.blockNumber);
      return regSort === "newest" ? diff : -diff;
    });

  const doRegistry = useCallback(() => {
    setRegistryError("");
    startReg(async () => {
      try {
        const r = await runB20Registry(network);
        setRegistryResult(r);
        regLoadedFor.current = network;
      } catch (e) { setRegistryError((e as Error).message ?? "Registry load failed."); }
    });
  }, [network]);

  useEffect(() => {
    if (activeTab === "registry" && regLoadedFor.current !== network) doRegistry();
  }, [activeTab, network, doRegistry]);

  // ── Recent Activity (control events) — loads alongside the registry ─────────
  const [activityResult, setActivityResult] = useState<B20ActivityResult | null>(null);
  const [activityPending, startActivity]    = useTransition();
  const activityLoadedFor = useRef<Network | null>(null);

  const doActivity = useCallback(() => {
    startActivity(async () => {
      try {
        const r = await runB20Activity(network);
        setActivityResult(r);
        activityLoadedFor.current = network;
      } catch {
        // Honest fallback — section shows "activity unavailable".
        setActivityResult({ network, events: [], total: 0, unavailable: true });
        activityLoadedFor.current = network;
      }
    });
  }, [network]);

  useEffect(() => {
    if (activeTab === "registry" && activityLoadedFor.current !== network) doActivity();
  }, [activeTab, network, doActivity]);

  // Network change → reset all tab results
  useEffect(() => {
    regLoadedFor.current = null;
    activityLoadedFor.current = null;
    setRegistryResult(null); setRegistryError("");
    setActivityResult(null);
    setScanResult(null);     setScanError("");
    setRolesResult(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [network]);

  // Registry row → fill Scanner + auto-inspect
  function handleRegistrySelect(addr: string) {
    setScanAddr(addr);
    setActiveTab("scanner");
    setScanError(""); setScanResult(null);
    startScan(async () => {
      try {
        const result = await runB20Inspect(addr.trim(), network);
        setScanResult(result);
        if (result.isB20 && result.name) {
          setRecentScans(p => {
            const next = [{ address: addr.trim(), name: result.name!, symbol: result.symbol ?? "", network, timestamp: Date.now() }, ...p.filter(r => r.address !== addr.trim())].slice(0, 10);
            lsSet(LS_RECENT, next);
            return next;
          });
        }
        window.history.replaceState({}, "", `/b20?${new URLSearchParams({ address: addr.trim(), network })}`);
      } catch (e) { setScanError((e as Error).message ?? "Inspection failed."); }
    });
  }

  // Cross-tab: scan a just-deployed token
  function handleScanDeployed(addr: string, net: Network) {
    setScanAddr(addr);
    setNetwork(net);
    setActiveTab("scanner");
    setScanError(""); setScanResult(null);
    startScan(async () => {
      try {
        const result = await runB20Inspect(addr.trim(), net);
        setScanResult(result);
        if (result.isB20 && result.name) {
          setRecentScans(p => {
            const next = [{ address: addr.trim(), name: result.name!, symbol: result.symbol ?? "", network: net, timestamp: Date.now() }, ...p.filter(r => r.address !== addr.trim())].slice(0, 10);
            lsSet(LS_RECENT, next);
            return next;
          });
        }
        window.history.replaceState({}, "", `/b20?${new URLSearchParams({ address: addr.trim(), network: net })}`);
      } catch (e) { setScanError((e as Error).message ?? "Inspection failed."); }
    });
  }

  // ── Manage tab state ──────────────────────────────────────────────────────
  const [manageToken,  setManageToken]  = useState("");
  const [manageData,   setManageData]   = useState<ManageData | null>(null);
  const [manageError,  setManageError]  = useState("");
  const [managePending, startManage]    = useTransition();

  // Connected wallet roles for scanner read-only CTA (auto-fetched after scan)
  const [scanWalletRoles, setScanWalletRoles] = useState<B20RolesResult | null>(null);

  const { address: connectedAddress } = useAccount();

  // Auto-fetch roles after successful scan (drives the "Manage this token →" CTA)
  useEffect(() => {
    if (!scanResult?.isB20 || !connectedAddress) {
      setScanWalletRoles(null);
      return;
    }
    let cancelled = false;
    runB20Roles(scanResult.address, connectedAddress, scanResult.network as Network)
      .then(r => { if (!cancelled) setScanWalletRoles(r); })
      .catch(() => { if (!cancelled) setScanWalletRoles(null); });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanResult?.address, connectedAddress, scanResult?.network]);

  // Admin-renounce check after a successful scan — confirms (via the on-chain
  // LastAdminRenounced event) whether DEFAULT_ADMIN was permanently removed.
  // Non-blocking & fail-safe: any failure leaves renounce=null so the Scanner
  // shows no badge and keeps its conservative "admin unknown" wording.
  const [scanRenounce, setScanRenounce] = useState<B20AdminRenounceResult | null>(null);

  useEffect(() => {
    if (!scanResult?.isB20) { setScanRenounce(null); return; }
    let cancelled = false;
    setScanRenounce(null);
    runB20AdminRenounced(scanResult.address, scanResult.network as Network)
      .then(r => { if (!cancelled) setScanRenounce(r); })
      .catch(() => { if (!cancelled) setScanRenounce(null); });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanResult?.address, scanResult?.network]);

  // Reset manage data on network change
  useEffect(() => {
    setScanWalletRoles(null);
    setManageData(null);
    setManageError("");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [network]);

  function doManageLoad(tokenAddr?: string, isRefresh = false) {
    const addr = (tokenAddr ?? manageToken).trim();
    if (!isValidAddr(addr) || !connectedAddress) return;
    setManageError("");
    if (!isRefresh) setManageData(null); // keep panel mounted during refresh so toast persists
    startManage(async () => {
      try {
        const d = await runB20ManageLoad(addr, connectedAddress, network);
        setManageData(d);
        if (tokenAddr) setManageToken(tokenAddr);
      } catch (e) { setManageError((e as Error).message ?? "Load failed."); }
    });
  }

  // Pre-fill manage token from scanner and jump to manage tab
  function goToManage(addr: string) {
    setManageToken(addr);
    setActiveTab("manage");
    doManageLoad(addr);
  }

  // ── Tab header labels ─────────────────────────────────────────────────────
  const TAB_LABELS: Record<Tab, string> = {
    scanner:  "Token Scanner",
    roles:    "Role Checker",
    registry: "Registry",
    launch:   "Launch B20",
    manage:   "Manage",
    watchlist: "Watchlist",
    methodology: "Methodology",
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex bg-[#050508] font-mono h-full overflow-hidden">

      {/* ══════════════════════════════════════════════════════════════════
          SUB-SIDEBAR (lg+)
      ══════════════════════════════════════════════════════════════════ */}
      <aside className="hidden lg:flex flex-col w-64 shrink-0 h-full border-r border-[#1A1A2E] bg-[#050508]">

        {/* Header */}
        <div className="px-5 h-14 flex items-center justify-between border-b border-[#1A1A2E] shrink-0">
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-[#4FC3F7] shrink-0"
              style={{ boxShadow: "0 0 5px #4FC3F780" }} />
            <p className="font-mono text-xs text-[#4FC3F7] tracking-widest">// B20 HUB</p>
          </div>
          {/* Network toggle */}
          <div className="flex rounded-lg border border-[#1A1A2E] overflow-hidden">
            {(["mainnet", "sepolia"] as const).map(n => (
              <button key={n} onClick={() => setNetwork(n)}
                className="px-2.5 py-1 font-mono text-[8px] transition-colors"
                style={network === n ? { background: "#4FC3F715", color: "#4FC3F7" } : { color: "#334155" }}>
                {n === "mainnet" ? "Main" : "Sepolia"}
              </button>
            ))}
          </div>
        </div>

        {/* Nav */}
        <nav className="px-2 pt-2 pb-1 shrink-0 space-y-0.5">
          {TABS.map(tab => {
            const isActive = activeTab === tab.id;
            return (
              <button key={tab.id} onClick={() => setActiveTab(tab.id)}
                className="w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-colors relative"
                style={isActive ? { background: "#4FC3F712" } : undefined}
                onMouseEnter={e => { if (!isActive) (e.currentTarget as HTMLElement).style.background = "#ffffff08"; }}
                onMouseLeave={e => { if (!isActive) (e.currentTarget as HTMLElement).style.background = "transparent"; }}>
                {isActive && (
                  <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 rounded-r-full bg-[#4FC3F7]"
                    style={{ boxShadow: "0 0 6px #4FC3F780" }} />
                )}
                <span className="shrink-0" style={{ color: isActive ? "#4FC3F7" : "#64748b" }}>
                  {TabIcons[tab.id]}
                </span>
                <span className="font-mono text-[13px] flex-1 text-left"
                  style={{ color: isActive ? "#4FC3F7" : "#cbd5e1" }}>
                  {tab.label}
                </span>
                {tab.id === "registry" && registryResult && (
                  <span className="font-mono text-[8px] text-slate-600">{registryResult.total}</span>
                )}
                {tab.id === "registry" && regPending && (
                  <span className="w-1 h-1 rounded-full bg-[#4FC3F7] animate-pulse shrink-0" />
                )}
              </button>
            );
          })}

          {/* Docs */}
          <a href="/docs/beryl"
            className="w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-colors"
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "#ffffff08"; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}>
            <span className="shrink-0 text-[#64748b]">{DocsIcon}</span>
            <span className="font-mono text-[13px] flex-1 text-left text-[#cbd5e1]">Docs</span>
            <span className="font-mono text-[8px] text-slate-600">↗</span>
          </a>
        </nav>

        {/* Beryl status */}
        {berylLabel && (
          <div className="px-5 py-2 border-t border-[#1A1A2E] shrink-0">
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full shrink-0"
                style={{ background: berylLabel.active ? "#22C55E" : "#F59E0B",
                         boxShadow:  berylLabel.active ? "0 0 4px #22C55E80" : "0 0 4px #F59E0B80" }} />
              <span className="font-mono text-[9px]"
                style={{ color: berylLabel.active ? "#22C55E" : "#F59E0B" }}>
                {berylLabel.text}
              </span>
            </div>
          </div>
        )}

        {/* Recents */}
        {recentScans.length > 0 && (
          <div className="flex-1 overflow-hidden flex flex-col min-h-0 border-t border-[#1A1A2E] mt-1">
            <div className="px-5 pt-3 pb-1 shrink-0">
              <p className="font-mono text-[9px] text-slate-600 tracking-widest uppercase">Recents</p>
            </div>
            <div className="flex-1 overflow-y-auto pb-2">
              {recentScans.map(r => {
                const isActive = scanResult?.address?.toLowerCase() === r.address.toLowerCase() && activeTab === "scanner";
                return (
                  <button key={r.address}
                    onClick={() => { setScanAddr(r.address); setActiveTab("scanner"); doScan(r.address); }}
                    className={`w-full text-left flex items-center gap-2 px-5 py-2 transition-all ${isActive ? "bg-[#4FC3F7]/8" : "hover:bg-[#ffffff05]"}`}>
                    <span className="w-1.5 h-1.5 rounded-full shrink-0"
                      style={{ background: isActive ? "#4FC3F7" : "#334155" }} />
                    <div className="flex-1 min-w-0">
                      <p className={`font-mono text-[12px] truncate ${isActive ? "text-white" : "text-slate-400"}`}>
                        {r.name}{r.symbol ? ` $${r.symbol}` : ""}
                      </p>
                      <p className="font-mono text-[8px] text-slate-700 truncate">{r.address.slice(0, 10)}…</p>
                    </div>
                    <span className="font-mono text-[8px] text-slate-700 shrink-0">
                      {r.network === "mainnet" ? "M" : "S"}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {recentScans.length === 0 && <div className="flex-1" />}
      </aside>

      {/* ══════════════════════════════════════════════════════════════════
          MAIN CONTENT
      ══════════════════════════════════════════════════════════════════ */}
      <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">

        {/* Mobile tab bar (lg:hidden) */}
        <div className="lg:hidden flex items-center gap-1 px-3 py-2 border-b border-[#1A1A2E] overflow-x-auto shrink-0">
          {TABS.map(tab => (
            <button key={tab.id} onClick={() => setActiveTab(tab.id)}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg font-mono text-[10px] shrink-0 transition-colors"
              style={activeTab === tab.id
                ? { background: "#4FC3F715", color: "#4FC3F7", border: "1px solid #4FC3F730" }
                : { color: "#475569", border: "1px solid transparent" }}>
              <span style={{ color: activeTab === tab.id ? "#4FC3F7" : "#64748b" }}>{TabIcons[tab.id]}</span>
              {tab.label}
            </button>
          ))}
          <a href="/docs/beryl"
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg font-mono text-[10px] shrink-0"
            style={{ color: "#475569", border: "1px solid transparent" }}>
            <span className="text-[#64748b]">{DocsIcon}</span>
            Docs ↗
          </a>
          <div className="ml-auto flex rounded-lg border border-[#1A1A2E] overflow-hidden shrink-0">
            {(["mainnet", "sepolia"] as const).map(n => (
              <button key={n} onClick={() => setNetwork(n)}
                className="px-2 py-1 font-mono text-[8px] transition-colors"
                style={network === n ? { background: "#4FC3F715", color: "#4FC3F7" } : { color: "#334155" }}>
                {n === "mainnet" ? "M" : "S"}
              </button>
            ))}
          </div>
        </div>

        {/* Scrollable area */}
        <div className="flex-1 overflow-y-auto">

          {/* ── Full-width stats header ─────────────────────────────── */}
          <div className="px-6 py-3 border-b border-[#1A1A2E] flex items-center gap-3 flex-wrap">
            <span className="font-mono text-xs font-semibold text-white">{TAB_LABELS[activeTab]}</span>
            <span className="w-px h-3 bg-[#1A1A2E] shrink-0" />

            {activeTab === "scanner" && (
              <>
                <InfoChip>Multicall</InfoChip>
                <InfoChip>Zero LLM</InfoChip>
                <InfoChip>Auto-detect</InfoChip>
              </>
            )}

            {activeTab === "roles" && (
              <span className="font-mono text-[9px] text-slate-600">7 roles · multicall in 2 rounds</span>
            )}

            {activeTab === "registry" && (
              <>
                {registryResult ? (
                  <>
                    <span className="font-mono text-[9px] text-slate-500">{registryResult.total} tokens</span>
                    {regStats && (
                      <>
                        <span className="font-mono text-[9px]" style={{ color: "#4FC3F7" }}>{regStats.assetCount} ASSET</span>
                        <span className="font-mono text-[9px]" style={{ color: "#22C55E" }}>{regStats.stableCount} STABLECOIN</span>
                      </>
                    )}
                  </>
                ) : (
                  <span className="font-mono text-[9px] text-slate-600">B20Factory event log</span>
                )}
                <button onClick={doRegistry} disabled={regPending}
                  className="font-mono text-[9px] text-slate-600 hover:text-slate-400 transition-colors">
                  {regPending ? "Loading…" : "↻ Refresh"}
                </button>
              </>
            )}

            {activeTab === "launch" && (
              <span className="font-mono text-[9px] text-slate-600">connect wallet → sign tx → token live on Base</span>
            )}

            {activeTab === "manage" && (
              <>
                <InfoChip>Client-side encode</InfoChip>
                <InfoChip>Role-gated</InfoChip>
                <InfoChip>wagmi sign</InfoChip>
              </>
            )}

            {activeTab === "watchlist" && (
              <>
                <InfoChip>Per-wallet</InfoChip>
                <InfoChip>View-time diff</InfoChip>
                <InfoChip>No cron</InfoChip>
              </>
            )}

            {activeTab === "methodology" && (
              <>
                <InfoChip>Live Base RPC</InfoChip>
                <InfoChip>Multicall</InfoChip>
                <InfoChip>Deterministic</InfoChip>
              </>
            )}

            {/* Beryl badge on right */}
            {berylLabel && (
              <div className="ml-auto flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full shrink-0"
                  style={{ background: berylLabel.active ? "#22C55E" : "#F59E0B",
                           boxShadow:  berylLabel.active ? "0 0 4px #22C55E80" : "0 0 4px #F59E0B80" }} />
                <span className="font-mono text-[9px]"
                  style={{ color: berylLabel.active ? "#22C55E" : "#F59E0B" }}>
                  {berylLabel.text}
                </span>
              </div>
            )}
          </div>

          {/* ── 2-column body ───────────────────────────────────────── */}
          <div className="flex flex-col lg:flex-row">

            {/* MAIN ~62% */}
            <div className="w-full lg:w-[62%] px-6 py-6 border-b border-[#1A1A2E] lg:border-b-0 lg:border-r">

              {/* ── SCANNER MAIN ──────────────────────────────────── */}
              {activeTab === "scanner" && (
                <div>
                  {/* Input */}
                  <div className="flex gap-2 mb-2">
                    <input value={scanAddr}
                      onChange={e => setScanAddr(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter" && addrValid && !scanPending) doScan(); }}
                      placeholder={t("scanner.placeholder")}
                      spellCheck={false}
                      className={`flex-1 min-w-0 ${INPUT_CLS}`}
                    />
                    <button onClick={() => doScan()} disabled={!addrValid || scanPending}
                      className="px-5 py-2.5 rounded-xl font-mono text-xs font-semibold transition-all shrink-0"
                      style={addrValid && !scanPending
                        ? { background: "#4FC3F720", color: "#4FC3F7", border: "1px solid #4FC3F740" }
                        : { background: "#0d0d18", color: "#334155", border: "1px solid #1A1A2E", cursor: "not-allowed" }}>
                      {scanPending ? "Reading…" : t("scanner.inspect_btn")}
                    </button>
                  </div>

                  {scanAddr && !addrValid && (
                    <p className="font-mono text-xs text-[#EF4444] mb-2 ml-1">
                      Must be 0x followed by 40 hex characters.
                    </p>
                  )}

                  {/* Refresh when result */}
                  {scanResult && !scanPending && (
                    <div className="mb-2">
                      <button onClick={() => doScan()} disabled={!addrValid}
                        className="font-mono text-xs px-3 py-1 rounded-lg border border-[#1A1A2E] text-slate-500 hover:text-slate-300 transition-colors">
                        Refresh
                      </button>
                    </div>
                  )}

                  {/* Loading */}
                  {scanPending && (
                    <div className="mt-4 flex items-center gap-2">
                      <span className="w-1.5 h-1.5 rounded-full bg-[#4FC3F7] animate-pulse" />
                      <span className="font-mono text-xs text-slate-500">
                        Reading from Base {network === "mainnet" ? "Mainnet" : "Sepolia"} RPC…
                      </span>
                    </div>
                  )}

                  {/* Error */}
                  {scanError && !scanPending && (
                    <div className="mt-4 rounded-2xl border border-[#EF444430] px-4 py-3">
                      <p className="font-mono text-sm text-[#EF4444]">{scanError}</p>
                      <button onClick={() => setScanError("")}
                        className="font-mono text-xs text-slate-500 hover:text-slate-300 mt-2 transition-colors">
                        Dismiss
                      </button>
                    </div>
                  )}

                  {/* Result */}
                  {scanResult && !scanPending && (
                    <ResultCard info={scanResult}
                      renounce={scanRenounce}
                      onHowItWorks={() => setActiveTab("methodology")}
                      onScanAnother={() => {
                        setScanResult(null); setScanError(""); setScanAddr("");
                        window.history.replaceState({}, "", "/b20");
                      }} />
                  )}

                  {/* Read-only CTA — Scanner stays report-only; manage lives on the Manage tab */}
                  {scanResult?.isB20 && !scanPending && scanWalletRoles?.roles.some(r => r.held) && (
                    <div className="mt-4 rounded-2xl border overflow-hidden" style={{ borderColor: "#4FC3F730" }}>
                      <div className="px-4 py-4 bg-[#0a0a0f] space-y-3">
                        <div className="flex items-center gap-2">
                          <span className="w-1.5 h-1.5 rounded-full bg-[#4FC3F7] shrink-0"
                            style={{ boxShadow: "0 0 4px #4FC3F780" }} />
                          <p className="font-mono text-xs text-[#4FC3F7] font-semibold">You can manage this token</p>
                        </div>

                        {/* Role chips for context */}
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-mono text-[9px] text-slate-600">Your roles:</span>
                          {scanWalletRoles.roles.filter(r => r.held).map(r => (
                            <span key={r.roleKey}
                              className="font-mono text-[8px] px-1.5 py-0.5 rounded bg-[#4FC3F710] text-[#4FC3F7] border border-[#4FC3F720]">
                              {r.roleKey.replace(/_ROLE$/, "")}
                            </span>
                          ))}
                        </div>

                        <p className="font-mono text-[10px] text-slate-500 leading-relaxed">
                          Mint, transfer, manage roles, policy, pause and more — all actions live on the Manage tab.
                        </p>

                        <button onClick={() => goToManage(scanResult.address)}
                          className="font-mono text-xs px-4 py-2 rounded-xl transition-all"
                          style={{ background: "#4FC3F715", color: "#4FC3F7", border: "1px solid #4FC3F730" }}>
                          {t("scanner.manage_cta")}
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Empty state hint */}
                  {!scanResult && !scanPending && !scanError && (
                    <div className="mt-4 rounded-2xl border border-[#1A1A2E] bg-[#0a0a0f] px-5 py-6 text-center">
                      <p className="font-mono text-sm text-slate-500 mb-1">Paste any Base token address</p>
                      <p className="font-mono text-xs text-slate-700">
                        Real-time on-chain data via multicall. No LLM involved.
                      </p>
                    </div>
                  )}
                </div>
              )}

              {/* ── ROLES MAIN ────────────────────────────────────── */}
              {activeTab === "roles" && (
                <div>
                  <div className="rounded-2xl border border-[#F59E0B25] bg-[#F59E0B05] px-4 py-3 mb-5">
                    <p className="font-mono text-sm text-[#F59E0B] font-medium mb-0.5">
                      B20 omits AccessControlEnumerable
                    </p>
                    <p className="font-mono text-xs text-slate-500 leading-relaxed">
                      Role holders cannot be enumerated — you must check specific wallet addresses.
                    </p>
                  </div>

                  <div className="space-y-3 mb-4">
                    <div>
                      <label className="font-mono text-[9px] text-slate-600 tracking-widest uppercase block mb-1.5">
                        Token Address
                      </label>
                      <input value={roleToken} onChange={e => setRoleToken(e.target.value)}
                        placeholder="0x… B20 token address" spellCheck={false} className={INPUT_CLS} />
                    </div>
                    <div>
                      <label className="font-mono text-[9px] text-slate-600 tracking-widest uppercase block mb-1.5">
                        Wallet to Check
                      </label>
                      <input value={roleWallet} onChange={e => setRoleWallet(e.target.value)}
                        placeholder="0x… wallet address" spellCheck={false} className={INPUT_CLS} />
                    </div>
                  </div>

                  <button onClick={doRoles}
                    disabled={!isValidAddr(roleToken) || !isValidAddr(roleWallet) || rolesPending}
                    className="px-5 py-2.5 rounded-xl font-mono text-xs font-semibold transition-all mb-5"
                    style={isValidAddr(roleToken) && isValidAddr(roleWallet) && !rolesPending
                      ? { background: "#4FC3F720", color: "#4FC3F7", border: "1px solid #4FC3F740" }
                      : { background: "#0d0d18", color: "#334155", border: "1px solid #1A1A2E", cursor: "not-allowed" }}>
                    {rolesPending ? "Checking…" : "Check Roles"}
                  </button>

                  {rolesPending && (
                    <div className="flex items-center gap-2 mb-4">
                      <span className="w-1.5 h-1.5 rounded-full bg-[#4FC3F7] animate-pulse" />
                      <span className="font-mono text-xs text-slate-500">Multicall in 2 rounds — fetching role hashes, then checking…</span>
                    </div>
                  )}
                  {rolesError && !rolesPending && (
                    <div className="rounded-2xl border border-[#EF444430] px-4 py-3 mb-4">
                      <p className="font-mono text-xs text-[#EF4444]">{rolesError}</p>
                    </div>
                  )}

                  {rolesResult && !rolesPending && (
                    <div className="rounded-2xl border border-[#1A1A2E] overflow-hidden">
                      <div className="px-4 py-3 bg-[#0a0a0f] border-b border-[#1A1A2E]">
                        <p className="font-mono text-xs text-slate-500">
                          <span className="text-slate-300">{truncAddr(rolesResult.wallet, 8)}</span>
                          <span className="text-slate-600"> on </span>
                          <span className="text-slate-300">{truncAddr(rolesResult.token, 8)}</span>
                          <span className="text-slate-600"> · {rolesResult.network}</span>
                        </p>
                      </div>
                      <div className="divide-y divide-[#0d0d18]">
                        {rolesResult.roles.map(role => (
                          <div key={role.roleKey} className="flex items-center justify-between px-4 py-3.5">
                            <div>
                              <span className="font-mono text-sm text-slate-200">{role.name}</span>
                              {role.hash && (
                                <span className="font-mono text-[9px] text-slate-700 ml-3 hidden sm:inline">
                                  {role.hash.slice(0, 14)}…
                                </span>
                              )}
                            </div>
                            <span className="font-mono text-xs font-semibold px-2.5 py-1 rounded-full"
                              style={role.held === null
                                ? { background: "#64748b15", color: "#64748b" }
                                : role.held
                                  ? { background: "#22C55E15", color: "#22C55E", border: "1px solid #22C55E30" }
                                  : { background: "#0f0f14", color: "#334155" }}>
                              {role.held === null ? "unknown" : role.held ? "HELD" : "—"}
                            </span>
                          </div>
                        ))}
                      </div>
                      <div className="px-4 py-2.5 bg-[#0a0a0f] border-t border-[#1A1A2E]">
                        <p className="font-mono text-[9px] text-slate-700">
                          Checked {new Date(rolesResult.checkedAt).toLocaleTimeString()} via multicall (2 rounds).
                        </p>
                      </div>
                    </div>
                  )}

                  {!rolesResult && !rolesPending && !rolesError && (
                    <div className="rounded-2xl border border-[#1A1A2E] bg-[#0a0a0f] px-5 py-6 text-center">
                      <p className="font-mono text-sm text-slate-500 mb-1">Enter a token + wallet address</p>
                      <p className="font-mono text-xs text-slate-700">
                        Checks all 7 B20 roles via multicall in 2 rounds.
                      </p>
                    </div>
                  )}
                </div>
              )}

              {/* ── REGISTRY MAIN ─────────────────────────────────── */}
              {activeTab === "registry" && (
                <div>
                  {/* Filter + search + sort */}
                  <div className="flex items-center gap-2 flex-wrap mb-4">
                    {(["all", "asset", "stablecoin"] as const).map(f => (
                      <button key={f} onClick={() => setRegFilter(f)}
                        className="font-mono text-[10px] px-2.5 py-1 rounded-full border transition-colors"
                        style={regFilter === f
                          ? f === "asset"
                            ? { background: "#4FC3F715", color: "#4FC3F7", borderColor: "#4FC3F740" }
                            : f === "stablecoin"
                              ? { background: "#22C55E15", color: "#22C55E", borderColor: "#22C55E40" }
                              : { background: "#ffffff10", color: "#e2e8f0", borderColor: "#ffffff20" }
                          : { color: "#475569", borderColor: "#1A1A2E" }}>
                        {f === "all" ? "All" : f === "asset" ? "ASSET" : "STABLECOIN"}
                      </button>
                    ))}
                    <div className="flex-1 min-w-[120px]">
                      <input value={regSearch} onChange={e => setRegSearch(e.target.value)}
                        placeholder={t("registry.search_placeholder")} spellCheck={false}
                        className="w-full bg-[#0a0a12] border border-[#1A1A2E] rounded-xl px-3 py-1.5 font-mono text-xs text-slate-200 placeholder:text-slate-700 outline-none focus:border-[#4FC3F740]" />
                    </div>
                    <div className="flex rounded-lg border border-[#1A1A2E] overflow-hidden shrink-0">
                      {(["newest", "oldest"] as const).map(s => (
                        <button key={s} onClick={() => setRegSort(s)}
                          className="px-2.5 py-1 font-mono text-[9px] transition-colors capitalize"
                          style={regSort === s ? { background: "#4FC3F715", color: "#4FC3F7" } : { color: "#475569" }}>
                          {s}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Loading */}
                  {regPending && (
                    <div className="flex items-center gap-2 mb-4">
                      <span className="w-1.5 h-1.5 rounded-full bg-[#4FC3F7] animate-pulse" />
                      <span className="font-mono text-xs text-slate-500">Scanning B20Factory event log…</span>
                    </div>
                  )}

                  {/* Error */}
                  {registryError && !regPending && (
                    <div className="rounded-2xl border border-[#EF444430] px-4 py-3 mb-4">
                      <p className="font-mono text-xs text-[#EF4444]">{registryError}</p>
                      <button onClick={doRegistry}
                        className="font-mono text-xs text-slate-500 hover:text-slate-300 mt-2 transition-colors">
                        Retry
                      </button>
                    </div>
                  )}

                  {/* Initial placeholder */}
                  {!registryResult && !regPending && !registryError && (
                    <div className="rounded-2xl border border-[#1A1A2E] bg-[#0a0a0f] px-5 py-8 text-center">
                      <p className="font-mono text-sm text-slate-500 mb-1">Loading B20Factory events…</p>
                      <p className="font-mono text-xs text-slate-700">Scanning backwards from latest block</p>
                    </div>
                  )}

                  {/* Empty state */}
                  {registryResult && !regPending && registryResult.entries.length === 0 && (
                    <div className="rounded-2xl border border-[#1A1A2E] px-5 py-10 text-center">
                      <p className="font-mono text-sm text-slate-400 mb-2">No B20 tokens on {network} yet.</p>
                      <p className="font-mono text-xs text-slate-600 mb-5">
                        {network === "mainnet"
                          ? "Beryl mainnet is live. Tokens will appear here as they are deployed."
                          : "Deploy a B20 token on Sepolia to see it here."}
                      </p>
                      <button onClick={() => setActiveTab("launch")}
                        className="font-mono text-xs px-5 py-2 rounded-xl transition-all"
                        style={{ background: "#4FC3F715", color: "#4FC3F7", border: "1px solid #4FC3F735" }}>
                        Launch your first B20 →
                      </button>
                    </div>
                  )}

                  {/* No search results */}
                  {registryResult && !regPending && registryResult.entries.length > 0 && filteredEntries.length === 0 && (
                    <div className="rounded-2xl border border-[#1A1A2E] px-5 py-8 text-center">
                      <p className="font-mono text-sm text-slate-500">No tokens match your filter</p>
                      <button onClick={() => { setRegFilter("all"); setRegSearch(""); }}
                        className="font-mono text-xs text-[#4FC3F7] mt-2 hover:opacity-80 transition-opacity">
                        Clear filters
                      </button>
                    </div>
                  )}

                  {/* Token grid */}
                  {filteredEntries.length > 0 && !regPending && (
                    <div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-3">
                        {filteredEntries.map(entry => (
                          <button key={`${entry.token}-${entry.blockNumber}`}
                            onClick={() => handleRegistrySelect(entry.token)}
                            className="flex items-center gap-3 rounded-2xl border border-[#1A1A2E] px-3 py-3 hover:bg-[#0d0d18] transition-colors text-left w-full">
                            <div className="w-9 h-9 rounded-xl flex items-center justify-center font-mono text-[11px] font-bold shrink-0"
                              style={{
                                background: entry.variant === 0 ? "#4FC3F715" : "#22C55E15",
                                border:     `1px solid ${entry.variant === 0 ? "#4FC3F730" : "#22C55E30"}`,
                                color:      entry.variant === 0 ? "#4FC3F7" : "#22C55E",
                              }}>
                              {(entry.symbol || entry.name).slice(0, 2).toUpperCase()}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-1.5 mb-0.5 flex-wrap">
                                <span className="font-mono text-xs text-white font-medium truncate max-w-[100px]">
                                  {entry.name || "—"}
                                </span>
                                {entry.symbol && (
                                  <span className="font-mono text-[9px] text-slate-500">${entry.symbol}</span>
                                )}
                              </div>
                              <div className="flex items-center gap-1.5">
                                <VariantBadge variant={entry.variantLabel} />
                              </div>
                            </div>
                            <div className="flex flex-col items-end gap-1 shrink-0">
                              <span className="font-mono text-[9px] text-slate-600">
                                #{Number(entry.blockNumber).toLocaleString()}
                              </span>
                              <span className="font-mono text-[9px] text-[#4FC3F7]">Inspect →</span>
                            </div>
                          </button>
                        ))}
                      </div>
                      <div className="flex items-center justify-between px-1">
                        <p className="font-mono text-[9px] text-slate-700">
                          {filteredEntries.length} of {registryResult?.total ?? 0} tokens
                          {registryResult?.capped ? " (capped at 100)" : ""}
                        </p>
                        <a href={`https://${network === "mainnet" ? "" : "sepolia."}basescan.org/address/0xb20f000000000000000000000000000000000000#events`}
                          target="_blank" rel="noopener noreferrer"
                          className="font-mono text-[9px] text-slate-600 hover:text-slate-400 transition-colors">
                          All events ↗
                        </a>
                      </div>
                    </div>
                  )}

                  {/* ── Recent Activity (CONTROL events) ───────────────── */}
                  <div className="mt-6 pt-5 border-t border-[#1A1A2E]">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-mono text-xs font-semibold text-white">{t("activity.title")}</span>
                      <span className="font-mono text-[9px] text-slate-600">{t("activity.control_events")}</span>
                      {activityResult && !activityResult.unavailable && activityResult.events.length > 0 && (
                        <span className="font-mono text-[9px] text-slate-700">· {activityResult.total} total</span>
                      )}
                      <button onClick={doActivity} disabled={activityPending}
                        className="ml-auto font-mono text-[9px] text-slate-600 hover:text-slate-400 transition-colors">
                        {activityPending ? "Loading…" : `↻ ${t("activity.refresh")}`}
                      </button>
                      {activityResult && !activityResult.unavailable && activityResult.events.length > 0 && (
                        <button onClick={() => downloadActivityCsv(activityResult)}
                          title="Export the loaded control events as a CSV compliance report"
                          className="font-mono text-[9px] px-2 py-0.5 rounded-md border transition-colors"
                          style={{ color: "#22C55E", borderColor: "#22C55E30", background: "#22C55E0a" }}>
                          ↓ Export CSV
                        </button>
                      )}
                    </div>
                    <p className="font-mono text-[9px] text-slate-700 mb-3 leading-relaxed">
                      Pause · policy · supply-cap · freeze-seize · role — operator actions on live B20 tokens.
                      Berry &amp; Charon don&apos;t surface these.
                    </p>

                    {/* Loading */}
                    {activityPending && !activityResult && (
                      <div className="flex items-center gap-2 py-3">
                        <span className="w-1.5 h-1.5 rounded-full bg-[#4FC3F7] animate-pulse" />
                        <span className="font-mono text-xs text-slate-500">Loading control events…</span>
                      </div>
                    )}

                    {/* Unavailable — honest fallback */}
                    {activityResult?.unavailable && (
                      <div className="rounded-2xl border border-[#1A1A2E] px-4 py-4 text-center">
                        <p className="font-mono text-xs text-slate-500">{t("activity.unavailable")}</p>
                        <button onClick={doActivity}
                          className="font-mono text-[10px] text-slate-600 hover:text-slate-400 mt-1 transition-colors">
                          Retry
                        </button>
                      </div>
                    )}

                    {/* Empty — mainnet pre-activation / no control events */}
                    {activityResult && !activityResult.unavailable && !activityPending && activityResult.events.length === 0 && (
                      <div className="rounded-2xl border border-[#1A1A2E] px-4 py-5 text-center">
                        <p className="font-mono text-xs text-slate-500">
                          {network === "mainnet"
                            ? "No B20 control events on mainnet yet."
                            : "No control events yet."}
                        </p>
                      </div>
                    )}

                    {/* Feed */}
                    {activityResult && !activityResult.unavailable && activityResult.events.length > 0 && (
                      <div className="flex flex-col gap-1.5">
                        {activityResult.events.map((ev, i) => {
                          const color = ACTIVITY_COLOR[ev.category];
                          return (
                            <div key={`${ev.txHash}-${ev.token}-${i}`}
                              className="flex items-center gap-2.5 rounded-xl border border-[#1A1A2E] px-3 py-2 hover:bg-[#0d0d18] transition-colors">
                              <span className="w-1.5 h-1.5 rounded-full shrink-0"
                                style={{ background: color, boxShadow: `0 0 5px ${color}80` }} />
                              <span className="font-mono text-[8px] px-1.5 py-0.5 rounded shrink-0 hidden sm:inline"
                                style={{ background: `${color}15`, color, border: `1px solid ${color}30` }}>
                                {ACTIVITY_LABEL[ev.category]}
                              </span>
                              <button onClick={() => handleRegistrySelect(ev.token)}
                                title="Inspect this token"
                                className="flex-1 min-w-0 font-mono text-[11px] text-slate-200 hover:text-white transition-colors text-left truncate">
                                {ev.text}
                              </button>
                              <span className="font-mono text-[9px] text-slate-600 shrink-0">{timeAgo(ev.timestamp)}</span>
                              <a href={ev.explorerUrl} target="_blank" rel="noopener noreferrer"
                                className="font-mono text-[9px] text-slate-600 hover:text-[#4FC3F7] transition-colors shrink-0">
                                tx ↗
                              </a>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* ── LAUNCH MAIN ───────────────────────────────────── */}
              {activeTab === "launch" && <LaunchTab onScanToken={handleScanDeployed} network={network} setNetwork={setNetwork} />}

              {/* ── MANAGE MAIN ───────────────────────────────────── */}
              {activeTab === "manage" && (
                <div>
                  {!connectedAddress ? (
                    <div className="rounded-2xl border border-[#F59E0B25] bg-[#F59E0B05] px-5 py-6 text-center">
                      <p className="font-mono text-sm text-[#F59E0B] font-medium mb-1">Connect Wallet</p>
                      <p className="font-mono text-xs text-slate-500 mb-4">
                        Connect your wallet to perform management actions on a B20 token.
                      </p>
                      <ConnectButton label="Connect Wallet" />
                    </div>
                  ) : (
                    <>
                      {/* Token input */}
                      <div className="mb-2">
                        <label className="font-mono text-[9px] text-slate-600 tracking-widest uppercase block mb-1.5">
                          Token Address
                        </label>
                        <div className="flex gap-2">
                          <input
                            value={manageToken}
                            onChange={e => setManageToken(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === "Enter" && isValidAddr(manageToken.trim()) && !managePending) doManageLoad();
                            }}
                            placeholder="0x… B20 token address"
                            spellCheck={false}
                            className={`flex-1 min-w-0 ${INPUT_CLS}`}
                          />
                          <button
                            onClick={() => doManageLoad()}
                            disabled={!isValidAddr(manageToken.trim()) || managePending}
                            className="px-5 py-2.5 rounded-xl font-mono text-xs font-semibold transition-all shrink-0"
                            style={isValidAddr(manageToken.trim()) && !managePending
                              ? { background: "#4FC3F720", color: "#4FC3F7", border: "1px solid #4FC3F740" }
                              : { background: "#0d0d18", color: "#334155", border: "1px solid #1A1A2E", cursor: "not-allowed" }}>
                            {managePending ? "Loading…" : "Load"}
                          </button>
                        </div>
                      </div>

                      {/* Loading — only on the initial load, not on a silent refresh
                          (so the panel stays mounted during refresh and the success toast persists) */}
                      {managePending && !manageData && (
                        <div className="mt-4 flex items-center gap-2">
                          <span className="w-1.5 h-1.5 rounded-full bg-[#4FC3F7] animate-pulse" />
                          <span className="font-mono text-xs text-slate-500">
                            Fetching roles + scope hashes via multicall…
                          </span>
                        </div>
                      )}

                      {/* Error */}
                      {manageError && !managePending && (
                        <div className="mt-4 rounded-2xl border border-[#EF444430] px-4 py-3">
                          <p className="font-mono text-sm text-[#EF4444]">{manageError}</p>
                          <button onClick={() => setManageError("")}
                            className="font-mono text-xs text-slate-500 hover:text-slate-300 mt-2 transition-colors">
                            Dismiss
                          </button>
                        </div>
                      )}

                      {/* ManagePanel — kept mounted during refresh so the success toast persists */}
                      {manageData && (
                        <div className="mt-4">
                          <ManagePanel
                            token={manageToken.trim()}
                            network={network}
                            inspect={manageData.inspect}
                            roles={manageData.roles}
                            scopeHashes={manageData.scopeHashes}
                            balance={manageData.balance}
                            onRefresh={() => doManageLoad(undefined, true)}
                            compact={false}
                          />
                        </div>
                      )}

                      {/* Empty state */}
                      {!manageData && !managePending && !manageError && (
                        <div className="mt-4 rounded-2xl border border-[#1A1A2E] bg-[#0a0a0f] px-5 py-6 text-center">
                          <p className="font-mono text-sm text-slate-500 mb-1">Enter a B20 token address</p>
                          <p className="font-mono text-xs text-slate-700">
                            Actions are gated by your connected wallet&apos;s roles.
                          </p>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}

              {/* ── WATCHLIST MAIN ────────────────────────────────── */}
              {activeTab === "watchlist" && (
                <WatchlistTab
                  connectedAddress={connectedAddress}
                  network={network}
                  setNetwork={setNetwork}
                />
              )}

              {/* ── METHODOLOGY MAIN ──────────────────────────────── */}
              {activeTab === "methodology" && (
                <MethodologyMain onScan={() => setActiveTab("scanner")} />
              )}

            </div>

            {/* SIDE ~38% */}
            <div className="w-full lg:w-[38%] px-5 py-6 space-y-4">

              {/* ── SCANNER SIDE ──────────────────────────────────── */}
              {activeTab === "scanner" && (
                <>
                  {/* Recent scans */}
                  {recentScans.length > 0 && (
                    <SideCard title={`Recent Scans (${recentScans.length})`}>
                      <div className="divide-y divide-[#0d0d18]">
                        {recentScans.map(r => {
                          const isActive = scanResult?.address?.toLowerCase() === r.address.toLowerCase();
                          return (
                            <button key={r.address}
                              onClick={() => { setScanAddr(r.address); doScan(r.address); }}
                              className={`w-full text-left flex items-center gap-3 px-4 py-3 transition-colors ${isActive ? "bg-[#4FC3F7]/8" : "hover:bg-[#0d0d18]"}`}>
                              <div className="flex-1 min-w-0">
                                <p className={`font-mono text-xs truncate ${isActive ? "text-white" : "text-slate-400"}`}>
                                  {r.name}{r.symbol ? ` $${r.symbol}` : ""}
                                </p>
                                <p className="font-mono text-[8px] text-slate-700">{r.address.slice(0, 14)}…</p>
                              </div>
                              <span className="font-mono text-[8px] text-slate-700 shrink-0">
                                {r.network === "mainnet" ? "Main" : "Sepolia"}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </SideCard>
                  )}

                  {/* Quick examples */}
                  <SideCard title="Quick Examples">
                    <div className="px-4 py-3 space-y-2">
                      {[
                        { label: "B20Factory",     addr: "0xB20f000000000000000000000000000000000000", desc: "The factory contract — not a B20 token" },
                        { label: "PolicyRegistry", addr: "0x8453000000000000000000000000000000000002", desc: "Global on-chain policy registry" },
                      ].map(({ label, addr, desc }) => (
                        <button key={addr} onClick={() => { setScanAddr(addr); doScan(addr); }}
                          className="w-full text-left rounded-xl border border-[#1A1A2E] px-3 py-2.5 hover:bg-[#0d0d18] transition-colors">
                          <p className="font-mono text-xs text-slate-300">{label}</p>
                          <p className="font-mono text-[8px] text-slate-700 mt-0.5">{desc}</p>
                        </button>
                      ))}
                      {registryResult?.entries.slice(0, 2).map(e => (
                        <button key={e.token} onClick={() => { setScanAddr(e.token); doScan(e.token); }}
                          className="w-full text-left rounded-xl border border-[#1A1A2E] px-3 py-2.5 hover:bg-[#0d0d18] transition-colors">
                          <div className="flex items-center gap-2 mb-0.5">
                            <p className="font-mono text-xs text-slate-300">{e.name || e.symbol}</p>
                            <VariantBadge variant={e.variantLabel} />
                          </div>
                          <p className="font-mono text-[8px] text-slate-700">{e.token.slice(0, 18)}…</p>
                        </button>
                      ))}
                    </div>
                  </SideCard>

                  {/* What this checks */}
                  <SideCard title="What This Checks">
                    <div className="divide-y divide-[#0d0d18]">
                      {[
                        { icon: "✓",  label: "B20 verification",  desc: "Confirms the token is a real B20 precompile on Base" },
                        { icon: "⏸",  label: "Pause status",      desc: "Transfer, Mint, and Burn — each independently controlled" },
                        { icon: "🔐", label: "Policy gates",      desc: "Which scopes are allowlist/blocklist restricted (KYC, compliance)" },
                        { icon: "📊", label: "Supply & decimals", desc: "Total supply, supply cap, decimals, variant-specific fields" },
                      ].map(({ icon, label, desc }) => (
                        <div key={label} className="flex items-start gap-3 px-4 py-3">
                          <span className="text-sm w-5 shrink-0 text-center leading-relaxed">{icon}</span>
                          <div>
                            <p className="font-mono text-xs text-slate-300">{label}</p>
                            <p className="font-mono text-[9px] text-slate-600 mt-0.5 leading-relaxed">{desc}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="px-4 py-3 border-t border-[#1A1A2E]">
                      <p className="font-mono text-[9px] text-slate-700 leading-relaxed">
                        Zero LLM — all data is read directly from Base via multicall. Results reflect on-chain state at read time.
                      </p>
                    </div>
                  </SideCard>
                </>
              )}

              {/* ── ROLES SIDE ────────────────────────────────────── */}
              {activeTab === "roles" && (
                <>
                  <SideCard title="The 7 B20 Roles">
                    <div className="divide-y divide-[#0d0d18]">
                      {[
                        { r: "DEFAULT_ADMIN_ROLE", d: "Manages all roles + supply cap via updateSupplyCap()" },
                        { r: "MINT_ROLE",          d: "Mint new tokens to any address" },
                        { r: "BURN_ROLE",          d: "Burn tokens (holder approval required)" },
                        { r: "BURN_BLOCKED_ROLE",  d: "Freeze-seize: burnBlocked() forcibly confiscates" },
                        { r: "PAUSE_ROLE",         d: "Pause TRANSFER, MINT, or BURN independently" },
                        { r: "UNPAUSE_ROLE",       d: "Unpause any paused operation" },
                        { r: "METADATA_ROLE",      d: "Update token name, symbol, and metadata" },
                      ].map(({ r, d }) => (
                        <div key={r} className="px-4 py-3">
                          <code className="font-mono text-[9px] text-[#4FC3F7] block mb-0.5">{r}</code>
                          <span className="font-mono text-[10px] text-slate-600 leading-relaxed">{d}</span>
                        </div>
                      ))}
                    </div>
                  </SideCard>

                  <SideCard title="Why This Matters">
                    <div className="px-4 py-4 space-y-3">
                      <p className="font-mono text-xs text-slate-500 leading-relaxed">
                        B20 omits <code className="text-[#4FC3F7]">AccessControlEnumerable</code> — role holders cannot be listed on-chain. You must check specific addresses.
                      </p>
                      <p className="font-mono text-xs text-slate-500 leading-relaxed">
                        Use this checker to verify role assignments before trusting a token or granting permissions in a protocol.
                      </p>
                      <p className="font-mono text-xs leading-relaxed" style={{ color: "#F59E0B80" }}>
                        <span style={{ color: "#F59E0B" }}>BURN_BLOCKED_ROLE</span> is especially sensitive — it allows forcible confiscation of any holder's tokens without their consent.
                      </p>
                    </div>
                  </SideCard>
                </>
              )}

              {/* ── REGISTRY SIDE ─────────────────────────────────── */}
              {activeTab === "registry" && (
                <>
                  <SideCard title="Registry Stats">
                    <div className="divide-y divide-[#0d0d18]">
                      {[
                        { label: "Total tokens",      value: regStats ? regStats.total.toString()       : "—", color: "#e2e8f0" },
                        { label: "ASSET tokens",      value: regStats ? regStats.assetCount.toString()  : "—", color: "#4FC3F7" },
                        { label: "STABLECOIN tokens", value: regStats ? regStats.stableCount.toString() : "—", color: "#22C55E" },
                        { label: "Recent (~5d)",      value: regStats ? regStats.recentCount.toString() : "—", color: "#F59E0B" },
                      ].map(({ label, value, color }) => (
                        <div key={label} className="flex items-center justify-between px-4 py-2.5">
                          <span className="font-mono text-xs text-slate-500">{label}</span>
                          <span className="font-mono text-sm font-semibold" style={{ color }}>{value}</span>
                        </div>
                      ))}
                    </div>
                    {registryResult?.cached && (
                      <div className="px-4 py-2 border-t border-[#1A1A2E]">
                        <p className="font-mono text-[9px] text-slate-700">KV cached · TTL 120s</p>
                      </div>
                    )}
                  </SideCard>

                  <SideCard title="How the Registry Works">
                    <div className="divide-y divide-[#0d0d18]">
                      {[
                        { label: "B20Created event",  desc: "Emitted by B20Factory on every token deployment" },
                        { label: "No database",       desc: "Reconstructed from raw getLogs — backwards chunked scan in 2000-block windows" },
                        { label: "KV cache 120s",     desc: "Results cached server-side so repeated loads are instant" },
                        { label: "Beryl required",    desc: "Factory only active after Beryl upgrade on each network" },
                      ].map(({ label, desc }) => (
                        <div key={label} className="flex items-start gap-3 px-4 py-3">
                          <span className="font-mono text-[9px] text-[#4FC3F7] shrink-0 w-[100px] pt-0.5 leading-relaxed">{label}</span>
                          <span className="font-mono text-[10px] text-slate-600 leading-relaxed">{desc}</span>
                        </div>
                      ))}
                    </div>
                    <div className="px-4 py-3 border-t border-[#1A1A2E]">
                      <a href={`https://${network === "mainnet" ? "" : "sepolia."}basescan.org/address/0xb20f000000000000000000000000000000000000#events`}
                        target="_blank" rel="noopener noreferrer"
                        className="font-mono text-[9px] text-slate-600 hover:text-[#4FC3F7] transition-colors">
                        All B20Created events on Basescan ↗
                      </a>
                    </div>
                  </SideCard>
                </>
              )}

              {/* ── LAUNCH SIDE ───────────────────────────────────── */}
              {activeTab === "launch" && (
                <>
                  <SideCard title="Variant Comparison">
                    <div className="divide-y divide-[#0d0d18]">
                      <div className="grid grid-cols-3 gap-2 px-4 py-2.5">
                        <span className="font-mono text-[9px] text-slate-700" />
                        <span className="font-mono text-[9px] text-[#4FC3F7] font-semibold">ASSET</span>
                        <span className="font-mono text-[9px] text-[#22C55E] font-semibold">STABLECOIN</span>
                      </div>
                      {[
                        { prop: "variant id",   asset: "0",                    stable: "1"               },
                        { prop: "decimals",     asset: "18 (default)",         stable: "6 (fixed)"       },
                        { prop: "currency",     asset: "—",                    stable: "USD, EUR, …"     },
                        { prop: "multiplier",   asset: "rebase-capable",       stable: "—"               },
                        { prop: "use case",     asset: "governance, utility",  stable: "dollar-pegged"   },
                      ].map(({ prop, asset, stable }) => (
                        <div key={prop} className="grid grid-cols-3 gap-2 px-4 py-2.5">
                          <span className="font-mono text-[9px] text-slate-600">{prop}</span>
                          <span className="font-mono text-[9px] text-[#4FC3F7]">{asset}</span>
                          <span className="font-mono text-[9px] text-[#22C55E]">{stable}</span>
                        </div>
                      ))}
                    </div>
                  </SideCard>

                  <LaunchMyTokens />

                  <SideCard title="Before You Deploy">
                    <div className="divide-y divide-[#0d0d18]">
                      {[
                        "Choose variant carefully — cannot be changed after deploy",
                        "Use Sepolia first to test deploy + role setup flow",
                        "Assign DEFAULT_ADMIN_ROLE to a multisig, not an EOA",
                        "Set supply cap before minting via updateSupplyCap()",
                        "Configure PolicyRegistry if you need KYC / compliance gates",
                        "Verify in Scanner tab after deployment to confirm config",
                      ].map((item, i) => (
                        <div key={i} className="flex items-start gap-3 px-4 py-2.5">
                          <span className="font-mono text-[9px] text-slate-600 shrink-0 w-4 pt-0.5">{i + 1}.</span>
                          <span className="font-mono text-[10px] text-slate-500 leading-relaxed">{item}</span>
                        </div>
                      ))}
                    </div>
                  </SideCard>
                </>
              )}

              {/* ── MANAGE SIDE ───────────────────────────────────── */}
              {activeTab === "manage" && (
                <>
                  <SideCard title="Connected Wallet">
                    <div className="px-4 py-3">
                      {connectedAddress ? (
                        <div>
                          <code className="font-mono text-[10px] text-[#4FC3F7] break-all">
                            {truncAddr(connectedAddress, 8)}
                          </code>
                          <p className="font-mono text-[9px] text-slate-700 mt-1 break-all">{connectedAddress}</p>
                        </div>
                      ) : (
                        <p className="font-mono text-xs text-slate-600">No wallet connected</p>
                      )}
                      {manageData && (
                        <div className="mt-3 border-t border-[#1A1A2E] pt-3 space-y-1.5">
                          {manageData.roles.roles.filter(r => r.held).map(r => (
                            <div key={r.roleKey} className="flex items-center gap-2">
                              <span className="w-1.5 h-1.5 rounded-full bg-[#22C55E] shrink-0"
                                style={{ boxShadow: "0 0 4px #22C55E60" }} />
                              <span className="font-mono text-[9px] text-[#22C55E]">{r.name}</span>
                            </div>
                          ))}
                          {manageData.roles.roles.every(r => !r.held) && (
                            <p className="font-mono text-[9px] text-slate-600">No roles held on this token</p>
                          )}
                        </div>
                      )}
                    </div>
                  </SideCard>

                  <SideCard title="Manage Actions">
                    <div className="divide-y divide-[#0d0d18]">
                      {[
                        { role: "MINT_ROLE",          action: "mint(to, amount)",          desc: "Issue new tokens" },
                        { role: "BURN_ROLE",          action: "burn(amount)",              desc: "Burn your balance" },
                        { role: "BURN_BLOCKED_ROLE",  action: "burnBlocked(from, amount)", desc: "Confiscate + burn" },
                        { role: "PAUSE_ROLE",         action: "pause([features])",         desc: "Pause transfer/mint/burn" },
                        { role: "UNPAUSE_ROLE",       action: "unpause([features])",       desc: "Unpause operations" },
                        { role: "DEFAULT_ADMIN_ROLE", action: "updatePolicy + grantRole",  desc: "Policy + role admin" },
                        { role: "METADATA_ROLE",      action: "updateName/Symbol/URI",     desc: "Update token metadata" },
                      ].map(({ role, action, desc }) => (
                        <div key={role} className="px-4 py-2.5">
                          <code className="font-mono text-[8px] text-[#4FC3F7] block mb-0.5">{role}</code>
                          <code className="font-mono text-[9px] text-slate-400 block mb-0.5">{action}</code>
                          <span className="font-mono text-[9px] text-slate-600">{desc}</span>
                        </div>
                      ))}
                    </div>
                  </SideCard>

                  <SideCard title="Safety Notes">
                    <div className="px-4 py-3 space-y-2.5">
                      <p className="font-mono text-[10px] text-[#EF4444] leading-relaxed">
                        <span className="font-semibold">renounceLastAdmin</span> permanently removes DEFAULT_ADMIN_ROLE. Irreversible.
                      </p>
                      <p className="font-mono text-[10px] text-[#F59E0B] leading-relaxed">
                        <span className="font-semibold">burnBlocked</span> forcibly confiscates a holder&apos;s tokens without consent.
                      </p>
                      <p className="font-mono text-[10px] text-slate-600 leading-relaxed">
                        Transactions are encoded client-side and signed by your wallet. No keys or tx data sent to Blue Agent servers.
                      </p>
                    </div>
                  </SideCard>
                </>
              )}

              {/* ── WATCHLIST SIDE ────────────────────────────────── */}
              {activeTab === "watchlist" && (
                <>
                  <SideCard title="How it works">
                    <div className="px-4 py-3 space-y-2.5">
                      <p className="font-mono text-[10px] text-slate-400 leading-relaxed">
                        Each watched token stores a <span className="text-[#4FC3F7]">baseline snapshot</span> of its
                        compliance-critical state — variant, pause flags, per-scope policies, and supply cap.
                      </p>
                      <p className="font-mono text-[10px] text-slate-400 leading-relaxed">
                        On every load we re-inspect each token live and <span className="text-[#4FC3F7]">diff</span> it
                        against the baseline. Detected changes surface as badges; press
                        <span className="text-[#4FC3F7]"> Acknowledge</span> to reset the baseline to the current state.
                      </p>
                      <p className="font-mono text-[10px] text-slate-600 leading-relaxed">
                        Pull-based — no cron, no push. Changes are evaluated the moment you open this tab.
                      </p>
                    </div>
                  </SideCard>

                  <SideCard title="What we diff">
                    <div className="divide-y divide-[#0d0d18]">
                      {[
                        { k: "Pause", v: "transfer / mint / burn paused or resumed" },
                        { k: "Policy", v: "per-scope policy changed (open / blocked / custom)" },
                        { k: "Supply cap", v: "cap raised, lowered, set, or removed" },
                      ].map(({ k, v }) => (
                        <div key={k} className="px-4 py-2.5">
                          <code className="font-mono text-[9px] text-[#4FC3F7] block mb-0.5">{k}</code>
                          <span className="font-mono text-[9px] text-slate-500">{v}</span>
                        </div>
                      ))}
                    </div>
                  </SideCard>

                  <SideCard title="Note">
                    <div className="px-4 py-3 space-y-2.5">
                      <p className="font-mono text-[10px] text-slate-600 leading-relaxed">
                        Raw <span className="text-slate-400">totalSupply</span> is shown for context but never diffed —
                        an active stablecoin mints/burns constantly, which would bury the real signal.
                      </p>
                      <p className="font-mono text-[10px] text-slate-600 leading-relaxed">
                        Watchlist is stored per connected wallet (max 25 tokens). Read-only monitoring — no signing required.
                      </p>
                    </div>
                  </SideCard>
                </>
              )}

              {/* ── METHODOLOGY SIDE ──────────────────────────────── */}
              {activeTab === "methodology" && <MethodologySide />}

            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
