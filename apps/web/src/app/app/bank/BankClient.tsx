"use client";

// BlueBank dashboard — responsive grid layout: sidebar | grid content.
// Non-custodial Base neobank: real on-chain balances (wagmi), real transactions
// (Moralis). Nothing is fabricated.
//
// This wallet does NOT sell yield. The Earn entrance was closed one release ago
// (supply deferred to phase 2) and this one removes the shop window that stayed
// up after it: the APY boards, the rate sparkline, the DeFi app grid. What
// survives is the part that is about the user's own money — a position they
// already hold, and the exit from it. See the `earn*` block below.

import { useState, useEffect, useRef, useMemo } from "react";
import Link from "next/link";
import { useAccount, useReadContract, useBalance, useSwitchChain } from "wagmi";
import { resolveRead } from "@/lib/wallet/read-state";
import { useWalletDisconnect } from "@/lib/walletSession";
import { useWallet } from "@/hooks/useWallet";
import PrivyLoginButton from "@/components/PrivyLoginButton";
import { PRIVY_ENABLED, describeLoginMethods } from "@/lib/privy/config";
import { formatUnits } from "viem";
import { QRCodeSVG } from "qrcode.react";
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from "recharts";
import { WALLET_CHAINS, WALLET_CHAIN_ORDER, type WalletChain } from "@/lib/wallet/chains";
// ⚠️ EARN-ONLY import, and now WITHDRAW-only: the contract addresses needed to
// read a position the user already holds and hand them back out of it. The
// wallet's identity (chain, explorer, what counts as cash) comes from
// @/lib/wallet/chains — nothing here decides what the wallet IS.
//
// `AAVE_POOL_ABI` + `supplyApyPct` were dropped with the rate boards: an APY is
// only actionable if you can supply more, and you can't.
import { YIELD_NETWORKS, ERC20_ABI, ERC4626_ABI, VENUES } from "@/lib/yield-execution";
import { MoveToYieldCard, SendCard } from "@/app/chat/components/ToolCards";
import { useBasename, shortAddr } from "@/lib/useBasename";
import QrScanner from "./QrScanner";
import SwapCard, { type SellPreset } from "./SwapCard";
import { parsePaymentQr, buildPaymentUri, type ParsedPayment } from "@/lib/payment-qr";
// `B20_ENABLED` was imported alongside this, purely to hide the Orders tab.
// OrdersPanel reads the same flag itself and renders its own degraded-mode
// banner from it, so gating the entrance here only ever meant the user could
// not reach the explanation. See the VIEWS list below.
import OrdersPanel from "./OrdersPanel";
import TransactionHistory, { type WalletTx } from "./TransactionHistory";
import TokenTable from "./TokenTable";
import RhTokenTable from "./RhTokenTable";
import StockTable from "./StockTable";
import type { WalletHolding } from "@/lib/wallet/holdings";
import { useWalletIdentity } from "@/lib/wallet/identity";
// WHO is signed in, as opposed to WHAT wallet is attached — see the note at the
// `who` derivation below for why this page needs both and why they are not the
// same import.
import { resolveIdentity } from "@/lib/identity/account-identity";
import { usePrivyIdentity } from "@/lib/privy/identity-bridge";
import { buildWalletState } from "@/lib/state";

const usd = (n: number | null | undefined) =>
  n == null ? "—" : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// A `CAMPAIGNS` array sat here with two entries — "Base Ecosystem Fund" and
// "Morpho Boost · +0.5% APY on USDC deposits" — and NOTHING rendered it. Dead
// on arrival, but the second one is why it goes in this commit rather than a
// tidy-up: it advertised a deposit bonus for an entrance that is closed, and a
// dead advert is one `{CAMPAIGNS.map(…)}` away from being a live lie.

// "withdraw" was "earn" until yield was deferred to phase 2. The panel still
// renders MoveToYieldCard, but withdraw-only: no new supply can be started from
// this surface, while anyone already deposited keeps a way out.
//
// `orders` left this union for the page-level `View` below. It was the one tab
// here that is not a transaction you start and finish in a modal — payment
// requests are a list you keep, come back to, and reconcile against — and it
// was gated on B20_ENABLED, which is off, so the panel had NO entrance at all
// while its own copy said "payment links work now". A feature with no door.
type Panel = "positions" | "withdraw" | "send" | "receive" | "convert";

// The page's own long-tail sections, one at a time. Distinct from `Panel`:
// a Panel is a thing you DO (and it lives in a modal you dismiss), a View is a
// record you READ. Conflating them is what put Orders in a modal.
type View = "portfolio" | "activity" | "orders";

// Sticky testnet unlock. Deliberately NOT the same key family as `bluebank:*`
// user settings — this is a developer escape hatch, not a preference.
const TESTNET_KEY = "bluebank:testnet";

