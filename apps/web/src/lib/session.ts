/**
 * Blue Agent — SIWE sessions (server side)
 *
 * The first session/cookie code in this repo. Before this, every "prove you own
 * this wallet" flow was per-action: the client built a message, signed it, and
 * posted `{ address, signature, nonce }` — with the NONCE INVENTED BY THE CLIENT.
 * That is replayable: capture one signed body and it verifies forever, because
 * nothing on our side ever recorded that the nonce was spent. This module fixes
 * that by making the server the only issuer of nonces, and by spending each one
 * exactly once.
 *
 * As of 2026-09-05 this is the ONLY nonce mechanism for wallet proofs. The four
 * Hub routes that used to mint their own — submit external, submit hosted,
 * remove external, remove hosted — were retrofitted onto `issueNonce` /
 * `spendNonce` (#172). The one remaining client-supplied nonce is
 * `api/profile/[address]`, which is deliberately left alone: it burns the nonce
 * itself with `kvSetNX` and binds a ±5-minute `issuedAt` into the signed text,
 * so it is single-use by a different but sound route.
 *
 * What a session is here:
 *   • an opaque 256-bit random token, stored ONLY in an httpOnly cookie
 *   • KV `session:<token>` → { wallet, createdAt, expiresAt }
 *
 * The wallet is never in the cookie. A cookie the client can read is a cookie
 * the client can edit, and the whole point of the session is that the server —
 * not a `?wallet=` query param, not a request body — decides whose data a
 * request may touch.
 *
 * What signing does NOT do: it moves no funds, grants no allowance, and
 * authorizes no transaction. It is a proof of key control, nothing else. The
 * message says so, because a wallet prompt the user doesn't understand is a
 * wallet prompt they should refuse.
 */

import type { NextRequest, NextResponse } from "next/server";
import { verifyMessage } from "viem";
import { kvGetProbe, kvSet, kvSetNX, kvDel } from "@/lib/kv";

// Re-exported so route handlers have one import, but DEFINED in a dependency-free
// module because the browser has to build the identical string to sign it.
export { sessionSiweMessage } from "@/lib/siwe-session-message";

export const SESSION_COOKIE = "blue_session";

const SESSION_TTL_S = 30 * 24 * 60 * 60; // 30 days
const NONCE_TTL_S   = 5 * 60;            // 5 minutes to sign
// Must outlive NONCE_TTL_S, and that ordering is the invariant that makes
// single-use work: the spend marker is only ever consulted while the issued key
// is still alive, so if the marker expired first there would be a window where a
// nonce is still valid but no longer remembered as spent.
const SPENT_TTL_S   = 10 * 60;

const nonceKey = (n: string) => `siwe:nonce:${n}`;
const spentKey = (n: string) => `siwe:nonce:spent:${n}`;
const sessKey  = (t: string) => `session:${t}`;

export interface SessionRecord {
  wallet:    string;  // lowercased 0x address
  createdAt: number;
  expiresAt: number;
}

// ─── Random ──────────────────────────────────────────────────────────────────

