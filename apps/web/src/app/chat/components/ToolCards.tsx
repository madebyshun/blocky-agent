"use client";
// Tool output cards — rendered inline after tool execution logs
// One card per tool type: honeypot, risk-gate, deep-analysis, token-pick, contract-trust

import { useState, useEffect, useCallback, useRef } from "react";
import { useAccount, useReadContracts, useBalance, useReadContract, useWriteContract, useSwitchChain, usePublicClient, useSendTransaction, useCapabilities, useSendCalls, useCallsStatus } from "wagmi";
import { formatUnits, parseUnits, parseEther, isAddress, namehash, encodeFunctionData } from "viem";
import { base } from "viem/chains";
import { useName } from "@coinbase/onchainkit/identity";
import { YIELD_NETWORKS, ERC20_ABI, AAVE_POOL_ABI, ERC4626_ABI, WITHDRAW_ALL, parseUsdc, supplyApyPct, VENUES, VENUE_LIST, type YieldNetwork, type VenueId } from "@/lib/yield-execution";
import { useChat } from "../ChatContext";
import { useBasename } from "@/lib/useBasename";
import { DATA_SUFFIX } from "@/constants/builderCode";
import ManagePanel from "@/app/app/b20/ManagePanel";
import { runB20ManageLoad, type ManageData } from "@/app/app/b20/manage-action";
import { ConnectButton } from "@/components/ConnectModal";
import { useLang } from "@/lib/i18n/context";
import { B20_ENABLED, B20_USDC } from "@/lib/orders";
import { encodeTransferWithMemo, isValidMemo, MEMO_MAX_CHARS } from "@/lib/b20/encode";
import { QRCodeSVG } from "qrcode.react";
import { RobinhoodSwapCard, type RobinhoodSwapResult } from "./RobinhoodSwapCard";
import { RobinhoodSendCard, type RobinhoodSendResult } from "./RobinhoodSendCard";
import { RobinhoodBridgeCard, type RobinhoodBridgeResult } from "./RobinhoodBridgeCard";
import DcaCard, { type DcaResult } from "./DcaCard";
import { HoodArrowCard, type HoodArrowResult } from "./HoodArrowCard";

function truncAddr(addr: string, len = 6) {
  if (!addr || addr.length < 12) return addr;
  return `${addr.slice(0, len)}…${addr.slice(-4)}`;
}

// Forward Basename → address resolution. OnchainKit's useAddress proved
// unreliable (returned "not found" for live names like madebyshun.base.eth), so
// we read the verified Base L2 Resolver directly — proven to resolve correctly.
const BASENAME_L2_RESOLVER = "0xC6d566A56A1aFf6508b41f6c90ff131615583BCD" as const;
const RESOLVER_ADDR_ABI = [
  { name: "addr", type: "function", stateMutability: "view",
    inputs: [{ name: "node", type: "bytes32" }], outputs: [{ type: "address" }] },
] as const;
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

// "shun.base" → "shun.base.eth"; passes through "*.base.eth" / "*.eth".
function basenameToEns(input: string): string | null {
  const n = input.trim().toLowerCase();
  if (!n) return null;
  if (n.endsWith(".base")) return `${n}.eth`;
  if (n.endsWith(".base.eth") || n.endsWith(".eth")) return n;
  return null;
}
function safeNamehash(name: string | null): `0x${string}` | undefined {
  if (!name) return undefined;
  try { return namehash(name); } catch { return undefined; }
}

function ScoreBar({ score, color }: { score: number; color: string }) {
  const pct = Math.max(0, Math.min(100, score));
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1 rounded-full bg-[#1A1A2E] overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="font-mono text-[10px] shrink-0" style={{ color }}>{pct}</span>
    </div>
  );
}

function VerdictBadge({
  verdict, colorMap,
}: {
  verdict: string;
  colorMap: Record<string, { bg: string; text: string; icon: string }>;
}) {
  const s = colorMap[verdict] ?? { bg: "#1E1E32", text: "#94a3b8", icon: "·" };
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full font-mono text-[11px] font-bold"
      style={{ background: s.bg, color: s.text }}
    >
      <span>{s.icon}</span>
      {verdict}
    </span>
  );
}

function FlagList({ flags, color }: { flags: string[]; color: string }) {
  if (!flags?.length) return null;
  return (
    <div className="flex flex-col gap-1">
      {flags.slice(0, 4).map((f, i) => (
        <div key={i} className="flex items-start gap-1.5">
          <span style={{ color }} className="mt-0.5 shrink-0 text-[10px]">›</span>
          <span className="font-mono text-[11px] text-slate-400 leading-snug">{f}</span>
        </div>
      ))}
    </div>
  );
}

// ── Shared card wrapper ───────────────────────────────────────────────────────

function Card({ children, accentColor = "#4FC3F7" }: { children: React.ReactNode; accentColor?: string }) {
  return (
    <div
      className="rounded-xl border overflow-hidden my-3"
      style={{ borderColor: `${accentColor}25`, background: `${accentColor}06` }}
    >
      {children}
    </div>
  );
}

function CardHeader({ children, accentColor }: { children: React.ReactNode; accentColor: string }) {
  return (
    <div
      className="flex items-center justify-between px-4 py-3 border-b"
      style={{ borderColor: `${accentColor}20`, background: `${accentColor}10` }}
    >
      {children}
    </div>
  );
}