export default function BankPage() {
  const { address, isConnected, chainId: walletChainId, chain: walletChain } = useAccount();
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

  // ── Who is this? ───────────────────────────────────────────────────────────
  //
  // TWO different things on this page are called "identity" and they answer
  // different questions. `identity` (further down, `useWalletIdentity`) is about
  // the WALLET — connector family, smart account, passkey. `who` is about the
  // PERSON. Keeping the names apart is the point; conflating them is how a
  // greeting ends up addressing someone by their connector.
  //
  // The ladder is `resolveIdentity`, imported unchanged from
  // lib/identity/account-identity.ts and shared with the account menu in the app
  // shell and with /signup. That is the fix: this page had its own local ladder
  // (`name ?? fname ?? shortAddr`) with NO social rung at all, so a user who
  // signed in with Google — and who is greeted by name in the menu directly
  // above this header — was greeted here as `0x2266…608E`, an identifier they
  // have never seen and did not choose. One ladder means the two places agree by
  // construction rather than by two copies happening to be edited together.
  //
  // `usePrivyIdentity()` is a plain `useContext` and returns `null` on the
  // Privy-off tree, so this is safe to call unconditionally on both trees.
  const privy = usePrivyIdentity();
  const who = resolveIdentity({
    social: privy?.social ?? null,
    basename: name ?? null,
    address: acct ?? null,
    shortAddress: acct ? shortAddr(acct) : null,
  });
  // `fname` is spliced in HERE rather than passed to `resolveIdentity` as the
  // basename. It is a Farcaster username resolved from the address via Pinata
  // (the effect above) — a real name, but `resolveIdentity` stamps a `source` on
  // what it returns, and handing it a Farcaster name through the `basename` slot
  // would label its provenance as a Basename. It keeps the rank the old local
  // ladder gave it: below a Basename, above a bare address. `source ===
  // "address"` is precisely "the ladder found nothing better than 0x…", which is
  // the only case fname improves on.
  // Total (`string`, never null) so no consumer has to re-guess a fallback —
  // that re-guessing is how four different ladders got here in the first place.
  // The trailing `shortAddr` is `resolveIdentity`'s own last rung repeated for
  // the nothing-connected case, and matches what the old local ladder ended on.
  const displayName = (who.source === "address" ? (fname ?? who.displayName) : who.displayName) ?? shortAddr(acct);

  // ── Network ──────────────────────────────────────────────────────────────
  // Base MAINNET is the default and must stay that way. This used to default to
  // `baseSepolia` while every label around it said "Base", so the receive QR,
  // the payment link, and the transaction list were all testnet while the UI
  // claimed mainnet — a money-adjacent lie, not a cosmetic one.
  //
  // Testnet is now OPT-IN: the toggle does not render at all unless testnet mode
  // is unlocked with `?testnet=1` (sticky, cleared with `?testnet=0`). A normal
  // user therefore has no way to land on Sepolia by a stray click, and when
  // testnet IS active a banner says so in the one place they cannot miss.
  //
  // Both pieces of state start at their SSR-safe values and are only widened in
  // an effect — reading localStorage/searchParams during the first render would
  // hydration-mismatch, and the safe value (mainnet, locked) is the right first
  // paint anyway.
  const [network, setNetwork] = useState<WalletChain>("base");
  const [testnetUnlocked, setTestnetUnlocked] = useState(false);
  useEffect(() => {
    try {
      const q = new URLSearchParams(window.location.search).get("testnet");
      if (q === "1")      localStorage.setItem(TESTNET_KEY, "1");
      else if (q === "0") localStorage.removeItem(TESTNET_KEY);
      const on = localStorage.getItem(TESTNET_KEY) === "1";
      setTestnetUnlocked(on);
      if (!on) setNetwork("base"); // locking testnet must also leave it
    } catch { /* private mode — stay locked on mainnet */ }
  }, []);

  // Hoisted above the onramp handlers on purpose: `addCash` / `cashOut` read
  // `isTestnet` to refuse a mainnet-only flow, so it has to be initialised
  // before the first render that can bind those handlers.
  const net         = WALLET_CHAINS[network];
  const chainId     = net.chainId;
  const isTestnet   = net.testnet;
  // Not the same question as `!isTestnet`, even though they return the same
  // answer today. Onramp, offramp and swap are pinned to Base MAINNET by their
  // own URLs and routers — they need "am I on 8453", and they were asking "is
  // this play money". Those coincide only because WALLET_CHAIN_ORDER happens to
  // hold exactly base + baseSepolia; the moment a third mainnet is listed, an
  // `isTestnet` guard waves real funds through to the wrong chain. Asking the
  // question the code actually depends on costs one line and removes a trap
  // that would otherwise be armed by an edit in a different file.
  const isBaseMainnet = network === "base";

  // ⚠️ EARN-ONLY — the wallet's last dependency on the yield module, deliberately
  // narrowed to these three lines so removing Earn is a delete, not a hunt.
  // Lending markets exist on Base only; `earnNet` is undefined on any chain
  // without one, and every read below is gated on it rather than assuming.
  const earnKey     = network === "base" || network === "baseSepolia" ? network : null;
  const earnNet     = earnKey ? YIELD_NETWORKS[earnKey] : undefined;
  const morphoVnet  = earnKey ? VENUES.morpho.nets[earnKey] : undefined;

  // The wallet's OWN chain, which is not the same thing as the network this
  // dashboard is reading. Balances are read with an explicit `chainId`, so they
  // are right either way — but every write (send, swap, supply) goes through the
  // wallet, so a mismatch here is the difference between a transaction and a
  // rejection. Surfacing it beats letting the user find out at signing time.
  const { switchChainAsync } = useSwitchChain();
  const [switchBusy, setSwitchBusy] = useState(false);
  const chainMismatch = isConnected && walletChainId != null && walletChainId !== chainId;
  async function switchToAppChain() {
    setSwitchBusy(true);
    try { await switchChainAsync({ chainId }); } catch { /* user declined */ }
    finally { setSwitchBusy(false); }
  }

  const [panel, setPanel]     = useState<Panel>("positions");
  const [view, setView]       = useState<View>("portfolio");
  const [actionOpen, setActionOpen] = useState(false);
  const [copied, setCopied]   = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const openAction = (p: Panel) => {
    if (p === "send") { setScanPrefill(null); setScanKey(k => k + 1); }
    setPanel(p); setActionOpen(true);
  };

  // Quick-sell from the token table → pre-fill + open the Convert panel. Amount
  // is computed from the exact base-unit balance (Moralis `raw`), leaving a small
  // gas buffer when selling 100% of native ETH. The user reviews and signs in the
  // Convert card — this only pre-fills it, it never auto-executes.
  const [sellPreset, setSellPreset] = useState<SellPreset | null>(null);
  const quickSell = (h: WalletHolding, pct: number) => {
    try {
      let sellRaw = (BigInt(h.raw) * BigInt(pct)) / 100n;
      if (h.isNative && pct === 100) { const buf = 50_000_000_000_000n; sellRaw = sellRaw > buf ? sellRaw - buf : 0n; } // ~0.00005 ETH
      if (sellRaw <= 0n) return;
      setSellPreset({ addr: h.address, sym: h.symbol, decimals: h.decimals, amount: formatUnits(sellRaw, h.decimals), nonce: Date.now() });
      openAction("convert");
    } catch { /* malformed raw — ignore */ }
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

  // Coinbase Onramp — add cash.
  //
  // ⚠️ The Onramp session is MAINNET-ONLY (`/api/onramp/session` pins
  // `blockchains: ["base"]`, and the popup URL below pins `defaultNetwork=base`).
  // While the app was defaulting to Sepolia, this shipped real USDC to Base
  // mainnet while the dashboard showed testnet balances — the money arrived
  // somewhere the UI was not looking. Refuse on testnet instead of hardcoding
  // `base` into a flow the rest of the page thinks is Sepolia.
  const [onrampBusy, setOnrampBusy] = useState(false);
  const [onrampMsg, setOnrampMsg]   = useState("");
  async function addCash() {
    if (!acct) return;
    if (!isBaseMainnet) { setOnrampMsg(`Deposit is Base mainnet only — you are on ${net.short}.`); return; }
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
    if (!isBaseMainnet) { setOnrampMsg(`Cash out is Base mainnet only — you are on ${net.short}.`); return; }
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

  // ── Live on-chain reads ──────────────────────────────────────────────────
  //
  // The whole query object is kept, not just `.data`. Every one of these returns
  // status / isError / isPending / isLoading alongside the value, and this file
  // used to destructure `{ data }` and drop the rest — which is how four
  // distinct read outcomes arrived here and got collapsed into one boolean 60
  // lines down. See the `balanceRead` block below.
  const usdcQ = useReadContract({
    address: net.stable, abi: ERC20_ABI, functionName: "balanceOf",
    args: acct ? [acct] : undefined, chainId, query: { enabled: !!acct },
  });
  const ethQ = useBalance({ address: acct, chainId, query: { enabled: !!acct } });
  // Balance reads only. The Aave `getReserveData` call that fed the supply-APY
  // display is gone with the display — a rate the user cannot act on is not
  // worth an RPC round-trip on every render of the wallet.
  const aaveQ = useReadContract({
    address: earnNet?.aUsdc, abi: ERC20_ABI, functionName: "balanceOf",
    args: acct ? [acct] : undefined, chainId, query: { enabled: !!acct && !!earnNet },
  });
  const morphoQ = useReadContract({
    address: morphoVnet?.target, abi: ERC4626_ABI, functionName: "maxWithdraw",
    args: acct ? [acct] : undefined, chainId,
    query: { enabled: !!acct && !!morphoVnet },
  });
  const walletRaw = usdcQ.data, ethRaw = ethQ.data, aaveRaw = aaveQ.data, morphoRaw = morphoQ.data;

  const walletUsdc = walletRaw != null ? Number(formatUnits(walletRaw as bigint, net.stableDecimals)) : null;
  const ethBal     = ethRaw ? Number(formatUnits(ethRaw.value, ethRaw.decimals)) : null;
  const aavePos    = aaveRaw != null ? Number(formatUnits(aaveRaw as bigint, 6)) : null;
  const morphoPos  = morphoRaw != null ? Number(formatUnits(morphoRaw as bigint, 6)) : null;

  // ── Two rate fetches used to run here, on every wallet load ──────────────
  // `/api/yield/rates` (DefiLlama) fed three APY boards, and
  // `/api/yield/morpho-history` fed a 30-day sparkline. All four surfaces are
  // gone, so the calls are too.
  //
  // Worth recording why they were a liability and not just clutter: neither was
  // passed `network`. They returned MAINNET pool yields regardless of the chain
  // the dashboard was reading, so on testnet the page quoted real-money APYs
  // over play-money balances. That was survivable only because mainnet is the
  // default — a comment used to sit here saying exactly that, load-bearing and
  // one config change from being wrong. Deleting the fetches deletes the trap.
  //
  // `/api/yield/morpho-history` goes in THIS commit rather than a cleanup pass:
  // its header named the sparkline above as its only consumer, and a repo-wide
  // grep confirms it now has zero callers. The retiring rule is one commit, and
  // an orphaned route that still answers is the shape of every surface this repo
  // has had to retire late. `/api/yield/rates` STAYS — the chat tool cards
  // (`chat/components/ToolCards.tsx`) still call it, so it is not orphaned.
  //
  // ── Real wallet history (Moralis) ────────────────────────────────────────
  type TxStats = { transferCountMonth: number; netFlowUsdcMonth: number; gasSavedUsd: number | null; ethUsdPrice: number | null };
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

  // ── How much of the balance did we actually READ? ────────────────────────
  //
  // Four states, one derivation — `lib/wallet/read-state.ts`, the same module
  // the three holdings tables use. This file was the FOURTH hand-rolled copy of
  // that question and the only one gating a *score*. It read:
  //
  //     const balancesKnown = walletUsdc != null;
  //
  // One boolean where there are four answers. The comment that used to sit here
  // even NAMED the distinction — "null while the contract read is in flight or
  // has failed" — and then discarded it, so:
  //
  //   · a FAILED USDC read rendered "Reading…" forever, with no path out of the
  //     spinner. Identical to the bug fixed in RhTokenTable, one folder over.
  //   · a PARTIAL read (Aave or Morpho short) was graded as if complete, and its
  //     dollar total printed as a flat figure rather than the floor it is.
  //
  // The signals were never missing. wagmi hands back status/isError/isPending on
  // every query above; all three destructures took only `.data`.
  //
  // A leg that does not APPLY on this chain (no Aave market, no Morpho vault) is
  // not an unread leg — it is not a leg at all. `enabled: false` leaves a query
  // permanently `isPending`, so counting one would pin the page to "Reading…"
  // on every chain that lacks a venue.
  const legs = [
    { applies: !!acct,                 q: usdcQ },
    { applies: !!acct && !!earnNet,    q: aaveQ },
    { applies: !!acct && !!morphoVnet, q: morphoQ },
  ].filter(l => l.applies);

  // This wallet's "rows" are its FUNDED positions — the things there are to
  // show. A real count rather than a 0/1 flag, because each leg holds
  // independently and `resolveRead` uses it to decide whether a degraded read
  // still has something to display (qualify it) or nothing (say so plainly).
  const fundedLegs = [walletUsdc, aavePos, morphoPos].filter(v => v != null && v > 0).length;

  const balanceRead = resolveRead({
    loading:  legs.some(l => l.q.isLoading),
    received: legs.length > 0 && legs.every(l => !l.q.isPending),
    // USDC is the PRIMARY leg: `total` is denominated in it and every claim this
    // page makes rests on it. Without it nothing is known — strictly weaker than
    // "we got some", which is why `failed` outranks `partial` in the module.
    failed:   usdcQ.isError,
    // Any leg short of success makes `total` a FLOOR — the user holds at least
    // this much, possibly more. Rendered with "≥", never as a flat figure.
    partial:  legs.some(l => l.q.isError),
    rowCount: fundedLegs,
  });
  // "≥" wherever a total is printed from a read that did not cover everything.
  const floor = balanceRead.totalIsFloor ? "≥ " : "";

  // Stats from real wallet history (this calendar month)
  const netFlowMonth      = txData?.stats?.netFlowUsdcMonth ?? 0;
  const transferCountMonth = txData?.stats?.transferCountMonth ?? 0;
  // Live ETH/USD (CoinGecko, via the transactions route). `null` = the feed did
  // not answer — kept null all the way to the render so nothing downstream can
  // quietly substitute a constant, which is what `ethBal * 2500` used to be.
  const ethUsdPrice        = txData?.stats?.ethUsdPrice ?? null;
  const gasSavedUsd        = txData?.stats?.gasSavedUsd ?? null;

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
          // The prompt states balances and no rate. It used to end
          // "In yield: $X at Y%", where Y was `bestApy` — DefiLlama's top USDC
          // pool, a market-wide figure, not this user's position. The assistant
          // read it as the user's own rate and quoted it back. With the yield
          // entrance closed there is no rate to state at all, and the old
          // "Focus on Base DeFi" steer pointed answers at a product this page
          // no longer sells.
          // Same `displayName` the header greets with — this was a FOURTH copy of
          // the ladder and the most degraded of them (it omitted even `fname`),
          // so the assistant addressed by hex a user the page had just greeted by
          // name. One derivation, every consumer.
          // `balanceForPrompt` carries the READ STATE, not just the numbers —
          // see its definition. This interpolated `$${usd(total)}` directly,
          // which is "$0.00" for any read that had not landed or had failed.
          system: `You are BlueAgent Wallet assistant. User: ${displayName}. ${balanceForPrompt} Answer concisely in 2-3 sentences. Help with balances, sending and receiving on Base, and withdrawing supplied funds. Never state a balance that is marked UNKNOWN or NOT YET READ above, and never describe an unread balance as zero or empty. Do not recommend yield strategies or quote APYs — this wallet no longer offers them.`,
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
    // `network` is already in the query string — the human title has to agree
    // with it, or a Sepolia link gets shared reading "Pay me on Base".
    const title = parseFloat(reqAmount) > 0 ? `Pay me ${reqAmount} ${reqAsset} on ${net.short}` : `Pay me on ${net.short}`;
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
    netFlowMonth,
    transferCountMonth,
    ethUsdPrice,
    gasSavedUsd,
  }), [walletUsdc, aavePos, morphoPos, ethBal, netFlowMonth, transferCountMonth, ethUsdPrice, gasSavedUsd]);

  // ── The wallet's totals — ONE definition, this one ────────────────────────
  //
  // These were `const inYield = (aavePos ?? 0) + (morphoPos ?? 0)` and
  // `const total = (walletUsdc ?? 0) + inYield`, sitting ~160 lines above.
  // `buildWalletState` computes byte-identical expressions (wallet-state.ts:24-25),
  // so the page carried two independent definitions of "what this wallet holds"
  // and rendered BOTH: the chat system prompt read `total`, the balance headings
  // read `walletState.balance`. They agree today only because the two
  // expressions happen to match character for character.
  //
  // KEPT: the module. It is shared, unit-testable, and already the source for
  // `ethUsd` / `pricedTotal` / `ethUnpriced` / `holdsAssets` — four values that
  // were collapsed into it for exactly this reason (see the note above
  // `portfolioData`). Leaving `total` and `inYield` behind meant that earlier
  // dedupe took four of six copies and the survivors kept breeding, which is why
  // the reason is written here instead of only in a commit message.
  //
  // DELETED: the local pair. Aliased rather than renamed at ~20 call sites so
  // the diff stays a dedupe rather than a rename, and so any future third copy
  // has to walk past this comment to get written.
  const { balance: total, inYield } = walletState;

  // `inYield` collapses "the read has not resolved" into 0, and the withdraw
  // path is gated on `inYield > 0` — so an RPC that fails and stays null would
  // hide the ONLY exit from a user who really does have USDC supplied. Anything
  // that gates the exit must ask "is it positively known to be zero", not "is it
  // zero". Cosmetic gates (widgets that print a dollar figure) stay on
  // `inYield > 0`: those must not assert $0.00 from a read that never landed.
  const noPositions = aavePos != null && morphoPos != null && inYield === 0;

  // ── What the chat assistant is told about the balance ────────────────────
  //
  // The prompt is the FIFTH consumer of this read and the one with the least
  // supervision: the user never sees the string, and an LLM handed
  // "Balance: $0.00" will state it back as fact in a confident sentence. On a
  // pending or failed read `total` is the number 0 (`(walletUsdc ?? 0) + …`),
  // so the assistant was being told the wallet was empty by a page that had
  // not managed to read it — and then asked to "help with balances".
  //
  // Every other consumer got a dash or a banner; this one got the number,
  // because a template literal has nowhere to put a caveat unless one is
  // written. So it is written. The instruction is explicit rather than implied
  // by an em-dash, since the model is the one thing here that will happily
  // interpolate around a missing value.
  const balanceForPrompt =
    balanceRead.body === "pending"
      ? "Balance: NOT YET READ (request still in flight)."
      : balanceRead.body === "failed"
        ? `Balance: UNKNOWN — the ${net.short} balance read failed. Do not state or imply any amount, and do not say the wallet is empty; say the balance could not be read and offer to retry.`
        : `Balance: ${floor}$${usd(total)} · USDC: ${walletUsdc == null ? "UNREAD" : `$${usd(walletUsdc)}`} · Supplied, withdraw-only: $${usd(inYield)}. ETH: ${ethBal?.toFixed(4) ?? "UNREAD"}.${
            balanceRead.totalIsFloor
              ? " NOTE: part of this wallet could not be read, so these are LOWER BOUNDS. Say 'at least' and never present them as the full balance."
              : ""
          }`;

  // What the connected account IS — read off the live connector + on-chain
  // bytecode, never asserted. Called here (above the early return) because it
  // is a hook; it returns a fully "unknown" identity when nothing is connected.
  const identity = useWalletIdentity(chainId);

  if (!isConnected) {
    return <BankLanding />;
  }

  // The Withdraw tab is hidden only for a wallet POSITIVELY known to hold
  // nothing — it is the exit from a feature whose entrance is closed, so a
  // read that has not resolved keeps it visible. Hiding it on a stale null
  // would strand a depositor's funds; showing it on an empty wallet costs a
  // tab that reports "no positions".
  const TABS: { id: Panel; label: string; icon: string; desc: string }[] = [
    { id: "positions", label: "Positions", icon: "📊", desc: "Your yield" },
    ...(noPositions ? [] : [{ id: "withdraw" as Panel, label: "Withdraw", icon: "↩︎", desc: "Exit yield" }]),
    { id: "send",      label: "Send",      icon: "➡",  desc: "Pay anyone" },
    { id: "receive",   label: "Receive",   icon: "⬇",  desc: "Get paid" },
    { id: "convert",   label: "Convert",   icon: "⇅",  desc: "Swap tokens" },
  ];

  // Orders is NOT gated on B20_ENABLED, unlike the modal tab it replaces.
  // That gate hid the whole panel while the panel's own banner read "Payment
  // links work now. B20 USDC auto-settlement … go live at B20 mainnet" — so the
  // flag that only turns off AUTO-SETTLEMENT was turning off the feature. With
  // it off today, the AI mission below still offered a "Try" button that opened
  // the modal onto a tab that did not exist: an empty box. OrdersPanel already
  // states its own degraded mode; the tab lets a user reach it to read that.
  const VIEWS: { id: View; label: string }[] = [
    { id: "portfolio", label: "Portfolio" },
    { id: "activity",  label: "Activity" },
    { id: "orders",    label: "Payment requests" },
  ];

  // ── Portfolio allocation (for pie chart) ─────────────────────────────────
  // `ethUsd` was `(ethBal ?? 0) * 2500` — a hardcoded ETH price, invented at a
  // moment when it happened to be roughly right and never true again. It fed
  // both this chart and `divScore` below, so a stale constant was silently
  // grading the user's portfolio. It is now the live price or nothing: `null`
  // drops the ETH slice out of the chart rather than drawing it at a made-up
  // size, and the caption says the leg is unpriced.
  //
  // These four values were then recomputed HERE with the same expressions that
  // `buildWalletState` already runs. Two copies of one derivation is how the
  // card ended up disagreeing with itself; the copies are gone and this reads
  // the canonical state.
  const { ethUsd, pricedTotal, ethUnpriced, holdsAssets } = walletState;
  const portfolioData = [
    { name: "Stablecoin", value: walletState.balance, color: "#4FC3F7" },
    { name: "ETH",        value: ethUsd ?? 0,         color: "#94A3B8" },
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
  // `null` means NO SCORE, and that is the whole point of this block.
  //
  // It used to read `total === 0 ? 0 : …`, which rendered a brand-new empty
  // wallet as a red **0/100 · D** with a Share button under it. That is worse
  // than an invented number: it invents a BAD one, out of the absence of data,
  // and shows it to the user least equipped to dismiss it — someone who just
  // connected and has no idea whether the app is grading them or their wallet.
  // Every input here (deployed ratio, diversification, gas, activity) is
  // undefined on an empty or unread wallet, so the honest output is "—", not a
  // failing grade. CLAUDE.md: missing data is "unknown", never an inferred
  // negative score.
  //
  // `balanceRead` guards the loading case too — during the RPC round-trip a
  // funded wallet also looks empty, and it must not flash a grade it is about
  // to contradict. It now guards two MORE cases that the old `balancesKnown`
  // boolean could not express: a read that FAILED, and one that came back
  // short. A grade is a claim about the user's whole position, so it requires a
  // COMPLETE read — a partial one would grade a wallet against a picture known
  // to be missing part of it.
  //
  // The heaviest term used to be `yieldScore` — 40% of the grade, keyed on what
  // fraction of the balance was supplied into Aave/Morpho, floor 20 for anyone
  // supplying nothing. With the Earn entrance closed that is a 40% penalty for
  // declining to use a feature the wallet no longer offers, which every user
  // now permanently fails and none of them can fix. A score has to be about
  // something the user can act on, so it is gone and the surviving three
  // dimensions are reweighted to sum to 1 rather than silently rescaled.
  // Diversification degrades honestly when ETH has no price: "holds ETH at all"
  // is still knowable from the balance, only the ">5% of portfolio" tier needs
  // a price. Previously both tiers were decided by a constant.
  const divScore       = ethUsd != null && pricedTotal > 0 && ethUsd / pricedTotal > 0.05 ? 88
                       : (ethBal ?? 0) > 0 ? 65 : 45;
  // `null`, not 50, when the ETH balance never arrived. This read
  // `ethBal == null ? 50 : …` — a middling grade invented out of an absent
  // measurement and then given 35% of the weight, with a second 40% flowing
  // through `divScore`'s ETH tiers. Three quarters of the score could be
  // fabricated from a failed `useBalance` and it still printed a letter grade.
  // CLAUDE.md: missing data is "unknown", never an inferred value.
  const gasScore: number | null =
    ethBal == null ? null : ethBal > 0.05 ? 95 : ethBal > 0.01 ? 80 : ethBal > 0.005 ? 60 : 20;
  const actScore       = transferCountMonth > 10 ? 90 : transferCountMonth > 5 ? 75 : transferCountMonth > 1 ? 55 : 20;
  // COMPLETE, not merely "known" — see the note above. `gasScore != null` folds
  // in the ETH leg, which is not part of `total` and so is deliberately not one
  // of `balanceRead`'s legs, but which three quarters of this grade rests on.
  const scoreReady     = balanceRead.state === "complete" && total > 0 && gasScore != null;
  const portfolioScore: number | null =
    scoreReady && gasScore != null ? Math.round(divScore * 0.4 + gasScore * 0.35 + actScore * 0.25) : null;
  const scoreGrade     = portfolioScore == null ? null : portfolioScore >= 85 ? "A" : portfolioScore >= 70 ? "B" : portfolioScore >= 55 ? "C" : "D";
  // Slate, not red, when there is no score — colour is a claim too.
  const scoreColor     = portfolioScore == null ? "#475569"
    : portfolioScore >= 85 ? "#34D399" : portfolioScore >= 70 ? "#4FC3F7" : portfolioScore >= 55 ? "#F59E0B" : "#EF4444";

  // ── Mission Control items ─────────────────────────────────────────────────
  interface MC { priority: "high"|"warn"|"good"|"info"; icon: string; text: string; action?: string; onAction?: () => void; color: string }
  const allMissions: MC[] = [];
  // A mission is ADVICE ABOUT THE USER'S POSITION, so it needs a position that
  // was actually read. Three of the five bodies produce none: not read yet, not
  // read at all, and read but short — the last of which used to fall through to
  // the `total === 0` branch and tell someone to fund a wallet whose balance we
  // had just failed to fetch. An empty list beats a confident wrong instruction.
  if (balanceRead.body === "pending" || balanceRead.body === "failed" || balanceRead.body === "partial") {
    /* nothing to advise until the balance read lands, in full */
  } else if (balanceRead.body === "empty") {
    allMissions.push({ priority: "info", icon: "💡", text: `Add USDC to fund your wallet on ${net.short}`, action: "Add cash", onAction: addCash, color: "#F59E0B" });
  } else {
    // The two missions that used to sit here — "$X idle, earn ~$Y/mo" and
    // "Enable Auto Earn" — both invited a NEW supply, which is the entrance
    // the last release closed. Only the passive one below survives: it reports
    // a position the user already holds rather than asking for another.
    //
    // Auto Earn is gone outright, not hidden. It persisted a flag to
    // localStorage and nothing anywhere read it back, so the toggle promised
    // an auto-deploy that never ran once.
    //
    // The surviving line no longer quotes a rate or projects a monthly figure.
    // Both came from `bestApy` — the TOP pool on DefiLlama, not the pool this
    // user is actually in — so "$500 earning 6.1% · ~$3/month" was a real
    // balance multiplied by someone else's yield. The balance is measured; the
    // return on it was never something this page could read.
    if (inYield > 0)
      allMissions.push({ priority: "good", icon: "✅", text: `$${usd(inYield)} supplied — withdrawable any time`, action: "Withdraw", onAction: () => openAction("withdraw"), color: "#34D399" });
    if (ethBal != null && ethBal < 0.005)
      allMissions.push({ priority: "warn", icon: "⛽", text: "ETH too low for gas fees", action: "Get ETH", onAction: () => openAction("convert"), color: "#F59E0B" });
    // "Try" used to call `openAction("orders")`. With B20_ENABLED off that
    // opened the action modal onto a panel whose tab had been filtered out of
    // TABS and whose body had no branch — a modal containing a close button and
    // nothing else. It now scrolls to a tab that always exists.
    if (new Date() >= new Date("2026-06-25"))
      allMissions.push({ priority: "info", icon: "⚡", text: "Beryl live — B20 payments + faster L1 withdrawals", action: "Try", onAction: () => setView("orders"), color: "#4FC3F7" });
  }
  const topMissions = allMissions.slice(0, 3);
  // Gated on the BALANCE READ, not on `total`.
  //
  // The first branch used to be `total === 0 ? "Connect and add funds…"`, which
  // is unreachable-by-intent nonsense: this whole render sits below
  // `if (!isConnected) return <BankLanding/>`, so the wallet is ALREADY
  // connected here. A connected user with a zero balance — every new user, and
  // every existing user for the second or two the RPC takes — was told to
  // connect a wallet they were looking at the address of, right beside a
  // "Disconnect" button. Same defect family as the score above: a balance of
  // zero was read as a statement about the connection.
  //
  // The SECOND branch is the one that was live in production: `!balancesKnown`
  // where `balancesKnown === walletUsdc != null`. A USDC read that ERRORED
  // leaves `walletUsdc` null forever, so the line read "Reading your balances…"
  // for as long as the page stayed open — a spinner sentence describing a
  // request that had already finished, and failed. Nothing retried, nothing
  // said so. Now `pending` and `failed` are different sentences because they
  // are different facts, and neither is `empty`.
  const missionSummary =
    balanceRead.body === "pending" ? "Reading your balances…" :
    balanceRead.body === "failed"  ? `Couldn't read your balance on ${net.short} — unknown, not zero.` :
    balanceRead.body === "partial" ? `Part of your position on ${net.short} could not be read — unknown, not empty.` :
    balanceRead.body === "empty"   ? `Wallet connected · add USDC on ${net.short} to get started.` :
    // `body === "rows"`: something is funded. `rowCount > 0` outranks `failed`
    // in the module, so this branch is reachable with the USDC leg itself
    // errored and a supplied position still read — hence the liquid figure is
    // named only when it is known, rather than rendering "$—" as if that were
    // an amount. `floor` marks the total as a lower bound either way.
    walletUsdc == null ? `${floor}$${usd(inYield)} supplied · liquid balance unread` :
    inYield > 0 ? `${floor}$${usd(walletUsdc)} liquid · $${usd(inYield)} supplied` :
    `${floor}$${usd(walletUsdc)} USDC on ${net.short}`;

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";

  // ── The header trust strip — WHERE am I and WHOSE keys are these ──────────
  //
  // This row used to carry four chips: Non-custodial · {network} ·
  // {connectionLabel} · Passkey. The last two are gone, and the split is the
  // point: there are two different questions on this page and they had been
  // interleaved across two rows that each answered half of each.
  //
  //   header (here)      → where am I, whose keys           — never scrolls
  //   health-card chips  → what KIND of account is this      — captioned, wraps
  //
  // `connectionLabel` and `passkey` are read off `useWalletIdentity`, which
  // returns three facts about the account: connector family, smart-vs-EOA, and
  // passkey. The health card renders all three together; this row rendered two
  // of the three, so the header could say "Coinbase Wallet · Passkey" while
  // never saying whether the account is a smart wallet or an EOA — two thirds
  // of a derivation, which is a worse artifact than either the whole or none.
  //
  // KEPT here: the two that are NOT about the account. `net.short` is about the
  // chain (and is the one chip that can warn — it was the literal "Base" while
  // the app defaulted to Sepolia, directly above the receive QR). "Non-custodial"
  // is about THIS APP, which holds no key and no fund; it is the answer to the
  // question a stranger asks first, so it belongs beside the address in a bar
  // that never scrolls away.
  //
  // KEPT on the health card: the account triple, intact. It is the complete set
  // and it is the only row that has room for it.
  //
  // One array, two renderings — the chips at `sm` and up, and the `sm:hidden`
  // line under the greeting. Those two are complementary by construction, so
  // the same claim is never on screen twice.
  const trustChips: { label: string; warn: boolean }[] = [
    { label: "Non-custodial", warn: false },
    { label: net.short,       warn: isTestnet },
  ];

  return (
    <div className="flex h-full w-full bg-[#050508] text-slate-200 overflow-hidden">

      {/* ── SIDEBAR ─────────────────────────────────────────────────────── */}
      <aside className="hidden md:flex flex-col shrink-0 h-full border-r border-[#1A1A2E] bg-[#050508] overflow-y-auto w-56 lg:w-60 xl:w-64 2xl:w-72 3xl:w-80">
        {/* 1. Header */}
        <div className="px-4 h-14 flex items-center gap-2 border-b border-[#1A1A2E] shrink-0">
          <span className="w-1.5 h-1.5 rounded-full bg-[#4FC3F7] animate-pulse shrink-0" />
          <p className="font-mono text-[11px] text-[#4FC3F7] tracking-widest">// WALLET</p>
        </div>

        {/* 2 + 3. The USDC widget and the SUPPLIED card were here.
            ─────────────────────────────────────────────────────────────────
            Both rendered numbers the Section-1 balance card renders again, on
            the same screen at the same moment: `walletState.balance` at 22px
            here and 28px there, `walletState.inYield` in this caption, in the
            SUPPLIED card, AND as the aUSDC/Morpho rows there. One derivation,
            four renderings, two of which were inside this aside.

            KEPT: the balance card (Section 1). Three reasons, in order of
            weight —
              1. It is the only copy with the BREAKDOWN. The itemised USDC /
                 aUSDC / Morpho / ETH rows and the low-gas warning live there
                 because a previous release deliberately merged them in when it
                 deleted the Section-2 WALLET card (see the note above Section
                 2). Keeping this widget instead would re-open that.
              2. This aside is `hidden md:flex` — it does not exist below `md`,
                 so it can never be the canonical answer for a phone. The card
                 renders at every breakpoint.
              3. The card sits beside ACTIONS, so the number and the buttons
                 that change it are adjacent.

            DELETED: these two. The reason is written here rather than only in
            the commit because the Section-2 delete recorded its reasoning and
            still left this copy standing — the survivor bred. Anyone tempted
            to put a balance back in the sidebar has to delete this paragraph
            first.

            The Withdraw exit is NOT lost with the SUPPLIED card — it was a
            shortcut, not the path. Verified before deleting: `TABS` still
            carries the Withdraw tab whenever `noPositions` is false, the
            Positions panel's PositionRow rows both `setPanel("withdraw")`, and
            the `inYield > 0` mission keeps a one-click "Withdraw" that is
            always inside `topMissions` (its branch pushes at most three). */}

        {/* 4. BlueAgent mini chat — `mt-3` because the deleted widget above
            carried the top margin for everything under the header. */}
        <div className="mx-3 mt-3 mb-3">
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

        {/* 5. ⚡ BASE APPS was here — a six-tile grid of outbound links to
            Aerodrome, Moonwell, Morpho, Uniswap, Aave and Compound, in six
            different brand colours, pinned above the network switcher.

            Three separate reasons it goes, any one of which is sufficient:
            it is a lending/yield shop window in a wallet that no longer sells
            yield; it is the only block on the page whose every control leaves
            the product; and its six brand colours were the single largest
            source of decorative colour in the app (see the palette pass). */}

        {/* 6. Spacer */}
        <div className="flex-1" />

        {/* 7. Chains — the two this wallet reads, and what each one carries.
            Titled NETWORK (singular) over one switchable chain, while the stock
            table below has been reading a second one all along: readStockHoldings
            returns `legs: [base, rh]` on every call, unconditionally. So the
            wallet already spanned two chains and said so nowhere.

            Robinhood is a ROW, not a button, and that asymmetry is deliberate —
            it is not `WALLET_CHAIN_ORDER` being conservative for its own sake.
            Making it selectable would repoint `chainId` at 4663, and three
            things downstream would keep answering in Base:

              /api/wallet/transactions  CHAIN[network] ?? "base"  → Base txs
              /api/wallet/holdings      same shape                → Base tokens
              TokenTable                84532 ? sepolia : base    → labelled Base

            (RH holdings themselves are no longer among them: /api/wallet/rh-holdings
            reads chain 4663 through Blockscout and mounts unconditionally on
            mainnet. That closed the read gap; the five below are about MOVING
            money, and they are why this is still a row and not a button.)

            …and two would still MOVE REAL MONEY on Base: addCash/cashOut pin
            `defaultNetwork=base` in the Coinbase Onramp URL, and SwapCard
            force-switches the wallet to mainnet before signing. A picker that
            silently sends Base data and Base money under a Robinhood heading is
            the "testnet balances under a Base label" bug with the chains
            swapped. Until those five are chain-aware, the honest surface is the
            one below: name the chain, say what is actually read from it, and
            offer the only control that works there — its own explorer. */}
        <div className="px-3 pb-3">
          <div className="font-mono text-[9px] text-slate-600 mb-1.5">CHAINS</div>
          {testnetUnlocked ? (
            <div className="flex gap-1">
              {WALLET_CHAIN_ORDER.map(nk => (
                <button key={nk} onClick={() => setNetwork(nk)}
                  className="flex-1 font-mono text-[10px] py-1.5 rounded-md transition-colors"
                  style={network === nk
                    ? WALLET_CHAINS[nk].testnet
                      ? { background: "#F59E0B15", color: "#F59E0B", border: "1px solid #F59E0B30" }
                      : { background: "#4FC3F715", color: "#4FC3F7", border: "1px solid #4FC3F730" }
                    : { color: "#64748b", border: "1px solid #1A1A2E" }}>
                  {WALLET_CHAINS[nk].short}
                </button>
              ))}
            </div>
          ) : (
            <div className="font-mono text-[10px] py-1.5 px-2 rounded-md"
              style={{ background: "#4FC3F70d", color: "#4FC3F7", border: "1px solid #4FC3F725" }}>
              <div className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-[#4FC3F7]" />
                {net.label}
              </div>
              <div className="font-mono text-[9px] text-slate-600 mt-0.5 pl-3">
                cash · send · swap · agent payments
              </div>
            </div>
          )}
          {/* Gated on the SAME predicate as the RH tables' mount, so this row can
              never claim a leg the page is not reading. On testnet both are
              absent (no B20 or RWA testnet twin), so this is too. */}
          {!isTestnet && (
            // `?tab=tokens`, not the bare address page. The subtitle under this
            // row promises "tokens · tokenized stocks", and Blockscout's default
            // address view is the TRANSACTION list — so the link answered a
            // question it had not been asked, and an RH holder following it saw
            // transfers where they were told they would see holdings.
            // Same URL RhTokenTable.tsx:151 already builds for its "full list on
            // Blockscout" escape hatch; this row was the one place that dropped
            // the tab and landed somewhere else.
            <a href={`${WALLET_CHAINS.robinhood.explorer}/address/${acct}?tab=tokens`}
              target="_blank" rel="noopener noreferrer"
              className="block mt-1.5 font-mono text-[10px] py-1.5 px-2 rounded-md border border-[#1A1A2E] hover:border-[#4FC3F730] transition-colors">
              <div className="flex items-center gap-1.5 text-slate-400">
                <span className="w-1.5 h-1.5 rounded-full bg-[#1A1A2E] border border-slate-700" />
                {WALLET_CHAINS.robinhood.label}
              </div>
              <div className="font-mono text-[9px] text-slate-600 mt-0.5 pl-3">
                tokens · tokenized stocks · read-only ↗
              </div>
            </a>
          )}
        </div>

        {/* 8. Account chip */}
        <div className="px-4 py-3 border-t border-[#1A1A2E]">
          <div className="font-mono text-[11px] text-slate-300 truncate">{displayName}</div>
          <div className="flex items-center gap-2 mt-0.5">
            <a href={`${net.explorer}/address/${acct}`} target="_blank" rel="noopener noreferrer"
              className="font-mono text-[9px] text-slate-600 hover:text-[#4FC3F7]">{net.explorerName} ↗</a>
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
                Good {greeting}, <span className="text-[#4FC3F7]">{displayName}</span>
              </p>
              {/* The same `trustChips`, and `sm:hidden` against the row's
                  `hidden sm:flex` — complementary, so exactly one of the two is
                  ever on screen. It used to be the literal string
                  "{net.short} · Non-custodial · You hold the keys", which put
                  BOTH of those claims twice inside one 56px bar at `sm` and up.
                  Worse, this copy was always plain grey while the chip beside it
                  turns amber on testnet: the header said "Sepolia" calmly and
                  "Sepolia" alarmingly, 200px apart, and the calm one was wrong.
                  It carries the warn colour now, because below `sm` it is the
                  only carrier.

                  "You hold the keys" went with it. It is not a fourth claim —
                  it is "Non-custodial" restated in plain English, and a synonym
                  is still a copy. */}
              <p className="font-mono text-[9px] truncate sm:hidden"
                style={{ color: trustChips.some(c => c.warn) ? "#F59E0B" : "#475569" }}>
                {trustChips.map(c => c.label).join(" · ")}
              </p>
            </div>
          </div>
          <div className="hidden sm:flex items-center gap-1.5 shrink-0">
            {trustChips.map(c => (
              <span key={c.label} className="font-mono text-[9px] px-2 py-1 rounded-md"
                style={c.warn
                  ? { color: "#F59E0B", border: "1px solid #F59E0B40", background: "#F59E0B10" }
                  : { color: "#94A3B8", border: "1px solid #1A1A2E", background: "#0d0d12" }}>{c.label}</span>
            ))}
            {new Date() >= new Date("2026-06-25") && (
              <span className="font-mono text-[9px] px-2 py-1 rounded-md font-bold"
                style={{ color: "#4FC3F7", border: "1px solid #4FC3F730", background: "#4FC3F710" }}>⚡ Beryl</span>
            )}
          </div>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto p-3 sm:p-4 xl:p-5 2xl:p-6 3xl:p-8">

          {/* Testnet banner — the whole point of the opt-in. If a page can show
              testnet balances and hand out a testnet receive QR, it has to say
              so louder than the chip in the header does. */}
          {isTestnet && (
            <div className="mb-3 rounded-xl px-3.5 py-2.5 flex items-center justify-between gap-3"
              style={{ background: "#F59E0B10", border: "1px solid #F59E0B40" }}>
              <div className="min-w-0">
                <div className="font-mono text-[11px] font-bold" style={{ color: "#F59E0B" }}>
                  ⚠ Testnet — {net.label}
                </div>
                <div className="font-mono text-[9px] text-slate-400 mt-0.5">
                  Balances, QR codes and payment links on this page are test-only and hold no real value.
                </div>
              </div>
              <button onClick={() => setNetwork("base")}
                className="shrink-0 font-mono text-[10px] font-bold px-3 py-1.5 rounded-lg transition-opacity hover:opacity-80"
                style={{ background: "#F59E0B", color: "#050508" }}>
                Switch to Base
              </button>
            </div>
          )}

          {/* Wallet-vs-app chain mismatch. Reads are pinned to `chainId` so the
              numbers above stay correct, but every signature would be rejected —
              better to say it here than at the wallet prompt. */}
          {chainMismatch && (
            <div className="mb-3 rounded-xl px-3.5 py-2.5 flex items-center justify-between gap-3"
              style={{ background: "#4FC3F70d", border: "1px solid #4FC3F740" }}>
              <div className="min-w-0">
                <div className="font-mono text-[11px] font-bold" style={{ color: "#4FC3F7" }}>
                  Wallet is on {walletChain?.name ?? `chain ${walletChainId}`}
                </div>
                <div className="font-mono text-[9px] text-slate-400 mt-0.5">
                  Balances below are read from {net.label}. Send and swap need your wallet on the same network.
                </div>
              </div>
              <button onClick={switchToAppChain} disabled={switchBusy}
                className="shrink-0 font-mono text-[10px] font-bold px-3 py-1.5 rounded-lg transition-opacity hover:opacity-80 disabled:opacity-50"
                style={{ background: "#4FC3F7", color: "#050508" }}>
                {switchBusy ? "…" : `Switch to ${net.short}`}
              </button>
            </div>
          )}

          {/* ── Section 1: Balance | Actions | Health ─────────────────────── */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3 items-start">

            {/* Balance card */}
            <div className="rounded-2xl border border-[#1A1A2E] bg-[#0a0a0f] p-4">
              {/* Was "TOTAL BALANCE" — over a stablecoins-only figure, with an
                  "ETH (gas)" row listed underneath it that the total excludes.
                  A heading is a claim about what was summed. Then "USDC + YIELD"
                  while the wallet sold yield; the rows below still itemise a
                  supplied position when there is one, so "USDC" covers it. */}
              <div className="font-mono text-[9px] text-slate-500 tracking-widest mb-2">USDC</div>
              {/* White, not the accent — colour is decoration on a figure the
                  eye already finds; the three semantic colours are reserved
                  for claims. (This used to read "same reason as the sidebar
                  figure above"; that figure was the duplicate deleted in the
                  dedupe pass, and this is now the only balance on the page.)
                  ── and the single most important consumer of `balanceRead`.
                  `walletState.balance` is `(walletUsdc ?? 0) + inYield`, so a
                  read still in flight — or one that FAILED — arrives here as
                  the number 0 and used to render "$0.00" at 28px: the largest,
                  most confident thing on the page, asserting a balance nobody
                  had measured. A dash is not a worse number, it is the absence
                  of a claim; "$0.00" is a claim, and `canAssertEmpty` is the
                  only thing that licenses it. Between them sits the floor: a
                  read that covered part of the wallet knows a LOWER BOUND, and
                  says so with "≥" rather than passing it off as the total. */}
              <div className="font-mono text-[28px] font-bold text-white">
                {balanceRead.body === "rows"  ? `${floor}$${usd(walletState.balance)}`
                  : balanceRead.body === "empty" ? `$${usd(0)}`
                  : "—"}
              </div>
              {/* Why the figure above is a dash, or carries a "≥". Never both
                  with the rows below — this is a caption on the total, and the
                  rows are individually gated on their own positive balances. */}
              {balanceRead.body === "pending" ? (
                <div className="font-mono text-[9px] text-slate-600 mt-1">reading {net.short}…</div>
              ) : balanceRead.body === "failed" ? (
                <div className="font-mono text-[9px] text-amber-500/80 mt-1 leading-relaxed">
                  Couldn&apos;t read your USDC balance on {net.short}. Unknown — not zero.
                </div>
              ) : balanceRead.totalIsFloor ? (
                <div className="font-mono text-[9px] text-amber-500/80 mt-1 leading-relaxed">
                  Part of this wallet could not be read — it holds at least this much.
                </div>
              ) : null}
              <div className="flex flex-col gap-1.5 mt-3">
                {(walletUsdc ?? 0) > 0 && (
                  <div className="flex justify-between font-mono text-[10px]">
                    <span className="text-slate-500">USDC</span>
                    <span className="text-slate-300">${usd(walletUsdc)}</span>
                  </div>
                )}
                {/* Both rows stay — they are the user's money, and a supplied
                    position that stops being shown is a position the user
                    cannot find. Already correctly gated on a POSITIVE balance,
                    so a wallet that never touched Earn sees neither. */}
                {(aavePos ?? 0) > 0 && (
                  <div className="flex justify-between font-mono text-[10px]">
                    <span className="text-slate-500">aUSDC (Aave)</span>
                    <span className="text-slate-300">${usd(aavePos)}</span>
                  </div>
                )}
                {(morphoPos ?? 0) > 0 && (
                  <div className="flex justify-between font-mono text-[10px]">
                    <span className="text-slate-500">Morpho</span>
                    <span className="text-slate-300">${usd(morphoPos)}</span>
                  </div>
                )}
                {/* `!= null`, not `> 0`. This row used to hide itself on a
                    wallet holding zero ETH — the one wallet that most needs to
                    be told, because zero ETH means it cannot sign anything at
                    all. It stayed hidden because the low-gas warning lived on a
                    SECOND card further down that rendered the same four rows
                    again; that card is gone (see Section 2) and the warning
                    lands here, on the only balance breakdown left.

                    It reads `ethBal`, not `walletState.gasReserveEth`: the
                    latter is `ethBal ?? 0`, so a read that never came back
                    would be warned about as if it had returned zero. */}
                {ethBal != null && (
                  <div className="flex justify-between font-mono text-[10px]">
                    <span className="text-slate-500">ETH (gas)</span>
                    <span className={ethBal < 0.005 ? "text-amber-400" : "text-slate-400"}>
                      {ethBal.toFixed(4)}
                    </span>
                  </div>
                )}
                {ethBal != null && ethBal < 0.005 && (
                  <div className="font-mono text-[9px] text-amber-400">⚠ Low — get ETH for gas</div>
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
                <button onClick={addCash} disabled={onrampBusy || !isConnected || !isBaseMainnet}
                  title={!isBaseMainnet ? "Base mainnet only" : undefined}
                  className="font-mono text-[11px] font-bold py-2.5 px-3 rounded-xl disabled:opacity-40 transition-opacity hover:opacity-80"
                  style={{ background: "#34D39910", color: "#34D399", border: "1px solid #34D39930" }}>
                  {onrampBusy ? "…" : "💵 Add"}
                </button>
                <button onClick={cashOut} disabled={cashOutBusy || !isConnected || !isBaseMainnet}
                  title={!isBaseMainnet ? "Base mainnet only" : undefined}
                  className="font-mono text-[11px] py-2.5 px-3 rounded-xl text-slate-400 disabled:opacity-40 transition-opacity hover:text-slate-200"
                  style={{ border: "1px solid #1A1A2E" }}>
                  {cashOutBusy ? "…" : "🏦 Out"}
                </button>
              </div>
              {/* 🌾 Earn used to lead this row. Supplying into Aave/Morpho is
                  deferred to phase 2, so the control that starts a deposit is
                  gone; the withdraw path lives on the Positions panel. */}
              <div className="flex gap-1.5">
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
                <div className="font-mono text-[32px] font-bold leading-none" style={{ color: scoreColor }}>
                  {portfolioScore ?? "—"}
                </div>
                {/* WHY there is no score, in the caller's own words. This was
                    `balancesKnown ? "No data yet" : "Reading…"` — two labels for
                    five outcomes, and the one that shipped was the wrong one:
                    an errored USDC read left `balancesKnown` false forever, so
                    a failed read displayed "Reading…" indefinitely. "No data
                    yet" was no better on a failed read — it reads as a fact
                    about the wallet ("nothing here") rather than about our
                    read ("we didn't get it"). Each branch below names which
                    input is missing, so the absence is attributable. */}
                <div className="font-mono text-[13px] text-slate-500 mb-1">
                  {portfolioScore != null ? `/100 · ${scoreGrade}`
                    /* `!!acct &&` for the same reason the legs are filtered by
                       `applies`: a disabled wagmi query is permanently
                       `isPending`, so an unguarded read of it would pin this to
                       "Reading…" rather than describe anything. */
                    : balanceRead.body === "pending" || (!!acct && ethQ.isPending) ? "Reading…"
                    : balanceRead.body === "failed"   ? "Balance unread"
                    : balanceRead.state === "partial" ? "Partial read"
                    : ethBal == null                  ? "Gas balance unread"
                    : "No data yet"}
                </div>
              </div>
              {/* Every chip below is DERIVED. `identity` comes from the live
                  connector + on-chain bytecode (lib/wallet/identity.ts); the
                  Basename chip from the ENS/Basename lookup. The two that used
                  to be `active={true}` — "Smart Wallet" and "Passkey" — were
                  true only for Coinbase Smart Wallet users and were shown to
                  everyone, so a MetaMask EOA was told it had a passkey.

                  This is now the ONLY place the account triple is rendered —
                  the header carried `connectionLabel` and the passkey too, and
                  it kept the two that are about the account while dropping the
                  one (`accountLabel`) that completes them. See `trustChips`. */}
              <div className="flex flex-wrap gap-1.5 mb-3">
                <IdentityChip label={identity.connectionLabel} active={identity.family !== "unknown"} color="#4FC3F7" />
                <IdentityChip label={identity.accountLabel} active={identity.accountKind === "smart"} color="#4FC3F7" />
                <IdentityChip label={identity.passkeyLabel} active={identity.passkey === "yes"} color="#34D399" />
                {/* Was #A78BFA — the only violet in the file, one chip in a row
                    of five, carrying no meaning the other four don't. The
                    palette is one primary plus three semantic colours (green
                    good / amber warn / red danger); a fifth hue used once is
                    decoration pretending to be a category.

                    KEPT despite the greeting above already printing a Basename
                    when there is one, because it is not the same claim: the
                    greeting answers "what do we call you" and this answers "does
                    this account have a Basename", which is a checklist item next
                    to Smart Wallet and Passkey and is the only one that renders
                    a NEGATIVE ("No Basename") the greeting can never say.

                    `?? fname` is gone though, and that is the price of keeping
                    it. A Farcaster username is not a Basename. With `fname`
                    accepted, someone with `@shun` on Farcaster and no Basename
                    saw a lit chip reading `@shun` in the slot whose unlit text
                    is "No Basename" — the chip asserting a Basename that does
                    not exist. Exactly the defect the passkey chip had two
                    paragraphs up. They still get greeted by name: `displayName`
                    splices `fname` in at the `source === "address"` rung. */}
                <IdentityChip label={name ?? "No Basename"} active={!!name} color="#4FC3F7" />
                {/* "Non-custodial" was a sixth chip here. It is a CONSTANT in a
                    row of five per-user derivations — its own note used to say
                    so ("unlike the chips above it cannot drift away from a
                    per-user truth it was never reading"), which is the argument
                    for moving it, not for keeping it here. It now appears once,
                    in the header trust strip, where it sits beside the address
                    and answers the question a stranger asks first. */}
              </div>
              {/* Share is hidden, not disabled, while there is no score.
                  Sharing a fabricated grade propagates the fabrication OUTSIDE
                  the app, where no later fix can reach it — the same reason a
                  testnet QR labelled "Base" was the dangerous part of PR 1. */}
              {portfolioScore != null && (
                <button
                  onClick={() => {
                    const text = `My ${net.short} wallet health: ${portfolioScore}/100 @blueagent_`;
                    navigator.clipboard?.writeText(text).catch(() => {});
                  }}
                  className="font-mono text-[9px] px-2.5 py-1 rounded-full transition-colors hover:opacity-80"
                  style={{ background: "#4FC3F710", color: "#4FC3F7", border: "1px solid #4FC3F730" }}>
                  Share
                </button>
              )}
            </div>

          </div>

          {/* ── Section 1.5: a link where the AGENT SPEND panel used to be ──
              The full <SpendConsole> lived here. It answers "what did I spend
              on BlueAgent", which is the same question /app/usage exists to
              answer with credits — two pages, one subject, and the numbers came
              from the same ledger, so they could disagree without either being
              wrong. The panel moved to /app/usage; this page keeps the money
              you hold and move, that page keeps what you consumed.

              A link, not a silent removal: the console is still the one thing
              here no generic Base wallet can show, and dropping the entrance to
              it would lose the feature rather than relocate it. */}
          <Link
            href="/app/usage"
            className="flex items-center justify-between mb-3 rounded-2xl border border-[#1A1A2E] bg-[#0a0a0f] px-4 py-3 hover:border-[#4FC3F730] transition-colors"
          >
            <div className="min-w-0">
              <div className="font-mono text-[9px] text-slate-500 tracking-widest">AGENT SPEND</div>
              <div className="font-mono text-[10px] text-slate-600 mt-0.5">
                What your payments bought, per tool — with your credit balance.
              </div>
            </div>
            <span className="font-mono text-[10px] text-[#4FC3F7] flex-shrink-0 ml-3">Usage →</span>
          </Link>

          {/* ── Section 2: AI Mission Control | Portfolio Allocation ────────
              A "WALLET" card led the left column here, listing USDC, aUSDC,
              Morpho and a GAS RESERVE row. Those are the same four rows the
              balance card in Section 1 already renders, from the same four
              variables, one screen-height apart — the same number written twice
              on one page, which is the defect the previous release fixed
              BETWEEN two pages. Two copies of one derivation is how a surface
              ends up disagreeing with itself; the wallet's own history has that
              happening three separate times (see the allocation card below).

              Its one non-duplicate pixel was the low-gas warning, which is why
              this is a merge and not a delete: that moved up into the Section 1
              ETH row, where it now also fires at exactly zero.

              A "YIELD RATES · BASE" board sat under it — the top four DefiLlama
              pools with comparison bars. The previous release gated it to
              holders only, on the argument that for them it was "context on the
              money they have in". It wasn't: it ranked FOUR pools, of which the
              user's was at most one, and the only action it offered was to go
              somewhere else. Context you can't act on is an advert with a
              smaller audience.

              With both gone the left column held nothing, so the two surviving
              cards are direct grid children rather than one-item stacks. */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mb-3 items-start">

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
                {/* ONE predicate for the whole card. It used to be two — the
                    chart asked `balance > 0` (stables only) and the bar below
                    asked whether a ratio existed (stables + priced ETH) — and
                    on a wallet holding dust ETH and no stables the card said
                    "No assets yet" and then drew "Stablecoin 0%" underneath.
                    Everything empty-able now hangs off `holdsAssets`, and the
                    bar is INSIDE this branch so it cannot escape again.

                    But `holdsAssets` answers "is there anything to chart", not
                    "did we manage to look" — it is derived from `pricedTotal`,
                    which is `(walletUsdc ?? 0) + inYield + …`, so an unread
                    balance reaches it as the number 0 and this card printed
                    "No assets yet" over a request that had failed. Same
                    sentence as the balance card's "$0.00", same cause, and the
                    module says only `canAssertEmpty` licenses it.

                    The branch order below is `resolveRead`'s own precedence,
                    deliberately: pending → rows → failed → partial → empty.
                    `holdsAssets` sits in the "rows" slot rather than
                    `body === "rows"` because it counts a leg this read does
                    not — a wallet holding only ETH has zero funded USDC legs
                    and is still not empty. */}
                {balanceRead.body === "pending" ? (
                  <div className="font-mono text-[10px] text-slate-600">reading {net.short}…</div>
                ) : holdsAssets ? (
                  <>
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
                      {/* Say so when the ETH leg is missing, rather than letting
                          the chart imply the wallet holds no ETH. */}
                      {ethUnpriced && (
                        <div className="font-mono text-[9px] text-slate-500">
                          {ethBal?.toFixed(4)} ETH — price unavailable, not charted
                        </div>
                      )}
                      {/* The other reason a slice can be too small: not an
                          unpriced leg, an unread one. Same caveat as the "≥"
                          on the balance card, in the shape it takes here. */}
                      {balanceRead.totalIsFloor && (
                        <div className="font-mono text-[9px] text-amber-500/80">
                          Part of the wallet was not read — slices are lower bounds
                        </div>
                      )}
                      <div className="font-mono text-[8px] text-slate-700 pt-1">ETH counted as gas reserve</div>
                      {walletState.gasSavedUsd != null && (
                        <div className="font-mono text-[9px] text-[#34D399]">~${walletState.gasSavedUsd} saved vs mainnet</div>
                      )}
                    </div>
                  </div>
                  {/* Nested inside `holdsAssets`, not a sibling of it. As a
                      sibling it rendered a percentage under "No assets yet" —
                      twice, in two different releases. `stablecoin != null` is
                      still required because a ratio can be unknown even when
                      the wallet plainly holds something (unpriced ETH leg). */}
                  {walletState.allocation.stablecoin != null ? (
                    <>
                      <div className="mt-3 flex items-center justify-between font-mono text-[10px]">
                        <span className="text-slate-500">Stablecoin</span>
                        <span className="text-[#4FC3F7] font-bold">{walletState.allocation.stablecoin}%</span>
                      </div>
                      <div className="h-1.5 rounded-full bg-[#1A1A2E] overflow-hidden mt-1">
                        <div className="h-full rounded-full bg-[#4FC3F7]"
                          style={{ width: `${walletState.allocation.stablecoin}%` }} />
                      </div>
                    </>
                  ) : (
                    <div className="mt-3 font-mono text-[9px] text-slate-600">
                      Split unknown — ETH price unavailable
                    </div>
                  )}
                  </>
                ) : balanceRead.body === "failed" ? (
                  <div className="rounded-lg px-3 py-2.5 font-mono text-[9px] leading-relaxed text-amber-500/80"
                    style={{ border: "1px solid #F59E0B30", background: "#F59E0B08" }}>
                    Your balance on {net.short} could not be read. The allocation is unknown —
                    this is not an empty wallet.
                  </div>
                ) : balanceRead.body === "partial" ? (
                  <div className="rounded-lg px-3 py-2.5 font-mono text-[9px] leading-relaxed text-amber-500/80"
                    style={{ border: "1px solid #F59E0B30", background: "#F59E0B08" }}>
                    Nothing was found in the part that could be read, but part of this wallet was
                    not read at all. Incomplete, not empty.
                  </div>
                ) : (
                  // The one branch that ASSERTS something about the user, and
                  // it is now reached only from a complete read that found
                  // nothing — `resolveRead`'s `canAssertEmpty`.
                  <div className="font-mono text-[10px] text-slate-600">No assets yet</div>
                )}
              </div>

          </div>

          {/* ── Section 3: the long tail, behind tabs ───────────────────────
              Three full-width sections used to stack here — the token table,
              the stock table, and the transaction list — each of which paginates
              or scrolls internally. Below three cards and a link, that put the
              transaction history somewhere between two and five screens down,
              and nothing above it told you it was there.

              Tabs, not an accordion or a "show more": these are three answers to
              three different questions ("what do I hold", "what did I do"), only
              one of which is being asked at a time, and a tab bar is the only
              form that states the other options exist while showing one.

              Stocks sit WITH tokens rather than in a tab of their own. They are
              the same question — what this wallet holds — asked of a second
              venue, and StockTable already reads both chains itself. */}
          <div className="flex items-center gap-1 mb-3 border-b border-[#1A1A2E]">
            {VIEWS.map(v => (
              <button key={v.id} onClick={() => setView(v.id)}
                className="font-mono text-[11px] px-3 py-2 -mb-px border-b-2 transition-colors"
                style={view === v.id
                  ? { color: "#4FC3F7", borderColor: "#4FC3F7" }
                  : { color: "#64748b", borderColor: "transparent" }}>
                {v.label}
              </button>
            ))}
          </div>

          {view === "portfolio" && (
            <>
              <TokenTable address={acct} onQuickSell={quickSell} />
              {/* Mainnet-only by construction: B20 stocks exist on Base 8453 and
                  the RWA registry on RH 4663, and neither has a testnet twin. On
                  a testnet dashboard this would show mainnet positions under a
                  banner saying "no real value", so it is absent instead — the
                  same refusal the Convert panel makes.

                  RH crypto sits between the two tables deliberately: it is the
                  same KIND of thing as the Base tokens above it (spot balances),
                  while the stock table below spans both chains at once. Reading
                  top to bottom you get Base tokens → RH tokens → equities, and
                  every one of the three names its own chain. */}
              {!isTestnet && <RhTokenTable address={acct} />}
              {!isTestnet && <StockTable address={acct} />}
            </>
          )}

          {view === "activity" && (
            <TransactionHistory
              transactions={txData?.transactions ?? []}
              loading={txLoading}
              error={txError}
              needsKey={txData?.needsKey}
              onRetry={() => setTxReload(k => k + 1)}
              explorer={net.explorer}
              address={acct}
            />
          )}

          {view === "orders" && <OrdersPanel />}

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
                    {/* A "BEST SAFE RATE · BASE" leaderboard used to follow these
                        two rows, inside the panel a user opens to LEAVE. */}
                    <PositionRow label="Aave v3" pos={aavePos} onManage={() => setPanel("withdraw")} />
                    <PositionRow label="Morpho · Gauntlet USDC Prime" pos={morphoPos}
                      disabled={!morphoVnet} disabledNote="mainnet only" onManage={() => setPanel("withdraw")} />
                    {/* The button said "Start earning" to anyone with no
                        position — the last remaining control that could open a
                        new deposit. It is now the exit only, and it stays put
                        unless the reads came back and said zero. */}
                    {!noPositions ? (
                      <>
                        <button onClick={() => setPanel("withdraw")}
                          className="w-full font-mono text-[12px] font-bold py-2.5 rounded-xl mt-3"
                          style={{ background: "#4FC3F710", color: "#4FC3F7", border: "1px solid #4FC3F730" }}>
                          ↩︎ Withdraw
                        </button>
                        <p className="font-mono text-[9px] text-slate-600 mt-2 leading-relaxed px-0.5">
                          Pulls USDC back out of Aave or Morpho to your wallet — non-custodial, you sign every transaction.
                        </p>
                      </>
                    ) : (
                      <p className="font-mono text-[9px] text-slate-600 mt-3 leading-relaxed px-0.5">
                        New yield deposits are paused. Existing positions stay withdrawable at any time.
                      </p>
                    )}
                  </div>
                )}
                {/* `withdrawOnly` is what actually closes the entrance. Hiding
                    the buttons above is not enough on its own — the card ships
                    a Supply/Withdraw toggle, so without this prop a user who
                    reached the exit could flip straight back into a deposit. */}
                {/* `earnKey`, not `network` — MoveToYieldCard takes `network` as a
                    loose string and reads anything that isn't "base" as
                    baseSepolia, so handing it a chain with no lending market
                    would silently move the user onto a TESTNET withdraw form.
                    Passing the narrowed key means the card can only ever be given
                    a network it can actually represent. */}
                {panel === "withdraw" && (earnKey
                  ? <MoveToYieldCard result={{ network: earnKey, action: "withdraw" }} account={acct} withdrawOnly />
                  : <p className="font-mono text-[11px] text-slate-500">Earn positions are on Base. Switch to Base to withdraw.</p>
                )}
                {/* Convert is a 0x-API flow that exists on Base mainnet only, and
                    SwapCard force-switches the wallet to mainnet before signing.
                    Rendering it while the dashboard is on testnet would move REAL
                    funds under a page captioned "no real value" — exactly the
                    class of mismatch this PR removes. Refuse instead. */}
                {panel === "convert" && (!isBaseMainnet
                  ? <div className="rounded-lg px-3.5 py-3" style={{ background: "#F59E0B10", border: "1px solid #F59E0B40" }}>
                      <div className="font-mono text-[11px] font-bold" style={{ color: "#F59E0B" }}>Convert is Base mainnet only</div>
                      <div className="font-mono text-[9px] text-slate-400 mt-1 leading-relaxed">
                        Swaps route through the 0x API on Base mainnet and would spend real funds. You are on {net.short} — switch to Base to convert.
                      </div>
                      <button onClick={() => setNetwork("base")}
                        className="font-mono text-[10px] font-bold px-3 py-1.5 rounded-lg mt-2.5 transition-opacity hover:opacity-80"
                        style={{ background: "#F59E0B", color: "#050508" }}>
                        Switch to Base
                      </button>
                    </div>
                  : <SwapCard account={acct} preset={sellPreset} />)}
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
                          ? <>Payment-request QR — a payer scanning it (Wallet <b className="text-slate-300">Scan to pay</b>, or any EIP-681 wallet) gets <b className="text-slate-300">{reqAmount} {reqAsset}</b> prefilled.</>
                          : <>Scan the QR with any wallet, or set an amount above to make a payment request. <b className="text-slate-300">USDC / ETH on {net.label}</b> only.</>}
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
              <span className="font-mono text-[9px] text-slate-600">Wallet mode</span>
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

// `AssetRow` lived here. Its three call sites were the USDC / aUSDC / Morpho
// rows of the Section 2 WALLET card, which this release deleted as a duplicate
// of the Section 1 balance card. Deleted with them rather than left behind: the
// component it duplicated renders those rows inline, so a second row primitive
// is an invitation to grow the duplicate back.
//
// `AssetPill`, `AISuggestion` and `StatMini` below/above are ALSO unreferenced,
// but they were already dead before this branch (0 call sites at its base
// commit), so removing them belongs to its own change, not to a wallet rebuild.

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
// A local `Spark` SVG line-chart component lived here. Its ONE call site was
// the Morpho APY sparkline in the sidebar, so it goes with it. (BaseTokensCard
// has its own `Spark` — different file, different component, still in use.)

// `apy` was a prop here, appended to the balance as " · ~4.12%". Dropped with
// the rest of the rate surface: it came from the Aave reserve read for one row
// and from DefiLlama's top pool for the other, so two rows in the same list
// quoted rates measured two different ways and only one of them was this user's.
function PositionRow({ label, pos, onManage, disabled, disabledNote }: {
  label: string; pos: number | null; onManage: () => void; disabled?: boolean; disabledNote?: string;
}) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-[#13131f] last:border-0">
      <div>
        <div className="font-mono text-[12px] text-slate-200">{label}</div>
        <div className="font-mono text-[10px] text-slate-600">
          {disabled ? <span className="text-slate-700">{disabledNote}</span>
            : pos != null ? `${pos.toFixed(2)} USDC` : "—"}
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
function BankLanding() {
  // The lead bullet MIRRORS the panel's primary control so the two can never
  // disagree. With Privy on, the way in is "sign in, we make the wallet" — and
  // the method name is read from the same config the button reads, not typed
  // out here. With Privy off (local dev, no NEXT_PUBLIC_PRIVY_APP_ID) the only
  // way in is your own wallet, so the copy says that instead of advertising an
  // onboarding path the panel does not render.
  //
  // What used to sit here — "Sign in with Face ID … Coinbase Smart Wallet" —
  // described the CTA removed from `ConnectButton` below; see the comment there
  // for why that promise stopped being true.
  const signIn = PRIVY_ENABLED
    ? { icon: "✉️", title: `Sign in with ${describeLoginMethods()} — no seed phrase`, body: "No extension, no app, no 12-word phrase. Signing in creates a wallet that is yours — we never hold the keys." }
    : { icon: "🔌", title: "Bring your own wallet", body: "MetaMask, Coinbase Wallet, Rabby, Phantom, or any WalletConnect wallet. Connect in one tap." };
  // The second bullet used to promise "Earn ~X% APY on idle USDC". It is the
  // first thing an unconnected visitor reads, and it sold the one feature this
  // phase withdraws — so it advertised a door that is now closed. Replaced with
  // the agent spend console, which is the thing about this product no other
  // wallet can show.
  //
  // The console itself now lives on /app/usage, so the bullet says where. A
  // landing bullet describing a panel that is no longer on the page it lands
  // you on is the same defect as the APY promise it replaced: copy that outlived
  // the thing it described.
  const features: { icon: string; title: string; body: string }[] = [
    signIn,
    { icon: "📊", title: "See every payment your agent made", body: "Each x402 tool call your agent paid for, itemised in USDC on your Usage page — the ledger a generic wallet cannot reconstruct." },
    { icon: "➡", title: "Send to any wallet or name.base", body: "Pay anyone on Base by address or Basename. Instant, 24/7, no cut-off times." },
    { icon: "🔒", title: "Non-custodial — you hold the keys", body: "You sign every transaction from your own wallet. BlueAgent never holds your keys or funds." },
    { icon: "🌐", title: "On-chain, withdraw anytime", body: "Your money lives on Base, not in a silo. Pull it out whenever you want, in one click." },
  ];
  return (
    <div className="min-h-full bg-[#050508] flex items-center justify-center p-5 sm:p-8">
      <div className="w-full max-w-4xl grid md:grid-cols-2 gap-6 items-center">
        <div>
          {/* A headline and a paragraph used to sit between this label and the
              bullets: "A wallet you actually own." over "Hold USDC, move money,
              and track every agent payment on Base — non-custodial. You hold the
              keys; BlueAgent only prepares the transaction, you sign it."

              Every clause of it is repeated verbatim below. "Hold USDC, move
              money" is bullet 3, "track every agent payment" is bullet 2,
              "non-custodial / you hold the keys" is bullet 4 — which states it
              twice more in its own title and body. Five claims, three of them
              said twice within 200px, and the paragraph was the copy a reader
              hits first, so the bullets under it read as a restatement rather
              than as the detail.

              The label is the heading now rather than a decorative eyebrow over
              one: dropping the <h1> without promoting something would leave the
              page with no heading at all. */}
          <h1 className="font-mono text-[13px] tracking-widest text-[#4FC3F7] font-bold mb-4">🔵 WALLET</h1>
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
          {/* Describes the control DIRECTLY BELOW IT, which is why it tracks
              PRIVY_ENABLED: with Privy off there is no "we create your wallet"
              path on this panel, only the wallet list. The old line promised
              Face ID and a passkey — the CTA that delivered that is gone. */}
          <p className="font-mono text-[11px] text-slate-500 mb-5">
            {PRIVY_ENABLED
              ? "Sign in and we create your wallet — no seed phrase, no app to install."
              : "Connect a wallet you already own — no signup, no KYC, no custody."}
          </p>
          <ConnectButton />
          <div className="flex items-center gap-2 my-4">
            <div className="h-px flex-1 bg-[#1A1A2E]" /><span className="font-mono text-[9px] text-slate-700">SECURED BY YOU</span><div className="h-px flex-1 bg-[#1A1A2E]" />
          </div>
          <div className="flex items-center justify-center gap-4 font-mono text-[9px] text-slate-600">
            <span>🔒 Non-custodial</span><span>·</span><span>⛓ On Base</span><span>·</span><span>🔑 You sign everything</span>
          </div>
          {/* Named Aave v3 and Morpho, which this surface no longer sends money
              to — the only thing left pointing at them is the withdraw path,
              and an unconnected visitor has no position to withdraw. Naming a
              lender under the signup button reads as "your deposit goes here".
              "Withdraw anytime" left the row above for the same reason: it
              answers a question about a deposit you can no longer make. */}
          <p className="font-mono text-[9px] text-slate-700 text-center mt-4">Powered by Base · USDC</p>
        </div>
      </div>
    </div>
  );
}

// Connect-wallet CTA — two controls, nothing else: sign in (we make the wallet)
// vs bring your own. Same split Halo ships.
//
// ⚠️ THE "🔵 Create a free wallet" CTA THAT USED TO HEAD THIS PANEL IS GONE, and
// it should not come back in that form. It called `coinbase.select()`, where
// `coinbase` is just `wallets.find(name includes "coinbase")` — byte-for-byte
// the same call as the "Coinbase Wallet" row inside the dropdown below. One
// button, listed twice.
//
// It also stopped telling the truth. Before Privy, `coinbase` resolved to the
// wagmi `coinbaseWallet({ preference: { options: "all" } })` connector, which
// really does surface Smart Wallet creation — so "Face ID · no seed phrase" was
// accurate. Routing external wallets through Privy changed what that entry
// resolves to WITHOUT changing the copy, leaving a button that promised a
// passkey and opened Coinbase's generic connect flow. The genuine passkey
// product is `base_account`, which is its own row in the list and is labelled
// as such there.
//
// The seedless pitch now lives on the Privy control, which actually delivers it
// (sign in → embedded wallet, no seed phrase), and whose label is derived from
// the configured login methods so it cannot drift the same way.
function ConnectButton() {
  const { wallets, isPending } = useWallet();
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      {/* Sign in → embedded wallet. Guarded by PRIVY_ENABLED so PrivyLoginButton
          never mounts outside its provider; with the var unset this panel falls
          back to the wallet list alone (dev-only — prod has Privy on). */}
      {PRIVY_ENABLED && (
        <>
          <PrivyLoginButton variant="primary" />
          {/* No sub-caption here on purpose: the panel line right above the
              button already carries "no seed phrase, no app to install", and a
              second copy of the same promise two rows apart reads as clutter.
              One claim, one place — it also means there is only one string to
              keep honest if the sign-in path changes again. */}
          <div className="flex items-center gap-2 mt-3">
            <div className="h-px flex-1 bg-[#1A1A2E]" />
            <span className="font-mono text-[9px] text-slate-600 uppercase tracking-widest">or</span>
            <div className="h-px flex-1 bg-[#1A1A2E]" />
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
              <button key={w.key} onClick={() => { w.select(); setOpen(false); }}
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
