/**
 * Fetch a server-issued SIWE nonce (browser half).
 *
 * One implementation, shared by every flow that signs something: Blue Chat
 * sign-in, Hub tool submit, Hub tool remove. It exists as its own module
 * because the failure mode of *not* sharing it is silent — a second flow that
 * keeps minting its own nonce still signs, still verifies, and still looks
 * correct in the UI, while being replayable. That is exactly how the Hub
 * submit/remove routes drifted from the session route in the first place.
 *
 * A locally generated nonce (`crypto.randomUUID()`) is NOT an acceptable
 * substitute and the server no longer accepts one. A nonce the client invented
 * proves nothing: the server never recorded issuing it, so it can never notice
 * it being replayed. Only `GET /api/auth/nonce` mints one, and `spendNonce`
 * burns it exactly once.
 */

/**
 * Resolves to a 64-hex-char nonce, or throws with a message fit to show a user.
 *
 * Throws rather than returning null so a caller cannot accidentally fall through
 * to signing with `undefined` — the resulting signature would verify against a
 * message the server never expects and report "invalid signature", sending the
 * builder to debug their wallet instead of the outage that actually happened.
 */
export async function fetchServerNonce(): Promise<string> {
  let res: Response;
  try {
    res = await fetch("/api/auth/nonce", { cache: "no-store" });
  } catch {
    throw new Error("Could not reach the server to start signing.");
  }

  const body = (await res.json().catch(() => ({}))) as { nonce?: unknown; error?: unknown };

  if (!res.ok) {
    // 429 (rate limit) and 503 (KV down) both arrive here with their own text.
    throw new Error(String(body.error ?? "Could not start signing."));
  }
  if (typeof body.nonce !== "string" || !body.nonce) {
    throw new Error("Could not start signing — the server did not issue a nonce.");
  }
  return body.nonce;
}
