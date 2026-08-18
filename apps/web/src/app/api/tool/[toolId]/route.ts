/**
 * Blue Agent Tool Gateway — /api/tool/[toolId]
 *
 * x402 payment flow:
 *   1. POST without payment → 402 requirements (payTo = our wallet)
 *   2. Client signs EIP-3009 + retries with payment in body
 *   3. Route calls facilitator.x402.org/verify (plain HTTP, no library)
 *   4. If valid → run tool → call facilitator.x402.org/settle → return result
 */
import { NextRequest, NextResponse } from "next/server";
import { recoverTypedDataAddress } from "viem";

export const runtime = "nodejs";
export const maxDuration = 120;

const PAY_TO          = (process.env.PAYMENT_WALLET ?? "0x02950ad38ada1d599375bd447e080cd404809205").toLowerCase();
const NETWORK         = "eip155:8453";
const USDC            = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const FACILITATOR     = "https://facilitator.x402.org";
const INTERNAL_KEY    = process.env.INTERNAL_SERVICE_KEY ?? "";

const SELF_BASE = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : "https://blueagent.dev";

// ─── Tool catalog (price in USDC micro-units, 6 decimals) ────────────────────

const TOOLS: Record<string, { price: string; usd: string; description: string }> = {
  "honeypot-check":           { price: "100000",  usd: "$0.10", description: "Token honeypot detection" },
  "contract-trust":           { price: "150000",  usd: "$0.15", description: "Smart contract trust score" },
  "aml-screen":               { price: "200000",  usd: "$0.20", description: "AML screening" },
  "allowance-audit":          { price: "100000",  usd: "$0.10", description: "Token allowance audit" },
  "phishing-scan":            { price: "100000",  usd: "$0.10", description: "Phishing detection" },
  "key-exposure":             { price: "150000",  usd: "$0.15", description: "Key exposure check" },
  "risk-gate":                { price: "200000",  usd: "$0.20", description: "Transaction risk gate" },
  "deep-analysis":            { price: "500000",  usd: "$0.50", description: "Deep project analysis" },
  "whale-copy-signal":        { price: "350000",  usd: "$0.35", description: "Smart money copy signal" },
  "token-pick-signal":        { price: "200000",  usd: "$0.20", description: "Actionable token pick" },
  "narrative-position":       { price: "250000",  usd: "$0.25", description: "Narrative position calls" },
  "token-momentum-scanner":   { price: "250000",  usd: "$0.25", description: "Momentum scanner" },
  "whale-tracker":            { price: "200000",  usd: "$0.20", description: "Whale tracker" },
  "community-sentiment":      { price: "250000",  usd: "$0.25", description: "Community sentiment" },
  "ecosystem-digest":         { price: "200000",  usd: "$0.20", description: "Weekly Base ecosystem digest" },
  "market-fit":               { price: "350000",  usd: "$0.35", description: "Market fit validator" },
  "repo-health":              { price: "350000",  usd: "$0.35", description: "Repo health check" },
  "competitor-scan":          { price: "750000",  usd: "$0.75", description: "Competitive landscape scan" },
  "token-launch-readiness":   { price: "500000",  usd: "$0.50", description: "Token launch readiness" },
  "builder-deep-dd":          { price: "1000000", usd: "$1.00", description: "Builder due diligence" },
  "roadmap-validator":        { price: "500000",  usd: "$0.50", description: "Roadmap validator" },
  "gtm-brief":                { price: "500000",  usd: "$0.50", description: "Go-to-market brief" },
  "investor-memo":            { price: "750000",  usd: "$0.75", description: "Investor memo" },
  "pitch-intelligence":       { price: "350000",  usd: "$0.35", description: "Pitch intelligence" },
  "fundraise-timing":         { price: "500000",  usd: "$0.50", description: "Fundraise timing signal" },
  "base-grant-finder":        { price: "350000",  usd: "$0.35", description: "Base grant matching" },
  "launch-simulator-1":       { price: "100000",  usd: "$0.10", description: "Launch Simulator Tier 1 — quick signal" },
  "launch-simulator-2":       { price: "350000",  usd: "$0.35", description: "Launch Simulator Tier 2 — deep + live data" },
  "launch-simulator-3":       { price: "500000",  usd: "$0.50", description: "Launch Simulator Tier 3 — full report" },
  "defi-opportunity":         { price: "350000",  usd: "$0.35", description: "DeFi opportunity scan" },
  "protocol-risk-monitor":    { price: "350000",  usd: "$0.35", description: "Protocol risk monitor" },
  "multi-agent-workflow":     { price: "500000",  usd: "$0.50", description: "Multi-agent workflow" },
  "agent-collab-match":       { price: "350000",  usd: "$0.35", description: "Agent collab match" },
  "agent-performance":        { price: "350000",  usd: "$0.35", description: "Agent performance audit" },
  "community-growth-playbook":{ price: "500000",  usd: "$0.50", description: "Community growth playbook" },
  "thread-intelligence":      { price: "350000",  usd: "$0.35", description: "CT thread strategy" },
  "narrative-pulse":          { price: "250000",  usd: "$0.25", description: "Narrative pulse" },
};

