/**
 * GET /api/auth/nonce — mint a single-use, server-issued SIWE nonce.
 *
 * This endpoint exists because the alternative is trusting a nonce the CLIENT
 * invented. That proves nothing — the server never recorded issuing it, so it
 * can never notice it being replayed. Here the nonce is minted, stored, and
 * spent exactly once by `spendNonce`.
 *
 * Callers (all of them, as of #172): Blue Chat sign-in, Hub submit external,
 * Hub submit hosted, Hub remove external, Hub remove hosted. The browser half
 * is `lib/siwe-nonce.ts`; external agents call this endpoint directly, which is
 * documented at /docs/list-a-tool.
 *
 * Rate-limited by IP: each call writes a KV key, so an unlimited endpoint is a
 * free way to burn this project's Upstash request budget — which has already
 * been exhausted three times (#148).
 */
import { NextRequest, NextResponse } from "next/server";
import { rateLimit, getIdentifier } from "@/lib/rate-limit";
import { issueNonce } from "@/lib/session";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const rl = await rateLimit(getIdentifier(req), "console"); // 10/min
  if (!rl.success) {
    return NextResponse.json(
      { error: "Too many sign-in attempts. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(Math.max(1, Math.ceil((rl.reset - Date.now()) / 1000))) } },
    );
  }

  const nonce = await issueNonce();
  if (!nonce) {
    // `issueNonce` only fails if the SET NX did not land — i.e. KV is
    // unavailable. Say that, rather than returning a nonce we did not record
    // (which would verify against nothing and fail confusingly at POST time).
    return NextResponse.json(
      { error: "Sign-in is temporarily unavailable — could not issue a nonce." },
      { status: 503 },
    );
  }

  return NextResponse.json(
    { nonce },
    { headers: { "Cache-Control": "no-store" } },
  );
}
