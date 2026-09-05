/**
 * POST /api/dca/create
 *
 * Server-side create for a DCA schedule.
 * The caller (chat card) sends:
 *   { userAddress, chainId, sellToken, buyToken, sellAmountPerRun (decimal string),
 *     frequency, totalRuns, slippageBps }
 *
 * The server:
 *   1. Fetches sellToken/buyToken symbol + decimals on-chain
 *   2. Derives the per-user keeper address (deterministic from KEEPER_MASTER_KEY)
 *   3. Computes totalAllowance (per-run × runs × (1 + fee))
 *   4. Persists the schedule to KV
 *   5. Returns { scheduleId, keeperAddress, totalAllowance, sellTokenDecimals, ... }
 *      → the card uses this to build the exact ERC-20 approve() call for the
 *        user to sign in-wallet.
 *
 * NOTE: This route does NOT verify the on-chain approval yet. The cron does that
 * before each run. If the user never approves, the schedule just fails run 1 and
 * gets auto-paused after 3 consecutive failures.
 */

import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { createPublicClient, http, isAddress, formatUnits, type Address } from "viem";
import { base } from "viem/chains";
import { kvGet, kvSet } from "@/lib/kv";
import { getKeeperAddress } from "@/lib/dca/keeper";
import { dcaKeys } from "@/lib/dca/kv-keys";
import { knownBaseToken } from "@/lib/dca/base-tokens";
import {
  FREQUENCY_SECONDS,
  type CreateDcaInput,
  type CreateDcaResponse,
  type DcaFrequency,
  type DcaSchedule,
} from "@/lib/dca/types";
import { computeTotalAllowance } from "@/lib/dca/execution";

export const runtime = "nodejs";
export const maxDuration = 30;

const DEFAULT_FEE_BPS = 50; // 0.5% keeper markup
const MIN_SLIPPAGE_BPS = 10;    // 0.1%
const MAX_SLIPPAGE_BPS = 1000;  // 10%
const MAX_TOTAL_RUNS = 365;