function CardBody({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-3 space-y-3">{children}</div>;
}

// ── HoneypotCard ─────────────────────────────────────────────────────────────

interface HoneypotResult {
  verdict?: string;
  confidence?: number;
  is_honeypot?: boolean;
  sell_tax_estimate?: string;
  buy_tax_estimate?: string;
  red_flags?: string[];
  green_flags?: string[];
  assessment?: string;
  token?: { name?: string; symbol?: string; verified?: boolean; url?: string };
  address?: string;
}

const HONEYPOT_COLORS: Record<string, { bg: string; text: string; icon: string }> = {
  SAFE:        { bg: "#16a34a15", text: "#4ade80", icon: "✓" },
  SUSPICIOUS:  { bg: "#d9770615", text: "#fb923c", icon: "⚠" },
  HONEYPOT:    { bg: "#dc262615", text: "#f87171", icon: "✕" },
  NOT_A_TOKEN: { bg: "#1E1E3215", text: "#94a3b8", icon: "·" },
};

export function HoneypotCard({ result }: { result: HoneypotResult }) {
  const verdict   = result.verdict ?? "SUSPICIOUS";
  const color     = HONEYPOT_COLORS[verdict]?.text ?? "#94a3b8";
  const accentColor = verdict === "SAFE" ? "#4ade80" : verdict === "HONEYPOT" ? "#f87171" : verdict === "NOT_A_TOKEN" ? "#64748b" : "#fb923c";
  const url       = result.token?.url ?? (result.address ? `https://basescan.org/address/${result.address}` : undefined);

  return (
    <Card accentColor={accentColor}>
      <CardHeader accentColor={accentColor}>
        <div className="flex items-center gap-3">
          <span className="text-sm">🛡</span>
          <span className="font-mono text-[11px] text-slate-500 tracking-widest uppercase">Honeypot Check</span>
        </div>
        <div className="flex items-center gap-2">
          <VerdictBadge verdict={verdict} colorMap={HONEYPOT_COLORS} />
          {result.confidence !== undefined && (
            <span className="font-mono text-[10px] text-slate-600">{result.confidence}% confidence</span>
          )}
        </div>
      </CardHeader>
      <CardBody>
        {/* Token info */}
        {result.token?.name && (
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] text-slate-400">
              {result.token.symbol && <span style={{ color: accentColor }} className="font-bold">${result.token.symbol}</span>}
              {result.token.name && ` · ${result.token.name}`}
            </span>
            {result.address && (
              <span className="font-mono text-[10px] text-slate-600">{truncAddr(result.address)}</span>
            )}
          </div>
        )}

        {/* Tax row */}
        {(result.sell_tax_estimate || result.buy_tax_estimate) && (
          <div className="flex gap-4 font-mono text-[11px]">
            {result.buy_tax_estimate && (
              <span>Buy tax: <span className="text-slate-300">{result.buy_tax_estimate}</span></span>
            )}
            {result.sell_tax_estimate && (
              <span>Sell tax: <span style={{ color: result.sell_tax_estimate === "0%" ? "#4ade80" : "#fb923c" }}>
                {result.sell_tax_estimate}
              </span></span>
            )}
          </div>
        )}

        {/* Flags */}
        {!!result.red_flags?.length && <FlagList flags={result.red_flags} color="#f87171" />}
        {!!result.green_flags?.length && <FlagList flags={result.green_flags} color="#4ade80" />}

        {/* Assessment */}
        {result.assessment && (
          <p className="font-mono text-[11px] text-slate-500 leading-relaxed border-t pt-2" style={{ borderColor: `${accentColor}15` }}>
            {result.assessment}
          </p>
        )}

        {/* Footer */}
        {url && (
          <div className="flex pt-1">
            <a href={url} target="_blank" rel="noopener noreferrer"
              className="font-mono text-[10px] hover:underline transition-colors"
              style={{ color: accentColor }}>
              View on Basescan ↗
            </a>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

// ── RiskGateCard ─────────────────────────────────────────────────────────────

interface RiskGateResult {
  verdict?: string;
  action?: string;
  risk_score?: number;
  risk_level?: string;
  red_flags?: string[];
  aml_signals?: string[];
  assessment?: string;
  transaction?: { action?: string; to?: string; hasCalldata?: boolean };
  target?: { isContract?: boolean; verified?: boolean; contractName?: string; url?: string };
  community?: { known_drainer?: boolean; known_phishing?: boolean; risk_signals?: string[] };
}

const RISKGATE_COLORS: Record<string, { bg: string; text: string; icon: string }> = {
  PROCEED: { bg: "#16a34a15", text: "#4ade80", icon: "✓" },
  CAUTION: { bg: "#d9770615", text: "#fb923c", icon: "⚠" },
  ABORT:   { bg: "#dc262615", text: "#f87171", icon: "✕" },
};

export function RiskGateCard({ result }: { result: RiskGateResult }) {
  const verdict     = result.verdict ?? "CAUTION";
  const score       = result.risk_score ?? 50;
  const accentColor = verdict === "PROCEED" ? "#4ade80" : verdict === "ABORT" ? "#f87171" : "#fb923c";
  const url         = result.target?.url;

  return (
    <Card accentColor={accentColor}>
      <CardHeader accentColor={accentColor}>
        <div className="flex items-center gap-3">
          <span className="text-sm">⚠️</span>
          <span className="font-mono text-[11px] text-slate-500 tracking-widest uppercase">Risk Gate</span>
        </div>
        <VerdictBadge verdict={verdict} colorMap={RISKGATE_COLORS} />
      </CardHeader>
      <CardBody>
        {/* Transaction info */}
        <div className="flex flex-wrap gap-3 font-mono text-[11px]">
          {result.transaction?.action && (
            <span className="text-slate-400">Action: <span className="text-slate-200 capitalize">{result.transaction.action}</span></span>
          )}
          {result.transaction?.to && (
            <span className="text-slate-400">To: <span className="text-slate-300">{truncAddr(result.transaction.to)}</span></span>
          )}
          {result.target?.contractName && (
            <span className="text-slate-400">Contract: <span className="text-slate-300">{result.target.contractName}</span></span>
          )}
        </div>

        {/* Risk score bar */}
        <div className="space-y-1">
          <div className="flex justify-between font-mono text-[10px] text-slate-600">
            <span>Risk score</span>
            <span style={{ color: accentColor }}>{result.risk_level ?? "medium"}</span>
          </div>
          <ScoreBar score={score} color={accentColor} />
        </div>

        {/* Drainer / phishing badges */}
        {(result.community?.known_drainer || result.community?.known_phishing) && (
          <div className="flex gap-2 flex-wrap">
            {result.community.known_drainer && (
              <span className="font-mono text-[10px] px-2 py-0.5 rounded-full bg-red-950/40 text-red-400 border border-red-900/40">Known drainer</span>
            )}
            {result.community.known_phishing && (
              <span className="font-mono text-[10px] px-2 py-0.5 rounded-full bg-red-950/40 text-red-400 border border-red-900/40">Phishing</span>
            )}
          </div>
        )}

        {/* Flags */}
        {!!result.red_flags?.length && <FlagList flags={result.red_flags} color="#f87171" />}
        {!!result.aml_signals?.length && <FlagList flags={result.aml_signals} color="#fb923c" />}

        {/* Assessment */}
        {result.assessment && (
          <p className="font-mono text-[11px] text-slate-500 leading-relaxed border-t pt-2" style={{ borderColor: `${accentColor}15` }}>
            {result.assessment}
          </p>
        )}

        {url && (
          <a href={url} target="_blank" rel="noopener noreferrer"
            className="font-mono text-[10px] hover:underline" style={{ color: accentColor }}>
            View on Basescan ↗
          </a>
        )}
      </CardBody>
    </Card>
  );
}

// ── DeepAnalysisCard ──────────────────────────────────────────────────────────

interface DeepAnalysisResult {
  verdict?: string;
  composite_score?: number;
  action?: string;
  address?: string;
  token?: { name?: string; symbol?: string; verified?: boolean; isProxy?: boolean; isContract?: boolean; isToken?: boolean; contractName?: string; url?: string };
  security?: { score?: number; critical_risks?: string[]; positive_signals?: string[]; summary?: string };
  market?: { score?: number; community_trust?: string; narrative?: string; summary?: string };
  fundamentals?: { score?: number; activity_level?: string; age_signal?: string; summary?: string };
}

const DEEP_VERDICT_COLORS: Record<string, { bg: string; text: string; icon: string }> = {
  BULLISH: { bg: "#16a34a15", text: "#4ade80", icon: "↑" },
  NEUTRAL: { bg: "#1e40af15", text: "#60a5fa", icon: "→" },
  BEARISH: { bg: "#dc262615", text: "#f87171", icon: "↓" },
};

export function DeepAnalysisCard({ result }: { result: DeepAnalysisResult }) {
  // EOA or non-token contract (pool/router/multisig): token scoring doesn't
  // apply — render a clean note, not misleading 0/0/0 bars or a BEARISH verdict.
  const notAnalyzable =
    result.verdict === "NOT_A_CONTRACT" ||
    result.verdict === "NOT_A_TOKEN" ||
    result.token?.isContract === false ||
    (result.token?.isContract === true && result.token?.isToken === false);
  if (notAnalyzable) {
    const url = result.token?.url ?? (result.address ? `https://basescan.org/address/${result.address}` : undefined);
    const isEOA = result.verdict === "NOT_A_CONTRACT" || result.token?.isContract === false;
    const chip = isEOA ? "NOT A CONTRACT" : "NOT A TOKEN";
    const fallback = isEOA
      ? "This address is a wallet (EOA), not a smart contract or token — there is no code to audit."
      : "This is a non-token contract (pool / router / multisig) — token-level analysis doesn't apply.";
    return (
      <Card accentColor="#64748b">
        <CardHeader accentColor="#64748b">
          <div className="flex items-center gap-3">
            <span className="text-sm">🔬</span>
            <span className="font-mono text-[11px] text-slate-500 tracking-widest uppercase">Deep Analysis</span>
          </div>
          <span className="font-mono text-[10px] px-2 py-0.5 rounded-full bg-slate-800/60 text-slate-400 border border-slate-700/50">{chip}</span>
        </CardHeader>
        <CardBody>
          {result.token?.contractName && (
            <div className="font-mono text-[11px] text-slate-300">{result.token.contractName}{result.token?.verified ? " · verified ✓" : ""}</div>
          )}
          <p className="font-mono text-[11px] text-slate-400 leading-relaxed">
            {result.security?.summary ?? fallback}
          </p>
          {url && (
            <a href={url} target="_blank" rel="noopener noreferrer"
              className="font-mono text-[10px] hover:underline text-slate-400">
              View on Basescan ↗
            </a>
          )}
        </CardBody>
      </Card>
    );
  }

  const verdict     = result.verdict ?? "NEUTRAL";
  const composite   = result.composite_score ?? 50;
  const accentColor = verdict === "BULLISH" ? "#4ade80" : verdict === "BEARISH" ? "#f87171" : "#60a5fa";
  const secScore    = result.security?.score ?? 0;
  const mktScore    = result.market?.score ?? 0;
  const fundScore   = result.fundamentals?.score ?? 0;
  const url         = result.token?.url ?? (result.address ? `https://basescan.org/address/${result.address}` : undefined);

  return (
    <Card accentColor={accentColor}>
      <CardHeader accentColor={accentColor}>
        <div className="flex items-center gap-3">
          <span className="text-sm">🔬</span>
          <div className="flex flex-col">
            <span className="font-mono text-[11px] text-slate-500 tracking-widest uppercase">Deep Analysis</span>
            {result.token?.symbol && (
              <span className="font-mono text-[12px] font-bold" style={{ color: accentColor }}>
                ${result.token.symbol}
                {result.token?.name ? ` · ${result.token.name}` : ""}
              </span>
            )}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <VerdictBadge verdict={verdict} colorMap={DEEP_VERDICT_COLORS} />
          <span className="font-mono text-[10px] text-slate-600">Score {composite}/100</span>
        </div>
      </CardHeader>
      <CardBody>
        {/* Score bars */}
        <div className="space-y-2">
          <div className="space-y-1">
            <div className="flex justify-between font-mono text-[10px] text-slate-600">
              <span>Security</span>
            </div>
            <ScoreBar score={secScore} color={secScore >= 70 ? "#4ade80" : secScore >= 45 ? "#fb923c" : "#f87171"} />
          </div>
          <div className="space-y-1">
            <div className="flex justify-between font-mono text-[10px] text-slate-600">
              <span>Market</span>
            </div>
            <ScoreBar score={mktScore} color={mktScore >= 70 ? "#4ade80" : mktScore >= 45 ? "#fb923c" : "#f87171"} />
          </div>
          <div className="space-y-1">
            <div className="flex justify-between font-mono text-[10px] text-slate-600">
              <span>Onchain</span>
            </div>
            <ScoreBar score={fundScore} color={fundScore >= 70 ? "#4ade80" : fundScore >= 45 ? "#fb923c" : "#f87171"} />
          </div>
        </div>

        {/* Tags row */}
        <div className="flex flex-wrap gap-1.5">
          {result.token?.verified && (
            <span className="font-mono text-[10px] px-2 py-0.5 rounded-full bg-green-950/40 text-green-400 border border-green-900/40">Verified</span>
          )}
          {result.token?.isProxy && (
            <span className="font-mono text-[10px] px-2 py-0.5 rounded-full bg-yellow-950/40 text-yellow-400 border border-yellow-900/40">Proxy</span>
          )}
          {result.market?.narrative && result.market.narrative !== "unknown" && (
            <span className="font-mono text-[10px] px-2 py-0.5 rounded-full border" style={{ borderColor: `${accentColor}30`, color: accentColor, background: `${accentColor}10` }}>
              {result.market.narrative}
            </span>
          )}
          {result.fundamentals?.activity_level && result.fundamentals.activity_level !== "unknown" && (
            <span className="font-mono text-[10px] px-2 py-0.5 rounded-full border border-slate-700/50 text-slate-500">
              activity: {result.fundamentals.activity_level}
            </span>
          )}
        </div>

        {/* Critical risks */}
        {!!result.security?.critical_risks?.length && (
          <FlagList flags={result.security.critical_risks} color="#f87171" />
        )}

        {/* Security summary */}
        {result.security?.summary && (
          <p className="font-mono text-[11px] text-slate-500 leading-relaxed border-t pt-2" style={{ borderColor: `${accentColor}15` }}>
            {result.security.summary}
          </p>
        )}

        {url && (
          <a href={url} target="_blank" rel="noopener noreferrer"
            className="font-mono text-[10px] hover:underline" style={{ color: accentColor }}>
            View on Basescan ↗
          </a>
        )}
      </CardBody>
    </Card>
  );
}

// ── TokenPickCard ─────────────────────────────────────────────────────────────

interface TokenPickResult {
  token?: string;
  symbol?: string;
  thesis?: string;
  entry?: string;
  target?: string;
  kill_criterion?: string;
  sizing?: string;
  conviction?: string;
  timeframe?: string;
  catalysts?: string[];
  risks?: string[];
  narrative?: string;
  // fallback flat structure
  signal?: string;
  pick?: string;
  result?: string;
}

const CONVICTION_COLORS: Record<string, string> = {
  high:   "#4ade80",
  medium: "#fb923c",
  low:    "#94a3b8",
};

export function TokenPickCard({ result }: { result: TokenPickResult }) {
  const conviction  = (result.conviction ?? "medium").toLowerCase();
  const accentColor = CONVICTION_COLORS[conviction] ?? "#4FC3F7";
  const symbol      = result.symbol ?? result.token?.split("(")[0]?.trim() ?? "Token";

  return (
    <Card accentColor={accentColor}>
      <CardHeader accentColor={accentColor}>
        <div className="flex items-center gap-3">
          <span className="text-sm">🎯</span>
          <div>
            <span className="font-mono text-[11px] text-slate-500 tracking-widest uppercase">Token Pick</span>
            {symbol && (
              <p className="font-mono text-[13px] font-bold" style={{ color: accentColor }}>${symbol}</p>
            )}
          </div>
        </div>
        {result.conviction && (
          <span className="font-mono text-[10px] px-2.5 py-1 rounded-full border font-semibold uppercase tracking-wider"
            style={{ color: accentColor, borderColor: `${accentColor}40`, background: `${accentColor}12` }}>
            {conviction} conviction
          </span>
        )}
      </CardHeader>
      <CardBody>
        {/* Thesis */}
        {result.thesis && (
          <p className="font-mono text-[12px] text-slate-300 leading-relaxed">{result.thesis}</p>
        )}

        {/* Trade params */}
        <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 font-mono text-[11px]">
          {result.entry && (
            <div><span className="text-slate-600">Entry</span> <span className="text-slate-300">{result.entry}</span></div>
          )}
          {result.target && (
            <div><span className="text-slate-600">Target</span> <span style={{ color: accentColor }}>{result.target}</span></div>
          )}
          {result.sizing && (
            <div><span className="text-slate-600">Size</span> <span className="text-slate-300">{result.sizing}</span></div>
          )}
          {result.timeframe && (
            <div><span className="text-slate-600">Timeframe</span> <span className="text-slate-300">{result.timeframe}</span></div>
          )}
          {result.narrative && (
            <div className="col-span-2"><span className="text-slate-600">Narrative</span> <span className="text-slate-300">{result.narrative}</span></div>
          )}
        </div>

        {/* Kill criterion */}
        {result.kill_criterion && (
          <div className="flex items-start gap-2 p-2.5 rounded-lg border border-red-900/30 bg-red-950/20">
            <span className="text-red-400 text-xs shrink-0 mt-px">✕</span>
            <div>
              <span className="font-mono text-[10px] text-red-500 uppercase tracking-wider block mb-0.5">Kill switch</span>
              <span className="font-mono text-[11px] text-slate-400">{result.kill_criterion}</span>
            </div>
          </div>
        )}

        {/* Catalysts */}
        {!!result.catalysts?.length && (
          <div>
            <span className="font-mono text-[10px] text-slate-600 uppercase tracking-wider block mb-1">Catalysts</span>
            <FlagList flags={result.catalysts} color={accentColor} />
          </div>
        )}
      </CardBody>
    </Card>
  );
}

// ── ContractTrustCard ─────────────────────────────────────────────────────────

interface ContractTrustResult {
  verdict?: string;
  confidence?: number;
  headline?: string;
  action?: string;
  summary?: string;
  checklist?: string[];
  address?: string;
  basescan?: { verified?: boolean; contractName?: string; isProxy?: boolean; url?: string };
  security?: { score?: number; red_flags?: string[]; green_flags?: string[]; assessment?: string };
  community?: { trust?: string; recognition?: string; verdict?: string };
}

const TRUST_COLORS: Record<string, { bg: string; text: string; icon: string }> = {
  SAFE:     { bg: "#16a34a15", text: "#4ade80", icon: "✓" },
  CAUTION:  { bg: "#d9770615", text: "#fb923c", icon: "⚠" },
  RED_FLAG: { bg: "#dc262615", text: "#f87171", icon: "✕" },
};

export function ContractTrustCard({ result }: { result: ContractTrustResult }) {
  const verdict     = result.verdict ?? "CAUTION";
  const score       = result.security?.score ?? 50;
  const accentColor = TRUST_COLORS[verdict]?.text ?? "#94a3b8";
  const url         = result.basescan?.url ?? (result.address ? `https://basescan.org/address/${result.address}` : undefined);

  return (
    <Card accentColor={accentColor}>
      <CardHeader accentColor={accentColor}>
        <div className="flex items-center gap-3">
          <span className="text-sm">🔐</span>
          <div>
            <span className="font-mono text-[11px] text-slate-500 tracking-widest uppercase">Contract Trust</span>
            {result.basescan?.contractName && (
              <p className="font-mono text-[12px] font-bold text-slate-200">{result.basescan.contractName}</p>
            )}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <VerdictBadge verdict={verdict} colorMap={TRUST_COLORS} />
          {result.confidence !== undefined && (
            <span className="font-mono text-[10px] text-slate-600">{result.confidence}% confidence</span>
          )}
        </div>
      </CardHeader>
      <CardBody>
        {result.headline && (
          <p className="font-mono text-[12px] text-slate-200 font-medium">{result.headline}</p>
        )}

        {/* Security score */}
        <div className="space-y-1">
          <div className="font-mono text-[10px] text-slate-600">Security score</div>
          <ScoreBar score={score} color={accentColor} />
        </div>

        {/* Tags */}
        <div className="flex flex-wrap gap-1.5">
          {result.basescan?.verified && (
            <span className="font-mono text-[10px] px-2 py-0.5 rounded-full bg-green-950/40 text-green-400 border border-green-900/40">Verified</span>
          )}
          {result.basescan?.isProxy && (
            <span className="font-mono text-[10px] px-2 py-0.5 rounded-full bg-yellow-950/40 text-yellow-400 border border-yellow-900/40">Proxy</span>
          )}
          {result.community?.recognition && result.community.recognition !== "unknown" && (
            <span className="font-mono text-[10px] px-2 py-0.5 rounded-full border border-slate-700/50 text-slate-500">
              {result.community.recognition.replace(/_/g, " ")}
            </span>
          )}
        </div>

        {/* Red flags */}
        {!!result.security?.red_flags?.length && <FlagList flags={result.security.red_flags} color="#f87171" />}
        {!!result.security?.green_flags?.length && <FlagList flags={result.security.green_flags} color="#4ade80" />}

        {/* Summary */}
        {result.summary && (
          <p className="font-mono text-[11px] text-slate-500 leading-relaxed border-t pt-2" style={{ borderColor: `${accentColor}15` }}>
            {result.summary}
          </p>
        )}

        {/* Checklist */}
        {!!result.checklist?.length && (
          <div className="space-y-1">
            <span className="font-mono text-[10px] text-slate-600 uppercase tracking-wider">Before interacting</span>
            <FlagList flags={result.checklist.slice(0, 3)} color="#94a3b8" />
          </div>
        )}

        {url && (
          <a href={url} target="_blank" rel="noopener noreferrer"
            className="font-mono text-[10px] hover:underline" style={{ color: accentColor }}>
            View on Basescan ↗
          </a>
        )}
      </CardBody>
    </Card>
  );
}

// ── MarketFitCard ─────────────────────────────────────────────────────────────

const VERDICT_COLORS: Record<string, { bg: string; text: string; icon: string }> = {
  GO:    { bg: "#16a34a15", text: "#4ade80", icon: "✓" },
  WAIT:  { bg: "#d9770615", text: "#fb923c", icon: "⏸" },
  PIVOT: { bg: "#dc262615", text: "#f87171", icon: "↻" },
};

function MarketFitCard({ result }: { result: Record<string, unknown> }) {
  const verdict  = String(result.verdict ?? "");
  const score    = Number(result.score ?? result.market_fit_score ?? 0);
  const summary  = String(result.summary ?? result.suggested_change ?? "");
  const risks    = Array.isArray(result.risks) ? result.risks as string[] : [];
  const brief    = result.brief as Record<string, string> | undefined;
  const color    = verdict === "GO" ? "#4ade80" : verdict === "WAIT" ? "#fb923c" : "#f87171";
  return (
    <Card accentColor={color}>
      <CardHeader accentColor={color}>
        <span className="font-mono text-[11px] font-bold text-slate-300">Market Fit</span>
        <div className="flex items-center gap-2">
          <VerdictBadge verdict={verdict || "—"} colorMap={VERDICT_COLORS} />
          {score > 0 && <span className="font-mono text-[10px]" style={{ color }}>{score}/100</span>}
        </div>
      </CardHeader>
      <CardBody>
        {score > 0 && <ScoreBar score={score} color={color} />}
        {brief && (
          <div className="grid grid-cols-1 gap-1.5">
            {Object.entries(brief).slice(0, 3).map(([k, v]) => (
              <div key={k}>
                <p className="font-mono text-[9px] text-slate-600 uppercase tracking-wider">{k}</p>
                <p className="font-mono text-[11px] text-slate-300 leading-snug">{v}</p>
              </div>
            ))}
          </div>
        )}
        {risks.length > 0 && <FlagList flags={risks} color="#fb923c" />}
        {summary && <p className="font-mono text-[11px] text-slate-400 leading-snug">{summary}</p>}
      </CardBody>
    </Card>
  );
}

// ── WalletPnlCard ─────────────────────────────────────────────────────────────

function WalletPnlCard({ result }: { result: Record<string, unknown> }) {
  const pnl   = String(result.estimatedPnL ?? result.pnl ?? "");
  const wr    = String(result.winRate ?? result.win_rate ?? "");
  const style = String(result.tradingStyle ?? result.trading_style ?? "");
  const score = Number(result.smartMoneyScore ?? result.smart_money_score ?? 0);
  const summary = String(result.summary ?? "");
  const isPos = pnl.startsWith("+");
  const color = isPos ? "#4ade80" : pnl.startsWith("-") ? "#f87171" : "#4FC3F7";
  return (
    <Card accentColor={color}>
      <CardHeader accentColor={color}>
        <span className="font-mono text-[11px] font-bold text-slate-300">Wallet PnL</span>
        {pnl && <span className="font-mono text-[13px] font-bold" style={{ color }}>{pnl}</span>}
      </CardHeader>
      <CardBody>
        <div className="grid grid-cols-3 gap-3">
          {wr    && <div><p className="font-mono text-[9px] text-slate-600 uppercase">Win Rate</p><p className="font-mono text-[12px]" style={{ color: "#4ade80" }}>{wr}</p></div>}
          {style && <div><p className="font-mono text-[9px] text-slate-600 uppercase">Style</p><p className="font-mono text-[11px] text-slate-300">{style}</p></div>}
          {score > 0 && <div><p className="font-mono text-[9px] text-slate-600 uppercase">Smart $</p><ScoreBar score={score} color="#A78BFA" /></div>}
        </div>
        {summary && <p className="font-mono text-[11px] text-slate-400 leading-snug">{summary}</p>}
      </CardBody>
    </Card>
  );
}

// ── AmlCard ───────────────────────────────────────────────────────────────────

const AML_COLORS: Record<string, { bg: string; text: string; icon: string }> = {
  CLEAN:      { bg: "#16a34a15", text: "#4ade80", icon: "✓" },
  SUSPICIOUS: { bg: "#d9770615", text: "#fb923c", icon: "⚠" },
  FLAGGED:    { bg: "#dc262615", text: "#f87171", icon: "✕" },
};

function AmlCard({ result }: { result: Record<string, unknown> }) {
  const verdict = String(result.verdict ?? result.status ?? "");
  const score   = Number(result.riskScore ?? result.risk_score ?? 0);
  const flags   = Array.isArray(result.flags) ? result.flags as string[] : [];
  const summary = String(result.summary ?? "");
  const color   = verdict === "CLEAN" ? "#4ade80" : verdict === "FLAGGED" ? "#f87171" : "#fb923c";
  return (
    <Card accentColor={color}>
      <CardHeader accentColor={color}>
        <span className="font-mono text-[11px] font-bold text-slate-300">AML Screen</span>
        <div className="flex items-center gap-2">
          <VerdictBadge verdict={verdict || "—"} colorMap={AML_COLORS} />
          {score > 0 && <span className="font-mono text-[10px]" style={{ color }}>Risk {score}</span>}
        </div>
      </CardHeader>
      <CardBody>
        {score > 0 && <ScoreBar score={score} color={color} />}
        {flags.length > 0 && <FlagList flags={flags} color="#fb923c" />}
        {summary && <p className="font-mono text-[11px] text-slate-400 leading-snug">{summary}</p>}
      </CardBody>
    </Card>
  );
}

// ── QuantumCard ───────────────────────────────────────────────────────────────

function QuantumCard({ result }: { result: Record<string, unknown> }) {
  const score    = Number(result.vulnerabilityScore ?? result.score ?? result.quantum_score ?? 0);
  const verdict  = String(result.verdict ?? result.risk_level ?? "");
  const exposed  = result.keyExposed ?? result.key_exposed;
  const timeline = String(result.timeline ?? result.threat_timeline ?? "");
  const recs     = Array.isArray(result.recommendations) ? result.recommendations as string[] : [];
  const color    = score > 70 ? "#f87171" : score > 40 ? "#fb923c" : "#4ade80";
  return (
    <Card accentColor={color}>
      <CardHeader accentColor={color}>
        <span className="font-mono text-[11px] font-bold text-slate-300">⚛ Quantum Scan</span>
        <div className="flex items-center gap-2">
          {verdict && <span className="font-mono text-[10px] font-bold" style={{ color }}>{verdict}</span>}
          {score > 0 && <span className="font-mono text-[10px] text-slate-500">Score {score}</span>}
        </div>
      </CardHeader>
      <CardBody>
        {score > 0 && <ScoreBar score={score} color={color} />}
        {exposed !== undefined && (
          <div className="flex items-center gap-2">
            <span className="font-mono text-[9px] text-slate-600 uppercase">Key Exposed</span>
            <span className="font-mono text-[11px]" style={{ color: exposed ? "#f87171" : "#4ade80" }}>{exposed ? "Yes ⚠" : "No ✓"}</span>
          </div>
        )}
        {timeline && <p className="font-mono text-[11px] text-slate-400 leading-snug">{timeline}</p>}
        {recs.length > 0 && <FlagList flags={recs} color="#A78BFA" />}
      </CardBody>
    </Card>
  );
}

// ── YieldCard ─────────────────────────────────────────────────────────────────

function YieldCard({ result }: { result: Record<string, unknown> }) {
  const opps = Array.isArray(result.opportunities) ? result.opportunities as Record<string, unknown>[] : [];
  const summary = String(result.summary ?? result.top_opportunity ?? "");
  return (
    <Card accentColor="#34D399">
      <CardHeader accentColor="#34D399">
        <span className="font-mono text-[11px] font-bold text-slate-300">💰 Yield Optimizer</span>
        {opps.length > 0 && <span className="font-mono text-[10px] text-[#34D399]">{opps.length} opportunities</span>}
      </CardHeader>
      <CardBody>
        {opps.slice(0, 3).map((o, i) => (
          <div key={i} className="flex items-center justify-between py-1 border-b border-slate-800 last:border-0">
            <div>
              <p className="font-mono text-[11px] text-slate-200">{String(o.protocol ?? o.name ?? "")}</p>
              <p className="font-mono text-[9px] text-slate-600">{String(o.asset ?? o.pool ?? "")}</p>
            </div>
            <span className="font-mono text-[12px] font-bold text-[#34D399]">{String(o.apy ?? o.apr ?? "")}</span>
          </div>
        ))}
        {opps.length === 0 && summary && <p className="font-mono text-[11px] text-slate-400">{summary}</p>}
      </CardBody>
    </Card>
  );
}

// ── BlueStreamCard — live trending/new-pool feed (Base or Robinhood Chain) ────

function BlueStreamCard({ result }: { result: Record<string, unknown> }) {
  const chain = String(result.chain ?? "base");
  const isRobinhood = chain === "robinhood";
  const trending = Array.isArray(result.trending) ? (result.trending as Record<string, unknown>[]) : [];
  const newPools = Array.isArray(result.new_pools) ? (result.new_pools as Record<string, unknown>[]) : [];
  const tvl = result.base_tvl as Record<string, unknown> | null | undefined;
  const errorMsg = typeof result.error === "string" ? result.error : "";

  const renderRow = (p: Record<string, unknown>, i: number) => {
    const change = String(p.change_24h ?? p.change_1h ?? "");
    const isUp = change.startsWith("+");
    const isDown = change.startsWith("-");
    return (
      <a
        key={i}
        href={typeof p.url === "string" ? p.url : undefined}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center justify-between py-1.5 border-b border-slate-800 last:border-0 hover:bg-slate-800/30 -mx-1 px-1 rounded"
      >
        <div className="min-w-0">
          <p className="font-mono text-[11px] text-slate-200 truncate">{String(p.token ?? "")}</p>
          <p className="font-mono text-[9px] text-slate-600 truncate">{String(p.pool ?? "")}</p>
        </div>
        <div className="text-right shrink-0 pl-2">
          <p className="font-mono text-[11px] text-slate-300">{p.price_usd != null ? `$${p.price_usd}` : ""}</p>
          <p className={`font-mono text-[10px] ${isUp ? "text-[#34D399]" : isDown ? "text-red-400" : "text-slate-500"}`}>
            {change || "—"}
          </p>
        </div>
      </a>
    );
  };

  return (
    <Card accentColor={isRobinhood ? "#34D399" : "#4FC3F7"}>
      <CardHeader accentColor={isRobinhood ? "#34D399" : "#4FC3F7"}>
        <span className="font-mono text-[11px] font-bold text-slate-300">
          {isRobinhood ? "🟢 Robinhood Chain Stream" : "🔵 Base Stream"}
        </span>
        {tvl?.usd != null && (
          <span className="font-mono text-[10px] text-slate-500">
            TVL ${Number(tvl.usd).toLocaleString()} {tvl.change_1d ? `(${tvl.change_1d} 1d)` : ""}
          </span>
        )}
      </CardHeader>
      <CardBody>
        {errorMsg && <p className="font-mono text-[11px] text-slate-400">{errorMsg}</p>}
        {trending.length > 0 && (
          <div className="mb-2">
            <p className="font-mono text-[9px] text-slate-600 uppercase mb-1">Trending</p>
            {trending.slice(0, 5).map(renderRow)}
          </div>
        )}
        {newPools.length > 0 && (
          <div>
            <p className="font-mono text-[9px] text-slate-600 uppercase mb-1">New Pools</p>
            {newPools.slice(0, 5).map(renderRow)}
          </div>
        )}
        {!errorMsg && trending.length === 0 && newPools.length === 0 && (
          <p className="font-mono text-[11px] text-slate-500">No live data right now.</p>
        )}
      </CardBody>
    </Card>
  );
}

// ── GenericCard — fallback for any tool without a specific card ───────────────

const SKIP_KEYS = new Set(["raw", "prompt", "_meta", "model", "tool", "command"]);

function GenericCard({ tool, result }: { tool: string; result: Record<string, unknown> }) {
  const label = tool.replace(/^hub_/, "").replace(/_/g, " ");

  // Pick the most informative fields to surface
  const topFields = Object.entries(result)
    .filter(([k, v]) => !SKIP_KEYS.has(k) && v !== null && v !== undefined && v !== "")
    .slice(0, 6);

  if (topFields.length === 0) return null;

  return (
    <Card accentColor="#4FC3F7">
      <CardHeader accentColor="#4FC3F7">
        <span className="font-mono text-[11px] font-bold text-slate-300 capitalize">{label}</span>
      </CardHeader>
      <CardBody>
        <div className="grid grid-cols-1 gap-2">
          {topFields.map(([k, v]) => {
            const isArray  = Array.isArray(v);
            const isObject = typeof v === "object" && !isArray;
            const display  = isArray
              ? (v as unknown[]).slice(0, 3).map(String).join(" · ")
              : isObject
              ? JSON.stringify(v).slice(0, 120)
              : String(v).slice(0, 200);
            const isScore  = /score|rating|pct|percent/i.test(k) && typeof v === "number";
            const key      = k.replace(/_/g, " ");
            return (
              <div key={k}>
                <p className="font-mono text-[9px] text-slate-600 uppercase tracking-wider">{key}</p>
                {isScore
                  ? <ScoreBar score={Number(v)} color="#4FC3F7" />
                  : <p className="font-mono text-[11px] text-slate-300 leading-snug">{display}</p>
                }
              </div>
            );
          })}
        </div>
      </CardBody>
    </Card>
  );
}

// ── Router — pick the right card for a tool ───────────────────────────────────

// ── Portfolio card (live, client-side) ────────────────────────────────────────
// Rendered for the `show_portfolio` marker tool. Reads the connected wallet's
// Base balances directly via wagmi (read-only, no signing) so the number is
// live rather than a server snapshot. Mirrors the dashboard's token set.

const PORTFOLIO_TOKENS = [
  { sym: "BLUEAGENT", address: "0xf895783b2931c919955e18b5e3343e7c7c456ba3", decimals: 18, color: "#4FC3F7" },
  { sym: "USDC",  address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6,  color: "#22C55E" },
  { sym: "WETH",  address: "0x4200000000000000000000000000000000000006", decimals: 18, color: "#A78BFA" },
  { sym: "cbBTC", address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", decimals: 8,  color: "#F59E0B" },
  { sym: "AERO",  address: "0x940181a94A35A4569E4529A3CDfB74e38FD98631", decimals: 18, color: "#F472B6" },
] as const;

const ERC20_BALANCE_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view",
    inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

function fmtTokenAmt(n: number, decimals: number): string {
  if (n === 0) return "0";
  if (decimals <= 6)  return n.toFixed(2);
  if (n >= 1_000)     return (n / 1_000).toFixed(2) + "K";
  if (n >= 1)         return n.toFixed(4);
  return n.toFixed(6);
}

function PortfolioCard() {
  const { address, isConnected } = useAccount();
  const { data: native } = useBalance({ address });
  const { data, isLoading } = useReadContracts({
    contracts: PORTFOLIO_TOKENS.map(t => ({
      address:      t.address as `0x${string}`,
      abi:          ERC20_BALANCE_ABI,
      functionName: "balanceOf",
      args:         address ? [address] : undefined,
    })),
    query: { enabled: !!address },
  });

  if (!isConnected || !address) {
    return (
      <div className="mt-2 rounded-xl border border-[#1A1A2E] bg-[#0a0a0f] p-3 font-mono text-[11px] text-slate-500">
        Connect a wallet to see your Base portfolio.
      </div>
    );
  }

  const eth = native ? Number(formatUnits(native.value, 18)) : null;
  const rows = [
    { sym: "ETH", color: "#627EEA", decimals: 18, amt: eth },
    ...PORTFOLIO_TOKENS.map((t, i) => {
      const raw = data?.[i]?.result as bigint | undefined;
      return { sym: t.sym, color: t.color, decimals: t.decimals,
               amt: raw !== undefined ? Number(formatUnits(raw, t.decimals)) : null };
    }),
  ];

  return (
    <div className="mt-2 rounded-xl border border-[#1A1A2E] bg-[#0a0a0f] p-3.5">
      <div className="flex items-center justify-between mb-3">
        <span className="font-mono text-[10px] text-slate-500 tracking-widest font-bold">PORTFOLIO · BASE</span>
        <span className="font-mono text-[9px] text-slate-700">{truncAddr(address)}</span>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {rows.map(t => {
          const isZero = !t.amt || t.amt === 0;
          return (
            <div key={t.sym}
              className={`rounded-lg border p-2 ${isZero ? "border-[#1A1A2E]/40 bg-[#0a0a0f]/40 opacity-50" : "border-[#1A1A2E] bg-[#0d0d12]"}`}>
              <div className="font-mono text-[9px] tracking-widest font-bold mb-0.5" style={{ color: t.color }}>{t.sym}</div>
              <div className="font-mono text-[12px] font-bold text-white leading-none truncate">
                {isLoading && t.amt === null ? "…" : t.amt === null ? "—" : fmtTokenAmt(t.amt, t.decimals)}
              </div>
            </div>
          );
        })}
      </div>
      <p className="font-mono text-[9px] text-slate-700 mt-2.5">Live on-chain balances · read-only</p>
    </div>
  );
}

// ── Token launch card (Bankr launchpad, explicit confirm) ─────────────────────
// Rendered for the `prepare_token_launch` marker. A real, irreversible deploy
// on Base — so it's a preview with an explicit Launch button. The deploy runs
// server-side via Bankr's partner key; the 57% creator-fee share is routed to
// the user's connected wallet (feeRecipient), so they own the upside without a
// Bankr account or a signature.

interface TokenLaunchResult {
  tokenName?:        string;
  tokenSymbol?:      string;
  description?:      string;
  image?:            string;
  website?:          string;
  feeRecipientType?: string;   // wallet | x | farcaster | ens (from the agent Q&A)
  feeRecipientValue?:string;
  // If the agent already knows which chain the user wants, pass it through to
  // skip the picker step. Otherwise the card asks Base vs Robinhood Chain first.
  chain?: "base" | "robinhood";
  decimals?: number;
  initial_supply?: string;
}

const ROBINHOOD_NETWORKS = [
  { id: "mainnet", label: "Robinhood Chain",         chain: 4663,  explorer: "https://robinhoodchain.blockscout.com" },
  { id: "testnet", label: "Robinhood Chain Testnet", chain: 46630, explorer: "https://explorer.testnet.chain.robinhood.com" },
] as const;
type RobinhoodNet = typeof ROBINHOOD_NETWORKS[number]["id"];

type FeeType = "wallet" | "x" | "farcaster" | "ens";
const FEE_TYPES: { id: FeeType; label: string; placeholder: string }[] = [
  { id: "wallet",    label: "Wallet",    placeholder: "0x… (your address)" },
  { id: "x",         label: "X",         placeholder: "@username" },
  { id: "farcaster", label: "Farcaster", placeholder: "username" },
  { id: "ens",       label: "ENS",       placeholder: "name.eth" },
];

// Default fee recipient when the user leaves the field blank — BlueAgent's X
// account (@blueagent_). Bankr resolves the X handle → verified wallet at deploy
// time, so launches monetize BlueAgent by default; the user can redirect the
// 57% creator fee to themselves (wallet / X / Farcaster / ENS).
const BLUE_FEE_X = "blueagent_";

// Small labelled text input used across the launch form.
function LaunchField({ label, value, onChange, placeholder }: {
  label: string; value: string; onChange: (v: string) => void; placeholder: string;
}) {
  return (
    <label className="block">
      <span className="font-mono text-[9px] text-slate-600 block mb-1">{label}</span>
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-[#050508] border border-[#1A1A2E] focus:border-[#4FC3F7]/40 rounded-lg px-2.5 py-1.5 font-mono text-[11px] text-slate-200 placeholder:text-slate-700 outline-none transition-colors"
      />
    </label>
  );
}

function TokenLaunchCard({ result }: { result: TokenLaunchResult }) {
  const { address, chainId: currentChainId } = useAccount();
  const { sendTransactionAsync } = useSendTransaction();
  const { switchChainAsync } = useSwitchChain();

  // Chain picker — Base (Bankr, sponsored) vs Robinhood Chain (direct,
  // self-signed, no factory). Pre-set from the agent's args if it already
  // knows; otherwise null shows the picker step first.
  const [chain, setChain] = useState<"base" | "robinhood" | null>(result.chain ?? null);

  const [step, setStep] = useState<"idle" | "launching" | "done" | "error">("idle");
  const [err,  setErr]  = useState<string>("");
  const [out,  setOut]  = useState<{ tokenAddress: string | null; basescan: string | null; uniswap: string | null; bankr: string | null } | null>(null);

  // Robinhood-only fields.
  const [rhDecimals, setRhDecimals] = useState<number>(result.decimals ?? 18);
  const [rhSupply,   setRhSupply]   = useState(result.initial_supply ?? "1000000000");
  const [rhNetwork,  setRhNetwork]  = useState<RobinhoodNet>("mainnet");
  const [rhTxHash,   setRhTxHash]   = useState("");
  const [rhPolling,  setRhPolling]  = useState(false);
  const [showReceive, setShowReceive] = useState(false);

  // Every token field is editable in the card — pre-filled only from values the
  // agent explicitly passed through (it never invents them), but the card is the
  // source of truth so the user can fix/fill anything before launching.
  const [name,        setName]        = useState(result.tokenName ?? "");
  const [symbol,      setSymbol]      = useState((result.tokenSymbol ?? "").replace(/^\$/, ""));
  const [description, setDescription] = useState(result.description ?? "");
  const [image,       setImage]       = useState(result.image ?? "");
  const [website,     setWebsite]     = useState(result.website ?? "");

  // Fee recipient — who gets the 57% creator share. Pre-selected from the Q&A if
  // any; left blank, fees default to BlueAgent (see resolved* below).
  // Default tab = X so the blank-field default visibly matches @blueagent_
  // (the creator fee routes there until the user picks/fills a recipient).
  const initType = (["wallet", "x", "farcaster", "ens"].includes(result.feeRecipientType ?? "")
    ? result.feeRecipientType : "x") as FeeType;
  const [feeType,  setFeeType]  = useState<FeeType>(initType);
  const [feeValue, setFeeValue] = useState(result.feeRecipientValue ?? "");

  const cleanName   = name.trim();
  const cleanSymbol = symbol.replace(/^\$/, "").trim();

  // Resolve the effective fee recipient. If the user entered nothing, the 57%
  // creator fee defaults to BlueAgent's X account (@blueagent_) — the user can
  // redirect it to their own wallet / X / Farcaster / ENS by filling the field.
  const feeEntered       = feeValue.trim().length > 0;
  const resolvedFeeType  = feeEntered ? feeType : "x";
  const resolvedFeeValue = feeEntered ? feeValue.trim() : BLUE_FEE_X;

  async function launch() {
    if (!cleanName) return;
    setStep("launching"); setErr("");
    try {
      const res = await fetch("/api/launch-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tokenName: cleanName, tokenSymbol: cleanSymbol || undefined,
          description: description.trim() || undefined,
          feeRecipientType: resolvedFeeType, feeRecipientValue: resolvedFeeValue,
          image: image.trim() || undefined, website: website.trim() || undefined,
          // Route BOTH chains through Bankr's launchpad — chain:"robinhood"
          // uses the user-level BANKR_API_KEY (partner keys are Base-only per
          // docs.bankr.bot/token-launching/overview). Bankr handles gas + pool.
          chain: chain === "robinhood" ? "robinhood" : "base",
        }),
      });
      const d = await res.json();
      if (!res.ok) {
        // 503 = missing partner key — surface setup instruction directly
        const setupMsg = d?.setup
          ? "Token launch needs a Bankr partner key — set BANKR_PARTNER_KEY in Vercel env vars."
          : null;
        // Otherwise show whatever Bankr actually returned so we don't hide
        // "Internal server error" behind our own sanitized wrapper.
        const bd = d?._debug?.bankrBody;
        const bankrDetail =
          typeof bd === "string" ? bd :
          bd && typeof bd === "object"
            ? (bd.error || bd.message || JSON.stringify(bd).slice(0, 300))
            : null;
        const msg = setupMsg
          ?? (bankrDetail
                ? `${d?.error ?? "Launch failed"} · Bankr: ${bankrDetail}`
                : (d?.error ?? `Launch failed (${res.status})`));
        setErr(msg); setStep("error"); return;
      }
      setOut({
        tokenAddress: d.tokenAddress ?? null,
        // Chain-agnostic explorer URL from the API; fall back to legacy Base-only field.
        basescan: d.explorer ?? d.basescan ?? null,
        uniswap: d.uniswap ?? null,
        bankr: d.bankr ?? null,
      });
      setStep("done");
    } catch (e) {
      setErr((e as Error).message); setStep("error");
    }
  }

  async function launchRobinhood() {
    if (!address) { setErr("Connect your wallet first"); setStep("error"); return; }
    if (!cleanName || !cleanSymbol) { setErr("Name and symbol required"); setStep("error"); return; }
    setStep("launching"); setErr(""); setRhTxHash("");
    try {
      const net = ROBINHOOD_NETWORKS.find(x => x.id === rhNetwork)!;
      const supplyBaseUnits = (BigInt(rhSupply || "0") * (10n ** BigInt(rhDecimals))).toString();

      const prepRes = await fetch("/api/robinhood/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: cleanName, symbol: cleanSymbol, decimals: rhDecimals,
          initial_supply: supplyBaseUnits,
          owner: address,
          network: rhNetwork,
        }),
      });
      const prep = await prepRes.json();
      if (!prep.ok) throw new Error(prep.error || "Prepare failed");

      if (currentChainId !== net.chain) {
        try {
          await switchChainAsync({ chainId: net.chain });
        } catch {
          throw new Error(`Switch your wallet to ${net.label} and try again`);
        }
      }

      // Contract-creation tx — no `to` field.
      const hash = await sendTransactionAsync({
        data:    prep.tx.data as `0x${string}`,
        value:   0n,
        chainId: net.chain,
      });
      setRhTxHash(hash);
      setRhPolling(true);

      let landed = false;
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 3000));
        const recRes = await fetch("/api/robinhood/receipt", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tx_hash: hash, network: rhNetwork,
            tokenName: cleanName, tokenSymbol: cleanSymbol,
            image: image.trim() || undefined, website: website.trim() || undefined,
            description: description.trim() || undefined,
            owner: address,
          }),
        });
        const rec = await recRes.json();
        if (rec.ok && rec.status === "success" && rec.tokenAddress) {
          setOut({ tokenAddress: rec.tokenAddress, basescan: rec.tokenUrl ?? null, uniswap: null, bankr: null });
          landed = true;
          break;
        }
        if (rec.ok && rec.status === "reverted") throw new Error("Transaction reverted");
      }
      setRhPolling(false);
      if (!landed) throw new Error("Timed out waiting for confirmation — check the tx hash on the explorer.");
      setStep("done");
    } catch (e) {
      setErr((e as Error).message); setStep("error");
    } finally {
      setRhPolling(false);
    }
  }

  const chainLabel = chain === "robinhood" ? ROBINHOOD_NETWORKS.find(x => x.id === rhNetwork)!.label : "Base";

  if (step === "done") {
    return (
      <div className="mt-2 rounded-xl border p-3.5" style={{ borderColor: "#22C55E40", background: "#22C55E08" }}>
        <div className="font-mono text-[11px] font-bold mb-1" style={{ color: "#22C55E" }}>🚀 ${cleanSymbol || cleanName} launched on {chainLabel}</div>
        {out?.tokenAddress && <div className="font-mono text-[10px] text-slate-400 mb-2 break-all">{out.tokenAddress}</div>}
        <div className="flex flex-wrap gap-2">
          {out?.bankr    && <a href={out.bankr}    target="_blank" rel="noopener noreferrer" className="font-mono text-[10px] px-2.5 py-1 rounded-lg border border-[#4FC3F730] text-[#4FC3F7]">View on Bankr ↗</a>}
          {out?.basescan && <a href={out.basescan} target="_blank" rel="noopener noreferrer" className="font-mono text-[10px] px-2.5 py-1 rounded-lg border border-[#1A1A2E] text-slate-300 hover:text-white">{chain === "robinhood" ? "Explorer ↗" : "Basescan ↗"}</a>}
          {out?.uniswap  && <a href={out.uniswap}  target="_blank" rel="noopener noreferrer" className="font-mono text-[10px] px-2.5 py-1 rounded-lg border border-[#F59E0B30] text-[#F59E0B]">Trade on Uniswap ↗</a>}
        </div>
        {chain !== "robinhood" && (
          <p className="font-mono text-[9px] text-slate-600 mt-2">Creator fees (57%) accrue to {feeEntered ? "the fee recipient" : "@blueagent_"}.</p>
        )}
      </div>
    );
  }

  // ── Step 0: pick chain ──────────────────────────────────────────────────
  if (chain === null) {
    return (
      <div className="mt-2 rounded-xl border border-[#1A1A2E] bg-[#0a0a0f] p-3.5">
        <div className="font-mono text-[10px] text-slate-500 tracking-widest font-bold mb-3">LAUNCH A TOKEN — CHOOSE CHAIN</div>
        <div className="grid grid-cols-2 gap-2 mb-1">
          <button onClick={() => setChain("base")}
            className="rounded-xl p-3 text-left transition-colors"
            style={{ background: "#4FC3F715", border: "1px solid #4FC3F730" }}>
            <div className="font-mono text-[12px] font-bold text-[#4FC3F7] mb-0.5">Base</div>
            <div className="font-mono text-[9px] text-slate-500">via Bankr · gas sponsored · 57% creator fee</div>
          </button>
          <button onClick={() => setChain("robinhood")}
            className="rounded-xl p-3 text-left transition-colors"
            style={{ background: "#22C55E15", border: "1px solid #22C55E30" }}>
            <div className="font-mono text-[12px] font-bold text-[#22C55E] mb-0.5">Robinhood Chain</div>
            <div className="font-mono text-[9px] text-slate-500">direct deploy · your wallet signs · your gas</div>
          </button>
        </div>
      </div>
    );
  }

  // ── Step 1: Robinhood Chain form ────────────────────────────────────────
  if (chain === "robinhood") {
    // Robinhood-via-Bankr — same form as Base, just tagged with { chain: "robinhood" }
    // in the API body. The dormant direct-deploy path (launchRobinhood + the
    // decimals/supply/network fields + Receive QR) is kept in the codebase
    // but not exposed anywhere in the UI.
    return (
      <div className="mt-2 rounded-xl border border-[#1A1A2E] bg-[#0a0a0f] p-3.5">
        <div className="flex items-center justify-between mb-3">
          <div className="font-mono text-[10px] text-slate-500 tracking-widest font-bold">LAUNCH TOKEN · ROBINHOOD CHAIN</div>
          <button onClick={() => setChain(null)} className="font-mono text-[9px] text-slate-600 hover:text-slate-400">← chain</button>
        </div>

        <div className="flex items-center gap-2.5 mb-3">
          <div className="w-9 h-9 rounded-xl flex items-center justify-center font-mono text-sm font-bold shrink-0"
               style={{ background: "#22C55E15", border: "1px solid #22C55E30", color: "#22C55E" }}>
            {(cleanSymbol || cleanName).slice(0, 2).toUpperCase() || "RH"}
          </div>
          <div className="min-w-0">
            <div className="font-mono text-sm font-bold text-white truncate">{cleanName || "Your token name"}</div>
            <div className="font-mono text-[11px] text-slate-500">${cleanSymbol || "TICKER"}</div>
          </div>
        </div>

        <div className="space-y-2 mb-3">
          <LaunchField label="TOKEN NAME *"  value={name}        onChange={setName}        placeholder="e.g. Robinhood Games" />
          <div className="grid grid-cols-2 gap-2">
            <LaunchField label="TICKER"      value={symbol}      onChange={setSymbol}      placeholder="auto from name" />
            <LaunchField label="LOGO URL"    value={image}       onChange={setImage}       placeholder="https://…/logo.png" />
          </div>
          <LaunchField label="DESCRIPTION"   value={description}  onChange={setDescription} placeholder="One-line pitch (optional)" />
          <LaunchField label="WEBSITE"       value={website}      onChange={setWebsite}     placeholder="https://… (optional)" />
        </div>

        {/* Fee recipient — same as Base */}
        <div className="mb-3">
          <div className="font-mono text-[9px] text-slate-600 mb-1.5">FEE RECIPIENT · 95% creator share · optional</div>
          <div className="flex gap-1 mb-1.5 flex-wrap">
            {FEE_TYPES.map(t => {
              const active = feeType === t.id;
              return (
                <button key={t.id}
                  onClick={() => { setFeeType(t.id); setFeeValue(t.id === "wallet" && address ? address : ""); }}
                  className="font-mono text-[10px] px-2 py-1 rounded-md transition-colors"
                  style={active
                    ? { background: "#22C55E15", color: "#22C55E", border: "1px solid #22C55E40" }
                    : { color: "#64748b", border: "1px solid #1A1A2E" }}>
                  {t.label}
                </button>
              );
            })}
          </div>
          <LaunchField label="" value={feeValue} onChange={setFeeValue}
            placeholder={feeType === "wallet" ? "0x… — or blank → @blueagent_" : `@handle — or blank → @blueagent_`} />
        </div>

        {step === "error" && <p className="font-mono text-[10px] text-amber-400 mb-2">{err}</p>}

        <button
          onClick={launch}
          disabled={step === "launching" || !cleanName}
          className="w-full font-mono text-[12px] font-bold py-2.5 rounded-xl disabled:opacity-40 transition-opacity"
          style={{ background: "#22C55E15", color: "#22C55E", border: "1px solid #22C55E40" }}>
          {step === "launching" ? "Launching…" : `🚀 Launch $${cleanSymbol || "TOKEN"} on Robinhood Chain`}
        </button>
        <p className="font-mono text-[9px] text-slate-600 mt-1.5 text-center">
          Deploys via <span className="text-[#22C55E]">Bankr</span> on Robinhood Chain (4663) · auto Uniswap pool · 0.7% swap fee, 95% → creator (recurring). Bankr handles gas + wallet.
        </p>
      </div>
    );
  }

  // ── Step 1: Base (Bankr) form ────────────────────────────────────────────
  return (
    <div className="mt-2 rounded-xl border border-[#1A1A2E] bg-[#0a0a0f] p-3.5">
      <div className="flex items-center justify-between mb-3">
        <div className="font-mono text-[10px] text-slate-500 tracking-widest font-bold">LAUNCH TOKEN · BASE</div>
        <button onClick={() => setChain(null)} className="font-mono text-[9px] text-slate-600 hover:text-slate-400">← chain</button>
      </div>

      {/* Live preview of the name/ticker as typed */}
      <div className="flex items-center gap-2.5 mb-3">
        <div className="w-9 h-9 rounded-xl flex items-center justify-center font-mono text-sm font-bold shrink-0"
             style={{ background: "#4FC3F715", border: "1px solid #4FC3F730", color: "#4FC3F7" }}>
          {(cleanSymbol || cleanName).slice(0, 2).toUpperCase() || "?"}
        </div>
        <div className="min-w-0">
          <div className="font-mono text-sm font-bold text-white truncate">{cleanName || "Your token name"}</div>
          <div className="font-mono text-[11px] text-slate-500">${cleanSymbol || "TICKER"}</div>
        </div>
      </div>

      {/* Editable token fields — the card is the form */}
      <div className="space-y-2 mb-3">
        <LaunchField label="TOKEN NAME *"  value={name}        onChange={setName}        placeholder="e.g. Blue Agent" />
        <div className="grid grid-cols-2 gap-2">
          <LaunchField label="TICKER"      value={symbol}      onChange={setSymbol}      placeholder="auto from name" />
          <LaunchField label="LOGO URL"    value={image}       onChange={setImage}       placeholder="https://…/logo.png" />
        </div>
        <LaunchField label="DESCRIPTION"   value={description}  onChange={setDescription} placeholder="One-line pitch (optional)" />
        <LaunchField label="WEBSITE"       value={website}      onChange={setWebsite}     placeholder="https://… (optional)" />
      </div>


      {/* Fee recipient — optional; blank = BlueAgent */}
      <div className="mb-3">
        <div className="font-mono text-[9px] text-slate-600 mb-1.5">FEE RECIPIENT · 57% creator share · optional</div>
        <div className="flex gap-1 mb-1.5 flex-wrap">
          {FEE_TYPES.map(t => {
            const active = feeType === t.id;
            return (
              <button key={t.id}
                onClick={() => { setFeeType(t.id); setFeeValue(t.id === "wallet" && address ? address : ""); }}
                className="font-mono text-[10px] px-2 py-1 rounded-md transition-colors"
                style={active
                  ? { background: "#4FC3F715", color: "#4FC3F7", border: "1px solid #4FC3F730" }
                  : { color: "#64748b", border: "1px solid #1A1A2E" }}>
                {t.label}
              </button>
            );
          })}
        </div>
        <input
          value={feeValue}
          onChange={e => setFeeValue(e.target.value)}
          placeholder={feeType === "wallet"
            ? (address ? `${truncAddr(address)} — or leave blank → @blueagent_` : "0x… — or leave blank → @blueagent_")
            : `${FEE_TYPES.find(t => t.id === feeType)?.placeholder ?? ""} — or leave blank → @blueagent_`}
          className="w-full bg-[#050508] border border-[#1A1A2E] focus:border-[#4FC3F7]/40 rounded-lg px-2.5 py-1.5 font-mono text-[11px] text-slate-200 placeholder:text-slate-700 outline-none transition-colors"
        />
      </div>

      <p className="font-mono text-[9px] text-slate-600 mb-2 leading-relaxed">
        Fees → <span className="text-slate-400">{feeEntered ? (resolvedFeeType === "wallet" ? truncAddr(resolvedFeeValue) : `${resolvedFeeType}:${feeValue.trim()}`) : "@blueagent_ (default)"}</span>. This deploys a
        <span className="text-amber-400"> real, irreversible</span> token on Base via Bankr.
      </p>
      {step === "error" && <p className="font-mono text-[10px] text-amber-400 mb-2">{err}</p>}
      <button
        onClick={launch}
        disabled={step === "launching" || !cleanName}
        className="w-full font-mono text-[12px] font-bold py-2 rounded-lg transition-all disabled:opacity-50"
        style={{ background: "#F59E0B15", color: "#F59E0B", border: "1px solid #F59E0B40" }}>
        {step === "launching" ? "Launching…" : `🚀 Launch $${cleanSymbol || "TOKEN"} on Base`}
      </button>
      <p className="font-mono text-[9px] text-slate-700 mt-1.5">
        {cleanName ? "Bankr allows 1 real launch/min per wallet." : "Enter a token name to launch."}
      </p>
    </div>
  );
}

