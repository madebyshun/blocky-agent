/**
 * /api/auth/session — the Blue Chat sign-in session.
 *
 * POST   { address, signature, nonce } → verify SIWE, set httpOnly cookie
 * GET                                  → who am I (never 500s on a KV blip)
 * DELETE                               → sign out, drop the server record
 *
 * The only thing a session grants is access to `workspace:<wallet>`. It moves
 * no funds and authorizes no transaction — see `sessionSiweMessage`.
 */
import { NextRequest, NextResponse } from "next/server";
import { rateLimit, getIdentifier } from "@/lib/rate-limit";
import {
  sessionSiweMessage,
  requestDomain,
  spendNonce,
  verifySiwe,
  createSession,
  readSession,
  destroySession,
  setSessionCookie,
  clearSessionCookie,
} from "@/lib/session";

export const runtime = "nodejs";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

// ─── POST — sign in ──────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const rl = await rateLimit(getIdentifier(req), "console"); // 10/min
  if (!rl.success) {
    return NextResponse.json({ error: "Too many sign-in attempts. Try again shortly." }, { status: 429 });
  }

  let body: { address?: unknown; signature?: unknown; nonce?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const address   = typeof body.address   === "string" ? body.address.trim()   : "";
  const signature = typeof body.signature === "string" ? body.signature.trim() : "";
  const nonce     = typeof body.nonce     === "string" ? body.nonce.trim()     : "";

  if (!ADDRESS_RE.test(address)) return NextResponse.json({ error: "Invalid address." },   { status: 400 });
  if (!signature.startsWith("0x")) return NextResponse.json({ error: "Invalid signature." }, { status: 400 });
  if (!nonce)                      return NextResponse.json({ error: "Missing nonce." },    { status: 400 });

  // Spend the nonce BEFORE verifying the signature. Doing it in this order means
  // a captured body cannot be retried even if the signature check is slow or the
  // attacker floods it — the very first attempt burns the nonce for everyone.
  const spend = await spendNonce(nonce);
  if (!spend.ok) return NextResponse.json({ error: spend.reason }, { status: spend.status });

  const message = sessionSiweMessage(requestDomain(req), address, nonce);
  const valid   = await verifySiwe(address, message, signature);
  if (!valid) {
    return NextResponse.json(
      { error: "Signature does not match this address — sign-in refused." },
      { status: 401 },
    );
  }

  const token = await createSession(address);
  const res   = NextResponse.json({ wallet: address.toLowerCase() });
  setSessionCookie(res, token);
  return res;
}

// ─── GET — whoami ────────────────────────────────────────────────────────────

/**
 * Returns one of three states. `unavailable` is NOT folded into "signed out":
 * the client uses this to decide whether to hydrate its workspace, and reading
 * a KV outage as "signed out" would leave a signed-in user looking at an empty
 * app. 503 is the honest answer to "I could not check".
 */
export async function GET(req: NextRequest) {
  const session = await readSession(req);

  if (session.status === "unavailable") {
    return NextResponse.json(
      { status: "unavailable", error: "Could not read session — store unavailable." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (session.status === "anonymous") {
    return NextResponse.json({ status: "anonymous" }, { headers: { "Cache-Control": "no-store" } });
  }
  return NextResponse.json(
    { status: "active", wallet: session.wallet },
    { headers: { "Cache-Control": "no-store" } },
  );
}

// ─── DELETE — sign out ───────────────────────────────────────────────────────

/**
 * Ends the session only. It does NOT delete `workspace:<wallet>` — signing out
 * on a shared laptop must not wipe your history everywhere else. Deleting the
 * synced copy is a separate, explicit act (`DELETE /api/workspace`).
 */
export async function DELETE(req: NextRequest) {
  await destroySession(req);
  const res = NextResponse.json({ status: "anonymous" });
  clearSessionCookie(res);
  return res;
}
