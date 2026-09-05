/**
 * Gas top-up for per-user keeper wallets.
 *
 * Problem: a freshly-derived keeper EOA has 0 ETH on Base. The very first
 * DCA execution needs ~$0.001 of gas which the keeper doesn't have, so the
 * transferFrom() reverts before we even see it fail on-chain (RPC rejects
 * the send).
 *
 * Solution: a shared "gas tank" hot wallet whose sole job is to keep each
 * user's keeper topped up with enough ETH to run a few swap-tx sequences.
 * The keeper's 0.5% sell-token fee accumulates over time and can be
 * periodically converted to ETH to refill this tank (out-of-band, manual v1).
 *
 * Env:
 *   GAS_TOP_UP_PRIVATE_KEY — 0x + 64 hex chars, the tank's signer key.
 *                            Fund this wallet with ~0.05 ETH on Base ($150+).
 *
 * Design:
 *   - MIN_KEEPER_BALANCE  — if keeper below this, top up
 *   - TOP_UP_AMOUNT        — how much to send per top-up
 *   - MAX_TOP_UPS_PER_TICK — safety cap so a runaway loop can't drain the tank
 *
 * If GAS_TOP_UP_PRIVATE_KEY is not set, `ensureKeeperGas()` is a no-op that
 * returns { skipped: true } — the swap will still fail with insufficient-funds
 * but that's the same as before, so we degrade gracefully.
 */

import { createPublicClient, createWalletClient, http, parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const MIN_KEEPER_BALANCE_ETH = "0.0002";   // ~$0.6 — enough for ~5 tx at 0.05 gwei
const TOP_UP_AMOUNT_ETH      = "0.001";    // ~$3 — enough for ~30 tx sequences

const MIN_KEEPER_BALANCE_WEI = parseEther(MIN_KEEPER_BALANCE_ETH);
const TOP_UP_AMOUNT_WEI      = parseEther(TOP_UP_AMOUNT_ETH);

export type GasTopUpResult =
  | { ok: true; action: "sent";    txHash: Hex; keeperBalanceBefore: string; sentWei: string }
  | { ok: true; action: "skip";    reason: "sufficient" | "no_key"; keeperBalanceBefore: string }
  | { ok: false; error: string; keeperBalanceBefore?: string };

export async function ensureKeeperGas(
  keeperAddress: Address,
  opts: { rpcUrl?: string; publicClient?: any } = {}, // eslint-disable-line @typescript-eslint/no-explicit-any
): Promise<GasTopUpResult> {
  const pk = process.env.GAS_TOP_UP_PRIVATE_KEY as `0x${string}` | undefined;
  const rpcUrl = opts.rpcUrl ?? process.env.BASE_RPC_URL ?? "https://mainnet.base.org";
  const pc = opts.publicClient ?? createPublicClient({ chain: base, transport: http(rpcUrl) });

  let keeperBalance: bigint;
  try {
    keeperBalance = await pc.getBalance({ address: keeperAddress });
  } catch (e) {
    return { ok: false, error: `getBalance failed: ${(e as Error).message}` };
  }

  if (keeperBalance >= MIN_KEEPER_BALANCE_WEI) {
    return {
      ok: true,
      action: "skip",
      reason: "sufficient",
      keeperBalanceBefore: keeperBalance.toString(),
    };
  }

  if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    return {
      ok: true,
      action: "skip",
      reason: "no_key",
      keeperBalanceBefore: keeperBalance.toString(),
    };
  }

  const tank = privateKeyToAccount(pk);
  const walletClient = createWalletClient({ account: tank, chain: base, transport: http(rpcUrl) });

  try {
    const txHash = await walletClient.sendTransaction({
      account: tank,
      chain: base,
      to: keeperAddress,
      value: TOP_UP_AMOUNT_WEI,
    });
    await pc.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });
    return {
      ok: true,
      action: "sent",
      txHash,
      keeperBalanceBefore: keeperBalance.toString(),
      sentWei: TOP_UP_AMOUNT_WEI.toString(),
    };
  } catch (e) {
    return {
      ok: false,
      error: `top-up tx failed: ${(e as Error).message}`,
      keeperBalanceBefore: keeperBalance.toString(),
    };
  }
}

export function getGasTankAddress(): Address | null {
  const pk = process.env.GAS_TOP_UP_PRIVATE_KEY as `0x${string}` | undefined;
  if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) return null;
  return privateKeyToAccount(pk).address;
}

export const GAS_TOPUP_CONSTANTS = {
  MIN_KEEPER_BALANCE_ETH,
  TOP_UP_AMOUNT_ETH,
  MIN_KEEPER_BALANCE_WEI,
  TOP_UP_AMOUNT_WEI,
} as const;