/** 32 bytes of CSPRNG as lowercase hex. Not `Math.random()`, not a UUID. */
function randomHex32(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ─── The signed message ──────────────────────────────────────────────────────

/**
 * Host to bind the message to, taken from the request the browser actually
 * sent. Bound per-host rather than hard-coded to blueagent.dev so a signature
 * obtained on a preview deploy is not valid against production. (Replay is
 * already blocked by the single-use nonce; this is the cheap second layer.)
 */
export function requestDomain(req: NextRequest): string {
  const host = req.headers.get("host") ?? "blueagent.dev";
  return host.toLowerCase();
}

// ─── Nonce: issue once, spend once ───────────────────────────────────────────

/**
 * Mint a nonce and record that WE minted it. `kvSetNX` rather than `kvSet` so a
 * (vanishingly unlikely) collision with a live nonce is reported instead of
 * silently overwriting someone mid-signature.
 */
export async function issueNonce(): Promise<string | null> {
  const nonce = randomHex32();
  const ok = await kvSetNX(nonceKey(nonce), { issuedAt: Date.now() }, NONCE_TTL_S);
  return ok ? nonce : null;
}

export type NonceSpend =
  | { ok: true }
  | { ok: false; status: 401 | 503; reason: string };

/**
 * Appended to the spend-failure text on routes an EXTERNAL agent may call.
 *
 * The Hub submit/remove endpoints are a documented public API, and #172 changed
 * their contract: a self-minted nonce used to be accepted and now 401s. A
 * third-party builder whose script breaks has no way to discover the new step
 * from "Nonce unknown or expired" alone, so the error names the endpoint that
 * issues them. Defined once because it must stay identical across four routes
 * and the /docs/list-a-tool page.
 */
export const NONCE_SOURCE_HINT =
  "Nonces are issued by GET /api/auth/nonce and are single-use — a self-generated nonce is no longer accepted.";

/**
 * Spend a nonce. Fails CLOSED on every ambiguity — this is the one place where
 * "we couldn't check" must never degrade into "fine, come in".
 *
 *   • KV read errored  → 503. A throttled Upstash (this project has hit its cap
 *     three times, see #148) must not read as "valid nonce".
 *   • nonce not found  → 401. Either never issued by us, or already expired.
 *   • spend marker lost the race → 401. `kvSetNX` is a real Redis SET NX, so
 *     exactly one concurrent caller can win; the loser is either a genuine
 *     replay or a KV error, and both should be refused.
 */
export async function spendNonce(nonce: string): Promise<NonceSpend> {
  if (!/^[0-9a-f]{64}$/.test(nonce)) {
    return { ok: false, status: 401, reason: "Malformed nonce." };
  }

  const probe = await kvGetProbe<{ issuedAt: number }>(nonceKey(nonce));
  if (probe.status === "error") {
    return { ok: false, status: 503, reason: "Cannot verify nonce right now — store unavailable." };
  }
  if (probe.status === "miss") {
    return { ok: false, status: 401, reason: "Nonce unknown or expired — request a new one." };
  }

  const claimed = await kvSetNX(spentKey(nonce), { at: Date.now() }, SPENT_TTL_S);
  if (!claimed) {
    return { ok: false, status: 401, reason: "Nonce already used — request a new one." };
  }

  // The issued key is deliberately NOT deleted here; it expires on NONCE_TTL_S.
  // Deleting it would make the probe above miss on a replay, so every replay
  // would report "unknown or expired" and the spend marker — the thing that
  // actually detects replay — would never be consulted outside a true race.
  // Measured: with the del in place, replaying a just-used nonce returned
  // "unknown or expired". Letting it live means a replay inside the signing
  // window reports "already used" (accurate and actionable), and only a genuinely
  // stale nonce reports "expired". It is also one fewer KV write per sign-in,
  // which is not nothing on a budget that has been suspended three times (#148).
  return { ok: true };
}

// ─── Signature ───────────────────────────────────────────────────────────────

/**
 * Wrapped so a malformed signature is a 401, not a 500. viem throws on garbage
 * input rather than returning false.
 */
export async function verifySiwe(
  address: string,
  message: string,
  signature: string,
): Promise<boolean> {
  try {
    return await verifyMessage({
      address:   address as `0x${string}`,
      message,
      signature: signature as `0x${string}`,
    });
  } catch {
    return false;
  }
}

// ─── Session lifecycle ───────────────────────────────────────────────────────

/** Create the KV record and return the opaque token to put in the cookie. */
export async function createSession(wallet: string): Promise<string> {
  const token = randomHex32();
  const now   = Date.now();
  const rec: SessionRecord = {
    wallet:    wallet.toLowerCase(),
    createdAt: now,
    expiresAt: now + SESSION_TTL_S * 1000,
  };
  await kvSet(sessKey(token), rec, SESSION_TTL_S);
  return token;
}

export type SessionRead =
  | { status: "active"; wallet: string }
  | { status: "anonymous" }
  | { status: "unavailable"; message: string };

/**
 * Who is this request? Three outcomes, deliberately not two.
 *
 * "anonymous" and "unavailable" look the same to `kvGet` and that difference
 * matters more here than almost anywhere else in the app: a caller that treats
 * a KV outage as "not signed in" will hand a signed-in user an EMPTY workspace,
 * and if that empty workspace is then mirrored back it has silently deleted
 * their conversations. Callers must branch on all three.
 */
export async function readSession(req: NextRequest): Promise<SessionRead> {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return { status: "anonymous" };

  const probe = await kvGetProbe<SessionRecord>(sessKey(token));
  if (probe.status === "error") return { status: "unavailable", message: probe.message };
  if (probe.status === "miss")  return { status: "anonymous" };

  const rec = probe.value;
  if (!rec?.wallet || typeof rec.expiresAt !== "number" || Date.now() > rec.expiresAt) {
    return { status: "anonymous" };
  }
  return { status: "active", wallet: rec.wallet.toLowerCase() };
}

/** Drop the server record. The cookie is cleared separately, on the response. */
export async function destroySession(req: NextRequest): Promise<void> {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (token && /^[0-9a-f]{64}$/.test(token)) await kvDel(sessKey(token));
}

// ─── Cookie ──────────────────────────────────────────────────────────────────

/**
 * `httpOnly` so no script — ours, an injected one, or an extension — can read
 * the token. `sameSite: "lax"` because the session is only ever used by
 * same-origin fetches from our own app; there is no cross-site POST that needs it.
 */
export function setSessionCookie(res: NextResponse, token: string): void {
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === "production",
    sameSite: "lax",
    path:     "/",
    maxAge:   SESSION_TTL_S,
  });
}

export function clearSessionCookie(res: NextResponse): void {
  res.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    secure:   process.env.NODE_ENV === "production",
    sameSite: "lax",
    path:     "/",
    maxAge:   0,
  });
}
