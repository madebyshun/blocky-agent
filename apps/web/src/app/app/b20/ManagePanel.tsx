"use client";

/**
 * ManagePanel — write actions for B20 tokens.
 * Role-gated: only shows actions the connected wallet can perform.
 * Encodes tx client-side (viem), signs via wagmi, polls receipt.
 */

import { useState, useEffect } from "react";
import { encodeFunctionData, parseUnits, formatUnits } from "viem";
import { useAccount, useSendTransaction, useSwitchChain } from "wagmi";
import {
  B20_WRITE_ABI,
  SUPPLY_CAP_MAX,
  PAUSE_FEATURE,
  ROLE_DEFS,
  POLICY_SCOPE_KEYS,
  POLICY_SCOPE_LABELS,
  type PolicyScopeKey,
} from "@/lib/b20/manage-abi";
import {
  encodeMintWithMemo,
  encodeBurnWithMemo,
  isValidMemo,
  MEMO_MAX_CHARS,
} from "@/lib/b20/encode";
import type { B20Inspection } from "@/lib/b20/inspect";
import type { B20RolesResult } from "@/lib/b20/roles";
import type { ScopeHashes } from "./manage-action";
import { ConnectButton } from "@/components/ConnectModal";
import { resolveSpend, type SpendGate } from "@/lib/wallet/read-state";
import { UnverifiedBalance } from "@/components/wallet/UnverifiedBalance";

// ── Types ─────────────────────────────────────────────────────────────────────

type Network = "mainnet" | "sepolia";
const CHAIN_IDS: Record<Network, number> = { mainnet: 8453, sepolia: 84532 };
const EXPLORER:  Record<Network, string>  = {
  mainnet: "https://basescan.org",
  sepolia: "https://sepolia.basescan.org",
};

interface TxState {
  action: string;
  status: "pending" | "polling" | "success" | "error";
  hash?:  string;
  error?: string;
  msg?:   string;   // human-readable success message, e.g. "Minted 100 TEST to 0x…"
}

export interface ManagePanelProps {
  token:       string;
  network:     Network;
  inspect:     B20Inspection;
  roles:       B20RolesResult;
  scopeHashes: ScopeHashes;
  balance:     string;   // raw uint256 string (wallet token balance)
  /**
   * Re-run the inspection. REQUIRED, not optional: this panel holds its mint
   * buttons when the supply cap could not be read, and a gate with no way out
   * is a broken card, not a safe one — the same reason `UnverifiedBalance`
   * types `onRetry` as required. Both render sites already pass it.
   */
  onRefresh:   () => void;
  compact?:    boolean;  // true = scanner inline (fewer groups)
  initialMemo?: string;  // optional LLM/url-supplied memo to seed the mint form
}

// ── Shared styles ─────────────────────────────────────────────────────────────

const INPUT = [
  "w-full bg-[#0a0a12] border border-[#1A1A2E]",
  "focus:border-[#4FC3F740] rounded-xl px-3 py-2",
  "font-mono text-xs text-slate-200 placeholder:text-slate-700",
  "outline-none transition-colors",
].join(" ");

const LABEL = "font-mono text-[9px] text-slate-600 tracking-widest uppercase block mb-1";
const DESC  = "font-mono text-[9px] text-slate-600 leading-relaxed mb-2";

function isAddr(v: string) { return /^0x[a-fA-F0-9]{40}$/.test(v.trim()); }
function isAmt (v: string) { return /^\d+(\.\d+)?$/.test(v.trim()) && parseFloat(v) > 0; }
/** Memo overflows bytes32 (more than 31 chars). Empty is allowed (optional). */
function memoTooLong(v: string) { return v.trim().length > MEMO_MAX_CHARS; }

// ── Optional onchain memo input (bytes32) ───────────────────────────────────────

function MemoField({
  value, onChange, disabled,
}: {
  value: string; onChange: (v: string) => void; disabled?: boolean;
}) {
  const tooLong = memoTooLong(value);
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <p className={LABEL + " mb-0"}>Memo (optional)</p>
        <span className={`font-mono text-[9px] ${tooLong ? "text-[#EF4444]" : "text-slate-600"}`}>
          {value.trim().length}/{MEMO_MAX_CHARS}
        </span>
      </div>
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        placeholder="INV-2026-001 (optional)"
        spellCheck={false}
        className={INPUT + (tooLong ? " border-[#EF444450]" : "")}
      />
      <p className={DESC + " mt-1 mb-0"}>
        Attached onchain — order IDs, payment refs, audit trail.
      </p>
      {tooLong && (
        <p className="font-mono text-[9px] text-[#EF4444] mt-1">
          Memo must be ≤ {MEMO_MAX_CHARS} characters (fits in bytes32).
        </p>
      )}
    </div>
  );
}

// ── Section wrapper ───────────────────────────────────────────────────────────

function Section({
  title, icon, color = "#4FC3F7", children, visible,
}: {
  title: string; icon: string; color?: string; children: React.ReactNode; visible: boolean;
}) {
  if (!visible) return null;
  return (
    <div className="rounded-2xl border border-[#1A1A2E] overflow-hidden">
      <div className="px-4 py-3 bg-[#0a0a0f] border-b border-[#1A1A2E] flex items-center gap-2">
        <span style={{ color }} className="text-sm">{icon}</span>
        <p className="font-mono text-xs font-semibold" style={{ color }}>{title}</p>
      </div>
      <div className="px-4 py-4 space-y-4">{children}</div>
    </div>
  );
}

// ── In-progress indicator (inline) ────────────────────────────────────────────