// ── B20 Launch Card ──────────────────────────────────────────────────────────
// Rendered for hub_b20_launch marker. Pre-fills from LLM args, user edits,
// then [Generate Scripts] produces foundry.toml + deploy script + CLI commands
// with per-network tabs. Fully client-side — no API call, no funds moved.

interface B20LaunchResult {
  name?: string;
  symbol?: string;
  variant?: "asset" | "stablecoin";
  decimals?: number;
  supply_cap?: string;
  currency_code?: string;
}

const B20_NETWORKS = [
  { id: "sepolia", label: "Sepolia", rpc: "https://sepolia.base.org",      chain: 84532    },
  { id: "vibenet", label: "Vibenet", rpc: "https://rpc.vibes.base.org/",   chain: 84538453 },
  { id: "mainnet", label: "Mainnet", rpc: "https://mainnet.base.org",       chain: 8453     },
] as const;
type B20Net = typeof B20_NETWORKS[number]["id"];

function B20Block({ title, code }: { title: string; code: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard?.writeText(code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  }
  return (
    <div className="rounded-xl border border-[#1A1A2E] bg-[#070710] overflow-hidden mb-3">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-[#1A1A2E]">
        <span className="font-mono text-[9px] text-slate-500 tracking-widest">{title}</span>
        <button onClick={copy} className="font-mono text-[9px] px-2 py-0.5 rounded border border-[#1A1A2E] text-slate-400 hover:text-white hover:border-[#4FC3F7]/30 transition-colors">
          {copied ? "Copied ✓" : "Copy"}
        </button>
      </div>
      <pre className="p-3 overflow-x-auto"><code className="font-mono text-[10px] text-slate-300 leading-relaxed whitespace-pre">{code}</code></pre>
    </div>
  );
}

function B20Field({ label, value, onChange, placeholder, disabled }: {
  label: string; value: string; onChange: (v: string) => void; placeholder: string; disabled?: boolean;
}) {
  return (
    <label className="block">
      <span className="font-mono text-[9px] text-slate-600 block mb-1">{label}</span>
      <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} disabled={disabled}
        className="w-full bg-[#050508] border border-[#1A1A2E] focus:border-[#4FC3F7]/40 rounded-lg px-2.5 py-1.5 font-mono text-[11px] text-slate-200 placeholder:text-slate-700 outline-none transition-colors disabled:opacity-40 disabled:cursor-not-allowed" />
    </label>
  );
}

function B20LaunchCard({ result }: { result: B20LaunchResult }) {
  const initVariant = result.variant ?? "asset";
  const [name,          setName]          = useState(result.name ?? "");
  const [symbol,        setSymbol]        = useState((result.symbol ?? "").toUpperCase());
  const [variant,       setVariant]       = useState<"asset" | "stablecoin">(initVariant);
  const [decimals,      setDecimals]      = useState<number>(result.decimals ?? (initVariant === "stablecoin" ? 6 : 18));
  const [decOverridden, setDecOverridden] = useState(!!result.decimals);
  const [supplyCap,     setSupplyCap]     = useState(result.supply_cap ?? "");
  const [currCode,      setCurrCode]      = useState((result.currency_code ?? "").toUpperCase());
  const [generated,     setGenerated]     = useState(false);
  const [network,       setNetwork]       = useState<B20Net>("sepolia");
  const [cmdCopied,     setCmdCopied]     = useState(false);

  // Deploy flow
  const { address, chainId: currentChainId } = useAccount();
  const { sendTransactionAsync }              = useSendTransaction();
  const { switchChainAsync }                  = useSwitchChain();
  const [deploying,      setDeploying]      = useState(false);
  const [polling,        setPolling]        = useState(false);
  const [deployErr,      setDeployErr]      = useState("");
  const [deployTxHash,   setDeployTxHash]   = useState("");
  const [deployedToken,  setDeployedToken]  = useState("");

  function switchVariant(v: "asset" | "stablecoin") {
    setVariant(v);
    if (!decOverridden) setDecimals(v === "stablecoin" ? 6 : 18);
  }

  const n      = name.trim();
  const s      = symbol.replace(/^\$/, "").trim();
  const cap    = supplyCap.trim();
  const cur    = currCode.trim() || "USD";
  const net    = B20_NETWORKS.find(x => x.id === network)!;
  const canGen = !!n && !!s;

  async function deployB20() {
    if (!address) { setDeployErr("Connect your wallet first"); return; }
    if (!n || !s) { setDeployErr("Name and symbol required"); return; }
    setDeploying(true); setDeployErr(""); setDeployTxHash(""); setDeployedToken("");
    try {
      const prepRes = await fetch("/api/b20/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: n, symbol: s, variant, decimals,
          supply_cap:    cap || undefined,
          currency_code: variant === "stablecoin" ? cur : undefined,
          admin:         address,
          network,
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

      // Auto-switch to target chain if needed
      const targetChainId = network === "mainnet" ? 8453 : 84532;
      if (currentChainId !== targetChainId) {
        try {
          await switchChainAsync({ chainId: targetChainId });
        } catch {
          throw new Error(
            `Switch your wallet to Base ${network === "mainnet" ? "Mainnet" : "Sepolia"} and try again`,
          );
        }
      }

      const hash = await sendTransactionAsync({
        to:      prep.tx.to as `0x${string}`,
        data:    prep.tx.data as `0x${string}`,
        value:   0n,
        chainId: targetChainId,
      });
      setDeployTxHash(hash);
      setPolling(true);

      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 3000));
        const recRes = await fetch("/api/b20/receipt", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tx_hash: hash, network }),
        });
        const rec = await recRes.json();
        if (rec.ok && rec.status === "success" && rec.tokenAddress) {
          setDeployedToken(rec.tokenAddress);
          break;
        }
        if (rec.ok && rec.status === "reverted") {
          throw new Error("Transaction reverted");
        }
      }
      setPolling(false);
    } catch (e) {
      setDeployErr((e as Error).message);
    } finally {
      setDeploying(false);
      setPolling(false);
    }
  }

  // ── Script bodies ─────────────────────────────────────────────────────────

  const foundryToml = `[profile.default]
src = "src"
out = "out"
libs = ["lib"]
base = true
remappings = [
  "base-std/=lib/base-std/src/",
  "forge-std/=lib/forge-std/src/",
]`;

  const hasCap    = !!cap;
  const nCalls    = hasCap ? 2 : 1;
  const encParams = variant === "asset"
    ? `B20FactoryLib.encodeAssetCreateParams(\n      "${n}", "${s}", account, ${decimals}\n    )`
    : `B20FactoryLib.encodeStablecoinCreateParams(\n      "${n}", "${s}", "${cur}", ${decimals}\n    )`;
  const b20Type   = variant === "asset" ? "IB20Factory.B20Variant.ASSET" : "IB20Factory.B20Variant.STABLECOIN";
  const capLine   = hasCap ? `\n    initCalls[1] = B20FactoryLib.encodeUpdateSupplyCap(${cap}e${decimals});` : "";

  const deployScript = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import {Script, console} from "forge-std/Script.sol";