const ERC20_META_ABI = [
  { type: "function", name: "symbol",   stateMutability: "view", inputs: [], outputs: [{ type: "string"  }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8"   }] },
] as const;

/**
 * Read symbol + decimals for a token.
 *
 * IMPORTANT: decimals MUST NOT silently fall back to 18 on RPC failure —
 * that caused a "$2 request → $2 trillion spending cap" bug during local
 * test (USDC = 6 decimals, but 18-fallback made the value 10^12 too large).
 * So this throws on decimals-read failure, and short-circuits well-known
 * tokens via the KNOWN_BASE_TOKENS map (no RPC needed for USDC / WETH / etc).
 * Symbol still falls back gracefully — cosmetic only.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readTokenMeta(pc: any, token: Address) {
  const known = knownBaseToken(token);
  if (known) return known;

  let decimalsRaw: unknown;
  try {
    decimalsRaw = await pc.readContract({ address: token, abi: ERC20_META_ABI, functionName: "decimals" });
  } catch (e) {
    throw new Error(`failed to read decimals for ${token}: ${(e as Error).message}`);
  }
  const decimals = Number(decimalsRaw);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 30) {
    throw new Error(`invalid decimals returned by ${token}: ${String(decimalsRaw)}`);
  }

  const symbol = await pc
    .readContract({ address: token, abi: ERC20_META_ABI, functionName: "symbol" })
    .then(String)
    .catch(() => "TOKEN");
  return { symbol, decimals };
}

function isFrequency(v: unknown): v is DcaFrequency {
  return typeof v === "string" && v in FREQUENCY_SECONDS;
}

export async function POST(req: Request) {
  let body: Partial<CreateDcaInput> = {};
  try { body = (await req.json()) as Partial<CreateDcaInput>; }
  catch { return NextResponse.json({ error: "invalid json" }, { status: 400 }); }

  // ── Validate input ────────────────────────────────────────────────────
  const userAddress = body.userAddress;
  const sellToken   = body.sellToken;
  const buyToken    = body.buyToken;
  if (!userAddress || !isAddress(userAddress)) {
    return NextResponse.json({ error: "invalid userAddress" }, { status: 400 });
  }
  if (!sellToken || !isAddress(sellToken)) {
    return NextResponse.json({ error: "invalid sellToken"   }, { status: 400 });
  }
  if (!buyToken || !isAddress(buyToken)) {
    return NextResponse.json({ error: "invalid buyToken"    }, { status: 400 });
  }
  if (sellToken.toLowerCase() === buyToken.toLowerCase()) {
    return NextResponse.json({ error: "sellToken and buyToken must differ" }, { status: 400 });
  }
  if (!isFrequency(body.frequency)) {
    return NextResponse.json({
      error: `invalid frequency — one of ${Object.keys(FREQUENCY_SECONDS).join(", ")}`,
    }, { status: 400 });
  }
  if (typeof body.totalRuns !== "number" || body.totalRuns < 1 || body.totalRuns > MAX_TOTAL_RUNS) {
    return NextResponse.json({ error: `totalRuns must be 1..${MAX_TOTAL_RUNS}` }, { status: 400 });
  }
  const slippageBps = Number.isFinite(body.slippageBps as number) ? Number(body.slippageBps) : 100;
  if (slippageBps < MIN_SLIPPAGE_BPS || slippageBps > MAX_SLIPPAGE_BPS) {
    return NextResponse.json({
      error: `slippageBps must be ${MIN_SLIPPAGE_BPS}..${MAX_SLIPPAGE_BPS}`,
    }, { status: 400 });
  }
  const sellAmountHuman = String(body.sellAmountPerRun ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(sellAmountHuman) || Number(sellAmountHuman) <= 0) {
    return NextResponse.json({ error: "invalid sellAmountPerRun" }, { status: 400 });
  }
  const chainId = Number(body.chainId ?? 8453);
  if (chainId !== 8453) {
    return NextResponse.json({ error: "v1 supports Base (chainId 8453) only" }, { status: 400 });
  }

  // ── Fetch on-chain token metadata ─────────────────────────────────────
  let sellMeta: { symbol: string; decimals: number };
  let buyMeta:  { symbol: string; decimals: number };
  try {
    const pc = createPublicClient({
      chain: base,
      transport: http(process.env.BASE_RPC_URL ?? "https://mainnet.base.org"),
    });
    [sellMeta, buyMeta] = await Promise.all([
      readTokenMeta(pc, sellToken as Address),
      readTokenMeta(pc, buyToken  as Address),
    ]);
  } catch (e) {
    return NextResponse.json({
      error: `failed to read token metadata: ${(e as Error).message}`,
    }, { status: 502 });
  }

  // ── Derive keeper + compute allowance ─────────────────────────────────
  let keeperAddress: Address;
  try {
    keeperAddress = getKeeperAddress(userAddress as Address);
  } catch (e) {
    return NextResponse.json({
      error: `keeper derivation failed: ${(e as Error).message}`,
    }, { status: 500 });
  }

  const feeBps = DEFAULT_FEE_BPS;
  const totalAllowance = computeTotalAllowance(
    sellAmountHuman,
    body.totalRuns,
    feeBps,
    sellMeta.decimals,
  );
  const sellAmountPerRun = (BigInt(totalAllowance) / BigInt(body.totalRuns)) * 10_000n / BigInt(10_000 + feeBps);
  // NOTE: sellAmountPerRun above is derived from the totalAllowance for exactness.
  // We could parseUnits(sellAmountHuman) directly — both give identical results.

  // ── Persist ───────────────────────────────────────────────────────────
  const id = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const frequencySec = FREQUENCY_SECONDS[body.frequency];
  const expiresAt = now + frequencySec * body.totalRuns + 24 * 60 * 60; // +1d grace

  const schedule: DcaSchedule = {
    id,
    userAddress: (userAddress as Address).toLowerCase() as Address,
    keeperAddress,
    chainId,
    sellToken: sellToken as Address,
    sellTokenSymbol: sellMeta.symbol,
    sellTokenDecimals: sellMeta.decimals,
    sellAmountPerRun: sellAmountPerRun.toString(),
    buyToken: buyToken as Address,
    buyTokenSymbol: buyMeta.symbol,
    buyTokenDecimals: buyMeta.decimals,
    frequency: body.frequency,
    frequencySec,
    slippageBps,
    totalAllowance: totalAllowance.toString(),
    totalRuns: body.totalRuns,
    expiresAt,
    feeBps,
    status: "active",
    createdAt: now,
    lastRunAt: null,
    nextRunAt: now + Math.min(frequencySec, 120), // first run ≤ 2min from creation
    runsCompleted: 0,
    runsFailed: 0,
    totalSpent: "0",
    totalBought: "0",
    lastError: null,
  };

  await kvSet(dcaKeys.schedule(id), schedule);

  // Append to user index
  const userIdx = (await kvGet<string[]>(dcaKeys.userIndex(userAddress))) ?? [];
  if (!userIdx.includes(id)) userIdx.push(id);
  await kvSet(dcaKeys.userIndex(userAddress), userIdx);

  // Append to active set (cron work queue)
  const activeSet = (await kvGet<string[]>(dcaKeys.activeSet())) ?? [];
  if (!activeSet.includes(id)) activeSet.push(id);
  await kvSet(dcaKeys.activeSet(), activeSet);

  const response: CreateDcaResponse = {
    scheduleId: id,
    keeperAddress,
    totalAllowance: totalAllowance.toString(),
    totalAllowanceHuman: formatUnits(totalAllowance, sellMeta.decimals),
    sellTokenDecimals: sellMeta.decimals,
    feeBps,
    expiresAt,
    nextRunAt: schedule.nextRunAt,
  };
  return NextResponse.json({ ok: true, ...response });
}
