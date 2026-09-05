/**
 * Execute one DCA run for a schedule.
 *
 * Flow (Base mainnet, EOA-approve model):
 *   1. Verify user's approve(sellToken → keeper) covers this run
 *   2. Verify user's sellToken balance covers it
 *   3. Keeper pulls sellAmount + fee via transferFrom(user, keeper, total)
 *   4. Keeper (one-time per token) approves the 0x AllowanceHolder
 *   5. Keeper fetches a fresh 0x AllowanceHolder quote
 *   6. Keeper submits the swap tx (buyToken lands at keeper)
 *   7. Keeper transfers buyToken to user (minus 0 — fee is taken in sellToken up front)
 *   8. Keeper retains `sellAmount × feeBps / 10_000` in sellToken for gas reimbursement
 *
 * Non-goals for v1:
 *   - Multi-hop route optimization (0x picks route, we accept)
 *   - MEV protection beyond slippage (0x has private-order defaults)
 *   - Atomic bundling (this is 3–4 separate txs; on Base at 0.05 gwei that's ~$0.001)
 */

import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  http,
  maxUint256,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { base } from "viem/chains";
import { deriveKeeperAccount, getKeeperMasterKey } from "./keeper";
import { ensureKeeperGas } from "./gas-topup";
import type { DcaSchedule, DcaExecutionLog } from "./types";

const ERC20_ABI = [
  { type: "function", name: "approve",     stateMutability: "nonpayable",
    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "allowance",   stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf",   stateMutability: "view",
    inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "transfer",    stateMutability: "nonpayable",
    inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "transferFrom", stateMutability: "nonpayable",
    inputs: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

/**
 * ERC-20 Transfer event ABI — used to authoritatively count buyToken received
 * from the swap receipt logs (rather than re-querying balanceOf, which can
 * return stale data across RPC nodes right after a fresh tx).
 */
const TRANSFER_EVENT_ABI = [
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { indexed: true,  name: "from",  type: "address" },
      { indexed: true,  name: "to",    type: "address" },
      { indexed: false, name: "value", type: "uint256" },
    ],
  },
] as const;

/**
 * Sum every Transfer(_, to=recipient) event for `token` in the given logs.
 * Authoritative for "how much of buyToken did recipient just receive" — the
 * data lives in the tx receipt itself, so it isn't subject to RPC-node lag
 * on `balanceOf(recipient)` right after a swap.
 */
function sumIncomingTransfers(
  logs: readonly { address: string; data: `0x${string}`; topics: `0x${string}`[] }[],
  token: Address,
  recipient: Address,
): bigint {
  const tokenLc     = token.toLowerCase();
  const recipientLc = recipient.toLowerCase();
  let sum = 0n;
  for (const log of logs) {
    if (log.address.toLowerCase() !== tokenLc) continue;
    try {
      const decoded = decodeEventLog({
        abi: TRANSFER_EVENT_ABI,
        data: log.data,
        topics: log.topics as [signature: `0x${string}`, ...args: `0x${string}`[]],
      });
      if (decoded.eventName === "Transfer" && decoded.args.to.toLowerCase() === recipientLc) {
        sum += decoded.args.value as bigint;
      }
    } catch { /* not a Transfer event, skip */ }
  }
  return sum;
}

const ZEROX_URL = "https://api.0x.org/swap/allowance-holder/quote";

type ZeroExIssue = { actual: string; spender: `0x${string}` } | null;
type ZeroExQuote = {
  buyAmount: string;
  sellAmount: string;
  minBuyAmount: string;
  gas: string;
  issues: { allowance: ZeroExIssue; balance: unknown };
  transaction: { to: `0x${string}`; data: `0x${string}`; value: string; gas?: string; gasPrice?: string };
  route?: unknown;
};

/**
 * Fetch a firm 0x AllowanceHolder quote. Throws on any API-level or shape error
 * so the cron loop catches + logs uniformly.
 */
async function fetchZeroExQuote(params: {
  sellToken: Address;
  buyToken: Address;
  sellAmount: bigint;
  taker: Address;
  slippageBps: number;
}): Promise<ZeroExQuote> {
  const key = process.env.ZEROX_API_KEY;
  if (!key) throw new Error("ZEROX_API_KEY not set — DCA cannot fetch swap quotes");

  const qs = new URLSearchParams({
    chainId: "8453",
    sellToken: params.sellToken,
    buyToken:  params.buyToken,
    sellAmount: params.sellAmount.toString(),
    taker: params.taker,
    slippageBps: String(params.slippageBps),
  });

  const res  = await fetch(`${ZEROX_URL}?${qs}`, {
    headers: { "0x-api-key": key, "0x-version": "v2" },
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `0x quote failed (${res.status}): ${(data as { reason?: string; message?: string })?.reason
        ?? (data as { reason?: string; message?: string })?.message
        ?? "unknown"}`,
    );
  }
  if (!data?.transaction?.to || !data?.transaction?.data) {
    throw new Error("0x quote missing transaction payload");
  }
  return data as ZeroExQuote;
}

