/**
 * /api/tool/_debug — Payment payload inspector
 *
 * POST a payment object here to see exactly what viem recovers and which
 * verification checks pass/fail. Helps diagnose MetaMask vs viem signing differences.
 */
import { NextRequest, NextResponse } from "next/server";
import { recoverTypedDataAddress } from "viem";

export const runtime = "nodejs";

const PAY_TO = (process.env.PAYMENT_WALLET ?? "0x02950ad38ada1d599375bd447e080cd404809205").toLowerCase();
const USDC   = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

export async function POST(req: NextRequest) {
  let payment: Record<string, unknown> = {};
  try { payment = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const payload = payment.payload as Record<string, unknown> | undefined;
  const auth    = payload?.authorization as Record<string, string> | undefined;
  const sig     = payload?.signature as string | undefined;
  const extra   = payment.extra as { name?: string; version?: string } | undefined;

  const info: Record<string, unknown> = {
    received: {
      x402Version:  payment.x402Version,
      scheme:       payment.scheme,
      network:      payment.network,
      hasPayload:   !!payload,
      hasAuth:      !!auth,
      hasSig:       !!sig,
      extra,
    },
    auth: auth ?? null,
    sigLength: sig?.length ?? 0,
    sigPrefix: sig?.slice(0, 20) ?? null,
  };

  if (!auth || !sig) {
    return NextResponse.json({ error: "Missing auth or sig", info }, { status: 400 });
  }

  const domainUsed = {
    name:              extra?.name    ?? "USD Coin",
    version:           extra?.version ?? "2",
    chainId:           8453,
    verifyingContract: USDC,
  };

  const messageUsed = {
    from:        auth.from,
    to:          auth.to,
    value:       auth.value,
    validAfter:  auth.validAfter ?? "0",
    validBefore: auth.validBefore,
    nonce:       auth.nonce,
  };

  info.domainUsed   = domainUsed;
  info.messageUsed  = messageUsed;

  let signer: string | null = null;
  let recoverError: string | null = null;

  try {
    signer = await recoverTypedDataAddress({
      domain: domainUsed,
      types: {
        TransferWithAuthorization: [
          { name: "from",        type: "address" },
          { name: "to",         type: "address" },
          { name: "value",      type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore",type: "uint256" },
          { name: "nonce",      type: "bytes32" },
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
  } catch (e) {
    recoverError = (e as Error).message;
  }

  const now = BigInt(Math.floor(Date.now() / 1000));

  const checks = signer ? {
    signerOk:   signer.toLowerCase() === auth.from.toLowerCase(),
    toOk:       auth.to.toLowerCase() === PAY_TO,
    valueOk:    BigInt(auth.value) >= BigInt(100000), // min price
    expiryOk:   BigInt(auth.validBefore) > now,
    signer,
    expected_from:    auth.from,
    expected_to:      PAY_TO,
    actual_to:        auth.to,
    actual_value:     auth.value,
    now_unix:         now.toString(),
    validBefore_unix: auth.validBefore,
  } : null;

  return NextResponse.json({
    ok: !recoverError && checks?.signerOk && checks?.toOk && checks?.valueOk && checks?.expiryOk,
    recoverError,
    checks,
    info,
    PAY_TO,
  });
}
