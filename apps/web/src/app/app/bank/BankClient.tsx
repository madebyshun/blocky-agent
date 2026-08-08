"use client";

// BlueBank dashboard — responsive grid layout: sidebar | grid content.
// Non-custodial Base neobank: real on-chain balances (wagmi), live yield rates
// (DefiLlama), real transactions (Moralis). Nothing is fabricated.

import { useState, useEffect, useRef, useMemo } from "react";
import { useAccount, useReadContract, useBalance } from "wagmi";
import { useWalletDisconnect } from "@/lib/walletSession";
import { useWallet } from "@/hooks/useWallet";
import { formatUnits } from "viem";
import { QRCodeSVG } from "qrcode.react";
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from "recharts";
import {
  YIELD_NETWORKS, ERC20_ABI, AAVE_POOL_ABI, ERC4626_ABI, VENUES, supplyApyPct,
  type YieldNetwork,
} from "@/lib/yield-execution";
import { MoveToYieldCard, SendCard } from "@/app/chat/components/ToolCards";
import { useBasename, shortAddr } from "@/lib/useBasename";
import QrScanner from "./QrScanner";
import SwapCard from "./SwapCard";
import { parsePaymentQr, buildPaymentUri, type ParsedPayment } from "@/lib/payment-qr";
import OrdersPanel from "./OrdersPanel";
import { B20_ENABLED } from "@/lib/orders";
import TransactionHistory, { type WalletTx } from "./TransactionHistory";
import { buildWalletState } from "@/lib/state";

const usd = (n: number | null | undefined) =>
  n == null ? "—" : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const CAMPAIGNS: { name: string; desc: string; badge: string; color: string }[] = [
  { name: "Base Ecosystem Fund", desc: "Builder grants — up to $50K", badge: "OPEN", color: "#4FC3F7" },
  { name: "Morpho Boost", desc: "+0.5% APY on USDC deposits", badge: "LIVE", color: "#A78BFA" },
];

type Panel = "positions" | "earn" | "send" | "receive" | "convert" | "orders";