import {B20Constants} from "base-std/lib/B20Constants.sol";
import {B20FactoryLib} from "base-std/lib/B20FactoryLib.sol";
import {IB20Factory} from "base-std/interfaces/IB20Factory.sol";
import {StdPrecompiles} from "base-std/StdPrecompiles.sol";

contract CreateToken is Script {
  function run() external returns (address token) {
    address account = vm.envAddress("ACCOUNT_ADDRESS");
    bytes32 salt = keccak256("${s}-deploy");
    bytes memory params = ${encParams};
    bytes[] memory initCalls = new bytes[](${nCalls});
    initCalls[0] = B20FactoryLib.encodeGrantRole(B20Constants.MINT_ROLE, account);${capLine}
    vm.startBroadcast();
    token = StdPrecompiles.B20_FACTORY.createB20(
      ${b20Type}, salt, params, initCalls
    );
    vm.stopBroadcast();
    console.log("${n} deployed at:", token);
  }
}`;

  const capWei = hasCap ? `${cap}${"0".repeat(decimals)}` : `1000000${"0".repeat(decimals)}`;
  const commands = `# Install
curl -L https://raw.githubusercontent.com/base/base-anvil/HEAD/foundryup/install | bash
base-foundryup --install v1.1.0

# Setup
mkdir ${s.toLowerCase() || "my"}-b20 && cd ${s.toLowerCase() || "my"}-b20
base-forge init . --force
base-forge install base/base-std --no-git

