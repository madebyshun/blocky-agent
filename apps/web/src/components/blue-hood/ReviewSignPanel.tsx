"use client";

/**
 * Blue Hood — Review & Sign panel (T-E, the Action layer).
 *
 * Opens over an arrow card. Fetches a live quote, lets the user pick
 * amount + slippage, then walks the user through the sign flow via
 * their connected wallet on Robinhood Chain (4663).
 *
 * NON-NEGOTIABLE RULES — enforced in this file:
 *   1. NON-CUSTODIAL — every signature comes from `useSendTransaction`
 *      on the user's connected wallet. Server never gets a private key.
 *   2. `recipient` = `useAccount().address` VERBATIM. There is NO
 *      env fallback, NO default, NO hardcode. `recipient` variable
 *      is set exactly ONCE, right here, from `address`. Grep for
 *      the string "RECIPIENT SET" to audit.
 *   3. NO auto-execute. Every tx requires a distinct user click on
 *      an explicit button. The panel autoquotes on open, but that's
 *      a READ operation — no wallet interaction happens until the
 *      user clicks "Sign approve" / "Sign swap".
 *   4. Warnings shown VERBATIM. `warnings.map(...)` — no filtering.
 *   5. Better to block than mis-sign. Every doubt → sign button
 *      disabled with a specific reason.
 *
 * Multi-hop scope (v1): the X2 endpoint can return a 4-call
 * multi-hop sequence when no direct pool exists at the picked denom.
 * v1 supports DIRECT route only (2 signs). If multi-hop comes back,
 * we show a clear message pointing the user at the other denom.
 * Multi-hop with balance-recalc between legs lands in v2.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAccount, useSwitchChain, useSendTransaction, useReadContract, usePublicClient, useBalance } from "wagmi";
import { erc20Abi, formatUnits, parseUnits } from "viem";
import Link from "next/link";
import type { Arrow, UserAction } from "@/lib/blue-hood/types";
import { ConnectButton } from "@/components/ConnectModal";
import { ROBINHOOD_SWAP_ROUTER_ADDRESS } from "@/lib/robinhood/swap";

const RH_CHAIN_ID = 4663;
const RH_EXPLORER = "https://robinhoodchain.blockscout.com";
const HEAVY_IMPACT_PCT = 3;      // amber warning + require ack above this
const MIN_TVL_USD = 5_000;       // dust floor — same as engine
const QUOTE_STALE_MS = 60_000;   // 60s from last quote fetch

const RH_GREEN = "#34D399";
const AMBER = "#f5b342";
const RED = "#ef4444";
const MUTED = "#6b7280";
const BORDER = "#1A1A2E";
const SURFACE = "#0B0D13";

// ── Types shared with the API ─────────────────────────────────────────

interface QuoteResponse {
  ticker: string;
  side: "buy" | "sell";
  denom_in: "USDG" | "WETH";
  amount_in: number;
  amount_in_base_units: string;
  spot_usd: number | null;
  spot_source: "pool" | "chainlink" | null;
  pool_spot_usd: number | null;
  chainlink_spot_usd: number | null;
  pool_oracle_delta_pct: number | null;
  pool_deviates_from_oracle: boolean;
  expected_out: number | null;
  expected_after_impact: number | null;
  min_out: number | null;
  slippage_bps: number;
  trade_impact_pct: number;
  one_side_usd_used: number;
  warnings: string[];
  route: {
    kind: "direct" | "multi-hop" | null;
    /** Honest V3 executability. If false, the on-chain V3 factory has
     *  no pool for this pair — GT may show a V4 pool but our router
     *  can't touch it. Panel must disable Sign when this is false. */
    executable?: boolean;
    unavailable_reason?: string | null;
    note: string;
    direct_pool_gt: { address: string; tvl_usd: number } | null;
    direct_pool_on_chain_weth: { address: string } | null;
  };
  execution: {
    token_in: string;
    token_out: string;
    token_in_decimals: number;
    token_out_decimals: number;
    router: string;
    factory: string;
    deadline_unix: number;
  };
  timestamp: string;
}

interface PrepareResponse {
  ticker: string;
  side: "buy" | "sell";
  denom_in: "USDG" | "WETH";
  recipient: string;
  quote: QuoteResponse["route"] & Partial<QuoteResponse> & { min_out?: number | null; amount_in_base_units?: string; amount_out_minimum_base_units?: string };
  warnings: string[];
  route: { kind: "direct" | "multi-hop"; call_count: number };
  calls: Array<{
    kind: "approve" | "swap";
    to: string;
    data: string;
    value: string;
    leg?: number | null;
  }>;
  deadline_unix: number;
  notes: string[];
  network: string;
  timestamp: string;
}

// ── Component ─────────────────────────────────────────────────────────

export interface ReviewSignPanelProps {
  arrow: Arrow;
  /** Called when the panel closes (X button, backdrop click, done). */
  onClose: () => void;
  /** Called after a swap tx has been broadcast (before receipt). Lets
   *  the caller optimistically update its local arrow copy. Optional. */
  onActionPending?: (action: UserAction) => void;
}

type Phase =
  | { kind: "quoting" }
  | { kind: "quote_error"; msg: string }
  | { kind: "ready" }
  | { kind: "preparing" }
  | { kind: "prepare_error"; msg: string }
  | { kind: "review" }
  | { kind: "signing"; step: number; total: number; label: string }
  // P0 allowance-race (2026-07-24): sign_error can now carry a live
  // approve_hash so the panel can offer a one-click revoke button
  // (approve(spender, 0)) when the swap sign failed AFTER approve
  // confirmed — the 7-dangling-approvals scenario from ví test 23/7.
  | { kind: "sign_error"; msg: string; approve_hash?: string | null; spender?: string | null; token?: string | null }
  | { kind: "revoking" }
  | { kind: "done"; swap_hash: string; approve_hash: string | null };

