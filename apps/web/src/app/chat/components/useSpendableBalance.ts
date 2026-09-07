"use client";

/**
 * ONE balance read for every card that spends — send, swap, bridge.
 *
 * ─── Why this is a hook and not three copies ─────────────────────────────────
 *
 * MEASURED 2026-09-07. The three Robinhood action cards each hand-rolled the
 * same read and each got it wrong the same two ways. Both bugs are the shape
 * this repo keeps finding: a fact that was never established, rendered as if
 * it had been.
 *
 * ① DECIMALS WERE ASSUMED, NOT READ.
 *
 *      RobinhoodSwapCard    formatUnits(tokenBal, 18) — three times
 *      RobinhoodSendCard    prep?.meta?.decimals ?? (isNative ? 18 : 18)
 *      RobinhoodBridgeCard  prep?.meta?.token.decimals ?? 18
 *
 *    The last two look like they defer to the server. They cannot: `prep` only
 *    exists after the prepare fetch, the prepare fetch is gated on `amount`,
 *    and for a symbolic amount ("all" / "half" / "50%") `amount` is resolved
 *    FROM the balance. The dependency is circular, so the fallback is not a
 *    fallback — it is the value, always.
 *
 *    USDG is 6 decimals (`0x5fc5…d168`, rwa-registry.ts) and it is what
 *    Robinhood Chain uses for cash. Read at 18, a wallet holding 1,000 USDG
 *    reports 0.000000000001, so "swap all my USDG" resolved to dust and any
 *    real amount tripped the over-balance guard: the confirm button read
 *    "Insufficient balance" and was DISABLED on a wallet that held plenty.
 *
 *    The swap card had already found this — its own comment at the prepare
 *    step says "Hardcoding 18 was a real bug: USDG has 6 decimals" — and fixed
 *    the copy it was standing in front of. Ninety lines above, the copy that
 *    decides whether the button is even clickable kept the bug. That is the
 *    argument for this file: the fix has to have one address.
 *
 *    So decimals are READ, on-chain, as a first-class query beside the
 *    balance. A raw integer with a guessed exponent is not a quantity, which
 *    is why an unread `decimals` counts as an unread BALANCE below and not as
 *    some lesser degradation.
 *
 * ② PENDING AND FAILED WERE THE SAME VALUE.
 *
 *    All three destructured only `.data`, so "still reading" and "could not
 *    read" were both `null`, and all three then wrote the guard as
 *    `balance != null && amount > balance` — FAIL-OPEN. On a failed read the
 *    guard is false, the button enables, and the user signs and pays gas for a
 *    transaction that cannot succeed. That is precisely the outcome each
 *    card's own comment says the balance read exists to prevent.
 *
 *    Robinhood Chain has one public RPC. This is not a hypothetical.
 *
 * The four states and the fail-closed gate live in `lib/wallet/read-state.ts`,
 * shared with the wallet's holdings tables — see `resolveSpend` there. This
 * hook's only job is to produce honest SIGNALS for it: what is in flight, what
 * came back, and what did not.
 */

import { useCallback } from "react";
import { useBalance, useReadContract } from "wagmi";
import { formatUnits, isAddress } from "viem";
import { ERC20_ABI } from "@/lib/yield-execution";

export interface SpendableBalance {
  /** Human-scale balance. `null` whenever it is not established — for ANY reason. */
  balance: number | null;
  /** Read from the token, never assumed. `null` until known. */
  decimals: number | null;
  /** Feed straight into `resolveSpend`. */
  loading: boolean;
  received: boolean;
  failed: boolean;
  /** Re-runs every query this hook owns. The way out of `unverified`. */
  refetch: () => Promise<void>;
  /** A re-read is in flight. Derived from the queries, never stored. */
  refetching: boolean;
}

/**
 * @param holder   whose balance. Falsy → nothing is read.
 * @param native   true for the chain's own coin; `token` is then ignored.
 * @param token    ERC-20 address. A non-address (empty, a symbol, a partial
 *                 paste) reads nothing rather than reading garbage.
 * @param chainId  which chain. Base and Robinhood share no state, so a balance
 *                 without a chain is not an answer — see CLAUDE.md rule 1.
 *
 * NOTE on `enabled`: a wagmi query that is disabled sits at `isPending`
 * forever, so `received` stays false and the gate reads "reading" — the same
 * trap that would have pinned the wallet page to a permanent spinner on any
 * chain without an Aave market. Callers must therefore only consult the gate
 * once they have a holder and a usable token; every card here already renders
 * "Connect your wallet" or a field error before that point. `applicable` is
 * returned so a caller can assert it rather than assume it.
 */
export function useSpendableBalance(opts: {
  holder?: `0x${string}` | "";
  native: boolean;
  token?: string;
  chainId: number;
}): SpendableBalance & { applicable: boolean } {
  const { holder, native, token, chainId } = opts;
  const tokenAddr = token && isAddress(token) ? (token as `0x${string}`) : undefined;
  const applicable = !!holder && (native || !!tokenAddr);

  const nativeQ = useBalance({
    address: holder || undefined,
    chainId,
    query: { enabled: !!holder && native },
  });

  // Decimals and balance are read as a PAIR and fail as a pair. Splitting them
  // would reintroduce the exact bug: a balance whose scale is unknown is not a
  // partially-known quantity, it is an unknown one.
  const decQ = useReadContract({
    address: tokenAddr, abi: ERC20_ABI, functionName: "decimals", chainId,
    query: { enabled: !!holder && !native && !!tokenAddr },
  });
  const balQ = useReadContract({
    address: tokenAddr, abi: ERC20_ABI, functionName: "balanceOf",
    args: holder ? [holder] : undefined, chainId,
    query: { enabled: !!holder && !native && !!tokenAddr },
  });

  // `useBalance` reports the coin's own decimals — 18 for an EVM native, but
  // taken from the response rather than written down, so this file contains no
  // decimals literal to drift.
  const decimals = native
    ? (nativeQ.data ? nativeQ.data.decimals : null)
    : (decQ.data != null ? Number(decQ.data) : null);

  const raw: bigint | null = native
    ? (nativeQ.data ? nativeQ.data.value : null)
    : (balQ.data != null ? (balQ.data as bigint) : null);

  const balance = raw != null && decimals != null
    ? Number(formatUnits(raw, decimals))
    : null;

  const qs = native ? [nativeQ] : [decQ, balQ];

  const refetch = useCallback(async () => {
    await Promise.all(qs.map(q => q.refetch()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [native, tokenAddr, holder, chainId]);

  return {
    applicable,
    balance,
    decimals,
    loading:  qs.some(q => q.isLoading),
    received: qs.every(q => !q.isPending),
    // Any query erroring, and also a resolved read that still produced no
    // usable number — a response that arrives without one of the two halves is
    // a failed read, not a zero balance.
    failed:   qs.some(q => q.isError) || (qs.every(q => !q.isPending) && balance == null),
    refetch,
    refetching: qs.some(q => q.isFetching),
  };
}