# Deploy
export RPC_URL="${net.rpc}"
source .env
base-forge script script/CreateToken.s.sol \\
  --rpc-url $RPC_URL --private-key $PRIVATE_KEY --broadcast

# Mint (replace $TOKEN_ADDRESS with deployed address)
base-cast send $TOKEN_ADDRESS "mint(address,uint256)" \\
  $ACCOUNT_ADDRESS ${capWei} \\
  --rpc-url $RPC_URL --private-key $PRIVATE_KEY

# Verify
base-cast call $TOKEN_ADDRESS \\
  "balanceOf(address)(uint256)" $ACCOUNT_ADDRESS \\
  --rpc-url $RPC_URL`;

  return (
    <div className="mt-2 rounded-xl border border-[#1A1A2E] bg-[#0a0a0f] p-3.5">
      <div className="font-mono text-[10px] text-slate-500 tracking-widest font-bold mb-3">B20 TOKEN · BASE</div>

      {/* Preview pill */}
      <div className="flex items-center gap-2.5 mb-3">
        <div className="w-9 h-9 rounded-xl flex items-center justify-center font-mono text-sm font-bold shrink-0"
             style={{ background: "#4FC3F715", border: "1px solid #4FC3F730", color: "#4FC3F7" }}>
          {(s || n).slice(0, 2).toUpperCase() || "B2"}
        </div>
        <div className="min-w-0">
          <div className="font-mono text-sm font-bold text-white truncate">{n || "Token Name"}</div>
          <div className="font-mono text-[11px] text-slate-500">${s || "SYMBOL"} · {variant} · B20</div>
        </div>
      </div>

      {/* Form */}
      <div className="space-y-2 mb-3">
        <div className="grid grid-cols-2 gap-2">
          <B20Field label="TOKEN NAME *" value={name} onChange={setName} placeholder="e.g. Base Dollar" />
          <B20Field label="SYMBOL *" value={symbol} onChange={v => setSymbol(v.toUpperCase())} placeholder="e.g. BUSD" />
        </div>

        {/* Variant toggle */}
        <div>
          <span className="font-mono text-[9px] text-slate-600 block mb-1">VARIANT</span>
          <div className="flex gap-1">
            {(["asset", "stablecoin"] as const).map(v => (
              <button key={v} onClick={() => switchVariant(v)}
                className="font-mono text-[10px] px-3 py-1 rounded-md transition-colors capitalize"
                style={variant === v
                  ? { background: "#4FC3F715", color: "#4FC3F7", border: "1px solid #4FC3F730" }
                  : { color: "#64748b", border: "1px solid #1A1A2E" }}>
                {v}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="font-mono text-[9px] text-slate-600 block mb-1">
              DECIMALS <span className="text-slate-700">(6–18)</span>
            </span>
            <input
              type="number" min={6} max={18} value={decimals}
              disabled={variant === "stablecoin"}
              onChange={e => { setDecOverridden(true); setDecimals(Number(e.target.value)); }}
              className="w-full bg-[#050508] border border-[#1A1A2E] focus:border-[#4FC3F7]/40 rounded-lg px-2.5 py-1.5 font-mono text-[11px] text-slate-200 outline-none transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            />
          </label>
          <B20Field label="SUPPLY CAP (optional)" value={supplyCap} onChange={setSupplyCap} placeholder="e.g. 1000000" />
        </div>

        {variant === "stablecoin" && (
          <B20Field label="CURRENCY CODE" value={currCode} onChange={v => setCurrCode(v.toUpperCase())} placeholder="e.g. USD" />
        )}
      </div>

      <button
        onClick={() => setGenerated(true)}
        disabled={!canGen}
        className="w-full font-mono text-[12px] font-bold py-2 rounded-lg transition-all disabled:opacity-40 mb-3"
        style={{ background: "#4FC3F715", color: "#4FC3F7", border: "1px solid #4FC3F730" }}>
        Generate Scripts →
      </button>

      {generated && (
        <>
          <B20Block title="foundry.toml" code={foundryToml} />
          <B20Block title="script/CreateToken.s.sol" code={deployScript} />

          {/* Commands with network tabs */}
          <div className="rounded-xl border border-[#1A1A2E] bg-[#070710] overflow-hidden">
            <div className="flex items-center justify-between px-3 py-1.5 border-b border-[#1A1A2E]">
              <div className="flex gap-1">
                {B20_NETWORKS.map(nx => (
                  <button key={nx.id} onClick={() => setNetwork(nx.id)}
                    className="font-mono text-[9px] px-2 py-0.5 rounded transition-colors"
                    style={network === nx.id
                      ? { background: "#4FC3F715", color: "#4FC3F7", border: "1px solid #4FC3F730" }
                      : { color: "#64748b", border: "1px solid transparent" }}>
                    {nx.label}
                  </button>
                ))}
              </div>
              <button
                onClick={() => { navigator.clipboard?.writeText(commands); setCmdCopied(true); setTimeout(() => setCmdCopied(false), 1500); }}
                className="font-mono text-[9px] px-2 py-0.5 rounded border border-[#1A1A2E] text-slate-400 hover:text-white hover:border-[#4FC3F7]/30 transition-colors">
                {cmdCopied ? "Copied ✓" : "Copy"}
              </button>
            </div>
            <pre className="p-3 overflow-x-auto"><code className="font-mono text-[10px] text-slate-300 leading-relaxed whitespace-pre">{commands}</code></pre>
          </div>
          <p className="font-mono text-[9px] text-slate-700 mt-2">
            Chain {net.chain} · {net.rpc}
          </p>
        </>
      )}

      {/* ── Direct deploy section ────────────────────────────────────────── */}
      <div className="mt-3 pt-3 border-t border-[#1A1A2E]">
        {!deployedToken ? (
          <>
            <button
              onClick={deployB20}
              disabled={deploying || !canGen || !address || network === "vibenet"}
              className="w-full font-mono text-[12px] font-bold py-2.5 rounded-xl disabled:opacity-40 transition-opacity"
              style={{ background: "#34D399", color: "#050508" }}>
              {!address
                ? "Connect wallet to deploy"
                : deploying
                  ? (polling ? "Confirming onchain…" : "Preparing…")
                  : network === "vibenet"
                    ? "Vibenet — script-only"
                    : `Deploy B20 on ${net.label} →`}
            </button>

            {network === "mainnet" && (
              <p className="font-mono text-[9px] text-amber-500/70 mt-1.5 text-center">
                ⚠ Mainnet Beryl activates June 25, 2026 18:00 UTC
              </p>
            )}
            {network === "sepolia" && (
              <p className="font-mono text-[9px] text-slate-600 mt-1.5 text-center">
                Sepolia testnet · live now.{" "}
                <a href="https://portal.cdp.coinbase.com/products/faucet"
                  target="_blank" rel="noopener noreferrer"
                  className="text-[#4FC3F7] hover:opacity-80">
                  Get free test ETH →
                </a>
              </p>
            )}
            {network === "vibenet" && (
              <p className="font-mono text-[9px] text-slate-600 mt-1.5 text-center">
                Vibenet — script-only. Use Sepolia or Mainnet to deploy from here.
              </p>
            )}

            {deployErr && (
              <p className="font-mono text-[9px] text-red-400 mt-1.5 text-center">{deployErr}</p>
            )}
            {deployTxHash && !deployedToken && (
              <p className="font-mono text-[9px] text-slate-500 mt-1.5 text-center break-all">
                tx: {deployTxHash.slice(0, 10)}…{deployTxHash.slice(-8)}
              </p>
            )}
          </>
        ) : (
          <div className="rounded-xl border border-[#34D399]/30 bg-[#34D399]/5 p-3">
            <p className="font-mono text-[10px] text-[#34D399] mb-1">✓ B20 deployed</p>
            <p className="font-mono text-[11px] text-white break-all mb-2">{deployedToken}</p>
            <div className="flex gap-2 flex-wrap">
              <a
                href={`${net.chain === 8453 ? "https://basescan.org" : "https://sepolia.basescan.org"}/token/${deployedToken}`}
                target="_blank" rel="noopener noreferrer"
                className="font-mono text-[9px] px-2 py-1 rounded border border-[#1A1A2E] text-[#4FC3F7] hover:border-[#4FC3F7]/30 transition-colors">
                View on Basescan →
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Rendered for the `prepare_yield` marker. NON-custodial move-to-yield: the user
// signs supply/withdraw on the chosen venue (Aave v3 or Morpho) from their OWN
// wallet via wagmi. Verified addresses (see lib/yield-execution). Best-rate
// router: pick a venue, the card builds the right protocol calls.
// ── B20 Manage (reuses ManagePanel: full mint/burn/pause/policy/role/cap) ──────
// check_memo result — server-read of the B20 Memo(address,bytes32) event on a tx.
// Inline, read-only card (no signing): shows the decoded memo + caller + tx link.
interface MemoResultData {
  found?:   boolean;
  memo?:    string;
  caller?:  string | null;
  txHash?:  string;
  network?: string;
  txUrl?:   string;
  status?:  "found" | "no_memo" | "pending" | "invalid";
}

function MemoResultCard({ result }: { result: MemoResultData }) {
  const found  = !!result.found;
  const status = result.status ?? (found ? "found" : "no_memo");
  const caller = (result.caller ?? "").trim();
  const txUrl  = result.txUrl;

  const label =
    status === "invalid" ? "Invalid transaction hash"
    : status === "pending" ? "Transaction not found or not yet mined"
    : !found ? "No memo found in this transaction"
    : null;

  return (
    <div className="mt-2 rounded-xl border border-[#1A1A2E] bg-[#0a0a0f] px-3.5 py-3">
      {found ? (
        <>
          <div className="flex items-center gap-2">
            <span className="text-base leading-none">🔖</span>
            <span className="font-mono text-[10px] text-slate-500 tracking-widest font-bold">MEMO</span>
            <span className="font-mono text-[13px] text-[#4FC3F7] break-all">{result.memo}</span>
          </div>
          {caller && (
            <div className="font-mono text-[11px] text-slate-500 mt-1.5">
              Caller {caller.slice(0, 6)}…{caller.slice(-4)}
            </div>
          )}
          {txUrl && (
            <a
              href={txUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block font-mono text-[11px] text-slate-400 hover:text-[#4FC3F7] mt-1.5"
            >
              View tx ↗
            </a>
          )}
        </>
      ) : (
        <div className="flex items-center gap-2">
          <span className="text-base leading-none">{status === "invalid" ? "⚠️" : "∅"}</span>
          <span className="font-mono text-xs text-slate-400">{label}</span>
          {txUrl && status !== "invalid" && (
            <a
              href={txUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-[11px] text-slate-500 hover:text-[#4FC3F7]"
            >
              tx ↗
            </a>
          )}
        </div>
      )}
    </div>
  );
}

// check_authorization result — server-read of a B20 token's policy: is `account`
// allowed for a scope (sender/receiver/executor/mint_receiver)? Inline, read-only.
interface AuthorizationResultData {
  authorized?:           boolean | null;
  token?:                string;
  account?:              string;
  accountInput?:         string;
  resolvedFromBasename?: boolean;
  scope?:                string;
  scopeLabel?:           string;
  policyId?:             string;
  policyKind?:           "open" | "blocked" | "custom" | "unknown";
  network?:              string;
  status?:               string;
  message?:              string;
  explorerUrl?:          string;
}

function AuthorizationResultCard({ result }: { result: AuthorizationResultData }) {
  const determined = result.status === "authorized" || result.status === "denied";
  const allowed    = result.authorized === true;
  const accent     = !determined ? "#64748b" : allowed ? "#22C55E" : "#EF4444";
  const icon       = !determined ? "ℹ" : allowed ? "✓" : "✗";
  const acct       = (result.account ?? "").trim();
  const acctShort  = /^0x[a-fA-F0-9]{40}$/.test(acct) ? `${acct.slice(0, 6)}…${acct.slice(-4)}` : acct;
  const headline   = !determined
    ? "Authorization unknown"
    : allowed ? "Authorized" : "Not authorized";

  return (
    <div className="mt-2 rounded-xl border bg-[#0a0a0f] px-3.5 py-3"
      style={{ borderColor: `${accent}35` }}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-mono text-sm font-bold shrink-0" style={{ color: accent }}>{icon}</span>
        <span className="font-mono text-[13px] font-bold" style={{ color: accent }}>{headline}</span>
        {result.scopeLabel && (
          <span className="font-mono text-[10px] px-1.5 py-0.5 rounded-full border text-slate-400 border-[#1A1A2E]">
            {result.scopeLabel}
          </span>
        )}
        {result.policyKind && result.policyKind !== "unknown" && (
          <span className="font-mono text-[10px] text-slate-500">
            {result.policyKind === "open" ? "ALWAYS_ALLOW"
              : result.policyKind === "blocked" ? "ALWAYS_BLOCK"
              : `policy #${result.policyId ?? "?"}`}
          </span>
        )}
      </div>
      {acctShort && (
        <div className="font-mono text-[11px] text-slate-400 mt-1.5 break-all">
          {acctShort}
          {result.resolvedFromBasename && result.accountInput && (
            <span className="text-slate-600"> · {result.accountInput}</span>
          )}
        </div>
      )}
      {result.message && (
        <p className="font-mono text-[11px] text-slate-500 leading-relaxed mt-1.5">{result.message}</p>
      )}
      {result.explorerUrl && result.status !== "invalid_token" && (
        <a href={result.explorerUrl} target="_blank" rel="noopener noreferrer"
          className="inline-block font-mono text-[11px] text-slate-400 hover:text-[#4FC3F7] mt-1.5">
          Token on Basescan ↗
        </a>
      )}
    </div>
  );
}

// Read-only wallet balance — connected wallet's live ETH + major token amounts
// on Base. No signing, no price feed (honest: raw on-chain amounts only).
interface WalletHoldingView {
  symbol:    string;
  name?:     string;
  address:   string;
  amount:    string;
  raw:       string;
  decimals?: number;
  isNative?: boolean;
  isB20?:    boolean;
  usdValue?: number;
  logo?:     string;
}
interface WalletResultData {
  connected?:  boolean;
  address?:    string;
  network?:    "mainnet" | "sepolia";
  explorer?:   string;
  addressUrl?: string;
  source?:     "moralis" | "rpc";
  partial?:    boolean;
  holdings?:   WalletHoldingView[];
  /** Robinhood Chain holdings — added by the check_wallet handler (Blockscout). */
  robinhoodHoldings?: WalletHoldingView[];
  error?:      string;
}

function fmtUsdSmall(n?: number): string | null {
  if (n == null || !Number.isFinite(n) || n <= 0) return null;
  if (n >= 1000) return "$" + (n / 1000).toFixed(1) + "K";
  if (n >= 1)    return "$" + n.toFixed(2);
  return "$" + n.toFixed(4);
}

// Connected-wallet portfolio card (check_wallet). Lists tokens held (balance > 0)
// on BOTH Base (Moralis) AND Robinhood Chain (Blockscout). Small-dust filter:
// tokens with usdValue < $1 are hidden by default — user can toggle "show all"
// to see the long tail (airdrop dust, illiquid tokens, unknown-price tokens).
// Honest: only real holdings, never fabricates. B20 tokens badged + linked.
const DUST_USD_THRESHOLD = 1;

/**
 * Keep the row when EITHER:
 *  - it's the native chain currency (ETH — always relevant), OR
 *  - it has a known USD value >= threshold.
 * Tokens with unknown USD (rate missing) are dust-filtered too — the user's
 * screenshot showed those as the majority of noise (airdrops without indexed price).
 */
function isDust(h: WalletHoldingView): boolean {
  if (h.isNative) return false;
  if (typeof h.usdValue === "number" && h.usdValue >= DUST_USD_THRESHOLD) return false;
  return true;
}

