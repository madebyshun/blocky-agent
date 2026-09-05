import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, createWalletClient, http, encodeFunctionData } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { B20HUB_BUYBACK } from "@/lib/b20hub/constants";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Auto-distribute keeper bot.
 *
 * Purpose: BLUE flywheel needs someone to trigger BlueBuyBack.distribute()
 * once WETH accumulates past the on-chain threshold (default 0.001 WETH).
 * We run this on a schedule so the flywheel isn't gated on manual
 * intervention; the 0.1% keeper reward covers gas + a small tip. If the
 * threshold isn't cleared we no-op and log — no wasted gas.
 *
 * Env:
 *   CRON_SECRET               — required in the Authorization header (Bearer)
 *   B20HUB_KEEPER_PRIVATE_KEY — 0x-prefixed 64 hex chars; ⚠️ dedicated hot wallet
 *                              that we top up with ~$5 of ETH. Never reuse
 *                              anything with meaningful funds.
 *
 * Vercel cron entry in vercel.json:
 *   { "path": "/api/cron/b20hub-distribute", "schedule": "0 * * * *" }  // hourly
 */

const WETH9 = "0x4200000000000000000000000000000000000006" as const;

const ERC20_ABI = [
  {
    type: "function", name: "balanceOf", stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const BUYBACK_ABI = [
  {
    type: "function", name: "minDistributeThreshold", stateMutability: "view",
    inputs: [], outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function", name: "bluePoolKeySet", stateMutability: "view",
    inputs: [], outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function", name: "distribute", stateMutability: "nonpayable",
    inputs: [
      { name: "minBlueOut", type: "uint256" },
      { name: "deadline",   type: "uint256" },
    ],
    outputs: [
      { name: "blueBought",    type: "uint256" },
      { name: "keeperReward",  type: "uint256" },
    ],
  },
] as const;

export async function GET(req: NextRequest) {
  // ── Auth (allow Vercel Cron header OR CRON_SECRET Bearer) ────────────
  const cronSecret = process.env.CRON_SECRET ?? "";
  const authHeader = req.headers.get("authorization") ?? "";
  const isVercelCron = req.headers.has("x-vercel-cron");
  const isAuthorized = isVercelCron || (
    cronSecret !== "" && authHeader === `Bearer ${cronSecret}`
  );
  if (!isAuthorized) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const publicClient = createPublicClient({ chain: base, transport: http("https://mainnet.base.org") });

  // ── Read state ───────────────────────────────────────────────────────
  try {
    const [wethBal, threshold, bluePoolKeySet] = await Promise.all([
      publicClient.readContract({ address: WETH9, abi: ERC20_ABI, functionName: "balanceOf", args: [B20HUB_BUYBACK as `0x${string}`] }),
      publicClient.readContract({ address: B20HUB_BUYBACK as `0x${string}`, abi: BUYBACK_ABI, functionName: "minDistributeThreshold" }),
      publicClient.readContract({ address: B20HUB_BUYBACK as `0x${string}`, abi: BUYBACK_ABI, functionName: "bluePoolKeySet" }),
    ]);

    if (!bluePoolKeySet) {
      return NextResponse.json({
        ok: true,
        action: "skip",
        reason: "bluePoolKey not set on BuyBack",
        buybackWeth: wethBal.toString(),
        threshold: threshold.toString(),
      });
    }

    if (wethBal < threshold) {
      return NextResponse.json({
        ok: true,
        action: "skip",
        reason: "below threshold",
        buybackWeth: wethBal.toString(),
        buybackWethEth: Number(wethBal) / 1e18,
        threshold: threshold.toString(),
        thresholdEth: Number(threshold) / 1e18,
      });
    }

    // ── Fire distribute() ────────────────────────────────────────────
    const keeperKey = process.env.B20HUB_KEEPER_PRIVATE_KEY as `0x${string}` | undefined;
    if (!keeperKey || !/^0x[0-9a-fA-F]{64}$/.test(keeperKey)) {
      return NextResponse.json({
        ok: false,
        error: "B20HUB_KEEPER_PRIVATE_KEY not configured or malformed (need 0x + 64 hex)",
        buybackWeth: wethBal.toString(),
      }, { status: 500 });
    }
    const account = privateKeyToAccount(keeperKey);
    const walletClient = createWalletClient({ account, chain: base, transport: http("https://mainnet.base.org") });

    const data = encodeFunctionData({
      abi: BUYBACK_ABI,
      functionName: "distribute",
      args: [
        0n,                                             // minBlueOut — accept any (keeper race isn't MEV-sensitive here)
        BigInt(Math.floor(Date.now() / 1000) + 300),    // deadline: now + 5min
      ],
    });
    const hash = await walletClient.sendTransaction({
      to:    B20HUB_BUYBACK as `0x${string}`,
      data,
      value: 0n,
    });

    return NextResponse.json({
      ok: true,
      action: "distributed",
      tx: hash,
      buybackWethBefore: wethBal.toString(),
      buybackWethBeforeEth: Number(wethBal) / 1e18,
      keeper: account.address,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
