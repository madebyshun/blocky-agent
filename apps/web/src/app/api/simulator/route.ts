/**
 * /api/simulator — Launch Simulator gateway
 *
 * Payment flows to our wallet (not Bankr).
 * Tool runs locally via /api/launch-simulator (with LLM fallback — no Bankr Lambda dependency).
 *
 * x402 flow:
 *   1. POST without X-Payment → 402 with our wallet as payTo
 *   2. Client signs EIP-3009 + retries with X-Payment header (base64 payment)
 *   3. Route verifies signature locally with viem
 *   4. Runs /api/launch-simulator → settles via facilitator → return result
 */
import { NextRequest, NextResponse } from "next/server";
import { recoverTypedDataAddress } from "viem";

export const runtime  = "nodejs";
export const maxDuration = 120;

const PAY_TO      = (process.env.PAYMENT_WALLET ?? "0x02950ad38ada1d599375bd447e080cd404809205").toLowerCase();
const USDC        = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const FACILITATOR = "https://facilitator.x402.org";
const SELF_BASE   = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : "https://blueagent.dev";

const TIERS: Record<number, { price: string; usd: string; description: string }> = {
  1: { price: "100000",  usd: "$0.10", description: "Launch Simulator Tier 1 — Quick Signal (Blue Agent + Aeon + MiroShark)" },
  2: { price: "350000",  usd: "$0.35", description: "Launch Simulator Tier 2 — Deep Signal with live market data" },
  3: { price: "500000",  usd: "$0.50", description: "Launch Simulator Tier 3 — Full Simulation with risk matrix" },
};

export async function POST(req: NextRequest) {
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const tier     = Math.min(Math.max(Number(body.tier ?? 1), 1), 3);
  const meta     = TIERS[tier];
  const resource = `${SELF_BASE}/api/simulator`;
  const xPayment = req.headers.get("x-payment") ?? req.headers.get("X-Payment");

  // ── No payment → return 402 requirements ────────────────────────────────
  if (!xPayment) {
    return NextResponse.json(
      {
        x402Version: 2,
        error: "Payment Required",
        accepts: [{
          scheme:            "exact",
          network:           "eip155:8453",
          maxAmountRequired: meta.price,
          amount:            meta.price,
          resource,
          description:       meta.description,
          mimeType:          "application/json",
          payTo:             PAY_TO,
          maxTimeoutSeconds: 300,
          asset:             USDC,
          extra: { name: "USD Coin", version: "2" },
        }],
      },
      { status: 402 }
    );
  }

  // ── Decode X-Payment header ──────────────────────────────────────────────
  let payment: Record<string, unknown>;
  try {
    payment = JSON.parse(Buffer.from(xPayment, "base64").toString("utf-8"));
  } catch {
    return NextResponse.json({ error: "Invalid X-Payment header" }, { status: 402 });
  }

  const payload = payment.payload as Record<string, unknown> | undefined;
  const auth    = payload?.authorization as Record<string, string> | undefined;
  const sig     = payload?.signature as string | undefined;

  if (!auth || !sig) {
    return NextResponse.json({ error: "Invalid payment payload" }, { status: 402 });
  }

  // ── Verify EIP-3009 signature locally ───────────────────────────────────
  try {
    const signer = await recoverTypedDataAddress({
      domain: {
        name:              "USD Coin",
        version:           "2",
        chainId:           8453,
        verifyingContract: USDC,
      },
      types: {
        TransferWithAuthorization: [
          { name: "from",        type: "address" },
          { name: "to",          type: "address" },
          { name: "value",       type: "uint256" },
          { name: "validAfter",  type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce",       type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      message: {
        from:        auth.from        as `0x${string}`,
        to:          auth.to          as `0x${string}`,
        value:       BigInt(auth.value),
        validAfter:  BigInt(auth.validAfter  ?? "0"),
        validBefore: BigInt(auth.validBefore),
        nonce:       auth.nonce       as `0x${string}`,
      },
      signature: sig as `0x${string}`,
    });

    const now = BigInt(Math.floor(Date.now() / 1000));
    if (signer.toLowerCase() !== auth.from.toLowerCase())
      return NextResponse.json({ error: `verify failed: signer_mismatch — ${signer} ≠ ${auth.from}` }, { status: 402 });
    if (auth.to.toLowerCase() !== PAY_TO)
      return NextResponse.json({ error: `verify failed: wrong_recipient — auth.to=${auth.to} PAY_TO=${PAY_TO}` }, { status: 402 });
    if (BigInt(auth.value) < BigInt(meta.price))
      return NextResponse.json({ error: `verify failed: insufficient_value — ${auth.value} < ${meta.price}` }, { status: 402 });
    if (BigInt(auth.validBefore) <= now)
      return NextResponse.json({ error: `verify failed: expired` }, { status: 402 });
  } catch (e) {
    return NextResponse.json({ error: `verify error: ${(e as Error).message}` }, { status: 402 });
  }

  // ── Run tool locally via /api/launch-simulator (has LLM fallback) ────────
  let result: unknown;
  try {
    const res = await fetch(`${SELF_BASE}/api/launch-simulator`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(body),
      signal:  AbortSignal.timeout(110_000),
    });
    result = await res.json().catch(() => ({ error: "Invalid response from tool" }));
  } catch (e) {
    return NextResponse.json({ error: "Tool unavailable", message: (e as Error).message }, { status: 502 });
  }

  // ── Settle USDC via facilitator ──────────────────────────────────────────
  const requirement = {
    scheme:            "exact",
    network:           "eip155:8453",
    maxAmountRequired: meta.price,
    payTo:             PAY_TO,
    asset:             USDC,
    maxTimeoutSeconds: 300,
    resource,
    description:       meta.description,
    mimeType:          "application/json",
    extra:             { name: "USD Coin", version: "2" },
  };

  fetch(`${FACILITATOR}/settle`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({
      x402Version:         payment.x402Version ?? 2,
      paymentPayload:      payment,
      paymentRequirements: requirement,
    }),
    signal: AbortSignal.timeout(20_000),
  })
    .then(r => r.json().then(d => console.log("[simulator] settle:", JSON.stringify(d))))
    .catch(e => console.error("[simulator] settle failed:", e));

  return NextResponse.json(result);
}