// ─── POST ────────────────────────────────────────────────────────────────────

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ toolId: string }> }
) {
  const { toolId } = await params;
  const meta = TOOLS[toolId];

  if (!meta) {
    return NextResponse.json(
      { error: "Unknown tool", available: Object.keys(TOOLS) },
      { status: 404 }
    );
  }

  let body: { toolParams?: Record<string, unknown>; payment?: Record<string, unknown> } = {};
  try { body = await req.json(); } catch {}

  const toolParams = body.toolParams ?? {};
  const payment   = body.payment;

  // ── Internal service bypass — skip x402 for server-to-server calls ────────
  const internalHeader = req.headers.get("X-Blue-Internal");
  if (INTERNAL_KEY && internalHeader === INTERNAL_KEY) {
    const toolResult = await runTool(toolId, toolParams);
    const resultData = await toolResult.json().catch(() => null);
    return NextResponse.json(
      typeof resultData === "object" && resultData !== null ? resultData : { raw: resultData }
    );
  }

  // ── No payment → return 402 requirements ─────────────────────────────────
  if (!payment) {
    return NextResponse.json({
      requiresPayment: true,
      paymentDetails: {
        x402Version: 2,
        error: "Payment Required",
        accepts: [{
          scheme:            "exact",
          network:           NETWORK,
          maxAmountRequired: meta.price,
          amount:            meta.price,
          resource:          `${SELF_BASE}/api/tool/${toolId}`,
          description:       meta.description,
          mimeType:          "application/json",
          payTo:             PAY_TO,
          maxTimeoutSeconds: 300,
          asset:             USDC,
          extra: { name: "USD Coin", version: "2" },
        }],
      },
    });
  }

  // ── Verify EIP-3009 signature locally with viem ───────────────────────────
  const auth = (payment.payload as Record<string, unknown>)?.authorization as Record<string, string> | undefined;
  const sig  = (payment.payload as Record<string, unknown>)?.signature as string | undefined;

  if (!auth || !sig) {
    return NextResponse.json({ error: "Invalid payment payload: missing authorization or signature" }, { status: 402 });
  }

  const extra = (payment as Record<string, unknown>).extra as { name?: string; version?: string } | undefined;

  let verified = false;
  try {
    const signer = await recoverTypedDataAddress({
      domain: {
        name:              extra?.name    ?? "USD Coin",
        version:           extra?.version ?? "2",
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
    const signerOk   = signer.toLowerCase() === auth.from.toLowerCase();
    const toOk       = auth.to.toLowerCase() === PAY_TO;
    const valueOk    = BigInt(auth.value) >= BigInt(meta.price);
    const expiryOk   = BigInt(auth.validBefore) > now;

    if (!signerOk)  return NextResponse.json({ error: `verify failed: signer_mismatch — ${signer} ≠ ${auth.from}` }, { status: 402 });
    if (!toOk)      return NextResponse.json({ error: `verify failed: wrong_recipient — auth.to=${auth.to} PAY_TO=${PAY_TO}` }, { status: 402 });
    if (!valueOk)   return NextResponse.json({ error: `verify failed: insufficient_value — ${auth.value} < ${meta.price}` }, { status: 402 });
    if (!expiryOk)  return NextResponse.json({ error: `verify failed: expired — validBefore=${auth.validBefore} now=${now}` }, { status: 402 });

    verified = true;
  } catch (e) {
    return NextResponse.json({ error: `verify error: ${(e as Error).message}` }, { status: 402 });
  }

  // ── Build requirement object for settle call ──────────────────────────────
  const requirement = {
    scheme:            "exact",
    network:           NETWORK,
    maxAmountRequired: meta.price,
    payTo:             PAY_TO,
    asset:             USDC,
    maxTimeoutSeconds: 300,
    resource:          `${SELF_BASE}/api/tool/${toolId}`,
    description:       meta.description,
    mimeType:          "application/json",
    extra:             { name: extra?.name ?? "USD Coin", version: extra?.version ?? "2" },
  };

  const facilitatorBody = JSON.stringify({
    x402Version:         (payment as Record<string, unknown>).x402Version ?? 2,
    paymentPayload:      payment,
    paymentRequirements: requirement,
  });

  // ── Run tool ─────────────────────────────────────────────────────────────
  const toolResult = await runTool(toolId, toolParams);

  // ── Settle via facilitator ────────────────────────────────────────────────
  let settleError: string | null = null;
  try {
    const sRes = await fetch(`${FACILITATOR}/settle`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    facilitatorBody,
      signal:  AbortSignal.timeout(20_000),
    });
    const settleData = await sRes.json().catch(() => ({}));
    if (!sRes.ok) {
      settleError = JSON.stringify(settleData);
      console.error("[x402] settle failed:", settleData);
    } else {
      console.log("[x402] settle ok:", settleData);
    }
  } catch (e) {
    settleError = (e as Error).message;
    console.error("[x402] settle error:", e);
  }

  // Include settle debug info in response temporarily
  const resultData = await toolResult.json().catch(() => null);
  return NextResponse.json({
    ...(typeof resultData === "object" && resultData !== null ? resultData : { raw: resultData }),
    _settle: settleError ? { ok: false, error: settleError } : { ok: true },
  });
}

async function runTool(toolId: string, toolParams: Record<string, unknown>): Promise<NextResponse> {
  try {
    const res = await fetch(`${SELF_BASE}/api/x402/${toolId}`, {
      method:  "POST",
      headers: {
        "Content-Type": "application/json",
        ...(INTERNAL_KEY ? { "X-Blue-Internal": INTERNAL_KEY } : {}),
      },
      body:    JSON.stringify(toolParams),
      signal:  AbortSignal.timeout(110_000),
    });
    const data = await res.json().catch(() => ({ error: "Invalid response" }));
    return NextResponse.json({ result: data });
  } catch (e) {
    return NextResponse.json(
      { error: "Tool failed", message: (e as Error).message },
      { status: 502 }
    );
  }
}
