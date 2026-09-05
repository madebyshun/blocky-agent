/**
 * GET /api/dca/whoami?address=0x…
 *
 * Setup/debug helper. Returns everything a user (or admin) needs to sanity
 * check a DCA environment before running a real schedule:
 *
 *   - `keeper`   — the per-user derived keeper address + current ETH/USDC balance
 *   - `gasTank`  — the shared gas top-up wallet address (if configured) + balance
 *   - `config`   — which env vars are set (never leaks values, just booleans)
 *
 * Not sensitive: keeper addresses are trivially recoverable from the master
 * key + user address (only the server has the master). Balances are public
 * on-chain. This endpoint just saves you a Node REPL + block-explorer trip.
 *
 * Not called from the chat/card flow — this is a setup-time tool.
 */

import { NextResponse } from "next/server";
import { createPublicClient, http, isAddress, formatEther, formatUnits, type Address } from "viem";
import { base } from "viem/chains";
import { deriveKeeperAccount } from "@/lib/dca/keeper";
import { getGasTankAddress, GAS_TOPUP_CONSTANTS } from "@/lib/dca/gas-topup";

export const runtime = "nodejs";

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const ERC20_BAL_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view",
    inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

async function balances(pc: unknown, addr: Address) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = pc as any;
  const [eth, usdc] = await Promise.allSettled([
    client.getBalance({ address: addr }),
    client.readContract({ address: USDC_BASE, abi: ERC20_BAL_ABI, functionName: "balanceOf", args: [addr] }),
  ]);
  const ethWei  = eth.status  === "fulfilled" ? (eth.value  as bigint) : 0n;
  const usdcRaw = usdc.status === "fulfilled" ? (usdc.value as bigint) : 0n;
  return {
    eth:      formatEther(ethWei),
    ethWei:   ethWei.toString(),
    usdc:     formatUnits(usdcRaw, 6),
    usdcRaw:  usdcRaw.toString(),
  };
}

export async function GET(req: Request) {
  const u = new URL(req.url);
  const address = u.searchParams.get("address") ?? "";

  const config = {
    KEEPER_MASTER_KEY:      Boolean(process.env.KEEPER_MASTER_KEY && process.env.KEEPER_MASTER_KEY.length >= 32),
    ZEROX_API_KEY:          Boolean(process.env.ZEROX_API_KEY),
    CRON_SECRET:            Boolean(process.env.CRON_SECRET),
    GAS_TOP_UP_PRIVATE_KEY: Boolean(process.env.GAS_TOP_UP_PRIVATE_KEY && /^0x[0-9a-fA-F]{64}$/.test(process.env.GAS_TOP_UP_PRIVATE_KEY)),
    BASE_RPC_URL:           process.env.BASE_RPC_URL ?? "https://mainnet.base.org (default)",
  };

  const pc = createPublicClient({
    chain: base,
    transport: http(process.env.BASE_RPC_URL ?? "https://mainnet.base.org"),
  });

  const gasTankAddr = getGasTankAddress();
  const gasTank = gasTankAddr
    ? { address: gasTankAddr, ...await balances(pc, gasTankAddr) }
    : { address: null as null, note: "GAS_TOP_UP_PRIVATE_KEY not set — auto top-up disabled" };

  let keeper: unknown = { note: "provide ?address=0x… (must be valid EVM address)" };
  if (address && isAddress(address)) {
    try {
      const master = process.env.KEEPER_MASTER_KEY;
      if (!master) {
        keeper = { error: "KEEPER_MASTER_KEY not configured" };
      } else {
        const acc = deriveKeeperAccount(master, address as Address);
        keeper = {
          userAddress: address,
          keeperAddress: acc.address,
          ...await balances(pc, acc.address),
        };
      }
    } catch (e) {
      keeper = { error: (e as Error).message };
    }
  }

  return NextResponse.json({
    ok: true,
    config,
    gasTank,
    keeper,
    thresholds: {
      minKeeperBalanceEth: GAS_TOPUP_CONSTANTS.MIN_KEEPER_BALANCE_ETH,
      topUpAmountEth:      GAS_TOPUP_CONSTANTS.TOP_UP_AMOUNT_ETH,
    },
    hint: {
      setup: [
        "1. openssl rand -hex 32   → set as KEEPER_MASTER_KEY in .env.local",
        "2. openssl rand -hex 32   → set as GAS_TOP_UP_PRIVATE_KEY (add 0x prefix)",
        "3. Re-fetch /api/dca/whoami → note the gasTank.address, send ~0.01 ETH on Base to it",
        "4. Get a free ZEROX_API_KEY at dashboard.0x.org → set as ZEROX_API_KEY",
        "5. Set CRON_SECRET to any random string → curl /api/cron/dca-executor with 'Bearer <secret>'",
      ],
    },
  });
}