function WalletCard({ result }: { result: WalletResultData }) {
  const { t } = useLang();
  const [showAll, setShowAll] = useState(false);
  const baseLabel = result.network === "mainnet" ? "Base Mainnet" : "Base Sepolia";
  const addr = (result.address ?? "").trim();

  if (result.connected === false) {
    return (
      <div className="mt-2 rounded-xl border border-[#1A1A2E] bg-[#0a0a0f] px-3.5 py-3">
        <div className="flex items-center gap-2">
          <span className="text-base leading-none">🔌</span>
          <span className="font-mono text-xs text-slate-400">{t("balance_card.connect_first")}</span>
        </div>
      </div>
    );
  }

  const baseHoldings = result.holdings ?? [];
  const rhHoldings   = result.robinhoodHoldings ?? [];
  const totalCount   = baseHoldings.length + rhHoldings.length;

  if (result.error && totalCount === 0) {
    return (
      <div className="mt-2 rounded-xl border border-[#EF444430] bg-[#0a0a0f] px-3.5 py-3">
        <div className="flex items-center gap-2">
          <span className="text-base leading-none">⚠️</span>
          <span className="font-mono text-xs text-[#EF4444]">{result.error}</span>
        </div>
      </div>
    );
  }

  // Apply dust filter unless user toggled off.
  const visibleBase = showAll ? baseHoldings : baseHoldings.filter(h => !isDust(h));
  const visibleRh   = showAll ? rhHoldings   : rhHoldings.filter(h => !isDust(h));
  const hiddenCount = (baseHoldings.length - visibleBase.length) + (rhHoldings.length - visibleRh.length);

  function renderHolding(h: WalletHoldingView, i: number) {
    const usd = fmtUsdSmall(h.usdValue);
    const sym = (
      <span className="font-mono text-[11px] text-slate-300 flex items-center gap-1">
        {h.symbol}
        {h.isB20 && (
          <span className="text-[9px] px-1 py-px rounded bg-[#4FC3F715] text-[#4FC3F7] border border-[#4FC3F730]">🟦 B20</span>
        )}
      </span>
    );
    return (
      <div key={`${h.address}-${i}`} className="flex items-center justify-between">
        {h.isB20 && h.address ? (
          <a href={`/app/b20?address=${h.address}`} className="hover:opacity-80">{sym}</a>
        ) : sym}
        <span className="font-mono text-[13px] text-slate-200 flex items-baseline gap-2">
          {usd && <span className="text-[9px] text-slate-600">{usd}</span>}
          {h.amount}
        </span>
      </div>
    );
  }

  return (
    <div className="mt-2 rounded-xl border border-[#1A1A2E] bg-[#0a0a0f] px-3.5 py-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-base leading-none">💰</span>
        {addr && (
          <span className="font-mono text-[11px] text-slate-400">{addr.slice(0, 6)}…{addr.slice(-4)}</span>
        )}
        {hiddenCount > 0 && (
          <button
            onClick={() => setShowAll(v => !v)}
            className="ml-auto font-mono text-[9px] text-slate-500 hover:text-slate-300 underline decoration-dotted underline-offset-2"
          >
            {showAll ? `Hide dust (<$${DUST_USD_THRESHOLD})` : `Show ${hiddenCount} more`}
          </button>
        )}
      </div>

      {/* Base chain leg */}
      <div className="flex items-center gap-1.5 mb-1">
        <span className="w-1.5 h-1.5 rounded-full bg-[#0052FF]" />
        <span className="font-mono text-[10px] text-slate-500">{baseLabel}</span>
        <span className="font-mono text-[9px] text-slate-700">· {baseHoldings.length} token{baseHoldings.length === 1 ? "" : "s"}</span>
      </div>
      {visibleBase.length === 0 ? (
        <div className="font-mono text-[10px] text-slate-600 py-0.5 mb-2">
          {baseHoldings.length === 0 ? `No tokens on ${baseLabel}.` : `All ${baseHoldings.length} token(s) filtered as dust.`}
        </div>
      ) : (
        <div className="space-y-1 mb-3">
          {visibleBase.map(renderHolding)}
        </div>
      )}

      {/* Robinhood Chain leg */}
      <div className="flex items-center gap-1.5 mb-1">
        <span className="w-1.5 h-1.5 rounded-full bg-[#34D399]" />
        <span className="font-mono text-[10px] text-slate-500">Robinhood Chain</span>
        <span className="font-mono text-[9px] text-slate-700">· {rhHoldings.length} token{rhHoldings.length === 1 ? "" : "s"}</span>
      </div>
      {visibleRh.length === 0 ? (
        <div className="font-mono text-[10px] text-slate-600 py-0.5">
          {rhHoldings.length === 0 ? "No tokens on Robinhood Chain." : `All ${rhHoldings.length} token(s) filtered as dust.`}
        </div>
      ) : (
        <div className="space-y-1">
          {visibleRh.map(renderHolding)}
        </div>
      )}

      {result.partial && (
        <p className="font-mono text-[9px] text-slate-600 mt-2">
          Showing major tokens only on Base — connect Moralis for the full portfolio.
        </p>
      )}
      {result.addressUrl && (
        <div className="flex items-center gap-3 mt-2">
          <a
            href={result.addressUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block font-mono text-[10px] text-slate-500 hover:text-[#4FC3F7]"
          >
            Base ↗
          </a>
          {addr && (
            <a
              href={`https://robinhoodchain.blockscout.com/address/${addr}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block font-mono text-[10px] text-slate-500 hover:text-[#34D399]"
            >
              Robinhood ↗
            </a>
          )}
        </div>
      )}
    </div>
  );
}

// Anti-pattern killer: chat "mint X" must open a wallet-signing panel, never
// emit cast / --private-key / Basescan-write text. Loads on-chain state + the
// connected wallet's roles, then renders the SAME role-gated ManagePanel as
// /app/b20 (compact mode). Every action is signed in the user's own wallet.
interface B20ManageResult { address?: string; network?: string; memo?: string }

function B20ManageCard({ result }: { result: B20ManageResult }) {
  const token = (result.address ?? "").trim();
  const network: "mainnet" | "sepolia" = result.network === "sepolia" ? "sepolia" : "mainnet";
  const validToken = /^0x[a-fA-F0-9]{40}$/.test(token);

  const { address } = useAccount();
  const [data,    setData]    = useState<ManageData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState("");

  const load = useCallback(() => {
    if (!validToken || !address) return;
    setLoading(true); setError("");
    runB20ManageLoad(token, address, network)
      .then((d) => setData(d))
      .catch((e) => setError((e as Error)?.message ?? "Load failed"))
      .finally(() => setLoading(false));
  }, [token, address, network, validToken]);

  useEffect(() => { load(); }, [load]);

  const netLabel = network === "mainnet" ? "BASE" : "SEPOLIA";

  return (
    <div className="mt-2 rounded-xl border border-[#1A1A2E] bg-[#0a0a0f] p-3.5">
      <div className="font-mono text-[10px] text-slate-500 tracking-widest font-bold mb-2">
        B20 MANAGE · {netLabel}
      </div>
      <div className="font-mono text-[11px] text-slate-400 mb-3 break-all">
        {validToken ? token : <span className="text-[#EF4444]">No token address provided</span>}
      </div>

      {/* Connect gate */}
      {validToken && !address && (
        <div className="rounded-xl border border-[#1A1A2E] bg-[#070710] px-4 py-5 text-center">
          <p className="font-mono text-xs text-slate-500 mb-3">Connect your wallet to manage this token</p>
          <div className="flex justify-center">
            <ConnectButton label="Connect Wallet" />
          </div>
        </div>
      )}

      {/* Loading */}
      {validToken && address && loading && (
        <div className="flex items-center gap-2 px-1 py-3">
          <span className="w-1.5 h-1.5 rounded-full bg-[#4FC3F7] animate-pulse shrink-0" />
          <span className="font-mono text-xs text-slate-500">Loading roles + on-chain state…</span>
        </div>
      )}

      {/* Error */}
      {validToken && address && error && !loading && (
        <div className="rounded-xl border border-[#EF444430] bg-[#EF444408] px-4 py-3">
          <p className="font-mono text-xs text-[#EF4444]">{error}</p>
          <button onClick={load} className="font-mono text-[10px] text-slate-500 hover:text-slate-300 mt-2 transition-colors">
            Retry
          </button>
        </div>
      )}

      {/* Not a B20 token */}
      {validToken && address && data && !loading && !data.inspect.isB20 && (
        <div className="rounded-xl border border-[#F59E0B30] bg-[#F59E0B08] px-4 py-3">
          <p className="font-mono text-xs text-[#F59E0B]">
            Not a B20 token on {network}. Check the address or switch network.
          </p>
        </div>
      )}

      {/* Role-gated manage panel — wallet-signed. compact=true → mint/burn/pause in chat;
          policy/role/cap/metadata live in the full /app/b20 Manage tab. */}
      {validToken && address && data && !loading && data.inspect.isB20 && (
        <ManagePanel
          token={token}
          network={network}
          inspect={data.inspect}
          roles={data.roles}
          scopeHashes={data.scopeHashes}
          balance={data.balance}
          onRefresh={load}
          compact={true}
          initialMemo={result.memo}
        />
      )}
    </div>
  );
}

interface YieldMoveResult { action?: string; amount?: number | string; network?: string }

export function MoveToYieldCard({ result, account }: { result: YieldMoveResult; account?: `0x${string}` }) {
  // `account` is the connected wallet, passed in by the host (chat dispatcher
  // reads it from useChat; the /app/bank dashboard reads it from useAccount) so
  // the card works both inside and outside the chat. wagmi hooks below still
  // drive the actual signing.
  const address = account;
  const isConnected = !!account;
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();

  const [venue,   setVenue]   = useState<VenueId>("aave");
  const [action,  setAction]  = useState<"supply" | "withdraw">(result.action === "withdraw" ? "withdraw" : "supply");
  const [network, setNetwork] = useState<YieldNetwork>(result.network === "base" ? "base" : "baseSepolia");
  const [amount,  setAmount]  = useState<string>(
    result.amount != null && (typeof result.amount === "number" || typeof result.amount === "string") ? String(result.amount) : "");
  const [all,  setAll]  = useState(false);
  const [step, setStep] = useState<"idle" | "switching" | "approving" | "supplying" | "withdrawing" | "done" | "error">("idle");
  const [err,  setErr]  = useState("");
  const [txHash, setTxHash] = useState<string>("");

  // #4 Best-rate routing — live curated USDC lending APYs across Base venues from
  // DefiLlama. Drives both the comparison panel and the per-venue APY display.
  type Rate = { project: string; label: string; apy: number; executable: boolean };
  const [rates, setRates] = useState<Rate[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/yield/rates")
      .then(r => r.json())
      .then(d => { if (!cancelled) setRates((d?.rates as Rate[]) ?? []); })
      .catch(() => { if (!cancelled) setRates([]); });
    return () => { cancelled = true; };
  }, []);

  const net = YIELD_NETWORKS[network];
  const chainId = net.chainId;
  const vcfg = VENUES[venue];
  const vnet = vcfg.nets[network];            // venue addresses on this network (or undefined)
  const isAave = vcfg.protocol === "aave";
  const publicClient = usePublicClient({ chainId });

  // Picking a venue not on the current network auto-switches the network.
  function pickVenue(v: VenueId) {
    setVenue(v); setStep("idle"); setErr("");
    if (!VENUES[v].nets[network]) setNetwork(Object.keys(VENUES[v].nets)[0] as YieldNetwork);
  }
  // Switching to a network the venue doesn't support falls back to Aave.
  useEffect(() => { if (!VENUES[venue].nets[network]) setVenue("aave"); }, [network, venue]);

  // #1 Position — Aave: aToken.balanceOf (rebases). Morpho: vault.maxWithdraw
  // (USDC-equivalent of your shares). Both in USDC units for display.
  const { data: aaveBal, refetch: refetchAave } = useReadContract({
    address: vnet?.receipt, abi: ERC20_ABI, functionName: "balanceOf",
    args: address ? [address] : undefined, chainId,
    query: { enabled: !!address && isAave && !!vnet },
  });
  const { data: reserve } = useReadContract({
    address: vnet?.target, abi: AAVE_POOL_ABI, functionName: "getReserveData",
    args: vnet ? [vnet.usdc] : undefined, chainId,
    query: { enabled: isAave && !!vnet },
  });
  const { data: morphoMaxW, refetch: refetchMorpho } = useReadContract({
    address: vnet?.target, abi: ERC4626_ABI, functionName: "maxWithdraw",
    args: address ? [address] : undefined, chainId,
    query: { enabled: !!address && !isAave && !!vnet },
  });
  const { data: morphoShares } = useReadContract({
    address: vnet?.receipt, abi: ERC20_ABI, functionName: "balanceOf",
    args: address ? [address] : undefined, chainId,
    query: { enabled: !!address && !isAave && !!vnet },
  });

  const position = isAave
    ? (aaveBal != null ? Number(formatUnits(aaveBal as bigint, 6)) : null)
    : (morphoMaxW != null ? Number(formatUnits(morphoMaxW as bigint, 6)) : null);
  const venueRate = rates?.find(r => r.project === vcfg.llamaProject)?.apy ?? null;
  const apy = isAave && reserve
    ? supplyApyPct((reserve as { currentLiquidityRate: bigint }).currentLiquidityRate)
    : venueRate;
  const refetchPos = () => { refetchAave?.(); refetchMorpho?.(); };

  // Basename identity + spendable wallet USDC (balance-aware supply, Tier 1 #3).
  const { name: fromName } = useBasename(address);
  const { data: walletUsdcRaw } = useReadContract({
    address: vnet?.usdc, abi: ERC20_ABI, functionName: "balanceOf",
    args: address ? [address] : undefined, chainId,
    query: { enabled: !!address && !!vnet },
  });
  const walletUsdc = walletUsdcRaw != null ? Number(formatUnits(walletUsdcRaw as bigint, vnet?.usdcDecimals ?? 6)) : null;
  const maxFor = action === "supply" ? walletUsdc : position; // supply caps at wallet, withdraw at position
  function setMax() { if (maxFor != null) setAmount(String(maxFor)); }

  const amt = parseFloat(amount);
  const withdrawAll = action === "withdraw" && all;
  const overMax = !withdrawAll && maxFor != null && amt > maxFor;
  const valid = !!vnet && (withdrawAll || (amt > 0 && !overMax));
  const busy = step === "switching" || step === "approving" || step === "supplying" || step === "withdrawing";

  async function run() {
    if (!address) { setErr("Connect your wallet first"); setStep("error"); return; }
    if (!vnet)    { setErr(`${vcfg.short} isn't available on ${net.short}`); setStep("error"); return; }
    if (!valid)   { setErr("Enter an amount"); setStep("error"); return; }
    setErr(""); setTxHash("");
    try {
      setStep("switching");
      await switchChainAsync({ chainId });
      const value = withdrawAll ? WITHDRAW_ALL : parseUsdc(amt, network);

      if (action === "supply") {
        setStep("approving");
        const approveHash = await writeContractAsync({
          address: vnet.usdc, abi: ERC20_ABI, functionName: "approve",
          args: [vnet.spender, value], chainId,
        });
        await publicClient?.waitForTransactionReceipt({ hash: approveHash });
        setStep("supplying");
        const supplyHash = isAave
          ? await writeContractAsync({ address: vnet.target, abi: AAVE_POOL_ABI, functionName: "supply",  args: [vnet.usdc, value, address, 0], chainId })
          : await writeContractAsync({ address: vnet.target, abi: ERC4626_ABI,   functionName: "deposit", args: [value, address], chainId });
        setTxHash(supplyHash); setStep("done");
      } else {
        setStep("withdrawing");
        let wHash: `0x${string}`;
        if (isAave) {
          wHash = await writeContractAsync({ address: vnet.target, abi: AAVE_POOL_ABI, functionName: "withdraw", args: [vnet.usdc, value, address], chainId });
        } else if (withdrawAll) {
          // ERC-4626 has no "max" sentinel — redeem the full share balance.
          const shares = (morphoShares as bigint | undefined) ?? 0n;
          if (shares === 0n) throw new Error("No position to withdraw");
          wHash = await writeContractAsync({ address: vnet.target, abi: ERC4626_ABI, functionName: "redeem", args: [shares, address, address], chainId });
        } else {
          wHash = await writeContractAsync({ address: vnet.target, abi: ERC4626_ABI, functionName: "withdraw", args: [value, address, address], chainId });
        }
        setTxHash(wHash); setStep("done");
      }
      setTimeout(refetchPos, 4000); // best-effort refresh once the tx is in
    } catch (e) {
      setErr(((e as Error).message || String(e)).slice(0, 160)); setStep("error");
    }
  }

  if (step === "done") {
    const msg = action === "supply"
      ? `Supplied to ${vcfg.short} — earning as it confirms.`
      : "Withdraw submitted — USDC is returning to your wallet.";
    return (
      <div className="mt-2 rounded-xl border p-3.5" style={{ borderColor: "#22C55E40", background: "#22C55E08" }}>
        <div className="font-mono text-[11px] font-bold mb-1" style={{ color: "#22C55E" }}>
          ✓ {action === "supply" ? "Supply" : "Withdraw"} submitted · {vcfg.short} · {net.short}
        </div>
        <div className="font-mono text-[10px] text-slate-400 mb-2">{msg}</div>
        {txHash && (
          <a href={`${net.explorer}/tx/${txHash}`} target="_blank" rel="noopener noreferrer"
             className="font-mono text-[10px] px-2.5 py-1 rounded-lg border border-[#4FC3F730] text-[#4FC3F7]">
            View tx ↗
          </a>
        )}
      </div>
    );
  }

  const btnLabel = busy
    ? (step === "switching" ? "Switching network…" : step === "approving" ? "Approve in wallet…" : step === "supplying" ? "Supply in wallet…" : "Withdraw in wallet…")
    : action === "supply" ? `🌾 Supply${amt > 0 ? ` ${amt}` : ""} USDC → ${vcfg.short}` : `↩︎ Withdraw${withdrawAll ? " all" : amt > 0 ? ` ${amt}` : ""} USDC`;

  return (
    <div className="mt-2 rounded-xl border border-[#1A1A2E] bg-[#0a0a0f] p-3.5">
      <div className="font-mono text-[10px] text-slate-500 tracking-widest font-bold mb-3">MOVE TO YIELD · BASE</div>

      {/* Network risk banner */}
      <div className="rounded-lg px-2.5 py-1.5 mb-3 font-mono text-[10px] leading-relaxed"
           style={net.testnet
             ? { background: "#F59E0B0a", border: "1px solid #F59E0B30", color: "#fcd9a3" }
             : { background: "#EF44440a", border: "1px solid #EF444440", color: "#fca5a5" }}>
        {net.testnet
          ? <>⚠️ <b>Testnet (Base Sepolia)</b> — safe to experiment with fake funds.</>
          : <>🔴 <b>Mainnet — real funds.</b> You sign; this is irreversible. Double-check the amount.</>}
      </div>

      {/* Account identity — Basename if set */}
      {address && (
        <div className="font-mono text-[9px] text-slate-600 mb-3">
          ACCOUNT <span className="text-slate-300">{fromName || truncAddr(address)}</span>
        </div>
      )}

      {/* Venue selector — the router */}
      <div className="mb-3">
        <div className="font-mono text-[9px] text-slate-600 mb-1.5">VENUE</div>
        <div className="flex gap-1">
          {VENUE_LIST.map(v => {
            const active = venue === v.id;
            const vr = rates?.find(r => r.project === v.llamaProject)?.apy ?? null;
            return (
              <button key={v.id} onClick={() => pickVenue(v.id)}
                className="flex-1 font-mono text-[10px] py-1.5 rounded-md transition-colors"
                style={active
                  ? { background: "#4FC3F715", color: "#4FC3F7", border: "1px solid #4FC3F730" }
                  : { color: "#64748b", border: "1px solid #1A1A2E" }}>
                {v.short}{vr != null && <span className={active ? "text-[#22C55E]" : "text-slate-500"}> {vr.toFixed(1)}%</span>}
              </button>
            );
          })}
        </div>
        <div className="font-mono text-[9px] text-slate-700 mt-1">
          {vcfg.label}{!isAave && " · mainnet only"}
        </div>
      </div>

      {/* #1 Position + #2 live APY — real on-chain reads (per venue) */}
      <div className="flex items-center justify-between mb-3 px-2.5 py-2 rounded-lg border border-[#1A1A2E] bg-[#0d0d12] font-mono text-[10px]">
        <div>
          <div className="text-slate-600 mb-0.5">YOUR POSITION</div>
          <div className="text-slate-200">{position != null ? `${position.toFixed(2)} USDC` : (isConnected ? (vnet ? "—" : "—") : "connect to view")}</div>
        </div>
        <div className="text-right">
          <div className="text-slate-600 mb-0.5">SUPPLY APY</div>
          <div className="text-[#22C55E]">{apy != null ? `~${apy.toFixed(2)}%` : "—"}</div>
        </div>
      </div>

      {/* #4 Best rate on Base — live curated comparison (DefiLlama) */}
      {rates && rates.length > 0 && (
        <div className="mb-3 rounded-lg border border-[#1A1A2E] bg-[#0d0d12] p-2.5">
          <div className="flex items-center justify-between mb-1.5">
            <span className="font-mono text-[9px] text-slate-600">BEST USDC RATE · BASE</span>
            <span className="font-mono text-[9px] text-slate-700">live · DefiLlama</span>
          </div>
          {rates.slice(0, 4).map((r, i) => (
            <div key={r.project} className="flex items-center justify-between py-[2px] font-mono text-[10px]">
              <span className={i === 0 ? "text-[#22C55E]" : "text-slate-400"}>
                {i === 0 ? "★ " : "  "}{r.label}
                {!r.executable && <span className="text-slate-700"> · view-only</span>}
              </span>
              <span className={i === 0 ? "text-[#22C55E]" : "text-slate-300"}>{r.apy.toFixed(2)}%</span>
            </div>
          ))}
        </div>
      )}

      {/* Supply / Withdraw toggle */}
      <div className="flex gap-1 mb-3">
        {(["supply", "withdraw"] as const).map(a => {
          const active = action === a;
          return (
            <button key={a} onClick={() => setAction(a)}
              className="flex-1 font-mono text-[11px] py-1.5 rounded-md transition-colors"
              style={active
                ? { background: "#4FC3F715", color: "#4FC3F7", border: "1px solid #4FC3F730" }
                : { color: "#64748b", border: "1px solid #1A1A2E" }}>
              {a === "supply" ? "Supply" : "Withdraw"}
            </button>
          );
        })}
      </div>

      {/* Network */}
      <label className="block mb-3">
        <span className="font-mono text-[9px] text-slate-600 block mb-1">NETWORK</span>
        <select value={network} onChange={e => setNetwork(e.target.value as YieldNetwork)}
          className="w-full bg-[#050508] border border-[#1A1A2E] focus:border-[#4FC3F7]/40 rounded-lg px-2.5 py-1.5 font-mono text-[11px] text-slate-200 outline-none">
          <option value="baseSepolia" disabled={!VENUES[venue].nets.baseSepolia}>Base Sepolia (testnet)</option>
          <option value="base">Base mainnet</option>
        </select>
      </label>

      {/* Amount + balance-aware Max */}
      <label className="block mb-2">
        <div className="flex items-center justify-between mb-1">
          <span className="font-mono text-[9px] text-slate-600">AMOUNT (USDC)</span>
          {maxFor != null && !withdrawAll && (
            <span className="font-mono text-[9px] text-slate-600">
              {action === "supply" ? "Wallet" : "Position"} {maxFor.toFixed(2)}
              <button type="button" onClick={setMax} className="text-[#4FC3F7] ml-1">Max</button>
            </span>
          )}
        </div>
        <input type="number" min="0" step="0.01" value={amount} disabled={withdrawAll}
          onChange={e => setAmount(e.target.value)} placeholder="e.g. 5"
          className="w-full bg-[#050508] border border-[#1A1A2E] focus:border-[#4FC3F7]/40 rounded-lg px-2.5 py-1.5 font-mono text-[11px] text-slate-200 placeholder:text-slate-700 outline-none transition-colors disabled:opacity-40" />
        {overMax && <span className="font-mono text-[9px] text-red-500 mt-1 block">{action === "supply" ? "Exceeds your wallet USDC" : "Exceeds your position"}</span>}
      </label>

      {action === "withdraw" && (
        <label className="flex items-center gap-2 mb-2 font-mono text-[10px] text-slate-500 cursor-pointer">
          <input type="checkbox" checked={all} onChange={e => setAll(e.target.checked)} className="w-auto" />
          Withdraw all (full position)
        </label>
      )}

      <p className="font-mono text-[9px] text-slate-600 mb-2 leading-relaxed">
        {action === "supply"
          ? <>Supplies USDC into <span className="text-slate-400">{vcfg.label}</span> — you sign {isAave ? "approve + supply" : "approve + deposit"} and hold a yield-bearing receipt. Non-custodial; funds stay in your control.</>
          : <>Pulls USDC back out of <span className="text-slate-400">{vcfg.short}</span> to your wallet — you sign one {isAave ? "withdraw" : withdrawAll ? "redeem" : "withdraw"} call.</>}
      </p>

      {step === "error" && <p className="font-mono text-[10px] text-amber-400 mb-2">{err}</p>}

      <button onClick={run} disabled={busy || !valid || !isConnected}
        className="w-full font-mono text-[12px] font-bold py-2 rounded-lg transition-all disabled:opacity-50"
        style={action === "supply"
          ? { background: "#F59E0B15", color: "#F59E0B", border: "1px solid #F59E0B40" }
          : { background: "#4FC3F710", color: "#4FC3F7", border: "1px solid #4FC3F730" }}>
        {!isConnected ? "Connect your wallet to continue" : btnLabel}
      </button>
      <p className="font-mono text-[9px] text-slate-700 mt-1.5">
        {vcfg.label} · {net.label} · you sign every transaction · withdraw anytime.
      </p>
    </div>
  );
}

// Rendered for the `prepare_send` marker. NON-custodial send/pay: the user signs
// a USDC ERC-20 transfer (or native ETH send) to an address or Basename, from
// their OWN wallet. Basenames resolve via OnchainKit (Base L2 resolver).
interface SendResult { to?: string; amount?: number | string; asset?: string; network?: string }

export function SendCard({ result, account }: { result: SendResult; account?: `0x${string}` }) {
  const fromAddr = account;
  const isConnected = !!account;
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const { sendTransactionAsync } = useSendTransaction();
  // EIP-5792 gasless path — only engages for a Smart Wallet whose paymaster
  // capability is present (see gaslessSupported below). Everything else falls
  // through to the unchanged writeContract / sendTransaction path.
  const { sendCallsAsync } = useSendCalls();
  const { data: walletCapabilities } = useCapabilities({ account, query: { enabled: !!account } });
  const [callsId, setCallsId] = useState<string>("");

  // B20 native settlement token (supports transferWithMemo). Only offered as a
  // send asset when enabled + a verified address is configured — Circle USDC and
  // ETH have no memo, so the memo field only appears for this asset.
  const b20Available = B20_ENABLED && isAddress(B20_USDC);
  const initialAsset: "USDC" | "ETH" | "B20" =
    result.asset === "ETH" ? "ETH" : (result.asset === "B20" && b20Available) ? "B20" : "USDC";

  const [asset,     setAsset]     = useState<"USDC" | "ETH" | "B20">(initialAsset);
  const [network,   setNetwork]   = useState<YieldNetwork>(
    initialAsset === "B20" ? "base" : (result.network === "base" ? "base" : "baseSepolia"));
  const [recipient, setRecipient] = useState<string>(typeof result.to === "string" ? result.to : "");
  const [amount,    setAmount]    = useState<string>(
    result.amount != null && (typeof result.amount === "number" || typeof result.amount === "string") ? String(result.amount) : "");
  const [memo,      setMemo]      = useState<string>("");

  const isB20Asset = asset === "B20";
  // B20 USDC is mainnet-only and fixed at 6 decimals. Picking it forces Base mainnet.
  function pickAsset(a: "USDC" | "ETH" | "B20") {
    setAsset(a);
    if (a === "B20") setNetwork("base");
  }
  const [step, setStep] = useState<"idle" | "switching" | "sending" | "done" | "error">("idle");
  const [err,  setErr]  = useState("");
  const [txHash, setTxHash] = useState<string>("");
  const [isEoa, setIsEoa] = useState(false);

  const net = YIELD_NETWORKS[network];
  const chainId = net.chainId;
  // Smart Wallet + paymaster present for this chain → we can sponsor gas.
  const gaslessSupported = Boolean(
    (walletCapabilities as Record<number, { paymasterService?: { supported?: boolean } }> | undefined)?.[chainId]?.paymasterService?.supported,
  );
  // Resolve the on-chain tx hash from an EIP-5792 batch once it confirms.
  const { data: callsStatus } = useCallsStatus({
    id: callsId,
    query: { enabled: !!callsId, refetchInterval: ({ state }) => (state.data?.status === "success" ? false : 1500) },
  });
  // When the sponsored batch confirms, surface its tx hash like a normal send.
  useEffect(() => {
    if (callsStatus?.status === "success") {
      const hash = callsStatus.receipts?.[0]?.transactionHash;
      if (hash) { setTxHash(hash); setStep("done"); }
    }
  }, [callsStatus]);
  const recip = recipient.trim();
  const recipIsAddr = isAddress(recip);
  const recipIsName = /\.(base|eth)$/i.test(recip);

  // Forward-resolve a Basename → address via the Base L2 Resolver (always on Base
  // mainnet; the resolved address is valid on whichever network you send from).
  const node = recipIsName ? safeNamehash(basenameToEns(recip)) : undefined;
  const { data: resolvedRaw, isLoading: resolving } = useReadContract({
    address: BASENAME_L2_RESOLVER, abi: RESOLVER_ADDR_ABI, functionName: "addr",
    args: node ? [node] : undefined, chainId: base.id,
    query: { enabled: !!node },
  });
  const resolvedAddr = resolvedRaw && resolvedRaw !== ZERO_ADDR ? (resolvedRaw as `0x${string}`) : undefined;
  // Reverse-name for a pasted address (nice confirmation label).
  const { data: revName } = useName(
    { address: recipIsAddr ? (recip as `0x${string}`) : undefined, chain: base }, { enabled: recipIsAddr });

  const toAddress = (recipIsAddr ? recip : (recipIsName ? (resolvedAddr ?? undefined) : undefined)) as `0x${string}` | undefined;

  // Basename as account identity + spendable balance (Tier 1 #3, balance-aware).
  const { name: fromName } = useBasename(fromAddr);
  const { data: usdcBalRaw } = useReadContract({
    address: net.usdc, abi: ERC20_ABI, functionName: "balanceOf",
    args: fromAddr ? [fromAddr] : undefined, chainId,
    query: { enabled: !!fromAddr && asset === "USDC" },
  });
  const { data: ethBal } = useBalance({ address: fromAddr, chainId, query: { enabled: !!fromAddr && asset === "ETH" } });
  const { data: b20BalRaw } = useReadContract({
    address: B20_USDC as `0x${string}`, abi: ERC20_ABI, functionName: "balanceOf",
    args: fromAddr ? [fromAddr] : undefined, chainId: base.id,
    query: { enabled: !!fromAddr && isB20Asset && b20Available },
  });
  const balance = asset === "USDC"
    ? (usdcBalRaw != null ? Number(formatUnits(usdcBalRaw as bigint, net.usdcDecimals)) : null)
    : asset === "ETH"
    ? (ethBal ? Number(formatUnits(ethBal.value, ethBal.decimals)) : null)
    : (b20BalRaw != null ? Number(formatUnits(b20BalRaw as bigint, 6)) : null);
  function setMax() {
    if (balance == null) return;
    setAmount(String(asset === "ETH" ? Math.max(0, balance - 0.00005) : balance)); // leave a little ETH for gas
  }

  const amt = parseFloat(amount);
  const overBalance = balance != null && amt > balance;
  const memoTooLong = isB20Asset && memo.trim().length > MEMO_MAX_CHARS;
  const valid = !!toAddress && amt > 0 && !overBalance && !memoTooLong;
  const busy = step === "switching" || step === "sending";

  // Build the value-transfer call for the selected asset. B20 native routes
  // through transferWithMemo when a memo is present (else a plain transfer);
  // USDC/ETH paths are unchanged.
  function buildTransferCall(to: `0x${string}`): { to: `0x${string}`; data?: `0x${string}`; value?: bigint } {
    if (asset === "USDC") {
      return { to: net.usdc, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [to, parseUnits(amount, net.usdcDecimals)] }) };
    }
    if (asset === "ETH") {
      return { to, value: parseEther(amount) };
    }
    // B20 native
    const data = isValidMemo(memo)
      ? encodeTransferWithMemo({ to, amount, decimals: 6, memo })
      : encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [to, parseUnits(amount, 6)] });
    return { to: B20_USDC as `0x${string}`, data };
  }

  async function send() {
    if (!fromAddr)  { setErr("Connect your wallet first"); setStep("error"); return; }
    if (!toAddress) { setErr(recipIsName ? "Couldn't resolve that name" : "Enter a valid address or .base name"); setStep("error"); return; }
    if (!(amt > 0)) { setErr("Enter an amount"); setStep("error"); return; }
    setErr(""); setTxHash(""); setCallsId("");
    try {
      setStep("switching");
      await switchChainAsync({ chainId });
      setStep("sending");

      // EIP-5792 path — route every 5792-capable wallet (Coinbase Smart Wallet,
      // recent MetaMask) through wallet_sendCalls so we can attach the ERC-8021
      // builder-code `dataSuffix`. Coinbase Smart Wallet appends it to the
      // executeBatch calldata (attributed); wallets that don't support the
      // capability ignore it (optional: true → never blocks the send). The
      // paymaster is added only when the wallet exposes one (gasless). The
      // status hook resolves the on-chain tx hash for both.
      const supportsSendCalls = !!walletCapabilities;
      if (supportsSendCalls) {
        const call = buildTransferCall(toAddress);
        const origin = typeof window !== "undefined" ? window.location.origin : "";
        const dataSuffix = { value: DATA_SUFFIX, optional: true };
        const capabilities = gaslessSupported
          ? { paymasterService: { url: `${origin}/api/paymaster?network=${network}` }, dataSuffix }
          : { dataSuffix };
        const res = await sendCallsAsync({ calls: [call], chainId, capabilities });
        setCallsId(typeof res === "string" ? res : res.id); // status hook → done
        return;
      }

      // Legacy fallback — wallets without EIP-5792 (older EOAs). Unattributed:
      // builder-code attribution needs the sendCalls dataSuffix capability above.
      setIsEoa(true);
      const call = buildTransferCall(toAddress);
      const hash = asset === "USDC"
        ? await writeContractAsync({ address: net.usdc, abi: ERC20_ABI, functionName: "transfer", args: [toAddress, parseUnits(amount, net.usdcDecimals)], chainId })
        : await sendTransactionAsync({ to: call.to, value: call.value, data: call.data, chainId });
      setTxHash(hash); setStep("done");
    } catch (e) {
      setErr(((e as Error).message || String(e)).slice(0, 160)); setStep("error");
    }
  }

  if (step === "done") {
    return (
      <div className="mt-2 rounded-xl border p-3.5" style={{ borderColor: "#22C55E40", background: "#22C55E08" }}>
        <div className="font-mono text-[11px] font-bold mb-1" style={{ color: "#22C55E" }}>
          ✓ Sent {amt} {asset} · {net.short}
        </div>
        <div className="font-mono text-[10px] text-slate-400 mb-2 break-all">
          to {revName || (recipIsName ? recip : truncAddr(toAddress ?? ""))}
        </div>
        {txHash && (
          <a href={`${net.explorer}/tx/${txHash}`} target="_blank" rel="noopener noreferrer"
             className="font-mono text-[10px] px-2.5 py-1 rounded-lg border border-[#4FC3F730] text-[#4FC3F7]">
            View tx ↗
          </a>
        )}
      </div>
    );
  }

  // Recipient resolution status line
  let resolveLine: React.ReactNode = null;
  if (recipIsName && resolving) resolveLine = <span className="text-slate-500">resolving {recip}…</span>;
  else if (recipIsName && toAddress) resolveLine = <span className="text-[#22C55E]">→ {truncAddr(toAddress)}</span>;
  else if (recipIsName && recip.length > 3) resolveLine = <span className="text-red-500">name not found on Base</span>;
  else if (recipIsAddr) resolveLine = <span className="text-[#22C55E]">✓ {revName ? `${revName} · ${truncAddr(recip)}` : "valid address"}</span>;
  else if (recip.length > 0) resolveLine = <span className="text-slate-600">enter a 0x… address or name.base</span>;

  const btnLabel = busy ? (step === "switching" ? "Switching network…" : "Confirm in wallet…")
    : `Send${amt > 0 ? ` ${amt}` : ""} ${asset}${toAddress ? ` → ${recipIsName ? recip : truncAddr(toAddress)}` : ""}`;

  return (
    <div className="mt-2 rounded-xl border border-[#1A1A2E] bg-[#0a0a0f] p-3.5">
      <div className="flex items-center justify-between mb-3">
        <span className="font-mono text-[10px] text-slate-500 tracking-widest font-bold">SEND / PAY · BASE</span>
        {gaslessSupported && (
          <span className="font-mono text-[9px] px-2 py-0.5 rounded-full" style={{ background: "#A78BFA15", color: "#A78BFA", border: "1px solid #A78BFA40" }}>
            ⚡ Gasless
          </span>
        )}
      </div>

      {/* Network risk banner */}
      <div className="rounded-lg px-2.5 py-1.5 mb-3 font-mono text-[10px] leading-relaxed"
           style={net.testnet
             ? { background: "#F59E0B0a", border: "1px solid #F59E0B30", color: "#fcd9a3" }
             : { background: "#EF44440a", border: "1px solid #EF444440", color: "#fca5a5" }}>
        {net.testnet
          ? <>⚠️ <b>Testnet (Base Sepolia)</b> — safe to experiment with fake funds.</>
          : <>🔴 <b>Mainnet — real funds.</b> Sending is irreversible. Double-check the recipient + amount.</>}
      </div>

      {/* Account identity — Basename if set */}
      {fromAddr && (
        <div className="font-mono text-[9px] text-slate-600 mb-3">
          FROM <span className="text-slate-300">{fromName || truncAddr(fromAddr)}</span>
        </div>
      )}

      {/* Asset toggle — B20 native appears only when a settlement token is configured */}
      <div className="flex gap-1 mb-3">
        {(b20Available ? (["USDC", "ETH", "B20"] as const) : (["USDC", "ETH"] as const)).map(a => {
          const active = asset === a;
          return (
            <button key={a} onClick={() => pickAsset(a)}
              className="flex-1 font-mono text-[11px] py-1.5 rounded-md transition-colors"
              style={active
                ? { background: "#4FC3F715", color: "#4FC3F7", border: "1px solid #4FC3F730" }
                : { color: "#64748b", border: "1px solid #1A1A2E" }}>
              {a}
            </button>
          );
        })}
      </div>

      {/* Recipient */}
      <label className="block mb-1">
        <span className="font-mono text-[9px] text-slate-600 block mb-1">RECIPIENT</span>
        <input value={recipient} onChange={e => setRecipient(e.target.value)}
          placeholder="0x… or name.base"
          className="w-full bg-[#050508] border border-[#1A1A2E] focus:border-[#4FC3F7]/40 rounded-lg px-2.5 py-1.5 font-mono text-[11px] text-slate-200 placeholder:text-slate-700 outline-none transition-colors" />
      </label>
      <div className="font-mono text-[9px] mb-3 h-3">{resolveLine}</div>

      {/* Amount + balance-aware Max */}
      <label className="block mb-3">
        <div className="flex items-center justify-between mb-1">
          <span className="font-mono text-[9px] text-slate-600">AMOUNT ({asset})</span>
          {balance != null && (
            <span className="font-mono text-[9px] text-slate-600">
              Bal {balance.toFixed(asset === "ETH" ? 4 : 2)}
              <button type="button" onClick={setMax} className="text-[#4FC3F7] ml-1">Max</button>
            </span>
          )}
        </div>
        <input type="number" min="0" step={asset === "ETH" ? "0.0001" : "0.01"} value={amount}
          onChange={e => setAmount(e.target.value)} placeholder={asset === "ETH" ? "e.g. 0.01" : "e.g. 5"}
          className="w-full bg-[#050508] border border-[#1A1A2E] focus:border-[#4FC3F7]/40 rounded-lg px-2.5 py-1.5 font-mono text-[11px] text-slate-200 placeholder:text-slate-700 outline-none transition-colors" />
        {overBalance && <span className="font-mono text-[9px] text-red-500 mt-1 block">Amount exceeds your {asset} balance</span>}
      </label>

      {/* Memo (B20 native only — transferWithMemo attaches a bytes32 reference) */}
      {isB20Asset && (
        <label className="block mb-3">
          <div className="flex items-center justify-between mb-1">
            <span className="font-mono text-[9px] text-slate-600">MEMO (OPTIONAL)</span>
            <span className={`font-mono text-[9px] ${memoTooLong ? "text-red-500" : "text-slate-600"}`}>
              {memo.trim().length}/{MEMO_MAX_CHARS}
            </span>
          </div>
          <input value={memo} onChange={e => setMemo(e.target.value)}
            placeholder="INV-2026-001"
            className="w-full bg-[#050508] border border-[#1A1A2E] focus:border-[#4FC3F7]/40 rounded-lg px-2.5 py-1.5 font-mono text-[11px] text-slate-200 placeholder:text-slate-700 outline-none transition-colors" />
          <span className="font-mono text-[9px] text-slate-600 mt-1 block">
            Attached onchain — order ID / payment ref. {memoTooLong && <span className="text-red-500">Max {MEMO_MAX_CHARS} chars.</span>}
          </span>
        </label>
      )}

      {/* Network */}
      <label className="block mb-3">
        <span className="font-mono text-[9px] text-slate-600 block mb-1">NETWORK</span>
        <select value={network} onChange={e => setNetwork(e.target.value as YieldNetwork)}
          className="w-full bg-[#050508] border border-[#1A1A2E] focus:border-[#4FC3F7]/40 rounded-lg px-2.5 py-1.5 font-mono text-[11px] text-slate-200 outline-none">
          <option value="baseSepolia">Base Sepolia (testnet)</option>
          <option value="base">Base mainnet</option>
        </select>
      </label>

      <p className="font-mono text-[9px] text-slate-600 mb-2 leading-relaxed">
        Sends {asset} directly from your wallet — you sign one {asset === "USDC" ? "transfer" : "send"}. Non-custodial; Blue Agent never touches the funds.
        {gaslessSupported && <span className="text-[#A78BFA]"> Gas is sponsored — no ETH needed.</span>}
      </p>

      {step === "error" && <p className="font-mono text-[10px] text-amber-400 mb-2">{err}</p>}

      <button onClick={send} disabled={busy || !valid || !isConnected}
        className="w-full font-mono text-[12px] font-bold py-2 rounded-lg transition-all disabled:opacity-50"
        style={{ background: "#34D39915", color: "#34D399", border: "1px solid #34D39940" }}>
        {!isConnected ? "Connect your wallet to continue" : btnLabel}
      </button>
      <p className="font-mono text-[9px] text-slate-700 mt-1.5">
        {net.label} · you sign every transaction · sends are final.
      </p>
      {/* Notice when falling back to EOA — builder code requires Smart Wallet */}
      {(!walletCapabilities || isEoa) && (
        <p className="font-mono text-[9px] text-slate-600 mt-1">
          💡 Builder attribution requires Coinbase Smart Wallet
        </p>
      )}
    </div>
  );
}

// ── Swap card (prepare_swap) ──────────────────────────────────────────────────
// Marker-driven inline swap. Fetches a LIVE 0x quote (/api/swap/quote) and lets
// the user review the rate + SIGN in their own wallet (non-custodial). Mirrors
// the Launches TradeModal flow. ZERO fabrication — every number is from 0x.
type SwapResult = {
  tokenIn?: string; tokenOut?: string; amountIn?: string;
  tokenInAddress?: string; tokenOutAddress?: string; network?: string;
};
type ChatSwapQuote = {
  needsKey?: boolean; error?: string;
  buyAmount?: string; minBuyAmount?: string;
  transaction?: { to: `0x${string}`; data: `0x${string}`; value?: string };
  issues?: { allowance?: { spender: `0x${string}` } | null };
};

const SWAP_NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const DECIMALS_ABI = [
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

function fmtSwapNum(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

export function SwapCard({ result, account }: { result: SwapResult; account?: `0x${string}` }) {
  const isConnected = !!account;
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const { sendTransactionAsync } = useSendTransaction();

  const sellSym  = (result.tokenIn  || "TOKEN").replace(/^\$/, "");
  const buySym   = (result.tokenOut || "TOKEN").replace(/^\$/, "");
  const sellAddr = (result.tokenInAddress  || "").trim();
  const buyAddr  = (result.tokenOutAddress || "").trim();
  const sellNative = sellAddr.toLowerCase() === SWAP_NATIVE;
  const buyNative  = buyAddr.toLowerCase()  === SWAP_NATIVE;
  const unresolved = !sellAddr || !buyAddr;

  // On-chain decimals for non-native legs (native = 18). 0x works in base units.
  const { data: sellDecRaw } = useReadContract({
    address: sellAddr as `0x${string}`, abi: DECIMALS_ABI, functionName: "decimals",
    chainId: base.id, query: { enabled: !!sellAddr && !sellNative },
  });
  const { data: buyDecRaw } = useReadContract({
    address: buyAddr as `0x${string}`, abi: DECIMALS_ABI, functionName: "decimals",
    chainId: base.id, query: { enabled: !!buyAddr && !buyNative },
  });
  const sellDec = sellNative ? 18 : (sellDecRaw != null ? Number(sellDecRaw) : undefined);
  const buyDec  = buyNative  ? 18 : (buyDecRaw  != null ? Number(buyDecRaw)  : undefined);

  const [amount, setAmount] = useState<string>(result.amountIn ?? "");
  const [quote,  setQuote]  = useState<ChatSwapQuote | null>(null);
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState<"idle" | "approving" | "swapping" | "done" | "error">("idle");
  const [err,  setErr]  = useState("");
  const [txHash, setTxHash] = useState("");

  // Balance of the sell leg.
  const { data: nativeBal } = useBalance({ address: account, chainId: base.id, query: { enabled: !!account && sellNative } });
  const { data: erc20Bal } = useReadContract({
    address: sellAddr as `0x${string}`, abi: ERC20_ABI, functionName: "balanceOf",
    args: account ? [account] : undefined, chainId: base.id,
    query: { enabled: !!account && !!sellAddr && !sellNative },
  });
  const balance = sellNative
    ? (nativeBal ? Number(formatUnits(nativeBal.value, 18)) : null)
    : (erc20Bal != null && sellDec != null ? Number(formatUnits(erc20Bal as bigint, sellDec)) : null);

  const amt = parseFloat(amount);
  const sellBase = amount && amt > 0 && sellDec != null
    ? (() => { try { return parseUnits(amount, sellDec).toString(); } catch { return ""; } })()
    : "";
  const overBalance = balance != null && amt > balance;

  // Debounced 0x quote.
  const reqId = useRef(0);
  useEffect(() => {
    if (!sellBase || !sellAddr || !buyAddr || sellAddr.toLowerCase() === buyAddr.toLowerCase()) { setQuote(null); return; }
    const id = ++reqId.current;
    setLoading(true);
    const tmo = setTimeout(() => {
      const qs = new URLSearchParams({ sellToken: sellAddr, buyToken: buyAddr, sellAmount: sellBase, ...(account ? { taker: account } : {}) });
      fetch(`/api/swap/quote?${qs}`).then(r => r.json()).then((j: ChatSwapQuote) => {
        if (id !== reqId.current) return; setQuote(j); setLoading(false);
      }).catch(() => { if (id === reqId.current) { setQuote({ error: "quote failed" }); setLoading(false); } });
    }, 450);
    return () => clearTimeout(tmo);
  }, [sellBase, sellAddr, buyAddr, account]);

  const buyAmount = quote?.buyAmount && buyDec != null ? Number(formatUnits(BigInt(quote.buyAmount), buyDec)) : null;
  const minBuy    = quote?.minBuyAmount && buyDec != null ? Number(formatUnits(BigInt(quote.minBuyAmount), buyDec)) : null;
  const rate = buyAmount != null && amt > 0 ? buyAmount / amt : null;

  const canSwap = !!account && !!quote?.transaction && amt > 0 && !overBalance && !loading && sellDec != null;
  const busy = step === "approving" || step === "swapping";

  function setMax() {
    if (balance == null) return;
    setAmount(String(sellNative ? Math.max(0, balance - 0.00005) : balance));
  }

  async function doSwap() {
    if (!account) { setErr("Connect your wallet"); setStep("error"); return; }
    if (quote?.needsKey) { setErr("Swap needs a 0x API key (ZEROX_API_KEY)"); setStep("error"); return; }
    if (!quote?.transaction || sellDec == null) { setErr(quote?.error || "No route for this pair"); setStep("error"); return; }
    setErr(""); setTxHash("");
    try {
      await switchChainAsync({ chainId: base.id });
      // ERC-20 sells need an allowance to the 0x AllowanceHolder first.
      if (!sellNative && quote.issues?.allowance?.spender) {
        setStep("approving");
        await writeContractAsync({
          address: sellAddr as `0x${string}`, abi: ERC20_ABI, functionName: "approve",
          args: [quote.issues.allowance.spender, parseUnits(amount, sellDec)], chainId: base.id,
        });
      }
      setStep("swapping");
      const hash = await sendTransactionAsync({
        to: quote.transaction.to,
        // Append the ERC-8021 builder-code suffix → tx credited to BlueAgent.
        data: (quote.transaction.data + DATA_SUFFIX.slice(2)) as `0x${string}`,
        value: quote.transaction.value ? BigInt(quote.transaction.value) : undefined,
        chainId: base.id,
      });
      setTxHash(hash); setStep("done");
    } catch (e) {
      const m = (e as Error).message || String(e);
      const cancelled = /user rejected|denied|cancell?ed/i.test(m);
      setErr(cancelled ? "Swap cancelled." : m.slice(0, 160)); setStep("error");
    }
  }

  // Unknown token → ask for the contract address (never fabricate one).
  if (unresolved) {
    return (
      <div className="mt-2 rounded-xl border border-[#1A1A2E] bg-[#0a0a0f] px-3.5 py-3">
        <div className="font-mono text-[11px] text-amber-400">
          Couldn’t resolve {!sellAddr ? sellSym : buySym}. Re-ask with its contract address (0x…).
        </div>
      </div>
    );
  }

  if (step === "done") {
    return (
      <div className="mt-2 rounded-xl border p-3.5" style={{ borderColor: "#22C55E40", background: "#22C55E08" }}>
        <div className="font-mono text-[12px] font-bold mb-1" style={{ color: "#22C55E" }}>
          ✓ Swapped {fmtSwapNum(amt)} {sellSym} → {buyAmount != null ? fmtSwapNum(buyAmount) : ""} {buySym}
        </div>
        {txHash && (
          <a href={`https://basescan.org/tx/${txHash}`} target="_blank" rel="noopener noreferrer"
            className="font-mono text-[10px] px-2.5 py-1 rounded-lg border border-[#4FC3F730] text-[#4FC3F7] inline-block mt-1">View tx ↗</a>
        )}
        <button onClick={() => { setStep("idle"); setQuote(null); }}
          className="font-mono text-[10px] text-slate-500 hover:text-slate-300 ml-3">Swap again</button>
      </div>
    );
  }

  return (
    <div className="mt-2 rounded-xl border border-[#1A1A2E] bg-[#0a0a0f] p-3.5">
      <div className="flex items-center gap-2 mb-2.5">
        <span className="text-base leading-none">🔄</span>
        <span className="font-mono text-[11px] font-bold text-white">Swap {sellSym} → {buySym}</span>
        <span className="font-mono text-[9px] text-slate-600 ml-auto">Base · via 0x</span>
      </div>

      {/* You pay */}
      <div className="rounded-lg border border-[#1A1A2E] bg-[#050508] p-2.5 mb-1">
        <div className="flex items-center justify-between mb-1">
          <span className="font-mono text-[9px] text-slate-600">YOU PAY</span>
          {balance != null && (
            <span className="font-mono text-[9px] text-slate-600">Bal {balance.toFixed(sellDec === 6 ? 2 : 5)}
              <button type="button" onClick={setMax} className="text-[#4FC3F7] ml-1">Max</button></span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <input type="number" min="0" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.0"
            className="flex-1 bg-transparent font-mono text-[16px] text-white outline-none placeholder:text-slate-700 w-0" />
          <span className="font-mono text-[11px] text-slate-200 px-2 py-1.5 border border-[#1A1A2E] rounded-lg">{sellSym}</span>
        </div>
        {overBalance && <div className="font-mono text-[9px] text-red-500 mt-1">Exceeds your {sellSym} balance</div>}
      </div>

      <div className="flex justify-center -my-1 relative z-10">
        <div className="w-7 h-7 rounded-lg border border-[#1A1A2E] bg-[#0d0d12] text-slate-500 font-mono text-[12px] flex items-center justify-center">↓</div>
      </div>

      {/* You receive */}
      <div className="rounded-lg border border-[#1A1A2E] bg-[#050508] p-2.5 mt-1 mb-3">
        <div className="font-mono text-[9px] text-slate-600 mb-1">YOU RECEIVE</div>
        <div className="flex items-center gap-2">
          <div className="flex-1 font-mono text-[16px] text-white w-0 truncate">
            {loading ? <span className="text-slate-600">…</span> : buyAmount != null ? fmtSwapNum(buyAmount) : <span className="text-slate-700">0.0</span>}
          </div>
          <span className="font-mono text-[11px] text-slate-200 px-2 py-1.5 border border-[#1A1A2E] rounded-lg">{buySym}</span>
        </div>
      </div>

      {rate != null && (
        <div className="font-mono text-[9px] text-slate-500 mb-2 flex items-center justify-between">
          <span>1 {sellSym} ≈ {fmtSwapNum(rate)} {buySym}</span>
          {minBuy != null && <span className="text-slate-600">min {fmtSwapNum(minBuy)} {buySym}</span>}
        </div>
      )}

      {quote?.needsKey && <p className="font-mono text-[9px] text-amber-400 mb-2">Swap needs a free 0x API key — set <span className="text-slate-300">ZEROX_API_KEY</span>.</p>}
      {quote?.error && !quote.needsKey && !loading && amt > 0 && <p className="font-mono text-[9px] text-amber-400 mb-2">No route found for this pair.</p>}
      {step === "error" && <p className="font-mono text-[10px] text-amber-400 mb-2">{err}</p>}

      <button onClick={doSwap} disabled={!canSwap || busy}
        className="w-full font-mono text-[12px] font-bold py-2.5 rounded-lg transition-all disabled:opacity-50"
        style={{ background: "#4FC3F715", color: "#4FC3F7", border: "1px solid #4FC3F740" }}>
        {!isConnected ? "Connect your wallet"
          : busy ? (step === "approving" ? "Approve in wallet…" : "Confirm in wallet…")
          : overBalance ? "Insufficient balance"
          : amt > 0 ? `Swap ${fmtSwapNum(amt)} ${sellSym}` : "Enter an amount"}
      </button>
      <p className="font-mono text-[9px] text-slate-700 mt-1.5 text-center">Best route via 0x · you sign · non-custodial · Base mainnet.</p>
    </div>
  );
}

export function ToolResultCard({ tool, result }: { tool: string; result: Record<string, unknown> }) {
  // Always called inside the chat (ChatMessages) — read the canonical wallet
  // here and hand it to the action cards as a prop so they don't depend on chat.
  const { walletAddr } = useChat();
  const account = walletAddr as `0x${string}` | undefined;
  if (!result || typeof result !== "object") return null;
  const r = result;

  switch (tool) {
    case "hub_honeypot":      return <HoneypotCard    result={r as HoneypotResult} />;
    case "hub_risk_gate":     return <RiskGateCard    result={r as RiskGateResult} />;
    case "hub_deep_analysis": return <DeepAnalysisCard result={r as DeepAnalysisResult} />;
    case "hub_token_pick":    return <TokenPickCard   result={r as TokenPickResult} />;
    case "hub_contract_trust":
    case "hub_whale_signal":  return <ContractTrustCard result={r as ContractTrustResult} />;
    case "hub_market_fit":    return <MarketFitCard   result={r} />;
    case "hub_wallet_pnl":    return <WalletPnlCard   result={r} />;
    case "hub_aml":           return <AmlCard         result={r} />;
    case "hub_quantum":       return <QuantumCard      result={r} />;
    case "hub_yield":         return <YieldCard        result={r} />;
    case "blue_stream":       return <BlueStreamCard   result={r} />;
    case "hub_b20_launch":       return <B20LaunchCard   result={r as B20LaunchResult} />;
    case "hub_hood_arrow":       return <HoodArrowCard   result={r as unknown as HoodArrowResult} />;
    case "robinhood_swap":       return <RobinhoodSwapCard result={r as unknown as RobinhoodSwapResult} />;
    case "robinhood_send":       return <RobinhoodSendCard result={r as unknown as RobinhoodSendResult} />;
    case "robinhood_bridge":     return <RobinhoodBridgeCard result={r as unknown as RobinhoodBridgeResult} />;
    case "blue_dca":             return <DcaCard          data={r as unknown as DcaResult} />;
    case "hub_b20_manage":       return <B20ManageCard   result={r as B20ManageResult} />;
    case "check_memo":           return <MemoResultCard  result={r as MemoResultData} />;
    case "check_authorization":  return <AuthorizationResultCard result={r as AuthorizationResultData} />;
    case "check_wallet":         return <WalletCard      result={r as WalletResultData} />;
    case "prepare_token_launch": return <TokenLaunchCard result={r as TokenLaunchResult} />;
    case "prepare_yield":     return <MoveToYieldCard  result={r as YieldMoveResult} account={account} />;
    case "prepare_send":      return <SendCard         result={r as SendResult} account={account} />;
    case "prepare_swap":      return <SwapCard         result={r as SwapResult} account={account} />;
    default:                  return <GenericCard      tool={tool} result={r} />;
  }
}