// Typed as `any` to sidestep viem's duplicate-install type friction (two viem
// copies get resolved via wagmi vs direct import; their PublicClient types are
// nominally identical but not structurally equal to TS). Runtime is fine.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function waitReceipt(pc: any, hash: Hex): Promise<void> {
  const receipt = await pc.waitForTransactionReceipt({ hash, timeout: 90_000 });
  if (receipt.status !== "success") throw new Error(`tx ${hash} reverted`);
}

/**
 * Compute the total amount to pull from user for one run: sellAmount + keeperFee.
 * Fee is expressed in sellToken (typically USDC) so it's stable, not exposed to
 * price movement of the buy token.
 */
export function computeRunPull(sellAmountPerRun: bigint, feeBps: number): {
  totalPull: bigint;
  swapAmount: bigint;
  feeAmount: bigint;
} {
  const feeAmount  = (sellAmountPerRun * BigInt(feeBps)) / 10_000n;
  const swapAmount = sellAmountPerRun;
  const totalPull  = swapAmount + feeAmount;
  return { totalPull, swapAmount, feeAmount };
}

export type ExecuteRunOpts = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  publicClient?: any;
  rpcUrl?: string;
  now?: number; // for tests
};

/**
 * Execute a single DCA run. Returns a log entry describing the outcome.
 * Never throws — every failure mode becomes a `status: "failed"` log.
 */