export default function BankPage() {
  const { address, isConnected } = useAccount();
  const acct = address as `0x${string}` | undefined;
  const { name } = useBasename(acct);
  const [fname, setFname] = useState<string | null>(null);
  useEffect(() => {
    if (!acct || name) { setFname(null); return; }
    fetch(`https://hub.pinata.cloud/v1/userDataByVerification?address=${acct}`)
      .then(r => r.json())
      .then(d => {
        const messages = d?.messages ?? [];
        const fid = messages[0]?.data?.fid;
        if (!fid) return;
        return fetch(`https://hub.pinata.cloud/v1/userDataByFid?fid=${fid}&user_data_type=6`)
          .then(r2 => r2.json())
          .then(d2 => {
            const v = d2?.messages?.[0]?.data?.userDataBody?.value;
            if (v) setFname(v);
          });
      })
      .catch(() => null);
  }, [acct, name]);
  const disconnect = useWalletDisconnect();
  const [network, setNetwork] = useState<YieldNetwork>("baseSepolia");
  const [panel, setPanel]     = useState<Panel>("positions");
  const [actionOpen, setActionOpen] = useState(false);
  const [copied, setCopied]   = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const openAction = (p: Panel) => {
    if (p === "send") { setScanPrefill(null); setScanKey(k => k + 1); }
    setPanel(p); setActionOpen(true);
  };

  // Scan-to-pay
  const [scanOpen, setScanOpen] = useState(false);
  const [scanPrefill, setScanPrefill] = useState<ParsedPayment | null>(null);
  const [scanKey, setScanKey] = useState(0);
  function handleScan(text: string): string | void {
    const p = parsePaymentQr(text);
    if (!p || !p.to) return "Not a Base address or payment QR";
    setScanPrefill(p);
    setScanKey(k => k + 1);
    setPanel("send");
    setScanOpen(false);
    setActionOpen(true);
  }

  // Receive request
  const [reqAmount, setReqAmount] = useState("");
  const [reqAsset, setReqAsset] = useState<"USDC" | "ETH">("USDC");

  // Coinbase Onramp — add cash
  const [onrampBusy, setOnrampBusy] = useState(false);
  const [onrampMsg, setOnrampMsg]   = useState("");
  async function addCash() {
    if (!acct) return;
    setOnrampBusy(true); setOnrampMsg("");
    try {
      const j = await fetch(`/api/onramp/session?address=${acct}`).then(r => r.json());
      if (j.needsKey) { setOnrampMsg("Add cash needs a CDP key"); return; }
      if (j.error || !j.sessionToken) { setOnrampMsg(j.error || "couldn't start onramp"); return; }
      const url = `https://pay.coinbase.com/buy/select-asset?sessionToken=${encodeURIComponent(j.sessionToken)}&defaultAsset=USDC&defaultNetwork=base&presetFiatAmount=25&fiatCurrency=USD`;
      window.open(url, "_blank", "popup,width=470,height=720");
    } catch { setOnrampMsg("onramp failed"); }
    finally { setOnrampBusy(false); }
  }

  // Coinbase Offramp — cash out
  const [cashOutBusy, setCashOutBusy] = useState(false);
  async function cashOut() {
    if (!acct) return;
    setCashOutBusy(true); setOnrampMsg("");
    try {
      const j = await fetch(`/api/onramp/session?address=${acct}`).then(r => r.json());
      if (j.needsKey) { setOnrampMsg("Cash out needs a CDP key"); return; }
      if (j.error || !j.sessionToken) { setOnrampMsg(j.error || "couldn't start cash out"); return; }
      const url = `https://pay.coinbase.com/v3/sell/input?sessionToken=${encodeURIComponent(j.sessionToken)}&defaultAsset=USDC&defaultNetwork=base&fiatCurrency=USD`;
      window.open(url, "_blank", "popup,width=470,height=720");
    } catch { setOnrampMsg("cash out failed"); }
    finally { setCashOutBusy(false); }
  }

  const net = YIELD_NETWORKS[network];
  const chainId = net.chainId;
  const morphoVnet = VENUES.morpho.nets[network];

  // ── Live on-chain reads ──────────────────────────────────────────────────
  const { data: walletRaw } = useReadContract({
    address: net.usdc, abi: ERC20_ABI, functionName: "balanceOf",
    args: acct ? [acct] : undefined, chainId, query: { enabled: !!acct },
  });
  const { data: ethRaw } = useBalance({ address: acct, chainId, query: { enabled: !!acct } });
  const { data: aaveRaw } = useReadContract({
    address: net.aUsdc, abi: ERC20_ABI, functionName: "balanceOf",
    args: acct ? [acct] : undefined, chainId, query: { enabled: !!acct },
  });
  const { data: aaveReserve } = useReadContract({
    address: net.pool, abi: AAVE_POOL_ABI, functionName: "getReserveData",
    args: [net.usdc], chainId,
  });
  const { data: morphoRaw } = useReadContract({
    address: morphoVnet?.target, abi: ERC4626_ABI, functionName: "maxWithdraw",
    args: acct ? [acct] : undefined, chainId,
    query: { enabled: !!acct && !!morphoVnet },
  });

  const walletUsdc = walletRaw != null ? Number(formatUnits(walletRaw as bigint, net.usdcDecimals)) : null;
  const ethBal     = ethRaw ? Number(formatUnits(ethRaw.value, ethRaw.decimals)) : null;
  const aavePos    = aaveRaw != null ? Number(formatUnits(aaveRaw as bigint, 6)) : null;
  const morphoPos  = morphoRaw != null ? Number(formatUnits(morphoRaw as bigint, 6)) : null;
  const aaveApy    = aaveReserve ? supplyApyPct((aaveReserve as { currentLiquidityRate: bigint }).currentLiquidityRate) : null;

  // ── Best yield rate (DefiLlama) ──────────────────────────────────────────
  type Rate = { project: string; label: string; apy: number };
  const [rates, setRates] = useState<Rate[] | null>(null);
  useEffect(() => {
    let off = false;
    fetch("/api/yield/rates").then(r => r.json()).then(d => { if (!off) setRates((d?.rates as Rate[]) ?? []); }).catch(() => {});
    return () => { off = true; };
  }, []);
  const bestApy   = rates && rates.length ? rates[0].apy : null;
  const morphoApy = rates?.find(r => r.project === "morpho-blue")?.apy ?? null;

  // Morpho 30d APY sparkline for sidebar
  const [hist, setHist] = useState<{ points: number[]; current: number | null } | null>(null);
  useEffect(() => {
    let off = false;
    fetch("/api/yield/morpho-history").then(r => r.json()).then(d => { if (!off) setHist({ points: d.points ?? [], current: d.current ?? null }); }).catch(() => {});
    return () => { off = true; };
  }, []);

  // ── Real wallet history (Moralis) ────────────────────────────────────────
  type TxStats = { transferCountMonth: number; netFlowUsdcMonth: number; gasSavedUsd: number | null };
  const [txData, setTxData] = useState<{ transactions: WalletTx[]; stats?: TxStats; needsKey?: boolean; error?: string } | null>(null);
  const [txLoading, setTxLoading] = useState(false);
  const [txError, setTxError]     = useState(false);
  const [txReload, setTxReload]   = useState(0);
  useEffect(() => {
    if (!acct) { setTxData(null); return; }
    let off = false;
    setTxLoading(true); setTxError(false);
    fetch(`/api/wallet/transactions?address=${acct}&network=${network}`)
      .then(r => r.json())
      .then(d => { if (!off) { setTxData(d); setTxLoading(false); } })
      .catch(() => { if (!off) { setTxError(true); setTxLoading(false); } });
    return () => { off = true; };
  }, [acct, network, txReload]);

  const inYield = (aavePos ?? 0) + (morphoPos ?? 0);
  const total   = (walletUsdc ?? 0) + inYield;

  // Stats from real wallet history (this calendar month)
  const netFlowMonth      = txData?.stats?.netFlowUsdcMonth ?? 0;
  const transferCountMonth = txData?.stats?.transferCountMonth ?? 0;

  // ── AI Chat popup ────────────────────────────────────────────────────────
  const [chatOpen, setChatOpen]       = useState(false);
  const [chatMessages, setChatMessages] = useState<{ role: "user" | "assistant"; content: string }[]>([]);
  const [chatInput, setChatInput]     = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const chatBottomRef = useRef<HTMLDivElement>(null);

  // ── Draggable AI FAB ─────────────────────────────────────────────────────
  const fabDrag = useRef<{ ox: number; oy: number; sx: number; sy: number; moved: boolean } | null>(null);
  const [fabXY, setFabXY]       = useState<{ x: number; y: number } | null>(null);
  const [fabDragging, setFabDragging] = useState(false);

  // ── Auto Earn ────────────────────────────────────────────────────────────
  const [autoEarn, setAutoEarn]               = useState(false);
  const [autoEarnThreshold, setAutoEarnThreshold] = useState(50);
  useEffect(() => {
    try { const s = localStorage.getItem("bluebank:autoEarn"); if (s) { const p = JSON.parse(s); setAutoEarn(!!p.enabled); setAutoEarnThreshold(p.threshold ?? 50); } } catch {}
  }, []);
  useEffect(() => {
    try { localStorage.setItem("bluebank:autoEarn", JSON.stringify({ enabled: autoEarn, threshold: autoEarnThreshold })); } catch {}
  }, [autoEarn, autoEarnThreshold]);

  function fabDown(e: React.PointerEvent<HTMLButtonElement>) {
    e.preventDefault();
    (e.currentTarget as HTMLButtonElement).setPointerCapture(e.pointerId);
    const r = (e.currentTarget as HTMLButtonElement).getBoundingClientRect();
    fabDrag.current = { ox: r.left, oy: r.top, sx: e.clientX, sy: e.clientY, moved: false };
    setFabDragging(true);
  }
  function fabMove(e: React.PointerEvent<HTMLButtonElement>) {
    if (!fabDrag.current) return;
    const dx = e.clientX - fabDrag.current.sx;
    const dy = e.clientY - fabDrag.current.sy;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) fabDrag.current.moved = true;
    if (!fabDrag.current.moved) return;
    setFabXY({
      x: Math.max(8, Math.min(window.innerWidth  - 56, fabDrag.current.ox + dx)),
      y: Math.max(8, Math.min(window.innerHeight - 56, fabDrag.current.oy + dy)),
    });
  }
  function fabUp() {
    if (fabDrag.current && !fabDrag.current.moved) setChatOpen(o => !o);
    fabDrag.current = null;
    setFabDragging(false);
  }

  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages, chatLoading]);

  async function sendChat(input: string) {
    if (!input.trim() || chatLoading) return;
    const userMsg = { role: "user" as const, content: input.trim() };
    const historySnapshot = [...chatMessages, userMsg];
    setChatMessages(historySnapshot);
    setChatInput("");
    setChatLoading(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: historySnapshot,
          system: `You are BlueAgent Banking assistant. User: ${name ?? shortAddr(acct)}. Balance: $${usd(total)} · USDC: $${usd(walletUsdc)} · In yield: $${usd(inYield)} at ${bestApy?.toFixed(1) ?? "—"}%. ETH: ${ethBal?.toFixed(4) ?? "—"}. Answer concisely in 2-3 sentences. Focus on Base DeFi and banking.`,
          model: "fast",
        }),
      });
      if (!res.ok || !res.body) throw new Error("no body");
      // SSE stream — accumulate text_delta events
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let accumulated = "";
      setChatMessages(prev => [...prev, { role: "assistant", content: "" }]);
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const raw = line.slice(6).trim();
          if (raw === "[DONE]") break;
          try {
            const parsed = JSON.parse(raw) as { type?: string; delta?: { text?: string } };
            if (parsed.delta?.text) {
              accumulated += parsed.delta.text;
              setChatMessages(prev => {
                const msgs = [...prev];
                msgs[msgs.length - 1] = { role: "assistant", content: accumulated };
                return msgs;
              });
            }
          } catch { /* ignore parse errors */ }
        }
      }
      if (!accumulated) {
        setChatMessages(prev => {
          const msgs = [...prev];
          msgs[msgs.length - 1] = { role: "assistant", content: "Sorry, couldn't get a response. Try again." };
          return msgs;
        });
      }
    } catch {
      setChatMessages(prev => [...prev, { role: "assistant", content: "Connection error. Try again." }]);
    } finally {
      setChatLoading(false);
    }
  }

  function copyAddr() {
    if (!acct) return;
    navigator.clipboard?.writeText(acct).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  }

  function sharePayLink() {
    if (!acct) return;
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    const qs = new URLSearchParams({ asset: reqAsset, network });
    if (parseFloat(reqAmount) > 0) qs.set("amount", reqAmount);
    const url = `${origin}/pay/${acct}?${qs.toString()}`;
    const title = parseFloat(reqAmount) > 0 ? `Pay me ${reqAmount} ${reqAsset} on Base` : "Pay me on Base";
    if (typeof navigator !== "undefined" && navigator.share) {
      navigator.share({ title, url }).catch(() => {});
    } else {
      navigator.clipboard?.writeText(url).then(() => { setLinkCopied(true); setTimeout(() => setLinkCopied(false), 1500); });
    }
  }

  // ── Wallet state (canonical derived state) — MUST be before any early return ──
  const walletState = useMemo(() => buildWalletState({
    walletUsdc: walletUsdc ?? 0,
    aavePos: aavePos ?? 0,
    morphoPos: morphoPos ?? 0,
    ethBal: ethBal ?? 0,
    bestApy,
    netFlowMonth,
    transferCountMonth,
  }), [walletUsdc, aavePos, morphoPos, ethBal, bestApy, netFlowMonth, transferCountMonth]);

  if (!isConnected) {
    return <BankLanding bestApy={bestApy} />;
  }

  const TABS: { id: Panel; label: string; icon: string; desc: string }[] = [
    { id: "positions", label: "Positions", icon: "📊", desc: "Your yield" },
    { id: "earn",      label: "Earn",      icon: "🌾", desc: "Grow USDC" },
    { id: "send",      label: "Send",      icon: "➡",  desc: "Pay anyone" },
    { id: "receive",   label: "Receive",   icon: "⬇",  desc: "Get paid" },
    { id: "convert",   label: "Convert",   icon: "⇅",  desc: "Swap tokens" },
    ...(B20_ENABLED ? [{ id: "orders" as Panel, label: "Orders", icon: "🧾", desc: "Get paid in B20" }] : []),
  ];

  // ── Portfolio allocation (for pie chart) ─────────────────────────────────
  const stableTotal   = (walletUsdc ?? 0) + (aavePos ?? 0) + (morphoPos ?? 0);
  const ethUsd        = (ethBal ?? 0) * 2500;
  const portfolioTotal = stableTotal + ethUsd;
  const portfolioData = [
    { name: "Stablecoin", value: stableTotal, color: "#4FC3F7" },
    { name: "ETH",        value: ethUsd,      color: "#94A3B8" },
  ].filter(d => d.value > 0);

  // ── Chat popup position relative to FAB ──────────────────────────────────
  const FAB_SZ   = 48;
  const POPUP_W  = 320;
  const POPUP_H  = 432;
  const chatPopupStyle: React.CSSProperties = fabXY
    ? {
        left: Math.max(8, Math.min(
          (typeof window !== "undefined" ? window.innerWidth : 1440) - POPUP_W - 8,
          fabXY.x + FAB_SZ / 2 - POPUP_W / 2,
        )),
        top: Math.max(8, fabXY.y - POPUP_H - 12),
        height: POPUP_H,
      }
    : { right: 16, bottom: 76, height: POPUP_H };

  // ── Portfolio health score ────────────────────────────────────────────────
  const deployedRatio  = total > 0 ? inYield / total : 0;
  const yieldScore     = deployedRatio > 0.8 ? 95 : deployedRatio > 0.5 ? 80 : deployedRatio > 0.2 ? 60 : deployedRatio > 0 ? 40 : 20;
  const divScore       = portfolioTotal > 0 && ethUsd / portfolioTotal > 0.05 ? 88 : ethUsd > 0 ? 65 : 45;
  const gasScore       = ethBal == null ? 50 : ethBal > 0.05 ? 95 : ethBal > 0.01 ? 80 : ethBal > 0.005 ? 60 : 20;
  const actScore       = transferCountMonth > 10 ? 90 : transferCountMonth > 5 ? 75 : transferCountMonth > 1 ? 55 : 20;
  const portfolioScore = total === 0 ? 0 : Math.round(yieldScore * 0.4 + divScore * 0.25 + gasScore * 0.2 + actScore * 0.15);
  const scoreGrade     = portfolioScore >= 85 ? "A" : portfolioScore >= 70 ? "B" : portfolioScore >= 55 ? "C" : "D";
  const scoreColor     = portfolioScore >= 85 ? "#34D399" : portfolioScore >= 70 ? "#4FC3F7" : portfolioScore >= 55 ? "#F59E0B" : "#EF4444";
  const scoreDims      = [
    { label: "Yield", s: yieldScore }, { label: "Diversify", s: divScore },
    { label: "Gas", s: gasScore },     { label: "Activity", s: actScore },
  ];

  // ── Mission Control items ─────────────────────────────────────────────────
  interface MC { priority: "high"|"warn"|"good"|"info"; icon: string; text: string; action?: string; onAction?: () => void; color: string }
  const allMissions: MC[] = [];
  if (total === 0) {
    allMissions.push({ priority: "info", icon: "💡", text: "Add USDC to start earning yield on Base", action: "Add cash", onAction: addCash, color: "#F59E0B" });
  } else {
    if ((walletUsdc ?? 0) > 50 && inYield === 0 && bestApy != null)
      allMissions.push({ priority: "high", icon: "📈", text: `$${usd(walletUsdc)} idle — earn ~$${(((walletUsdc ?? 0) * bestApy / 100) / 12).toFixed(0)}/mo at ${bestApy.toFixed(1)}%`, action: "Earn now", onAction: () => openAction("earn"), color: "#34D399" });
    if (inYield > 0 && bestApy != null)
      allMissions.push({ priority: "good", icon: "✅", text: `$${usd(inYield)} earning ${bestApy.toFixed(1)}% · ~$${((inYield * bestApy / 100) / 12).toFixed(0)}/month`, color: "#34D399" });
    if ((walletUsdc ?? 0) > 50 && !autoEarn)
      allMissions.push({ priority: "info", icon: "⚙️", text: "Enable Auto Earn to auto-deploy idle USDC", action: "Enable", onAction: () => setAutoEarn(true), color: "#A78BFA" });
    if (ethBal != null && ethBal < 0.005)
      allMissions.push({ priority: "warn", icon: "⛽", text: "ETH too low for gas fees", action: "Get ETH", onAction: () => openAction("convert"), color: "#F59E0B" });
    if (new Date() >= new Date("2026-06-25"))
      allMissions.push({ priority: "info", icon: "⚡", text: "Beryl live — B20 payments + faster L1 withdrawals", action: "Try", onAction: () => openAction("orders"), color: "#4FC3F7" });
  }
  const topMissions = allMissions.slice(0, 3);
  const missionSummary =
    total === 0 ? "Connect and add funds to get started." :
    (walletUsdc ?? 0) > 100 && inYield === 0 ? "Idle cash detected — put it to work." :
    inYield > 0 && (walletUsdc ?? 0) < 50 ? `Fully deployed · earning ${bestApy?.toFixed(1) ?? "—"}% APY` :
    `$${usd(walletUsdc)} liquid · $${usd(inYield)} earning`;

  // ── Auto Earn surplus ─────────────────────────────────────────────────────
  const autoEarnSurplus = Math.max(0, (walletUsdc ?? 0) - autoEarnThreshold);

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";

  return (
    <div className="flex h-full w-full bg-[#050508] text-slate-200 overflow-hidden">

      {/* ── SIDEBAR ─────────────────────────────────────────────────────── */}
      <aside className="hidden md:flex flex-col shrink-0 h-full border-r border-[#1A1A2E] bg-[#050508] overflow-y-auto w-56 lg:w-60 xl:w-64 2xl:w-72 3xl:w-80">
        {/* 1. Header */}
        <div className="px-4 h-14 flex items-center gap-2 border-b border-[#1A1A2E] shrink-0">
          <span className="w-1.5 h-1.5 rounded-full bg-[#4FC3F7] animate-pulse shrink-0" />
          <p className="font-mono text-[11px] text-[#4FC3F7] tracking-widest">// BLUEBANK</p>
        </div>

        {/* 2. Net Worth widget */}
        <div className="m-3 rounded-xl border border-[#1A1A2E] bg-gradient-to-b from-[#0d1117] to-[#0a0a0f] p-3.5">
          <div className="font-mono text-[9px] text-slate-500 tracking-wide mb-0.5">NET WORTH</div>
          <div className="font-mono text-[22px] font-bold text-[#34D399]">${usd(walletState.balance)}</div>
          <div className="font-mono text-[9px] text-slate-600 mt-0.5 mb-2">USDC + yield · Base</div>
          <Spark points={hist?.points ?? []} color="#34D399" height={28} />
          <div className="font-mono text-[8px] text-slate-700 mt-1">Morpho USDC · 30d trend</div>
        </div>

        {/* 3. Earn widget */}
        <div className="mx-3 mb-3 rounded-xl border border-[#1A1A2E] bg-[#0a0a0f] p-3">
          <div className="font-mono text-[9px] text-slate-500 tracking-wide mb-1">EARNING</div>
          <div className="font-mono text-[18px] font-bold text-[#A78BFA]">${usd(walletState.inYield)}</div>
          <div className="font-mono text-[9px] text-slate-600 mt-0.5">
            best {bestApy != null ? `${bestApy.toFixed(1)}%` : "—"} APY
          </div>
          {walletState.inYield === 0 && walletState.balance > 0 && (
            <button onClick={() => openAction("earn")}
              className="w-full font-mono text-[10px] font-bold mt-2 py-1.5 rounded-lg"
              style={{ background: "#A78BFA15", color: "#A78BFA", border: "1px solid #A78BFA40" }}>
              Deploy →
            </button>
          )}
        </div>

        {/* 4. BlueAgent mini chat */}
        <div className="mx-3 mb-3">
          <div className="font-mono text-[9px] text-slate-600 mb-1.5">ASK BLUEAGENT</div>
          <div className="flex gap-1.5">
            <input
              value={chatInput}
              onChange={e => setChatInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter" && chatInput.trim()) {
                  sendChat(chatInput);
                  setChatOpen(true);
                }
              }}
              onClick={() => setChatOpen(true)}
              placeholder="Ask anything…"
              className="flex-1 min-w-0 bg-[#050508] border border-[#1A1A2E] focus:border-[#4FC3F7]/40 rounded-lg px-2.5 py-1.5 font-mono text-[10px] text-slate-200 placeholder:text-slate-700 outline-none"
            />
            <button
              onClick={() => { if (chatInput.trim()) { sendChat(chatInput); } setChatOpen(true); }}
              className="w-8 h-8 shrink-0 rounded-lg flex items-center justify-center transition-colors"
              style={{ background: "#4FC3F720", color: "#4FC3F7", border: "1px solid #4FC3F740" }}>
              →
            </button>
          </div>
        </div>

        {/* 5. Base Apps grid */}
        <div className="mx-3 mb-3">
          <div className="font-mono text-[9px] text-slate-600 mb-1.5">⚡ BASE APPS</div>
          <div className="grid grid-cols-2 gap-1.5">
            {[
              { name: "Aerodrome", url: "https://aerodrome.finance",    color: "#EF4444" },
              { name: "Moonwell",  url: "https://moonwell.fi",          color: "#A78BFA" },
              { name: "Morpho",    url: "https://morpho.org",           color: "#4FC3F7" },
              { name: "Uniswap",   url: "https://app.uniswap.org",      color: "#FF007A" },
              { name: "Aave",      url: "https://app.aave.com",         color: "#B6509E" },
              { name: "Compound",  url: "https://app.compound.finance", color: "#00D395" },
            ].map(p => (
              <a key={p.name} href={p.url} target="_blank" rel="noopener noreferrer"
                className="font-mono text-[9px] py-1.5 px-2 rounded-lg text-center hover:opacity-80 transition-opacity"
                style={{ background: `${p.color}10`, color: p.color, border: `1px solid ${p.color}25` }}>
                {p.name}
              </a>
            ))}
          </div>
        </div>

        {/* 6. Spacer */}
        <div className="flex-1" />

        {/* 7. Network */}
        <div className="px-3 pb-3">
          <div className="font-mono text-[9px] text-slate-600 mb-1.5">NETWORK</div>
          <div className="flex gap-1">
            {(["baseSepolia", "base"] as const).map(nk => (
              <button key={nk} onClick={() => setNetwork(nk)}
                className="flex-1 font-mono text-[10px] py-1.5 rounded-md transition-colors"
                style={network === nk
                  ? { background: "#4FC3F715", color: "#4FC3F7", border: "1px solid #4FC3F730" }
                  : { color: "#64748b", border: "1px solid #1A1A2E" }}>
                {nk === "base" ? "Mainnet" : "Sepolia"}
              </button>
            ))}
          </div>
        </div>

        {/* 8. Account chip */}
        <div className="px-4 py-3 border-t border-[#1A1A2E]">
          <div className="font-mono text-[11px] text-slate-300 truncate">{name ?? fname ?? shortAddr(acct)}</div>
          <div className="flex items-center gap-2 mt-0.5">
            <a href={`${net.explorer}/address/${acct}`} target="_blank" rel="noopener noreferrer"
              className="font-mono text-[9px] text-slate-600 hover:text-[#4FC3F7]">Basescan ↗</a>
            <span className="text-slate-700 text-[9px]">·</span>
            <button onClick={() => disconnect()}
              className="font-mono text-[9px] text-slate-600 hover:text-red-400 transition-colors">Disconnect</button>
          </div>
        </div>
      </aside>

      {/* ── MAIN ────────────────────────────────────────────────────────── */}
      <main className="flex-1 min-w-0 flex flex-col overflow-hidden">

        {/* Header h-14: greeting + trust chips */}
        <div className="px-4 sm:px-5 h-14 flex items-center justify-between gap-3 border-b border-[#1A1A2E] shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <Identicon address={acct} />
            <div className="min-w-0">
              <p className="font-mono text-[13px] text-white">
                Good {greeting}, <span className="text-[#4FC3F7]">{name ?? fname ?? shortAddr(acct)}</span>
              </p>
              <p className="font-mono text-[9px] text-slate-600 truncate">Base · Non-custodial · You hold the keys</p>
            </div>
          </div>
          <div className="hidden sm:flex items-center gap-1.5 shrink-0">
            {["Non-custodial", "Base", "Passkey"].map(c => (
              <span key={c} className="font-mono text-[9px] px-2 py-1 rounded-md text-slate-400"
                style={{ border: "1px solid #1A1A2E", background: "#0d0d12" }}>{c}</span>
            ))}
            {new Date() >= new Date("2026-06-25") && (
              <span className="font-mono text-[9px] px-2 py-1 rounded-md font-bold"
                style={{ color: "#4FC3F7", border: "1px solid #4FC3F730", background: "#4FC3F710" }}>⚡ Beryl</span>
            )}
          </div>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto p-3 sm:p-4 xl:p-5 2xl:p-6 3xl:p-8">

          {/* ── Section 1: Balance | Actions | Health ─────────────────────── */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3 items-start">

            {/* Balance card */}
            <div className="rounded-2xl border border-[#1A1A2E] bg-[#0a0a0f] p-4">
              <div className="font-mono text-[9px] text-slate-500 tracking-widest mb-2">TOTAL BALANCE</div>
              <div className="font-mono text-[28px] font-bold text-[#34D399]">${usd(walletState.balance)}</div>
              <div className="flex flex-col gap-1.5 mt-3">
                {(walletUsdc ?? 0) > 0 && (
                  <div className="flex justify-between font-mono text-[10px]">
                    <span className="text-slate-500">USDC</span>
                    <span className="text-slate-300">${usd(walletUsdc)}</span>
                  </div>
                )}
                {(aavePos ?? 0) > 0 && (
                  <div className="flex justify-between font-mono text-[10px]">
                    <span className="text-slate-500">aUSDC (Aave)</span>
                    <span className="text-[#34D399]">${usd(aavePos)}</span>
                  </div>
                )}
                {(morphoPos ?? 0) > 0 && (
                  <div className="flex justify-between font-mono text-[10px]">
                    <span className="text-slate-500">Morpho</span>
                    <span className="text-[#A78BFA]">${usd(morphoPos)}</span>
                  </div>
                )}
                {ethBal != null && ethBal > 0 && (
                  <div className="flex justify-between font-mono text-[10px]">
                    <span className="text-slate-500">ETH (gas)</span>
                    <span className="text-slate-400">{ethBal.toFixed(4)}</span>
                  </div>
                )}
              </div>
            </div>

            {/* Actions card */}
            <div className="rounded-2xl border border-[#1A1A2E] bg-[#0a0a0f] p-4">
              <div className="font-mono text-[9px] text-slate-500 tracking-widest mb-3">ACTIONS</div>
              <div className="grid grid-cols-2 gap-2 mb-2">
                <button onClick={() => openAction("receive")}
                  className="font-mono text-[11px] font-bold py-2.5 px-3 rounded-xl transition-colors"
                  style={{ background: "#4FC3F710", color: "#4FC3F7", border: "1px solid #4FC3F740" }}>
                  ⬇ Receive
                </button>
                <button onClick={() => openAction("send")}
                  className="font-mono text-[11px] font-bold py-2.5 px-3 rounded-xl hover:opacity-90 transition-opacity"
                  style={{ background: "#4FC3F7", color: "#050508" }}>
                  ➡ Send
                </button>
                <button onClick={addCash} disabled={onrampBusy || !isConnected}
                  className="font-mono text-[11px] font-bold py-2.5 px-3 rounded-xl disabled:opacity-40 transition-opacity hover:opacity-80"
                  style={{ background: "#34D39910", color: "#34D399", border: "1px solid #34D39930" }}>
                  {onrampBusy ? "…" : "💵 Add"}
                </button>
                <button onClick={cashOut} disabled={cashOutBusy || !isConnected}
                  className="font-mono text-[11px] py-2.5 px-3 rounded-xl text-slate-400 disabled:opacity-40 transition-opacity hover:text-slate-200"
                  style={{ border: "1px solid #1A1A2E" }}>
                  {cashOutBusy ? "…" : "🏦 Out"}
                </button>
              </div>
              <div className="flex gap-1.5">
                <button onClick={() => openAction("earn")}
                  className="flex-1 font-mono text-[10px] py-1.5 rounded-lg text-slate-400 hover:text-slate-200 transition-colors"
                  style={{ border: "1px solid #1A1A2E" }}>
                  🌾 Earn
                </button>
                <button onClick={() => openAction("convert")}
                  className="flex-1 font-mono text-[10px] py-1.5 rounded-lg text-slate-400 hover:text-slate-200 transition-colors"
                  style={{ border: "1px solid #1A1A2E" }}>
                  ⇅ Swap
                </button>
                <button onClick={() => setScanOpen(true)}
                  className="flex-1 font-mono text-[10px] py-1.5 rounded-lg text-slate-400 hover:text-slate-200 transition-colors"
                  style={{ border: "1px solid #1A1A2E" }}>
                  📷 Scan
                </button>
              </div>
              {onrampMsg && <div className="font-mono text-[9px] text-amber-400 mt-2">{onrampMsg}</div>}
            </div>

            {/* Health card */}
            <div className="rounded-2xl border border-[#1A1A2E] bg-[#0a0a0f] p-4">
              <div className="font-mono text-[9px] text-slate-500 tracking-widest mb-2">PORTFOLIO HEALTH</div>
              <div className="flex items-end gap-2 mb-3">
                <div className="font-mono text-[32px] font-bold leading-none" style={{ color: scoreColor }}>{portfolioScore}</div>
                <div className="font-mono text-[13px] text-slate-500 mb-1">/100 · {scoreGrade}</div>
              </div>
              <div className="flex flex-wrap gap-1.5 mb-3">
                <IdentityChip label="Smart Wallet" active={true} color="#4FC3F7" />
                <IdentityChip label="Passkey" active={true} color="#34D399" />
                <IdentityChip label={name ?? fname ?? "No Basename"} active={!!(name ?? fname)} color="#A78BFA" />
                <IdentityChip label="Non-custodial" active={true} color="#34D399" />
              </div>
              <button
                onClick={() => {
                  const text = `My Base wallet health: ${portfolioScore}/100 @blueagent_`;
                  navigator.clipboard?.writeText(text).catch(() => {});
                }}
                className="font-mono text-[9px] px-2.5 py-1 rounded-full transition-colors hover:opacity-80"
                style={{ background: "#4FC3F710", color: "#4FC3F7", border: "1px solid #4FC3F730" }}>
                Share
              </button>
            </div>

          </div>

          {/* ── Section 2: Wallet+Earn | AI+Portfolio ─────────────────────── */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mb-3 items-start">

            {/* Left stack */}
            <div className="flex flex-col gap-3">

              {/* Wallet card */}
              <div className="rounded-2xl border border-[#1A1A2E] bg-[#0a0a0f] p-4">
                <div className="font-mono text-[9px] text-slate-500 tracking-widest mb-3">WALLET</div>
                <AssetRow label="USDC" sub="in wallet" usd={walletUsdc} color="#4FC3F7" />
                <AssetRow label="aUSDC" sub={`Aave · ${aaveApy != null ? `${aaveApy.toFixed(1)}%` : bestApy != null ? `${bestApy.toFixed(1)}%` : "—"} APY`} usd={aavePos} color="#34D399" />
                {(morphoPos ?? 0) > 0 && (
                  <AssetRow label="Morpho" sub={`Gauntlet · ${morphoApy != null ? `${morphoApy.toFixed(1)}%` : "—"} APY`} usd={morphoPos} color="#A78BFA" />
                )}
                <div className="mt-2 pt-2 border-t border-[#1A1A2E]">
                  <div className="font-mono text-[9px] text-slate-500 mb-1">GAS RESERVE</div>
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[11px] text-slate-400">ETH</span>
                    <span className="font-mono text-[11px] text-slate-300">{walletState.gasReserveEth.toFixed(4)}</span>
                  </div>
                  {walletState.gasReserveEth < 0.005 && (
                    <div className="font-mono text-[9px] text-amber-400 mt-1">⚠ Low — get ETH for gas</div>
                  )}
                </div>
              </div>

              {/* Earn card with APY bars */}
              <div className="rounded-2xl border border-[#1A1A2E] bg-[#0a0a0f] p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="font-mono text-[9px] text-slate-500 tracking-widest">YIELD RATES · BASE</div>
                  <button onClick={() => openAction("earn")}
                    className="font-mono text-[9px] px-2 py-1 rounded-lg"
                    style={{ background: "#34D39910", color: "#34D399", border: "1px solid #34D39920" }}>
                    Earn →
                  </button>
                </div>
                {rates && rates.length ? rates.slice(0, 4).map((r, i) => (
                  <div key={r.project} className="mb-2">
                    <div className="flex justify-between font-mono text-[10px] mb-1">
                      <span className={i === 0 ? "text-[#34D399]" : "text-slate-400"}>{i === 0 ? "★ " : ""}{r.label}</span>
                      <span className={i === 0 ? "text-[#34D399] font-bold" : "text-slate-300"}>{r.apy.toFixed(2)}%</span>
                    </div>
                    <div className="h-1 rounded-full bg-[#1A1A2E] overflow-hidden">
                      <div className="h-full rounded-full transition-all"
                        style={{ width: `${Math.min(100, (r.apy / (rates[0].apy + 1)) * 100)}%`, background: i === 0 ? "#34D399" : "#4FC3F740" }} />
                    </div>
                  </div>
                )) : (
                  <div className="font-mono text-[10px] text-slate-600">loading rates…</div>
                )}
              </div>

            </div>

            {/* Right stack */}
            <div className="flex flex-col gap-3">

              {/* AI Mission Control */}
              <div className="rounded-2xl border border-[#1A1A2E] bg-[#0a0a0f] p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <img src="/logomark.svg" alt="" className="w-4 h-4 opacity-90" />
                    <span className="font-mono text-[9px] text-slate-500 tracking-widest">AI MISSION CONTROL</span>
                  </div>
                  <button onClick={() => setChatOpen(o => !o)}
                    className="font-mono text-[9px] px-2.5 py-1 rounded-lg font-bold transition-colors"
                    style={{ background: "#4FC3F715", color: "#4FC3F7", border: "1px solid #4FC3F730" }}>
                    Ask BlueAgent →
                  </button>
                </div>
                <p className="font-mono text-[11px] text-slate-300 mb-3 leading-relaxed">{missionSummary}</p>
                <div className="space-y-2">
                  {topMissions.map((item, i) => (
                    <div key={i} className="flex items-center justify-between gap-2 p-2.5 rounded-xl"
                      style={{ background: `${item.color}08`, border: `1px solid ${item.color}20` }}>
                      <div className="flex items-center gap-2 min-w-0">
                        <div className="flex items-center gap-1.5 shrink-0">
                          {item.priority === "high" && <span className="w-1.5 h-1.5 rounded-full bg-[#EF4444] animate-pulse" />}
                          {item.priority === "warn" && <span className="w-1.5 h-1.5 rounded-full bg-[#F59E0B]" />}
                          {item.priority === "good" && <span className="w-1.5 h-1.5 rounded-full bg-[#34D399]" />}
                          {item.priority === "info" && <span className="w-1.5 h-1.5 rounded-full bg-[#64748b]" />}
                          <span className="text-sm leading-none">{item.icon}</span>
                        </div>
                        <span className="font-mono text-[10px] text-slate-300 leading-snug">{item.text}</span>
                      </div>
                      {item.action && item.onAction && (
                        <button onClick={item.onAction}
                          className="font-mono text-[9px] px-2 py-1 rounded-lg shrink-0 font-bold whitespace-nowrap"
                          style={{ background: `${item.color}20`, color: item.color, border: `1px solid ${item.color}40` }}>
                          {item.action}
                        </button>
                        )}
                    </div>
                  ))}
                  {topMissions.length === 0 && (
                    <div className="font-mono text-[10px] text-slate-600 py-2 text-center">✓ All good — no actions needed</div>
                  )}
                </div>
              </div>

              {/* Portfolio Allocation with donut chart */}
              <div className="rounded-2xl border border-[#1A1A2E] bg-[#0a0a0f] p-4">
                <div className="font-mono text-[9px] text-slate-500 tracking-widest mb-3">PORTFOLIO ALLOCATION</div>
                {walletState.balance > 0 ? (
                  <div className="flex items-center gap-4">
                    <div className="w-20 h-20 shrink-0">
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie data={portfolioData} cx="50%" cy="50%" innerRadius={24} outerRadius={36}
                            dataKey="value" strokeWidth={0}>
                            {portfolioData.map((entry, i) => (
                              <Cell key={i} fill={entry.color} />
                            ))}
                          </Pie>
                          <Tooltip formatter={(v: unknown) => `$${usd(v as number)}`}
                            contentStyle={{ background: "#0a0a0f", border: "1px solid #1A1A2E", fontSize: 10 }} />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                    <div className="flex-1 space-y-1.5">
                      {portfolioData.map(d => (
                        <div key={d.name} className="flex items-center justify-between">
                          <div className="flex items-center gap-1.5">
                            <div className="w-2 h-2 rounded-full" style={{ background: d.color }} />
                            <span className="font-mono text-[10px] text-slate-400">{d.name}</span>
                          </div>
                          <span className="font-mono text-[10px] text-slate-300">${usd(d.value)}</span>
                        </div>
                      ))}
                      <div className="font-mono text-[8px] text-slate-700 pt-1">ETH counted as gas reserve</div>
                      {walletState.gasSavedUsd != null && (
                        <div className="font-mono text-[9px] text-[#34D399]">~${walletState.gasSavedUsd} saved vs mainnet</div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="font-mono text-[10px] text-slate-600">No assets yet</div>
                )}
                <div className="mt-3 flex items-center justify-between font-mono text-[10px]">
                  <span className="text-slate-500">Stablecoin</span>
                  <span className="text-[#4FC3F7] font-bold">{walletState.allocation.stablecoin}%</span>
                </div>
                <div className="h-1.5 rounded-full bg-[#1A1A2E] overflow-hidden mt-1">
                  <div className="h-full rounded-full bg-[#4FC3F7]"
                    style={{ width: `${walletState.allocation.stablecoin}%` }} />
                </div>
              </div>

            </div>
          </div>

          {/* ── Section 3: Transaction History ─────────────────────────────── */}
          <TransactionHistory
            transactions={txData?.transactions ?? []}
            loading={txLoading}
            error={txError}
            needsKey={txData?.needsKey}
            onRetry={() => setTxReload(k => k + 1)}
            explorer={net.explorer}
            address={acct}
          />

        </div>

        {/* Action modal — fixed, inside main */}
        {actionOpen && (
          <div className="fixed inset-0 z-50 flex items-start justify-center pt-[8vh] p-4">
            <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => setActionOpen(false)} />
            <div className="relative z-10 w-full max-w-md h-[580px] max-h-[85vh] rounded-2xl border border-[#1A1A2E] bg-[#0a0a0f] shadow-2xl flex flex-col">
              <div className="flex items-center gap-1 p-3 border-b border-[#1A1A2E] shrink-0">
                {TABS.map(tb => (
                  <button key={tb.id} onClick={() => { if (tb.id === "send") { setScanPrefill(null); setScanKey(k => k + 1); } setPanel(tb.id); }}
                    className="flex-1 font-mono text-[10px] py-1.5 rounded-md transition-colors"
                    style={panel === tb.id
                      ? { background: "#4FC3F712", color: "#4FC3F7", border: "1px solid #4FC3F730" }
                      : { color: "#64748b", border: "1px solid transparent" }}>
                    {tb.label}
                  </button>
                ))}
                <button onClick={() => setActionOpen(false)} className="ml-1 w-7 h-7 rounded-md font-mono text-[13px] text-slate-500 hover:text-white hover:bg-[#1A1A2E] shrink-0">✕</button>
              </div>

              <div className="overflow-y-auto p-4 min-h-0">
                {panel === "positions" && (
                  <div>
                    <PositionRow label="Aave v3" pos={aavePos} apy={aaveApy} onManage={() => setPanel("earn")} />
                    <PositionRow label="Morpho · Gauntlet USDC Prime" pos={morphoPos} apy={morphoApy}
                      disabled={!morphoVnet} disabledNote="mainnet only" onManage={() => setPanel("earn")} />
                    <div className="mt-3 rounded-lg border border-[#1A1A2E] bg-[#0d0d12] p-3">
                      <div className="font-mono text-[9px] text-slate-600 mb-1.5">BEST SAFE RATE · BASE</div>
                      {rates && rates.length ? rates.slice(0, 3).map((r, i) => (
                        <div key={r.project} className="flex items-center justify-between py-0.5 font-mono text-[10px]">
                          <span className={i === 0 ? "text-[#34D399]" : "text-slate-400"}>{i === 0 ? "★ " : "  "}{r.label}</span>
                          <span className={i === 0 ? "text-[#34D399]" : "text-slate-300"}>{r.apy.toFixed(2)}%</span>
                        </div>
                      )) : <div className="font-mono text-[10px] text-slate-600">loading…</div>}
                    </div>
                    <button onClick={() => setPanel("earn")}
                      className="w-full font-mono text-[12px] font-bold py-2.5 rounded-xl mt-3"
                      style={{ background: "#F59E0B15", color: "#F59E0B", border: "1px solid #F59E0B40" }}>
                      🌾 {inYield > 0 ? "Manage yield" : "Start earning"}
                    </button>
                    <p className="font-mono text-[9px] text-slate-600 mt-2 leading-relaxed px-0.5">
                      Supply idle USDC into Aave or Morpho — non-custodial, you sign, withdraw anytime.
                    </p>
                  </div>
                )}
                {panel === "earn" && <MoveToYieldCard result={{ network }} account={acct} />}
                {panel === "convert" && <SwapCard account={acct} />}
                {panel === "orders" && <OrdersPanel />}
                {panel === "send" && (
                  <div>
                    <button onClick={() => setScanOpen(true)}
                      className="w-full font-mono text-[11px] font-bold py-2 rounded-xl mb-3 flex items-center justify-center gap-2"
                      style={{ background: "#4FC3F710", color: "#4FC3F7", border: "1px solid #4FC3F730" }}>
                      📷 Scan to pay
                    </button>
                    {scanPrefill && (
                      <div className="font-mono text-[9px] text-[#34D399] mb-2">
                        ✓ scanned{scanPrefill.amount ? ` · request ${scanPrefill.amount} ${scanPrefill.asset ?? "USDC"}` : ""} — confirm + sign below
                      </div>
                    )}
                    <SendCard key={scanKey}
                      result={{
                        network: scanPrefill?.network ?? network,
                        to: scanPrefill?.to,
                        amount: scanPrefill?.amount,
                        asset: scanPrefill?.asset,
                      }}
                      account={acct} />
                  </div>
                )}
                {panel === "receive" && (
                  <div>
                    <div className="font-mono text-[10px] text-slate-500 tracking-widest mb-3">RECEIVE · {net.short}</div>
                    <div className="flex items-center gap-1.5 mb-3">
                      <div className="flex gap-1">
                        {(["USDC", "ETH"] as const).map(a => (
                          <button key={a} onClick={() => setReqAsset(a)}
                            className="font-mono text-[10px] px-2.5 py-1.5 rounded-lg transition-colors"
                            style={reqAsset === a
                              ? { background: "#4FC3F712", color: "#4FC3F7", border: "1px solid #4FC3F730" }
                              : { color: "#64748b", border: "1px solid #1A1A2E" }}>
                            {a}
                          </button>
                        ))}
                      </div>
                      <input value={reqAmount} onChange={e => setReqAmount(e.target.value.replace(/[^0-9.]/g, ""))}
                        inputMode="decimal" placeholder="amount (optional)"
                        className="flex-1 bg-[#050508] border border-[#1A1A2E] focus:border-[#4FC3F7]/40 rounded-lg px-2.5 py-1.5 font-mono text-[10px] text-slate-200 placeholder:text-slate-700 outline-none" />
                      {reqAmount && (
                        <button onClick={() => setReqAmount("")} className="font-mono text-[10px] px-2 py-1.5 rounded-lg text-slate-500 hover:text-white border border-[#1A1A2E]">✕</button>
                      )}
                    </div>
                    <div className="flex flex-col items-center text-center">
                      <div className="bg-white p-2.5 rounded-xl">
                        <QRCodeSVG value={acct ? buildPaymentUri({ to: acct, amount: reqAmount, asset: reqAsset, network }) : ""} size={180} bgColor="#ffffff" fgColor="#0a0a0f" level="M" />
                      </div>
                      {parseFloat(reqAmount) > 0 && (
                        <div className="font-mono text-[12px] text-[#34D399] mt-3 font-bold">requesting {reqAmount} {reqAsset}</div>
                      )}
                      {name && <div className="font-mono text-[13px] text-[#4FC3F7] mt-2">{name}</div>}
                      <div className="font-mono text-[9px] text-slate-400 mt-1.5 break-all px-2">{acct}</div>
                      <div className="flex items-center gap-2 mt-3">
                        <button onClick={copyAddr} className="font-mono text-[11px] px-4 py-2 rounded-lg" style={{ background: "#4FC3F710", color: "#4FC3F7", border: "1px solid #4FC3F730" }}>
                          {copied ? "✓ Copied" : "Copy address"}
                        </button>
                        <button onClick={sharePayLink} className="font-mono text-[11px] px-4 py-2 rounded-lg" style={{ background: "#34D39910", color: "#34D399", border: "1px solid #34D39930" }}>
                          {linkCopied ? "✓ Link copied" : "🔗 Share pay link"}
                        </button>
                      </div>
                    </div>
                    <div className="rounded-lg border border-[#1A1A2E] bg-[#0d0d12] p-2.5 mt-4">
                      <p className="font-mono text-[9px] text-slate-500 leading-relaxed">
                        {parseFloat(reqAmount) > 0
                          ? <>Payment-request QR — a payer scanning it (BlueBank <b className="text-slate-300">Scan to pay</b>, or any EIP-681 wallet) gets <b className="text-slate-300">{reqAmount} {reqAsset}</b> prefilled.</>
                          : <>Scan the QR with any wallet, or set an amount above to make a payment request. <b className="text-slate-300">USDC / ETH on Base</b> ({net.short}) only.</>}
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {scanOpen && <QrScanner onResult={handleScan} onClose={() => setScanOpen(false)} />}

      </main>

      {/* ── Chat popup: fixed bottom-4 right-4 ─────────────────────────── */}
      {chatOpen && (
        <div className="fixed bottom-4 right-4 z-[60] w-72 sm:w-80 h-[420px] flex flex-col rounded-2xl border border-[#1A1A2E] bg-[#0a0a0f] shadow-2xl overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2.5 border-b border-[#1A1A2E] shrink-0"
            style={{ background: "#4FC3F708" }}>
            <div className="flex items-center gap-2">
              <img src="/logomark.svg" alt="BlueAgent" className="w-5 h-5" />
              <span className="font-mono text-[11px] text-[#4FC3F7] font-bold">BlueAgent</span>
              <span className="font-mono text-[9px] text-slate-600">Banking mode</span>
            </div>
            <button onClick={() => setChatOpen(false)}
              className="font-mono text-slate-500 hover:text-white text-sm w-6 h-6 flex items-center justify-center rounded">✕</button>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {chatMessages.length === 0 && (
              <div className="space-y-1.5">
                <div className="font-mono text-[10px] text-slate-600 mb-2">Ask anything about your wallet:</div>
                {["What's my best yield option?", "How do I send USDC?", "Show my balance breakdown"].map(q => (
                  <button key={q} onClick={() => sendChat(q)}
                    className="w-full text-left font-mono text-[10px] px-2 py-1.5 rounded-lg text-slate-400 hover:text-slate-200 transition-colors"
                    style={{ background: "#0d0d12", border: "1px solid #1A1A2E" }}>
                    {q}
                  </button>
                ))}
              </div>
            )}
            {chatMessages.map((m, i) => (
              <div key={i} className={`font-mono text-[10px] p-2 rounded-lg leading-relaxed ${
                m.role === "user"
                  ? "ml-6 bg-[#4FC3F715] text-[#4FC3F7] border border-[#4FC3F730]"
                  : "mr-6 bg-[#0d0d12] text-slate-300 border border-[#1A1A2E]"
              }`}>
                {m.content || (m.role === "assistant" && <span className="text-slate-600 animate-pulse">▌</span>)}
              </div>
            ))}
            {chatLoading && chatMessages[chatMessages.length - 1]?.role !== "assistant" && (
              <div className="font-mono text-[10px] text-slate-600 p-2">thinking…</div>
            )}
            <div ref={chatBottomRef} />
          </div>

          {/* Input */}
          <div className="flex gap-2 p-2.5 border-t border-[#1A1A2E] shrink-0">
            <input
              value={chatInput}
              onChange={e => setChatInput(e.target.value)}
              onKeyDown={e => e.key === "Enter" && !e.shiftKey && sendChat(chatInput)}
              placeholder="Ask anything…"
              className="flex-1 bg-[#050508] border border-[#1A1A2E] rounded-lg px-3 py-1.5 font-mono text-[11px] text-slate-200 placeholder:text-slate-700 outline-none focus:border-[#4FC3F7]/40"
            />
            <button onClick={() => sendChat(chatInput)} disabled={chatLoading || !chatInput.trim()}
              className="font-mono text-[11px] font-bold px-3 py-1.5 rounded-lg disabled:opacity-40"
              style={{ background: "#4FC3F7", color: "#050508" }}>
              →
            </button>
          </div>
        </div>
      )}

      {/* ── FAB: simple toggle, moves up when chat open ───────────────────── */}
      <button
        onClick={() => setChatOpen(o => !o)}
        className="fixed z-[65] w-12 h-12 rounded-full shadow-2xl flex items-center justify-center transition-all hover:shadow-[0_0_24px_#4FC3F750]"
        style={{
          right: "16px",
          bottom: chatOpen ? "444px" : "16px",
          background: chatOpen ? "#050508" : "#4FC3F7",
          color: chatOpen ? "#4FC3F7" : "#050508",
          border: "2px solid #4FC3F7",
          transition: "bottom 0.2s ease, background 0.15s ease",
        }}
      >
        {chatOpen
          ? <span className="text-base leading-none">✕</span>
          : <img src="/logomark.svg" alt="BlueAgent" className="w-6 h-6" />
        }
      </button>

    </div>
  );
}

// ── UI primitives ─────────────────────────────────────────────────────────────

function Identicon({ address }: { address?: string }) {
  const hue = (s: string, fallback: number) => {
    const n = parseInt(s, 16);
    return Number.isFinite(n) ? n % 360 : fallback;
  };
  const a = address ?? "0x000000";
  const h1 = hue(a.slice(2, 6), 200);
  const h2 = hue(a.slice(-4), 280);
  return (
    <span className="w-8 h-8 rounded-full shrink-0 border border-[#1A1A2E]"
      style={{ background: `linear-gradient(135deg, hsl(${h1} 70% 55%), hsl(${h2} 70% 45%))` }} />
  );
}

function AssetPill({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="font-mono text-[9px] px-2 py-0.5 rounded-full flex items-center gap-1"
      style={{ background: `${color}15`, border: `1px solid ${color}30`, color }}>
      <span className="text-slate-500">{label}</span>
      <span className="font-bold">{value}</span>
    </div>
  );
}

function AssetRow({ label, sub, usd: val, color }: { label: string; sub: string; usd: number | null; color: string }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-[#13131f] last:border-0">
      <div className="flex items-center gap-2">
        <span className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />
        <div>
          <div className="font-mono text-[12px] text-slate-200">{label}</div>
          <div className="font-mono text-[9px] text-slate-600">{sub}</div>
        </div>
      </div>
      <div className="font-mono text-[12px] text-slate-300">{val != null ? `$${usd(val)}` : "—"}</div>
    </div>
  );
}

function AISuggestion({ icon, text, action, onAction, color }: {
  icon: string; text: string; action?: string; onAction?: () => void; color: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2 p-2 rounded-lg"
      style={{ background: `${color}08`, border: `1px solid ${color}20` }}>
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-sm shrink-0">{icon}</span>
        <span className="font-mono text-[10px] text-slate-300 truncate">{text}</span>
      </div>
      {action && onAction && (
        <button onClick={onAction}
          className="font-mono text-[9px] px-2 py-1 rounded-md shrink-0 font-bold"
          style={{ background: `${color}20`, color, border: `1px solid ${color}40` }}>
          {action}
        </button>
      )}
    </div>
  );
}

function StatMini({ label, value, sub, color }: { label: string; value: string | number; sub: string; color: string }) {
  return (
    <div className="rounded-xl border border-[#1A1A2E] bg-[#050508] p-2.5">
      <div className="font-mono text-[9px] text-slate-500 mb-1">{label}</div>
      <div className="font-mono text-[14px] font-bold" style={{ color }}>{value}</div>
      <div className="font-mono text-[8px] text-slate-600 mt-0.5">{sub}</div>
    </div>
  );
}

function IdentityChip({ label, active, color }: { label: string; active: boolean; color: string }) {
  return (
    <div className="font-mono text-[9px] px-2 py-0.5 rounded-full flex items-center gap-1"
      style={active
        ? { background: `${color}15`, border: `1px solid ${color}30`, color }
        : { background: "#0d0d12", border: "1px solid #1A1A2E", color: "#475569" }}>
      {active && <span className="text-[8px]">✓</span>}
      {label}
    </div>
  );
}

// Dependency-free area sparkline for the sidebar
function Spark({ points, color, height = 48, fill = false }: { points: number[]; color: string; height?: number; fill?: boolean }) {
  if (!points || points.length < 2)
    return <div className="font-mono text-[10px] text-slate-700" style={fill ? { width: "100%" } : { height }}>loading chart…</div>;
  const w = 100, h = 48;
  const min = Math.min(...points), max = Math.max(...points), range = max - min || 1;
  const step = w / (points.length - 1);
  const coords = points.map((p, i) => `${(i * step).toFixed(2)},${(h - ((p - min) / range) * h).toFixed(2)}`);
  const line = "M" + coords.join(" L");
  const area = `${line} L${w},${h} L0,${h} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={fill ? { width: "100%", height: "100%" } : { width: "100%", height }}>
      <path d={area} fill={color} fillOpacity="0.12" />
      <path d={line} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function PositionRow({ label, pos, apy, onManage, disabled, disabledNote }: {
  label: string; pos: number | null; apy: number | null; onManage: () => void; disabled?: boolean; disabledNote?: string;
}) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-[#13131f] last:border-0">
      <div>
        <div className="font-mono text-[12px] text-slate-200">{label}</div>
        <div className="font-mono text-[10px] text-slate-600">
          {disabled ? <span className="text-slate-700">{disabledNote}</span>
            : <>{pos != null ? `${pos.toFixed(2)} USDC` : "—"}{apy != null && <span className="text-[#34D399]"> · ~{apy.toFixed(2)}%</span>}</>}
        </div>
      </div>
      {!disabled && (
        <button onClick={onManage} className="font-mono text-[10px] px-2.5 py-1 rounded-md text-[#4FC3F7]" style={{ border: "1px solid #4FC3F730" }}>
          Manage
        </button>
      )}
    </div>
  );
}

// ── Landing hero (shown until the wallet connects) ───────────────────────────
function BankLanding({ bestApy }: { bestApy: number | null }) {
  const apyText = bestApy != null ? `~${bestApy.toFixed(1)}%` : "up to ~5%";
  const features: { icon: string; title: string; body: string }[] = [
    { icon: "🔑", title: "Sign in with Face ID — no seed phrase", body: "Coinbase Smart Wallet: a passkey-secured account you create in one tap. Recoverable, no 12-word phrase to lose." },
    { icon: "📈", title: `Earn ${apyText} APY on idle USDC`, body: "Live rates across blue-chip lending (Aave · Morpho). Your USDC works while you sleep — no lockups." },
    { icon: "➡", title: "Send to any wallet or name.base", body: "Pay anyone on Base by address or Basename. Instant, 24/7, no cut-off times." },
    { icon: "🔒", title: "Non-custodial — you hold the keys", body: "You sign every transaction from your own wallet. BlueBank never holds your keys or funds." },
    { icon: "🌐", title: "On-chain, withdraw anytime", body: "Your money lives on Base, not in a silo. Pull it out whenever you want, in one click." },
  ];
  return (
    <div className="min-h-full bg-[#050508] flex items-center justify-center p-5 sm:p-8">
      <div className="w-full max-w-4xl grid md:grid-cols-2 gap-6 items-center">
        <div>
          <div className="font-mono text-[13px] tracking-widest text-[#4FC3F7] font-bold mb-3">🔵 BLUEBANK</div>
          <h1 className="text-2xl sm:text-3xl font-bold text-white leading-tight mb-3">
            Banking that you<br />actually own.
          </h1>
          <p className="font-mono text-[12px] text-slate-400 leading-relaxed mb-5 max-w-md">
            Hold USDC, earn real yield, and move money on Base — <span className="text-slate-200">non-custodial</span>.
            You hold the keys; BlueBank only prepares the transaction, you sign it.
          </p>
          <div className="space-y-3">
            {features.map(f => (
              <div key={f.title} className="flex gap-3">
                <span className="text-base shrink-0">{f.icon}</span>
                <div>
                  <div className="font-mono text-[12px] text-slate-200">{f.title}</div>
                  <div className="font-mono text-[10px] text-slate-600 leading-relaxed">{f.body}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="rounded-2xl border border-[#1A1A2E] bg-[#0a0a0f] p-6">
          <div className="font-mono text-[14px] font-bold text-white mb-1">Open your account</div>
          <p className="font-mono text-[11px] text-slate-500 mb-5">Sign in with Face ID — no signup, no KYC, no custody. Your keys are secured by a passkey, not a seed phrase.</p>
          <ConnectButton />
          <div className="flex items-center gap-2 my-4">
            <div className="h-px flex-1 bg-[#1A1A2E]" /><span className="font-mono text-[9px] text-slate-700">SECURED BY YOU</span><div className="h-px flex-1 bg-[#1A1A2E]" />
          </div>
          <div className="flex items-center justify-center gap-4 font-mono text-[9px] text-slate-600">
            <span>🔒 Non-custodial</span><span>·</span><span>⛓ On Base</span><span>·</span><span>↩ Withdraw anytime</span>
          </div>
          <p className="font-mono text-[9px] text-slate-700 text-center mt-4">Powered by Base · Aave v3 · Morpho</p>
        </div>
      </div>
    </div>
  );
}

// Connect-wallet CTA.
//
// The Coinbase-first funnel ("create a free wallet" → everything else behind a
// toggle) is deliberate BlueBank onboarding and stays. What's gone is the local
// copy of the connector plumbing — the de-dup, the icon map and the
// clearUserDisconnected() call now come from useWallet, so this list can't
// drift from the one every other surface shows.
function ConnectButton() {
  const { wallets, coinbase, connectWith, isPending } = useWallet();
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      {coinbase && (
        <>
          <button onClick={() => connectWith(coinbase.connector)} disabled={isPending}
            className="w-full font-mono text-[13px] font-bold py-3 rounded-xl transition-all disabled:opacity-60 flex items-center justify-center gap-2"
            style={{ background: "#4FC3F7", color: "#050508" }}>
            {isPending ? "Connecting…" : <>🔵 Create a free wallet</>}
          </button>
          <div className="flex items-center justify-center gap-2 mt-2 font-mono text-[9px] text-slate-500">
            <span>Face ID</span><span>·</span><span>no seed phrase</span><span>·</span><span>no app to install</span>
          </div>
        </>
      )}
      <button onClick={() => setOpen(o => !o)} disabled={isPending}
        className="w-full font-mono text-[11px] text-slate-400 hover:text-slate-200 py-2.5 mt-3 rounded-xl border border-[#1A1A2E] transition-colors disabled:opacity-60">
        I already have a wallet
      </button>
      {open && (
        <>
          <div className="absolute left-0 right-0 top-full mt-2 z-50 rounded-xl border border-[#1A1A2E] bg-[#0A0A12] shadow-2xl overflow-hidden">
            <p className="font-mono text-[10px] text-slate-600 px-3 pt-3 pb-2 tracking-widest">SELECT WALLET</p>
            {wallets.map(w => (
              <button key={w.connector.uid} onClick={() => { connectWith(w.connector); setOpen(false); }}
                className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-[#1A1A2E] transition-colors">
                <span className="w-7 h-7 rounded-lg bg-[#1A1A2E] flex items-center justify-center text-base shrink-0">{w.icon}</span>
                <span className="font-mono text-xs text-slate-200">{w.name}</span>
              </button>
            ))}
          </div>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
        </>
      )}
    </div>
  );
}