export default function ReviewSignPanel({ arrow, onClose, onActionPending }: ReviewSignPanelProps) {
  const { address, isConnected, chain } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { sendTransactionAsync } = useSendTransaction();
  const pubClient = usePublicClient({ chainId: RH_CHAIN_ID });

  // Derive `side` from the arrow's expected direction. LONG_DEX / drift-up /
  // arb-long-dex all mean "buy the token". SHORT_DEX / drift-down / arb-
  // short-dex all mean "sell". Arrows with `expected_direction === null`
  // (whale-informational) are read-only — we surface this state below.
  const defaultSide: "buy" | "sell" = arrow.expected_direction === "down" ? "sell" : "buy";

  const [amount, setAmount] = useState<string>("100");
  const [side, setSide] = useState<"buy" | "sell">(defaultSide);
  const [denom, setDenom] = useState<"USDG" | "WETH">("USDG");
  const [slippageBps, setSlippageBps] = useState<number>(100);
  const [ackImpact, setAckImpact] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "quoting" });
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [prepare, setPrepare] = useState<PrepareResponse | null>(null);
  const [quoteFetchedAt, setQuoteFetchedAt] = useState<number>(0);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // P0 allowance-race: signFlow stores the LAST completed approve here
  // so the outer sign_error catch can offer a Revoke button when the
  // swap sign fails after approve confirmed. Cleared at every fresh
  // signFlow entry; the ref survives the throw so the outer catch sees it.
  const lastApproveRef = useRef<{ hash: string; spender: string; token: string } | null>(null);

  // ── Wallet balance (of the token the user pays with) ────────────────
  // Bug fix #2 (2026-07-24, arrow #0071 NVDA sell): the previous guard
  // was `side === "buy"`, so on SELL the balance query never fired and
  // `walletBalance` stayed null → the insufficient-balance gate below
  // was a no-op. Result: user typed 1 NVDA while holding 0.0095, panel
  // let them sign approve for 1, swap reverted, dangling approval.
  // `quote.execution.token_in` IS the pay-side token regardless of side
  // (USDG on buy, the RWA token on sell) — drop the side filter.
  const payToken: `0x${string}` | undefined =
    quote?.execution?.token_in
      ? (quote.execution.token_in as `0x${string}`)
      : undefined;
  const payDecimals = quote?.execution?.token_in_decimals ?? 6;
  const { data: rawBalance } = useReadContract({
    address: payToken,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: RH_CHAIN_ID,
    query: { enabled: !!payToken && !!address, refetchInterval: 15_000 },
  });
  const walletBalance = useMemo(() => {
    if (typeof rawBalance !== "bigint") return null;
    return parseFloat(formatUnits(rawBalance, payDecimals));
  }, [rawBalance, payDecimals]);
  // Symbol shown next to the amount input + balance line. On BUY it's
  // the denom (USDG / WETH). On SELL it's the ticker being sold.
  const payUnitSymbol = side === "sell" ? arrow.ticker : denom;

  // ── Live allowance readout (2026-07-25, "diagnose reverts" PR) ─────
  // Prior UI showed nothing about allowance state until the sign flow
  // ran, so a user with a stale/mismatched allowance thought the
  // panel was broken. Read it live and render the resolution above
  // the sign button: "will skip approve · existing allowance covers"
  // vs "will request approve for X". Same read as signFlow — kept
  // in sync so what the panel says is what will happen.
  // Router address is a constant on RH Chain — read it up front so the
  // allowance state is visible BEFORE the user clicks Sign (previously
  // we only knew the spender after prepare returned, so the "will skip
  // approve" hint fired too late).
  const swapRouter = (ROBINHOOD_SWAP_ROUTER_ADDRESS ?? undefined) as `0x${string}` | undefined;
  const { data: rawAllowance } = useReadContract({
    address: payToken,
    abi: erc20Abi,
    functionName: "allowance",
    args: address && swapRouter ? [address, swapRouter] : undefined,
    chainId: RH_CHAIN_ID,
    query: { enabled: !!payToken && !!address && !!swapRouter, refetchInterval: 15_000 },
  });
  const currentAllowance = useMemo(() => {
    if (typeof rawAllowance !== "bigint") return null;
    return parseFloat(formatUnits(rawAllowance, payDecimals));
  }, [rawAllowance, payDecimals]);
  // `willSkipApprove` uses amountNum which is defined further down; the
  // definition happens after this block. See its computation near the
  // sign-flow guards where amountNum lives.

  // Native ETH on Robinhood Chain — gas token. The raw viem/MetaMask
  // "insufficient funds for gas" dump is unreadable (screenshot 3+4),
  // and users have no visible signal that they might be under-funded
  // on gas. Show it inline so the panel is honest about pre-conditions.
  const { data: rhEthBalance } = useBalance({
    address,
    chainId: RH_CHAIN_ID,
    query: { enabled: !!address, refetchInterval: 15_000 },
  });

  // ── Quote fetcher (debounced on input change) ───────────────────────
  const fetchQuote = useCallback(async () => {
    setPhase({ kind: "quoting" });
    try {
      const res = await fetch("/api/hood/trade/quote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ticker: arrow.ticker, side, amount: Number(amount), denom, slippage_bps: slippageBps }),
      });
      const body = await res.json() as QuoteResponse | { error: string; detail?: string };
      if (!res.ok || "error" in body) {
        const detail = ("detail" in body ? body.detail : undefined) ?? ("error" in body ? body.error : "quote_failed");
        setPhase({ kind: "quote_error", msg: String(detail) });
        return;
      }
      setQuote(body);
      setQuoteFetchedAt(Date.now());
      setPhase({ kind: "ready" });
    } catch (e) {
      setPhase({ kind: "quote_error", msg: (e as Error).message });
    }
  }, [arrow.ticker, side, amount, denom, slippageBps]);

  // Initial + on-input debounce (500ms per spec)
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => { void fetchQuote(); }, 500);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [fetchQuote]);

  // ── Derived flags for the smart action button ───────────────────────
  const arrowIsOpen = arrow.status === "open";
  const arrowClosedDetail = !arrowIsOpen
    ? `this signal closed ${arrow.graded_at ? formatRelTime(arrow.graded_at) : "already"} — read-only`
    : null;
  const wrongChain = isConnected && chain?.id !== RH_CHAIN_ID;
  const marketClosedDrift = arrow.type === "drift" && arrow.market_at_fire && !arrow.market_at_fire.is_open;
  const quoteStale = !!quote && (Date.now() - quoteFetchedAt) > QUOTE_STALE_MS;
  const deadlineExpired = !!quote?.execution && quote.execution.deadline_unix * 1000 < Date.now();
  const poolTvl = quote?.route?.direct_pool_gt?.tvl_usd ?? quote?.one_side_usd_used ? (quote?.one_side_usd_used ?? 0) * 2 : 0;
  const poolTooThin = quote !== null && poolTvl > 0 && poolTvl < MIN_TVL_USD;
  const heavyImpact = (quote?.trade_impact_pct ?? 0) > HEAVY_IMPACT_PCT;
  const amountNum = Number(amount);
  const validAmount = Number.isFinite(amountNum) && amountNum > 0;
  // Bug fix #2 (2026-07-24, arrow #0071): the insufficient guard was
  // scoped to `side === "buy"`, so on SELL it never fired even when the
  // wallet balance was clearly less than the requested amount. Widened
  // to both sides — walletBalance is now populated on both.
  const insufficient = walletBalance !== null && validAmount && amountNum > walletBalance;
  // Allowance plan resolves here now that both `currentAllowance` and
  // `amountNum` are in scope. `willSkipApprove` drives the pre-flight
  // banner + the "sign 1 tx / sign 2 txs" hint. Ties directly to what
  // signFlow does — if this says "skip", signFlow will skip.
  const willSkipApprove = currentAllowance !== null && currentAllowance >= amountNum && amountNum > 0;
  const multiHop = quote?.route?.kind === "multi-hop";

  // Reset the impact ack when the impact-blocked state clears.
  useEffect(() => { if (!heavyImpact) setAckImpact(false); }, [heavyImpact]);

  // The smart action button state — computes what click does + why.
  const action = pickAction({
    phase, isConnected, wrongChain, arrowIsOpen, validAmount, insufficient,
    poolTooThin, heavyImpact, ackImpact, quoteStale, deadlineExpired, multiHop,
    quote, hasAddress: !!address,
  });

  // ── Sign flow ────────────────────────────────────────────────────────
  const signFlow = useCallback(async (prep: PrepareResponse) => {
    // RECIPIENT SET — the ONLY assignment of recipient in the file. Comes
    // from wagmi's `useAccount().address`. If we ever accept a recipient
    // from anywhere else, this comment MUST be updated so the grep audit
    // still catches it.
    if (!address) throw new Error("wallet not connected");
    if (prep.recipient.toLowerCase() !== address.toLowerCase()) {
      throw new Error(`recipient mismatch: prepare returned ${prep.recipient} but wallet is ${address}`);
    }
    // Direct route only in v1 (spec E3): approve → swap.
    if (prep.route.kind !== "direct" || prep.calls.length !== 2) {
      throw new Error(`unsupported_route: expected direct 2-call, got ${prep.route.kind} ${prep.calls.length}-call. Try the other denom.`);
    }
    // Bug fix #4 audit (2026-07-24, arrow #0071 post-mortem): the pre-flight
    // eth_call sim from #227 should have caught the NVDA sell revert
    // (transferFrom would fail because balance < amount) but the swap sign
    // was requested anyway. Root cause unclear — possibly viem `call`
    // returning "success" on this specific router path, possibly RPC
    // caching. Rather than trust the sim as the only guard, add a hard
    // client-side balance assert before ANY signature. `walletBalance`
    // is now read for both sides (bug #2 fix above), so this covers SELL
    // regardless of the sim's behavior. Uses the LOOSE 0.999999 factor
    // because rounding of `walletBalance` from formatUnits can be off in
    // the last decimal; treat "sell 100%" as valid even if it's 0.9999999x.
    if (walletBalance !== null && amountNum > walletBalance * 1.0000001) {
      throw new Error(
        `insufficient_balance: requested ${amountNum} but balance is ${walletBalance}. ` +
        `Use the 100% preset to sell everything or lower the amount.`,
      );
    }
    // ── Pre-sign ETH gas budget (2026-07-25 fix for "every BUY reverted"
    //    diagnostic split). Rough sizing: approve = ~50k gas, swap = ~200k
    //    gas with our 30% buffer from #226 → worst-case ~250k gas total.
    //    At even 1 gwei on RH that's <$0.001, but wallets refuse a tx if
    //    the ETH balance can't cover `gas × gasPrice + value`. Say so
    //    plainly instead of letting the wallet return a cryptic error.
    //    Threshold 0.0005 ETH is generous — the first real swap used
    //    166k gas at effectively ~0 fee, so anyone with < 0.0005 ETH is
    //    going to hit trouble no matter the price.
    if (rhEthBalance !== undefined && rhEthBalance !== null) {
      const eth = Number(rhEthBalance.value) / 10 ** rhEthBalance.decimals;
      if (eth < 0.0005) {
        throw new Error(
          `insufficient_gas_eth: have ${eth.toFixed(6)} ETH on RH Chain, ` +
          `need at least 0.0005 ETH to cover approve + swap gas`,
        );
      }
    }
    const [approveCall, swapCall] = prep.calls;

    // ── P0 allowance-race fix (2026-07-24) ────────────────────────────
    // SLV #0073 evidence: MetaMask showed "This transaction is likely to
    // fail" + "Network fee: Unavailable" on the SWAP sign. Root cause:
    // we asked for the swap sign before the approve tx confirmed
    // on-chain → allowance still 0 → simulation revert. The wallet was
    // right; the user cancelled BECAUSE the wallet warned.
    //
    // Fix pipeline:
    //   (a) Decode approve amount + spender from calldata.
    //   (b) Read current allowance. If ≥ approve amount → skip approve.
    //   (c) Otherwise sign approve, then waitForTransactionReceipt AND
    //       verify receipt.status === "success". Re-read allowance to
    //       confirm state propagated.
    //   (d) BEFORE the swap sign, eth_call the swap. If it reverts,
    //       throw with the reason. Never ask the wallet for a
    //       likely-to-fail sign.
    //   (e) sign_error after a completed approve carries approve_hash +
    //       spender + token so the user can one-click Revoke.
    const tokenIn = approveCall.to as `0x${string}`;
    const router  = swapCall.to    as `0x${string}`;

    // Decode approve(spender, amount) — selector(4) + spender(32) + amount(32).
    const approveData = approveCall.data as `0x${string}`;
    let approveAmount = 0n;
    let approveSpender: `0x${string}` = router;
    try {
      if (approveData.length >= 2 + 8 + 64 + 64) {
        approveSpender = ("0x" + approveData.slice(2 + 8 + 24, 2 + 8 + 64)) as `0x${string}`;
        approveAmount  = BigInt("0x" + approveData.slice(2 + 8 + 64));
      }
    } catch {
      // Fall through with defaults — approveAmount=0 will force the
      // "no allowance to compare" branch, which is safe.
    }

    const ERC20_ALLOWANCE_ABI = [{
      name: "allowance", type: "function", stateMutability: "view",
      inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }],
      outputs: [{ name: "", type: "uint256" }],
    }] as const;

    let approveHash: `0x${string}` | null = null;
    lastApproveRef.current = null; // reset before each attempt

    if (pubClient) {
      let currentAllowance = 0n;
      try {
        currentAllowance = await pubClient.readContract({
          address: tokenIn, abi: ERC20_ALLOWANCE_ABI,
          functionName: "allowance",
          args: [address as `0x${string}`, approveSpender],
        }) as bigint;
      } catch (e) {
        console.warn(`[trade] allowance read failed: ${(e as Error).message} — proceeding with approve`);
      }
      console.log(`[trade] pre-flight allowance=${currentAllowance} required=${approveAmount} arrow=${arrow.serial} ticker=${arrow.ticker}`);

      if (approveAmount > 0n && currentAllowance < approveAmount) {
        // Sign approve — user's ONLY approve for this swap
        setPhase({ kind: "signing", step: 1, total: 2, label: "Sign approve in wallet…" });
        const signedApproveHash = await sendTransactionAsync({
          to: approveCall.to as `0x${string}`,
          data: approveCall.data as `0x${string}`,
          value: BigInt(approveCall.value || "0x0"),
          chainId: RH_CHAIN_ID,
        });
        approveHash = signedApproveHash;

        // Explicit intermediate phase so the panel shows progress while
        // we wait for RH Chain to include the approve tx.
        setPhase({ kind: "signing", step: 1, total: 2, label: "Approve confirming on-chain…" });
        const approveReceipt = await pubClient.waitForTransactionReceipt({
          hash: signedApproveHash, confirmations: 1, timeout: 90_000,
        });
        if (approveReceipt.status !== "success") {
          throw new Error(`approve_reverted: on-chain status=${approveReceipt.status}. Swap aborted — no allowance was granted.`);
        }

        // Re-read allowance to confirm the state propagated. RH RPC
        // occasionally serves the pre-tx state on the read-your-writes
        // path; a brief retry loop covers that.
        let confirmed = 0n;
        for (let i = 0; i < 3; i++) {
          try {
            confirmed = await pubClient.readContract({
              address: tokenIn, abi: ERC20_ALLOWANCE_ABI,
              functionName: "allowance",
              args: [address as `0x${string}`, approveSpender],
            }) as bigint;
            if (confirmed >= approveAmount) break;
          } catch (e) {
            console.warn(`[trade] post-approve allowance re-read ${i} failed: ${(e as Error).message}`);
          }
          await new Promise((r) => setTimeout(r, 400));
        }
        console.log(`[trade] post-approve allowance=${confirmed} required=${approveAmount} ok=${confirmed >= approveAmount}`);
        if (confirmed < approveAmount) {
          throw new Error(`approve_state_not_propagated: allowance=${confirmed} < required=${approveAmount} after 3 re-reads. Wait a block and retry.`);
        }
        // Approve succeeded — arm the revoke context so a downstream
        // failure (swap sim revert, user cancel on swap sign, …) can
        // offer a one-click revoke instead of leaving the allowance
        // hanging like the 7-cap scenario from ví test 23/7.
        lastApproveRef.current = { hash: signedApproveHash, spender: approveSpender, token: tokenIn };
      } else if (approveAmount > 0n) {
        console.log(`[trade] approve skipped — existing allowance sufficient arrow=${arrow.serial} ticker=${arrow.ticker}`);
      }

      // (d) Pre-flight the swap via eth_call. If it reverts, DON'T ask
      // the wallet — we already burned an approve, no point burning a
      // guaranteed-fail swap sign on top.
      try {
        await pubClient.call({
          account: address as `0x${string}`,
          to: swapCall.to as `0x${string}`,
          data: swapCall.data as `0x${string}`,
          value: BigInt(swapCall.value || "0x0"),
        });
        console.log(`[trade] swap pre-flight sim OK arrow=${arrow.serial}`);
      } catch (simErr) {
        const raw = (simErr as Error).message;
        const m = /reverted with the following reason:\s*([^\n]+)/i.exec(raw)
              ?? /reverted with reason string\s*['"]([^'"]+)['"]/i.exec(raw)
              ?? /execution reverted:\s*([^\n]+)/i.exec(raw);
        const reason = (m?.[1] ?? raw).slice(0, 240).trim();
        throw new Error(`swap_would_revert: ${reason}`);
      }
    }

    // P0.2 (2026-07-24): estimate gas + 30% buffer. First real swap ate
    // 93.73% of the wallet-default limit (166,068 / 177,174) — V3 concentrated-
    // liquidity swaps traversing multiple ticks can spike well past a naive
    // estimate. Fee on RH is ~$0.03 so overshooting costs nothing (unused gas
    // refunded). Log gas_est / limit_set / used so we can tune buffer over time.
    // Multi-pool (route.kind !== "direct") would use 1.5×, but v1 is direct-only.
    let gasLimit: bigint | undefined;
    let gasEst: bigint | undefined;
    if (pubClient) {
      try {
        gasEst = await pubClient.estimateGas({
          account: address as `0x${string}`,
          to: swapCall.to as `0x${string}`,
          data: swapCall.data as `0x${string}`,
          value: BigInt(swapCall.value || "0x0"),
        });
        gasLimit = (gasEst * 130n) / 100n;
        console.log(`[trade] gas_est=${gasEst} limit_set=${gasLimit} buffer=1.30x arrow=${arrow.serial} ticker=${arrow.ticker}`);
      } catch (e) {
        console.warn(`[trade] gas estimate failed — falling back to wallet default: ${(e as Error).message}`);
      }
    }

    // Sign #2 — swap
    setPhase({ kind: "signing", step: 2, total: 2, label: "Sign swap in wallet…" });
    const swapHash = await sendTransactionAsync({
      to: swapCall.to as `0x${string}`,
      data: swapCall.data as `0x${string}`,
      value: BigInt(swapCall.value || "0x0"),
      chainId: RH_CHAIN_ID,
      ...(gasLimit !== undefined ? { gas: gasLimit } : {}),
    });

    // P0.1 (2026-07-24): status flow reworked. Post `broadcast` — NOT
    // `pending` — so the record cannot silently upgrade to success by
    // omission. `success` is only written when a receipt with status
    // === "success" is observed; timeout / receipt fetch crash lands
    // as `broadcast` (still visible on Blockscout) and never rots into
    // a fake success. Prior code allowed structural revert-rate = 0.
    const broadcastAction: UserAction = {
      ts: new Date().toISOString(),
      wallet: address.toLowerCase(),
      tx_hash: swapHash.toLowerCase(),
      side, amount: amountNum, denom,
      min_out: quote?.min_out ?? null,
      status: "broadcast",
    };
    onActionPending?.(broadcastAction);
    void postUserAction(arrow.id, broadcastAction);

    // Wait for receipt, then post the terminal status.
    if (pubClient) {
      try {
        const receipt = await pubClient.waitForTransactionReceipt({
          hash: swapHash, confirmations: 1, timeout: 60_000,
        });
        const isSuccess = receipt.status === "success";
        const status: UserAction["status"] = isSuccess ? "success" : "reverted";
        let revertReason: string | null = null;
        if (!isSuccess) {
          // Try to fish a Uniswap-style short reason ("STF", "TOO_LITTLE_RECEIVED")
          // out of the tx. viem exposes the revert selector via a failed
          // simulate; wrap tightly so we never trade the terminal status.
          try {
            await pubClient.simulateContract({
              account: address as `0x${string}`,
              address: swapCall.to as `0x${string}`,
              abi: [{ type: "function", name: "multicall", inputs: [{ name: "data", type: "bytes[]" }], outputs: [], stateMutability: "payable" }] as const,
              functionName: "multicall",
              args: [[swapCall.data as `0x${string}`]],
              blockNumber: receipt.blockNumber,
            });
          } catch (simErr) {
            const raw = (simErr as Error).message;
            const m = /reverted with the following reason:\s*([^\n]+)/i.exec(raw);
            revertReason = (m?.[1] ?? raw).slice(0, 160).trim();
          }
        }
        console.log(`[trade] arrow=${arrow.serial} tx=${swapHash.slice(0, 10)}… status=${status} block=${receipt.blockNumber} gas_used=${receipt.gasUsed}${gasLimit !== undefined ? ` limit_set=${gasLimit}` : ""}${revertReason ? ` reason="${revertReason}"` : ""}`);
        void postUserAction(arrow.id, {
          ...broadcastAction,
          status,
          revert_reason: revertReason,
          block_number: Number(receipt.blockNumber),
        });
      } catch (e) {
        // Timeout / RPC error — DO NOT upgrade to "success". Post
        // `unknown` so the UI is honest ("we couldn't confirm").
        console.warn(`[trade] receipt wait crashed arrow=${arrow.serial} tx=${swapHash.slice(0, 10)}… err="${(e as Error).message}"`);
        void postUserAction(arrow.id, { ...broadcastAction, status: "unknown" });
      }
    }

    setPhase({ kind: "done", swap_hash: swapHash, approve_hash: approveHash });
  }, [address, arrow.id, arrow.serial, arrow.ticker, sendTransactionAsync, pubClient, side, amountNum, denom, quote?.min_out, onActionPending, walletBalance, rhEthBalance]);

  const onSmartClick = useCallback(async () => {
    if (action.kind === "connect") return; // rendered as ConnectButton child
    if (action.kind === "close") { onClose(); return; }
    if (action.kind === "switch") {
      try { await switchChainAsync({ chainId: RH_CHAIN_ID }); }
      catch (e) { console.warn("[review-sign] switch failed:", (e as Error).message); }
      return;
    }
    if (action.kind === "requote") { void fetchQuote(); return; }
    if (action.kind === "sign") {
      // Step 1 — prepare (build calldata with recipient = address)
      setPhase({ kind: "preparing" });
      try {
        if (!address) throw new Error("no_wallet");
        const res = await fetch("/api/hood/trade/prepare", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ticker: arrow.ticker, side, amount: amountNum, denom,
            slippage_bps: slippageBps, deadline_minutes: 5,
            recipient: address, // RECIPIENT SET — see note in signFlow
          }),
        });
        const body = await res.json() as PrepareResponse | { error: string; detail?: string };
        if (!res.ok || "error" in body) {
          const detail = ("detail" in body ? body.detail : undefined) ?? ("error" in body ? body.error : "prepare_failed");
          setPhase({ kind: "prepare_error", msg: String(detail) });
          return;
        }
        setPrepare(body);
        // Step 2 — sign (goes straight in; user already reviewed the
        // quote above. If we want a "review calls" pause step, we can
        // gate this behind a second confirm. For MVP: single confirm
        // above, then straight-through signing.)
        await signFlow(body);
      } catch (e) {
        const msg = (e as Error).message;
        // Enrich sign_error with the last completed approve so the panel
        // can offer a one-click Revoke button — matches P0 (d): after
        // approve succeeded, if anything downstream failed, don't leave
        // the allowance hanging.
        const revoke = lastApproveRef.current;
        setPhase({
          kind: "sign_error",
          msg: humanizeSignError(msg),
          approve_hash: revoke?.hash ?? null,
          spender: revoke?.spender ?? null,
          token: revoke?.token ?? null,
        });
      }
    }
  }, [action.kind, switchChainAsync, fetchQuote, address, arrow.ticker, side, amountNum, denom, slippageBps, signFlow, onClose]);

  // ── Revoke handler (P0 allowance-race, step d) ───────────────────────
  // Sends approve(spender, 0) for the token whose allowance was armed
  // during the failed sign flow. UI is only rendered when phase is
  // sign_error AND lastApproveRef fields are all present.
  const onRevoke = useCallback(async () => {
    if (phase.kind !== "sign_error" || !phase.approve_hash || !phase.spender || !phase.token) return;
    try {
      setPhase({ kind: "revoking" });
      // approve(address,uint256) selector = 0x095ea7b3
      const spenderPadded = phase.spender.slice(2).toLowerCase().padStart(64, "0");
      const zeroPadded    = "".padStart(64, "0");
      const revokeData = `0x095ea7b3${spenderPadded}${zeroPadded}` as `0x${string}`;
      await sendTransactionAsync({
        to: phase.token as `0x${string}`,
        data: revokeData,
        value: 0n,
        chainId: RH_CHAIN_ID,
      });
      // Reset the panel to a clean state so the user can requote if they want.
      lastApproveRef.current = null;
      setPhase({ kind: "ready" });
    } catch (e) {
      setPhase({
        kind: "sign_error",
        msg: `Revoke failed: ${(e as Error).message}`,
        approve_hash: phase.approve_hash,
        spender: phase.spender,
        token: phase.token,
      });
    }
  }, [phase, sendTransactionAsync]);

  // ── Render ────────────────────────────────────────────────────────
  return (
    <div
      role="dialog"
      aria-label="Review & Sign"
      className="fixed inset-0 z-[100] flex items-end justify-center bg-black/70 p-4 md:items-center hood-fade-in"
      onClick={onClose}
      style={{ fontFamily: "'JetBrains Mono', ui-monospace, monospace" }}
    >
      <div
        className="w-full max-w-lg rounded-lg border overflow-hidden hood-modal-in max-h-[90vh] overflow-y-auto hood-scroll"
        style={{ borderColor: BORDER, backgroundColor: SURFACE }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3 border-b" style={{ borderColor: "#0f1218" }}>
          <span className="text-[11px]" style={{ color: RH_GREEN }}>{arrow.serial}</span>
          <span className="text-[14px] font-semibold text-white">{arrow.ticker}</span>
          <span className="text-[10px] uppercase" style={{ color: MUTED, letterSpacing: "0.08em" }}>
            {arrow.type} {arrow.expected_direction === "up" ? "↑" : arrow.expected_direction === "down" ? "↓" : ""}
          </span>
          <button
            onClick={onClose}
            className="ml-auto text-[16px] hover:text-white"
            style={{ color: MUTED }}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Market-closed drift banner — informational, not blocking */}
        {marketClosedDrift && (
          <div
            className="mx-4 mt-3 rounded border px-3 py-2 text-[11px]"
            style={{ borderColor: "#3b2a15", backgroundColor: "#1a1408", color: "#f6c88f" }}
          >
            market closed — DEX may snap toward oracle at open; this is price
            discovery, not arbitrage.
          </div>
        )}

        {/* Read-only lock when arrow closed */}
        {!arrowIsOpen && (
          <div
            className="mx-4 mt-3 rounded border px-3 py-2 text-[11px]"
            style={{ borderColor: RED, backgroundColor: "#160b0b", color: "#f8b6b6" }}
          >
            {arrowClosedDetail}
          </div>
        )}

        {/* Inputs — amount + side + denom + slippage */}
        <div className="px-4 py-3 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-[10px] uppercase" style={{ color: MUTED, letterSpacing: "0.08em" }}>side</label>
            <SideToggle value={side} onChange={setSide} disabled={!arrowIsOpen} />
            <label className="text-[10px] uppercase ml-3" style={{ color: MUTED, letterSpacing: "0.08em" }}>denom</label>
            <DenomToggle value={denom} onChange={setDenom} disabled={!arrowIsOpen} />
          </div>

          <div className="flex items-center gap-2">
            <label className="text-[10px] uppercase" style={{ color: MUTED, letterSpacing: "0.08em" }}>amount</label>
            <input
              type="number"
              inputMode="decimal"
              step="any"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={!arrowIsOpen}
              className="flex-1 rounded border px-2 py-1 text-[13px] bg-black/40 text-white tabular-nums"
              style={{ borderColor: BORDER }}
            />
            {/* Bug fix #1 (2026-07-24, arrow #0071): the unit label was
                hardcoded to `denom`, so SELL 1 NVDA read "1 USDG" — misleading
                enough that a user could type 1 while holding 0.0095 and think
                they were selling ~$0.10 of NVDA. `payUnitSymbol` resolves to
                the actual token being paid (arrow.ticker on SELL, denom on BUY). */}
            <span className="text-[11px]" style={{ color: MUTED }}>{payUnitSymbol}</span>
          </div>

          {/* P2.2 amount presets (2026-07-24). BUY: fixed USDG amounts.
              SELL: percentage of REAL balance, computed live from the
              on-chain read. If the user has zero of the pay token, the
              presets are disabled. Bug #0071 root cause: no SELL balance
              → no percent-based presets → user typed 1 by hand. This
              row makes that path structurally impossible. */}
          {isConnected && arrowIsOpen && (
            <AmountPresetRow
              side={side}
              walletBalance={walletBalance}
              rawBalance={typeof rawBalance === "bigint" ? rawBalance : undefined}
              payDecimals={payDecimals}
              onSet={(v) => setAmount(v)}
              currentAmount={amount}
              payUnitSymbol={payUnitSymbol}
            />
          )}

          <div className="flex items-center gap-2">
            <label className="text-[10px] uppercase" style={{ color: MUTED, letterSpacing: "0.08em" }}>slippage</label>
            {[50, 100, 300].map((b) => (
              <button
                key={b}
                type="button"
                onClick={() => setSlippageBps(b)}
                disabled={!arrowIsOpen}
                className="rounded border px-2 py-0.5 text-[11px]"
                style={{
                  borderColor: slippageBps === b ? RH_GREEN : BORDER,
                  color: slippageBps === b ? RH_GREEN : "#9aa1ac",
                  backgroundColor: slippageBps === b ? "rgba(0,200,5,0.10)" : "transparent",
                }}
              >
                {(b / 100).toFixed(1)}%
              </button>
            ))}
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={5000}
              value={slippageBps}
              onChange={(e) => setSlippageBps(Math.max(1, Math.min(5000, Math.trunc(Number(e.target.value) || 100))))}
              disabled={!arrowIsOpen}
              className="w-20 rounded border px-2 py-0.5 text-[11px] bg-black/40 text-white tabular-nums"
              style={{ borderColor: BORDER }}
            />
            <span className="text-[10px]" style={{ color: MUTED }}>bps</span>
          </div>

          {isConnected && (
            <div className="text-[10px] flex flex-wrap gap-x-4" style={{ color: MUTED }}>
              {walletBalance !== null && (
                <span>
                  balance: <span className="tabular-nums">{formatNum(walletBalance)}</span> {payUnitSymbol}
                  {insufficient && (
                    <span className="ml-2" style={{ color: RED }}>
                      insufficient {payUnitSymbol}
                    </span>
                  )}
                </span>
              )}
              {rhEthBalance && (() => {
                const eth = parseFloat(formatUnits(rhEthBalance.value, rhEthBalance.decimals));
                return (
                  <span>
                    gas: <span className="tabular-nums">{formatNum(eth)}</span> ETH
                    {eth < 0.01 && (
                      <span className="ml-2" style={{ color: RED }} title="Low RH ETH — swap will fail with insufficient funds for gas">
                        low
                      </span>
                    )}
                  </span>
                );
              })()}
            </div>
          )}
        </div>

        {/* Pre-flight state (allowance + step plan) — visible BEFORE
            the sign click. If the panel already sees enough allowance,
            it says so. If not, it says exactly how much approve will
            be requested. Kills the "why did approve pop up again?"
            confusion + gives the user a heads-up on the # of signatures
            they're about to be asked for. */}
        {isConnected && amountNum > 0 && payToken && (
          <div className="mx-4 mb-3 rounded border px-3 py-2 text-[11px] space-y-1" style={{ borderColor: BORDER, backgroundColor: "#080a0f", color: "#9aa1ac" }}>
            <div className="flex items-center gap-2">
              <span style={{ color: MUTED }}>allowance:</span>
              <span className="tabular-nums text-white">
                {currentAllowance !== null ? formatNum(currentAllowance) : "…"} {payUnitSymbol}
              </span>
              <span style={{ color: MUTED }}>· required:</span>
              <span className="tabular-nums text-white">
                {formatNum(amountNum)} {payUnitSymbol}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span style={{ color: MUTED }}>plan:</span>
              {willSkipApprove ? (
                <span style={{ color: RH_GREEN }}>
                  skip approve · sign 1 tx (swap only)
                </span>
              ) : (
                <span style={{ color: AMBER }}>
                  sign 2 txs · approve {formatNum(amountNum)} {payUnitSymbol} → then swap
                </span>
              )}
            </div>
            {currentAllowance !== null && currentAllowance > 0 && !willSkipApprove && amountNum > 0 && (
              <div className="text-[10px]" style={{ color: MUTED }}>
                existing allowance {formatNum(currentAllowance)} {payUnitSymbol} is under the required {formatNum(amountNum)} — approve tx will overwrite it (safe on standard ERC-20).
              </div>
            )}
          </div>
        )}

        {/* Quote block */}
        <QuoteView phase={phase} quote={quote} denom={denom} onRequote={fetchQuote} />

        {/* Facts strip */}
        {arrow.snapshot_at_fire && <FactsAtFire snap={arrow.snapshot_at_fire} />}

        {/* Warnings (verbatim, per rule #4) */}
        {quote?.warnings && quote.warnings.length > 0 && (
          <div className="px-4 pb-3 space-y-1">
            {quote.warnings.map((w, i) => (
              <div key={i} className="text-[11px]" style={{ color: AMBER }}>⚠ {w}</div>
            ))}
          </div>
        )}
        {poolTooThin && (
          <div className="mx-4 mb-3 rounded border px-3 py-2 text-[11px]" style={{ borderColor: RED, color: "#f8b6b6", backgroundColor: "#160b0b" }}>
            pool too thin to trade safely (~${formatNum(poolTvl)} TVL) — engine's dust floor is ${MIN_TVL_USD.toLocaleString()}.
          </div>
        )}
        {multiHop && (
          <div className="mx-4 mb-3 rounded border px-3 py-2 text-[11px]" style={{ borderColor: AMBER, color: "#f6c88f", backgroundColor: "#1a1408" }}>
            no direct pool at this denom — X2 returned a multi-hop route.
            Multi-hop signing lands in v2. Try the other denom above for a
            direct route.
          </div>
        )}
        {heavyImpact && arrowIsOpen && !poolTooThin && (
          <div className="mx-4 mb-3">
            <label className="flex items-start gap-2 text-[11px] cursor-pointer" style={{ color: AMBER }}>
              <input
                type="checkbox"
                checked={ackImpact}
                onChange={(e) => setAckImpact(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                heavy trade — impact {(quote?.trade_impact_pct ?? 0).toFixed(2)}%.
                I understand this will move the pool and my realized fill
                will be worse than the mid-quote.
              </span>
            </label>
          </div>
        )}

        {/* Progress + result */}
        {phase.kind === "signing" && (
          <div className="mx-4 mb-3 rounded border px-3 py-2 text-[11px]" style={{ borderColor: BORDER, color: "#9aa1ac" }}>
            <span className="text-white">{phase.step}/{phase.total}</span> · {phase.label}
          </div>
        )}
        {phase.kind === "sign_error" && (
          <div className="mx-4 mb-3 rounded border px-3 py-2 space-y-2" style={{ borderColor: RED, color: "#f8b6b6", backgroundColor: "#160b0b" }}>
            <div className="text-[11px]">sign failed · {phase.msg}</div>
            {phase.approve_hash && phase.spender && phase.token && (
              <div className="border-t pt-2 space-y-1.5" style={{ borderColor: "#3a1010" }}>
                <div className="text-[10px]" style={{ color: "#f8b6b6" }}>
                  ⚠ approve tx already confirmed — allowance dangling.{" "}
                  <a href={`${RH_EXPLORER}/tx/${phase.approve_hash}`} target="_blank" rel="noreferrer" className="underline">
                    {shorten(phase.approve_hash)}
                  </a>
                </div>
                <button
                  type="button"
                  onClick={onRevoke}
                  className="w-full rounded border px-3 py-1.5 text-[11px] font-mono hover:bg-black/40 transition-colors"
                  style={{ borderColor: RED, color: RED }}
                >
                  [Revoke approval] · approve(spender, 0)
                </button>
                <div className="text-[9px]" style={{ color: MUTED }}>
                  Sends approve({shorten(phase.spender)}, 0) on the token contract — one wallet signature. Frees the allowance so no future call can spend it.
                </div>
              </div>
            )}
          </div>
        )}
        {phase.kind === "revoking" && (
          <div className="mx-4 mb-3 rounded border px-3 py-2 text-[11px]" style={{ borderColor: AMBER, color: "#e0ba7c", backgroundColor: "rgba(245,179,66,0.04)" }}>
            revoking approval — sign in wallet…
          </div>
        )}
        {phase.kind === "prepare_error" && (
          <div className="mx-4 mb-3 rounded border px-3 py-2 text-[11px]" style={{ borderColor: RED, color: "#f8b6b6", backgroundColor: "#160b0b" }}>
            prepare failed · {phase.msg}
          </div>
        )}
        {phase.kind === "quote_error" && (
          <div className="mx-4 mb-3 rounded border px-3 py-2 text-[11px]" style={{ borderColor: RED, color: "#f8b6b6", backgroundColor: "#160b0b" }}>
            quote failed · {phase.msg}
          </div>
        )}
        {phase.kind === "done" && (
          <div className="mx-4 mb-3 rounded border px-3 py-3 text-[12px] space-y-1" style={{ borderColor: RH_GREEN, backgroundColor: "rgba(0,200,5,0.06)" }}>
            <div className="text-white">✓ swap signed & broadcast</div>
            {phase.approve_hash && (
              <div className="text-[11px]" style={{ color: MUTED }}>
                approve · <a href={`${RH_EXPLORER}/tx/${phase.approve_hash}`} target="_blank" rel="noreferrer" className="underline">{shorten(phase.approve_hash)}</a>
              </div>
            )}
            <div className="text-[11px]" style={{ color: MUTED }}>
              swap · <a href={`${RH_EXPLORER}/tx/${phase.swap_hash}`} target="_blank" rel="noreferrer" className="underline" style={{ color: RH_GREEN }}>
                {shorten(phase.swap_hash)}
              </a>
            </div>
          </div>
        )}

        {/* Action bar */}
        <div className="border-t px-4 py-3 flex items-center gap-3" style={{ borderColor: "#0f1218" }}>
          {action.kind === "connect" ? (
            // Author's original comment on onSmartClick said "rendered as
            // ConnectButton child" but the ConnectButton was never wired up
            // → the plain <button> below just rendered `disabled: true` and
            // clicking did nothing. Real bug found in preview 2026-07-23.
            // Use the shared <ConnectButton> so users get the wallet-picker
            // modal (Coinbase / MetaMask / injected / WalletConnect) —
            // same UI as everywhere else in the app for consistency.
            <div className="flex-1">
              <ConnectButton
                label="Connect wallet to trade"
                className="w-full rounded border px-4 py-2 text-[13px] font-semibold"
                style={{ borderColor: RH_GREEN, color: RH_GREEN, backgroundColor: "rgba(0,200,5,0.10)" }}
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={onSmartClick}
              disabled={action.disabled || phase.kind === "signing" || phase.kind === "preparing"}
              className="flex-1 rounded border px-4 py-2 text-[13px] font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
              style={{
                borderColor: action.color,
                color: action.color,
                backgroundColor: action.color === RH_GREEN ? "rgba(0,200,5,0.10)" : "transparent",
              }}
              title={action.reason ?? undefined}
            >
              {phase.kind === "preparing" ? "preparing…" : action.label}
            </button>
          )}
          {action.reason && (
            <span className="text-[10px] max-w-[240px]" style={{ color: MUTED }} title={action.reason}>
              {action.reason}
            </span>
          )}
        </div>

        {/* Footer trust note */}
        <div className="px-4 py-2 border-t text-[9px] uppercase" style={{ borderColor: "#0f1218", color: MUTED, letterSpacing: "0.08em" }}>
          non-custodial · your wallet signs · <Link href="/hood/inbox" className="underline">/hood/inbox</Link>
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────

/**
 * P2.2 amount presets (v3 spec, 2026-07-24).
 *
 *   BUY  → 1 / 5 / 10 / 25 / 50 / 100 USDG (fixed amounts in the pay denom)
 *   SELL → 25% / 50% / 100% of REAL on-chain balance
 *
 * The percentage presets are the load-bearing part of the fix: on SELL,
 * the exact-balance-max preset makes it structurally impossible to type
 * a size > balance. Arrow #0071 NVDA (1 typed, 0.0095 held → swap
 * revert + dangling approval) was the tipping point.
 *
 * A preset that would exceed the current balance is dimmed + disabled
 * with a tooltip showing the real balance.
 */
function AmountPresetRow({
  side,
  walletBalance,
  rawBalance,
  payDecimals,
  onSet,
  currentAmount,
  payUnitSymbol,
}: {
  side: "buy" | "sell";
  walletBalance: number | null;
  /** Live on-chain balance in base-units (bigint). SELL percents are
   *  computed off THIS, never off the lossy `walletBalance` float. */
  rawBalance: bigint | undefined;
  payDecimals: number;
  onSet: (v: string) => void;
  currentAmount: string;
  payUnitSymbol: string;
}) {
  const BUY_PRESETS = [1, 5, 10, 25, 50, 100];
  // ── SELL percents computed on RAW base-units (v1.1 polish, 2026-07-25).
  //    The prior float path did `Number((balance*frac).toFixed(6))`, and
  //    `.toFixed` ROUNDS UP the last digit. Real bug: balance
  //    0.001612535…, click 100% → "0.001613" > balance → the
  //    insufficient-balance guard self-triggered and the user could never
  //    sell 100%. Integer math fixes it exactly:
  //      100% = the entire raw balance (pct=100 → raw*100/100 = raw),
  //      25/50% = floor(raw*pct/100) (integer division floors, never up).
  //    We set + display the exact floored value from `formatUnits` so what
  //    the user sees is what gets signed. `rawBalance` is the live
  //    on-chain read (refetched every 15s on the balanceOf query), so the
  //    percent is always taken against the true current balance.
  const SELL_PERCENTS: Array<{ label: string; pct: bigint }> = [
    { label: "25%",  pct: 25n },
    { label: "50%",  pct: 50n },
    { label: "100%", pct: 100n },
  ];
  const current = Number(currentAmount);
  const noBalance = rawBalance === undefined || rawBalance === 0n;
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <label className="text-[10px] uppercase" style={{ color: MUTED, letterSpacing: "0.08em" }}>preset</label>
      {side === "buy"
        ? BUY_PRESETS.map((v) => {
            const insufficient = walletBalance !== null && walletBalance < v;
            const active = current === v;
            return (
              <button
                key={v}
                type="button"
                onClick={() => onSet(String(v))}
                disabled={insufficient}
                className="rounded border px-2 py-0.5 text-[11px] disabled:opacity-40 disabled:cursor-not-allowed"
                style={{
                  borderColor: active ? RH_GREEN : BORDER,
                  color: active ? RH_GREEN : "#9aa1ac",
                  backgroundColor: active ? "rgba(0,200,5,0.10)" : "transparent",
                }}
                title={insufficient
                  ? `balance ${walletBalance?.toFixed(2)} ${payUnitSymbol} < ${v}`
                  : `Set to ${v} ${payUnitSymbol}`}
              >
                {v}
              </button>
            );
          })
        : SELL_PERCENTS.map(({ label, pct }) => {
            // floor(raw * pct / 100). BigInt division truncates toward
            // zero, so this never rounds above the real balance.
            const rawValue = rawBalance !== undefined ? (rawBalance * pct) / 100n : 0n;
            const valueStr = rawBalance !== undefined ? formatUnits(rawValue, payDecimals) : "0";
            const valueNum = Number(valueStr);
            const disabled = noBalance;
            const active = !disabled && Math.abs(current - valueNum) < 1e-12 && current > 0;
            return (
              <button
                key={label}
                type="button"
                onClick={() => onSet(valueStr)}
                disabled={disabled}
                className="rounded border px-2 py-0.5 text-[11px] disabled:opacity-40 disabled:cursor-not-allowed"
                style={{
                  borderColor: active ? RH_GREEN : BORDER,
                  color: active ? RH_GREEN : "#9aa1ac",
                  backgroundColor: active ? "rgba(0,200,5,0.10)" : "transparent",
                }}
                title={disabled
                  ? `no ${payUnitSymbol} balance to sell`
                  : `Sell ${label} of your ${payUnitSymbol} balance (${valueStr})`}
              >
                {label}
              </button>
            );
          })}
      {side === "sell" && rawBalance === 0n && (
        <span className="text-[10px]" style={{ color: RED }}>
          no {payUnitSymbol} to sell
        </span>
      )}
    </div>
  );
}

function SideToggle({ value, onChange, disabled }: { value: "buy" | "sell"; onChange: (v: "buy" | "sell") => void; disabled?: boolean }) {
  return (
    <div className="inline-flex rounded border overflow-hidden" style={{ borderColor: BORDER }}>
      {(["buy", "sell"] as const).map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => onChange(s)}
          disabled={disabled}
          className="px-2 py-0.5 text-[11px]"
          style={{
            color: value === s ? RH_GREEN : "#9aa1ac",
            backgroundColor: value === s ? "rgba(0,200,5,0.10)" : "transparent",
          }}
        >
          {s.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

function DenomToggle({ value, onChange, disabled }: { value: "USDG" | "WETH"; onChange: (v: "USDG" | "WETH") => void; disabled?: boolean }) {
  return (
    <div className="inline-flex rounded border overflow-hidden" style={{ borderColor: BORDER }}>
      {(["USDG", "WETH"] as const).map((d) => (
        <button
          key={d}
          type="button"
          onClick={() => onChange(d)}
          disabled={disabled}
          className="px-2 py-0.5 text-[11px]"
          style={{
            color: value === d ? RH_GREEN : "#9aa1ac",
            backgroundColor: value === d ? "rgba(0,200,5,0.10)" : "transparent",
          }}
        >
          {d}
        </button>
      ))}
    </div>
  );
}

function QuoteView({ phase, quote, denom, onRequote }: { phase: Phase; quote: QuoteResponse | null; denom: string; onRequote: () => void }) {
  if (phase.kind === "quoting") {
    return <div className="px-4 pb-3 text-[11px]" style={{ color: MUTED }}>quoting…</div>;
  }
  if (!quote) return null;
  const rows: [string, string][] = [
    ["spot",             quote.spot_usd !== null ? `$${quote.spot_usd.toFixed(4)}` : "—"],
    ["expected out",     quote.expected_out !== null ? `${formatNum(quote.expected_out)}` : "—"],
    ["after impact",     quote.expected_after_impact !== null ? `${formatNum(quote.expected_after_impact)}` : "—"],
    ["min out",          quote.min_out !== null ? `${formatNum(quote.min_out)}` : "—"],
    ["trade impact",     `${quote.trade_impact_pct.toFixed(3)}%`],
    ["pool·oracle Δ",    quote.pool_oracle_delta_pct !== null ? `${quote.pool_oracle_delta_pct.toFixed(3)}%` : "—"],
    ["source",           quote.spot_source ?? "—"],
    ["route",            quote.route.kind ?? "—"],
  ];
  return (
    <div className="mx-4 mb-3 rounded border px-3 py-2 text-[11px] space-y-0.5" style={{ borderColor: BORDER, backgroundColor: "#0a0c11", color: "#9aa1ac" }}>
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[9px] uppercase" style={{ color: MUTED, letterSpacing: "0.15em" }}>quote</span>
        <button type="button" onClick={onRequote} className="ml-auto text-[10px] underline" style={{ color: MUTED }}>
          re-quote
        </button>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 tabular-nums">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between">
            <span style={{ color: MUTED }}>{k}</span>
            <span className="text-white">{v}</span>
          </div>
        ))}
      </div>
      <div className="mt-1 text-[9px]" style={{ color: MUTED }}>denom in: {denom}</div>
    </div>
  );
}

function FactsAtFire({ snap }: { snap: NonNullable<Arrow["snapshot_at_fire"]> }) {
  const pairs: [string, string][] = [
    ["dex@fire",    snap.dex_price_usd !== null ? `$${snap.dex_price_usd.toFixed(4)}` : "—"],
    ["oracle@fire", snap.oracle_price_usd !== null ? `$${snap.oracle_price_usd.toFixed(4)}` : "—"],
    ["tvl@fire",    snap.dex_tvl_usd !== null ? `$${formatNum(snap.dex_tvl_usd)}` : "—"],
    ["vol@fire",    snap.dex_volume_24h_usd !== null ? `$${formatNum(snap.dex_volume_24h_usd)}` : "—"],
  ];
  return (
    <div className="mx-4 mb-3 rounded border px-3 py-2 text-[10px] tabular-nums" style={{ borderColor: BORDER, backgroundColor: "#080a0e", color: "#9aa1ac" }}>
      <div className="text-[8px] uppercase mb-1" style={{ color: MUTED, letterSpacing: "0.15em" }}>facts at fire</div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5">
        {pairs.map(([k, v]) => (
          <span key={k}><span style={{ color: MUTED }}>{k}</span> {v}</span>
        ))}
      </div>
    </div>
  );
}

// ── Smart action button ───────────────────────────────────────────────

interface ActionState {
  kind: "connect" | "switch" | "requote" | "sign" | "noop" | "close";
  label: string;
  disabled: boolean;
  color: string;
  reason: string | null;
}

function pickAction(o: {
  phase: Phase;
  isConnected: boolean;
  wrongChain: boolean;
  hasAddress: boolean;
  arrowIsOpen: boolean;
  validAmount: boolean;
  insufficient: boolean;
  poolTooThin: boolean;
  heavyImpact: boolean;
  ackImpact: boolean;
  quoteStale: boolean;
  deadlineExpired: boolean | undefined;
  multiHop: boolean | undefined;
  quote: QuoteResponse | null;
}): ActionState {
  if (o.phase.kind === "done") {
    // v1.1 polish (2026-07-25): this used to be a DISABLED noop, so after
    // a swap the primary button did nothing and the user had to hunt for
    // the ✕ in the header to dismiss. Make it an enabled Close action that
    // actually calls `onClose` (handled in onSmartClick). Green = success.
    return { kind: "close", label: "Done · close", disabled: false, color: RH_GREEN, reason: null };
  }
  if (!o.arrowIsOpen) {
    return { kind: "noop", label: "signal closed · read-only", disabled: true, color: MUTED, reason: null };
  }
  if (!o.isConnected || !o.hasAddress) {
    return { kind: "connect", label: "Connect wallet to trade", disabled: true, color: MUTED, reason: "no wallet connected" };
  }
  if (o.wrongChain) {
    return { kind: "switch", label: "Switch to Robinhood Chain", disabled: false, color: AMBER, reason: `expected chain 4663` };
  }
  if (!o.validAmount) {
    return { kind: "noop", label: "Enter an amount", disabled: true, color: MUTED, reason: null };
  }
  if (o.insufficient) {
    return { kind: "noop", label: "Insufficient balance", disabled: true, color: RED, reason: "topup or lower the amount" };
  }
  if (!o.quote) {
    return { kind: "noop", label: "Waiting for quote…", disabled: true, color: MUTED, reason: null };
  }
  if (o.poolTooThin) {
    return { kind: "noop", label: "Pool too thin", disabled: true, color: RED, reason: `TVL below dust floor` };
  }
  // V3 executability — quote's honest "can prepare build calldata" flag.
  // Was silently absent before the SNDK bug fix: quote said "direct"
  // based on GT (which includes V4), user clicked Sign, prepare failed
  // with "no route". Now the panel disables Sign at quote time.
  if (o.quote.route.executable === false) {
    const reason = o.quote.route.unavailable_reason ?? "No V3 pool for this pair";
    return {
      kind: "noop",
      label: "Not executable · V3 router",
      disabled: true,
      color: AMBER,
      reason: `${reason}. V4 support: Task #75.`,
    };
  }
  if (o.multiHop) {
    return { kind: "noop", label: "Multi-hop not in v1", disabled: true, color: AMBER, reason: "try the other denom for a direct route" };
  }
  if (o.deadlineExpired || o.quoteStale) {
    return { kind: "requote", label: "Re-quote", disabled: false, color: AMBER, reason: "quote is stale — pull a fresh one" };
  }
  if (o.heavyImpact && !o.ackImpact) {
    return { kind: "noop", label: "Acknowledge heavy impact first", disabled: true, color: AMBER, reason: `tick the checkbox above` };
  }
  return { kind: "sign", label: "Review & Sign (2 txs)", disabled: false, color: RH_GREEN, reason: null };
}

// ── Utils ─────────────────────────────────────────────────────────────

async function postUserAction(arrowId: string, action: UserAction) {
  try {
    await fetch(`/api/hood/arrows/${arrowId}/user-action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(action),
    });
  } catch (e) {
    console.warn("[review-sign] user-action post failed:", (e as Error).message);
  }
}

function formatNum(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (Math.abs(n) >= 1) return n.toFixed(4);
  return n.toFixed(6);
}

/**
 * Turn viem/MetaMask raw error dumps into one honest sentence. Before
 * this the error box showed hundreds of characters of viem stack + RPC
 * details that no user could parse (screenshots 3 + 4 on 2026-07-23).
 *
 * We look at KNOWN failure modes (rejected, out of gas ETH, deadline,
 * slippage, revert, chain switch refused) and pick a short human line.
 * If nothing matches we fall back to the first line of the raw message
 * — better than dumping the whole thing.
 */
function humanizeSignError(raw: string): string {
  const s = raw || "";
  const low = s.toLowerCase();

  // ── User-initiated cancel — highest priority ────────────────────────
  if (/reject|denied|user\s+cancel/i.test(s)) {
    return "cancelled — you rejected the signature";
  }

  // ── ORDER MATTERS (2026-07-25 fix): specific typed categories must
  //    be checked BEFORE the generic `execution reverted` fallback.
  //    Prior version had the generic branch first, which caught the raw
  //    "execution reverted" fragment inside the sim's throw and served
  //    the generic "reason unavailable" message. Result: every BUY on
  //    prod showed "reverted, check balance+allowance" no matter the
  //    real cause. Any change here MUST keep the specific-first order.

  // Client-side asserts thrown by signFlow itself:
  if (low.startsWith("insufficient_balance:")) {
    // Format: `insufficient_balance: requested X but balance is Y. ...`
    const detail = s.replace(/^insufficient_balance:\s*/i, "").split(/\n/)[0]?.trim() ?? "";
    return `insufficient balance — ${detail || "amount exceeds wallet balance"}`;
  }
  if (low.startsWith("insufficient_gas_eth:")) {
    // Format: `insufficient_gas_eth: have X ETH, need at least Y`
    const detail = s.replace(/^insufficient_gas_eth:\s*/i, "").split(/\n/)[0]?.trim() ?? "";
    return `insufficient ETH for gas on Robinhood Chain — ${detail || "top up native ETH before retrying"}`;
  }
  if (low.startsWith("swap_would_revert:")) {
    // Pre-flight sim (see signFlow step d). The decoded reason is
    // whatever the RPC returned — never editorialize. Recognize the
    // common ERC-20 balance error shape and give the user a specific
    // fix hint; otherwise surface verbatim.
    const decoded = s.replace(/^swap_would_revert:\s*/i, "").split(/\n/)[0]?.trim() ?? "";
    if (/transfer_?(from)?_failed|erc20:.*balance|exceeds allowance|exceeds balance/i.test(decoded)) {
      return `swap sim would fail with "${decoded}" — the router can't move the requested amount. Verify balance + existing allowance for the correct token.`;
    }
    if (/too_?little_?received|slippage/i.test(decoded)) {
      return `swap sim: quote drifted (${decoded}) — hit Re-quote or widen slippage.`;
    }
    if (/stf\b/i.test(decoded)) {
      // Uniswap V3 "STF" = SafeTransferFrom failure — usually allowance
      // OR the token has a transfer restriction.
      return `swap sim: router SafeTransferFrom failed ("${decoded}") — allowance may be under-set OR the token has a transfer restriction.`;
    }
    return decoded ? `swap sim reverted: ${decoded}` : "swap sim would revert (no decoded reason from RPC)";
  }
  if (low.startsWith("approve_reverted:") || /^approve_reverted\b/.test(low)) {
    return "approve transaction reverted on-chain — nothing was granted. Retry the flow.";
  }
  if (low.startsWith("approve_state_not_propagated:") || low.startsWith("swap_state_not_propagated:")) {
    return "approve landed on-chain but the RPC still reports the old allowance — wait a block and retry.";
  }
  if (low.startsWith("recipient mismatch:") || low.startsWith("unsupported_route:")) {
    // Bare-metal client errors — no humanization needed, they carry
    // the debug info devs want.
    return s.split(/\n/)[0]?.trim() ?? s.slice(0, 200);
  }

  // ── Wallet + RPC-layer errors (before generic revert) ───────────────
  // "insufficient funds for gas * price + value" — this is the wallet
  // rejecting a tx it can't afford. Different from insufficient_gas_eth
  // (which is our pre-check).
  if (low.includes("insufficient funds") || low.includes("exceeds the balance")) {
    return "wallet rejected the tx: not enough ETH on Robinhood Chain to pay gas — top up native ETH on RH.";
  }
  if (low.includes("nonce too low") || low.includes("nonce is too low")) {
    return "wallet nonce mismatch — refresh the page and try again";
  }
  if (low.includes("chain") && low.includes("mismatch")) {
    return "wallet on the wrong chain — switch to Robinhood Chain (4663)";
  }
  if (low.includes("deadline") && low.includes("exceeded")) {
    return "swap deadline passed — hit re-quote to pull a fresh quote";
  }
  if (low.includes("gas required exceeds allowance")) {
    return "wallet blocked the gas estimate — top up native ETH on RH";
  }

  // ── Generic "execution reverted" — ONLY reached if none of the
  //    specific branches above matched. This means the revert didn't
  //    come from our pre-flight sim or a labeled client throw — it's
  //    a viem/wallet layer message we don't recognize. Say so.
  if (low.includes("execution reverted")) {
    return "on-chain transaction reverted — reason unavailable from the RPC. Check token balance + allowance; do NOT re-sign until you know why.";
  }

  // Fall back to the first line only.
  const first = s.split(/\n|Details:|Request Arguments:|Version:/)[0]?.trim() ?? "sign failed";
  return first.length > 200 ? first.slice(0, 200) + "…" : first;
}
function shorten(h: string): string { return `${h.slice(0, 6)}…${h.slice(-4)}`; }
function formatRelTime(iso: string): string {
  const sec = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
// Silence unused-import warnings — parseUnits reserved for future
// balance-decimal parsing; keep it in scope so a follow-up doesn't
// need to re-thread the import.
void parseUnits;