function TxProgress({ tx }: { tx: TxState }) {
  if (tx.status !== "pending" && tx.status !== "polling") return null;
  return (
    <div className="rounded-xl border border-[#4FC3F730] bg-[#4FC3F708] px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className="w-1.5 h-1.5 rounded-full bg-[#4FC3F7] animate-pulse shrink-0" />
        <div>
          <p className="font-mono text-[10px] font-semibold text-[#4FC3F7]">{tx.action}</p>
          <p className="font-mono text-[9px] text-slate-500 mt-0.5">
            {tx.status === "pending" ? "Waiting for wallet signature…" : "Confirming on-chain…"}
          </p>
          {tx.status === "polling" && tx.hash && (
            <p className="font-mono text-[8px] text-slate-600 mt-0.5 truncate">
              {tx.hash.slice(0, 20)}…
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Toast (success / error popup) ─────────────────────────────────────────────

function Toast({
  tx, explorerBase, onDismiss, onCheckMemo,
}: {
  tx: TxState; explorerBase: string; onDismiss: () => void;
  onCheckMemo?: (hash: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  if (tx.status !== "success" && tx.status !== "error") return null;
  const ok = tx.status === "success";

  async function copyHash() {
    if (!tx.hash) return;
    try { await navigator.clipboard.writeText(tx.hash); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { /* clipboard unavailable */ }
  }
  return (
    <div className="fixed bottom-5 right-5 z-50 w-full max-w-[320px] rounded-2xl border shadow-2xl"
      style={{
        background:   ok ? "#070f07" : "#0f0707",
        borderColor:  ok ? "#22C55E50" : "#EF444450",
        boxShadow:    ok ? "0 8px 32px #22C55E18" : "0 8px 32px #EF444418",
      }}>
      <div className="px-4 py-3.5">
        <div className="flex items-start gap-3">
          {/* Icon */}
          <span className="text-base shrink-0 mt-0.5" style={{ color: ok ? "#22C55E" : "#EF4444" }}>
            {ok ? "✓" : "✕"}
          </span>

          {/* Content */}
          <div className="flex-1 min-w-0">
            <p className="font-mono text-[11px] font-bold leading-tight"
              style={{ color: ok ? "#22C55E" : "#EF4444" }}>
              {ok ? (tx.msg ?? tx.action) : `${tx.action} failed`}
            </p>

            {!ok && tx.error && (
              <p className="font-mono text-[9px] leading-relaxed mt-1"
                style={{ color: "#EF444480" }}>
                {tx.error}
              </p>
            )}

            {tx.hash && (
              <a href={`${explorerBase}/tx/${tx.hash}`}
                target="_blank" rel="noopener noreferrer"
                className="font-mono text-[8px] text-slate-500 hover:text-[#4FC3F7] transition-colors mt-1.5 block truncate">
                {tx.hash.slice(0, 18)}…{tx.hash.slice(-8)} ↗
              </a>
            )}

            {ok && tx.hash && (
              <div className="flex items-center gap-3 mt-2">
                <button onClick={copyHash}
                  className="font-mono text-[9px] text-slate-400 hover:text-[#4FC3F7] transition-colors">
                  {copied ? "✓ Copied" : "⧉ Copy hash"}
                </button>
                {onCheckMemo && (
                  <button onClick={() => onCheckMemo(tx.hash!)}
                    className="font-mono text-[9px] text-[#A78BFA] hover:text-[#C4B5FD] transition-colors">
                    🔖 Check memo →
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Close */}
          <button onClick={onDismiss}
            className="font-mono text-[9px] text-slate-600 hover:text-slate-300 shrink-0 mt-0.5 transition-colors">
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Confirm dialog ────────────────────────────────────────────────────────────

function ConfirmDialog({
  msg, consequence, onConfirm, onCancel,
}: {
  msg: string; consequence?: string; onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onCancel}>
      <div className="bg-[#0a0a12] border border-[#EF444430] rounded-2xl p-5 max-w-sm w-full"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-start gap-3 mb-4">
          <span className="text-xl shrink-0">⚠️</span>
          <div>
            <p className="font-mono text-sm font-bold text-white mb-1">{msg}</p>
            {consequence && (
              <p className="font-mono text-xs text-[#EF4444] leading-relaxed">{consequence}</p>
            )}
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={onCancel}
            className="flex-1 font-mono text-xs py-2 rounded-xl border border-[#1A1A2E] text-slate-400 hover:text-white transition-colors">
            Cancel
          </button>
          <button onClick={() => { onConfirm(); }}
            className="flex-1 font-mono text-xs py-2 rounded-xl transition-colors"
            style={{ background: "#EF444420", color: "#EF4444", border: "1px solid #EF444440" }}>
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function ManagePanel({
  token, network, inspect, roles, scopeHashes, balance, onRefresh, compact = false, initialMemo,
}: ManagePanelProps) {
  const { address, chainId: currentChainId } = useAccount();
  const { sendTransactionAsync }             = useSendTransaction();
  const { switchChainAsync }                 = useSwitchChain();
  const chainId     = CHAIN_IDS[network];
  const explorerBase= EXPLORER[network];

  // ── Tx & confirm state ────────────────────────────────────────────────────
  const [activeTx, setActiveTx] = useState<TxState | null>(null);
  const [confirm,  setConfirm]  = useState<{
    msg: string; consequence?: string; run: () => void;
  } | null>(null);

  // Auto-dismiss toast after 6s on success
  useEffect(() => {
    if (activeTx?.status !== "success") return;
    const t = setTimeout(() => setActiveTx(null), 6_000);
    return () => clearTimeout(t);
  }, [activeTx?.hash]); // re-arm each time a new tx hash succeeds

  // ── Form state — Supply ───────────────────────────────────────────────────
  const [mintTo,   setMintTo]   = useState("");
  const [mintAmt,  setMintAmt]  = useState("");
  const [mintMemo, setMintMemo] = useState((initialMemo ?? "").slice(0, MEMO_MAX_CHARS));

  // ── Form state — Batch Mint (batchMint, MINT_ROLE; no WithMemo variant) ────
  const [batchRows, setBatchRows] = useState<Array<{ to: string; amount: string }>>([
    { to: "", amount: "" },
  ]);
  const [csvOpen, setCsvOpen] = useState(false);
  const [csvText, setCsvText] = useState("");

  const [burnAmt,  setBurnAmt]  = useState("");
  const [burnMemo, setBurnMemo] = useState("");
  const [bbFrom,   setBbFrom]   = useState("");
  const [bbAmt,    setBbAmt]    = useState("");

  // ── Form state — Policy ───────────────────────────────────────────────────
  const [policyScope, setPolicyScope] = useState<PolicyScopeKey>("transferSender");
  const [policyId,    setPolicyId]    = useState("");

  // ── Form state — Roles ────────────────────────────────────────────────────
  const [roleOp,   setRoleOp]   = useState<"grant" | "revoke">("grant");
  const [roleKey,  setRoleKey]  = useState("MINT_ROLE");
  const [roleAddr, setRoleAddr] = useState("");

  // ── Form state — Supply cap ───────────────────────────────────────────────
  const [capAmt,      setCapAmt]     = useState("");
  const [capUncapped, setCapUncapped]= useState(false);

  // ── Form state — Metadata ─────────────────────────────────────────────────
  const [metaField, setMetaField] = useState<"name" | "symbol" | "uri">("name");
  const [metaValue, setMetaValue] = useState("");

  // ── Form state — Transfer ─────────────────────────────────────────────────
  const [xferTo,  setXferTo]  = useState("");
  const [xferAmt, setXferAmt] = useState("");

  // ── Form state — Check Memo (read-only RPC lookup, no signing) ─────────────
  const [memoTx,      setMemoTx]      = useState("");
  const [memoLoading, setMemoLoading] = useState(false);
  const [memoResult,  setMemoResult]  = useState<{
    found: boolean; memo: string; caller: string | null; txUrl?: string;
    status: "found" | "no_memo" | "pending" | "invalid";
  } | null>(null);
  const [memoErr,     setMemoErr]     = useState("");

  function isTxHash(v: string) { return /^0x[a-fA-F0-9]{64}$/.test(v.trim()); }

  async function lookupMemo(hashArg?: string) {
    const hash = (hashArg ?? memoTx).trim();
    if (hashArg) setMemoTx(hashArg);
    setMemoResult(null); setMemoErr("");
    if (!isTxHash(hash)) { setMemoErr("Invalid tx hash"); return; }
    setMemoLoading(true);
    try {
      const res = await fetch("/api/b20/memo", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ txHash: hash, network: network === "mainnet" ? "base" : "baseSepolia" }),
      });
      const d = await res.json();
      if (!res.ok) { setMemoErr(d?.error ?? "Lookup failed"); return; }
      setMemoResult({ found: !!d.found, memo: d.memo ?? "", caller: d.caller ?? null, txUrl: d.txUrl, status: d.status });
    } catch (e) {
      setMemoErr((e as Error)?.message ?? "Lookup failed");
    } finally {
      setMemoLoading(false);
    }
  }

  // ── Role-gating ───────────────────────────────────────────────────────────
  const r = roles.roles;
  const held = {
    isAdmin:      !!r.find(x => x.roleKey === "DEFAULT_ADMIN_ROLE")?.held,
    canMint:      !!r.find(x => x.roleKey === "MINT_ROLE")?.held,
    canBurn:      !!r.find(x => x.roleKey === "BURN_ROLE")?.held,
    canBurnBlock: !!r.find(x => x.roleKey === "BURN_BLOCKED_ROLE")?.held,
    canPause:     !!r.find(x => x.roleKey === "PAUSE_ROLE")?.held,
    canUnpause:   !!r.find(x => x.roleKey === "UNPAUSE_ROLE")?.held,
    canMetadata:  !!r.find(x => x.roleKey === "METADATA_ROLE")?.held,
    hasBalance:   BigInt(balance) > 0n,
  };

  // Map roleKey → bytes32 hash (from roles result)
  const roleHashes: Record<string, string | null> = Object.fromEntries(
    r.map(x => [x.roleKey, x.hash])
  );

  const decimals = inspect.decimals ?? 18;
  const symbol   = inspect.symbol ?? "";
  const balFmt   = formatUnits(BigInt(balance), decimals);

  // ── Derived — Batch Mint ──────────────────────────────────────────────────
  // Only fully-valid rows (address + positive amount) are counted/submitted.
  const batchValidRows = batchRows.filter(row => isAddr(row.to) && isAmt(row.amount));
  let batchTotalWei = 0n;
  try {
    for (const row of batchValidRows) batchTotalWei += parseUnits(row.amount.trim(), decimals);
  } catch { batchTotalWei = 0n; }
  const batchTotalFmt = formatUnits(batchTotalWei, decimals);

  // ── Derived — supply-cap headroom, ONE derivation for BOTH mint forms ──────
  //
  // A mint is gated by the cap exactly the way a swap is gated by a balance, so
  // it resolves through the same three-outcome verdict. What used to be here was
  // `remaining != null && total > remaining`, which is FALSE when the cap could
  // not be read — the read failing ENABLED the button and sent the user to pay
  // gas for a mint that reverts. Same shape as the send/swap/bridge cards, one
  // value along: it is not the balance that is unread, it is the cap.
  //
  // `supplyCap`/`totalSupply` are `undefined` ONLY on a failed multicall entry:
  // both live on the standard B20 read ABI, and both render sites gate on
  // `inspect.isB20`, so the function is always there. Undefined means the RPC
  // did not answer — which a refresh can fix — not "this token has no cap".
  // Note `supplyCapUncapped` is FALSE in that case too, so it cannot stand in
  // for "no limit"; the unread case has to be named separately.
  //
  // `live*` because the Update-supply-cap form below owns `capAmt`/`capUncapped`
  // — that pair is what the admin WANTS the cap to become. These two are what
  // the chain says it is right now, and confusing the two would gate a mint on
  // an unsubmitted form field.
  const liveCapUncapped = inspect.supplyCapUncapped === true;
  const liveCapUnread   = !liveCapUncapped && (inspect.supplyCap == null || inspect.totalSupply == null);
  const capRemainingWei: bigint | null =
    liveCapUncapped || liveCapUnread ? null : BigInt(inspect.supplyCap!) - BigInt(inspect.totalSupply!);
  /**
   * The verdict for minting `amountWei`. `loading`/`received` are fixed because
   * `inspect` arrives here already resolved — B20Client keeps this panel mounted
   * across a refresh, so there is no in-flight state at this level and a
   * "reading" outcome would be a lie. The one signal that varies is whether the
   * cap read landed.
   */
  const capGate = (amountWei: bigint): SpendGate => resolveSpend({
    loading:  false,
    received: true,
    failed:   liveCapUnread,
    over:     capRemainingWei != null && amountWei > capRemainingWei,
  });

  const mintAmtWei = (() => {
    try { return isAmt(mintAmt) ? parseUnits(mintAmt.trim(), decimals) : 0n; }
    catch { return 0n; }
  })();
  const mintCapGate  = capGate(mintAmtWei);
  const batchCapGate = capGate(batchTotalWei);
  const capRemainingFmt = capRemainingWei != null ? formatUnits(capRemainingWei, decimals) : null;

  function addBatchRow() {
    setBatchRows(rows => [...rows, { to: "", amount: "" }]);
  }
  function removeBatchRow(i: number) {
    setBatchRows(rows => (rows.length <= 1 ? rows : rows.filter((_, idx) => idx !== i)));
  }
  function updateBatchRow(i: number, field: "to" | "amount", value: string) {
    setBatchRows(rows => rows.map((row, idx) => (idx === i ? { ...row, [field]: value } : row)));
  }
  /** Parse "address,amount" (comma or whitespace separated) — one per line. Replaces the rows. */
  function applyCsv() {
    const parsed = csvText
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        const [to, amount] = line.split(/[,\s]+/);
        return { to: (to ?? "").trim(), amount: (amount ?? "").trim() };
      });
    if (parsed.length) {
      setBatchRows(parsed);
      setCsvOpen(false);
      setCsvText("");
    }
  }

  // ── Tx executor ───────────────────────────────────────────────────────────

  const isBusy = activeTx?.status === "pending" || activeTx?.status === "polling";

  /**
   * The cap verdict, rendered. A plain function rather than a nested component
   * so it cannot remount its subtree on every keystroke. `"ok"` and `"reading"`
   * render nothing — `"reading"` is unreachable here (see `capGate`) and is left
   * to the exhaustive switch rather than assumed away.
   */
  function capNotice(gate: SpendGate) {
    if (gate === "unverified") {
      return (
        <UnverifiedBalance
          subject="this token's supply cap"
          disclaimer="This says nothing about how much headroom the token has."
          onRetry={onRefresh}
          busy={isBusy}
        />
      );
    }
    if (gate === "insufficient" && capRemainingFmt != null) {
      return (
        <p className="font-mono text-[9px] text-[#EF4444]">
          ⚠ Exceeds remaining supply-cap headroom ({capRemainingFmt} {symbol}). The tx would revert.
        </p>
      );
    }
    return null;
  }

  async function exec(actionLabel: string, data: `0x${string}`, successMsg?: string) {
    if (!address || isBusy) return;
    setActiveTx({ action: actionLabel, status: "pending" });
    try {
      if (currentChainId !== chainId) {
        await switchChainAsync({ chainId });
      }
      const hash = await sendTransactionAsync({
        to: token as `0x${string}`, data, value: 0n, chainId,
      });
      setActiveTx({ action: actionLabel, status: "polling", hash });
      for (let i = 0; i < 30; i++) {
        await new Promise(res => setTimeout(res, 3000));
        const rec = await fetch("/api/b20/receipt", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tx_hash: hash, network }),
        }).then(res => res.json());
        if (rec.ok && rec.status === "success") {
          setActiveTx({ action: actionLabel, status: "success", hash, msg: successMsg });
          onRefresh();
          return;
        }
        if (rec.ok && rec.status === "reverted") {
          throw new Error("Transaction reverted. Possible causes: paused, policy restriction, supply cap exceeded, or insufficient balance.");
        }
      }
      throw new Error("Timeout — tx may still confirm. Check Basescan for the tx hash above.");
    } catch (e) {
      setActiveTx(prev => prev
        ? { ...prev, status: "error", error: (e as Error).message }
        : null
      );
    }
  }

  function dangerous(msg: string, consequence: string, run: () => void) {
    setConfirm({ msg, consequence, run });
  }

  // ── Pause feature rows ────────────────────────────────────────────────────

  const features = [
    { label: "TRANSFER", idx: PAUSE_FEATURE.TRANSFER, paused: !!inspect.paused?.transfer },
    { label: "MINT",     idx: PAUSE_FEATURE.MINT,     paused: !!inspect.paused?.mint     },
    { label: "BURN",     idx: PAUSE_FEATURE.BURN,     paused: !!inspect.paused?.burn     },
  ];

  // ── Render ────────────────────────────────────────────────────────────────

  if (!address) {
    return (
      <div className="rounded-2xl border border-[#1A1A2E] px-5 py-8 text-center space-y-3">
        <div>
          <p className="font-mono text-sm text-slate-400 mb-1">Connect wallet to manage this token</p>
          <p className="font-mono text-xs text-slate-700">
            Actions are role-gated — only shown for roles your wallet holds.
          </p>
        </div>
        <ConnectButton label="Connect Wallet" />
      </div>
    );
  }

  const hasAnyRole = Object.values(held).some(Boolean);

  if (!hasAnyRole) {
    return (
      <div className="rounded-2xl border border-[#1A1A2E] px-5 py-8 text-center">
        <p className="font-mono text-sm text-slate-400 mb-2">No management roles detected</p>
        <p className="font-mono text-xs text-slate-600 leading-relaxed">
          Your wallet ({address.slice(0, 8)}…{address.slice(-4)}) does not hold any of the 7 B20 roles
          on this token. Switch to the issuer wallet to manage.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">

      {/* ── WALLET HEADER + BALANCE ────────────────────────────────────────── */}
      <div className="rounded-xl border border-[#1A1A2E] bg-[#0a0a0f] px-4 py-3 space-y-2">
        {/* Address + balance row */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[9px] text-slate-600">Connected:</span>
          <span className="font-mono text-[9px] text-slate-400">{address.slice(0, 10)}…{address.slice(-4)}</span>
          <span className="mx-1 text-slate-700">·</span>
          <span className="font-mono text-[9px] text-slate-600">Balance:</span>
          <span className="font-mono text-[11px] font-semibold text-white">
            {balFmt} <span className="text-[#4FC3F7]">{symbol}</span>
          </span>
        </div>

        {/* Roles (hidden in compact to save space) */}
        {!compact && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-[9px] text-slate-600">Roles:</span>
            {held.isAdmin      && <span className="font-mono text-[8px] px-1.5 py-0.5 rounded bg-[#4FC3F710] text-[#4FC3F7] border border-[#4FC3F720]">ADMIN</span>}
            {held.canMint      && <span className="font-mono text-[8px] px-1.5 py-0.5 rounded bg-[#22C55E10] text-[#22C55E] border border-[#22C55E20]">MINT</span>}
            {held.canBurn      && <span className="font-mono text-[8px] px-1.5 py-0.5 rounded bg-[#F59E0B10] text-[#F59E0B] border border-[#F59E0B20]">BURN</span>}
            {held.canBurnBlock && <span className="font-mono text-[8px] px-1.5 py-0.5 rounded bg-[#EF444410] text-[#EF4444] border border-[#EF444420]">BURN_BLOCKED</span>}
            {held.canPause     && <span className="font-mono text-[8px] px-1.5 py-0.5 rounded bg-[#F59E0B10] text-[#F59E0B] border border-[#F59E0B20]">PAUSE</span>}
            {held.canUnpause   && <span className="font-mono text-[8px] px-1.5 py-0.5 rounded bg-[#22C55E10] text-[#22C55E] border border-[#22C55E20]">UNPAUSE</span>}
            {held.canMetadata  && <span className="font-mono text-[8px] px-1.5 py-0.5 rounded bg-[#4FC3F710] text-[#4FC3F7] border border-[#4FC3F720]">METADATA</span>}
            {held.hasBalance   && <span className="font-mono text-[8px] px-1.5 py-0.5 rounded bg-[#ffffff08] text-slate-400 border border-[#ffffff10]">HOLDER</span>}
          </div>
        )}
      </div>

      {/* In-progress indicator (visible during pending/polling) */}
      {activeTx && <TxProgress tx={activeTx} />}

      {/* ── COMMON ACTIONS (grouped on top) ─────────────────────────────── */}
      <Section title="Common actions" icon="⚡" visible={true}>

        {/* Mint */}
        {held.canMint && (
          <div className="space-y-2">
            <p className={LABEL}>Mint — MINT_ROLE</p>
            <p className={DESC}>Create new tokens and send them to an address. Increases total supply.</p>
            {inspect.paused?.mint && (
              <p className="font-mono text-[9px] text-[#F59E0B] mb-1">⚠ Mint is currently paused</p>
            )}
            <div className="grid grid-cols-2 gap-2">
              <div>
                <p className={LABEL}>Recipient</p>
                <input value={mintTo} onChange={e => setMintTo(e.target.value)}
                  placeholder="0x…" spellCheck={false} className={INPUT} />
              </div>
              <div>
                <p className={LABEL}>Amount ({symbol})</p>
                <input value={mintAmt} onChange={e => setMintAmt(e.target.value)}
                  placeholder="0.0" spellCheck={false} className={INPUT} />
              </div>
            </div>
            <MemoField value={mintMemo} onChange={setMintMemo} disabled={isBusy} />
            {/* Same cap verdict as Batch Mint below. This form had NO cap gate at
                all — an absent gate is invisible to any idiom-based check, so it
                survived every sweep that found the fail-open one next door. */}
            {capNotice(mintCapGate)}
            <button
              disabled={!isAddr(mintTo) || !isAmt(mintAmt) || memoTooLong(mintMemo) || mintCapGate !== "ok" || isBusy}
              onClick={() => exec(
                "Mint",
                isValidMemo(mintMemo)
                  ? encodeMintWithMemo({ to: mintTo, amount: mintAmt, decimals, memo: mintMemo })
                  : encodeFunctionData({
                      abi: B20_WRITE_ABI, functionName: "mint",
                      args: [mintTo as `0x${string}`, parseUnits(mintAmt, decimals)],
                    }),
                `Minted ${mintAmt} ${symbol} to ${mintTo.slice(0, 8)}…${isValidMemo(mintMemo) ? ` · memo "${mintMemo.trim()}"` : ""}`,
              )}
              className="font-mono text-xs px-4 py-2 rounded-xl transition-all disabled:opacity-40"
              style={{ background: "#22C55E15", color: "#22C55E", border: "1px solid #22C55E30" }}>
              Mint →
            </button>
          </div>
        )}

        {/* Batch Mint — batchMint(address[], uint256[]), MINT_ROLE gated.
            No WithMemo variant exists for batchMint; the announce() wrapper from
            the spec was intentionally skipped (no verified ABI in the codebase). */}
        {held.canMint && (
          <div className="space-y-2 pt-3 border-t border-[#0d0d18]">
            <p className={LABEL}>Batch Mint — MINT_ROLE</p>
            <p className={DESC}>Mint to many recipients in a single transaction. Cheaper than separate mints and all-or-nothing — if one recipient is blocked by policy, the whole tx reverts.</p>
            {inspect.paused?.mint && (
              <p className="font-mono text-[9px] text-[#F59E0B] mb-1">⚠ Mint is currently paused</p>
            )}

            {/* Recipient rows */}
            <div className="space-y-1.5">
              {batchRows.map((row, i) => (
                <div key={i} className="flex gap-1.5 items-start">
                  <input value={row.to} onChange={e => updateBatchRow(i, "to", e.target.value)}
                    placeholder="0x… recipient" spellCheck={false}
                    className={`flex-[2] ${INPUT}${row.to && !isAddr(row.to) ? " border-[#EF444450]" : ""}`} />
                  <input value={row.amount} onChange={e => updateBatchRow(i, "amount", e.target.value)}
                    placeholder="0.0" spellCheck={false}
                    className={`flex-1 ${INPUT}${row.amount && !isAmt(row.amount) ? " border-[#EF444450]" : ""}`} />
                  <button onClick={() => removeBatchRow(i)} disabled={batchRows.length <= 1}
                    title="Remove recipient"
                    className="font-mono text-xs px-2.5 py-2 rounded-xl text-slate-600 hover:text-[#EF4444] disabled:opacity-30 transition-colors shrink-0">
                    ✕
                  </button>
                </div>
              ))}
            </div>

            {/* Add / CSV controls */}
            <div className="flex gap-2">
              <button onClick={addBatchRow}
                className="font-mono text-[10px] px-3 py-1.5 rounded-lg border border-[#1A1A2E] text-slate-400 hover:text-[#22C55E] hover:border-[#22C55E30] transition-colors">
                + Add recipient
              </button>
              <button onClick={() => setCsvOpen(v => !v)}
                className="font-mono text-[10px] px-3 py-1.5 rounded-lg border border-[#1A1A2E] text-slate-400 hover:text-[#4FC3F7] hover:border-[#4FC3F730] transition-colors">
                📋 Paste CSV
              </button>
            </div>

            {/* CSV paste */}
            {csvOpen && (
              <div className="space-y-1.5">
                <p className={DESC + " mb-0"}>
                  One <span className="text-slate-400">address,amount</span> per line (comma or space separated). Replaces the rows above.
                </p>
                <textarea value={csvText} onChange={e => setCsvText(e.target.value)}
                  rows={4} spellCheck={false}
                  placeholder={"0xabc…,100\n0xdef…,250"}
                  className={INPUT + " resize-y"} />
                <button onClick={applyCsv} disabled={!csvText.trim()}
                  className="font-mono text-[10px] px-3 py-1.5 rounded-lg transition-colors disabled:opacity-40"
                  style={{ background: "#4FC3F715", color: "#4FC3F7", border: "1px solid #4FC3F730" }}>
                  Apply CSV
                </button>
              </div>
            )}

            {/* Total + cap headroom */}
            {batchValidRows.length > 0 && (
              <div className="flex items-center justify-between rounded-xl border border-[#1A1A2E] bg-[#0a0a0f] px-3 py-2">
                <span className="font-mono text-[9px] text-slate-600">
                  {batchValidRows.length} recipient{batchValidRows.length === 1 ? "" : "s"}
                </span>
                <span className="font-mono text-[11px] font-semibold text-white">
                  Total {batchTotalFmt} <span className="text-[#4FC3F7]">{symbol}</span>
                </span>
              </div>
            )}
            {capNotice(batchCapGate)}

            <button
              disabled={batchValidRows.length === 0 || batchCapGate !== "ok" || isBusy}
              onClick={() => exec(
                "Batch Mint",
                encodeFunctionData({
                  abi: B20_WRITE_ABI, functionName: "batchMint",
                  args: [
                    batchValidRows.map(row => row.to.trim() as `0x${string}`),
                    batchValidRows.map(row => parseUnits(row.amount.trim(), decimals)),
                  ],
                }),
                `Batch minted ${batchTotalFmt} ${symbol} to ${batchValidRows.length} recipient${batchValidRows.length === 1 ? "" : "s"}`,
              )}
              className="font-mono text-xs px-4 py-2 rounded-xl transition-all disabled:opacity-40"
              style={{ background: "#22C55E15", color: "#22C55E", border: "1px solid #22C55E30" }}>
              Batch Mint →{batchValidRows.length > 0 ? ` (${batchValidRows.length})` : ""}
            </button>
          </div>
        )}

        {/* Transfer */}
        {held.hasBalance && (
          <div className={`space-y-2${held.canMint ? " pt-3 border-t border-[#0d0d18]" : ""}`}>
            <p className={LABEL}>Transfer</p>
            <p className={DESC}>Send your tokens to another address. Subject to transfer policy and pause state.</p>
            {inspect.paused?.transfer && (
              <p className="font-mono text-[9px] text-[#F59E0B]">⚠ Transfers are currently paused</p>
            )}
            <div className="grid grid-cols-2 gap-2">
              <div>
                <p className={LABEL}>To</p>
                <input value={xferTo} onChange={e => setXferTo(e.target.value)}
                  placeholder="0x…" spellCheck={false} className={INPUT} />
              </div>
              <div>
                <p className={LABEL}>Amount ({symbol})</p>
                <input value={xferAmt} onChange={e => setXferAmt(e.target.value)}
                  placeholder="0.0" spellCheck={false} className={INPUT} />
              </div>
            </div>
            <button
              disabled={!isAddr(xferTo) || !isAmt(xferAmt) || isBusy}
              onClick={() => exec(
                "Transfer",
                encodeFunctionData({
                  abi: B20_WRITE_ABI, functionName: "transfer",
                  args: [xferTo as `0x${string}`, parseUnits(xferAmt, decimals)],
                }),
                `Transferred ${xferAmt} ${symbol} to ${xferTo.slice(0, 8)}…`,
              )}
              className="font-mono text-xs px-4 py-2 rounded-xl transition-all disabled:opacity-40"
              style={{ background: "#4FC3F715", color: "#4FC3F7", border: "1px solid #4FC3F730" }}>
              Transfer →
            </button>
          </div>
        )}

        {/* Check Memo — read-only lookup of the onchain Memo event on a tx hash */}
        <div className={`space-y-2${held.canMint || held.hasBalance ? " pt-3 border-t border-[#0d0d18]" : ""}`}>
          <p className={LABEL + " text-[#A78BFA]"}>🔖 Check Memo</p>
          <p className={DESC}>
            Read the memo attached to a B20 transaction (mint/burn/transfer WithMemo). No signing — just an RPC lookup.
          </p>
          <div>
            <p className={LABEL}>Tx Hash</p>
            <input
              value={memoTx}
              onChange={e => { setMemoTx(e.target.value); setMemoResult(null); setMemoErr(""); }}
              placeholder="0x… (66 chars)"
              spellCheck={false}
              className={INPUT}
            />
          </div>
          <button
            disabled={!isTxHash(memoTx) || memoLoading}
            onClick={() => lookupMemo()}
            className="font-mono text-xs px-4 py-2 rounded-xl transition-all disabled:opacity-40"
            style={{ background: "#A78BFA15", color: "#A78BFA", border: "1px solid #A78BFA30" }}>
            {memoLoading ? "Checking…" : "Check Memo →"}
          </button>

          {/* Error state */}
          {memoErr && !memoLoading && (
            <p className="font-mono text-[10px] text-[#EF4444]">⚠ {memoErr}</p>
          )}

          {/* Result */}
          {memoResult && !memoLoading && (
            memoResult.found ? (
              <div className="rounded-xl border border-[#A78BFA30] bg-[#A78BFA08] px-3 py-2 space-y-1">
                <p className="font-mono text-xs text-[#A78BFA] break-all">✓ Memo: {memoResult.memo}</p>
                {memoResult.caller && (
                  <p className="font-mono text-[10px] text-slate-500">
                    Caller {memoResult.caller.slice(0, 8)}…{memoResult.caller.slice(-6)}
                  </p>
                )}
                {memoResult.txUrl && (
                  <a href={memoResult.txUrl} target="_blank" rel="noopener noreferrer"
                    className="inline-block font-mono text-[10px] text-slate-400 hover:text-[#A78BFA]">
                    View tx ↗
                  </a>
                )}
              </div>
            ) : (
              <p className="font-mono text-[10px] text-slate-500">
                {memoResult.status === "pending"
                  ? "Transaction not found or not yet mined on this network."
                  : "No memo found in this transaction."}
              </p>
            )
          )}
        </div>
      </Section>

      {/* ── SUPPLY (burn / seize) ───────────────────────────────────────── */}
      <Section title="Supply" icon="🔥" color="#F59E0B"
        visible={held.canBurn || held.canBurnBlock}>

        {/* Burn */}
        {held.canBurn && (
          <div className="space-y-2">
            <p className={LABEL}>Burn (from your balance) — BURN_ROLE</p>
            <p className={DESC}>Destroy tokens from your own balance. Decreases total supply.</p>
            {inspect.paused?.burn && (
              <p className="font-mono text-[9px] text-[#F59E0B] mb-1">⚠ Burn is currently paused</p>
            )}
            <div className="flex gap-2">
              <input value={burnAmt} onChange={e => setBurnAmt(e.target.value)}
                placeholder={`Amount in ${symbol}`} spellCheck={false}
                className={`flex-1 ${INPUT}`} />
              <button
                disabled={!isAmt(burnAmt) || memoTooLong(burnMemo) || isBusy}
                onClick={() => exec(
                  "Burn",
                  isValidMemo(burnMemo)
                    ? encodeBurnWithMemo({ amount: burnAmt, decimals, memo: burnMemo })
                    : encodeFunctionData({
                        abi: B20_WRITE_ABI, functionName: "burn",
                        args: [parseUnits(burnAmt, decimals)],
                      }),
                  `Burned ${burnAmt} ${symbol}${isValidMemo(burnMemo) ? ` · memo "${burnMemo.trim()}"` : ""}`,
                )}
                className="font-mono text-xs px-4 py-2 rounded-xl transition-all disabled:opacity-40"
                style={{ background: "#F59E0B15", color: "#F59E0B", border: "1px solid #F59E0B30" }}>
                Burn →
              </button>
            </div>
            <MemoField value={burnMemo} onChange={setBurnMemo} disabled={isBusy} />
          </div>
        )}

        {/* Burn Blocked */}
        {held.canBurnBlock && (
          <div className="space-y-2 pt-2 border-t border-[#0d0d18]">
            <p className={LABEL}>Burn Blocked (seize) — BURN_BLOCKED_ROLE</p>
            <p className={DESC}>Seize and destroy tokens from a blocklisted address without their consent.</p>
            <div className="rounded-xl border border-[#EF444430] bg-[#EF444408] px-3 py-2 mb-2">
              <p className="font-mono text-[9px] text-[#EF4444] leading-relaxed">
                <strong>Forcibly confiscates tokens from any holder.</strong> Irreversible.
                Use only for regulatory / compliance enforcement.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <p className={LABEL}>From Address</p>
                <input value={bbFrom} onChange={e => setBbFrom(e.target.value)}
                  placeholder="0x…" spellCheck={false} className={INPUT} />
              </div>
              <div>
                <p className={LABEL}>Amount ({symbol})</p>
                <input value={bbAmt} onChange={e => setBbAmt(e.target.value)}
                  placeholder="0.0" spellCheck={false} className={INPUT} />
              </div>
            </div>
            <button
              disabled={!isAddr(bbFrom) || !isAmt(bbAmt) || isBusy}
              onClick={() => dangerous(
                "Seize tokens from holder?",
                `This burns ${bbAmt} ${symbol} from ${bbFrom.slice(0, 10)}… without their consent. This action cannot be undone.`,
                () => exec(
                  "Burn Blocked",
                  encodeFunctionData({
                    abi: B20_WRITE_ABI, functionName: "burnBlocked",
                    args: [bbFrom as `0x${string}`, parseUnits(bbAmt, decimals)],
                  }),
                  `Seized ${bbAmt} ${symbol} from ${bbFrom.slice(0, 8)}…`,
                ),
              )}
              className="font-mono text-xs px-4 py-2 rounded-xl transition-all disabled:opacity-40"
              style={{ background: "#EF444415", color: "#EF4444", border: "1px solid #EF444430" }}>
              Seize Tokens →
            </button>
          </div>
        )}
      </Section>

      {/* ── PAUSE ───────────────────────────────────────────────────────── */}
      <Section title="Pause / Unpause" icon="⏸" color="#F59E0B"
        visible={held.canPause || held.canUnpause}>

        <p className={DESC}>Pause or unpause TRANSFER, MINT, and BURN independently. Paused operations revert until unpaused.</p>
        <div className="space-y-2">
          {features.map(f => (
            <div key={f.label} className="flex items-center justify-between py-2 border-b border-[#0d0d18] last:border-0">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full shrink-0"
                  style={{ background: f.paused ? "#EF4444" : "#22C55E",
                           boxShadow:  f.paused ? "0 0 4px #EF444480" : "0 0 4px #22C55E80" }} />
                <span className="font-mono text-xs text-slate-300">{f.label}</span>
                <span className="font-mono text-[9px]" style={{ color: f.paused ? "#EF4444" : "#22C55E" }}>
                  {f.paused ? "paused" : "active"}
                </span>
              </div>
              <div className="flex gap-1.5">
                {held.canPause && !f.paused && (
                  <button
                    disabled={isBusy}
                    onClick={() => exec(
                      `Pause ${f.label}`,
                      encodeFunctionData({
                        abi: B20_WRITE_ABI, functionName: "pause",
                        args: [[f.idx]],
                      }),
                      `Paused ${f.label}`,
                    )}
                    className="font-mono text-[9px] px-3 py-1 rounded-lg transition-all disabled:opacity-40"
                    style={{ background: "#EF444415", color: "#EF4444", border: "1px solid #EF444430" }}>
                    Pause
                  </button>
                )}
                {held.canUnpause && f.paused && (
                  <button
                    disabled={isBusy}
                    onClick={() => exec(
                      `Unpause ${f.label}`,
                      encodeFunctionData({
                        abi: B20_WRITE_ABI, functionName: "unpause",
                        args: [[f.idx]],
                      }),
                      `Unpaused ${f.label}`,
                    )}
                    className="font-mono text-[9px] px-3 py-1 rounded-lg transition-all disabled:opacity-40"
                    style={{ background: "#22C55E15", color: "#22C55E", border: "1px solid #22C55E30" }}>
                    Unpause
                  </button>
                )}
                {held.canPause && !held.canUnpause && f.paused && (
                  <span className="font-mono text-[9px] text-slate-700">need UNPAUSE_ROLE</span>
                )}
                {!held.canPause && held.canUnpause && !f.paused && (
                  <span className="font-mono text-[9px] text-slate-700">need PAUSE_ROLE</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </Section>

      {/* ── POLICY (compact hidden) ─────────────────────────────────────── */}
      {!compact && (
        <Section title="Policy" icon="🔐" visible={held.isAdmin}>
          <div className="space-y-2">
            <p className={DESC}>Gate who can send, receive, or be minted to via allowlist / blocklist. Policy IDs live in the PolicyRegistry at 0x8453…0002. Policy ID 0 = ALWAYS_ALLOW (no restriction).</p>
            <div>
              <p className={LABEL}>Scope</p>
              <select value={policyScope}
                onChange={e => setPolicyScope(e.target.value as PolicyScopeKey)}
                className="w-full bg-[#0a0a12] border border-[#1A1A2E] rounded-xl px-3 py-2 font-mono text-xs text-slate-200 outline-none">
                {POLICY_SCOPE_KEYS.map(k => (
                  <option key={k} value={k}>{POLICY_SCOPE_LABELS[k]}</option>
                ))}
              </select>
            </div>
            <div>
              <p className={LABEL}>Policy ID <span className="text-slate-700 normal-case font-normal">(0 = ALWAYS_ALLOW)</span></p>
              <div className="flex gap-2">
                <input value={policyId} onChange={e => setPolicyId(e.target.value)}
                  placeholder="e.g. 42" spellCheck={false} className={`flex-1 ${INPUT}`} />
                <button
                  disabled={!/^\d+$/.test(policyId.trim()) || isBusy || !scopeHashes[policyScope]}
                  onClick={() => exec(
                    "Update Policy",
                    encodeFunctionData({
                      abi: B20_WRITE_ABI, functionName: "updatePolicy",
                      args: [scopeHashes[policyScope] as `0x${string}`, BigInt(policyId)],
                    }),
                    `Policy updated — ${POLICY_SCOPE_LABELS[policyScope]}`,
                  )}
                  className="font-mono text-xs px-4 py-2 rounded-xl transition-all disabled:opacity-40"
                  style={{ background: "#4FC3F715", color: "#4FC3F7", border: "1px solid #4FC3F730" }}>
                  Update →
                </button>
              </div>
            </div>
          </div>
        </Section>
      )}

      {/* ── ROLES (compact hidden) ──────────────────────────────────────── */}
      {!compact && (
        <Section title="Roles" icon="🔑" visible={held.isAdmin}>
          <div className="space-y-3">
            <p className={DESC}>Give or remove a permission for an address. Roles are bytes32 hashes — use the selector below to pick the correct one.</p>

            {/* Grant / Revoke toggle */}
            <div className="flex rounded-lg border border-[#1A1A2E] overflow-hidden">
              {(["grant", "revoke"] as const).map(op => (
                <button key={op} onClick={() => setRoleOp(op)}
                  className="flex-1 py-1.5 font-mono text-[10px] capitalize transition-colors"
                  style={roleOp === op
                    ? { background: "#4FC3F715", color: "#4FC3F7" }
                    : { color: "#475569" }}>
                  {op} Role
                </button>
              ))}
            </div>
            <div>
              <p className={LABEL}>Role</p>
              <select value={roleKey} onChange={e => setRoleKey(e.target.value)}
                className="w-full bg-[#0a0a12] border border-[#1A1A2E] rounded-xl px-3 py-2 font-mono text-xs text-slate-200 outline-none mb-2">
                {ROLE_DEFS.map(d => (
                  <option key={d.key} value={d.key}>{d.label} ({d.key})</option>
                ))}
              </select>
            </div>
            <div>
              <p className={LABEL}>Address</p>
              <input value={roleAddr} onChange={e => setRoleAddr(e.target.value)}
                placeholder="0x…" spellCheck={false} className={INPUT} />
            </div>
            <button
              disabled={!isAddr(roleAddr) || !roleHashes[roleKey] || isBusy}
              onClick={() => exec(
                roleOp === "grant" ? `Grant ${roleKey}` : `Revoke ${roleKey}`,
                encodeFunctionData({
                  abi: B20_WRITE_ABI,
                  functionName: roleOp === "grant" ? "grantRole" : "revokeRole",
                  args: [roleHashes[roleKey] as `0x${string}`, roleAddr as `0x${string}`],
                }),
                roleOp === "grant"
                  ? `Role granted — ${roleKey} → ${roleAddr.slice(0, 8)}…`
                  : `Role revoked — ${roleKey} from ${roleAddr.slice(0, 8)}…`,
              )}
              className="font-mono text-xs px-4 py-2 rounded-xl transition-all disabled:opacity-40"
              style={roleOp === "grant"
                ? { background: "#22C55E15", color: "#22C55E", border: "1px solid #22C55E30" }
                : { background: "#EF444415", color: "#EF4444", border: "1px solid #EF444430" }}>
              {roleOp === "grant" ? "Grant Role →" : "Revoke Role →"}
            </button>

            {/* Renounce last admin */}
            <div className="pt-3 border-t border-[#0d0d18]">
              <p className="font-mono text-[9px] text-slate-600 mb-2 leading-relaxed">
                <span className="text-[#EF4444]">renounceLastAdmin()</span> — permanently removes
                DEFAULT_ADMIN_ROLE from all holders. The token becomes immutable with no way to
                recover admin control. This is irreversible.
              </p>
              <button
                disabled={isBusy}
                onClick={() => dangerous(
                  "Renounce all admin permanently?",
                  "This calls renounceLastAdmin() and permanently removes DEFAULT_ADMIN_ROLE from all holders. No one can grant roles, update policy, or change supply cap after this. It cannot be undone.",
                  () => exec(
                    "Renounce Admin",
                    encodeFunctionData({
                      abi: B20_WRITE_ABI, functionName: "renounceLastAdmin", args: [],
                    }),
                    "Admin renounced — token is now immutable",
                  ),
                )}
                className="font-mono text-xs px-4 py-2 rounded-xl transition-all disabled:opacity-40"
                style={{ background: "#EF444415", color: "#EF4444", border: "1px solid #EF444430" }}>
                Renounce Last Admin →
              </button>
            </div>
          </div>
        </Section>
      )}

      {/* ── SUPPLY CAP (compact hidden) ─────────────────────────────────── */}
      {!compact && (
        <Section title="Supply Cap" icon="📊" visible={held.isAdmin}>
          <div className="space-y-2">
            <p className={DESC}>Set the maximum tokens that can ever exist. Uncapped (uint128.max) means no limit — issuers can mint freely.</p>
            {inspect.supplyCapFormatted && (
              <p className="font-mono text-[9px] text-slate-500">
                Current cap: <span className="text-slate-300">{inspect.supplyCapFormatted} {symbol}</span>
                {inspect.supplyCapUncapped && " (uncapped)"}
              </p>
            )}
            <div className="flex items-center gap-2">
              <input type="checkbox" id="cap-uncapped" checked={capUncapped}
                onChange={e => setCapUncapped(e.target.checked)}
                className="accent-[#4FC3F7]" />
              <label htmlFor="cap-uncapped" className="font-mono text-[10px] text-slate-400 cursor-pointer">
                Set uncapped (uint128.max)
              </label>
            </div>
            {!capUncapped && (
              <input value={capAmt} onChange={e => setCapAmt(e.target.value)}
                placeholder={`New cap in ${symbol}`} spellCheck={false} className={INPUT} />
            )}
            <button
              disabled={(!capUncapped && !isAmt(capAmt)) || isBusy}
              onClick={() => {
                const newCap = capUncapped ? SUPPLY_CAP_MAX : parseUnits(capAmt, decimals);
                exec(
                  "Update Supply Cap",
                  encodeFunctionData({
                    abi: B20_WRITE_ABI, functionName: "updateSupplyCap",
                    args: [newCap],
                  }),
                  capUncapped ? "Supply cap removed (uncapped)" : `Supply cap set to ${capAmt} ${symbol}`,
                );
              }}
              className="font-mono text-xs px-4 py-2 rounded-xl transition-all disabled:opacity-40"
              style={{ background: "#4FC3F715", color: "#4FC3F7", border: "1px solid #4FC3F730" }}>
              Update Cap →
            </button>
          </div>
        </Section>
      )}

      {/* ── METADATA (compact hidden) ───────────────────────────────────── */}
      {!compact && (
        <Section title="Metadata" icon="✏️" visible={held.canMetadata}>
          <div className="space-y-2">
            <p className={DESC}>Update token name, symbol, or contract URI. Changes are reflected on explorers after the next indexer update.</p>
            <div>
              <p className={LABEL}>Field</p>
              <div className="flex rounded-lg border border-[#1A1A2E] overflow-hidden mb-2">
                {(["name", "symbol", "uri"] as const).map(f => (
                  <button key={f} onClick={() => setMetaField(f)}
                    className="flex-1 py-1.5 font-mono text-[10px] capitalize transition-colors"
                    style={metaField === f ? { background: "#4FC3F715", color: "#4FC3F7" } : { color: "#475569" }}>
                    {f === "uri" ? "Contract URI" : f}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <p className={LABEL}>New value</p>
              <input value={metaValue} onChange={e => setMetaValue(e.target.value)}
                placeholder={metaField === "name" ? "Token Name" : metaField === "symbol" ? "SYMBOL" : "ipfs://…"}
                spellCheck={false} className={INPUT} />
            </div>
            <button
              disabled={!metaValue.trim() || isBusy}
              onClick={() => {
                const fn =
                  metaField === "name"   ? "updateName" :
                  metaField === "symbol" ? "updateSymbol" :
                  "updateContractURI";
                const label = metaField === "uri" ? "URI" : metaField.charAt(0).toUpperCase() + metaField.slice(1);
                exec(
                  `Update ${label}`,
                  encodeFunctionData({ abi: B20_WRITE_ABI, functionName: fn, args: [metaValue.trim()] }),
                  `Token ${label.toLowerCase()} updated`,
                );
              }}
              className="font-mono text-xs px-4 py-2 rounded-xl transition-all disabled:opacity-40"
              style={{ background: "#4FC3F715", color: "#4FC3F7", border: "1px solid #4FC3F730" }}>
              Update {metaField === "uri" ? "URI" : metaField.charAt(0).toUpperCase() + metaField.slice(1)} →
            </button>
          </div>
        </Section>
      )}

      {/* Success / error toast (fixed bottom-right) */}
      {activeTx && (
        <Toast tx={activeTx} explorerBase={explorerBase}
          onDismiss={() => setActiveTx(null)}
          onCheckMemo={(hash) => {
            setActiveTx(null);
            lookupMemo(hash);
            if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
          }}
        />
      )}

      {/* Confirm dialog */}
      {confirm && (
        <ConfirmDialog
          msg={confirm.msg}
          consequence={confirm.consequence}
          onConfirm={() => { setConfirm(null); confirm.run(); }}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