export async function executeDcaRun(
  schedule: DcaSchedule,
  opts: ExecuteRunOpts = {},
): Promise<DcaExecutionLog> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const runNumber = schedule.runsCompleted + 1;
  const baseLog: DcaExecutionLog = {
    scheduleId: schedule.id,
    runNumber,
    timestamp: now,
    txHash: null,
    approveHash: null,
    status: "failed",
    sellAmount: "0",
    buyAmount: "0",
    effectivePrice: null,
    gasSpentWei: "0",
    error: null,
  };

  try {
    if (schedule.chainId !== 8453) {
      throw new Error(`v1 supports Base only, got chainId=${schedule.chainId}`);
    }
    if (schedule.status !== "active") {
      return { ...baseLog, status: "skipped", error: `schedule status=${schedule.status}` };
    }
    if (schedule.expiresAt <= now) {
      return { ...baseLog, status: "skipped", error: "schedule expired" };
    }

    const rpcUrl = opts.rpcUrl ?? process.env.BASE_RPC_URL ?? "https://mainnet.base.org";
    const publicClient = opts.publicClient ?? createPublicClient({ chain: base, transport: http(rpcUrl) });

    const keeper = deriveKeeperAccount(getKeeperMasterKey(), schedule.userAddress);
    if (keeper.address.toLowerCase() !== schedule.keeperAddress.toLowerCase()) {
      throw new Error(
        `derived keeper mismatch: ${keeper.address} vs stored ${schedule.keeperAddress}`,
      );
    }

    const walletClient = createWalletClient({
      account: keeper,
      chain: base,
      transport: http(rpcUrl),
    });

    // 0. Ensure keeper has enough ETH for the ~3-tx sequence below. No-op if
    //    GAS_TOP_UP_PRIVATE_KEY isn't set — will surface an insufficient-funds
    //    error at the transferFrom step instead, which is at least visible.
    const gas = await ensureKeeperGas(keeper.address, { publicClient });
    if (!gas.ok) {
      throw new Error(`gas top-up failed: ${gas.error}`);
    }

    const sellAmountPerRun = BigInt(schedule.sellAmountPerRun);
    const { totalPull, swapAmount, feeAmount } = computeRunPull(
      sellAmountPerRun,
      schedule.feeBps,
    );

    // 1. Verify user allowance to keeper covers this run
    const [userAllowance, userBalance] = await Promise.all([
      publicClient.readContract({
        address: schedule.sellToken,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [schedule.userAddress, keeper.address],
      }) as Promise<bigint>,
      publicClient.readContract({
        address: schedule.sellToken,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [schedule.userAddress],
      }) as Promise<bigint>,
    ]);

    if (userAllowance < totalPull) {
      throw new Error(
        `user allowance ${userAllowance} < required ${totalPull} — user must re-approve`,
      );
    }
    if (userBalance < totalPull) {
      throw new Error(
        `user balance ${userBalance} < required ${totalPull} — schedule stalled`,
      );
    }

    // 2. Pull user → keeper (sellAmount + fee)
    const pullHash = await walletClient.writeContract({
      address: schedule.sellToken,
      abi: ERC20_ABI,
      functionName: "transferFrom",
      args: [schedule.userAddress, keeper.address, totalPull],
      account: keeper,
      chain: base,
    });
    await waitReceipt(publicClient, pullHash);

    // 3. Fetch 0x quote for the swap portion
    const quote = await fetchZeroExQuote({
      sellToken: schedule.sellToken,
      buyToken:  schedule.buyToken,
      sellAmount: swapAmount,
      taker: keeper.address,
      slippageBps: schedule.slippageBps,
    });

    // 4. Approve 0x AllowanceHolder if the current allowance is insufficient
    let approveHash: Hex | null = null;
    const spender = quote.issues?.allowance?.spender;
    if (spender) {
      const currentAllowance = (await publicClient.readContract({
        address: schedule.sellToken,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [keeper.address, spender],
      })) as bigint;
      if (currentAllowance < swapAmount) {
        approveHash = await walletClient.writeContract({
          address: schedule.sellToken,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [spender, maxUint256],
          account: keeper,
          chain: base,
        });
        await waitReceipt(publicClient, approveHash);
      }
    }

    // 5. Execute the swap
    const swapHash = await walletClient.sendTransaction({
      account: keeper,
      chain: base,
      to:    quote.transaction.to,
      data:  quote.transaction.data,
      value: BigInt(quote.transaction.value ?? "0"),
      gas:   quote.transaction.gas ? BigInt(quote.transaction.gas) : undefined,
    });
    const swapReceipt = await publicClient.waitForTransactionReceipt({
      hash: swapHash,
      timeout: 120_000,
    });
    if (swapReceipt.status !== "success") {
      throw new Error(`swap tx ${swapHash} reverted`);
    }

    // 6. Count buyToken this swap credited to keeper by parsing Transfer events
    //    from the receipt. Reliable — receipt logs are part of the confirmed tx,
    //    not subject to `balanceOf` RPC staleness that would otherwise misread
    //    the delta when this run follows another run in the same cron tick.
    const boughtAmount = sumIncomingTransfers(
      swapReceipt.logs,
      schedule.buyToken,
      keeper.address,
    );

    if (boughtAmount === 0n) {
      // Swap tx confirmed but zero buyToken landed at keeper — a broken route
      // or wrong 0x taker binding. Return failed so cron retries + surfaces
      // an obvious `lastError`, and DO NOT increment totalSpent/Bought.
      return {
        ...baseLog,
        txHash: swapHash,
        approveHash,
        status: "failed",
        sellAmount: "0",  // don't count spend if we got nothing — 0.5% fee is lost, but that's on us
        buyAmount:  "0",
        effectivePrice: null,
        gasSpentWei: "0",
        error: `swap tx ${swapHash} confirmed but zero ${schedule.buyTokenSymbol} received (route or taker bug)`,
      };
    }

    // 7. Forward buyToken to user
    const transferHash = await walletClient.writeContract({
      address: schedule.buyToken,
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [schedule.userAddress, boughtAmount],
      account: keeper,
      chain: base,
    });
    await waitReceipt(publicClient, transferHash);

    // 8. Compute effective price (buy per sell, human decimals)
    const sellHuman = Number(swapAmount) / 10 ** schedule.sellTokenDecimals;
    const buyHuman  = Number(boughtAmount) / 10 ** schedule.buyTokenDecimals;
    const price     = sellHuman > 0 ? (buyHuman / sellHuman).toFixed(8) : null;

    return {
      ...baseLog,
      txHash: swapHash,
      approveHash,
      status: "success",
      sellAmount: swapAmount.toString(),
      buyAmount:  boughtAmount.toString(),
      effectivePrice: price,
      // gasSpentWei: aggregate would require reading each receipt; skip in v1
      gasSpentWei: "0",
      error: null,
    };
  } catch (e) {
    return {
      ...baseLog,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Compute total allowance user must approve for a schedule (all runs + fee).
 * Callers building the approve() calldata for the DCA card use this.
 */
export function computeTotalAllowance(
  sellAmountPerRunHuman: string,
  totalRuns: number,
  feeBps: number,
  sellTokenDecimals: number,
): bigint {
  const perRunBase = parseUnits(sellAmountPerRunHuman, sellTokenDecimals);
  const withFee    = (perRunBase * BigInt(10_000 + feeBps)) / 10_000n;
  return withFee * BigInt(totalRuns);
}
